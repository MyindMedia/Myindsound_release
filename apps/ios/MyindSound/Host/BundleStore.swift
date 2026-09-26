import CryptoKit
import Foundation

/// A release bundle's `manifest.json` (BUN-1).
struct BundleManifest: Decodable, Equatable {
    struct SafeZone: Decodable, Equatable {
        var surface: String
        var x: Double
        var y: Double
        var w: Double
        var h: Double
    }

    var releaseId: String?
    var slug: String
    var version: String
    var entry: String
    var bridgeVersion: Int
    var minAppVersion: String
    var sha256: String?
    var wearSafeZones: [SafeZone]?
}

/// An unpacked bundle on disk, ready to serve.
struct InstalledBundle: Equatable {
    var slug: String
    var version: String
    var root: URL
    var manifest: BundleManifest
    /// The Debug build's embedded copy of `dist-bundles/<slug>` (no hosting needed in the simulator).
    var isDevFallback = false
}

/// What opening a release gets.
enum BundleResolution: Equatable {
    case ready(InstalledBundle)
    /// BRG-3: the bundle needs a newer app (or is older than this app still speaks).
    case needsUpdate(BundleManifest)
    case failed(String)
}

/// BUN-2, BUN-4, AUD-8: downloads a release's bundle zip from `bundle.url`, checks its SHA-256 against
/// `bundle.sha256` from `app.library`, unpacks it to Application Support/bundles/<slug>/<version>/ (excluded
/// from backup: it can be downloaded again) and keeps it, so the experience opens offline. A new version is
/// picked up whenever the library refreshes (launch, foreground, pull to refresh). BRG-3 checks
/// `bridgeVersion` and `minAppVersion` before anything is loaded.
@MainActor
final class BundleStore {
    enum StoreError: Error, Equatable, LocalizedError {
        case checksumMismatch
        case badManifest(String)
        case download(String)

        var errorDescription: String? {
            switch self {
            case .checksumMismatch: return "The release download didn't check out. Try again."
            case .badManifest: return "This release's package is damaged. Try again later."
            case .download: return "Couldn't download this release. Check your connection."
            }
        }
    }

    nonisolated static let markerName = ".myind-installed"

    let baseDirectory: URL
    let appVersion: String
    private var inFlight: [String: Task<InstalledBundle, Error>] = [:]

    init(baseDirectory: URL = BundleStore.defaultDirectory, appVersion: String = BundleStore.currentAppVersion) {
        self.baseDirectory = baseDirectory
        self.appVersion = appVersion
    }

    nonisolated static var defaultDirectory: URL {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return support.appendingPathComponent("bundles", isDirectory: true)
    }

    nonisolated static var currentAppVersion: String {
        (Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String) ?? "0.0.0"
    }

    // MARK: Opening

    /// The bundle to load for `release`: the published version (downloaded and verified if new), else the
    /// newest one already on disk (offline, AUD-8), else the Debug build's embedded copy.
    func resolve(_ release: LibraryRelease) async -> BundleResolution {
        var bundle: InstalledBundle?
        var failure: String?
        if let info = release.bundle, info.url != nil, info.sha256 != nil, info.version != nil {
            do {
                bundle = try await install(slug: release.slug, info: info)
            } catch {
                failure = (error as? LocalizedError)?.errorDescription ?? "Couldn't open this release."
            }
        }
        bundle = bundle ?? installed(slug: release.slug) ?? Self.devFallback(slug: release.slug)
        guard let bundle else { return .failed(failure ?? "This release's experience isn't published yet.") }
        guard Self.isCompatible(bundle.manifest, appVersion: appVersion) else { return .needsUpdate(bundle.manifest) }
        return .ready(bundle)
    }

    /// BUN-4: fetch new versions in the background after a library refresh, so the next open is instant.
    func prefetch(_ releases: [LibraryRelease]) {
        for release in releases where release.ownership == .owned || release.ownership == .lent {
            guard let info = release.bundle, info.url != nil, info.sha256 != nil, let version = info.version,
                  !isInstalled(slug: release.slug, version: version, sha256: info.sha256) else { continue }
            Task { _ = try? await self.install(slug: release.slug, info: info) }
        }
    }

    // MARK: BRG-3

    nonisolated static func isCompatible(_ manifest: BundleManifest, appVersion: String) -> Bool {
        (BridgeContract.minVersion...BridgeContract.version).contains(manifest.bridgeVersion)
            && compareVersions(manifest.minAppVersion, appVersion) != .orderedDescending
    }

    /// Numeric dotted versions: "1.10.0" > "1.9.2"; missing parts are 0.
    nonisolated static func compareVersions(_ a: String, _ b: String) -> ComparisonResult {
        let pa = a.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
        let pb = b.split(separator: ".").map { Int($0.prefix(while: \.isNumber)) ?? 0 }
        for i in 0..<max(pa.count, pb.count) {
            let x = i < pa.count ? pa[i] : 0, y = i < pb.count ? pb[i] : 0
            if x != y { return x < y ? .orderedAscending : .orderedDescending }
        }
        return .orderedSame
    }

    // MARK: Install (BUN-2)

    func install(slug: String, info: BundleInfo) async throws -> InstalledBundle {
        guard let url = info.url, let sha = info.sha256?.lowercased(), let version = info.version else {
            throw StoreError.badManifest("bundle info")
        }
        if let existing = installedBundle(slug: slug, version: version), marker(for: existing.root) == sha {
            return existing
        }
        if let task = inFlight[slug] { return try await task.value }
        let base = baseDirectory
        let task = Task<InstalledBundle, Error> {
            let zip = try await Self.download(url)
            defer { try? FileManager.default.removeItem(at: zip) }
            return try await Task.detached(priority: .userInitiated) {
                try Self.installZip(at: zip, slug: slug, version: version, expectedSHA256: sha, into: base)
            }.value
        }
        inFlight[slug] = task
        defer { inFlight[slug] = nil }
        return try await task.value
    }

    private static func download(_ url: URL) async throws -> URL {
        let temp = FileManager.default.temporaryDirectory.appendingPathComponent("bundle-\(UUID().uuidString).zip")
        if url.isFileURL {
            try FileManager.default.copyItem(at: url, to: temp)
            return temp
        }
        guard url.scheme == "https" else { throw StoreError.download("https only") }
        do {
            let (file, response) = try await URLSession.shared.download(from: url)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                try? FileManager.default.removeItem(at: file)
                throw StoreError.download("status")
            }
            try FileManager.default.moveItem(at: file, to: temp)
            return temp
        } catch let error as StoreError {
            throw error
        } catch {
            throw StoreError.download("network")
        }
    }

    /// Verifies `zip` against `expectedSHA256`, unpacks it to a staging folder, checks the manifest, then moves
    /// it into place as `<base>/<slug>/<version>/` and removes older versions. Nothing is unpacked on a mismatch.
    nonisolated static func installZip(
        at zip: URL, slug: String, version: String, expectedSHA256: String, into base: URL
    ) throws -> InstalledBundle {
        let fm = FileManager.default
        guard try sha256(of: zip) == expectedSHA256.lowercased() else { throw StoreError.checksumMismatch }

        try fm.createDirectory(at: base, withIntermediateDirectories: true)
        excludeFromBackup(base)
        let staging = base.appendingPathComponent(".staging-\(UUID().uuidString)", isDirectory: true)
        defer { try? fm.removeItem(at: staging) }
        try ZipArchive.extract(zip, to: staging)

        let manifest = try readManifest(in: staging)
        guard manifest.slug == slug else { throw StoreError.badManifest("slug") }
        guard manifest.version == version else { throw StoreError.badManifest("version") }
        guard entryExists(manifest.entry, in: staging) else { throw StoreError.badManifest("entry") }
        try Data(expectedSHA256.lowercased().utf8).write(to: staging.appendingPathComponent(markerName))

        let slugDir = base.appendingPathComponent(slug, isDirectory: true)
        try fm.createDirectory(at: slugDir, withIntermediateDirectories: true)
        let final = slugDir.appendingPathComponent(version, isDirectory: true)
        if fm.fileExists(atPath: final.path) { try fm.removeItem(at: final) }
        try fm.moveItem(at: staging, to: final)
        // Keep one version per release.
        for old in (try? fm.contentsOfDirectory(at: slugDir, includingPropertiesForKeys: nil)) ?? [] where old.lastPathComponent != version {
            try? fm.removeItem(at: old)
        }
        return InstalledBundle(slug: slug, version: version, root: final, manifest: manifest)
    }

    nonisolated static func sha256(of file: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    nonisolated static func readManifest(in root: URL) throws -> BundleManifest {
        guard let data = try? Data(contentsOf: root.appendingPathComponent("manifest.json")),
              let manifest = try? JSONDecoder().decode(BundleManifest.self, from: data) else {
            throw StoreError.badManifest("manifest.json")
        }
        return manifest
    }

    nonisolated private static func entryExists(_ entry: String, in root: URL) -> Bool {
        guard let url = URL(string: "\(BridgeContract.scheme)://x/\(entry)") else { return false }
        return BundleSchemeHandler.resolve(url, slug: "x", root: root) != nil
    }

    nonisolated static func excludeFromBackup(_ url: URL) {
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        var target = url
        try? target.setResourceValues(values)
    }

    // MARK: On disk

    private func marker(for root: URL) -> String? {
        (try? String(contentsOf: root.appendingPathComponent(Self.markerName), encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func isInstalled(slug: String, version: String, sha256: String?) -> Bool {
        guard let bundle = installedBundle(slug: slug, version: version) else { return false }
        return marker(for: bundle.root) == sha256?.lowercased()
    }

    private func installedBundle(slug: String, version: String) -> InstalledBundle? {
        let root = baseDirectory.appendingPathComponent(slug, isDirectory: true).appendingPathComponent(version, isDirectory: true)
        guard marker(for: root) != nil, let manifest = try? Self.readManifest(in: root), manifest.slug == slug else { return nil }
        return InstalledBundle(slug: slug, version: version, root: root, manifest: manifest)
    }

    /// The newest verified version on disk (only verified installs carry the marker).
    func installed(slug: String) -> InstalledBundle? {
        let dir = baseDirectory.appendingPathComponent(slug, isDirectory: true)
        let versions = ((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
            .filter { !$0.hasPrefix(".") }
            .sorted { Self.compareVersions($0, $1) == .orderedDescending }
        for version in versions {
            if let bundle = installedBundle(slug: slug, version: version) { return bundle }
        }
        return nil
    }

    // MARK: Debug fallback

    /// `DevBundles/<slug>` inside the app, copied from `dist-bundles/<slug>` by a Debug-only build phase when
    /// it exists (project.yml). Release builds never carry it.
    nonisolated static func devFallback(slug: String, in bundle: Bundle = .main) -> InstalledBundle? {
        #if DEBUG
        guard let root = bundle.resourceURL?.appendingPathComponent("DevBundles/\(slug)", isDirectory: true),
              let manifest = try? readManifest(in: root), manifest.slug == slug else { return nil }
        return InstalledBundle(slug: slug, version: manifest.version, root: root, manifest: manifest, isDevFallback: true)
        #else
        return nil
        #endif
    }

    /// The embedded zip and its published manifest (`dist-bundles/<slug>-<version>.zip` + `.manifest.json`), so
    /// `-mock` runs exercise the real download, verify and unpack path from a file URL.
    nonisolated static func devZip(slug: String, in bundle: Bundle = .main) -> BundleInfo? {
        #if DEBUG
        guard let dir = bundle.resourceURL?.appendingPathComponent("DevBundles", isDirectory: true),
              let files = try? FileManager.default.contentsOfDirectory(atPath: dir.path),
              let manifestName = files.first(where: { $0.hasPrefix("\(slug)-") && $0.hasSuffix(".manifest.json") }),
              let data = try? Data(contentsOf: dir.appendingPathComponent(manifestName)),
              let manifest = try? JSONDecoder().decode(BundleManifest.self, from: data),
              let sha = manifest.sha256 else { return nil }
        let zip = dir.appendingPathComponent("\(slug)-\(manifest.version).zip")
        guard FileManager.default.fileExists(atPath: zip.path) else { return nil }
        return BundleInfo(version: manifest.version, url: zip, sha256: sha)
        #else
        return nil
        #endif
    }
}

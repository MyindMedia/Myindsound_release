import AVFoundation
import CryptoKit
import Foundation
import Observation

/// Offline downloads (PRD §13).
///
/// - AUD-3: owners only, never lent copies. Each track is fetched through `media.getStreamUrl` and every
///   network slice goes straight into `EncryptedAudioFile.Writer` (AES-GCM, the fan's Keychain key), so only
///   ciphertext is written, to Application Support/downloads/<account>/<slug>/ with `isExcludedFromBackup`.
///   The session is ephemeral with no URL cache, so nothing plain lands in a cache either.
/// - AUD-4: `asset(slug:trackId:)` hands `AudioEngine` an `AVURLAsset` that decrypts ranges in memory.
/// - AUD-5: a download plays only within 30 days of the last successful entitlement check (a library sync
///   that still lists the copy as owned). Past that it stays on disk, silent, until the next check.
/// - AUD-6: a sync that no longer lists the copy as owned deletes its files; with none left, the key goes too.
@MainActor
@Observable
final class DownloadManager {
    enum State: Equatable {
        case none
        case downloading(Double)
        case downloaded
        /// AUD-5: on disk, but the 30 day entitlement check is overdue.
        case needsCheck
        case failed(String)
    }

    struct TrackFile: Codable, Equatable {
        var trackId: String
        var file: String
        var length: UInt64
        var mimeType: String
    }

    struct ReleaseRecord: Codable, Equatable {
        var slug: String
        var tracks: [TrackFile]
        var lastVerifiedAt: Date

        var bytes: UInt64 { tracks.reduce(0) { $0 + $1.length } }
    }

    struct Index: Codable, Equatable {
        var releases: [String: ReleaseRecord] = [:]
    }

    /// AUD-5 [DECIDE] 30 days.
    nonisolated static let recheckInterval: TimeInterval = 30 * 86_400
    /// A device clock behind the last check by more than this counts as tampered: no playback until a check.
    nonisolated static let clockRollbackTolerance: TimeInterval = 86_400

    private(set) var states: [String: State] = [:]
    let root: URL
    @ObservationIgnored private let api: MyindAPI
    @ObservationIgnored private var account: String?
    @ObservationIgnored private var index = Index()
    @ObservationIgnored private var tasks: [String: Task<Void, Never>] = [:]
    /// Loaders for live assets (the asset's resource loader holds its delegate weakly).
    @ObservationIgnored private var loaders: [EncryptedAssetLoader] = []

    init(api: MyindAPI, root: URL = DownloadManager.defaultRoot) {
        self.api = api
        self.root = root
    }

    nonisolated static var defaultRoot: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("downloads", isDirectory: true)
    }

    // MARK: Account

    /// Scopes downloads to the signed-in fan. The folder and Keychain account are a hash of the user id, so the
    /// id itself is never written to disk.
    func setUser(_ userId: String?) {
        guard let userId, !userId.isEmpty else {
            cancelAll()
            account = nil
            index = Index()
            states = [:]
            return
        }
        let hashed = SHA256.hash(data: Data(userId.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
        guard hashed != account else { return }
        cancelAll()
        account = hashed
        index = loadIndex()
        refreshStates()
    }

    private var accountDirectory: URL? {
        account.map { root.appendingPathComponent($0, isDirectory: true) }
    }

    // MARK: State

    func state(for slug: String) -> State { states[slug] ?? .none }

    func record(for slug: String) -> ReleaseRecord? { index.releases[slug] }

    nonisolated static func canDownload(_ release: LibraryRelease) -> Bool {
        release.ownership == .owned && release.lend?.role != .borrower
    }

    /// AUD-5: within 30 days of the last check, and the clock hasn't been wound back past it.
    nonisolated static func canPlay(lastVerifiedAt: Date, now: Date) -> Bool {
        let age = now.timeIntervalSince(lastVerifiedAt)
        return age <= recheckInterval && age >= -clockRollbackTolerance
    }

    private func refreshStates(now: Date = Date()) {
        var next: [String: State] = [:]
        for (slug, state) in states {
            if case .downloading = state { next[slug] = state }
            if case .failed = state { next[slug] = state }
        }
        for (slug, record) in index.releases where next[slug] == nil || next[slug] == .none {
            next[slug] = Self.canPlay(lastVerifiedAt: record.lastVerifiedAt, now: now) ? .downloaded : .needsCheck
        }
        states = next
    }

    // MARK: Download / remove

    func toggle(_ release: LibraryRelease, tracks: [Track]) {
        switch state(for: release.slug) {
        case .downloading, .downloaded, .needsCheck: remove(slug: release.slug)
        case .none, .failed: download(release, tracks: tracks)
        }
    }

    func download(_ release: LibraryRelease, tracks: [Track]) {
        guard Self.canDownload(release) else {
            states[release.slug] = .failed("Only your own copies can be downloaded.")
            return
        }
        guard let dir = accountDirectory, tasks[release.slug] == nil, !tracks.isEmpty else { return }
        let slug = release.slug
        states[slug] = .downloading(0)
        tasks[slug] = Task {
            do {
                guard let key = try DownloadKeychain.key(account: self.account ?? "", create: true) else { throw CocoaError(.fileWriteUnknown) }
                let folder = dir.appendingPathComponent(slug, isDirectory: true)
                try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
                BundleStore.excludeFromBackup(self.root)
                BundleStore.excludeFromBackup(folder)
                var files: [TrackFile] = []
                for (n, track) in tracks.enumerated() {
                    try Task.checkCancellation()
                    let stream = try await self.api.streamURL(trackId: track.id, lendId: nil)
                    let name = Self.fileName(for: track.id)
                    let file = try await EncryptingDownload.run(
                        from: stream.url, to: folder.appendingPathComponent(name), key: key
                    ) { fraction in
                        Task { @MainActor in
                            guard case .downloading = self.states[slug] else { return }
                            self.states[slug] = .downloading((Double(n) + fraction) / Double(tracks.count))
                        }
                    }
                    files.append(TrackFile(trackId: track.id, file: name, length: file.length, mimeType: file.mimeType))
                }
                self.index.releases[slug] = ReleaseRecord(slug: slug, tracks: files, lastVerifiedAt: Date())
                try self.saveIndex()
                self.states[slug] = .downloaded
            } catch is CancellationError {
                // remove(slug:) already cleaned up.
            } catch {
                try? FileManager.default.removeItem(at: dir.appendingPathComponent(slug, isDirectory: true))
                self.states[slug] = .failed("Download failed. Check your connection and try again.")
            }
            self.tasks[slug] = nil
        }
    }

    func remove(slug: String) {
        tasks[slug]?.cancel()
        tasks[slug] = nil
        if let dir = accountDirectory {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(slug, isDirectory: true))
        }
        index.releases[slug] = nil
        try? saveIndex()
        states[slug] = nil
        deleteKeyIfUnused()
    }

    private func cancelAll() {
        for task in tasks.values { task.cancel() }
        tasks = [:]
    }

    private func deleteKeyIfUnused() {
        guard let account, index.releases.isEmpty, tasks.isEmpty else { return }
        DownloadKeychain.deleteKey(account: account)
    }

    /// Track ids are opaque; the file name is a hash of one, so no id needs escaping.
    nonisolated static func fileName(for trackId: String) -> String {
        SHA256.hash(data: Data(trackId.utf8)).prefix(12).map { String(format: "%02x", $0) }.joined() + ".mse"
    }

    // MARK: Sync (AUD-5, AUD-6)

    /// After every successful `app.library()`: owned copies count as checked now; anything else downloaded
    /// (refunded, revoked, never owned) is deleted, and the key with the last of them.
    func sync(_ snapshot: LibrarySnapshot, now: Date = Date()) {
        guard account != nil else { return }
        let owned = Set(snapshot.releases.filter { $0.ownership == .owned }.map(\.slug))
        var changed = false
        for slug in Array(index.releases.keys) {
            if owned.contains(slug) {
                index.releases[slug]?.lastVerifiedAt = now
            } else {
                if let dir = accountDirectory {
                    try? FileManager.default.removeItem(at: dir.appendingPathComponent(slug, isDirectory: true))
                }
                index.releases[slug] = nil
                states[slug] = nil
            }
            changed = true
        }
        // A copy that stopped being owned mid download stops too.
        for slug in Array(tasks.keys) where !owned.contains(slug) { remove(slug: slug) }
        if changed { try? saveIndex() }
        refreshStates(now: now)
        deleteKeyIfUnused()
    }

    // MARK: Playback (AUD-4)

    /// A decrypting asset for a downloaded track, or nil (not downloaded, AUD-5 check overdue, no key).
    func asset(slug: String, trackId: String, now: Date = Date()) -> AVURLAsset? {
        guard let account, let dir = accountDirectory, let record = index.releases[slug],
              Self.canPlay(lastVerifiedAt: record.lastVerifiedAt, now: now),
              let file = record.tracks.first(where: { $0.trackId == trackId }),
              let key = try? DownloadKeychain.key(account: account, create: false),
              let loader = try? EncryptedAssetLoader(
                  fileURL: dir.appendingPathComponent(slug, isDirectory: true).appendingPathComponent(file.file),
                  key: key, mimeType: file.mimeType
              ) else {
            if let record = index.releases[slug], !Self.canPlay(lastVerifiedAt: record.lastVerifiedAt, now: now) {
                states[slug] = .needsCheck
            }
            return nil
        }
        loaders.append(loader)
        if loaders.count > 6 { loaders.removeFirst(loaders.count - 6) }
        return loader.makeAsset(trackId: trackId)
    }

    #if DEBUG
    // Test hooks.
    var debugAccount: String? { account }

    func debugSeed(slug: String, files: [TrackFile], verifiedAt: Date) {
        index.releases[slug] = ReleaseRecord(slug: slug, tracks: files, lastVerifiedAt: verifiedAt)
        try? saveIndex()
        refreshStates()
    }
    #endif

    // MARK: Index file

    private var indexURL: URL? { accountDirectory?.appendingPathComponent("index.json") }

    private func loadIndex() -> Index {
        guard let url = indexURL, let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(Index.self, from: data) else { return Index() }
        return decoded
    }

    private func saveIndex() throws {
        guard let url = indexURL else { return }
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try JSONEncoder().encode(index).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        BundleStore.excludeFromBackup(root)
    }
}

/// Streams one URL into an `EncryptedAudioFile.Writer`. Uses a data task (a download task would write the
/// plain file to a temp folder first) on an ephemeral session with no cache.
final class EncryptingDownload: NSObject, URLSessionDataDelegate {
    struct Result {
        var length: UInt64
        var mimeType: String
    }

    private let destination: URL
    private let partial: URL
    private let writer: EncryptedAudioFile.Writer
    private let progress: (Double) -> Void
    private var expected: Int64 = 0
    private var received: Int64 = 0
    private var mimeType = "audio/mpeg"
    private var failure: Error?
    private var continuation: CheckedContinuation<Result, Error>?

    private init(destination: URL, key: SymmetricKey, progress: @escaping (Double) -> Void) throws {
        self.destination = destination
        partial = destination.appendingPathExtension("part")
        try? FileManager.default.removeItem(at: partial)
        writer = try EncryptedAudioFile.Writer(fileURL: partial, key: key)
        self.progress = progress
    }

    static func run(from url: URL, to destination: URL, key: SymmetricKey, progress: @escaping (Double) -> Void) async throws -> Result {
        let download = try EncryptingDownload(destination: destination, key: key, progress: progress)
        let config = URLSessionConfiguration.ephemeral
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        let session = URLSession(configuration: config, delegate: download, delegateQueue: queue)
        defer { session.finishTasksAndInvalidate() }
        let task = session.dataTask(with: url)
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                queue.addOperation {
                    download.continuation = continuation
                    task.resume()
                }
            }
        } onCancel: {
            task.cancel()
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            failure = URLError(.badServerResponse)
            completionHandler(.cancel)
            return
        }
        expected = http.expectedContentLength
        if let type = http.mimeType, type.hasPrefix("audio/") { mimeType = type }
        completionHandler(.allow)
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard failure == nil else { return }
        do {
            try writer.append(data)
            received += Int64(data.count)
            if expected > 0 { progress(min(1, Double(received) / Double(expected))) }
        } catch {
            failure = error
            dataTask.cancel()
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        defer { continuation = nil }
        do {
            if let failure { throw failure }
            if let error { throw error }
            if expected > 0, received != expected { throw URLError(.networkConnectionLost) }
            let length = try writer.finish()
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: partial, to: destination)
            continuation?.resume(returning: Result(length: length, mimeType: mimeType))
        } catch {
            try? FileManager.default.removeItem(at: partial)
            continuation?.resume(throwing: error)
        }
    }
}

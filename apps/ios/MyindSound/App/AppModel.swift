import ClerkKit
import ConvexMobile
import Foundation
import MyindWear
import Observation
import SwiftUI

/// Build and launch configuration: the Convex URL and Clerk key from Info.plist (Config/App.xcconfig), and
/// the `-mock` / `-screen` launch arguments.
struct AppConfig {
    var convexURL: String?
    var clerkPublishableKey: String?
    var isMock: Bool
    var screen: LaunchScreen

    static func current(bundle: Bundle = .main, arguments: [String] = ProcessInfo.processInfo.arguments) -> AppConfig {
        func plist(_ key: String) -> String? {
            let value = (bundle.object(forInfoDictionaryKey: key) as? String)?.trimmingCharacters(in: .whitespaces)
            return (value?.isEmpty ?? true) || value?.hasPrefix("$(") == true ? nil : value
        }
        return AppConfig(
            convexURL: plist("MSConvexURL"),
            clerkPublishableKey: plist("MSClerkPublishableKey"),
            // Unit tests run inside the app: never reach Clerk or Convex from them.
            isMock: Self.flag("-mock", in: arguments) || AppSession.usesSampleData
                || ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] != nil,
            screen: LaunchScreen.fromLaunchArguments(arguments)
        )
    }

    /// `-mock` alone, or `-mock YES`; `-mock NO` is off.
    static func flag(_ name: String, in arguments: [String]) -> Bool {
        guard let index = arguments.firstIndex(of: name) else { return false }
        if index + 1 < arguments.count, ["no", "0", "false"].contains(arguments[index + 1].lowercased()) { return false }
        return true
    }
}

/// Loading state for a screen's data.
enum Loadable<Value: Equatable>: Equatable {
    case loading
    case loaded(Value)
    case failed(String)

    var value: Value? {
        if case .loaded(let value) = self { return value }
        return nil
    }
}

/// The copy in the rack's focus view and how its host opens.
struct RackFocus: Equatable {
    var slug: String
    var mode: HostMode
}

/// The composition root: one API, one auth model, one audio engine and one play event queue for the app.
@MainActor
@Observable
final class AppModel {
    let config: AppConfig
    @ObservationIgnored let api: MyindAPI
    let auth: AuthModel
    let audio: AudioEngine
    @ObservationIgnored let playQueue: PlayEventQueue
    /// BUN-2: release bundles on disk.
    @ObservationIgnored let bundles = BundleStore()
    /// AUD-3..6: encrypted offline copies.
    let downloads: DownloadManager
    /// NAT-4: the warm release host.
    @ObservationIgnored private(set) lazy var hosts = HostPool(app: self)
    /// The release experience on screen (RootView presents it full screen).
    var hostRoute: HostRoute?
    @ObservationIgnored private(set) var hostController: ReleaseHostController?
    /// When each context arrived, to carry `serverNow` forward offline.
    @ObservationIgnored private var contextFetchedAt: [String: Date] = [:]
    /// When the library arrived: its `serverNow` corrects the rack's drop countdowns (DROP-1).
    private(set) var libraryFetchedAt: Date?
    /// RACK-2: the copy lifted out of the rack into the focus view, and its host (nil without a bundle).
    private(set) var rackFocus: RackFocus?
    @ObservationIgnored private(set) var focusController: ReleaseHostController?

    private(set) var library: Loadable<LibrarySnapshot> = .loading
    private(set) var contexts: [String: ReleaseContext] = [:]
    private(set) var tracks: [String: [Track]] = [:]
    private(set) var awards: AwardsSummary = .empty
    // Shell navigation.
    var tab: HUDTab = .library
    var showPlayer = false
    var listenPath = NavigationPath()
    var libraryPath = NavigationPath()

    /// Seconds queued on this device per release, for the WEAR-9 provisional overlay.
    private(set) var queuedSeconds: [String: Double] = [:]

    init(config: AppConfig) {
        self.config = config
        if config.isMock {
            let api = MockAPI()
            self.api = api
            self.auth = AuthModel(backend: MockAuthBackend(startSignedIn: config.screen != .signin))
        } else {
            let convexURL = config.convexURL ?? "https://decisive-iguana-954.convex.cloud"
            var backend: AuthBackend?
            let client: ConvexClient
            if let key = config.clerkPublishableKey {
                Clerk.configure(publishableKey: key)
                let authed = ConvexClientWithAuth<String>(deploymentUrl: convexURL, authProvider: ClerkConvexTokenProvider())
                backend = ClerkAuthBackend(convex: authed)
                client = authed
            } else {
                client = ConvexClient(deploymentUrl: convexURL)
            }
            self.api = ConvexAPI(client: client)
            self.auth = AuthModel(backend: backend)
        }
        let api = self.api
        let queue = PlayEventQueue(fileURL: config.isMock ? Self.mockQueueURL : PlayEventQueue.defaultFileURL) { events in
            try await api.recordPlayEvents(events).map(\.idempotencyKey)
        }
        self.playQueue = queue
        self.audio = AudioEngine(api: api, playQueue: queue)
        let downloads = DownloadManager(api: api)
        self.downloads = downloads
        // AUD-4: a downloaded owner's copy plays from disk.
        audio.localAsset = { slug, trackId in downloads.asset(slug: slug, trackId: trackId) }
    }

    /// `-mock` plays never mix with a real account's queue.
    private static var mockQueueURL: URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("mock-play-events.json")
    }

    // MARK: Lifecycle

    func start() async {
        await auth.restore()
        guard auth.isSignedIn else { return }
        downloads.setUser(auth.profile?.userId)
        await refresh()
        if config.isMock { await loadMockDeck() }
    }

    /// `-mock`: LIT sits in the deck, paused, so screenshots show the now playing bar as the site does.
    private func loadMockDeck() async {
        guard audio.loaded == nil, config.screen != .player, let release = ownedReleases.first,
              let list = try? await loadTracks(slug: release.slug) else { return }
        audio.load(release: release, tracks: list, startAt: 0, autoplay: false)
    }

    /// Foreground (WEAR-9): send what was queued offline, then reload.
    func foregrounded() async {
        guard auth.isSignedIn else { return }
        await playQueue.flush()
        flushPendingUnwraps()
        await refresh()
    }

    func refresh() async {
        do {
            let snapshot = try await api.library()
            libraryFetchedAt = Date()
            library = .loaded(snapshot)
            if downloads.states.isEmpty { downloads.setUser(auth.profile?.userId) }
            // AUD-5 / AUD-6: a successful library is the entitlement check for downloads.
            downloads.sync(snapshot)
            // BUN-4: new bundle versions download in the background.
            bundles.prefetch(snapshot.releases)
            for release in snapshot.releases {
                await loadContext(slug: release.slug)
            }
            hosts.prewarm()
            awards = (try? await api.myAwards()) ?? awards
        } catch {
            library = .failed(Self.message(error))
        }
        await updateQueuedSeconds()
    }

    func loadContext(slug: String) async {
        if var context = try? await api.context(slug: slug) {
            // A local unwrap still waiting for the server wins (RACK-3: the unwrap plays once).
            if pendingUnwraps.contains(slug) { context.unwrapped = true }
            contexts[slug] = context
            contextFetchedAt[slug] = Date()
        }
    }

    func loadTracks(slug: String) async throws -> [Track] {
        if let cached = tracks[slug], !cached.isEmpty { return cached }
        let fetched = try await api.tracks(slug: slug)
        tracks[slug] = fetched
        return fetched
    }

    func signOut() async {
        closeHost()
        closeFocus()
        audio.eject()
        downloads.setUser(nil)
        await playQueue.flush()
        await auth.signOut()
        library = .loading
        contexts = [:]
        tracks = [:]
        awards = .empty
        AppSession.leaveSampleData()
    }

    // MARK: Wear (WEAR-9)

    private func updateQueuedSeconds() async {
        var seconds: [String: Double] = [:]
        for event in await playQueue.pendingEvents {
            seconds[event.slug, default: 0] += event.playedSec
        }
        queuedSeconds = seconds
    }

    /// The server's wear level, plus the plays still waiting on this device, computed with the same function
    /// the server uses (packages/wear-swift). The server value replaces it once the queue flushes.
    func wearLevel(slug: String) -> Double? {
        guard let context = contexts[slug] else { return nil }
        let queued = queuedSeconds[slug] ?? 0
        guard queued > 0, let inputs = context.wearInputs else { return context.wearLevel }
        let stats = WearStats(
            playSeconds: inputs.playSeconds + queued,
            lentPlaySeconds: inputs.lentPlaySeconds,
            loads: inputs.loads,
            ejects: inputs.ejects
        )
        return (try? computeWear(seed: inputs.seed, stats: stats, version: inputs.version))?.level ?? context.wearLevel
    }

    // MARK: Release host (BUN-3, RACK-2..4)

    /// OPEN DECK and the rack tiles: the release's experience, full screen.
    func openHost(slug: String) {
        hostController = hosts.controller(for: slug)
        hostRoute = HostRoute(slug: slug)
    }

    func closeHost() {
        if let controller = hostController { hosts.closed(controller) }
        hostController = nil
        hostRoute = nil
    }

    // MARK: Rack (RACK-1..3)

    /// RACK-3: the film peel plays once per copy, so only an unwrapped copy opens in sleeve mode.
    func rackMode(slug: String) -> HostMode {
        (contexts[slug]?.unwrapped ?? release(slug: slug)?.unwrapped ?? false) ? .sleeve : .full
    }

    /// A tile was tapped: lift the copy into the focus view, with its host warming behind the splash.
    func openFocus(slug: String) {
        guard let release = release(slug: slug), release.ownership != .upcoming, release.ownership != .locked else { return }
        let mode = rackMode(slug: slug)
        focusController = release.bundle == nil ? nil : hosts.controller(for: slug, mode: mode)
        rackFocus = RackFocus(slug: slug, mode: mode)
    }

    /// After the reverse shared-element move: the page is torn down and a fresh one warms behind it.
    func closeFocus() {
        if let controller = focusController { hosts.closed(controller) }
        focusController = nil
        rackFocus = nil
    }

    /// Server time now for the rack's countdowns (DROP-1).
    func libraryServerNow(at date: Date = Date()) -> Date {
        RackRules.serverNow(deviceNow: date, serverNowAtFetch: library.value?.serverNow, fetchedAt: libraryFetchedAt)
    }

    /// The copy's wear descriptor for the rack's scuffs: the server's inputs plus plays queued here (WEAR-9).
    func wearDescriptor(slug: String) -> WearDescriptor? {
        guard let context = contexts[slug], let inputs = context.wearInputs else { return nil }
        let stats = WearStats(
            playSeconds: inputs.playSeconds + (queuedSeconds[slug] ?? 0),
            lentPlaySeconds: inputs.lentPlaySeconds,
            loads: inputs.loads,
            ejects: inputs.ejects
        )
        return try? computeWear(seed: inputs.seed, stats: stats, version: inputs.version)
    }

    /// The stickers on a copy (LB-1, LB-4).
    func stickers(for release: LibraryRelease) -> [RackSticker] {
        let edition = release.editionNumber ?? contexts[release.slug]?.editionNumber
        return RackRules.stickers(
            edition: edition,
            leaderboardSize: release.leaderboardSize,
            tier: awards.tier,
            countsTowardTier: release.ownership == .owned && awards.placements.contains { $0.slug == release.slug }
        )
    }

    /// Server time now: the context's `serverNow` carried forward by the device clock since it arrived.
    func serverNow(slug: String) -> Date {
        guard let serverNow = contexts[slug]?.serverNow, let fetched = contextFetchedAt[slug] else { return Date() }
        return serverNow.addingTimeInterval(Date().timeIntervalSince(fetched))
    }

    // MARK: Unwrap and cartridge events

    private static let pendingUnwrapsKey = "MSPendingUnwraps"

    private var pendingUnwraps: Set<String> {
        get { Set(UserDefaults.standard.stringArray(forKey: Self.pendingUnwrapsKey) ?? []) }
        set { UserDefaults.standard.set(Array(newValue), forKey: Self.pendingUnwrapsKey) }
    }

    /// RACK-3: recorded here at once (and on disk until the server has it), so the unwrap never plays twice,
    /// offline included.
    func markUnwrapped(slug: String) {
        contexts[slug]?.unwrapped = true
        pendingUnwraps.insert(slug)
        flushPendingUnwraps()
    }

    func flushPendingUnwraps() {
        for slug in pendingUnwraps {
            Task {
                do {
                    try await api.markUnwrapped(slug: slug)
                    pendingUnwraps.remove(slug)
                } catch {
                    // Kept for the next foreground.
                }
            }
        }
    }

    func recordCartridge(slug: String, kind: CartridgeEventKind) {
        let key = UUID().uuidString.lowercased()
        Task { try? await api.recordCartridgeEvent(slug: slug, kind: kind, idempotencyKey: key) }
    }

    /// The bridge `wear` value: computeWear on the server's inputs plus plays still queued here (WEAR-9),
    /// with the bundle's declared safe zones. Nil unless the copy wears (owned or lent).
    func wearPayload(slug: String, safeZones: [BundleManifest.SafeZone]?) -> [String: Any]? {
        guard let context = contexts[slug], let inputs = context.wearInputs,
              context.ownership == .owned || context.ownership == .lent else { return nil }
        let queued = queuedSeconds[slug] ?? 0
        let stats = WearStats(
            playSeconds: inputs.playSeconds + queued,
            lentPlaySeconds: inputs.lentPlaySeconds,
            loads: inputs.loads,
            ejects: inputs.ejects
        )
        let zones = safeZones?.map { WearSafeZone(surface: $0.surface, x: $0.x, y: $0.y, w: $0.w, h: $0.h) }
        guard let descriptor = (try? computeWear(seed: inputs.seed, stats: stats, version: inputs.version, safeZones: zones))
                ?? (try? computeWear(seed: inputs.seed, stats: stats, version: inputs.version)),
              let json = try? serializeDescriptor(descriptor),
              let object = try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any] else { return nil }
        return object
    }

    // MARK: Helpers

    var ownedReleases: [LibraryRelease] { library.value?.releases ?? [] }

    /// The release LISTEN shows: the one in the deck, else the newest copy, else the first upcoming one.
    var featuredRelease: LibraryRelease? {
        audio.loaded?.release ?? ownedReleases.first ?? library.value?.upcoming.first
    }

    /// The release's DiscDesign (library row, else its context). Nil for LIT.
    func design(slug: String) -> DiscDesign? {
        release(slug: slug)?.design ?? contexts[slug]?.design
    }

    /// The rack's spin loop for the release, when the portal rendered one.
    func rackRender(slug: String) -> RackRender? {
        release(slug: slug)?.rack ?? contexts[slug]?.rack
    }

    /// Where the release's backdrop art comes from (BackdropRules picks): the art the design names, then the
    /// same file inside the installed bundle (`design/<name>`, offline).
    func backdropChoice(slug: String?) -> BackdropChoice {
        guard let slug else { return .city }
        let design = design(slug: slug)
        return BackdropRules.choice(
            coverURL: release(slug: slug)?.coverURL, design: design, bundledArt: bundledDesignFile(slug: slug, design?.backdropArt)
        )
    }

    /// The release's cover for the sleeve on its pages (generated discs; LIT uses its bundled art).
    func coverArtURL(slug: String) -> URL? {
        guard let design = design(slug: slug) else { return release(slug: slug)?.coverURL }
        return release(slug: slug)?.coverURL ?? design.resolve(design.coverArt) ?? bundledDesignFile(slug: slug, design.coverArt)
    }

    /// `design/<file name>` inside the release's installed bundle, when it's there.
    private func bundledDesignFile(slug: String, _ reference: String?) -> URL? {
        guard let name = reference.map({ ($0 as NSString).lastPathComponent }), !name.isEmpty,
              let root = bundles.installed(slug: slug)?.root else { return nil }
        let file = root.appendingPathComponent("design/\(name)")
        return FileManager.default.fileExists(atPath: file.path) ? file : nil
    }

    func release(slug: String) -> LibraryRelease? {
        (library.value?.releases ?? []).first { $0.slug == slug } ?? library.value?.upcoming.first { $0.slug == slug }
    }

    static func message(_ error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? "Something went wrong. Try again."
    }
}

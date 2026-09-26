import AVFoundation
import os
import QuartzCore
import UIKit
import WebKit

/// The native side of the bridge (packages/bridge/CONTRACT.md) for one release host. The trust boundary:
/// every message is checked by `BridgeContract.decide` (origin, id, method, params) before anything runs, and
/// every ownership, lend and timing answer comes from the server's `app.context` (ARCH-3).
///
/// - Methods (§4) run against `AppModel`: the context and tracks from the API, playback through the one
///   `AudioEngine`, unwrap and cartridge events through the API, haptics (DS-32), native share and lend sheets.
/// - Events (§6): `playback` frames at up to 60 Hz from a display link while the host is on screen and the app
///   is active, with the spectrum from `AudioTap` (one frame in flight at most, newer frames dropped rather
///   than queued); `layout`, `lifecycle`, `wear` and `ownership` on change.
/// - Page loads (§1.4): `newPage` forgets every id from the last load; a resolve for an older load is dropped.
@MainActor
final class NativeBridge: NSObject {
    let slug: String
    weak var webView: WKWebView?
    private unowned let app: AppModel
    private let manifest: BundleManifest

    /// Host callbacks.
    var onReady: () -> Void = {}
    var onClose: () -> Void = {}
    /// Shows the placeholder share or lend sheet; calls back when it closes.
    var onSheet: (_ kind: HostSheet, _ done: @escaping () -> Void) -> Void = { _, done in done() }

    private var channelKey = ""
    private var generation = 0
    private var seenIds = Set<String>()
    private var readySent = false

    private(set) var foreground = false
    private var layout: [String: Any] = BridgePayload.layout(width: 390, height: 844, regular: false)
    private var lastLayoutKey = ""
    private var lastWearJSON: String?
    private var lastOwnershipJSON: String?

    // Frames
    private var displayLink: CADisplayLink?
    private var frameInFlight = false
    private var lastFrameKey: String?
    private let analyzer = SpectrumAnalyzer()

    private let log = Logger(subsystem: "com.myindsound.app", category: "bridge")
    private lazy var impacts: [BridgeContract.HapticKind: UIImpactFeedbackGenerator] = [
        .light: UIImpactFeedbackGenerator(style: .light),
        .medium: UIImpactFeedbackGenerator(style: .medium),
        .heavy: UIImpactFeedbackGenerator(style: .heavy),
        .rigid: UIImpactFeedbackGenerator(style: .rigid),
        .soft: UIImpactFeedbackGenerator(style: .soft),
    ]
    private lazy var notifier = UINotificationFeedbackGenerator()

    init(slug: String, app: AppModel, manifest: BundleManifest) {
        self.slug = slug
        self.app = app
        self.manifest = manifest
    }

    // MARK: Page loads

    /// A new page load with its own channel key: nothing from the previous load is ever answered.
    func newPage(channelKey: String) {
        generation += 1
        self.channelKey = channelKey
        seenIds = []
        readySent = false
        frameInFlight = false
        lastFrameKey = nil
        lastWearJSON = nil
        lastOwnershipJSON = nil
    }

    /// Navigation away, reload or a WebContent crash: drop every pending id.
    func dropPending() {
        generation += 1
        seenIds = []
        frameInFlight = false
    }

    func teardown() {
        displayLink?.invalidate()
        displayLink = nil
        dropPending()
    }

    // MARK: Messages

    func receive(_ message: WKScriptMessage) {
        guard message.webView === webView else { return }
        let frame = message.frameInfo
        let origin = BridgeContract.Origin(
            isMainFrame: frame.isMainFrame,
            scheme: frame.securityOrigin.protocol,
            host: frame.securityOrigin.host,
            port: frame.securityOrigin.port
        )
        let decision = BridgeContract.decide(body: message.body, origin: origin, slug: slug, seenIds: seenIds)
        #if DEBUG
        let method = (message.body as? [String: Any])?["method"] as? String ?? "?"
        log.debug("message \(method.prefix(32), privacy: .public) from \(origin.scheme, privacy: .public)://\(origin.host, privacy: .public) main=\(origin.isMainFrame)")
        #endif
        switch decision {
        case .drop(let reason):
            log.debug("dropped: \(reason, privacy: .public)")
        case .reject(let id, let error):
            seenIds.insert(id)
            resolve(id, generation: generation, result: nil, error: error)
        case .call(let id, let call):
            if let id { seenIds.insert(id) }
            let generation = self.generation
            Task { await self.run(call, id: id, generation: generation) }
        }
    }

    private func run(_ call: BridgeContract.Call, id: String?, generation: Int) async {
        do {
            let result = try await perform(call)
            if let id { resolve(id, generation: generation, result: result, error: nil) }
        } catch let error as BridgeContract.BridgeError {
            if let id { resolve(id, generation: generation, result: nil, error: error) }
        } catch {
            if let id { resolve(id, generation: generation, result: nil, error: .init(.internalError, "Something went wrong")) }
        }
    }

    // MARK: Methods (§4)

    private typealias BridgeError = BridgeContract.BridgeError

    private var release: LibraryRelease? { app.release(slug: slug) }
    private var context: ReleaseContext? { app.contexts[slug] }
    private var audio: AudioEngine { app.audio }
    private var isThisRelease: Bool { audio.loaded?.release.slug == slug }

    private func perform(_ call: BridgeContract.Call) async throws -> Any? {
        switch call {
        case .getContext:
            await app.loadContext(slug: slug)
            guard let context else { throw BridgeError(.offline, "No saved copy of this release's details") }
            return contextPayload(context)

        case .getTracks:
            return try await tracksPayload()

        case .play(let trackId, let startAt):
            try await play(trackId: trackId, startAt: startAt)
            return nil

        case .pause:
            if isThisRelease { audio.pause() }
            return nil

        case .seek(let seconds):
            if isThisRelease { audio.seek(to: min(seconds, max(0, audio.duration))) }
            return nil

        case .next:
            try checkCanPlay()
            if isThisRelease, let loaded = audio.loaded, audio.index + 1 < loaded.tracks.count { audio.next() }
            return nil

        case .previous:
            try checkCanPlay()
            if isThisRelease { audio.previous() }
            return nil

        case .getPlaybackState:
            return playbackState()

        case .setVolume(let volume):
            audio.setVolume(Float(volume))
            return nil

        case .markUnwrapped:
            guard context?.ownership == .owned else { throw BridgeError(.notAllowed, "Only the owner's copy unwraps") }
            app.markUnwrapped(slug: slug)
            return nil

        case .cartridgeLoaded, .cartridgeEjected:
            // Resolved once queued; copies that can't wear (preview, locked) record nothing.
            if let ownership = context?.ownership, ownership == .owned || ownership == .lent {
                app.recordCartridge(slug: slug, kind: call == .cartridgeLoaded ? .load : .eject)
            }
            return nil

        case .requestShare, .requestLend:
            let lend = call == .requestLend
            guard let ownership = context?.ownership, lend ? ownership == .owned : (ownership == .owned || ownership == .lent) else {
                throw BridgeError(.notAllowed, lend ? "Only the owner can lend this copy" : "Nothing to share yet")
            }
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
                onSheet(lend ? .lend : .share) { done.resume() }
            }
            return nil

        case .haptic(let kind):
            if kind == .success {
                notifier.notificationOccurred(.success)
            } else {
                impacts[kind]?.impactOccurred()
            }
            return nil

        case .playSound:
            // DS-31: native plays only names in its own table, and it is empty in v1: the bundle plays its own
            // mechanical sounds through Web Audio (NAT-6). Unknown names are ignored silently.
            return nil

        case .close:
            onClose()
            return nil

        case .ready:
            if !readySent {
                readySent = true
                onReady()
            }
            return nil
        }
    }

    private func checkCanPlay() throws {
        guard let context else { throw BridgeError(.offline, "No saved copy of this release's details") }
        switch context.ownership {
        case .owned:
            if let lend = context.lend, lend.role == .lender, lend.isActive {
                throw BridgeError(.notAllowed, "This copy is out on loan")
            }
        case .lent:
            if let lend = context.lend, !lend.isActive { throw BridgeError(.lendEnded, "This lend has ended") }
        case .preview, .locked, .upcoming:
            // Previews play on the website for now; the app streams owned and lent copies only.
            throw BridgeError(.notAllowed, "Get your own copy to play it here")
        }
    }

    private func play(trackId: String, startAt: Double?) async throws {
        try checkCanPlay()
        let tracks: [Track]
        do {
            tracks = try await app.loadTracks(slug: slug)
        } catch {
            throw BridgeError(.offline, "Couldn't load the tracklist")
        }
        guard let index = tracks.firstIndex(where: { $0.id == trackId }) else {
            throw BridgeError(.notFound, "That track isn't on this release")
        }
        guard let release else { throw BridgeError(.notFound, "Release not in your library") }
        if isThisRelease {
            audio.play(trackAt: index, startAt: startAt)
        } else {
            // The bundle reports its own cartridge load (cartridgeLoaded), so the engine doesn't record one.
            audio.load(
                release: release, tracks: tracks, startAt: index, lendId: context?.lend?.role == .borrower ? context?.lend?.lendId : nil,
                autoplay: true, seconds: startAt ?? 0, recordsCartridge: false
            )
        }
    }

    // MARK: Payloads

    private func contextPayload(_ context: ReleaseContext) -> [String: Any] {
        BridgePayload.context(
            context,
            wear: app.wearPayload(slug: slug, safeZones: manifest.wearSafeZones),
            layout: layout,
            foreground: foreground,
            serverNow: app.serverNow(slug: slug)
        )
    }

    private func tracksPayload() async throws -> [[String: Any]] {
        let tracks: [Track]
        do {
            tracks = try await app.loadTracks(slug: slug)
        } catch {
            throw BridgeError(.offline, "Couldn't load the tracklist")
        }
        let ownership = context?.ownership ?? .preview
        let dropped = context?.dropAt.map { $0 <= app.serverNow(slug: slug) } ?? true
        return BridgePayload.tracks(tracks, ownership: ownership, dropped: dropped)
    }

    /// PlaybackState (§5) for this release. Another release in the deck reads as idle here.
    func playbackState() -> [String: Any] {
        guard isThisRelease, let track = audio.currentTrack else {
            return ["trackId": NSNull(), "status": "idle", "positionSec": 0, "rate": 0]
        }
        let status: String
        switch audio.status {
        case .idle: status = "idle"
        case .loading: status = "loading"
        case .playing: status = "playing"
        case .paused: status = "paused"
        case .stopped: status = audio.reachedEnd ? "ended" : "stopped"
        case .failed: status = "error"
        }
        let duration = audio.duration
        let position = audio.reachedEnd ? duration : audio.currentTime
        var out: [String: Any] = [
            "trackId": BridgeContract.isValidTrackId(track.id) ? track.id : NSNull(),
            "status": status,
            "positionSec": BridgePayload.seconds(max(0, duration > 0 ? min(position, duration) : position)),
            "rate": status == "playing" ? 1 : 0,
        ]
        if duration.isFinite, duration > 0 { out["durationSec"] = BridgePayload.seconds(duration) }
        return out
    }

    // MARK: Events

    func setForeground(_ value: Bool) {
        guard value != foreground else { return }
        foreground = value
        emit("lifecycle", ["state": value ? "foreground" : "background"])
        if value {
            lastFrameKey = nil
            startFrames()
        } else {
            stopFrames()
        }
    }

    /// DUO-7 from the container size: size class from the width (never the device orientation, DUO-2).
    func setLayout(size: CGSize, regular: Bool) {
        guard size.width > 0, size.height > 0 else { return }
        let next = BridgePayload.layout(width: size.width, height: size.height, regular: regular)
        let key = "\(next["widthPt"]!)x\(next["heightPt"]!)-\(regular)"
        guard key != lastLayoutKey else { return }
        lastLayoutKey = key
        layout = next
        emit("layout", next)
    }

    /// `wear` and `ownership` when `app.context` changes (WEAR-10, lend and drop changes).
    func contextChanged() {
        guard let context else { return }
        let ownership = BridgePayload.ownershipEvent(context)
        if let json = Self.json(ownership), json != lastOwnershipJSON {
            let first = lastOwnershipJSON == nil
            lastOwnershipJSON = json
            if !first { emit("ownership", ownership) }
        }
        if let wear = app.wearPayload(slug: slug, safeZones: manifest.wearSafeZones), let json = Self.json(wear), json != lastWearJSON {
            let first = lastWearJSON == nil
            lastWearJSON = json
            if !first { emit("wear", wear) }
        }
    }

    private static func json(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) else { return nil }
        return String(data: data, encoding: .utf8)
    }

    func emit(_ event: String, _ payload: [String: Any]) {
        guard let webView, !channelKey.isEmpty else { return }
        webView.callAsyncJavaScript(
            "window.myind.__emit(k, e, p)",
            arguments: ["k": channelKey, "e": event, "p": payload],
            in: nil, in: .page, completionHandler: nil
        )
    }

    private func resolve(_ id: String, generation: Int, result: Any?, error: BridgeError?) {
        // Never answer an id from an earlier page load (§1.4).
        guard generation == self.generation, let webView, !channelKey.isEmpty else { return }
        webView.callAsyncJavaScript(
            "window.myind.__resolve(k, i, r, x)",
            arguments: ["k": channelKey, "i": id, "r": result ?? NSNull(), "x": error?.payload ?? NSNull()],
            in: nil, in: .page, completionHandler: nil
        )
    }

    // MARK: Playback frames (BRG-4)

    private func startFrames() {
        guard displayLink == nil else { return }
        let link = CADisplayLink(target: FrameTarget(self), selector: #selector(FrameTarget.tick))
        link.preferredFrameRateRange = CAFrameRateRange(minimum: 30, maximum: Float(BridgeContract.maxFramesPerSecond), preferred: Float(BridgeContract.maxFramesPerSecond))
        link.add(to: .main, forMode: .common)
        displayLink = link
    }

    private func stopFrames() {
        displayLink?.invalidate()
        displayLink = nil
    }

    fileprivate func tick() {
        guard foreground, let webView, !channelKey.isEmpty else { return }
        let state = playbackState()
        let playing = (state["status"] as? String) == "playing"
        let key = "\(state["trackId"] ?? "")|\(state["status"] ?? "")"
        let changed = key != lastFrameKey
        // Nothing to say while stopped, and never more than one frame in flight: the newest wins.
        guard (changed || playing), !frameInFlight else { return }
        var frame = state
        let spectrum = playing ? (analyzer.analyze(AudioTap.shared) ?? .silent) : .silent
        if !playing { analyzer.reset() }
        frame["bands"] = spectrum.bands
        frame["waveform"] = spectrum.waveform
        frame["level"] = spectrum.level
        frame["bass"] = spectrum.bass
        #if DEBUG
        if changed {
            let session = AVAudioSession.sharedInstance()
            log.debug("frame \(key, privacy: .public) session=\(session.category.rawValue, privacy: .public) opts=\(session.categoryOptions.rawValue) otherAudio=\(session.isOtherAudioPlaying)")
        }
        #endif
        frameInFlight = true
        lastFrameKey = key
        let generation = self.generation
        webView.callAsyncJavaScript(
            "window.myind.__emit(k, 'playback', p)",
            arguments: ["k": channelKey, "p": frame],
            in: nil, in: .page
        ) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self, self.generation == generation else { return }
                self.frameInFlight = false
            }
        }
    }
}

enum HostSheet: String, Identifiable {
    case share, lend
    var id: String { rawValue }
}

/// CADisplayLink retains its target; this breaks the cycle.
private final class FrameTarget: NSObject {
    weak var bridge: NativeBridge?
    init(_ bridge: NativeBridge) { self.bridge = bridge }
    @objc func tick() { MainActor.assumeIsolated { bridge?.tick() } }
}

/// `WKUserContentController` retains its handlers; this keeps the bridge collectable.
final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    private let receive: @MainActor (WKScriptMessage) -> Void
    init(_ receive: @escaping @MainActor (WKScriptMessage) -> Void) { self.receive = receive }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { receive(message) }
    }
}

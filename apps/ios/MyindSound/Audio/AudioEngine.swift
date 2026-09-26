import AVFoundation
import MediaPlayer
import os
import Observation
import UIKit

/// The native player (ARCH-2: music never plays through the web layer).
///
/// - AUD-2: every track streams from a `media.getStreamUrl` link, fetched per track. A link lives five
///   minutes, and a range request after it has expired gets a 403, so the engine refreshes the link before
///   resuming a long pause and swaps in a fresh item if a stream fails mid-track.
/// - AUD-7: an `AVQueuePlayer` with the next track queued a minute before the current one ends, so tracks
///   within a release run gaplessly; background audio in an `AVAudioSession` of category `.playback`.
/// - RACK-5: lock screen and Control Center through `MPNowPlayingInfoCenter` and `MPRemoteCommandCenter`.
/// - WEAR-6/9: each track heard becomes one `PlayEvent` with its own UUID, queued on disk and flushed after
///   every track and on foreground.
@MainActor
@Observable
final class AudioEngine {
    enum Status: Equatable {
        case idle, loading, playing, paused, stopped
        case failed(String)
    }

    struct Loaded: Equatable {
        var release: LibraryRelease
        var tracks: [Track]
        var lendId: String?
    }

    private(set) var loaded: Loaded?
    private(set) var index = 0
    private(set) var status: Status = .idle
    private(set) var elapsed: Double = 0
    private(set) var duration: Double = 0
    /// The last track of the release played to its end (bridge status `ended`).
    private(set) var reachedEnd = false
    /// The player's own music level 0...1 (bridge `setVolume`), never the system volume.
    private(set) var volume: Float = 1
    /// Bumped by every track start: work for an older start is abandoned (bridge "last play wins").
    private(set) var playEpoch = 0
    /// AUD-4: a decrypting asset for a downloaded track (`DownloadManager.asset`), preferred over streaming.
    /// Never consulted for lent copies.
    @ObservationIgnored var localAsset: ((_ slug: String, _ trackId: String) -> AVURLAsset?)?
    var repeatOn = false {
        didSet { if repeatOn != oldValue { requeueNext() } }
    }

    var currentTrack: Track? {
        guard let loaded, loaded.tracks.indices.contains(index) else { return nil }
        return loaded.tracks[index]
    }

    var isPlaying: Bool { status == .playing }

    /// The live position (the periodic observer only ticks four times a second; bridge frames run at 60).
    var currentTime: Double {
        guard player.currentItem != nil, !reachedEnd else { return elapsed }
        let seconds = player.currentTime().seconds
        return seconds.isFinite ? max(0, seconds) : elapsed
    }

    static let lastPlayedKey = "MSLastPlayedSlug"
    var progress: Double { duration > 0 ? min(1, elapsed / duration) : 0 }

    /// Seconds before the end of a track at which the next one is fetched and queued.
    static let prequeueLead: Double = 60
    /// A link is refreshed when it has less than this left (resume after a pause, queueing).
    static let urlSafetyMargin: TimeInterval = 45
    /// Plays shorter than this aren't worth a wear event.
    static let minimumEventSeconds: Double = 1

    @ObservationIgnored private let api: MyindAPI
    @ObservationIgnored private let playQueue: PlayEventQueue
    @ObservationIgnored private let player = AVQueuePlayer()
    @ObservationIgnored private var urls: [String: StreamURL] = [:]
    @ObservationIgnored private var itemIndex: [ObjectIdentifier: Int] = [:]
    @ObservationIgnored private var queuedNext: Int?
    @ObservationIgnored private var timeObserver: Any?
    @ObservationIgnored private var observations: [NSKeyValueObservation] = []
    @ObservationIgnored private var notificationTokens: [NSObjectProtocol] = []
    @ObservationIgnored private var session: Session?
    @ObservationIgnored private var lastTick: Date?
    @ObservationIgnored private var recovering = false
    @ObservationIgnored private var artwork: MPMediaItemArtwork?
    @ObservationIgnored private var volumeRamp: Task<Void, Never>?

    /// One listening session of one track: becomes one PlayEvent.
    private struct Session {
        var trackIndex: Int
        var startedAt: Date?
        var playedSec: Double = 0
    }

    init(api: MyindAPI, playQueue: PlayEventQueue) {
        self.api = api
        self.playQueue = playQueue
        player.actionAtItemEnd = .advance
        player.automaticallyWaitsToMinimizeStalling = true
        configureAudioSession()
        observePlayer()
        configureRemoteCommands()
    }

    // MARK: Transport

    /// Puts a release in the deck and starts `index` (RACK-2). Records a cartridge load.
    /// `recordsCartridge: false` when the caller reports the load itself (the release bundle's `cartridgeLoaded`).
    func load(
        release: LibraryRelease, tracks: [Track], startAt index: Int = 0, lendId: String? = nil,
        autoplay: Bool = true, seconds: Double = 0, recordsCartridge: Bool = true
    ) {
        guard !tracks.isEmpty else { return }
        let sameRelease = loaded?.release.slug == release.slug
        loaded = Loaded(release: release, tracks: tracks, lendId: lendId)
        artwork = Self.artwork(for: release)
        // NAT-4: the host pre-warms the most recently played release.
        UserDefaults.standard.set(release.slug, forKey: Self.lastPlayedKey)
        if !sameRelease && recordsCartridge {
            recordCartridge(.load, slug: release.slug)
        }
        start(trackAt: max(0, min(index, tracks.count - 1)), autoplay: autoplay, startAt: seconds)
    }

    /// Bridge `play(trackId, startAt?)` (CONTRACT.md §7): resume the loaded track when it's paused and no
    /// `startAt` is given; otherwise (re)start it from `startAt` (default 0), seeking before audio renders.
    func play(trackAt newIndex: Int, startAt seconds: Double?) {
        guard let loaded, loaded.tracks.indices.contains(newIndex) else { return }
        if seconds == nil, newIndex == index, status == .paused, player.currentItem != nil {
            play()
            return
        }
        start(trackAt: newIndex, autoplay: true, startAt: seconds ?? 0)
    }

    /// Bridge `setVolume`: ramps the player's level over about 80 ms so the change doesn't click.
    func setVolume(_ value: Float) {
        let target = max(0, min(1, value))
        let from = player.volume
        volume = target
        volumeRamp?.cancel()
        volumeRamp = Task { @MainActor in
            let steps = 5
            for step in 1...steps {
                guard !Task.isCancelled else { return }
                self.player.volume = from + (target - from) * Float(step) / Float(steps)
                try? await Task.sleep(for: .milliseconds(16))
            }
        }
    }

    func play() {
        guard loaded != nil else { return }
        if player.currentItem == nil {
            start(trackAt: index, autoplay: true)
            return
        }
        // A paused stream may need more bytes; a link that's about to lapse is swapped first (AUD-2).
        if !isLocal(player.currentItem), let track = currentTrack, let url = urls[track.id], !url.isValid(for: Self.urlSafetyMargin) {
            Task { await self.replaceCurrentItem(resumeAt: self.elapsed, autoplay: true) }
            return
        }
        activateSession()
        player.play()
    }

    func pause() {
        player.pause()
    }

    func togglePlayPause() {
        isPlaying ? pause() : play()
    }

    func next() {
        guard let loaded else { return }
        if index + 1 < loaded.tracks.count {
            start(trackAt: index + 1, autoplay: true)
        } else if repeatOn {
            start(trackAt: 0, autoplay: true)
        }
    }

    /// Back to the start of the track after three seconds, as the deck's PREV key does; otherwise the
    /// previous track.
    func previous() {
        if elapsed > 3 || index == 0 {
            seek(to: 0)
        } else {
            start(trackAt: index - 1, autoplay: isPlaying || status == .loading)
        }
    }

    func select(trackAt newIndex: Int) {
        start(trackAt: newIndex, autoplay: true)
    }

    func seek(to seconds: Double) {
        // Seeking an ended or stopped deck keeps it loaded but paused at that point (CONTRACT.md §7).
        if player.currentItem == nil {
            guard loaded != nil else { return }
            start(trackAt: index, autoplay: false, startAt: min(max(0, seconds), duration))
            return
        }
        let target = CMTime(seconds: max(0, seconds), preferredTimescale: 600)
        player.seek(to: target, toleranceBefore: .zero, toleranceAfter: .zero)
        elapsed = max(0, seconds)
        updateNowPlaying()
    }

    /// Ejects the cartridge: stops, records the eject, clears the deck.
    func eject() {
        finishSession()
        player.pause()
        player.removeAllItems()
        itemIndex.removeAll()
        queuedNext = nil
        if let slug = loaded?.release.slug { recordCartridge(.eject, slug: slug) }
        loaded = nil
        status = .idle
        elapsed = 0
        duration = 0
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        flushSoon()
    }

    /// Sends queued play events (foreground, after each track).
    func flushSoon() {
        Task { await playQueue.flush() }
    }

    // MARK: Items

    private func start(trackAt newIndex: Int, autoplay: Bool, startAt seconds: Double = 0) {
        guard let loaded, loaded.tracks.indices.contains(newIndex) else { return }
        playEpoch += 1
        let epoch = playEpoch
        reachedEnd = false
        finishSession()
        player.pause()
        player.removeAllItems()
        itemIndex.removeAll()
        queuedNext = nil
        index = newIndex
        elapsed = max(0, seconds)
        duration = loaded.tracks[newIndex].durationSeconds
        status = .loading
        session = Session(trackIndex: newIndex)
        updateNowPlaying()
        let track = loaded.tracks[newIndex]
        let slug = loaded.release.slug
        Task {
            do {
                let asset = try await self.asset(for: track, lendId: loaded.lendId, lasting: track.durationSeconds)
                // The fan may have picked another track while the link was on its way (last play wins).
                guard self.loaded?.release.slug == slug, self.index == newIndex, self.playEpoch == epoch else { return }
                let item = self.makeItem(asset: asset, index: newIndex)
                self.player.insert(item, after: nil)
                if seconds > 0 {
                    // Seek before the first audio renders: no audible jump.
                    await self.player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
                    guard self.playEpoch == epoch else { return }
                }
                if autoplay {
                    self.activateSession()
                    self.player.play()
                } else {
                    self.status = .paused
                }
            } catch {
                guard self.index == newIndex, self.playEpoch == epoch else { return }
                self.status = .failed((error as? LocalizedError)?.errorDescription ?? "Couldn't load this track.")
            }
        }
    }

    private func makeItem(asset: AVURLAsset, index: Int) -> AVPlayerItem {
        let item = AVPlayerItem(asset: asset)
        item.preferredForwardBufferDuration = 30
        itemIndex[ObjectIdentifier(item)] = index
        // BRG-4: the spectrum and waveform for the release bundle.
        AudioTap.shared.attach(to: item)
        return item
    }

    /// AUD-4 first (a downloaded owner's copy), else a fresh stream link (AUD-2).
    private func asset(for track: Track, lendId: String?, lasting: Double) async throws -> AVURLAsset {
        if lendId == nil, let slug = loaded?.release.slug, let local = localAsset?(slug, track.id) {
            #if DEBUG
            Logger(subsystem: "com.myindsound.app", category: "audio").debug("track \(track.position): the encrypted download")
            #endif
            return local
        }
        return AVURLAsset(url: try await freshURL(for: track, lendId: lendId, lasting: lasting))
    }

    private func isLocal(_ item: AVPlayerItem?) -> Bool {
        (item?.asset as? AVURLAsset)?.url.scheme == EncryptedAssetLoader.scheme
    }

    /// A cached link with enough life left for `lasting` seconds of playback, else a new one.
    private func freshURL(for track: Track, lendId: String?, lasting: Double) async throws -> URL {
        if let cached = urls[track.id], cached.isValid(for: min(lasting, 240) + Self.urlSafetyMargin) {
            return cached.url
        }
        let fresh = try await api.streamURL(trackId: track.id, lendId: lendId)
        urls[track.id] = fresh
        return fresh.url
    }

    /// The index that follows the current one, honouring repeat.
    private var nextIndex: Int? {
        guard let loaded else { return nil }
        if index + 1 < loaded.tracks.count { return index + 1 }
        return repeatOn ? 0 : nil
    }

    /// AUD-7 gapless: queue the next track behind the current one, with a link fetched now.
    private func queueNextIfDue() {
        guard queuedNext == nil, let loaded, let next = nextIndex, duration > 0,
              duration - elapsed <= Self.prequeueLead else { return }
        queuedNext = next
        let track = loaded.tracks[next]
        let current = player.currentItem
        Task {
            do {
                let asset = try await self.asset(for: track, lendId: loaded.lendId, lasting: 0)
                guard self.queuedNext == next, let current, self.player.currentItem === current else { return }
                let item = self.makeItem(asset: asset, index: next)
                if self.player.canInsert(item, after: current) {
                    self.player.insert(item, after: current)
                }
            } catch {
                // Not fatal: the track end falls through to start(trackAt:) instead.
                self.queuedNext = nil
            }
        }
    }

    /// Repeat changed: drop a queued item that no longer follows.
    private func requeueNext() {
        let items = player.items()
        guard items.count > 1 else {
            queuedNext = nil
            return
        }
        for item in items.dropFirst() {
            player.remove(item)
            itemIndex[ObjectIdentifier(item)] = nil
        }
        queuedNext = nil
        queueNextIfDue()
    }

    /// The stream failed (typically a 403 after the link expired): fetch a new link and pick up where it was.
    private func itemFailed() {
        guard !recovering else {
            status = .failed("Playback stopped. Check your connection.")
            return
        }
        recovering = true
        if let track = currentTrack { urls[track.id] = nil }
        Task {
            await self.replaceCurrentItem(resumeAt: self.elapsed, autoplay: true)
            try? await Task.sleep(for: .seconds(5))
            self.recovering = false
        }
    }

    private func replaceCurrentItem(resumeAt seconds: Double, autoplay: Bool) async {
        guard let loaded, let track = currentTrack else { return }
        let atIndex = index
        do {
            urls[track.id] = nil
            let asset = try await asset(for: track, lendId: loaded.lendId, lasting: track.durationSeconds - seconds)
            guard index == atIndex else { return }
            let item = makeItem(asset: asset, index: atIndex)
            player.removeAllItems()
            queuedNext = nil
            player.insert(item, after: nil)
            await player.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            if autoplay {
                activateSession()
                player.play()
            }
        } catch {
            status = .failed((error as? LocalizedError)?.errorDescription ?? "Couldn't resume this track.")
        }
    }

    // MARK: Observation

    private func observePlayer() {
        timeObserver = player.addPeriodicTimeObserver(forInterval: CMTime(value: 1, timescale: 4), queue: .main) { [weak self] time in
            MainActor.assumeIsolated { self?.tick(time) }
        }
        observations.append(player.observe(\.timeControlStatus, options: [.new]) { [weak self] player, _ in
            let value = player.timeControlStatus
            DispatchQueue.main.async { self?.timeControlChanged(value) }
        })
        observations.append(player.observe(\.currentItem, options: [.new]) { [weak self] player, _ in
            let item = player.currentItem
            DispatchQueue.main.async { self?.currentItemChanged(item) }
        })
        notificationTokens.append(NotificationCenter.default.addObserver(
            forName: AVPlayerItem.didPlayToEndTimeNotification, object: nil, queue: .main
        ) { [weak self] note in
            let id = (note.object as AnyObject?).map(ObjectIdentifier.init)
            MainActor.assumeIsolated { self?.itemEnded(id) }
        })
        notificationTokens.append(NotificationCenter.default.addObserver(
            forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: nil, queue: .main
        ) { [weak self] note in
            let id = (note.object as AnyObject?).map(ObjectIdentifier.init)
            MainActor.assumeIsolated {
                guard let self, let id, self.itemIndex[id] != nil else { return }
                self.itemFailed()
            }
        })
        notificationTokens.append(NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let info = note.userInfo
            MainActor.assumeIsolated { self?.interrupted(info) }
        })
    }

    private func tick(_ time: CMTime) {
        guard player.currentItem != nil else { return }
        let seconds = time.seconds.isFinite ? time.seconds : 0
        elapsed = seconds
        if let itemDuration = player.currentItem?.duration.seconds, itemDuration.isFinite, itemDuration > 0 {
            duration = itemDuration
        }
        let now = Date()
        if player.timeControlStatus == .playing {
            if session?.startedAt == nil { session?.startedAt = now }
            if let lastTick {
                // Wall clock between ticks, capped so a suspended app can't add phantom seconds.
                session?.playedSec += min(1, max(0, now.timeIntervalSince(lastTick))) * Double(player.rate)
            }
            lastTick = now
        } else {
            lastTick = nil
        }
        queueNextIfDue()
    }

    private func timeControlChanged(_ value: AVPlayer.TimeControlStatus) {
        switch value {
        case .playing:
            status = .playing
            lastTick = Date()
        case .paused:
            if status == .playing { status = .paused }
            lastTick = nil
        case .waitingToPlayAtSpecifiedRate:
            if status != .playing { status = .loading }
        @unknown default:
            break
        }
        updateNowPlaying()
    }

    /// The queue advanced to the queued track: the gapless hand-over (AUD-7).
    private func currentItemChanged(_ item: AVPlayerItem?) {
        guard let item, let newIndex = itemIndex[ObjectIdentifier(item)], queuedNext == newIndex else { return }
        finishSession()
        index = newIndex
        queuedNext = nil
        playEpoch += 1
        elapsed = 0
        duration = loaded?.tracks[newIndex].durationSeconds ?? 0
        session = Session(trackIndex: newIndex, startedAt: player.timeControlStatus == .playing ? Date() : nil)
        updateNowPlaying()
        flushSoon()
    }

    /// A track played to its end. With the next one queued, `currentItemChanged` takes over; without one
    /// (it failed to queue in time) the next is started here; at the end of the release the deck stops.
    private func itemEnded(_ id: ObjectIdentifier?) {
        guard let id, let endedIndex = itemIndex[id], endedIndex == index else { return }
        itemIndex[id] = nil
        if let queuedNext, player.items().contains(where: { itemIndex[ObjectIdentifier($0)] == queuedNext }) { return }
        queuedNext = nil
        if nextIndex != nil {
            next()
        } else {
            finishSession()
            status = .stopped
            reachedEnd = true
            elapsed = 0
            updateNowPlaying()
            flushSoon()
        }
    }

    private func interrupted(_ info: [AnyHashable: Any]?) {
        guard let raw = info?[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: raw) else { return }
        if type == .ended,
           let optionsRaw = info?[AVAudioSessionInterruptionOptionKey] as? UInt,
           AVAudioSession.InterruptionOptions(rawValue: optionsRaw).contains(.shouldResume) {
            play()
        }
    }

    // MARK: Play events (WEAR-6)

    /// Closes the current session into a queued PlayEvent.
    private func finishSession() {
        defer {
            session = nil
            lastTick = nil
        }
        guard let session, let loaded, let startedAt = session.startedAt,
              session.playedSec >= Self.minimumEventSeconds,
              loaded.tracks.indices.contains(session.trackIndex) else { return }
        let event = PlayEvent(
            slug: loaded.release.slug,
            trackId: loaded.tracks[session.trackIndex].id,
            lendId: loaded.lendId,
            startedAt: startedAt,
            playedSec: (session.playedSec * 10).rounded() / 10
        )
        Task {
            await playQueue.enqueue(event)
            await playQueue.flush()
        }
    }

    private func recordCartridge(_ kind: CartridgeEventKind, slug: String) {
        let key = UUID().uuidString.lowercased()
        Task { try? await api.recordCartridgeEvent(slug: slug, kind: kind, idempotencyKey: key) }
    }

    // MARK: Audio session (AUD-7)

    private func configureAudioSession() {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .default, policy: .longFormAudio)
    }

    private func activateSession() {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    // MARK: Now playing (RACK-5)

    private func configureRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.play() }
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.pause() }
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.togglePlayPause() }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.next() }
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.previous() }
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard let event = event as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            MainActor.assumeIsolated { self?.seek(to: event.positionTime) }
            return .success
        }
    }

    private func updateNowPlaying() {
        guard let loaded, let track = currentTrack else { return }
        var info: [String: Any] = [
            MPMediaItemPropertyTitle: track.title,
            MPMediaItemPropertyAlbumTitle: loaded.release.title,
            MPMediaItemPropertyAlbumTrackNumber: track.position,
            MPMediaItemPropertyAlbumTrackCount: loaded.tracks.count,
            MPMediaItemPropertyPlaybackDuration: duration,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: elapsed,
            MPNowPlayingInfoPropertyPlaybackRate: isPlaying ? 1.0 : 0.0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let artist = loaded.release.artist { info[MPMediaItemPropertyArtist] = artist }
        if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    /// Release art for the lock screen: the bundled sleeve for LIT; others get it once covers ship.
    private static func artwork(for release: LibraryRelease) -> MPMediaItemArtwork? {
        guard let image = ReleaseArt.image(for: release.slug) else { return nil }
        return MPMediaItemArtwork(boundsSize: image.size) { _ in image }
    }
}

/// Bundled release art by slug (DS-34 backdrop and sleeve). Remote covers come later with bundles.
enum ReleaseArt {
    static func imageName(for slug: String) -> String? {
        slug == "lit" ? "LITCover" : nil
    }

    static func image(for slug: String) -> UIImage? {
        imageName(for: slug).flatMap { UIImage(named: $0) }
    }
}

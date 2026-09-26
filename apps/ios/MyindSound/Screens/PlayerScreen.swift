import SwiftUI

/// The full player (DS-26: full screen with its own chrome, no tab bar), native until the stage bundle
/// lands (RACK-4). Laid out like the stream page on a phone (docs/app-v1/bar/03, bar/07): the chevron pill
/// to close, the status strip (STATUS · TIME · TRK · RPM), the disc, the LCD, the transport keys, and the
/// tracklist panel with REPEAT. Everything reads the AudioEngine live.
struct PlayerScreen: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var audio: AudioEngine { app.audio }

    var body: some View {
        ZStack {
            HUDBackdrop(depth: .player)
            ScrollView {
                VStack(spacing: MSSpace.space16) {
                    closePill
                    strip
                    disc
                    LCDView(content: lcd)
                        .frame(width: 236)
                        .overlay(Rectangle().strokeBorder(Color.black.opacity(0.6), lineWidth: 1))
                    scrubber
                    transport
                    if case .failed(let message) = audio.status {
                        Text(message)
                            .font(MSFont.mono(12, weight: .medium))
                            .foregroundStyle(MSColor.destructive)
                            .multilineTextAlignment(.center)
                    }
                    tracklist
                }
                .padding(.horizontal, MSSpace.space16)
                .padding(.bottom, MSSpace.space32)
            }
            .scrollIndicators(.hidden)
        }
        .preferredColorScheme(.dark)
    }

    // MARK: Chrome

    /// hud.css .p3d-open-hint style pill with a chevron: closes the player.
    private var closePill: some View {
        Button { dismiss() } label: {
            HUDChevron()
                .rotation(.degrees(90))
                .frame(width: 10, height: 14)
                .foregroundStyle(MSColor.text)
                .frame(width: 56, height: 26)
                .background(Capsule().fill(MSColor.ink.opacity(0.6)))
                .overlay(Capsule().strokeBorder(MSColor.lineDim, lineWidth: 1))
                .frame(minWidth: MSShape.minTouchTarget, minHeight: MSShape.minTouchTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(HUDPressStyle())
        .accessibilityLabel("Close player")
        .padding(.top, MSSpace.space4)
    }

    /// hud.css .p3d-strip (phones): mono 11 muted between `lineDim` hairlines, the status word gold 700.
    private var strip: some View {
        HStack {
            Text(statusWord).foregroundStyle(MSColor.gold).fontWeight(.bold)
            Spacer()
            Text(Track.clock(audio.elapsed))
            Spacer()
            Text("TRK \(String(format: "%02d", audio.index + 1))/\(String(format: "%02d", audio.loaded?.tracks.count ?? 0))")
            Spacer()
            Text("\(audio.isPlaying ? "300" : "000") RPM")
        }
        .font(MSFont.mono(11, weight: .semibold))
        .monospacedDigit()
        .foregroundStyle(MSColor.muted)
        .padding(.horizontal, 4)
        .frame(height: 40)
        .overlay(alignment: .top) { Rectangle().fill(MSColor.lineDim).frame(height: 1) }
        .overlay(alignment: .bottom) { Rectangle().fill(MSColor.lineDim).frame(height: 1) }
        .accessibilityElement(children: .combine)
    }

    /// The deck's status words (DS-5, lcd-text.ts STATUS_LINE).
    private var statusWord: String {
        switch audio.status {
        case .idle: return "NO DISC"
        case .loading: return "READING"
        case .playing: return "PLAY"
        case .paused: return "PAUSE"
        case .stopped: return "STOP"
        case .failed: return "ERROR"
        }
    }

    private var lcd: LCDContent {
        let track = audio.index + 1
        switch audio.status {
        case .idle: return .noDisc
        case .loading: return .reading
        case .playing: return LCDContent(LCDContent.playing(track: track).text, play: true, repeat: audio.repeatOn)
        case .paused: return LCDContent(LCDContent.paused(track: track).text, pause: true, repeat: audio.repeatOn)
        case .stopped: return LCDContent(LCDContent.stopped(track: track).text, stop: true, repeat: audio.repeatOn)
        case .failed: return LCDContent("NO SIGNAL")
        }
    }

    // MARK: Disc

    private var disc: some View {
        ZStack {
            if let slug = audio.loaded?.release.slug {
                ReleaseSleeve(slug: slug, size: 250)
            }
            SpinningDisc(spinning: audio.isPlaying && !reduceMotion)
                .frame(width: 86, height: 86)
                .offset(x: 108, y: 108)
                .shadow(color: .black.opacity(0.5), radius: 8, y: 4)
                .accessibilityHidden(true)
        }
        .frame(height: 290)
        .padding(.top, MSSpace.space8)
    }

    // MARK: Scrubber

    private var scrubber: some View {
        VStack(spacing: 6) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    MSColor.miniPlayerBarBg
                    MSColor.gold
                        .frame(width: proxy.size.width * audio.progress)
                        .hudGlow(HUDGlow.miniPlayerBar)
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onEnded { value in
                    guard audio.duration > 0 else { return }
                    audio.seek(to: max(0, min(1, value.location.x / proxy.size.width)) * audio.duration)
                })
            }
            .frame(height: MSComponent.NowPlaying.barHeight)
            .padding(.vertical, 10)
            HStack {
                Text(Track.clock(audio.elapsed))
                Spacer()
                Text(Track.clock(audio.duration))
            }
            .font(HUDType.trackNumber)
            .monospacedDigit()
            .foregroundStyle(MSColor.muted)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Position")
        .accessibilityValue("\(Track.clock(audio.elapsed)) of \(Track.clock(audio.duration))")
        .accessibilityAdjustableAction { direction in
            let step: Double = direction == .increment ? 10 : -10
            audio.seek(to: max(0, min(audio.duration, audio.elapsed + step)))
        }
    }

    // MARK: Transport (DS-15 keys; PLAY latches while playing)

    private var transport: some View {
        HStack(spacing: 6) {
            iconKey(.prev, label: "Previous track") { audio.previous() }
            iconKey(audio.isPlaying ? .pause : .play, label: audio.isPlaying ? "Pause" : "Play", latched: audio.isPlaying) {
                audio.togglePlayPause()
            }
            iconKey(.next, label: "Next track") { audio.next() }
            KeyButton("Eject", fullWidth: true) {
                audio.eject()
                dismiss()
            }
        }
    }

    private func iconKey(_ icon: HUDIcon, label: String, latched: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HUDIconView(icon: icon, size: 18)
                .foregroundStyle(latched ? MSColor.ink : MSColor.text)
                .frame(maxWidth: .infinity)
                .frame(minHeight: MSComponent.KeyButton.minHeight)
                .background(latched ? MSColor.gold : MSColor.base)
                .overlay(Rectangle().strokeBorder(latched ? MSColor.gold : MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
                .contentShape(Rectangle())
        }
        .buttonStyle(HUDPressStyle())
        .hudFocusRing()
        .accessibilityLabel(label)
        .accessibilityAddTraits(latched ? [.isButton, .isSelected] : .isButton)
    }

    // MARK: Tracklist

    @ViewBuilder
    private var tracklist: some View {
        if let loaded = audio.loaded {
            HUDPanel("\(loaded.release.title) · Tracklist", meta: "\(String(format: "%02d", loaded.tracks.count)) TRK") {
                VStack(spacing: 0) {
                    ForEach(Array(loaded.tracks.enumerated()), id: \.element.id) { index, track in
                        TrackRow(
                            number: track.position,
                            title: track.title,
                            duration: track.durationText,
                            isCurrent: audio.index == index,
                            isPlaying: audio.index == index && audio.isPlaying
                        ) {
                            audio.select(trackAt: index)
                        }
                    }
                    RepeatKey(on: audio.repeatOn) { audio.repeatOn.toggle() }
                        .padding(.top, MSSpace.space10)
                }
            }
        }
    }
}

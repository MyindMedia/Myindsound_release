import SwiftUI

/// DS-25 now playing bar (theme.css .mini-player on the phone breakpoint, docked above the tab bar by
/// ios.css): 42 pt art box with the MiniDisc shell and a spinning disc (3.4 s linear), Inter 12 semibold
/// title, mono 10 meta row (gold tag + muted time), 4 pt progress bar with gold glow, prev / play / next
/// keys (40 pt, the play key bordered), optional close. `panel` fill over a 12 px blur, `lineDim`
/// hairline, 4 pt radius, `--float` shadow, 12 pt 1 pt `--line` tick top-left. Tap the bar to return to
/// the player.
struct NowPlayingBar: View {
    var title: String
    var tag: String
    var elapsed: String
    var duration: String
    var progress: Double
    var isPlaying: Bool
    var onOpen: () -> Void = {}
    var onPrev: () -> Void = {}
    var onPlayPause: () -> Void = {}
    var onNext: () -> Void = {}
    var onClose: (() -> Void)? = nil
    /// A generated disc's cover, printed on the disc (nil: LIT's disc art).
    var discArt: URL? = nil

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: HUDSurface.nowPlayingGap) {
            Button(action: onOpen) {
                HStack(spacing: HUDSurface.nowPlayingGap) {
                    art
                    info
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Now playing, \(title)")
            .accessibilityValue("\(tag), \(elapsed) of \(duration)")
            .accessibilityHint("Opens the player")

            keys
        }
        .padding(.vertical, HUDSurface.nowPlayingPaddingV)
        .padding(.horizontal, HUDSurface.nowPlayingPaddingH)
        .background {
            ZStack {
                Rectangle().fill(.ultraThinMaterial)
                MSColor.panel
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: HUDSurface.nowPlayingRadius, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: HUDSurface.nowPlayingRadius, style: .continuous)
                .strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth)
        )
        .hudCornerTicks(
            corners: [.topLeading],
            size: MSComponent.NowPlaying.cornerTickSize,
            stroke: MSComponent.NowPlaying.cornerTickStroke,
            color: MSComponent.NowPlaying.cornerTickColor
        )
        .hudGlow(HUDGlow.float)
    }

    private var art: some View {
        ZStack {
            MSColor.panelSolid
            Image("MiniDiscShell")
                .resizable()
                .scaledToFit()
            SpinningDisc(spinning: isPlaying && !reduceMotion, art: discArt)
                .frame(
                    width: MSComponent.NowPlaying.artSizePhone * HUDSurface.nowPlayingDiscScale,
                    height: MSComponent.NowPlaying.artSizePhone * HUDSurface.nowPlayingDiscScale
                )
        }
        .frame(width: MSComponent.NowPlaying.artSizePhone, height: MSComponent.NowPlaying.artSizePhone)
        .clipped()
        .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
        .accessibilityHidden(true)
    }

    private var info: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title)
                .font(HUDType.nowPlayingTitle)
                .tracking(HUDType.nowPlayingTitleTracking)
                .foregroundStyle(MSColor.text)
                .lineLimit(1)
                .truncationMode(.tail)
            HStack(spacing: MSSpace.space8) {
                Text(tag.uppercased()).foregroundStyle(MSColor.gold)
                Text("\(elapsed) / \(duration)").foregroundStyle(MSColor.muted)
            }
            .font(HUDType.nowPlayingMeta)
            .tracking(HUDType.nowPlayingMetaTracking)
            .monospacedDigit()
            .lineLimit(1)
            .padding(.top, 2)
            .padding(.bottom, 5)
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    MSColor.miniPlayerBarBg
                    MSColor.gold
                        .frame(width: proxy.size.width * max(0, min(1, progress)))
                        .hudGlow(HUDGlow.miniPlayerBar)
                }
            }
            .frame(height: MSComponent.NowPlaying.barHeight)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var keys: some View {
        HStack(spacing: 2) {
            transportKey(.prev, label: "Previous track", action: onPrev)
            transportKey(isPlaying ? .pause : .play, label: isPlaying ? "Pause" : "Play", action: onPlayPause, bordered: true)
            transportKey(.next, label: "Next track", action: onNext)
            if let onClose {
                Button(action: onClose) {
                    HUDIconView(icon: .close, size: 18)
                        .foregroundStyle(MSColor.muted)
                        .frame(width: 26, height: MSComponent.NowPlaying.keySizePhone)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close player")
            }
        }
    }

    private func transportKey(_ icon: HUDIcon, label: String, action: @escaping () -> Void, bordered: Bool = false) -> some View {
        Button(action: action) {
            HUDIconView(icon: icon, size: 18)
                .foregroundStyle(bordered ? MSColor.text : MSColor.muted)
                .frame(width: MSComponent.NowPlaying.keySizePhone, height: MSComponent.NowPlaying.keySizePhone)
                .overlay {
                    if bordered {
                        Rectangle().strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth)
                    }
                }
                .contentShape(Rectangle())
        }
        .buttonStyle(NowPlayingKeyStyle())
        .accessibilityLabel(label)
    }
}

/// theme.css .mini-player__key:hover: gold at 10 % behind a gold glyph while pressed.
private struct NowPlayingKeyStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? MSColor.gold.opacity(0.1) : .clear)
            .foregroundStyle(configuration.isPressed ? MSColor.gold : .primary)
    }
}

/// theme.css .mini-player__disc + @keyframes mini-player-spin: one turn every 3.4 s while playing.
struct SpinningDisc: View {
    var spinning: Bool
    /// A generated disc's printed art (its cover), else LIT's disc.
    var art: URL? = nil
    @State private var angle: Angle = .zero

    var body: some View {
        disc
            .rotationEffect(angle)
            .onAppear { update() }
            .onChange(of: spinning) { _, _ in update() }
    }

    @ViewBuilder
    private var disc: some View {
        if let art {
            // The printed disc: the cover on a circle, a clear rim, the metal hub.
            GeometryReader { proxy in
                let d = min(proxy.size.width, proxy.size.height)
                ZStack {
                    CoverArtImage(url: art).frame(width: d, height: d).clipShape(Circle())
                    Circle().strokeBorder(Color.white.opacity(0.25), lineWidth: max(1, d * 0.03))
                    Circle().fill(Color(white: 0.72)).frame(width: d * 0.3, height: d * 0.3)
                    Circle().fill(MSColor.ink).frame(width: d * 0.12, height: d * 0.12)
                }
                .frame(width: d, height: d)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .aspectRatio(1, contentMode: .fit)
        } else {
            Image("MiniDiscArt")
                .resizable()
                .scaledToFit()
        }
    }

    private func update() {
        if spinning {
            withAnimation(MSMotion.discSpin) { angle = .degrees(360) }
        } else {
            withAnimation(.linear(duration: 0)) { angle = .zero }
        }
    }
}

#Preview("NowPlayingBar") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        NowPlayingBar(title: "01 · L.I.T. (Living In Truth)", tag: "Preview", elapsed: "0:01", duration: "0:30", progress: 0.05, isPlaying: true, onClose: {})
            .padding(.horizontal, 8)
    }
}

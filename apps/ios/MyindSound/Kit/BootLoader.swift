import SwiftUI

/// DS-23 boot loader (hud.css .p3d-boot, the uplink style): ink screen, mono 12 tracking 0.24em, a 3 pt
/// gold progress bar with glow in a 15 % gold track (`min(280px, 70vw)` wide), the percent in `muted`, and
/// the terminal printout above (hud-fx.ts BootTerminal: 11 pt mono, gold 0.9, `> ` prompt in ice, blinking
/// 8x13 caret). Fades out over 0.6 s (DS-29).
struct BootLoader: View {
    /// 0...1
    var progress: Double
    var lines: [String] = []
    var caret = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            MSColor.ink.ignoresSafeArea()
            VStack(spacing: HUDSurface.bootGap) {
                if !lines.isEmpty {
                    terminal
                }
                track
                Text("\(Int((progress * 100).rounded()))%")
                    .font(HUDType.bootPercent)
                    .tracking(HUDType.bootPercentTracking)
                    .monospacedDigit()
                    .foregroundStyle(MSColor.muted)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading")
        .accessibilityValue("\(Int((progress * 100).rounded())) percent")
    }

    private var track: some View {
        GeometryReader { proxy in
            ZStack(alignment: .leading) {
                MSColor.gold.opacity(HUDSurface.bootTrackAlpha)
                MSColor.gold
                    .frame(width: proxy.size.width * max(0, min(1, progress)))
                    .hudGlow(HUDGlow.bootBar)
                    .animation(reduceMotion ? nil : .easeOut(duration: MSComponent.BootLoader.barTransitionDuration), value: progress)
            }
        }
        .frame(height: MSComponent.BootLoader.trackHeight)
        .containerRelativeFrame(.horizontal) { width, _ in
            min(HUDSurface.bootTrackMaxWidth, width * HUDSurface.bootTrackWidthFraction)
        }
    }

    private var terminal: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.offset) { index, line in
                HStack(alignment: .firstTextBaseline, spacing: 0) {
                    Text(MSComponent.BootLoader.terminalPrefix)
                        .foregroundStyle(HUDSurface.terminalPrefix)
                    Text(line)
                        .foregroundStyle(MSColor.gold.opacity(HUDSurface.terminalAlpha))
                    if caret && index == lines.count - 1 {
                        TerminalCaret()
                            .padding(.leading, 4)
                            .alignmentGuide(.firstTextBaseline) { d in d[.bottom] - 1 }
                    }
                }
                .font(HUDType.terminal)
                .tracking(HUDType.terminalTracking)
                .frame(minHeight: MSComponent.BootLoader.terminalTextSize * HUDSurface.terminalLineHeight)
            }
        }
        .frame(minHeight: MSComponent.BootLoader.terminalMinHeight, alignment: .topLeading)
        .containerRelativeFrame(.horizontal, alignment: .leading) { width, _ in
            min(HUDSurface.bootTerminalMaxWidth, width * HUDSurface.bootTerminalWidthFraction)
        }
    }
}

/// hud.css .p3d-terminal__caret: 8x13 gold block, `p3d-blink 1s steps(2)`.
struct TerminalCaret: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Group {
            if reduceMotion {
                MSColor.gold
            } else {
                TimelineView(.periodic(from: .now, by: 0.5)) { timeline in
                    let on = Int(timeline.date.timeIntervalSinceReferenceDate * 2) % 2 == 0
                    MSColor.gold.opacity(on ? 1 : 0.2)
                }
            }
        }
        .frame(width: MSComponent.BootLoader.caretWidth, height: MSComponent.BootLoader.caretHeight)
        .accessibilityHidden(true)
    }
}

extension BootLoader {
    /// hud.ts's boot script, for previews and the gallery.
    static let sampleLines = [
        "MD-01 FIRMWARE v2.6 · MYIND SOUND",
        "UPLINK ............... OK",
        "DECK TEXTURES ........ LOADED",
        "LASER DIODE .......... ARMED",
        "CITY GRID ............ ONLINE",
    ]
}

#Preview("BootLoader") {
    BootLoader(progress: 0.62, lines: Array(BootLoader.sampleLines.prefix(3)))
}

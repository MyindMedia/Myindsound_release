import SwiftUI

/// DS-24 chromatic glitch (hud.css .p3d-glitch, a re-implementation of the React Bits 404-6 effect, not a
/// copy): when `trigger` changes, cyan and pink copies of the text flash offset and clipped for 0.52 s in
/// steps while the text itself jitters 1 px. Nothing moves under Reduce Motion; the text just changes.
struct GlitchText<Content: View>: View {
    var trigger: AnyHashable
    @ViewBuilder var content: () -> Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var phase = 0
    @State private var task: Task<Void, Never>?

    private static var frames: [(cyan: (dx: CGFloat, top: CGFloat, bottom: CGFloat), pink: (dx: CGFloat, top: CGFloat, bottom: CGFloat), jitter: CGFloat, alpha: Double)] {
        [
            ((-5, 0.10, 0.66), (5, 0.30, 0.46), 0, 1),
            ((3, 0.56, 0.20), (-3, 0.76, 0.04), 1, 0.7),
            ((-2, 0.30, 0.46), (2, 0.10, 0.66), -1, 1),
        ]
    }

    var body: some View {
        ZStack {
            if !reduceMotion, phase > 0, phase <= Self.frames.count {
                let frame = Self.frames[phase - 1]
                content()
                    .foregroundStyle(MSColor.glitchCyan)
                    .offset(x: frame.cyan.dx)
                    .mask(band(top: frame.cyan.top, bottom: frame.cyan.bottom))
                content()
                    .foregroundStyle(MSColor.glitchPink)
                    .offset(x: frame.pink.dx)
                    .mask(band(top: frame.pink.top, bottom: frame.pink.bottom))
                content()
                    .offset(x: frame.jitter)
                    .opacity(frame.alpha)
            } else {
                content()
            }
        }
        .onChange(of: trigger) { _, _ in run() }
        .accessibilityElement(children: .combine)
    }

    /// `clip-path: inset(top 0 bottom 0)` as a mask.
    private func band(top: CGFloat, bottom: CGFloat) -> some View {
        GeometryReader { proxy in
            Rectangle()
                .frame(height: proxy.size.height * (1 - top - bottom))
                .offset(y: proxy.size.height * top)
        }
    }

    private func run() {
        guard !reduceMotion else { return }
        task?.cancel()
        task = Task { @MainActor in
            let step: UInt64 = 520_000_000 / UInt64(Self.frames.count)
            for i in 1...Self.frames.count {
                phase = i
                try? await Task.sleep(nanoseconds: step)
                if Task.isCancelled { return }
            }
            phase = 0
        }
    }
}

#Preview("GlitchText") {
    struct Host: View {
        @State var count = 0
        var body: some View {
            ZStack {
                MSColor.ink.ignoresSafeArea()
                VStack {
                    GlitchText(trigger: count) {
                        Text("TRK 0\(count)/07").font(MSFont.mono(14, weight: .semibold)).foregroundStyle(MSColor.gold)
                    }
                    KeyButton("Next") { count += 1 }
                }
            }
        }
    }
    return Host()
}

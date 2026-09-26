import SwiftUI

/// DS-14 parallelogram: hud.css .p3d-insert `clip-path: polygon(10px 0, 100% 0, 100%-10px 100%, 0 100%)`.
struct ParallelogramShape: Shape {
    var slant: CGFloat = MSShape.primaryButtonSlant

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + slant, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - slant, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

/// DS-14 primary button: gold fill, ink text, JetBrains Mono bold 15 tracking 0.22em (hud.ts gives
/// `.p3d-insert` the `p3d-mono` class), 48 pt minimum, 10 pt slant, and a slow gold glow pulse (1.8 s round
/// trip) for the one main call to action on a screen. One pulsing button per screen at most.
struct PrimaryButton: View {
    let title: String
    var pulsing = true
    var fullWidth = false
    let action: () -> Void

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var glowing = false

    init(_ title: String, pulsing: Bool = true, fullWidth: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.pulsing = pulsing
        self.fullWidth = fullWidth
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title.uppercased())
                .font(HUDType.primaryButton)
                .tracking(HUDType.primaryButtonTracking)
                .foregroundStyle(MSColor.ink)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, HUDSurface.primaryButtonPaddingH)
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .frame(minHeight: MSComponent.PrimaryButton.minHeight)
                .background(MSColor.gold)
                .clipShape(ParallelogramShape())
                .contentShape(ParallelogramShape())
        }
        .buttonStyle(HUDPressStyle())
        .shadow(color: HUDGlow.primaryPulse.color.opacity(glowing ? 1 : 0), radius: HUDGlow.primaryPulse.hudRadius)
        .onAppear { startPulse() }
        .onChange(of: reduceMotion) { _, _ in startPulse() }
        .accessibilityLabel(title)
        .accessibilityAddTraits(.isButton)
    }

    /// DS-30: no pulse under Reduce Motion; the button simply sits lit.
    private func startPulse() {
        guard pulsing, !reduceMotion else {
            glowing = false
            return
        }
        glowing = false
        withAnimation(HUDMotion.pulse) { glowing = true }
    }
}

#Preview("PrimaryButton") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        PrimaryButton("Insert Disc") {}
    }
}

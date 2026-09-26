import SwiftUI

/// DS-15 secondary button (the deck's keys): `base` fill, 1 pt `lineDim` border, JetBrains Mono 12 semibold
/// tracking 0.08em, 44 pt minimum (hud.css .p3d-key). Latched (`aria-pressed`): gold fill, ink text.
struct KeyButton: View {
    let title: String
    var latched = false
    var fullWidth = false
    let action: () -> Void

    init(_ title: String, latched: Bool = false, fullWidth: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.latched = latched
        self.fullWidth = fullWidth
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title.uppercased())
                .font(MSFont.Style.keyButton)
                .tracking(MSFont.Tracking.keyButton)
                .monospacedDigit()
                .foregroundStyle(latched ? MSColor.ink : MSColor.text)
                .lineLimit(1)
                .padding(.horizontal, HUDSurface.keyButtonPaddingH)
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .frame(minHeight: MSComponent.KeyButton.minHeight)
                .background(latched ? MSColor.gold : MSColor.base)
                .overlay(Rectangle().strokeBorder(latched ? MSColor.gold : MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
                .contentShape(Rectangle())
        }
        .buttonStyle(HUDPressStyle())
        .hudFocusRing()
        .accessibilityLabel(title)
        .accessibilityAddTraits(latched ? [.isButton, .isSelected] : [.isButton])
        .accessibilityValue(latched ? "on" : "off")
    }
}

/// hud.css .p3d-repeat: the toggle that moved into the tracklist. Transparent with a `lineDim` border and
/// muted mono 12 bold tracking 0.16em; latched it fills gold like a key.
struct RepeatKey: View {
    var on: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: MSSpace.space10) {
                Image(systemName: "repeat")
                    .font(.system(size: 14, weight: .bold))
                Text(on ? "REPEAT ON" : "REPEAT OFF")
                    .font(HUDType.repeatButton)
                    .tracking(HUDType.repeatButtonTracking)
            }
            .foregroundStyle(on ? MSColor.ink : MSColor.muted)
            .padding(.horizontal, HUDSurface.keyButtonPaddingH)
            .frame(maxWidth: .infinity, alignment: .leading)
            .frame(minHeight: MSComponent.KeyButton.minHeight)
            .background(on ? MSColor.gold : Color.clear)
            .overlay(Rectangle().strokeBorder(on ? MSColor.gold : MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
            .contentShape(Rectangle())
        }
        .buttonStyle(HUDPressStyle())
        .hudFocusRing()
        .accessibilityLabel("Repeat")
        .accessibilityValue(on ? "on" : "off")
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : [.isButton])
    }
}

#Preview("KeyButton") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        HStack {
            KeyButton("Play", latched: true) {}
            KeyButton("Pause") {}
            KeyButton("Stop") {}
        }
    }
}

import SwiftUI

/// hud.css .p3d-readout `border-bottom: 1px dashed rgba(253,185,19,0.12)`.
struct DashedDivider: View {
    var color: Color = MSColor.gold.opacity(HUDSurface.readoutDividerAlpha)

    var body: some View {
        Path { path in
            path.move(to: .zero)
            path.addLine(to: CGPoint(x: 4000, y: 0))
        }
        .stroke(color, style: StrokeStyle(lineWidth: MSComponent.ReadoutRow.dividerWidth, dash: HUDSurface.readoutDividerDash))
        .frame(height: MSComponent.ReadoutRow.dividerWidth)
        .clipped()
        .accessibilityHidden(true)
    }
}

/// DS-17 readout row (hud.css .p3d-readout): mono label left (muted), value right (mono 14, gold with glow;
/// orange when "on"), 30 pt minimum, dashed `lineDim` divider at 12 %. Pass any view as the value
/// (an `LCDView` for edition numbers), or a string.
struct ReadoutRow<Value: View>: View {
    let label: String
    @ViewBuilder var value: () -> Value

    init(_ label: String, @ViewBuilder value: @escaping () -> Value) {
        self.label = label
        self.value = value
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: MSComponent.ReadoutRow.gap) {
                HUDLabel(label)
                Spacer(minLength: MSComponent.ReadoutRow.gap)
                value()
            }
            .frame(minHeight: MSComponent.ReadoutRow.minHeight - MSComponent.ReadoutRow.dividerWidth)
            DashedDivider()
        }
        .accessibilityElement(children: .combine)
    }
}

extension ReadoutRow where Value == ReadoutValue {
    init(_ label: String, value: String, on: Bool = false) {
        self.init(label) { ReadoutValue(value, on: on) }
    }
}

/// The plain readout value: mono 14, gold with the 10 px glow, orange when "on" (REPEAT ON).
struct ReadoutValue: View {
    let text: String
    var on = false

    init(_ text: String, on: Bool = false) {
        self.text = text
        self.on = on
    }

    var body: some View {
        Text(text)
            .font(HUDType.readoutValue)
            .tracking(HUDType.readoutValueTracking)
            .monospacedDigit()
            .foregroundStyle(on ? MSColor.orange : MSColor.gold)
            .hudGlow(HUDGlow.readout)
            .lineLimit(1)
    }
}

#Preview("ReadoutRow") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        VStack(spacing: 0) {
            ReadoutRow("Time", value: "0:00")
            ReadoutRow("Repeat", value: "ON", on: true)
        }
        .padding()
    }
}

import SwiftUI

/// hud.css .p3d-track__eq + @keyframes p3d-eq: three 3 px gold bars in a 14x12 box, stepping through three
/// keyframes at 0.9 s `steps(6)` alternating. Static at the resting heights under Reduce Motion.
struct EQBars: View {
    var animating = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var duration: Double { HUDSurface.eqDuration }
    private var steps: Int { HUDSurface.eqSteps }

    var body: some View {
        Group {
            if animating && !reduceMotion {
                TimelineView(.periodic(from: .now, by: duration / Double(steps))) { timeline in
                    bars(heights: heights(at: timeline.date.timeIntervalSinceReferenceDate))
                }
            } else {
                bars(heights: HUDSurface.eqRestHeights)
            }
        }
        .frame(width: HUDSurface.eqBoxWidth, height: HUDSurface.eqBoxHeight)
        .accessibilityHidden(true)
    }

    private func bars(heights: [CGFloat]) -> some View {
        Canvas { context, size in
            let w = HUDSurface.eqBarWidth
            for (index, h) in heights.enumerated() {
                let x = HUDSurface.eqBarOffsets[index]
                let height = size.height * h
                context.fill(Path(CGRect(x: x, y: size.height - height, width: w, height: height)), with: .color(MSColor.gold))
            }
        }
    }

    /// Where the CSS animation would be: `alternate` over 0.9 s, quantised into 6 steps, interpolated between
    /// the 0 / 50 / 100 percent keyframes.
    private func heights(at time: TimeInterval) -> [CGFloat] {
        let cycle = time.truncatingRemainder(dividingBy: duration * 2)
        let forward = cycle < duration
        let raw = forward ? cycle / duration : 2 - cycle / duration
        let stepped = (Double(Int(raw * Double(steps))) / Double(steps)).clamped(to: 0...1)
        let frames = HUDSurface.eqKeyframes
        let segment = stepped < 0.5 ? (frames[0], frames[1], stepped * 2) : (frames[1], frames[2], (stepped - 0.5) * 2)
        return (0..<3).map { i in
            segment.0[i] + (segment.1[i] - segment.0[i]) * CGFloat(segment.2)
        }
    }
}

private extension Comparable {
    func clamped(to range: ClosedRange<Self>) -> Self { min(max(self, range.lowerBound), range.upperBound) }
}

/// DS-16 list row (hud.css .p3d-track): `28px 1fr auto auto` grid, 44 pt minimum, mono muted number and
/// duration, Inter 500 14 title, 8 pt corners (the live row, docs/app-v1/bar/07). Current row: 2 pt gold
/// leading edge that follows the corners (a CSS `border-left` on a rounded box), gold gradient 16 % to
/// clear at 80 %, gold title with glow, gold number. The EQ bars show only while playing, as the live CSS
/// does (`opacity: 0` otherwise), so a paused deck shows a plain row.
struct TrackRow: View {
    let number: Int
    let title: String
    let duration: String
    var isCurrent = false
    var isPlaying = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: HUDSurface.trackRowGap) {
                Text(String(format: "%02d", number))
                    .font(HUDType.trackNumber)
                    .tracking(HUDType.trackNumberTracking)
                    .monospacedDigit()
                    .foregroundStyle(isCurrent ? MSColor.gold : MSColor.muted)
                    .frame(width: HUDSurface.trackNumberWidth, alignment: .leading)
                Text(title)
                    .font(HUDType.trackTitle)
                    .foregroundStyle(isCurrent ? MSColor.gold : MSColor.text)
                    .hudGlow(isCurrent ? HUDGlow.trackTitle : HUDGlow.none)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if isCurrent && isPlaying {
                    EQBars()
                }
                Text(duration)
                    .font(HUDType.trackNumber)
                    .tracking(HUDType.trackNumberTracking)
                    .monospacedDigit()
                    .foregroundStyle(MSColor.muted)
            }
            .padding(.vertical, HUDSurface.trackRowPaddingV)
            .padding(.horizontal, HUDSurface.trackRowPaddingH)
            .frame(minHeight: MSComponent.ListRow.minHeight)
            .background {
                if isCurrent {
                    RoundedRectangle(cornerRadius: HUDSurface.trackRowRadius, style: .circular)
                        .fill(HUDSurface.currentRowGradient)
                }
            }
            .overlay {
                if isCurrent {
                    LeadingBorderShape(radius: HUDSurface.trackRowRadius, width: MSComponent.ListRow.currentLeadingBorderWidth)
                        .fill(MSColor.gold, style: FillStyle(eoFill: true))
                    // Only the leading curve: the trailing edges of the two shapes cancel exactly in theory,
                    // but antialiasing leaves hairline specks there.
                    .mask(alignment: .leading) {
                        Rectangle().frame(width: HUDSurface.trackRowRadius + MSComponent.ListRow.currentLeadingBorderWidth)
                    }
                }
            }
            .contentShape(RoundedRectangle(cornerRadius: HUDSurface.trackRowRadius))
        }
        .buttonStyle(TrackRowPressStyle())
        .hudFocusRing(offset: MSComponent.ListRow.focusRingOffset)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Track \(number), \(title), \(duration)")
        .accessibilityValue(isCurrent ? (isPlaying ? "now playing" : "current") : "")
        .accessibilityAddTraits(isCurrent ? [.isButton, .isSelected] : [.isButton])
    }
}

/// hud.css .p3d-track:hover: a 7 % gold wash while pressed (in the row's 8 pt corners); no scale.
private struct TrackRowPressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(
                RoundedRectangle(cornerRadius: HUDSurface.trackRowRadius)
                    .fill(configuration.isPressed ? MSColor.gold.opacity(HUDSurface.rowPressedAlpha) : .clear)
            )
    }
}

/// A CSS `border-left` on a box with rounded corners: the band between the box and the same box pulled in
/// by `width` on the leading side, so it curves into both corners and thins out along them.
struct LeadingBorderShape: Shape {
    var radius: CGFloat
    var width: CGFloat

    func path(in rect: CGRect) -> Path {
        var path = Path(roundedRect: rect, cornerSize: CGSize(width: radius, height: radius), style: .circular)
        let inner = CGRect(x: rect.minX + width, y: rect.minY, width: rect.width - width, height: rect.height)
        let innerRadius = max(0, radius - width)
        path.addPath(UnevenRoundedRectangle(
            topLeadingRadius: innerRadius,
            bottomLeadingRadius: innerRadius,
            bottomTrailingRadius: radius,
            topTrailingRadius: radius,
            style: .circular
        ).path(in: inner))
        return path
    }
}

#Preview("TrackRow") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        VStack(spacing: 0) {
            TrackRow(number: 1, title: "L.I.T. (Living In Truth)", duration: "3:12", isCurrent: true, isPlaying: true) {}
            TrackRow(number: 2, title: "G. O. D.", duration: "2:58") {}
        }
        .padding()
    }
}

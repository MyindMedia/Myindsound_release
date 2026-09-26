import SwiftUI

/// The site's own line icons, as SwiftUI paths. Tab icons are src/ios.ts `ICONS` (24-unit viewBox, 1.7
/// stroke, round caps and joins); transport keys are src/mini-player.ts `ICONS` (20-unit viewBox, filled).
enum HUDIcon: Hashable {
    case listen, store, library
    case prev, next, play, pause, close

    /// The design box the path is drawn in.
    var viewBox: CGFloat {
        switch self {
        case .listen, .store, .library: return 24
        case .prev, .next, .play, .pause, .close: return 20
        }
    }

    var isStroked: Bool {
        switch self {
        case .listen, .store, .library, .close: return true
        default: return false
        }
    }

    var strokeWidth: CGFloat {
        switch self {
        case .close: return 1.6
        default: return 1.7
        }
    }

    /// Path in viewBox units.
    func path() -> Path {
        var p = Path()
        switch self {
        case .listen:
            // <path d="M12 3v11.5"/>
            p.move(to: CGPoint(x: 12, y: 3))
            p.addLine(to: CGPoint(x: 12, y: 14.5))
            // <circle cx="9" cy="16.5" r="3.2"/>
            p.addEllipse(in: CGRect(x: 9 - 3.2, y: 16.5 - 3.2, width: 6.4, height: 6.4))
            // <path d="M12 5.5l5.5-1.7v3.4L12 8.9"/>
            p.move(to: CGPoint(x: 12, y: 5.5))
            p.addLine(to: CGPoint(x: 17.5, y: 3.8))
            p.addLine(to: CGPoint(x: 17.5, y: 7.2))
            p.addLine(to: CGPoint(x: 12, y: 8.9))
        case .store:
            // <path d="M5 8h14l-1 11.5a1.6 1.6 0 0 1-1.6 1.5H7.6A1.6 1.6 0 0 1 6 19.5L5 8Z"/>
            p.move(to: CGPoint(x: 5, y: 8))
            p.addLine(to: CGPoint(x: 19, y: 8))
            p.addArc(tangent1End: CGPoint(x: 17.87, y: 21), tangent2End: CGPoint(x: 6.13, y: 21), radius: 1.6)
            p.addArc(tangent1End: CGPoint(x: 6.13, y: 21), tangent2End: CGPoint(x: 5, y: 8), radius: 1.6)
            p.closeSubpath()
            // <path d="M9 8V6.5a3 3 0 0 1 6 0V8"/>
            p.move(to: CGPoint(x: 9, y: 8))
            p.addLine(to: CGPoint(x: 9, y: 6.5))
            p.addArc(tangent1End: CGPoint(x: 9, y: 3.5), tangent2End: CGPoint(x: 15, y: 3.5), radius: 3)
            p.addArc(tangent1End: CGPoint(x: 15, y: 3.5), tangent2End: CGPoint(x: 15, y: 8), radius: 3)
            p.addLine(to: CGPoint(x: 15, y: 8))
        case .library:
            // Four rounded rects, rx 1.6.
            for rect in [
                CGRect(x: 3.5, y: 4.5, width: 7, height: 7),
                CGRect(x: 13.5, y: 4.5, width: 7, height: 7),
                CGRect(x: 3.5, y: 14.5, width: 7, height: 5.5),
                CGRect(x: 13.5, y: 14.5, width: 7, height: 5.5),
            ] {
                p.addRoundedRect(in: rect, cornerSize: CGSize(width: 1.6, height: 1.6))
            }
        case .prev:
            // <path d="M14 5 7 10l7 5V5Z"/><rect x="4" y="5" width="2" height="10"/>
            p.move(to: CGPoint(x: 14, y: 5))
            p.addLine(to: CGPoint(x: 7, y: 10))
            p.addLine(to: CGPoint(x: 14, y: 15))
            p.closeSubpath()
            p.addRect(CGRect(x: 4, y: 5, width: 2, height: 10))
        case .next:
            // <path d="M6 5l7 5-7 5V5Z"/><rect x="14" y="5" width="2" height="10"/>
            p.move(to: CGPoint(x: 6, y: 5))
            p.addLine(to: CGPoint(x: 13, y: 10))
            p.addLine(to: CGPoint(x: 6, y: 15))
            p.closeSubpath()
            p.addRect(CGRect(x: 14, y: 5, width: 2, height: 10))
        case .play:
            // <path d="M6 4.5 16 10 6 15.5v-11Z"/>
            p.move(to: CGPoint(x: 6, y: 4.5))
            p.addLine(to: CGPoint(x: 16, y: 10))
            p.addLine(to: CGPoint(x: 6, y: 15.5))
            p.closeSubpath()
        case .pause:
            p.addRect(CGRect(x: 5, y: 4.5, width: 3.5, height: 11))
            p.addRect(CGRect(x: 11.5, y: 4.5, width: 3.5, height: 11))
        case .close:
            // <path d="M5 5l8 8M13 5l-8 8"/>
            p.move(to: CGPoint(x: 5, y: 5))
            p.addLine(to: CGPoint(x: 13, y: 13))
            p.move(to: CGPoint(x: 13, y: 5))
            p.addLine(to: CGPoint(x: 5, y: 13))
        }
        return p
    }
}

/// Renders a `HUDIcon` in `currentColor` at the given point size (default: the tab bar's 22 pt).
struct HUDIconView: View {
    let icon: HUDIcon
    var size: CGFloat = MSComponent.TabBar.iconSize

    var body: some View {
        Canvas { context, canvasSize in
            let scale = canvasSize.width / icon.viewBox
            let path = icon.path().applying(CGAffineTransform(scaleX: scale, y: scale))
            if icon.isStroked {
                context.stroke(
                    path,
                    with: .foreground,
                    style: StrokeStyle(lineWidth: icon.strokeWidth * scale, lineCap: .round, lineJoin: .round)
                )
            } else {
                context.fill(path, with: .foreground)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

#Preview("HUDIcons") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        HStack(spacing: 16) {
            ForEach([HUDIcon.listen, .store, .library, .prev, .play, .pause, .next, .close], id: \.self) { icon in
                HUDIconView(icon: icon).foregroundStyle(MSColor.gold)
            }
        }
    }
}

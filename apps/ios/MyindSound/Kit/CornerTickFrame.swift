import SwiftUI

/// DS-13 / DS-27: the gold corner tick motif. The HUD panel puts a 14 pt, 2 pt tick on the top-left and
/// bottom-right (hud.css .p3d-panel::before/::after); site cards and the now-playing bar use a 14/12 pt,
/// 1 pt tick in `--line` on the top-left only (theme.css .product-card::before, .mini-player::before).
/// Draw it as an overlay: `.overlay(CornerTickFrame())`.
struct CornerTickFrame: Shape {
    enum Corner: Hashable, CaseIterable {
        case topLeading, topTrailing, bottomLeading, bottomTrailing
    }

    var size: CGFloat = MSShape.cornerTickSize
    var stroke: CGFloat = MSShape.cornerTickStroke
    var corners: Set<Corner> = [.topLeading, .bottomTrailing]

    /// The L shapes, centred on the stroke so the outer edge sits on the frame's edge.
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let half = stroke / 2
        let s = size
        if corners.contains(.topLeading) {
            path.move(to: CGPoint(x: rect.minX + half, y: rect.minY + s))
            path.addLine(to: CGPoint(x: rect.minX + half, y: rect.minY + half))
            path.addLine(to: CGPoint(x: rect.minX + s, y: rect.minY + half))
        }
        if corners.contains(.topTrailing) {
            path.move(to: CGPoint(x: rect.maxX - s, y: rect.minY + half))
            path.addLine(to: CGPoint(x: rect.maxX - half, y: rect.minY + half))
            path.addLine(to: CGPoint(x: rect.maxX - half, y: rect.minY + s))
        }
        if corners.contains(.bottomTrailing) {
            path.move(to: CGPoint(x: rect.maxX - half, y: rect.maxY - s))
            path.addLine(to: CGPoint(x: rect.maxX - half, y: rect.maxY - half))
            path.addLine(to: CGPoint(x: rect.maxX - s, y: rect.maxY - half))
        }
        if corners.contains(.bottomLeading) {
            path.move(to: CGPoint(x: rect.minX + s, y: rect.maxY - half))
            path.addLine(to: CGPoint(x: rect.minX + half, y: rect.maxY - half))
            path.addLine(to: CGPoint(x: rect.minX + half, y: rect.maxY - s))
        }
        return path.strokedPath(StrokeStyle(lineWidth: stroke, lineCap: .butt, lineJoin: .miter))
    }
}

/// A framed clip / card / badge (DS-27): hairline `lineDim` border with gold ticks on every corner.
struct CornerTickFramed<Content: View>: View {
    var corners: Set<CornerTickFrame.Corner> = Set(CornerTickFrame.Corner.allCases)
    var tickColor: Color = MSColor.gold
    var borderColor: Color = MSColor.lineDim
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .overlay(Rectangle().strokeBorder(borderColor, lineWidth: MSShape.hairlineWidth))
            .overlay(CornerTickFrame(corners: corners).fill(tickColor))
    }
}

extension View {
    /// Overlay the HUD panel's own two ticks (top-left, bottom-right, 14 pt, 2 pt, gold).
    func hudCornerTicks(
        corners: Set<CornerTickFrame.Corner> = [.topLeading, .bottomTrailing],
        size: CGFloat = MSShape.cornerTickSize,
        stroke: CGFloat = MSShape.cornerTickStroke,
        color: Color = MSColor.gold
    ) -> some View {
        overlay(CornerTickFrame(size: size, stroke: stroke, corners: corners).fill(color).allowsHitTesting(false))
    }
}

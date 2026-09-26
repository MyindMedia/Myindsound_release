import SwiftUI

/// DS-13: the chamfer cut from the panel's top-right and bottom-left corners
/// (hud.css .p3d-panel clip-path: `polygon(0 0, 100%-14px 0, 100% 14px, 100% 100%, 14px 100%, 0 100%-14px)`).
struct ChamferShape: Shape {
    var chamfer: CGFloat = MSShape.chamfer

    func path(in rect: CGRect) -> Path {
        let c = min(chamfer, rect.width / 2, rect.height / 2)
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - c, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY + c))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX + c, y: rect.maxY))
        path.addLine(to: CGPoint(x: rect.minX, y: rect.maxY - c))
        path.closeSubpath()
        return path
    }
}

/// hud.css .p3d-panel background: `repeating-linear-gradient(0deg, rgba(253,185,19,0.035) 0 1px,
/// transparent 1px 3px)` over `--panel`. One gold hairline every 3 pt.
struct HUDScanlines: View {
    var body: some View {
        Canvas(opaque: false, rendersAsynchronously: true) { context, size in
            let period = MSComponent.HUDPanel.scanlinePeriod
            var y: CGFloat = 0
            var lines = Path()
            while y < size.height {
                lines.addRect(CGRect(x: 0, y: y, width: size.width, height: 1))
                y += period
            }
            context.fill(lines, with: .color(MSColor.gold.opacity(MSComponent.HUDPanel.scanlineAlpha)))
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// The panel's surface on its own (fill + scanlines + hairline border + chamfer + ticks), for anything that
/// wants the look without the header (sheets, the gallery).
struct HUDPanelSurface: View {
    var fill: Color = MSColor.panel

    var body: some View {
        ZStack {
            fill
            HUDScanlines()
        }
        // The CSS border is drawn on the box and then clipped by the chamfer, so the diagonal cuts carry no
        // hairline. Stroke at twice the width and let the clip take the outer half.
        .overlay(Rectangle().stroke(MSColor.lineDim, lineWidth: MSShape.hairlineWidth * 2))
        .clipShape(ChamferShape())
        .hudCornerTicks()
    }
}

/// DS-13 HUD panel: `panel` fill with scanlines, 1 pt `lineDim` border, 14 pt chamfers (top-right,
/// bottom-left), 2 pt gold ticks (top-left, bottom-right), and a header row of title + mono meta over a
/// `lineDim` divider. Content padding follows hud.css `14px 16px 16px`; pass `contentInsets: 0` for
/// edge-to-edge rows (grouped lists).
struct HUDPanel<Content: View>: View {
    var title: String?
    var meta: String?
    var opaque = false
    var contentInsets: CGFloat? = nil
    var accessibilityLabel: String? = nil
    @ViewBuilder var content: () -> Content

    init(
        _ title: String? = nil,
        meta: String? = nil,
        opaque: Bool = false,
        contentInsets: CGFloat? = nil,
        accessibilityLabel: String? = nil,
        @ViewBuilder content: @escaping () -> Content
    ) {
        self.title = title
        self.meta = meta
        self.opaque = opaque
        self.contentInsets = contentInsets
        self.accessibilityLabel = accessibilityLabel
        self.content = content
    }

    private var horizontal: CGFloat { contentInsets ?? MSComponent.HUDPanel.paddingHorizontal }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if title != nil || meta != nil {
                header
                    .padding(.horizontal, MSComponent.HUDPanel.paddingHorizontal)
                    .padding(.top, MSComponent.HUDPanel.paddingTop)
                    .padding(.bottom, MSComponent.HUDPanel.headerMarginBottom)
            } else {
                Color.clear.frame(height: contentInsets ?? MSComponent.HUDPanel.paddingTop)
            }
            content()
                .padding(.horizontal, horizontal)
            Color.clear.frame(height: contentInsets ?? MSComponent.HUDPanel.paddingBottom)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(HUDPanelSurface(fill: opaque ? MSColor.panelSheet : MSColor.panel))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityLabel ?? title ?? "")
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: MSSpace.space12) {
            if let title { HUDPanelTitle(title) }
            Spacer(minLength: 0)
            if let meta { HUDPanelMeta(meta) }
        }
        .padding(.bottom, MSComponent.HUDPanel.headerPaddingBottom)
        .overlay(alignment: .bottom) {
            Rectangle().fill(MSColor.lineDim).frame(height: MSShape.hairlineWidth)
        }
    }
}

#Preview("HUDPanel") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        HUDPanel("LIT · Tracklist", meta: "Side A") {
            Text("Body").foregroundStyle(MSColor.text)
        }
        .padding()
    }
}

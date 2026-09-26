import SwiftUI

/// DS-20 tile / card (store products, releases, rack fallback): floats on ink with the site's `--float`
/// shadow (`0 18px 44px rgba(0,0,0,0.55)`), `lineDim` hairline, 14 pt radius on the phone shell
/// (ios.css .product-card), the 1 pt `--line` corner tick of theme.css .product-card::before, press to 0.97
/// and lift on focus (`--float-lift`: deeper shadow + gold ring at 50 %).
struct FloatingTile<Content: View>: View {
    var lifted = false
    let action: () -> Void
    @ViewBuilder var content: () -> Content

    init(lifted: Bool = false, action: @escaping () -> Void, @ViewBuilder content: @escaping () -> Content) {
        self.lifted = lifted
        self.action = action
        self.content = content
    }

    var body: some View {
        Button(action: action) {
            content()
                .frame(maxWidth: .infinity, alignment: .topLeading)
                .background(MSColor.panelSolid)
                .clipShape(RoundedRectangle(cornerRadius: MSShape.iosGroupedRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: MSShape.iosGroupedRadius, style: .continuous)
                        .strokeBorder(lifted ? MSColor.line : MSColor.lineDim, lineWidth: MSShape.hairlineWidth)
                )
                .hudCornerTicks(
                    corners: [.topLeading],
                    size: HUDSurface.siteTickSize,
                    stroke: HUDSurface.siteTickStroke,
                    color: HUDSurface.siteTickColor
                )
                .contentShape(RoundedRectangle(cornerRadius: MSShape.iosGroupedRadius, style: .continuous))
        }
        .buttonStyle(HUDPressStyle(scale: MSMotion.PressScale.tile))
        .hudGlow(lifted ? HUDGlow.floatLift : HUDGlow.float)
        .hudFocusRing()
        .accessibilityAddTraits(.isButton)
    }
}

/// A product-style tile body: square art, name (Inter 13 semibold), mono price (theme.css .product-price).
struct ProductTileBody: View {
    let name: String
    let price: String
    var art: Image?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ZStack {
                MSColor.base
                if let art {
                    art.resizable().scaledToFill()
                }
            }
            .aspectRatio(1, contentMode: .fit)
            .clipped()
            VStack(alignment: .leading, spacing: 2) {
                Text(name)
                    .font(HUDType.productName)
                    .tracking(HUDType.productNameTracking)
                    .foregroundStyle(MSColor.text)
                    .lineLimit(2)
                Text(price)
                    .font(HUDType.productPrice)
                    .tracking(HUDType.productPriceTracking)
                    .monospacedDigit()
                    .foregroundStyle(MSColor.gold)
            }
            .padding(.horizontal, MSSpace.space12)
            .padding(.vertical, MSSpace.space10)
        }
    }
}

#Preview("FloatingTile") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        FloatingTile(action: {}) {
            ProductTileBody(name: "LIT MiniDisc", price: "$28", art: Image("MiniDiscShell"))
        }
        .frame(width: 170)
    }
}

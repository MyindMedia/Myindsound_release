import SwiftUI

/// DS-19 sheet: opaque panel (0.95, hud.css `.p3d-tracklist { --panel: rgba(9,8,16,0.95) }` on phones), gold
/// hairline top edge, corner ticks, grabber in `lineDim`, optional mono title row like the site's sheet
/// toggle (mono 12 bold, tracking 0.16em, gold). No system sheet styling shows through.
struct HUDSheet<Content: View>: View {
    var title: String?
    @ViewBuilder var content: () -> Content

    init(_ title: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.title = title
        self.content = content
    }

    var body: some View {
        VStack(spacing: 0) {
            Capsule()
                .fill(MSColor.lineDim)
                .frame(width: HUDSurface.sheetGrabberSize.width, height: HUDSurface.sheetGrabberSize.height)
                .padding(.top, MSSpace.space8)
                .padding(.bottom, MSSpace.space10)
                .accessibilityHidden(true)
            if let title {
                Text(title.uppercased())
                    .font(HUDType.sheetTitle)
                    .tracking(HUDType.sheetTitleTracking)
                    .foregroundStyle(MSColor.gold)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, MSComponent.HUDPanel.paddingHorizontal)
                    .padding(.bottom, MSComponent.HUDPanel.headerPaddingBottom)
                    .overlay(alignment: .bottom) {
                        Rectangle().fill(MSColor.lineDim).frame(height: MSShape.hairlineWidth)
                    }
                    .accessibilityAddTraits(.isHeader)
            }
            content()
                .frame(maxWidth: .infinity, alignment: .topLeading)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background {
            ZStack {
                MSColor.panelSheet
                HUDScanlines()
            }
            .ignoresSafeArea()
        }
        .overlay(alignment: .top) {
            Rectangle().fill(MSColor.gold).frame(height: MSShape.hairlineWidth).accessibilityHidden(true)
        }
        .hudCornerTicks(corners: [.topLeading, .topTrailing])
    }
}

extension View {
    /// Present `content` as a HUD sheet (DS-19) on the medium and large detents. The system's own
    /// background, grabber and tint are replaced.
    func hudSheet<Content: View>(
        isPresented: Binding<Bool>,
        title: String? = nil,
        detents: Set<PresentationDetent> = [.medium, .large],
        @ViewBuilder content: @escaping () -> Content
    ) -> some View {
        sheet(isPresented: isPresented) {
            HUDSheet(title, content: content)
                .presentationDetents(detents)
                .presentationDragIndicator(.hidden)
                .presentationBackground(.clear)
                .presentationCornerRadius(0)
                .preferredColorScheme(.dark)
                .tint(MSColor.gold)
        }
    }
}

#Preview("HUDSheet") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        HUDSheet("Tracklist 01/07") {
            Text("Rows").foregroundStyle(MSColor.text).padding()
        }
        .frame(height: 320)
    }
}

import SwiftUI
import UIKit

/// A native page in the phone shell (DS-2): the iOS large title that collapses into a compact bar as it
/// scrolls under it (ios.ts HANDOVER_PX = 26), content in HUD sections, over the city backdrop the shell
/// draws. Pushed pages get a gold back chevron in the compact bar; swipe back works (HUDNavigation).
struct HUDPage<Content: View>: View {
    var title: String
    var subtitle: String?
    var showsBack = false
    @ViewBuilder var content: () -> Content

    @State private var scrollOffset: CGFloat = 0
    @Environment(\.dismiss) private var dismiss

    private var scrolled: Bool { scrollOffset > HUDSurface.navHandover }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                GeometryReader { proxy in
                    Color.clear.preference(key: HUDScrollOffsetKey.self, value: -proxy.frame(in: .named("hud-page")).minY)
                }
                .frame(height: 0)
                HUDLargeTitle(title: title, subtitle: subtitle)
                content()
            }
            // A root page's large title sits right under the status bar: the compact bar is empty (and clear) until
            // the page scrolls, so reserving its 46 pt left a blank band above the title on device. Pushed pages
            // keep the room for their back chevron.
            .padding(.top, showsBack ? HUDSurface.navBarHeight : MSSpace.space8)
            .padding(.bottom, MSSpace.space24)
        }
        .coordinateSpace(name: "hud-page")
        .scrollIndicators(.hidden)
        .onPreferenceChange(HUDScrollOffsetKey.self) { scrollOffset = $0 }
        .overlay(alignment: .top) {
            HUDCompactBar(title: title, scrolled: scrolled, onBack: showsBack ? { dismiss() } : nil)
        }
        .toolbar(.hidden, for: .navigationBar)
        // Each page carries the city itself: a NavigationStack paints its own opaque background, and a
        // pushed page slides in over the one below with its backdrop attached.
        .background { HUDBackdrop() }
    }
}

struct HUDScrollOffsetKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// A labelled section of a page (ios.css .section-label + content inset 16).
struct HUDSection<Content: View>: View {
    var label: String?
    @ViewBuilder var content: () -> Content

    init(_ label: String? = nil, @ViewBuilder content: @escaping () -> Content) {
        self.label = label
        self.content = content
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let label { HUDSectionLabel(label) }
            content()
                .padding(.horizontal, MSSpace.space16)
        }
        .padding(.bottom, HUDSurface.sectionGap)
    }
}

/// ios.css .ios-nav: 46 pt translucent bar under the status bar; the compact title fades and lifts in
/// (0.28 s) and a `lineDim` hairline appears once the page has scrolled.
struct HUDCompactBar: View {
    var title: String
    var scrolled: Bool
    var onBack: (() -> Void)?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            Text(title.uppercased())
                .font(MSFont.Style.iosNavTitle)
                .tracking(MSFont.Tracking.iosNavTitle)
                .foregroundStyle(MSColor.text)
                .lineLimit(1)
                .opacity(scrolled ? 1 : 0)
                .offset(y: scrolled ? 0 : 8)
                .accessibilityHidden(!scrolled)
            if let onBack {
                HStack {
                    Button(action: onBack) {
                        HUDChevron()
                            .rotation(.degrees(180))
                            .frame(width: 11, height: 18)
                            .foregroundStyle(MSColor.gold)
                            .frame(width: MSShape.minTouchTarget, height: MSShape.minTouchTarget)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(HUDPressStyle(scale: MSMotion.PressScale.tabIcon))
                    .accessibilityLabel("Back")
                    Spacer()
                }
                .padding(.horizontal, MSSpace.space6)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: HUDSurface.navBarHeight)
        .background {
            // Clear until the title has scrolled under it (ios.css keeps the bar see-through at rest).
            HUDBarBackground(alpha: scrolled ? HUDSurface.navBarScrolledAlpha : 0, blur: scrolled)
                .ignoresSafeArea(edges: .top)
        }
        .overlay(alignment: .bottom) {
            Rectangle()
                .fill(MSColor.lineDim)
                .frame(height: MSShape.hairlineWidth)
                .opacity(scrolled ? 1 : 0)
        }
        .animation(HUDMotion.animation(HUDMotion.navHandover, reduceMotion: reduceMotion), value: scrolled)
    }
}

/// SwiftUI turns off the swipe back gesture when the system navigation bar is hidden; the HUD bar replaces
/// it, so the gesture is turned back on for every stack (DS-2: swipe back stays).
extension UINavigationController: @retroactive UIGestureRecognizerDelegate {
    override open func viewDidLoad() {
        super.viewDidLoad()
        interactivePopGestureRecognizer?.delegate = self
    }

    public func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
        viewControllers.count > 1
    }
}

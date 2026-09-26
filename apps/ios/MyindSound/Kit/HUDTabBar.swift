import SwiftUI

/// The three sections of the phone shell (src/ios.ts `TABS`).
enum HUDTab: String, CaseIterable, Identifiable {
    case listen = "LISTEN"
    case store = "STORE"
    case library = "LIBRARY"

    var id: String { rawValue }

    var icon: HUDIcon {
        switch self {
        case .listen: return .listen
        case .store: return .store
        case .library: return .library
        }
    }
}

/// DS-26 tab bar (ios.css .ios-tabbar / .ios-tab): LISTEN, STORE, LIBRARY with the site's line icons at
/// 22 pt, JetBrains Mono 10 semibold labels tracking 0.1em, gold when active, cream at 50 % otherwise,
/// translucent ink (0.82 over a 20 px blur) above the home indicator, `lineDim` top hairline, 0.92 press.
struct HUDTabBar: View {
    @Binding var selection: HUDTab

    var body: some View {
        HStack(spacing: 0) {
            ForEach(HUDTab.allCases) { tab in
                tabButton(tab)
            }
        }
        .padding(.top, MSComponent.TabBar.bottomPaddingTop)
        .padding(.bottom, MSComponent.TabBar.bottomPaddingTop)
        .frame(maxWidth: .infinity)
        .background {
            HUDBarBackground(alpha: HUDSurface.tabBarAlpha)
                .ignoresSafeArea(edges: .bottom)
        }
        .overlay(alignment: .top) {
            Rectangle().fill(MSColor.lineDim).frame(height: MSShape.hairlineWidth)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Sections")
    }

    private func tabButton(_ tab: HUDTab) -> some View {
        let active = selection == tab
        return Button {
            selection = tab
        } label: {
            VStack(spacing: 3) {
                HUDIconView(icon: tab.icon)
                Text(tab.rawValue)
                    .font(MSFont.Style.tabLabel)
                    .tracking(MSFont.Tracking.tabLabel)
            }
            .padding(.vertical, 4)
            .frame(maxWidth: .infinity)
            .frame(minHeight: MSShape.minTouchTarget)
            .foregroundStyle(active ? MSColor.gold : HUDSurface.tabInactive)
            .contentShape(Rectangle())
        }
        .buttonStyle(HUDPressStyle(scale: MSMotion.PressScale.tabIcon))
        .accessibilityLabel(tab.rawValue.capitalized)
        .accessibilityAddTraits(active ? [.isButton, .isSelected] : [.isButton])
    }
}

/// ios.css bar backgrounds: `rgba(7,7,12,alpha)` over `saturate(180%) blur(20px)`. The blur (a material)
/// only earns its keep once content scrolls under the bar; over bare ink it just greys the band.
struct HUDBarBackground: View {
    var alpha: Double
    var blur = true

    var body: some View {
        ZStack {
            if blur {
                Rectangle().fill(.ultraThinMaterial)
            }
            MSColor.ink.opacity(alpha)
        }
    }
}

#Preview("HUDTabBar") {
    struct Host: View {
        @State var tab = HUDTab.library
        var body: some View {
            ZStack(alignment: .bottom) {
                MSColor.ink.ignoresSafeArea()
                HUDTabBar(selection: $tab)
            }
        }
    }
    return Host()
}

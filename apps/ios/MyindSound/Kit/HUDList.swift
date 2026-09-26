import SwiftUI

/// DS-18 grouped inset list: the group is a `HUDPanel`; rows have a 30 pt icon tile (radius 8), Inter 16
/// semibold title, 13 muted subtitle, separators inset to the text (57 pt, ios.css .action-card + .action-card)
/// and a gold chevron. Destructive rows (sign out, revoke) are centred in `destructive`.
struct HUDList<Rows: View>: View {
    var title: String?
    var meta: String?
    @ViewBuilder var rows: () -> Rows

    init(_ title: String? = nil, meta: String? = nil, @ViewBuilder rows: @escaping () -> Rows) {
        self.title = title
        self.meta = meta
        self.rows = rows
    }

    var body: some View {
        HUDPanel(title, meta: meta, contentInsets: 0) {
            _VariadicView.Tree(HUDListLayout()) { rows() }
        }
    }
}

/// Puts the inset separator between rows without the rows knowing their position.
private struct HUDListLayout: _VariadicView_MultiViewRoot {
    @ViewBuilder
    func body(children: _VariadicView.Children) -> some View {
        let last = children.last?.id
        ForEach(children) { child in
            child
            if child.id != last {
                Rectangle()
                    .fill(HUDSurface.groupedSeparator)
                    .frame(height: MSShape.hairlineWidth)
                    .padding(.leading, HUDSurface.groupedSeparatorInset)
            }
        }
    }
}

struct HUDListRow<Icon: View>: View {
    enum Style { case standard, destructive }

    let title: String
    var subtitle: String?
    var style: Style = .standard
    var chevron = true
    @ViewBuilder var icon: () -> Icon
    let action: () -> Void

    init(
        _ title: String,
        subtitle: String? = nil,
        style: Style = .standard,
        chevron: Bool = true,
        @ViewBuilder icon: @escaping () -> Icon,
        action: @escaping () -> Void
    ) {
        self.title = title
        self.subtitle = subtitle
        self.style = style
        self.chevron = chevron
        self.icon = icon
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: HUDSurface.groupedRowGap) {
                if style == .standard {
                    iconTile
                    VStack(alignment: .leading, spacing: 2) {
                        Text(title)
                            .font(HUDType.groupedTitle)
                            .tracking(HUDType.groupedTitleTracking)
                            .foregroundStyle(MSColor.text)
                        if let subtitle {
                            Text(subtitle)
                                .font(HUDType.groupedSubtitle)
                                .foregroundStyle(MSColor.muted)
                                .monospacedDigit()
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if chevron {
                        // ios.css .action-arrow: cream at 35 % (DS-18 says gold; the site is the bar).
                        HUDChevron()
                            .frame(width: HUDSurface.groupedChevronSize, height: HUDSurface.groupedChevronSize)
                            .foregroundStyle(HUDSurface.groupedChevron)
                    }
                } else {
                    Text(title)
                        .font(HUDType.groupedTitle)
                        .tracking(HUDType.groupedTitleTracking)
                        .foregroundStyle(MSColor.destructive)
                        .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, HUDSurface.groupedRowPaddingV)
            .padding(.horizontal, HUDSurface.groupedRowPaddingH)
            .frame(minHeight: MSComponent.ListRow.minHeight)
            .contentShape(Rectangle())
        }
        .buttonStyle(HUDListRowPressStyle())
        .hudFocusRing()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(subtitle.map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(.isButton)
    }

    private var iconTile: some View {
        icon()
            .font(.system(size: HUDSurface.groupedIconSize, weight: .medium))
            .foregroundStyle(MSColor.gold)
            .frame(width: HUDSurface.groupedIconTile, height: HUDSurface.groupedIconTile)
            .background(MSColor.gold.opacity(0.1))
            .clipShape(RoundedRectangle(cornerRadius: HUDSurface.groupedIconTileRadius, style: .continuous))
            .accessibilityHidden(true)
    }
}

extension HUDListRow where Icon == Image {
    init(_ title: String, subtitle: String? = nil, systemImage: String, action: @escaping () -> Void) {
        self.init(title, subtitle: subtitle, icon: { Image(systemName: systemImage) }, action: action)
    }
}

extension HUDListRow where Icon == EmptyView {
    static func destructive(_ title: String, action: @escaping () -> Void) -> HUDListRow<EmptyView> {
        HUDListRow<EmptyView>(title, style: .destructive, chevron: false, icon: { EmptyView() }, action: action)
    }
}

/// ios.css .action-card:active: gold wash at 14 % and a 0.985 squish.
private struct HUDListRowPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? MSColor.gold.opacity(HUDSurface.groupedPressedAlpha) : .clear)
            .scaleEffect(configuration.isPressed ? MSMotion.PressScale.actionRow : 1)
            .animation(HUDMotion.animation(MSMotion.standard, reduceMotion: reduceMotion), value: configuration.isPressed)
    }
}

/// The trailing chevron, drawn as a line so it stays gold and thin at every Dynamic Type size.
struct HUDChevron: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.3, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX - rect.width * 0.2, y: rect.midY))
        path.addLine(to: CGPoint(x: rect.minX + rect.width * 0.3, y: rect.maxY))
        return path.strokedPath(StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round))
    }
}

#Preview("HUDList") {
    ZStack {
        MSColor.ink.ignoresSafeArea()
        HUDList("Account") {
            HUDListRow("Downloads", subtitle: "7 tracks offline", systemImage: "arrow.down.circle") {}
            HUDListRow("Awards", subtitle: "Early buyer", systemImage: "rosette") {}
            HUDListRow<EmptyView>.destructive("Sign out") {}
        }
        .padding()
    }
}

import SwiftUI

/// RACK-1: the fan's MiniDiscs in their printed sleeves, 3 across on a phone (4 on wider size classes, 2 at large
/// Dynamic Type). Owned and borrowed copies first, then upcoming releases sealed in film with their drop
/// countdown. A tap lifts a copy into the focus view (RACK-2); a locked one opens its release page instead.
struct RackGrid: View {
    let releases: [LibraryRelease]
    let namespace: Namespace.ID

    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var columns: [GridItem] {
        let count = RackRules.columns(regularWidth: sizeClass == .regular, largeText: typeSize >= .xxLarge)
        return Array(repeating: GridItem(.flexible(), spacing: MSSpace.space16, alignment: .top), count: count)
    }

    var body: some View {
        LazyVGrid(columns: columns, alignment: .center, spacing: MSSpace.space24) {
            ForEach(releases) { release in
                RackTile(release: release, namespace: namespace, hidden: app.rackFocus?.slug == release.slug) {
                    tap(release)
                }
            }
        }
    }

    private func tap(_ release: LibraryRelease) {
        if RackTileState(release: release, context: app.contexts[release.slug]).isLocked {
            // DROP-2: sealed, not playable; its page has the drop and the store.
            app.libraryPath.append(HUDRoute.release(release.slug))
            return
        }
        withAnimation(reduceMotion ? .easeInOut(duration: 0.6) : MSMotion.standardLarge) {
            app.openFocus(slug: release.slug)
        }
    }
}

/// One copy: the sleeve (the shared element), the title in mono and the edition on a small LCD (or the drop
/// countdown for a sealed release).
struct RackTile: View {
    let release: LibraryRelease
    let namespace: Namespace.ID
    /// Lifted into the focus view: the sleeve's space stays, empty, until it comes back.
    var hidden: Bool
    let action: () -> Void

    @Environment(AppModel.self) private var app
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var context: ReleaseContext? { app.contexts[release.slug] }
    private var state: RackTileState { RackTileState(release: release, context: context) }
    private var edition: Int? { release.editionNumber ?? context?.editionNumber }

    var body: some View {
        Button(action: action) {
            VStack(spacing: MSSpace.space8) {
                ZStack {
                    // Keeps the tile's size while the sleeve is up in the focus view.
                    Color.clear.aspectRatio(RackArt.aspect, contentMode: .fit)
                    if !hidden {
                        RackSleeve(release: release, state: state)
                            .modifier(SharedSleeve(id: release.slug, namespace: namespace, enabled: !reduceMotion))
                    }
                }
                Text(release.title.uppercased())
                    .font(.custom("JetBrainsMono-SemiBold", size: 11, relativeTo: .caption))
                    .tracking(11 * 0.1)
                    .foregroundStyle(MSColor.text)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                    .frame(maxWidth: .infinity)
                readout
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(HUDPressStyle(scale: MSMotion.PressScale.tile))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(state.isLocked ? "Opens the release page" : "Lifts the disc out of the rack")
        .accessibilityAddTraits(.isButton)
    }

    @ViewBuilder
    private var readout: some View {
        if case .locked(let dropAt) = state {
            TimelineView(.periodic(from: .now, by: 1)) { timeline in
                LCDView(content: LCDContent(RackRules.countdown(dropAt: dropAt, serverNow: app.libraryServerNow(at: timeline.date))))
                    .overlay(Rectangle().strokeBorder(Color.black.opacity(0.6), lineWidth: 1))
            }
        } else if let edition {
            LCDView(content: .edition(edition))
                .overlay(Rectangle().strokeBorder(Color.black.opacity(0.6), lineWidth: 1))
        } else {
            LCDView(content: LCDContent("PRESALE"))
                .overlay(Rectangle().strokeBorder(Color.black.opacity(0.6), lineWidth: 1))
        }
    }

    private var accessibilityLabel: String {
        var countdown: String?
        if case .locked(let dropAt) = state {
            countdown = RackRules.spokenCountdown(dropAt: dropAt, serverNow: app.libraryServerNow())
        }
        return RackSpeech.label(title: release.title, edition: edition, stickers: app.stickers(for: release), state: state, countdown: countdown)
    }
}

/// The sleeve for a library row, with its stickers, wear and state.
struct RackSleeve: View {
    let release: LibraryRelease
    let state: RackTileState

    @Environment(AppModel.self) private var app

    var body: some View {
        SleeveArt(
            slug: release.slug,
            title: release.title,
            edition: release.editionNumber ?? app.contexts[release.slug]?.editionNumber,
            stickers: state.isLocked ? [] : app.stickers(for: release),
            state: state,
            wear: app.wearDescriptor(slug: release.slug),
            accent: release.theme?.accent.flatMap(Color.init(hex:)) ?? MSColor.gold
        )
    }
}

/// The shared-element link between a tile and the focus view (off under Reduce Motion: crossfades only).
struct SharedSleeve: ViewModifier {
    let id: String
    let namespace: Namespace.ID
    var enabled: Bool

    func body(content: Content) -> some View {
        if enabled {
            content.matchedGeometryEffect(id: "sleeve-\(id)", in: namespace)
        } else {
            content
        }
    }
}

/// RACK-1 empty state: NO DISC on the LCD and one pulsing GET LIT (DS-14) to the LIT release.
struct RackEmpty: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        VStack(spacing: MSSpace.space20) {
            LCDView(content: .noDisc).frame(maxWidth: 240)
            Text("Your MiniDiscs live here. Copies you buy with this account show up on the rack.")
                .font(HUDType.groupedSubtitle)
                .foregroundStyle(MSColor.muted)
                .multilineTextAlignment(.center)
            PrimaryButton("Get Lit") { app.libraryPath.append(HUDRoute.release("lit")) }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, MSSpace.space24)
    }
}

extension Color {
    /// `#RRGGBB` from `products.theme` (DS-34).
    init?(hex: String) {
        var value = hex.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("#") { value.removeFirst() }
        guard value.count == 6, let rgb = UInt32(value, radix: 16) else { return nil }
        self.init(red: Double((rgb >> 16) & 0xFF) / 255, green: Double((rgb >> 8) & 0xFF) / 255, blue: Double(rgb & 0xFF) / 255)
    }
}

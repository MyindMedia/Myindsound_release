import SwiftUI

/// RACK-1: the fan's MiniDiscs in their printed sleeves, 3 across on a phone (4 on wider size classes, 2 at large
/// Dynamic Type), two rows to a page: the fan swipes left and right through the rack, 6 discs at a time on a phone,
/// with page dots beneath. Owned and borrowed copies first, then upcoming releases sealed in film with their drop
/// countdown. A tap lifts a copy into the focus view (RACK-2); a locked one opens its release page instead. A long
/// press opens the disc's menu (RACK-4: details and credits, offline, share).
struct RackGrid: View {
    let releases: [LibraryRelease]
    let namespace: Namespace.ID
    let onDetails: (LibraryRelease) -> Void

    @Environment(AppModel.self) private var app
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var page: Int? = 0

    private var columnCount: Int {
        RackRules.columns(regularWidth: sizeClass == .regular, largeText: typeSize >= .xxLarge)
    }

    private var columns: [GridItem] {
        Array(repeating: GridItem(.flexible(), spacing: MSSpace.space16, alignment: .top), count: columnCount)
    }

    var body: some View {
        let pages = RackRules.pages(releases, columns: columnCount)
        VStack(spacing: MSSpace.space16) {
            ScrollView(.horizontal) {
                LazyHStack(alignment: .top, spacing: 0) {
                    ForEach(pages.indices, id: \.self) { index in
                        grid(pages[index])
                            // Each page is the full width, inset like the section, so a swipe moves edge to edge.
                            .padding(.horizontal, MSSpace.space16)
                            .containerRelativeFrame(.horizontal)
                            .id(index)
                    }
                }
                .scrollTargetLayout()
            }
            .scrollTargetBehavior(.paging)
            .scrollIndicators(.hidden)
            .scrollPosition(id: $page)
            .padding(.horizontal, -MSSpace.space16)
            if pages.count > 1 {
                pageDots(count: pages.count)
            }
        }
    }

    private func grid(_ discs: [LibraryRelease]) -> some View {
        LazyVGrid(columns: columns, alignment: .center, spacing: MSSpace.space24) {
            ForEach(discs) { release in
                RackTile(release: release, namespace: namespace, hidden: app.rackFocus?.slug == release.slug) {
                    tap(release)
                }
                .contextMenu {
                    DiscMenu(release: release) { onDetails(release) }
                }
            }
        }
        // Room for the sleeves' glow, which the paging scroll view would otherwise clip.
        .padding(.vertical, MSSpace.space8)
    }

    /// Which page is showing; a tap on a dot jumps to that page.
    private func pageDots(count: Int) -> some View {
        HStack(spacing: 8) {
            ForEach(0..<count, id: \.self) { index in
                let current = (page ?? 0) == index
                Button {
                    withAnimation(reduceMotion ? nil : MSMotion.standard) { page = index }
                } label: {
                    Capsule()
                        .fill(current ? MSColor.gold : MSColor.lineDim)
                        .frame(width: current ? 18 : 6, height: 6)
                        .frame(height: 24)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .animation(reduceMotion ? nil : MSMotion.standard, value: page)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Rack page \((page ?? 0) + 1) of \(count)")
        .accessibilityAdjustableAction { direction in
            let current = page ?? 0
            switch direction {
            case .increment: page = min(count - 1, current + 1)
            case .decrement: page = max(0, current - 1)
            @unknown default: break
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
    var boxAspect: CGFloat = RackArt.aspect
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
                    Color.clear.aspectRatio(boxAspect, contentMode: .fit)
                    if !hidden {
                        RackSleeve(release: release, state: state)
                            .modifier(SharedSleeve(id: release.slug, namespace: namespace, enabled: !reduceMotion))
                    }
                }
                HStack(spacing: 4) {
                    Text(release.title.uppercased())
                        .font(.custom("JetBrainsMono-SemiBold", size: 11, relativeTo: .caption))
                        .tracking(11 * 0.1)
                        .foregroundStyle(MSColor.text)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    offlineMark
                }
                .frame(maxWidth: .infinity)
                readout
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(HUDPressStyle(scale: MSMotion.PressScale.tile))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityLabel)
        .accessibilityHint(state.isLocked ? "Opens the release page" : "Lifts the disc out of the rack. Touch and hold for details, offline and sharing")
        .accessibilityAddTraits(.isButton)
    }

    /// Saved for offline (or saving): a small gold mark beside the title, set from the disc's long-press menu.
    @ViewBuilder
    private var offlineMark: some View {
        switch app.downloads.state(for: release.slug) {
        case .downloaded:
            Image(systemName: "arrow.down.circle.fill").font(.system(size: 10)).foregroundStyle(MSColor.gold)
        case .needsCheck:
            Image(systemName: "exclamationmark.circle").font(.system(size: 10)).foregroundStyle(MSColor.destructive)
        case .downloading(let fraction):
            ProgressView(value: fraction).progressViewStyle(.circular).tint(MSColor.gold).scaleEffect(0.5).frame(width: 10, height: 10)
        case .none, .failed:
            EmptyView()
        }
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

/// The sleeve for a library row, with its stickers, wear and state: the release's rendered still when it has one
/// (`rack`, or LIT's built-in render), completely still, else the printed sleeve art.
struct RackSleeve: View {
    let release: LibraryRelease
    let state: RackTileState
    /// The stickers and states laid over the still. The focus view fades them out as it zooms in, so the frame it
    /// lands on is the live 3D sleeve's opening frame exactly (the stickers show in the row beneath instead).
    var overlayOpacity: Double = 1

    @Environment(AppModel.self) private var app

    private var edition: Int? { release.editionNumber ?? app.contexts[release.slug]?.editionNumber }
    private var stickers: [RackSticker] { state.isLocked ? [] : app.stickers(for: release) }
    private var accent: Color { release.theme?.accent.flatMap(Color.init(hex:)) ?? MSColor.gold }

    var body: some View {
        if let render = app.rackRender(slug: release.slug) {
            RenderedSleeve(
                release: release, render: render, state: state, edition: edition, stickers: stickers,
                wear: app.wearDescriptor(slug: release.slug), accent: accent, overlayOpacity: overlayOpacity
            )
        } else {
            SleeveArt(
                slug: release.slug,
                title: release.title,
                edition: edition,
                stickers: stickers,
                state: state,
                wear: app.wearDescriptor(slug: release.slug),
                accent: accent
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        }
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

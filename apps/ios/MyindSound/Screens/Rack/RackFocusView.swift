import SwiftUI

/// RACK-2: a copy lifted out of the rack. The tile's sleeve moves up into the middle of the screen over the dimmed
/// backdrop (the shared element), then crossfades into the release's own three.js sleeve (ARCH-1: the same renderer
/// as the site, opened in sleeve mode for an unwrapped copy), where the fan turns it, zooms and double-taps to
/// reset. A tap on the sleeve, or LOAD DISC, slides the sleeve off and inserts the disc into the deck. Closing
/// fades back to the printed sleeve and it drops back into its slot.
///
/// A copy that has never been unwrapped opens the full experience instead (RACK-3: the film peels once).
struct RackFocusView: View {
    let focus: RackFocus
    let release: LibraryRelease
    let controller: ReleaseHostController?
    let namespace: Namespace.ID

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The lift has landed; the 3D sleeve may take over.
    @State private var lifted = false
    /// The web view is showing (crossfaded in over the printed sleeve).
    @State private var showHost = false
    @State private var closing = false

    private var context: ReleaseContext? { app.contexts[release.slug] }
    private var state: RackTileState { RackTileState(release: release, context: context) }
    private var edition: Int? { release.editionNumber ?? context?.editionNumber }
    private var canLoad: Bool {
        switch state {
        case .lentOut: return false
        case .borrowed(_, let left, let ended): return !ended && left > 0
        default: return true
        }
    }

    /// Readouts and LOAD show until the load starts (or, in the full experience, until the film is off).
    private var showsPanels: Bool {
        guard !closing else { return false }
        guard let controller else { return true }
        if controller.mode == .full { return !(context?.unwrapped ?? false) }
        return !controller.sleeveLoading
    }

    var body: some View {
        withLifecycle(GeometryReader { proxy in stage(size: proxy.size) }.ignoresSafeArea().statusBarHidden())
    }

    private func stage(size: CGSize) -> some View {
        let layout = FocusLayout(size: size)
        return ZStack {
            // The rack's backdrop, dimmed.
            MSColor.ink.opacity(0.9).ignoresSafeArea()
            hostLayer
            printedSleeve(layout: layout, size: size)
            if showsPanels {
                panels(layout: layout).transition(.opacity)
            }
            closeKey
        }
        .onAppear { controller?.setLayout(size: size, regular: sizeClass == .regular) }
        .onChange(of: size) { _, value in controller?.setLayout(size: value, regular: sizeClass == .regular) }
    }

    @ViewBuilder
    private var hostLayer: some View {
        if let controller {
            WebViewSlot(controller: controller, phase: controller.phase)
                .ignoresSafeArea()
                .opacity(showHost ? 1 : 0)
                .allowsHitTesting(showHost)
                .accessibilityHidden(!showHost)
        }
    }

    /// The printed sleeve: the shared element, and the splash until the page is ready (NAT-3).
    private func printedSleeve(layout: FocusLayout, size: CGSize) -> some View {
        RackSleeve(release: release, state: state)
            .modifier(SharedSleeve(id: release.slug, namespace: namespace, enabled: !reduceMotion))
            .frame(width: layout.sleeveWidth, height: layout.sleeveWidth / RackArt.aspect)
            .position(x: size.width / 2, y: layout.sleeveCentreY)
            .opacity(showHost ? 0 : 1)
            .allowsHitTesting(false)
            .accessibilityHidden(true)
    }

    private func withLifecycle<V: View>(_ content: V) -> some View {
        let phase = controller?.phase
        let closeRequested = controller?.closeRequested ?? false
        let loading = controller?.sleeveLoading ?? false
        let panelAnimation: Animation = reduceMotion ? .easeInOut(duration: 0.3) : .easeInOut(duration: 0.6)
        return content
            .animation(panelAnimation, value: showsPanels)
            .task { await begin() }
            .onDisappear { controller?.setPresented(false) }
            .onChange(of: phase) { _, _ in crossfadeIfReady() }
            .onChange(of: scenePhase) { _, value in controller?.setAppActive(value == .active) }
            .onChange(of: context) { _, _ in controller?.contextChanged() }
            .onChange(of: closeRequested) { _, requested in if requested { close() } }
            .onChange(of: loading) { _, value in
                // DS-32: the bundle sends soft pulses through the pull and rigid on the insert.
                if value { UIAccessibility.post(notification: .announcement, argument: "Loading the disc") }
            }
            .hudSheet(isPresented: sheetBinding, title: controller?.sheet == .lend ? "Lend" : "Share") {
                HostSheetPlaceholder(kind: controller?.sheet ?? .share) { controller?.sheetClosed() }
            }
            .accessibilityAction(.escape) { close() }
    }

    private var sheetBinding: Binding<Bool> {
        Binding(get: { controller?.sheet != nil }, set: { if !$0 { controller?.sheetClosed() } })
    }

    /// The lift (0.5 s) plays while the host starts; the crossfade waits for both.
    private func begin() async {
        if let controller {
            controller.setPresented(true)
            controller.setAppActive(scenePhase == .active)
            Task { await controller.start() }
        }
        try? await Task.sleep(for: .seconds(reduceMotion ? 0.1 : 0.55))
        lifted = true
        crossfadeIfReady()
    }

    // MARK: Crossfade (NAT-3: no flash, the printed sleeve stays until the page has drawn)

    private func crossfadeIfReady() {
        guard lifted, !closing, !showHost, controller?.phase == .ready else { return }
        withAnimation(.easeInOut(duration: 0.6)) { showHost = true }
    }

    // MARK: Close (the reverse move)

    private func close() {
        guard !closing else { return }
        closing = true
        let fade = reduceMotion ? 0.3 : 0.4
        withAnimation(.easeInOut(duration: fade)) { showHost = false }
        Task {
            try? await Task.sleep(for: .seconds(fade))
            withAnimation(reduceMotion ? .easeInOut(duration: 0.6) : MSMotion.standardLarge) { app.closeFocus() }
        }
    }

    private var closeKey: some View {
        VStack {
            HStack {
                Button(action: close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(MSColor.text.opacity(0.8))
                        .frame(width: 34, height: 34)
                        .background(Rectangle().fill(MSColor.ink.opacity(0.55)))
                        .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
                        .frame(width: MSShape.minTouchTarget, height: MSShape.minTouchTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(HUDPressStyle())
                .accessibilityLabel("Close")
                Spacer()
            }
            Spacer()
        }
        .padding(.leading, MSSpace.space10)
        .padding(.top, 50)
    }

    // MARK: Readouts (DS-17) and LOAD (DS-14)

    private func panels(layout: FocusLayout) -> some View {
        VStack(spacing: 0) {
            HUDPanel("\(release.title.uppercased()) · COPY", meta: state.isLocked ? "SEALED" : release.ownership.readout, opaque: true) {
                // One compact row, so the panel stays clear of the sleeve on the smallest phones.
                HStack(alignment: .top, spacing: MSSpace.space14) {
                    readout("Edition") {
                        if let edition { LCDView.inset(.edition(edition), width: 104) } else { ReadoutValue("PRESALE") }
                    }
                    readout("Plays") { ReadoutValue(playTime) }
                    readout("Wear") {
                        ReadoutValue(app.wearLevel(slug: release.slug).map { "\(Int(($0 * 100).rounded()))%" } ?? "--")
                    }
                }
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, MSSpace.space16)
            .padding(.top, 92)

            Spacer(minLength: 0)

            if controller?.mode != .full {
            VStack(spacing: MSSpace.space12) {
                stickerRow
                if let lines = state.tagLines, !canLoad {
                    Text("\(lines.0) · \(lines.1)")
                        .font(MSFont.mono(12, weight: .semibold))
                        .tracking(12 * 0.14)
                        .foregroundStyle(MSColor.orange)
                        .monospacedDigit()
                } else {
                    HUDLabel(controller == nil ? "Tap Load to play" : "Drag to turn · pinch to zoom · tap to load")
                        .multilineTextAlignment(.center)
                    PrimaryButton("Load Disc", pulsing: canLoad, fullWidth: false) { load() }
                        .disabled(!canLoad || (controller != nil && controller?.phase != .ready))
                        .opacity(canLoad ? 1 : 0.5)
                        .accessibilityHint("Slides the sleeve off and plays the disc")
                }
            }
            .frame(maxWidth: 520)
            .padding(.horizontal, MSSpace.space16)
            .padding(.bottom, 40)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private func readout<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HUDLabel(label)
            value()
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var stickerRow: some View {
        let stickers = app.stickers(for: release)
        if !stickers.isEmpty {
            HStack(spacing: MSSpace.space12) {
                ForEach(stickers, id: \.self) { sticker in
                    HStack(spacing: 6) {
                        VinylSticker(sticker: sticker, diameter: 26)
                        Text(sticker.title)
                            .font(MSFont.mono(10, weight: .semibold))
                            .tracking(10 * 0.12)
                            .foregroundStyle(MSColor.muted)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Stickers: " + stickers.map(\.spoken).joined(separator: ", "))
        }
    }

    /// Total time heard on this copy (`wearInputs.stats.playSeconds`).
    private var playTime: String {
        guard let seconds = context?.wearInputs?.playSeconds else { return "--" }
        let minutes = Int(seconds / 60)
        return minutes >= 60 ? "\(minutes / 60)H \(String(format: "%02d", minutes % 60))M" : "\(minutes)M"
    }

    private func load() {
        if let controller {
            controller.loadFromSleeve()
            return
        }
        // No bundle for this release yet: the native player plays it.
        Task {
            guard let tracks = try? await app.loadTracks(slug: release.slug), !tracks.isEmpty else { return }
            app.audio.load(release: release, tracks: tracks, startAt: 0, lendId: release.lend?.role == .borrower ? release.lend?.lendId : nil)
            close()
            app.showPlayer = true
        }
    }
}

/// Where the printed sleeve sits in the focus view: the same box the bundle's inspector fits the 3D sleeve into
/// (hud stage, FILL 0.86 / 0.9), so the crossfade lands on it.
struct FocusLayout {
    let size: CGSize

    var sleeveWidth: CGFloat { min(size.width * 0.846, size.height * 0.39) }
    /// The centre of the whole view (cartridge lip included), so the sleeve face centres at 49.4 % of the height.
    var sleeveCentreY: CGFloat {
        size.height * 0.494 - sleeveWidth * RackArt.cartridgeLip / 2
    }
}

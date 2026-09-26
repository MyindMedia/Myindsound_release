import SwiftUI
import WebKit

/// Which release the host shows (RootView presents it full screen).
struct HostRoute: Identifiable, Hashable {
    var slug: String
    var id: String { slug }
}

/// BUN-3, NAT-1..4: the release experience, full screen and edge to edge. The native splash (the release art
/// on ink) covers the web view until the bundle calls `ready()`; after `READY_TIMEOUT_MS` it becomes an error
/// with Retry and Close. BRG-3 mismatches get the native "Update the app" screen instead of the bundle.
struct ReleaseHostView: View {
    let controller: ReleaseHostController
    var onClose: () -> Void

    @Environment(AppModel.self) private var app
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var sizeClass
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        @Bindable var controller = controller
        GeometryReader { proxy in
            ZStack {
                MSColor.ink.ignoresSafeArea()
                WebViewSlot(controller: controller, phase: controller.phase)
                    .ignoresSafeArea()
                overlay
                    .transition(.opacity)
                closeKey
            }
            .onAppear { controller.setLayout(size: proxy.size, regular: sizeClass == .regular) }
            .onChange(of: proxy.size) { _, size in controller.setLayout(size: size, regular: sizeClass == .regular) }
            .onChange(of: sizeClass) { _, value in controller.setLayout(size: proxy.size, regular: value == .regular) }
        }
        .ignoresSafeArea()
        .animation(reduceMotion ? nil : .easeOut(duration: 0.6), value: controller.phase)
        .statusBarHidden()
        .persistentSystemOverlays(.hidden)
        .task {
            controller.setPresented(true)
            controller.setAppActive(scenePhase == .active)
            await controller.start()
        }
        .onDisappear { controller.setPresented(false) }
        .onChange(of: scenePhase) { _, phase in controller.setAppActive(phase == .active) }
        .onChange(of: app.contexts[controller.slug]) { _, _ in controller.contextChanged() }
        .onChange(of: controller.closeRequested) { _, requested in if requested { onClose() } }
        .hudSheet(isPresented: Binding(
            get: { controller.sheet != nil },
            set: { if !$0 { controller.sheetClosed() } }
        ), title: controller.sheet == .lend ? "Lend" : "Share") {
            HostSheetPlaceholder(kind: controller.sheet ?? .share) { controller.sheetClosed() }
        }
    }

    @ViewBuilder
    private var overlay: some View {
        switch controller.phase {
        case .resolving, .loading:
            HostSplash(slug: controller.slug, message: controller.phase == .resolving ? "LOADING RELEASE" : "READING DISC")
        case .ready:
            EmptyView()
        case .failed(let message):
            HostMessage(title: "NO SIGNAL", message: message, primary: ("Try again", { controller.retry() }), close: onClose)
        case .needsUpdate:
            HostMessage(
                title: "UPDATE THE APP",
                message: "This release needs a newer version of Myind Sound. Update the app to open it.",
                primary: ("Update", { UIApplication.shared.open(AppLinks.appStore) }),
                close: onClose
            )
        }
    }

    /// A native way out that doesn't depend on the bundle (its own close is GET LIT's `close()`).
    private var closeKey: some View {
        VStack {
            HStack {
                Button(action: onClose) {
                    Image(systemName: "xmark")
                        .font(.system(size: 13, weight: .bold))
                        .foregroundStyle(MSColor.text.opacity(0.8))
                        .frame(width: 34, height: 34)
                        // A view, not a ShapeStyle: a style background would bleed up into the safe area.
                        .background(Rectangle().fill(MSColor.ink.opacity(0.55)))
                        .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
                        .contentShape(Rectangle())
                }
                .buttonStyle(HUDPressStyle())
                .accessibilityLabel("Close")
                Spacer()
            }
            Spacer()
        }
        .padding(.leading, MSSpace.space16)
        .padding(.top, 54)
    }
}

/// Hosts the controller's WKWebView, which outlives this view in the pool (NAT-4).
struct WebViewSlot: UIViewRepresentable {
    let controller: ReleaseHostController
    /// The web view is made after this slot (once the bundle resolves): a phase change re-runs `updateUIView`,
    /// which puts it in the window. Off the window WebKit runs no animation frames, so `ready()` never comes.
    let phase: ReleaseHostController.Phase

    func makeUIView(context: Context) -> UIView {
        let container = UIView()
        container.backgroundColor = UIColor(MSColor.ink)
        attach(to: container)
        return container
    }

    func updateUIView(_ container: UIView, context: Context) {
        attach(to: container)
    }

    private func attach(to container: UIView) {
        guard let webView = controller.webView, webView.superview !== container else { return }
        webView.removeFromSuperview()
        webView.frame = container.bounds
        webView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        container.addSubview(webView)
    }
}

/// NAT-3 splash: the release art on ink, as the bundle's own first frame starts.
struct HostSplash: View {
    let slug: String
    var message = "LOADING"

    var body: some View {
        ZStack {
            MSColor.ink.ignoresSafeArea()
            VStack(spacing: MSSpace.space24) {
                ReleaseSleeve(slug: slug, size: 232)
                HStack(spacing: MSSpace.space10) {
                    HUDSpinner(size: 16, stroke: 2)
                    Text(message)
                        .font(MSFont.mono(12, weight: .semibold))
                        .tracking(12 * 0.16)
                        .foregroundStyle(MSColor.muted)
                }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading the release")
    }
}

/// The error and update screens: an LCD word, a line of copy, a key to act and one to close.
private struct HostMessage: View {
    let title: String
    let message: String
    let primary: (String, () -> Void)
    let close: () -> Void

    var body: some View {
        ZStack {
            MSColor.ink.ignoresSafeArea()
            HUDPanel(title, meta: "Release") {
                VStack(spacing: MSSpace.space20) {
                    LCDView(content: LCDContent(title == "UPDATE THE APP" ? "UPDATE" : "NO SIGNAL"))
                        .frame(width: 200)
                    Text(message)
                        .font(MSFont.inter(16, weight: .regular))
                        .foregroundStyle(MSColor.muted)
                        .multilineTextAlignment(.center)
                    PrimaryButton(primary.0, action: primary.1)
                    KeyButton("Close", action: close)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, MSSpace.space12)
            }
            .padding(.horizontal, MSSpace.space24)
        }
    }
}

/// `requestShare` / `requestLend` until PRD §15 and §12 land: a HUD sheet that says so and resolves on close.
struct HostSheetPlaceholder: View {
    let kind: HostSheet
    let done: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: MSSpace.space16) {
            Text(kind == .lend
                 ? "Lending arrives in the next update: send your copy to a friend for a few plays, then it comes back."
                 : "Sharing arrives in the next update: a card of your copy, your edition number and its wear.")
                .font(HUDType.groupedSubtitle)
                .foregroundStyle(MSColor.muted)
            KeyButton("Done", fullWidth: true, action: done)
        }
        .padding(MSComponent.HUDPanel.paddingHorizontal)
    }
}

enum AppLinks {
    /// [DECIDE] the App Store id once the listing exists; the site until then.
    static let appStore = URL(string: "https://stream.myindsound.com")!
}

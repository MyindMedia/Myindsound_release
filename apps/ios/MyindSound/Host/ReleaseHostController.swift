import os
import UIKit
import WebKit

/// One release experience in a WKWebView (PRD §10.1 BUN-3, §10.3 NAT-1..4). Owns the web view, the scheme
/// handler, the bridge and the load state. Lives in `HostPool`, so the most recently played release can be
/// loaded before the fan opens it (NAT-4) and shown with no wait.
/// How the release opens: the full experience (the sealed package on a new copy, RACK-3, else the deck), or the
/// rack's sleeve mode for an unwrapped copy (the printed card sleeve without film, `index.html?mode=sleeve`).
enum HostMode: String, Equatable {
    case full
    case sleeve
}

@MainActor
@Observable
final class ReleaseHostController: NSObject {
    enum Phase: Equatable {
        case resolving
        case loading
        case ready
        case failed(String)
        case needsUpdate
    }

    let slug: String
    let mode: HostMode
    private(set) var phase: Phase = .resolving
    /// Sleeve mode: the fan has started the load (the sleeve is sliding off). The bundle reports it as a
    /// same-page `#loading` fragment, which the navigation policy allows.
    private(set) var sleeveLoading = false
    /// The share or lend placeholder sheet the bundle asked for.
    var sheet: HostSheet?
    var closeRequested = false

    @ObservationIgnored private unowned let app: AppModel
    @ObservationIgnored private(set) var webView: WKWebView?
    @ObservationIgnored private var bridge: NativeBridge?
    @ObservationIgnored private var scheme: BundleSchemeHandler?
    @ObservationIgnored private var bundle: InstalledBundle?
    @ObservationIgnored private var expectedURL: URL?
    @ObservationIgnored private var readyTimer: Task<Void, Never>?
    @ObservationIgnored private var sheetDone: (() -> Void)?
    @ObservationIgnored private var presented = false
    @ObservationIgnored private var starting = false
    @ObservationIgnored private var appActive = true
    @ObservationIgnored private let log = Logger(subsystem: "com.myindsound.app", category: "host")
    @ObservationIgnored private var urlObservation: NSKeyValueObservation?

    init(slug: String, app: AppModel, mode: HostMode = .full) {
        self.slug = slug
        self.app = app
        self.mode = mode
    }

    /// The entry URL for a bundle entry in this mode.
    nonisolated static func entryURL(slug: String, entry: String, mode: HostMode) -> URL {
        URL(string: "\(BridgeContract.scheme)://\(slug)/\(entry)\(mode == .sleeve ? "?mode=sleeve" : "")")!
    }

    /// Sleeve mode's LOAD key: the same as a tap on the sleeve (the bundle ignores it when the copy can't load).
    func loadFromSleeve() {
        guard mode == .sleeve, phase == .ready else { return }
        webView?.evaluateJavaScript("window.__myindSleeve && window.__myindSleeve.load(); void 0", completionHandler: nil)
    }

    #if DEBUG
    /// Screenshot scenarios only (`-screen rack-*`): drives the page as a fan's fingers would.
    func debugEvaluate(_ script: String) {
        webView?.evaluateJavaScript(script, completionHandler: nil)
    }
    #endif

    // MARK: Start

    /// Resolves the bundle (BUN-2) and loads it. Safe to call again after a failure.
    func start() async {
        if starting { return }
        if webView != nil, phase == .ready || phase == .loading { return }
        starting = true
        defer { starting = false }
        phase = .resolving
        guard let release = app.release(slug: slug) else {
            phase = .failed("This release isn't in your library.")
            return
        }
        switch await app.bundles.resolve(release) {
        case .failed(let message):
            phase = .failed(message)
        case .needsUpdate:
            phase = .needsUpdate
        case .ready(let installed):
            bundle = installed
            if webView == nil { makeWebView(installed) }
            load()
        }
    }

    private func makeWebView(_ installed: InstalledBundle) {
        let scheme = BundleSchemeHandler(slug: slug, root: installed.root, entry: installed.manifest.entry)
        let bridge = NativeBridge(slug: slug, app: app, manifest: installed.manifest)
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(scheme, forURLScheme: BridgeContract.scheme)
        config.allowsInlineMediaPlayback = true
        // The bundle's Web Audio sounds start on its own gestures; nothing autoplays audibly (NAT-6).
        config.mediaTypesRequiringUserActionForPlayback = []
        config.dataDetectorTypes = []
        config.preferences.isTextInteractionEnabled = false
        config.preferences.isElementFullscreenEnabled = false
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.add(WeakScriptHandler { [weak bridge] in bridge?.receive($0) }, contentWorld: .page, name: BridgeContract.handlerName)
        #if DEBUG
        config.userContentController.add(WeakScriptHandler { [weak self] message in self?.debugLog(message) }, contentWorld: .page, name: "myindDebug")
        #endif

        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 844), configuration: config)
        // NAT-3: ink under everything, so there is never a white frame.
        webView.isOpaque = false
        webView.backgroundColor = UIColor(MSColor.ink)
        webView.underPageBackgroundColor = UIColor(MSColor.ink)
        webView.scrollView.backgroundColor = UIColor(MSColor.ink)
        // NAT-2: no bounce, no zoom (the bundle does its own pinch), no link previews, no back swipe.
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.alwaysBounceHorizontal = false
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.minimumZoomScale = 1
        webView.scrollView.maximumZoomScale = 1
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false
        webView.scrollView.delegate = self
        // NAT-1: edge to edge; the bundle reads env(safe-area-inset-*) where it wants them.
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.allowsLinkPreview = false
        webView.allowsBackForwardNavigationGestures = false
        webView.navigationDelegate = self
        webView.uiDelegate = self
        #if DEBUG
        webView.isInspectable = true
        #endif

        urlObservation = webView.observe(\.url, options: [.new]) { [weak self] view, _ in
            let fragment = view.url?.fragment
            MainActor.assumeIsolated {
                if fragment == "loading" { self?.sleeveLoading = true }
            }
        }
        bridge.webView = webView
        bridge.onReady = { [weak self] in self?.bundleReady() }
        bridge.onClose = { [weak self] in self?.closeRequested = true }
        bridge.onSheet = { [weak self] kind, done in
            guard let self else { return done() }
            self.sheetDone?()
            self.sheetDone = done
            self.sheet = kind
        }
        self.scheme = scheme
        self.bridge = bridge
        self.webView = webView
        // The host may already be on screen: the bridge starts in the right lifecycle state (BRG-2).
        updateLifecycle()
    }

    /// A page load with fresh per-page secrets (CONTRACT.md §2). Every main-frame load goes through here.
    func load() {
        guard let webView, let scheme, let bridge, let bundle else { return }
        guard let shimSource = Self.shimSource else {
            phase = .failed("This build is missing the bridge.")
            return
        }
        let token = BridgeContract.randomHex()
        var key = BridgeContract.randomHex()
        while key == token { key = BridgeContract.randomHex() }
        guard let shim = BridgeContract.substituteShim(shimSource, token: token, channelKey: key) else {
            phase = .failed("This build is missing the bridge.")
            return
        }
        let controller = webView.configuration.userContentController
        controller.removeAllUserScripts()
        // Injected only into myind-bundle main frames: navigation anywhere else is cancelled below.
        controller.addUserScript(WKUserScript(source: shim, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        controller.addUserScript(WKUserScript(source: Self.nativeStyle, injectionTime: .atDocumentEnd, forMainFrameOnly: true, in: .page))
        #if DEBUG
        controller.addUserScript(WKUserScript(source: Self.debugConsole, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: .page))
        #endif
        scheme.connectToken = token
        bridge.newPage(channelKey: key)
        readyTimer?.cancel()
        phase = .loading
        sleeveLoading = false
        let url = Self.entryURL(slug: slug, entry: bundle.manifest.entry, mode: mode)
        expectedURL = url
        webView.load(URLRequest(url: url))
        armReadyTimer()
    }

    /// Retry from the error screen: resolve again (the bundle may have been fixed or re-downloaded).
    func retry() {
        bridge?.dropPending()
        Task { await start() }
    }

    func teardown() {
        readyTimer?.cancel()
        urlObservation?.invalidate()
        urlObservation = nil
        bridge?.teardown()
        webView?.stopLoading()
        webView?.navigationDelegate = nil
        webView?.uiDelegate = nil
        webView?.configuration.userContentController.removeAllScriptMessageHandlers()
        webView?.removeFromSuperview()
        webView = nil
        bridge = nil
        scheme = nil
        sheetDone?()
        sheetDone = nil
    }

    // MARK: Presentation and lifecycle (BRG-2)

    func setPresented(_ value: Bool) {
        presented = value
        updateLifecycle()
        if value, phase == .loading { armReadyTimer() }
    }

    func setAppActive(_ value: Bool) {
        appActive = value
        updateLifecycle()
    }

    private func updateLifecycle() {
        bridge?.setForeground(presented && appActive)
    }

    func setLayout(size: CGSize, regular: Bool) {
        bridge?.setLayout(size: size, regular: regular)
    }

    func contextChanged() {
        bridge?.contextChanged()
    }

    func sheetClosed() {
        sheet = nil
        let done = sheetDone
        sheetDone = nil
        done?()
    }

    // MARK: Ready (NAT-3)

    private func bundleReady() {
        readyTimer?.cancel()
        if phase == .loading { phase = .ready }
    }

    /// READY_TIMEOUT_MS: counted from when the fan is looking (a pre-warmed view renders nothing off screen).
    private func armReadyTimer() {
        readyTimer?.cancel()
        guard presented, phase == .loading else { return }
        readyTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(BridgeContract.readyTimeout))
            guard !Task.isCancelled, let self, self.phase == .loading else { return }
            self.phase = .failed("The release didn't start. Try again.")
        }
    }

    // MARK: Resources

    /// `packages/bridge/native-shim.js`, copied into the app as is (project.yml).
    static let shimSource: String? = Bundle.main.url(forResource: "native-shim", withExtension: "js")
        .flatMap { try? String(contentsOf: $0, encoding: .utf8) }

    /// NAT-2 belt and braces: the bundle sets these too.
    static let nativeStyle = """
    (function(){var s=document.createElement('style');s.textContent='html,body{-webkit-user-select:none;user-select:none;-webkit-touch-callout:none;-webkit-tap-highlight-color:transparent;overscroll-behavior:none;touch-action:none}';(document.head||document.documentElement).appendChild(s);})();
    """

    #if DEBUG
    /// Debug builds only: console errors, uncaught errors and CSP violations to the device log.
    static let debugConsole = """
    (function(){var h=window.webkit&&window.webkit.messageHandlers&&window.webkit.messageHandlers.myindDebug;if(!h)return;
    function send(k,a){try{h.postMessage(k+': '+Array.prototype.map.call(a,function(x){try{return x instanceof Error?x.name+' '+x.message:typeof x==='string'?x:JSON.stringify(x)}catch(e){return String(x)}}).join(' ').slice(0,400))}catch(e){}}
    ['error','warn'].forEach(function(k){var o=console[k];console[k]=function(){send(k,arguments);return o.apply(console,arguments)}});
    window.addEventListener('error',function(e){send('uncaught',[e.message+' @'+(e.filename||'').split('/').pop()+':'+e.lineno])});
    window.addEventListener('unhandledrejection',function(e){send('rejection',[e.reason])});
    document.addEventListener('securitypolicyviolation',function(e){send('csp',[e.violatedDirective+' '+e.blockedURI])});})();
    """

    private func debugLog(_ message: WKScriptMessage) {
        guard let text = message.body as? String else { return }
        log.debug("bundle \(text.prefix(400), privacy: .public)")
    }
    #endif
}

// MARK: - Navigation (CONTRACT.md §1.2, §1.4)

extension ReleaseHostController: WKNavigationDelegate, WKUIDelegate, UIScrollViewDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping @MainActor (WKNavigationActionPolicy) -> Void) {
        decisionHandler(Self.policy(for: action.request.url, targetIsMainFrame: action.targetFrame?.isMainFrame,
                                    slug: slug, expected: &expectedURL, current: webView.url) ? .allow : .cancel)
        if action.targetFrame?.isMainFrame == true, action.navigationType == .reload, action.request.url != nil {
            // A page-initiated reload gets fresh secrets through load() instead.
            if expectedURL == nil, phase != .resolving { load() }
        }
    }

    /// Allow only: the load native started, a same-document fragment change, and subframes on the bundle's
    /// own origin. Never another scheme or host, never a new window (`targetFrame == nil`).
    nonisolated static func policy(for url: URL?, targetIsMainFrame: Bool?, slug: String, expected: inout URL?, current: URL?) -> Bool {
        guard let url, url.scheme == BridgeContract.scheme, url.host == slug, let isMain = targetIsMainFrame else { return false }
        guard isMain else { return true }
        if let wanted = expected, url == wanted {
            expected = nil
            return true
        }
        if let current, url.fragment != nil, withoutFragment(url) == withoutFragment(current) { return true }
        return false
    }

    nonisolated private static func withoutFragment(_ url: URL) -> String {
        url.absoluteString.components(separatedBy: "#")[0]
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        // Page code from the previous load can't be answered any more.
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        failLoad(error)
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        failLoad(error)
    }

    private func failLoad(_ error: Error) {
        // A cancelled navigation (our own policy) isn't a failure of the page.
        if (error as NSError).code == NSURLErrorCancelled || (error as NSError).code == 102 { return }
        readyTimer?.cancel()
        bridge?.dropPending()
        phase = .failed("The release didn't load. Try again.")
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        log.error("web content process terminated")
        bridge?.dropPending()
        load()
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }

    func webView(_ webView: WKWebView, contextMenuConfigurationForElement elementInfo: WKContextMenuElementInfo, completionHandler: @escaping @MainActor (UIContextMenuConfiguration?) -> Void) {
        completionHandler(nil)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor () -> Void) {
        completionHandler()
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (Bool) -> Void) {
        completionHandler(false)
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping @MainActor (String?) -> Void) {
        completionHandler(nil)
    }

    nonisolated func viewForZooming(in scrollView: UIScrollView) -> UIView? { nil }
}

// MARK: - Pool (NAT-4)

/// Keeps one warm host: the most recently played release, loaded in the background after the library
/// refreshes, so OPEN DECK shows it at once. At most one extra web view; dropped on a memory warning.
@MainActor
final class HostPool {
    private unowned let app: AppModel
    private var warm: ReleaseHostController?

    init(app: AppModel) {
        self.app = app
        NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.dropWarm() }
        }
    }

    /// The host for `slug` in `mode`: the warm one if it matches, else a new one.
    func controller(for slug: String, mode: HostMode = .full) -> ReleaseHostController {
        if let warm, warm.slug == slug, warm.mode == mode {
            if case .failed = warm.phase { dropWarm() } else { return warm }
        }
        dropWarm()
        let controller = ReleaseHostController(slug: slug, app: app, mode: mode)
        warm = controller
        return controller
    }

    /// After a close: the page is torn down (CONTRACT.md §4 `close`) and a fresh one warms up behind it.
    func closed(_ controller: ReleaseHostController) {
        if warm === controller { warm = nil }
        controller.teardown()
        Task {
            try? await Task.sleep(for: .seconds(2))
            self.prewarm()
        }
    }

    func prewarm() {
        // Never inside the unit test host.
        guard ProcessInfo.processInfo.environment["XCTestConfigurationFilePath"] == nil else { return }
        // The most recently played copy, else the newest one on the rack; in the mode the rack opens it in, so a
        // tap lifts straight into a page that is already built (NAT-4).
        let playable = { (release: LibraryRelease) in
            (release.ownership == .owned || release.ownership == .lent) && release.bundle != nil
        }
        let lastPlayed = UserDefaults.standard.string(forKey: AudioEngine.lastPlayedKey).flatMap { app.release(slug: $0) }
        guard warm == nil, let release = lastPlayed.flatMap({ playable($0) ? $0 : nil }) ?? app.ownedReleases.first(where: playable) else { return }
        let controller = ReleaseHostController(slug: release.slug, app: app, mode: app.rackMode(slug: release.slug))
        warm = controller
        Task { await controller.start() }
    }

    private func dropWarm() {
        warm?.teardown()
        warm = nil
    }
}

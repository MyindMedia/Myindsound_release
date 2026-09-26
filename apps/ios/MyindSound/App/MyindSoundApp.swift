import SwiftUI

@main
struct MyindSoundApp: App {
    @State private var app = AppModel(config: .current())
    @Environment(\.scenePhase) private var scenePhase
    /// The Debug sample data switch rebuilds the composition root (a new API behind everything).
    private let sessionChanges = NotificationCenter.default.publisher(for: AppSession.didChange)

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(app)
                // DS-3: dark only, gold tint, never system blue.
                .preferredColorScheme(.dark)
                .tint(MSColor.gold)
                .background(MSColor.ink.ignoresSafeArea())
                .task { await app.start() }
                .onChange(of: scenePhase) { _, phase in
                    // WEAR-9: flush the offline queue and refresh on every foreground.
                    if phase == .active { Task { await app.foregrounded() } }
                }
                .onReceive(sessionChanges) { _ in
                    app.audio.eject()
                    app = AppModel(config: .current())
                    Task { await app.start() }
                }
        }
    }
}

/// Debug only: the "Preview with sample data" key on sign in. The choice is remembered, so the home screen
/// icon opens on the sample data too, until SIGN OUT turns it off. Release builds ignore it entirely.
enum AppSession {
    static let didChange = Notification.Name("MSAppSessionDidChange")
    static let sampleDataKey = "MSPreviewSampleData"

    static var usesSampleData: Bool {
        #if DEBUG
        UserDefaults.standard.bool(forKey: sampleDataKey)
        #else
        false
        #endif
    }

    static func enterSampleData() {
        #if DEBUG
        UserDefaults.standard.set(true, forKey: sampleDataKey)
        NotificationCenter.default.post(name: didChange, object: nil)
        #endif
    }

    /// Called on sign out: back to the real sign in.
    static func leaveSampleData() {
        #if DEBUG
        guard usesSampleData else { return }
        UserDefaults.standard.set(false, forKey: sampleDataKey)
        NotificationCenter.default.post(name: didChange, object: nil)
        #endif
    }
}

/// `-screen <name>` on the launch command line picks the first screen, so simulator screenshots can be
/// scripted: `xcrun simctl launch booted com.myindsound.app -mock -screen leaderboard`.
enum LaunchScreen: String {
    case gallery, library, lcd, listen, store, boot, leaderboard, signin, player, host
    case storeLoading = "store-loading"
    case rackFocus = "rack-focus"
    case rackFocusBack = "rack-focus-back"
    case rackPull = "rack-pull"
    case rackLoaded = "rack-loaded"

    /// `-slug <slug>`: the release `-screen player` and `-screen rack-focus` open (default: the newest, and LIT).
    static var slug: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "-slug"), index + 1 < arguments.count else { return nil }
        return arguments[index + 1].lowercased()
    }

    static func fromLaunchArguments(_ arguments: [String] = ProcessInfo.processInfo.arguments) -> LaunchScreen {
        if let index = arguments.firstIndex(of: "-screen"), index + 1 < arguments.count,
           let screen = LaunchScreen(rawValue: arguments[index + 1].lowercased()) {
            return screen
        }
        // `-screen x` is also parsed into the defaults domain by Foundation.
        if let value = UserDefaults.standard.string(forKey: "screen"), let screen = LaunchScreen(rawValue: value.lowercased()) {
            return screen
        }
        return .library
    }
}

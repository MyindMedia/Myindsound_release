import SwiftUI

/// The app shell: boot, then sign in or the three sections under the tab bar with the now playing bar
/// docked above it (DS-25, DS-26), all over the city backdrop. Debug screens (gallery, lcd, boot) take the
/// whole window.
struct RootView: View {
    @Environment(AppModel.self) private var app
    @State private var appliedLaunchScreen = false

    var body: some View {
        switch app.config.screen {
        case .gallery:
            KitGallery()
        case .lcd:
            LCDScreen()
        case .boot:
            BootLoader(progress: 0.62, lines: Array(BootLoader.sampleLines.prefix(3)))
        default:
            gate
        }
    }

    @ViewBuilder
    private var gate: some View {
        switch app.auth.state {
        case .loading:
            BootLoader(progress: 0.4, lines: Array(BootLoader.sampleLines.prefix(2)))
        case .signedOut:
            SignInScreen()
                .transition(.opacity)
        case .signedIn:
            shell
                .task { applyLaunchScreen() }
        }
    }

    private var shell: some View {
        @Bindable var app = app
        return ZStack {
            MSColor.ink.ignoresSafeArea()
            switch app.tab {
            case .listen:
                NavigationStack(path: $app.listenPath) {
                    ListenTab()
                        .navigationDestination(for: HUDRoute.self, destination: destination)
                }
            case .store:
                NavigationStack {
                    StoreScreen(holdLoading: app.config.screen == .storeLoading)
                }
            case .library:
                NavigationStack(path: $app.libraryPath) {
                    LibraryScreen()
                        .navigationDestination(for: HUDRoute.self, destination: destination)
                }
            }
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if let track = app.audio.currentTrack, let loaded = app.audio.loaded {
                    NowPlayingBar(
                        title: "\(String(format: "%02d", track.position)) · \(track.title)",
                        tag: loaded.release.title,
                        elapsed: Track.clock(app.audio.elapsed),
                        duration: Track.clock(app.audio.duration),
                        progress: app.audio.progress,
                        isPlaying: app.audio.isPlaying,
                        onOpen: { app.showPlayer = true },
                        onPrev: { app.audio.previous() },
                        onPlayPause: { app.audio.togglePlayPause() },
                        onNext: { app.audio.next() }
                    )
                    // ios.css body.ios-app .mini-player: left/right 8, sitting on the tab bar.
                    .padding(.horizontal, MSComponent.NowPlaying.dockedLeft)
                    .padding(.top, MSSpace.space8)
                    .padding(.bottom, MSSpace.space8)
                    // A solid band from the bar down to the tab bar, so rows never show between them.
                    .background(alignment: .top) {
                        MSColor.ink
                            .overlay(alignment: .top) {
                                LinearGradient(colors: [.clear, MSColor.ink], startPoint: .top, endPoint: .bottom)
                                    .frame(height: 18)
                                    .offset(y: -18)
                            }
                    }
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                HUDTabBar(selection: $app.tab)
            }
            // RACK-2: the focus view takes the whole screen; the bars come back with the grid.
            .opacity(app.rackFocus == nil ? 1 : 0)
            .allowsHitTesting(app.rackFocus == nil)
            .animation(.easeInOut(duration: 0.6), value: app.rackFocus == nil)
        }
        .onChange(of: app.tab) { _, tab in if tab != .library, app.rackFocus != nil { app.closeFocus() } }
        .fullScreenCover(isPresented: $app.showPlayer) {
            PlayerScreen()
                .environment(app)
        }
        // BUN-3: the release experience, full screen over everything (NAT-1).
        .fullScreenCover(item: $app.hostRoute) { route in
            if let controller = app.hostController, controller.slug == route.slug {
                ReleaseHostView(controller: controller) { app.closeHost() }
                    .environment(app)
                    .presentationBackground(MSColor.ink)
            }
        }
    }

    @ViewBuilder
    private func destination(_ route: HUDRoute) -> some View {
        switch route {
        case .release(let slug): ReleaseScreen(slug: slug)
        case .leaderboard(let slug): LeaderboardScreen(slug: slug)
        }
    }

    /// `-screen` picks the first tab or page (screenshots). Applied once, after sign in.
    private func applyLaunchScreen() {
        guard !appliedLaunchScreen else { return }
        appliedLaunchScreen = true
        switch app.config.screen {
        case .listen: app.tab = .listen
        case .store, .storeLoading: app.tab = .store
        case .leaderboard:
            app.tab = .listen
            app.listenPath.append(HUDRoute.leaderboard("lit"))
        case .host:
            // `-screen host`: straight into the first copy's experience (screenshots, NAT checks).
            Task {
                await app.refresh()
                guard let release = app.ownedReleases.first else { return }
                app.openHost(slug: release.slug)
            }
        case .rackFocus, .rackFocusBack, .rackPull, .rackLoaded:
            // Screenshots of the rack's focus (`scripts/screenshots.sh rack-*`): lift LIT, then drive the page.
            app.tab = .library
            let screen = app.config.screen
            Task {
                await app.refresh()
                try? await Task.sleep(for: .seconds(0.6))
                withAnimation(MSMotion.standardLarge) { app.openFocus(slug: "lit") }
                #if DEBUG
                guard screen != .rackFocus, let controller = app.focusController else { return }
                for _ in 0..<40 where controller.phase != .ready { try? await Task.sleep(for: .seconds(0.25)) }
                try? await Task.sleep(for: .seconds(1.2))
                if screen == .rackFocusBack {
                    // Five flicks of the arrow key turn the sleeve round to its printed back (inspect.ts KEY_IMPULSE).
                    controller.debugEvaluate("""
                    for (let i = 0; i < 5; i++) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
                    """)
                } else {
                    controller.loadFromSleeve()
                }
                #endif
            }
        case .player:
            Task {
                await app.refresh()
                guard let release = app.featuredRelease, let tracks = try? await app.loadTracks(slug: release.slug) else { return }
                app.audio.load(release: release, tracks: tracks, startAt: 0, autoplay: false)
                app.showPlayer = true
            }
        default: app.tab = .library
        }
    }
}

/// LISTEN: the release in the deck, else the newest copy (RACK-1 until the stage bundle, RACK-4).
struct ListenTab: View {
    @Environment(AppModel.self) private var app

    var body: some View {
        if let release = app.featuredRelease {
            ReleaseScreen(slug: release.slug, showsBack: false)
        } else {
            switch app.library {
            case .loading:
                HUDPage(title: "Listen") { HUDStateMessage(kind: .loading, message: "Reading disc...") }
            case .failed(let message):
                HUDPage(title: "Listen") {
                    HUDStateMessage(kind: .error(retry: { Task { await app.refresh() } }), message: message)
                }
            case .loaded:
                HUDPage(title: "Listen") {
                    VStack(spacing: MSSpace.space24) {
                        LCDView(content: .noDisc).frame(maxWidth: 260)
                        Text("No releases yet. Copies you buy show up here.")
                            .font(MSFont.inter(16, weight: .regular))
                            .foregroundStyle(MSColor.muted)
                            .multilineTextAlignment(.center)
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.top, MSSpace.space36)
                    .padding(.horizontal, MSSpace.space24)
                }
            }
        }
    }
}

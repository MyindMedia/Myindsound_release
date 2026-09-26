import SwiftUI

/// Debug screen: every kit component in one scroll, for side by side checks against docs/app-v1/bar.
/// Launch with `-screen gallery`.
struct KitGallery: View {
    @State private var latched = "PLAY"
    @State private var current = 1
    @State private var sheet = false
    @State private var glitch = 0
    @State private var repeatOn = true

    var body: some View {
        ZStack {
            MSColor.ink.ignoresSafeArea()
            ScrollView {
                VStack(alignment: .leading, spacing: MSSpace.space24) {
                    HUDLargeTitle(title: "Kit", subtitle: "HUD components · DS-13 to DS-27")

                    block("DS-22 LCD") {
                        VStack(spacing: MSSpace.space10) {
                            LCDView(content: .playing(track: 3))
                            LCDView(content: .loading)
                            LCDView(content: LCDContent("REPEAT ON", repeat: true))
                        }
                    }

                    block("DS-13 Panel · DS-17 Readouts") {
                        HUDPanel("Deck · MD-01", meta: "Online") {
                            VStack(spacing: 0) {
                                ReadoutRow("Time", value: "0:00")
                                ReadoutRow("Track", value: "01/07")
                                ReadoutRow("RPM", value: "000")
                                ReadoutRow("Format", value: "MD · 44.1K")
                                ReadoutRow("Repeat", value: "ON", on: true)
                            }
                        }
                    }

                    block("DS-14 Primary · DS-15 Keys") {
                        VStack(alignment: .leading, spacing: MSSpace.space16) {
                            HStack { Spacer(); PrimaryButton("Insert Disc") {}; Spacer() }
                            HStack(spacing: 6) {
                                ForEach(["PLAY", "PAUSE", "STOP", "EJECT"], id: \.self) { key in
                                    KeyButton(key, latched: latched == key) { latched = key }
                                }
                            }
                            RepeatKey(on: repeatOn) { repeatOn.toggle() }
                        }
                    }

                    block("DS-16 Track rows") {
                        HUDPanel("LIT · Tracklist", meta: "Side A") {
                            VStack(spacing: 0) {
                                ForEach(LITSample.tracks.prefix(4)) { track in
                                    TrackRow(number: track.position, title: track.title, duration: track.duration, isCurrent: track.position == current, isPlaying: track.position == current) {
                                        current = track.position
                                    }
                                }
                            }
                        }
                    }

                    block("DS-18 Grouped list") {
                        HUDList("Account") {
                            HUDListRow("Downloads", subtitle: "7 tracks offline", systemImage: "arrow.down.to.line") {}
                            HUDListRow("Awards", subtitle: "Early buyer · NO 0007", systemImage: "seal") {}
                            HUDListRow<EmptyView>.destructive("Sign out") {}
                        }
                    }

                    block("DS-19 Sheet") {
                        KeyButton("Open tracklist sheet", fullWidth: true) { sheet = true }
                    }

                    block("DS-20 Tiles") {
                        HStack(spacing: 14) {
                            // Kit sample only: the store never shows made-up products (StoreScreen).
                            ForEach(["Sample tile A", "Sample tile B"], id: \.self) { name in
                                FloatingTile(action: {}) {
                                    ProductTileBody(name: name, price: "--", art: Image("MiniDiscShell"))
                                }
                            }
                        }
                    }

                    block("DS-27 Corner tick frame · DS-24 Glitch") {
                        CornerTickFramed {
                            VStack(spacing: MSSpace.space8) {
                                GlitchText(trigger: glitch) {
                                    Text("TRK \(String(format: "%02d", glitch % 7 + 1))/07")
                                        .font(MSFont.mono(14, weight: .semibold))
                                        .tracking(14 * MSFont.Tracking.monoDefaultEm)
                                        .foregroundStyle(MSColor.gold)
                                }
                                KeyButton("Next") { glitch += 1 }
                            }
                            .frame(maxWidth: .infinity)
                            .padding(MSSpace.space20)
                        }
                    }

                    block("DS-23 Boot loader") {
                        BootLoader(progress: 0.62, lines: Array(BootLoader.sampleLines.prefix(3)))
                            .frame(height: 220)
                            .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: 1))
                    }

                    block("DS-25 Now playing") {
                        NowPlayingBar(title: LITSample.nowPlayingTitle, tag: LITSample.nowPlayingTag, elapsed: LITSample.nowPlayingElapsed, duration: LITSample.nowPlayingDuration, progress: LITSample.nowPlayingProgress, isPlaying: true, onClose: {})
                    }

                    block("DS-26 Tab bar") {
                        HUDTabBar(selection: .constant(.library))
                            .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: 1))
                    }
                }
                .padding(.vertical, MSSpace.space16)
            }
            .scrollIndicators(.hidden)
        }
        .hudSheet(isPresented: $sheet, title: "Tracklist 01/07") {
            VStack(spacing: 0) {
                ForEach(LITSample.tracks) { track in
                    TrackRow(number: track.position, title: track.title, duration: track.duration, isCurrent: track.position == current, isPlaying: track.position == current) {
                        current = track.position
                        sheet = false
                    }
                }
            }
            .padding(.horizontal, MSSpace.space8)
            .padding(.top, MSSpace.space8)
        }
    }

    private func block<Content: View>(_ label: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            HUDSectionLabel(label)
            content().padding(.horizontal, MSSpace.space16)
        }
    }
}

/// `-screen lcd`: the display on its own, every status word and the app's own uses (DS-22).
struct LCDScreen: View {
    private let contents: [LCDContent] = [
        .playing(track: 1),
        .paused(track: 1),
        .stopped(track: 7),
        .spinUp(track: 3),
        LCDContent("REPEAT ON", repeat: true),
        .loading,
        .reading,
        .calibrating,
        .noDisc,
        .edition(7),
        .playsLeft(3),
        LCDContent("ABCDEFGHIJK"),
        LCDContent("LMNOPQRSTUV"),
        LCDContent("WXYZ 0123456789"),
    ]

    var body: some View {
        ZStack {
            MSColor.ink.ignoresSafeArea()
            ScrollView {
                VStack(spacing: MSSpace.space12) {
                    HUDSectionLabel("DS-22 · 14-segment LCD")
                    ForEach(Array(contents.enumerated()), id: \.offset) { _, content in
                        LCDView(content: content)
                    }
                }
                .padding(.horizontal, MSSpace.space16)
                .padding(.vertical, MSSpace.space24)
            }
        }
    }
}

#Preview("Gallery") {
    KitGallery().preferredColorScheme(.dark).tint(MSColor.gold)
}

import SwiftUI

/// LISTEN: the release detail (PRD 4A.9 "Release detail"): the release backdrop behind a HUD panel, the
/// sleeve, readouts for EDITION (LCD), TRACKS and STATUS, the tracklist panel, and one pulsing CTA
/// (DS-14), OPEN DECK, that opens the release's web experience (BUN-3). Tracklist rows still load the disc
/// into the native player.
struct ReleaseScreen: View {
    let slug: String
    var showsBack = true

    @Environment(AppModel.self) private var app
    @State private var tracks: Loadable<[Track]> = .loading

    private var release: LibraryRelease? { app.release(slug: slug) }
    private var context: ReleaseContext? { app.contexts[slug] }
    private var ownership: Ownership { context?.ownership ?? release.map { $0.ownership == .upcoming ? .locked : $0.ownership } ?? .preview }
    private var isInDeck: Bool { app.audio.loaded?.release.slug == slug }

    var body: some View {
        HUDPage(title: release?.title ?? context?.title ?? slug.uppercased(), subtitle: subtitle, showsBack: showsBack) {
            HUDSection {
                VStack(spacing: MSSpace.space20) {
                    ReleaseSleeve(slug: slug, size: 232)
                        .frame(maxWidth: .infinity)
                        .padding(.top, MSSpace.space4)
                    readouts
                    cta
                }
            }

            HUDSection("Tracklist") {
                tracklist
            }

            HUDSection {
                NavigationLink(value: HUDRoute.leaderboard(slug)) {
                    HStack(spacing: MSSpace.space10) {
                        Image(systemName: "list.number")
                            .font(.system(size: 14, weight: .bold))
                        Text("LEADERBOARD")
                            .font(HUDType.repeatButton)
                            .tracking(HUDType.repeatButtonTracking)
                        Spacer()
                        HUDChevron().frame(width: 8, height: 12)
                    }
                    .foregroundStyle(MSColor.muted)
                    .padding(.horizontal, HUDSurface.keyButtonPaddingH)
                    .frame(minHeight: MSComponent.KeyButton.minHeight)
                    .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
                    .contentShape(Rectangle())
                }
                .buttonStyle(HUDPressStyle())
            }
        }
        .task(id: slug) { await load() }
    }

    private var subtitle: String {
        [release?.artist, release?.year].compactMap { $0 }.joined(separator: " · ").nilIfEmpty ?? "Myind Sound"
    }

    // MARK: Readouts (DS-17)

    private var readouts: some View {
        HUDPanel("\(release?.title ?? slug.uppercased()) · Release", meta: tracksMeta) {
            VStack(spacing: 0) {
                ReadoutRow("Edition") {
                    if let edition = context?.editionNumber ?? release?.editionNumber {
                        LCDView.inset(.edition(edition))
                    } else {
                        ReadoutValue(ownership == .locked ? "SEALED" : "--")
                    }
                }
                ReadoutRow("Tracks", value: tracks.value.map { String(format: "%02d", $0.count) } ?? "--")
                ReadoutRow("Status", value: ownership.readout, on: isInDeck && app.audio.isPlaying)
            }
        }
    }

    private var tracksMeta: String {
        guard let list = tracks.value else { return "Loading" }
        let total = list.reduce(0) { $0 + $1.durationSeconds }
        return "\(String(format: "%02d", list.count)) TRK · \(Track.clock(total))"
    }

    // MARK: CTA (DS-14: one pulsing button per screen)

    @ViewBuilder
    private var cta: some View {
        switch ownership {
        case .owned, .lent:
            // BUN-3: the release's own experience (the unwrap on a new copy, RACK-3, then the deck).
            PrimaryButton("Open Deck") { app.openHost(slug: slug) }
        case .locked:
            PrimaryButton("Sealed", pulsing: false) {}
                .disabled(true)
                .opacity(0.6)
        case .preview, .upcoming:
            // PAY-*: purchase in the app is StoreKit (wave 2); the web checkout is where copies are sold today.
            PrimaryButton("Get Lit") { UIApplication.shared.open(URL(string: "https://stream.myindsound.com")!) }
        }
    }

    // MARK: Tracklist (DS-16)

    @ViewBuilder
    private var tracklist: some View {
        switch tracks {
        case .loading:
            HUDStateMessage(kind: .loading, message: "Reading disc...")
        case .failed(let message):
            HUDStateMessage(kind: .error(retry: { Task { await load() } }), message: message)
        case .loaded(let list):
            HUDPanel("\(release?.title ?? slug.uppercased()) · Tracklist", meta: ownership.canPlayFullTracks ? "Full album" : "30s previews") {
                VStack(spacing: 0) {
                    ForEach(Array(list.enumerated()), id: \.element.id) { index, track in
                        TrackRow(
                            number: track.position,
                            title: track.title,
                            duration: track.durationText,
                            isCurrent: isInDeck && app.audio.index == index,
                            isPlaying: isInDeck && app.audio.index == index && app.audio.isPlaying
                        ) {
                            insert(at: index)
                        }
                        .disabled(!ownership.canPlayFullTracks)
                    }
                    if ownership.canPlayFullTracks {
                        RepeatKey(on: app.audio.repeatOn) { app.audio.repeatOn.toggle() }
                            .padding(.top, MSSpace.space10)
                    }
                }
            }
        }
    }

    // MARK: Actions

    private func load() async {
        if context == nil { await app.loadContext(slug: slug) }
        do {
            tracks = .loaded(try await app.loadTracks(slug: slug))
        } catch {
            tracks = .failed(AppModel.message(error))
        }
    }

    private func insert(at index: Int) {
        guard let list = tracks.value, let release = release ?? app.featuredRelease else { return }
        if isInDeck {
            app.audio.select(trackAt: index)
        } else {
            app.audio.load(release: release, tracks: list, startAt: index, lendId: context?.lend?.lendId)
        }
        app.showPlayer = true
    }
}

extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}

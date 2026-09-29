import SwiftUI

/// RACK-4: everything about one copy, per disc (it used to sit in a shared Offline list under the rack). A long press
/// on a rack tile opens the menu (`DiscMenu`); DETAILS, and the focus view's info key, open the sheet
/// (`DiscDetailsSheet`): the copy's readouts, the tracklist, the credits, its offline save and sharing.

/// The long-press menu on a rack tile.
struct DiscMenu: View {
    let release: LibraryRelease
    let onDetails: () -> Void

    @Environment(AppModel.self) private var app

    private var locked: Bool { RackTileState(release: release, context: app.contexts[release.slug]).isLocked }

    var body: some View {
        Button(action: onDetails) { Label("Details & credits", systemImage: "info.circle") }
        if DownloadManager.canDownload(release) && !locked {
            DiscOffline.menuButton(release: release, app: app)
        }
        DiscShare.link(release: release, app: app)
        Button {
            app.libraryPath.append(HUDRoute.release(release.slug))
        } label: {
            Label("Release page", systemImage: "opticaldisc")
        }
    }
}

/// Saving one copy for offline (AUD-3: owners only, never lent copies), from the menu or the sheet.
enum DiscOffline {
    @MainActor
    static func menuButton(release: LibraryRelease, app: AppModel) -> some View {
        let (title, icon) = menuTitle(app.downloads.state(for: release.slug))
        return Button { toggle(release, app: app) } label: { Label(title, systemImage: icon) }
    }

    static func menuTitle(_ state: DownloadManager.State) -> (String, String) {
        switch state {
        case .downloading(let fraction): return ("Cancel download (\(Int((fraction * 100).rounded()))%)", "xmark.circle")
        case .downloaded, .needsCheck: return ("Remove offline copy", "trash")
        case .none, .failed: return ("Save for offline", "arrow.down.circle")
        }
    }

    @MainActor
    static func toggle(_ release: LibraryRelease, app: AppModel) {
        Task {
            let tracks = (try? await app.loadTracks(slug: release.slug)) ?? []
            app.downloads.toggle(release, tracks: tracks)
        }
    }
}

/// Sharing a copy: the rendered sleeve still when it's loaded (else the site link), with the edition in the line.
enum DiscShare {
    static let site = URL(string: "https://stream.myindsound.com")!

    static func message(release: LibraryRelease, edition: Int?) -> String {
        var line = release.title.uppercased()
        if let artist = release.artist, !artist.isEmpty { line += " by \(artist)" }
        if let edition {
            line += ", my copy is NO \(String(format: "%04d", edition))"
        }
        return line + " on Myind Sound. \(site.absoluteString)"
    }

    @MainActor @ViewBuilder
    static func link(release: LibraryRelease, app: AppModel, label: String = "Share") -> some View {
        let edition = release.editionNumber ?? app.contexts[release.slug]?.editionNumber
        let text = message(release: release, edition: edition)
        if let render = app.rackRender(slug: release.slug), let still = RackStillLoader.cached(render) {
            let image = Image(decorative: still, scale: 1)
            ShareLink(item: image, subject: Text(release.title), message: Text(text), preview: SharePreview(release.title, image: image)) {
                Label(label, systemImage: "square.and.arrow.up")
            }
        } else {
            ShareLink(item: site, subject: Text(release.title), message: Text(text)) {
                Label(label, systemImage: "square.and.arrow.up")
            }
        }
    }
}

/// The details sheet: the copy, the tracklist, the credits, offline and sharing.
struct DiscDetailsSheet: View {
    let release: LibraryRelease

    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss
    @State private var tracks: [Track] = []
    @State private var tracksFailed = false

    private var context: ReleaseContext? { app.contexts[release.slug] }
    private var state: RackTileState { RackTileState(release: release, context: context) }
    private var edition: Int? { release.editionNumber ?? context?.editionNumber }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MSSpace.space20) {
                header
                copyPanel
                tracklist
                credits
                if DownloadManager.canDownload(release) && !state.isLocked {
                    HUDList("Offline", meta: "Encrypted on this device") {
                        DownloadRow(release: release)
                    }
                }
                HStack(spacing: MSSpace.space12) {
                    DiscShare.link(release: release, app: app, label: "Share copy")
                        .labelStyle(.titleOnly)
                        .font(MSFont.Style.keyButton)
                        .tracking(MSFont.Tracking.keyButton)
                        .textCase(.uppercase)
                        .foregroundStyle(MSColor.ink)
                        .padding(.horizontal, HUDSurface.keyButtonPaddingH)
                        .frame(minHeight: MSComponent.KeyButton.minHeight)
                        .background(MSColor.gold)
                    KeyButton("Release page") {
                        dismiss()
                        if app.rackFocus != nil { app.closeFocus() }
                        app.libraryPath.append(HUDRoute.release(release.slug))
                    }
                }
            }
            .padding(MSComponent.HUDPanel.paddingHorizontal)
        }
        .task {
            do { tracks = try await app.loadTracks(slug: release.slug) } catch { tracksFailed = true }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(release.title.uppercased())
                .font(MSFont.mono(20, weight: .semibold))
                .tracking(20 * 0.08)
                .foregroundStyle(MSColor.text)
            Text([release.artist, release.year].compactMap { $0 }.joined(separator: " · "))
                .font(HUDType.groupedSubtitle)
                .foregroundStyle(MSColor.muted)
        }
        .accessibilityElement(children: .combine)
    }

    private var copyPanel: some View {
        HUDPanel("Your copy", meta: state.isLocked ? "SEALED" : release.ownership.readout) {
            VStack(alignment: .leading, spacing: MSSpace.space14) {
                HStack(alignment: .top, spacing: MSSpace.space14) {
                    readout("Edition") {
                        if let edition { LCDView.inset(.edition(edition), width: 104) } else { ReadoutValue("PRESALE") }
                    }
                    readout("Plays") { ReadoutValue(DiscDetailsSheet.playTime(context?.wearInputs?.playSeconds)) }
                    readout("Wear") {
                        ReadoutValue(app.wearLevel(slug: release.slug).map { "\(Int(($0 * 100).rounded()))%" } ?? "--")
                    }
                }
                HStack(alignment: .top, spacing: MSSpace.space14) {
                    readout("In your rack since") { ReadoutValue(release.grantedAt.map(Self.day) ?? "--") }
                    if let loads = context?.wearInputs?.loads {
                        readout("Loads") { ReadoutValue("\(Int(loads))") }
                    }
                }
                let stickers = app.stickers(for: release)
                if !stickers.isEmpty {
                    HStack(spacing: MSSpace.space12) {
                        ForEach(stickers, id: \.self) { sticker in
                            HStack(spacing: 6) {
                                VinylSticker(sticker: sticker, diameter: 22)
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
        }
    }

    @ViewBuilder
    private var tracklist: some View {
        let count = tracks.isEmpty ? release.trackCount : tracks.count
        HUDPanel("Tracklist", meta: count.map { String(format: "%02d", $0) + " TRACKS" }) {
            if tracks.isEmpty {
                Text(tracksFailed ? "The tracklist shows once you're online." : "Loading...")
                    .font(HUDType.groupedSubtitle)
                    .foregroundStyle(MSColor.muted)
            } else {
                VStack(spacing: 10) {
                    ForEach(tracks) { track in
                        HStack(spacing: HUDSurface.trackRowGap) {
                            Text(String(format: "%02d", track.position))
                                .font(HUDType.trackNumber)
                                .monospacedDigit()
                                .foregroundStyle(MSColor.muted)
                                .frame(width: HUDSurface.trackNumberWidth, alignment: .leading)
                            Text(track.title)
                                .font(HUDType.trackTitle)
                                .foregroundStyle(MSColor.text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            Text(track.durationText)
                                .font(MSFont.mono(12, weight: .medium))
                                .monospacedDigit()
                                .foregroundStyle(MSColor.muted)
                        }
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }

    /// The liner notes: the release's credits when it has them, always the artist and the label.
    private var credits: some View {
        HUDPanel("Credits") {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(creditLines, id: \.self) { credit in
                    HStack(alignment: .firstTextBaseline) {
                        Text(credit.role.uppercased())
                            .font(MSFont.mono(10, weight: .semibold))
                            .tracking(10 * 0.12)
                            .foregroundStyle(MSColor.muted)
                            .frame(width: 118, alignment: .leading)
                        Text(credit.name)
                            .font(HUDType.groupedSubtitle)
                            .foregroundStyle(MSColor.text)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private var creditLines: [ReleaseCredit] {
        var lines: [ReleaseCredit] = []
        if let artist = release.artist, !artist.isEmpty { lines.append(ReleaseCredit(role: "Artist", name: artist)) }
        lines += release.credits
        if let year = release.year { lines.append(ReleaseCredit(role: "Released", name: year)) }
        lines.append(ReleaseCredit(role: "Label", name: "Myind Sound"))
        return lines
    }

    private func readout<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HUDLabel(label)
            value()
        }
        .accessibilityElement(children: .combine)
    }

    /// Total time heard on a copy (`wearInputs.stats.playSeconds`).
    static func playTime(_ seconds: Double?) -> String {
        guard let seconds else { return "--" }
        let minutes = Int(seconds / 60)
        return minutes >= 60 ? "\(minutes / 60)H \(String(format: "%02d", minutes % 60))M" : "\(minutes)M"
    }

    private static func day(_ date: Date) -> String {
        date.formatted(.dateTime.day().month(.abbreviated).year()).uppercased()
    }
}

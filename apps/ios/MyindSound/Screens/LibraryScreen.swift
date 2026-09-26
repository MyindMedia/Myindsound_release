import SwiftUI

/// Pages the shell can push (inside the LISTEN and LIBRARY stacks).
enum HUDRoute: Hashable {
    case release(String)
    case leaderboard(String)
}

/// LIBRARY (PRD 4A.9, RACK-1, DS-12, DS-18): the large title with the greeting, then the rack: the fan's
/// MiniDiscs in their sleeves as the page's main content (owned and borrowed copies, and upcoming releases sealed
/// with their drop countdown). A tap lifts a disc into the focus view (RACK-2), which carries the per-copy
/// readouts. Offline saves, awards and the account sit in compact sections well below the rack.
struct LibraryScreen: View {
    @Environment(AppModel.self) private var app
    @State private var privacySheet = false
    @Namespace private var rack

    var body: some View {
        ZStack {
            HUDPage(title: "Library", subtitle: greeting) {
                switch app.library {
                case .loading:
                    HUDStateMessage(kind: .loading, message: "Loading your library...")
                case .failed(let message):
                    HUDStateMessage(kind: .error(retry: { Task { await app.refresh() } }), message: message)
                case .loaded(let snapshot):
                    content(snapshot)
                }
            }
            .refreshable { await app.refresh() }
            .accessibilityHidden(app.rackFocus != nil)

            if let focus = app.rackFocus, let release = app.release(slug: focus.slug) {
                RackFocusView(focus: focus, release: release, controller: app.focusController, namespace: rack)
                    .transition(.opacity)
                    .zIndex(10)
            }
        }
        .hudSheet(isPresented: $privacySheet, title: "Your data") {
            PrivacySheet()
        }
    }

    private var greeting: String {
        if let name = app.auth.profile?.firstName, !name.isEmpty { return "Welcome back, \(name)" }
        return "Welcome back"
    }

    @ViewBuilder
    private func content(_ snapshot: LibrarySnapshot) -> some View {
        let discs = snapshot.releases + snapshot.upcoming
        HUDSection {
            if discs.isEmpty {
                RackEmpty()
            } else {
                RackGrid(releases: discs, namespace: rack)
                    .padding(.top, MSSpace.space8)
            }
        }
        .padding(.bottom, MSSpace.space16)

        let owned = snapshot.releases.filter(DownloadManager.canDownload)
        if !owned.isEmpty {
            HUDSection("Offline") {
                HUDList(meta: "Encrypted on this device") {
                    ForEach(owned) { release in
                        DownloadRow(release: release)
                    }
                }
            }
        }

        HUDSection("Awards") {
            HUDList {
                HUDListRow("Collector tier", subtitle: tierLine, systemImage: "rosette") {}
                ForEach(app.awards.placements) { placement in
                    HUDListRow(
                        "\(placement.title) · Early buyer",
                        subtitle: "Edition NO \(String(format: "%04d", placement.editionNumber)) · rank \(placement.rank)",
                        systemImage: "seal"
                    ) {}
                }
            }
        }

        HUDSection("Account") {
            HUDList {
                HUDListRow("Your data", subtitle: "Export or delete your data", systemImage: "lock") {
                    privacySheet = true
                }
                HUDListRow<EmptyView>.destructive("Sign out") {
                    Task { await app.signOut() }
                }
            }
        }
    }

    /// LB-4 tiers, from `leaderboard.myAwards`.
    private var tierLine: String {
        let awards = app.awards
        let current = awards.tier.map { "\($0.uppercased()) · " } ?? ""
        if let next = awards.nextTier, let needs = awards.nextTierNeeds {
            return "\(current)\(awards.topPlacements) top placements · \(needs) more for \(next.uppercased())"
        }
        return "\(current)\(awards.topPlacements) top placements"
    }
}

/// The release sleeve (bundled for LIT), framed with corner ticks (DS-27), floating on the ink (DS-20).
struct ReleaseSleeve: View {
    let slug: String
    var size: CGFloat

    @Environment(AppModel.self) private var app

    var body: some View {
        Group {
            if let name = ReleaseArt.imageName(for: slug) {
                Image(name).resizable().scaledToFill()
            } else if let url = app.coverArtURL(slug: slug) {
                CoverArtImage(url: url)
            } else {
                ZStack {
                    MSColor.base
                    LCDView(content: .noDisc).padding(6)
                }
            }
        }
        .frame(width: size, height: size)
        .clipped()
        .overlay(Rectangle().strokeBorder(MSColor.lineDim, lineWidth: MSShape.hairlineWidth))
        .hudCornerTicks(corners: [.topLeading, .bottomTrailing], size: 10, stroke: 1, color: MSColor.line)
        .hudGlow(HUDGlow.float)
        .accessibilityHidden(true)
    }
}

extension LCDView {
    /// DS-22 inline in a readout row: small, as a recessed window (the deck's LCD sits in a recess).
    static func inset(_ content: LCDContent, width: CGFloat = 112) -> some View {
        LCDView(content: content)
            .frame(width: width)
            .overlay(Rectangle().strokeBorder(Color.black.opacity(0.6), lineWidth: 1))
            .padding(.vertical, 3)
    }
}

/// Privacy (NFR-2): export as a JSON file through the share sheet, or delete the account after typing
/// DELETE, both through the existing `privacy.exportMyData` / `privacy.deleteMyData`.
struct PrivacySheet: View {
    @Environment(AppModel.self) private var app
    @State private var exportURL: URL?
    @State private var busy = false
    @State private var message: String?
    @State private var confirmText = ""

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: MSSpace.space20) {
                VStack(alignment: .leading, spacing: MSSpace.space10) {
                    HUDLabel("Export", color: MSColor.gold)
                    Text("A copy of your purchases, plays and settings as a JSON file.")
                        .font(HUDType.groupedSubtitle)
                        .foregroundStyle(MSColor.muted)
                    if let exportURL {
                        ShareLink(item: exportURL) {
                            Text("SHARE FILE")
                                .font(MSFont.Style.keyButton)
                                .tracking(MSFont.Tracking.keyButton)
                                .foregroundStyle(MSColor.ink)
                                .padding(.horizontal, HUDSurface.keyButtonPaddingH)
                                .frame(minHeight: MSComponent.KeyButton.minHeight)
                                .background(MSColor.gold)
                        }
                    } else {
                        KeyButton(busy ? "Preparing..." : "Export my data") { Task { await export() } }
                            .disabled(busy)
                    }
                }
                DashedDivider()
                VStack(alignment: .leading, spacing: MSSpace.space10) {
                    HUDLabel("Delete", color: MSColor.destructive)
                    Text("Deletes your account and play history. Your edition numbers stay reserved as retired.")
                        .font(HUDType.groupedSubtitle)
                        .foregroundStyle(MSColor.muted)
                    TextField("", text: $confirmText, prompt: Text("Type DELETE").foregroundStyle(MSColor.muted))
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .hudField()
                    KeyButton("Delete my account") { Task { await delete() } }
                        .disabled(confirmText != "DELETE" || busy)
                        .opacity(confirmText == "DELETE" ? 1 : 0.5)
                }
                if let message {
                    Text(message).font(HUDType.groupedSubtitle).foregroundStyle(MSColor.destructive)
                }
            }
            .padding(MSComponent.HUDPanel.paddingHorizontal)
        }
    }

    private func export() async {
        busy = true
        defer { busy = false }
        do {
            let data = try await app.api.exportMyData()
            let url = FileManager.default.temporaryDirectory.appendingPathComponent("myind-sound-my-data.json")
            try data.write(to: url, options: [.atomic, .completeFileProtection])
            exportURL = url
        } catch {
            message = AppModel.message(error)
        }
    }

    private func delete() async {
        busy = true
        defer { busy = false }
        do {
            try await app.api.deleteMyData()
            await app.signOut()
        } catch {
            message = AppModel.message(error)
        }
    }
}

/// AUD-3 UI: one release's offline copy, as a HUD row with a latching SAVE key (DS-15) and a gold progress
/// line while it downloads. Owners only (never lent copies).
struct DownloadRow: View {
    let release: LibraryRelease
    @Environment(AppModel.self) private var app

    private var state: DownloadManager.State { app.downloads.state(for: release.slug) }

    var body: some View {
        HStack(spacing: HUDSurface.groupedRowGap) {
            Image(systemName: icon)
                .font(.system(size: HUDSurface.groupedIconSize, weight: .medium))
                .foregroundStyle(MSColor.gold)
                .frame(width: HUDSurface.groupedIconTile, height: HUDSurface.groupedIconTile)
                .background(MSColor.gold.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: HUDSurface.groupedIconTileRadius, style: .continuous))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(release.title)
                    .font(HUDType.groupedTitle)
                    .tracking(HUDType.groupedTitleTracking)
                    .foregroundStyle(MSColor.text)
                Text(subtitle)
                    .font(HUDType.groupedSubtitle)
                    .foregroundStyle(isProblem ? MSColor.destructive : MSColor.muted)
                    .monospacedDigit()
                if case .downloading(let fraction) = state {
                    GeometryReader { proxy in
                        ZStack(alignment: .leading) {
                            Rectangle().fill(MSColor.lineDim)
                            Rectangle().fill(MSColor.gold).frame(width: proxy.size.width * fraction)
                        }
                    }
                    .frame(height: 2)
                    .animation(.linear(duration: 0.2), value: fraction)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            KeyButton(keyTitle, latched: isOn) { toggle() }
        }
        .padding(.vertical, HUDSurface.groupedRowPaddingV)
        .padding(.horizontal, HUDSurface.groupedRowPaddingH)
        .frame(minHeight: MSComponent.ListRow.minHeight)
        .accessibilityElement(children: .combine)
    }

    private var isOn: Bool {
        switch state {
        case .downloaded, .needsCheck, .downloading: return true
        case .none, .failed: return false
        }
    }

    private var isProblem: Bool {
        switch state {
        case .needsCheck, .failed: return true
        default: return false
        }
    }

    private var icon: String {
        switch state {
        case .downloaded: return "checkmark"
        case .needsCheck: return "exclamationmark.arrow.circlepath"
        default: return "arrow.down.to.line"
        }
    }

    private var keyTitle: String {
        switch state {
        case .downloading: return "Cancel"
        case .downloaded, .needsCheck: return "Saved"
        case .none, .failed: return "Save"
        }
    }

    private var subtitle: String {
        switch state {
        case .none: return "Save for offline"
        case .downloading(let fraction): return "Downloading \(Int((fraction * 100).rounded()))%"
        case .downloaded:
            let bytes = app.downloads.record(for: release.slug)?.bytes ?? 0
            let size = ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
            return "Offline · \(app.downloads.record(for: release.slug)?.tracks.count ?? 0) tracks · \(size)"
        case .needsCheck: return "Go online to keep listening offline"
        case .failed(let message): return message
        }
    }

    private func toggle() {
        Task {
            let tracks = (try? await app.loadTracks(slug: release.slug)) ?? []
            app.downloads.toggle(release, tracks: tracks)
        }
    }
}

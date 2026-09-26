import SwiftUI

/// LB-1..3 (PRD 4A.9 Leaderboard): the first editions of a release in the DS-16 row pattern, edition
/// numbers on the LCD, award tiers in corner tick badges (DS-27), the fan's own row highlighted like the
/// current track. TOP 20 / TOP 100 as latching keys (DS-15). Refreshes every 30 s while open (LB-3's
/// "polling" option until the live subscription is wired).
struct LeaderboardScreen: View {
    let slug: String
    var showsBack = true

    @Environment(AppModel.self) private var app
    @State private var board: Loadable<Leaderboard> = .loading
    @State private var limit = 20

    var body: some View {
        HUDPage(title: "Leaderboard", subtitle: subtitle, showsBack: showsBack) {
            HUDSection {
                HStack(spacing: 6) {
                    KeyButton("Top 20", latched: limit == 20, fullWidth: true) { limit = 20 }
                    KeyButton("Top 100", latched: limit == 100, fullWidth: true) { limit = 100 }
                }
            }
            HUDSection {
                switch board {
                case .loading:
                    HUDStateMessage(kind: .loading, message: "Reading editions...")
                case .failed(let message):
                    HUDStateMessage(kind: .error(retry: { Task { await load() } }), message: message)
                case .loaded(let board):
                    panel(board)
                }
            }
        }
        .task(id: limit) {
            while !Task.isCancelled {
                await load()
                try? await Task.sleep(for: .seconds(30))
            }
        }
    }

    private var subtitle: String {
        let title = board.value?.title ?? app.release(slug: slug)?.title ?? slug.uppercased()
        return "\(title) · first \(board.value?.size ?? 100) editions"
    }

    private func panel(_ board: Leaderboard) -> some View {
        HUDPanel("\(board.title) · Editions", meta: "\(board.entries.count)/\(board.size)") {
            if board.entries.isEmpty {
                VStack(spacing: MSSpace.space12) {
                    LCDView(content: LCDContent("NO EDITIONS")).frame(width: 200)
                    Text("No numbered copies yet.")
                        .font(HUDType.groupedSubtitle)
                        .foregroundStyle(MSColor.muted)
                }
                .frame(maxWidth: .infinity)
            } else {
                VStack(spacing: 0) {
                    ForEach(board.entries) { entry in
                        LeaderboardRow(entry: entry)
                    }
                }
            }
        }
    }

    private func load() async {
        do {
            board = .loaded(try await app.api.leaderboard(slug: slug, limit: limit))
        } catch {
            if board.value == nil { board = .failed(AppModel.message(error)) }
        }
    }
}

/// DS-16 for the leaderboard: mono rank, the edition on a small LCD, the public name (never an email), and
/// the tier badge. The fan's own row gets the current track treatment.
struct LeaderboardRow: View {
    let entry: LeaderboardEntry

    var body: some View {
        HStack(spacing: HUDSurface.trackRowGap) {
            Text(String(format: "%02d", entry.rank))
                .font(HUDType.trackNumber)
                .tracking(HUDType.trackNumberTracking)
                .monospacedDigit()
                .foregroundStyle(entry.isYou ? MSColor.gold : MSColor.muted)
                .frame(width: HUDSurface.trackNumberWidth, alignment: .leading)
            LCDView.inset(.edition(entry.editionNumber), width: 96)
            Text(entry.isYou ? "\(entry.displayName) · You" : entry.displayName)
                .font(HUDType.trackTitle)
                .foregroundStyle(entry.isYou ? MSColor.gold : (entry.retired || entry.anonymous ? MSColor.muted : MSColor.text))
                .hudGlow(entry.isYou ? HUDGlow.trackTitle : HUDGlow.none)
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let tier = entry.awardTier {
                AwardBadge(tier: tier)
            }
        }
        .padding(.vertical, HUDSurface.trackRowPaddingV)
        .padding(.horizontal, HUDSurface.trackRowPaddingH)
        .frame(minHeight: MSComponent.ListRow.minHeight)
        .background {
            if entry.isYou {
                RoundedRectangle(cornerRadius: HUDSurface.trackRowRadius).fill(HUDSurface.currentRowGradient)
            }
        }
        .overlay {
            if entry.isYou {
                LeadingBorderShape(radius: HUDSurface.trackRowRadius, width: MSComponent.ListRow.currentLeadingBorderWidth)
                    .fill(MSColor.gold, style: FillStyle(eoFill: true))
                    // Only the leading curve: the trailing edges of the two shapes cancel exactly in theory,
                    // but antialiasing leaves hairline specks there.
                    .mask(alignment: .leading) {
                        Rectangle().frame(width: HUDSurface.trackRowRadius + MSComponent.ListRow.currentLeadingBorderWidth)
                    }
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Rank \(entry.rank), edition \(entry.editionNumber), \(entry.displayName)\(entry.awardTier.map { ", \($0) award" } ?? "")")
        .accessibilityAddTraits(entry.isYou ? .isSelected : [])
    }
}

/// An award tier in a corner tick frame (DS-27): mono 10, uppercase.
struct AwardBadge: View {
    let tier: String

    var body: some View {
        CornerTickFramed(corners: [.topLeading, .bottomTrailing], tickColor: MSColor.gold, borderColor: MSColor.lineDim) {
            Text(tier.uppercased())
                .font(HUDType.panelMeta)
                .tracking(HUDType.panelMetaTracking * 1.6)
                .foregroundStyle(tier.lowercased() == "gold" ? MSColor.gold : MSColor.text)
                .padding(.horizontal, 6)
                .padding(.vertical, 3)
        }
        .accessibilityHidden(true)
    }
}

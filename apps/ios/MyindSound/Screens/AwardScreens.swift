import SwiftUI

/// LB-4 in detail, from the Library's Awards rows: the collector tier (the ladder, how far to the next tier, the
/// releases that count) and one early-buyer placement (the copy, its rank, the stickers it earned and why).

/// The collector tier: BRONZE, SILVER, GOLD by how many releases the fan placed on (`leaderboard.myAwards`).
struct CollectorTierScreen: View {
    @Environment(AppModel.self) private var app

    private var awards: AwardsSummary { app.awards }
    private var tier: String? { awards.tier?.lowercased() }

    var body: some View {
        HUDPage(title: "Collector tier", subtitle: subtitle, showsBack: true) {
            HUDSection {
                hero
            }
            HUDSection("Tiers") {
                HUDPanel("The ladder", meta: "\(awards.topPlacements) PLACED") {
                    VStack(spacing: MSSpace.space12) {
                        ForEach(RackRules.tiers, id: \.tier) { step in
                            ladderRow(step.tier, needs: step.minPlacements)
                        }
                    }
                }
            }
            HUDSection("How it counts") {
                HUDPanel {
                    Text("A release counts when your own copy's edition number is inside its leaderboard (the first \(RackRules.defaultLeaderboardSize) editions unless the release sets another size). Borrowed copies never count.")
                        .font(HUDType.groupedSubtitle)
                        .foregroundStyle(MSColor.muted)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            HUDSection("Releases that count") {
                if awards.placements.isEmpty {
                    HUDPanel {
                        Text("None yet. Get an early edition of a new drop to place on its leaderboard.")
                            .font(HUDType.groupedSubtitle)
                            .foregroundStyle(MSColor.muted)
                    }
                } else {
                    HUDList {
                        ForEach(awards.placements) { placement in
                            HUDListRow(
                                "\(placement.title) · Early buyer",
                                subtitle: "Edition NO \(String(format: "%04d", placement.editionNumber)) · rank \(placement.rank)",
                                systemImage: "seal"
                            ) {
                                app.libraryPath.append(HUDRoute.placement(placement.slug))
                            }
                        }
                    }
                }
            }
        }
    }

    private var subtitle: String {
        (tier?.uppercased() ?? "No tier yet") + " · \(awards.topPlacements) top placements"
    }

    private var hero: some View {
        HStack(spacing: MSSpace.space16) {
            if let tier {
                VinylSticker(sticker: .tier(tier), diameter: 84)
            } else {
                Circle().strokeBorder(MSColor.lineDim, style: StrokeStyle(lineWidth: 1.5, dash: [4, 4]))
                    .frame(width: 84, height: 84)
            }
            VStack(alignment: .leading, spacing: 8) {
                HUDLabel("Current tier")
                Text(tier?.uppercased() ?? "NONE")
                    .font(MSFont.mono(22, weight: .semibold))
                    .tracking(22 * 0.1)
                    .foregroundStyle(tier == "gold" ? MSColor.gold : MSColor.text)
                if let next = awards.nextTier, let needs = awards.nextTierNeeds {
                    Text("\(needs) more for \(next.uppercased())")
                        .font(HUDType.groupedSubtitle)
                        .foregroundStyle(MSColor.muted)
                    progress(toward: next)
                } else if tier == "gold" {
                    Text("Top tier reached")
                        .font(HUDType.groupedSubtitle)
                        .foregroundStyle(MSColor.gold)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, MSSpace.space8)
        .accessibilityElement(children: .combine)
    }

    /// Placements so far against the next tier's threshold.
    private func progress(toward next: String) -> some View {
        let goal = RackRules.tiers.first { $0.tier == next }?.minPlacements ?? max(1, awards.topPlacements)
        let fraction = min(1, Double(awards.topPlacements) / Double(max(1, goal)))
        return GeometryReader { proxy in
            ZStack(alignment: .leading) {
                Rectangle().fill(MSColor.lineDim)
                Rectangle().fill(MSColor.gold).frame(width: proxy.size.width * fraction)
            }
        }
        .frame(height: 3)
    }

    private func ladderRow(_ step: String, needs: Int) -> some View {
        let reached = awards.topPlacements >= needs
        let current = tier == step
        return HStack(spacing: MSSpace.space12) {
            VinylSticker(sticker: .tier(step), diameter: 30)
                .opacity(reached ? 1 : 0.35)
            Text(step.uppercased())
                .font(MSFont.mono(13, weight: .semibold))
                .tracking(13 * 0.12)
                .foregroundStyle(current ? MSColor.gold : (reached ? MSColor.text : MSColor.muted))
            Spacer()
            Text("\(needs) RELEASES")
                .font(MSFont.mono(11, weight: .medium))
                .tracking(11 * 0.1)
                .foregroundStyle(MSColor.muted)
            Image(systemName: reached ? "checkmark" : "lock")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(reached ? MSColor.gold : MSColor.muted)
                .frame(width: 16)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(step.capitalized): \(needs) releases, \(reached ? "reached" : "not reached")\(current ? ", your tier" : "")")
    }
}

/// One early-buyer placement: the copy's sleeve, its edition and rank inside the release's leaderboard, the
/// stickers it earned, and the way to the full leaderboard.
struct PlacementScreen: View {
    let slug: String

    @Environment(AppModel.self) private var app

    private var placement: AwardsSummary.Placement? { app.awards.placements.first { $0.slug == slug } }
    private var release: LibraryRelease? { app.release(slug: slug) }
    private var size: Int { release?.leaderboardSize ?? RackRules.defaultLeaderboardSize }
    private var title: String { placement?.title ?? release?.title ?? slug.uppercased() }

    var body: some View {
        HUDPage(title: "Early buyer", subtitle: title, showsBack: true) {
            if let placement {
                HUDSection {
                    sleeve.padding(.top, MSSpace.space8)
                }
                HUDSection {
                    HUDPanel("\(title.uppercased()) · PLACEMENT", meta: "FIRST \(size)") {
                        HStack(alignment: .top, spacing: MSSpace.space14) {
                            readout("Edition") { LCDView.inset(.edition(placement.editionNumber), width: 104) }
                            readout("Rank") { ReadoutValue("\(placement.rank) / \(size)", on: true) }
                            readout("Top") { ReadoutValue("\(max(1, Int((Double(placement.rank) / Double(max(1, size)) * 100).rounded())))%") }
                        }
                    }
                }
                HUDSection("Stickers earned") {
                    HUDPanel {
                        VStack(alignment: .leading, spacing: MSSpace.space14) {
                            ForEach(stickers, id: \.self) { sticker in
                                HStack(spacing: MSSpace.space12) {
                                    VinylSticker(sticker: sticker, diameter: 34)
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(sticker.title)
                                            .font(MSFont.mono(12, weight: .semibold))
                                            .tracking(12 * 0.12)
                                            .foregroundStyle(MSColor.text)
                                        Text(explanation(sticker))
                                            .font(HUDType.groupedSubtitle)
                                            .foregroundStyle(MSColor.muted)
                                            .fixedSize(horizontal: false, vertical: true)
                                    }
                                }
                                .accessibilityElement(children: .combine)
                            }
                        }
                    }
                }
                HUDSection {
                    HStack(spacing: MSSpace.space12) {
                        ShareLink(item: DiscShare.site, message: Text(shareLine(placement))) {
                            Text("SHARE AWARD")
                                .font(MSFont.Style.keyButton)
                                .tracking(MSFont.Tracking.keyButton)
                                .foregroundStyle(MSColor.ink)
                                .padding(.horizontal, HUDSurface.keyButtonPaddingH)
                                .frame(minHeight: MSComponent.KeyButton.minHeight)
                                .background(MSColor.gold)
                        }
                        KeyButton("Leaderboard") { app.libraryPath.append(HUDRoute.leaderboard(slug)) }
                    }
                }
            } else {
                HUDSection {
                    HUDStateMessage(kind: .empty, message: "This placement isn't on your account any more.")
                }
            }
        }
    }

    @ViewBuilder
    private var sleeve: some View {
        if let release {
            RackSleeve(release: release, state: RackTileState(release: release, context: app.contexts[slug]))
                .frame(width: 220, height: 220)
                .frame(maxWidth: .infinity)
                .accessibilityHidden(true)
        }
    }

    private var stickers: [RackSticker] {
        guard let placement else { return [] }
        return RackRules.stickers(edition: placement.editionNumber, leaderboardSize: size, tier: app.awards.tier, countsTowardTier: true)
    }

    private func explanation(_ sticker: RackSticker) -> String {
        switch sticker {
        case .top20: return "Your copy is one of the first \(RackRules.top20) editions."
        case .first100: return "Your copy is inside the first \(size) editions, so it's on the leaderboard."
        case .tier(let tier): return "This release counts toward your \(tier.uppercased()) collector tier."
        }
    }

    private func shareLine(_ placement: AwardsSummary.Placement) -> String {
        title.uppercased()
            + ": early buyer, edition NO \(String(format: "%04d", placement.editionNumber)), rank \(placement.rank) of the first \(size) on Myind Sound."
    }

    private func readout<Value: View>(_ label: String, @ViewBuilder value: () -> Value) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HUDLabel(label)
            value()
        }
        .accessibilityElement(children: .combine)
    }
}

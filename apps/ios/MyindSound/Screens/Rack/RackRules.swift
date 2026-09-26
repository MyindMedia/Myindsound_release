import Foundation

// The rack's pure rules (RACK-1, LB-1, LB-4, DROP-1): which stickers a copy carries, where they sit, what a
// tile's state is, and how the drop countdown reads. No SwiftUI here, so `RackTests` covers all of it.

/// A die-cut vinyl sticker on a sleeve: an early buyer badge (LB-1) or the collector tier (LB-4).
enum RackSticker: Equatable, Hashable {
    /// The edition is within the release's leaderboard (`leaderboardSize`, default 100).
    case first100
    /// The edition is within the first 20 (the leaderboard's Top 20 tab).
    case top20
    /// The fan's collector tier (`bronze | silver | gold`) on a copy that counted toward it.
    case tier(String)

    var title: String {
        switch self {
        case .first100: return "FIRST 100"
        case .top20: return "TOP 20"
        case .tier(let tier): return tier.uppercased()
        }
    }

    /// VoiceOver wording.
    var spoken: String {
        switch self {
        case .first100: return "First 100"
        case .top20: return "Top 20"
        case .tier(let tier): return "\(tier.capitalized) collector"
        }
    }
}

enum RackRules {
    /// LB-1 [DECIDE] default, used when the library row carries no `leaderboardSize`.
    static let defaultLeaderboardSize = 100
    static let top20 = 20
    /// Never more than this many stickers on one sleeve.
    static let maxStickers = 3

    /// The stickers on one copy, most important first: the collector tier, then TOP 20, then FIRST 100.
    /// - `edition`: the copy's number (a borrower sees the lender's); nil for presale copies.
    /// - `countsTowardTier`: this release is one of `leaderboard.myAwards().placements`.
    static func stickers(edition: Int?, leaderboardSize: Int?, tier: String?, countsTowardTier: Bool) -> [RackSticker] {
        var out: [RackSticker] = []
        if let tier, !tier.isEmpty, countsTowardTier, ["bronze", "silver", "gold"].contains(tier.lowercased()) {
            out.append(.tier(tier.lowercased()))
        }
        if let edition, edition > 0 {
            if edition <= top20 { out.append(.top20) }
            if edition <= max(1, leaderboardSize ?? defaultLeaderboardSize) { out.append(.first100) }
        }
        return Array(out.prefix(maxStickers))
    }

    /// FNV-1a over the slug, the edition and the sticker's slot: the same copy always gets the same numbers.
    static func seed(slug: String, edition: Int?, slot: Int) -> UInt64 {
        var hash: UInt64 = 0xcbf2_9ce4_8422_2325
        for byte in Array("\(slug)#\(edition ?? 0)#\(slot)".utf8) {
            hash ^= UInt64(byte)
            hash = hash &* 0x0000_0100_0000_01b3
        }
        return hash
    }

    /// A number in `-1...1` from the seed (different bits for different uses).
    private static func unit(_ seed: UInt64, shift: UInt64) -> Double {
        Double((seed >> shift) & 0xFFFF) / Double(0xFFFF) * 2 - 1
    }

    /// Slapped on by hand: tilted up to 14 degrees either way, stable for the copy (never jumps on redraw).
    static func stickerAngle(slug: String, edition: Int?, slot: Int) -> Double {
        unit(seed(slug: slug, edition: edition, slot: slot), shift: 0) * 14
    }

    /// Where a sticker sits on the sleeve face, as fractions of its width and height (the sticker's centre).
    /// Three slots spread over the art, jittered a little per copy. The title and the edition are printed under
    /// the tile, so nothing here can cover them; with a loan tag across the foot, the slots stay above it.
    /// `generic`: a sleeve without art prints its title across the top, so its stickers sit below it.
    static func stickerCentre(slug: String, edition: Int?, slot: Int, tagged: Bool, generic: Bool = false) -> (x: Double, y: Double) {
        let slots: [(Double, Double)]
        switch (generic, tagged) {
        case (false, true): slots = [(0.76, 0.2), (0.24, 0.42), (0.7, 0.58)]
        case (false, false): slots = [(0.76, 0.2), (0.25, 0.52), (0.72, 0.8)]
        case (true, true): slots = [(0.76, 0.6), (0.26, 0.6), (0.51, 0.62)]
        case (true, false): slots = [(0.74, 0.64), (0.28, 0.72), (0.62, 0.84)]
        }
        let base = slots[min(max(slot, 0), slots.count - 1)]
        let seed = seed(slug: slug, edition: edition, slot: slot)
        return (base.0 + unit(seed, shift: 16) * 0.04, base.1 + unit(seed, shift: 32) * 0.03)
    }

    // MARK: Countdown (DS-22, DROP-1)

    /// Server time now: the device clock corrected by the offset between the server and the device when the
    /// server's clock was read (DROP-1: never the device clock alone).
    static func serverNow(deviceNow: Date, serverNowAtFetch: Date?, fetchedAt: Date?) -> Date {
        guard let serverNowAtFetch, let fetchedAt else { return deviceNow }
        return deviceNow.addingTimeInterval(serverNowAtFetch.timeIntervalSince(fetchedAt))
    }

    /// The tile's LCD: `DROP 02:14:07` under 100 hours (the colons ride between the 11 cells), then `DROP 4D 03H`,
    /// and `DROPPING` once the time is up and the library hasn't refreshed yet.
    static func countdown(dropAt: Date?, serverNow: Date) -> String {
        guard let dropAt else { return "DROP SOON" }
        let left = Int(dropAt.timeIntervalSince(serverNow).rounded(.down))
        guard left > 0 else { return "DROPPING" }
        let hours = left / 3600, minutes = (left % 3600) / 60, seconds = left % 60
        if hours < 100 {
            return String(format: "DROP %02d:%02d:%02d", hours, minutes, seconds)
        }
        return LCDGlyphs.line("DROP", "\(hours / 24)D \(String(format: "%02d", hours % 24))H")
    }

    /// Spoken countdown for VoiceOver.
    static func spokenCountdown(dropAt: Date?, serverNow: Date) -> String {
        guard let dropAt else { return "Drops soon" }
        let left = max(0, Int(dropAt.timeIntervalSince(serverNow)))
        let days = left / 86_400, hours = (left % 86_400) / 3600, minutes = (left % 3600) / 60
        if left == 0 { return "Dropping now" }
        return "Drops in " + [days > 0 ? "\(days) days" : nil, "\(hours) hours", "\(minutes) minutes"]
            .compactMap { $0 }.joined(separator: " ")
    }

    // MARK: Rendered discs

    /// Where the sleeve's face sits in a spin-loop frame `width × height` (trimmed to the cartridge): the
    /// sleeve is square and at the foot, the cartridge stands above it. Its stickers, tag and film go here.
    static func renderFace(width: CGFloat, height: CGFloat) -> CGRect {
        let side = min(width * 0.92, height)
        return CGRect(x: (width - side) / 2, y: height - side, width: side, height: side)
    }

    /// Seconds into the loop a copy starts at, stable per slug, so the rack's discs don't turn in step.
    static func loopPhase(slug: String) -> TimeInterval {
        Double(seed(slug: slug, edition: nil, slot: 9) % 1000) / 1000 * 1.5
    }

    // MARK: Grid (DS-12, Dynamic Type)

    /// 3 across on a phone, 4 on wider size classes, 2 at Dynamic Type XXL and above so titles still fit.
    static func columns(regularWidth: Bool, largeText: Bool) -> Int {
        if largeText { return 2 }
        return regularWidth ? 4 : 3
    }
}

/// What a tile shows about how the fan holds the copy (RACK-1).
enum RackTileState: Equatable {
    case owned
    /// The fan's own copy is out on an active lend.
    case lentOut(playsLeft: Int)
    /// Someone else's copy, lent to the fan.
    case borrowed(from: String?, playsLeft: Int, ended: Bool)
    /// Announced and sealed until `dropAt` (DROP-2): shrink film, countdown, not playable.
    case locked(dropAt: Date?)

    init(release: LibraryRelease, context: ReleaseContext?) {
        if release.ownership == .upcoming || release.ownership == .locked {
            self = .locked(dropAt: release.dropAt)
            return
        }
        let lend = release.lend ?? context?.lend
        if release.ownership == .lent {
            self = .borrowed(
                from: context?.ownerDisplayName,
                playsLeft: lend?.playsLeft ?? 0,
                ended: lend.map { !$0.isActive } ?? false
            )
        } else if let lend, lend.role == .lender, lend.isActive {
            self = .lentOut(playsLeft: lend.playsLeft)
        } else {
            self = .owned
        }
    }

    var isLocked: Bool {
        if case .locked = self { return true }
        return false
    }

    /// The two lines of the loan tag across the sleeve's foot, or nil.
    var tagLines: (String, String)? {
        switch self {
        case .lentOut(let left):
            return ("ON LOAN", "\(String(format: "%02d", left)) PLAYS LEFT")
        case .borrowed(let from, let left, let ended):
            let lender = from.map { "FROM \($0.uppercased())" } ?? "BORROWED"
            return (lender, ended ? "LEND ENDED" : "\(String(format: "%02d", left)) PLAYS LEFT")
        default:
            return nil
        }
    }

    var spoken: String? {
        switch self {
        case .owned: return nil
        case .lentOut(let left): return "On loan, \(left) plays left"
        case .borrowed(let from, let left, let ended):
            let lender = from.map { "Borrowed from \($0)" } ?? "Borrowed"
            return ended ? "\(lender), lend ended" : "\(lender), \(left) plays left"
        case .locked: return "Sealed until the drop"
        }
    }
}

/// VoiceOver label for a tile: title, edition, stickers, state.
enum RackSpeech {
    static func label(title: String, edition: Int?, stickers: [RackSticker], state: RackTileState, countdown: String?) -> String {
        var parts = [title]
        if let edition { parts.append("edition \(edition)") }
        if !stickers.isEmpty { parts.append("stickers: " + stickers.map(\.spoken).joined(separator: ", ")) }
        if let spoken = state.spoken { parts.append(spoken) }
        if let countdown { parts.append(countdown) }
        return parts.joined(separator: ", ")
    }
}

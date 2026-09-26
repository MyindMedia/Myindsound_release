import Foundation

// App-side models for the Convex app API (docs/app-v1/BUILD.md "App API contract"). The server decides every
// value here (ARCH-3); the app only displays them. Mapping from the raw Convex returns is in APIDecoding.swift.

/// How the signed-in fan holds a release (bridge `getContext().ownership`, plus `upcoming` for library rows
/// that are announced but not out).
enum Ownership: String, Equatable {
    case owned, lent, locked, preview, upcoming

    /// LCD-style status word for readouts (DS-17).
    var readout: String {
        switch self {
        case .owned: return "OWNED"
        case .lent: return "LENT"
        case .locked: return "LOCKED"
        case .preview: return "PREVIEW"
        case .upcoming: return "UPCOMING"
        }
    }

    var canPlayFullTracks: Bool { self == .owned || self == .lent }
}

/// Per release accents (DS-34, `products.theme`). Hex strings as stored.
struct ReleaseTheme: Equatable {
    var accent: String?
    var accent2: String?
    var backdropImage: String?
    var lcdTint: String?
}

/// `bundle: { url, sha256, version }`: the release's own web bundle (BUN-2, BUN-4), opened by the focus view and
/// the deck through `BundleStore`.
struct BundleInfo: Equatable {
    var version: String?
    var url: URL?
    var sha256: String?
}

/// API.md `LendInfo` (wave 2; always null today). Plays left drives the `PLAYS 03` LCD.
struct LendInfo: Equatable {
    enum Role: String { case borrower, lender }

    var lendId: String
    var playsAllowed: Int
    var playsUsed: Int
    var expiresAt: Date?
    var status: String
    var endReason: String?
    var role: Role

    var playsLeft: Int { max(0, playsAllowed - playsUsed) }
    var isActive: Bool { status == "active" }
}

/// API.md `WearInputs`: what the server's descriptor was computed from. WEAR-9's offline overlay is
/// computeWear(seed, stats + locally queued plays, version) with the Swift port.
struct WearInputs: Equatable {
    var seed: String
    var playSeconds: Double
    var loads: Double
    var ejects: Double
    var lentPlaySeconds: Double
    var version: Int
}

/// One row of `app.library().releases`. `locked` rows (before their drop) are listed as `upcoming`.
struct LibraryRelease: Identifiable, Equatable {
    var releaseId: String?
    var slug: String
    var title: String
    var artist: String?
    var year: String?
    var coverURL: URL?
    var editionNumber: Int?
    var unwrapped: Bool
    var dropAt: Date?
    var ownership: Ownership
    var theme: ReleaseTheme?
    var bundle: BundleInfo?
    var lend: LendInfo?
    /// `draft | scheduled | live`; missing reads as live.
    var status: String = "live"
    var grantedAt: Date?
    var trackCount: Int?
    /// LB-1: when the server sends it; the rack falls back to `RackRules.defaultLeaderboardSize`.
    var leaderboardSize: Int? = nil
    /// The generated disc's DiscDesign (portal releases; nil for LIT).
    var design: DiscDesign? = nil
    /// The pre-rendered spin loop for the rack (nil for LIT: its built-in sleeve art stays).
    var rack: RackRender? = nil

    var id: String { slug }
}

struct LibrarySnapshot: Equatable {
    var releases: [LibraryRelease]
    var upcoming: [LibraryRelease]
    var serverNow: Date?

    static let empty = LibrarySnapshot(releases: [], upcoming: [], serverNow: nil)
}

/// `app.context({ slug })`: the bridge `getContext` data.
struct ReleaseContext: Equatable {
    var releaseId: String?
    var slug: String
    var title: String?
    var ownership: Ownership
    var editionNumber: Int?
    var ownerDisplayName: String?
    /// WearDescriptor.level from the server (null unless owned or lent).
    var wearLevel: Double?
    var wearInputs: WearInputs?
    var unwrapped: Bool
    /// nil when the release has no scheduled drop (the API sends 0).
    var dropAt: Date?
    var status: String
    var serverNow: Date?
    var lend: LendInfo?
    var design: DiscDesign? = nil
    var rack: RackRender? = nil
}

/// `app.tracks({ slug })`: never a storage id or a permanent link (ARCH-4).
struct Track: Identifiable, Equatable, Hashable {
    var id: String
    var position: Int
    var title: String
    var durationSeconds: Double

    var durationText: String { Self.clock(durationSeconds) }

    static func clock(_ seconds: Double) -> String {
        let s = max(0, Int(seconds.isFinite ? seconds.rounded(.down) : 0))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
}

/// `media.getStreamUrl`: valid for five minutes (AUD-2).
struct StreamURL: Equatable {
    var url: URL
    var expiresAt: Date

    func isValid(for seconds: TimeInterval, now: Date = Date()) -> Bool {
        expiresAt.timeIntervalSince(now) > seconds
    }
}

/// One row of `leaderboard.forRelease` (LB-2).
struct LeaderboardEntry: Identifiable, Equatable {
    var rank: Int
    var editionNumber: Int
    /// Public name, "Anonymous collector" (opted out) or "Retired" (deleted account). Never an email.
    var displayName: String
    var retired: Bool
    var anonymous: Bool
    var isYou: Bool
    /// `bronze | silver | gold`
    var awardTier: String?

    var id: Int { editionNumber }
}

struct Leaderboard: Equatable {
    var slug: String
    var title: String
    var size: Int
    var entries: [LeaderboardEntry]

    var myEntry: LeaderboardEntry? { entries.first(where: \.isYou) }
}

/// `leaderboard.myAwards()` (LB-4, LB-6).
struct AwardsSummary: Equatable {
    struct Placement: Equatable, Identifiable {
        var slug: String
        var title: String
        var rank: Int
        var editionNumber: Int
        var id: String { slug }
    }

    var topPlacements: Int
    var tier: String?
    var nextTier: String?
    var nextTierNeeds: Int?
    var placements: [Placement]
    var leaderboardVisible: Bool

    static let empty = AwardsSummary(topPlacements: 0, tier: nil, nextTier: nil, nextTierNeeds: nil, placements: [], leaderboardVisible: true)
}

/// `plays.recordPlayEvents` per-event result. Every status (recorded, duplicate, rejected) leaves the queue.
struct PlayEventResult: Equatable {
    var idempotencyKey: String
    var status: String
    var reason: String?
    var countedSec: Double
}

/// A play session queued for `plays.recordPlayEvents` (WEAR-6). The key is made once on the device and
/// never changes, so a retried batch is ignored server side instead of counted twice.
struct PlayEvent: Codable, Equatable, Identifiable {
    enum Kind: String, Codable { case play }

    var idempotencyKey: String
    var slug: String
    var trackId: String
    var lendId: String?
    /// Epoch ms on the device clock when the session started (WEAR-7 rejects future or > 60 day old ones).
    var startedAtClient: Double
    var playedSec: Double
    var kind: Kind

    var id: String { idempotencyKey }

    init(
        idempotencyKey: String = UUID().uuidString.lowercased(),
        slug: String,
        trackId: String,
        lendId: String? = nil,
        startedAt: Date,
        playedSec: Double,
        kind: Kind = .play
    ) {
        self.idempotencyKey = idempotencyKey
        self.slug = slug
        self.trackId = trackId
        self.lendId = lendId
        self.startedAtClient = (startedAt.timeIntervalSince1970 * 1000).rounded()
        self.playedSec = playedSec
        self.kind = kind
    }
}

enum CartridgeEventKind: String { case load, eject }

/// Errors the screens show. `code` is the server's `ConvexError({ code })` when there is one.
struct APIError: LocalizedError, Equatable {
    var code: String
    var message: String

    var errorDescription: String? { message }

    static let unauthenticated = APIError(code: "UNAUTHENTICATED", message: "Sign in to continue.")
    static let notConfigured = APIError(code: "NOT_CONFIGURED", message: "The app has no backend configured.")
}

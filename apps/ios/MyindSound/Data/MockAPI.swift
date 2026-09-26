import Foundation
import MyindWear

/// Sample data for `-mock` runs (screenshots, the simulator without a backend). Titles are LIT's real
/// tracklist; streams are the public 30 second previews the site already serves, so playback works end to
/// end without a signed in account. Nothing here is a real fan.
final class MockAPI: MyindAPI {
    /// `-rack full|one|empty`: which library the rack shows (screenshots of every state, RACK-1).
    enum Scenario: String {
        case full, one, empty

        static func fromLaunchArguments(_ arguments: [String] = ProcessInfo.processInfo.arguments) -> Scenario {
            guard let index = arguments.firstIndex(of: "-rack"), index + 1 < arguments.count else { return .full }
            return Scenario(rawValue: arguments[index + 1].lowercased()) ?? .full
        }
    }

    let scenario: Scenario

    init(scenario: Scenario = .fromLaunchArguments()) {
        self.scenario = scenario
    }

    private(set) var recordedEvents: [PlayEvent] = []
    private(set) var cartridgeEvents: [(String, CartridgeEventKind)] = []
    private(set) var unwrappedSlugs: Set<String> = []

    static let previewBase = URL(string: "https://stream.myindsound.com/assets/audio/lit-previews/")!
    private static let previewFiles = [
        "01-lit.mp3", "02-god.mp3", "03-victory-in-the-valley.mp3", "04-tired.mp3",
        "05-let-him-cook.mp3", "06-he-the-truth.mp3", "07-faith.mp3",
    ]

    static let litTracks: [Track] = LITSample.tracks.map {
        Track(id: "mock-lit-\($0.position)", position: $0.position, title: $0.title, durationSeconds: $0.durationSeconds)
    }

    static let lit = LibraryRelease(
        releaseId: "mock-release-lit",
        slug: "lit",
        title: "LIT",
        artist: LITSample.artist,
        year: LITSample.year,
        coverURL: nil,
        editionNumber: LITSample.editionNumber,
        // RACK-3: unwrapped, so the rack opens it in sleeve mode; `-sealed` starts it in its film instead, so the
        // unwrap plays once per run.
        unwrapped: !ProcessInfo.processInfo.arguments.contains("-sealed"),
        dropAt: nil,
        ownership: .owned,
        theme: ReleaseTheme(accent: "#FF3DA8", accent2: "#9FD8FF", backdropImage: "city-comic.webp", lcdTint: nil),
        // BUN-2 in the simulator: the Debug build's embedded dist-bundles zip, verified and unpacked for real.
        bundle: BundleStore.devZip(slug: "lit"),
        lend: nil,
        grantedAt: Date(timeIntervalSince1970: 1_758_326_400),
        trackCount: litTracks.count
    )

    static let theSource = LibraryRelease(
        releaseId: "mock-release-the-source",
        slug: "the-source",
        title: "The Source",
        artist: LITSample.artist,
        year: nil,
        coverURL: nil,
        editionNumber: nil,
        unwrapped: false,
        dropAt: Date().addingTimeInterval(2 * 86_400 + 14 * 3600 + 7 * 60),
        ownership: .upcoming,
        theme: nil,
        bundle: nil,
        lend: nil,
        status: "scheduled",
        trackCount: nil
    )

    /// Sample copies for the other rack states. Titles other than LIT, C-WALK and The Source are samples.
    static func sample(
        _ slug: String, _ title: String, edition: Int?, ownership: Ownership, lend: LendInfo? = nil, accent: String
    ) -> LibraryRelease {
        LibraryRelease(
            releaseId: "mock-release-\(slug)", slug: slug, title: title, artist: LITSample.artist, year: nil, coverURL: nil,
            editionNumber: edition, unwrapped: true, dropAt: nil, ownership: ownership,
            theme: ReleaseTheme(accent: accent, accent2: nil, backdropImage: nil, lcdTint: nil),
            bundle: nil, lend: lend, grantedAt: Date(timeIntervalSince1970: 1_758_000_000), trackCount: nil
        )
    }

    static let cWalk = sample("c-walk", "C-WALK", edition: 64, ownership: .owned, accent: "#FF8C00")
    static let reflections = sample("reflections", "Reflections", edition: 212, ownership: .owned, accent: "#9FD8FF")
    static let blood = sample(
        "blood", "Blood", edition: 19, ownership: .owned,
        lend: LendInfo(lendId: "mock-lend-out", playsAllowed: 10, playsUsed: 4, expiresAt: Date().addingTimeInterval(4 * 86_400),
                       status: "active", endReason: nil, role: .lender),
        accent: "#FF3DA8"
    )
    static let cook = sample(
        "cook", "Let Him Cook", edition: 3, ownership: .lent,
        lend: LendInfo(lendId: "mock-lend-in", playsAllowed: 10, playsUsed: 6, expiresAt: Date().addingTimeInterval(5 * 86_400),
                       status: "active", endReason: nil, role: .borrower),
        accent: "#FDB913"
    )

    /// Different play time per copy, so the rack's scuffs differ (seconds heard, seed).
    private static let sampleWear: [String: (Double, String)] = [
        "c-walk": (40 * 180, "0a1b2c3d4e5f60718293a4b5c6d7e8f9"),
        "reflections": (420 * 180, "f0e1d2c3b4a5968778695a4b3c2d1e0f"),
        "blood": (160 * 180, "1234abcd5678ef901234abcd5678ef90"),
        "cook": (90 * 180, "9f8e7d6c5b4a39281706f5e4d3c2b1a0"),
    ]

    /// What the server would send: computeWear on the sample inputs (packages/wear-swift).
    static let mockWearLevel: Double? = try? computeWear(
        seed: wearInputs.seed,
        stats: WearStats(playSeconds: wearInputs.playSeconds, lentPlaySeconds: 0, loads: wearInputs.loads, ejects: wearInputs.ejects),
        version: wearInputs.version
    ).level

    private static let names = [
        "Kairo W.", "Anonymous collector", "Dee M.", "Jules R.", "Marcus T.", "Anonymous collector", "Collector",
        "Nia S.", "Theo B.", "Anonymous collector", "Rae K.", "Omar F.", "Lena P.", "Anonymous collector",
        "Sol A.", "Ivy D.", "Anonymous collector", "Quinn H.", "Ade O.", "Mika L.",
    ]

    func library() async throws -> LibrarySnapshot {
        switch scenario {
        case .empty: return LibrarySnapshot(releases: [], upcoming: [], serverNow: Date())
        case .one: return LibrarySnapshot(releases: [Self.lit], upcoming: [], serverNow: Date())
        case .full:
            return LibrarySnapshot(
                releases: [Self.lit, Self.cWalk, Self.blood, Self.cook, Self.reflections],
                upcoming: [Self.theSource],
                serverNow: Date()
            )
        }
    }

    private var allReleases: [LibraryRelease] { [Self.lit, Self.cWalk, Self.reflections, Self.blood, Self.cook, Self.theSource] }

    /// 128 bit hex, as ENT-3 grants. Sample only.
    static let wearInputs = WearInputs(
        seed: "5f3a9c1e7b2d4f608a1c3e5f7b9d0a2c",
        playSeconds: Double(LITSample.plays) * 180,
        loads: 42,
        ejects: 40,
        lentPlaySeconds: 0,
        version: 1
    )

    func context(slug: String) async throws -> ReleaseContext {
        let release = allReleases.first { $0.slug == slug } ?? Self.theSource
        // The empty rack's GET LIT opens LIT as a fan who hasn't bought it yet.
        let owned = release.ownership == .owned && scenario != .empty
        let wears = owned || release.ownership == .lent
        let inputs: WearInputs? = slug == Self.lit.slug ? Self.wearInputs : Self.sampleWear[slug].map {
            WearInputs(seed: $0.1, playSeconds: $0.0, loads: 12, ejects: 11, lentPlaySeconds: 0, version: 1)
        }
        let level = inputs.flatMap {
            try? computeWear(seed: $0.seed, stats: WearStats(playSeconds: $0.playSeconds, lentPlaySeconds: 0, loads: $0.loads, ejects: $0.ejects), version: 1).level
        }
        return ReleaseContext(
            releaseId: release.releaseId,
            slug: slug,
            title: release.title,
            ownership: scenario == .empty && slug == Self.lit.slug ? .preview : (release.ownership == .upcoming ? .locked : release.ownership),
            editionNumber: release.editionNumber,
            ownerDisplayName: owned ? "Lawrence B." : (release.ownership == .lent ? "Dee M." : nil),
            wearLevel: wears ? level : nil,
            wearInputs: wears ? inputs : nil,
            unwrapped: release.unwrapped || unwrappedSlugs.contains(slug),
            dropAt: release.dropAt,
            status: release.status,
            serverNow: Date(),
            lend: release.lend
        )
    }

    func tracks(slug: String) async throws -> [Track] {
        slug == Self.lit.slug ? Self.litTracks : []
    }

    func streamURL(trackId: String, lendId: String?) async throws -> StreamURL {
        guard let index = Self.litTracks.firstIndex(where: { $0.id == trackId }) else {
            throw APIError(code: "NOT_FOUND", message: "That track isn't available.")
        }
        return StreamURL(
            url: Self.previewBase.appendingPathComponent(Self.previewFiles[index]),
            expiresAt: Date().addingTimeInterval(5 * 60)
        )
    }

    func recordPlayEvents(_ events: [PlayEvent]) async throws -> [PlayEventResult] {
        recordedEvents += events
        return events.map { PlayEventResult(idempotencyKey: $0.idempotencyKey, status: "recorded", reason: nil, countedSec: $0.playedSec) }
    }

    func markUnwrapped(slug: String) async throws {
        unwrappedSlugs.insert(slug)
    }

    func recordCartridgeEvent(slug: String, kind: CartridgeEventKind, idempotencyKey: String) async throws {
        cartridgeEvents.append((slug, kind))
    }

    func leaderboard(slug: String, limit: Int) async throws -> Leaderboard {
        let entries = Self.names.prefix(limit).enumerated().map { index, name in
            let edition = index + 1
            let isYou = edition == LITSample.editionNumber
            return LeaderboardEntry(
                rank: edition,
                editionNumber: edition,
                displayName: isYou ? "Lawrence B." : name,
                retired: false,
                anonymous: name == "Anonymous collector",
                isYou: isYou,
                awardTier: [1, 2, 4].contains(edition) ? "silver" : ([3, 9, 12].contains(edition) ? "bronze" : nil)
            )
        }
        return Leaderboard(slug: slug, title: "LIT", size: 100, entries: Array(entries))
    }

    func myAwards() async throws -> AwardsSummary {
        if scenario != .full {
            return AwardsSummary(
                topPlacements: scenario == .one ? 1 : 0,
                tier: nil,
                nextTier: "bronze",
                nextTierNeeds: scenario == .one ? 2 : 3,
                placements: scenario == .one
                    ? [.init(slug: "lit", title: "LIT", rank: LITSample.editionNumber, editionNumber: LITSample.editionNumber)] : [],
                leaderboardVisible: true
            )
        }
        return AwardsSummary(
            topPlacements: 3,
            tier: "bronze",
            nextTier: "silver",
            nextTierNeeds: 4,
            placements: [
                .init(slug: "lit", title: "LIT", rank: LITSample.editionNumber, editionNumber: LITSample.editionNumber),
                .init(slug: "c-walk", title: "C-WALK", rank: 61, editionNumber: 64),
                .init(slug: "blood", title: "Blood", rank: 19, editionNumber: 19),
            ],
            leaderboardVisible: true
        )
    }

    func registerPushToken(_ token: String, wantsDropAlerts: Bool, sandbox: Bool) async throws {}
    func unregisterPushToken(_ token: String) async throws {}

    func exportMyData() async throws -> Data {
        Data(#"{"sample":true,"purchases":[{"slug":"lit","editionNumber":7}]}"#.utf8)
    }

    func deleteMyData() async throws {}
}

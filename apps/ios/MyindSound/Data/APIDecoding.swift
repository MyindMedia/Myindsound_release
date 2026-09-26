import Foundation

/// Raw Convex returns → app models, to the shapes in docs/app-v1/API.md. Each field is read by its API.md
/// name; a missing optional field becomes nil or its documented default rather than failing the decode, so
/// an additive server change never breaks the app. Only a value a screen cannot work without (a track id,
/// a stream URL) throws.
enum APIDecoding {
    struct Failure: LocalizedError {
        var what: String
        var errorDescription: String? { "Unexpected response from the server (\(what))." }
    }

    // MARK: Shared types

    static func ownership(_ word: String?) -> Ownership? {
        switch word?.lowercased() {
        case "owned": return .owned
        case "lent": return .lent
        case "locked": return .locked
        case "preview": return .preview
        default: return nil
        }
    }

    static func theme(_ value: JSONValue?) -> ReleaseTheme? {
        guard let value, value.object != nil else { return nil }
        return ReleaseTheme(
            accent: value["accent"]?.string,
            accent2: value["accent2"]?.string,
            backdropImage: value["backdropImage"]?.string,
            lcdTint: value["lcdTint"]?.string
        )
    }

    static func bundle(_ value: JSONValue?) -> BundleInfo? {
        guard let value, value.object != nil else { return nil }
        return BundleInfo(
            version: value["version"]?.string,
            url: value["url"]?.string.flatMap(URL.init(string:)),
            sha256: value["sha256"]?.string
        )
    }

    static func lend(_ value: JSONValue?) -> LendInfo? {
        guard let value, let lendId = value["lendId"]?.string else { return nil }
        return LendInfo(
            lendId: lendId,
            playsAllowed: value["playsAllowed"]?.int ?? 0,
            playsUsed: value["playsUsed"]?.int ?? 0,
            expiresAt: value["expiresAt"]?.date,
            status: value["status"]?.string ?? "active",
            endReason: value["endReason"]?.string,
            role: LendInfo.Role(rawValue: value["role"]?.string ?? "") ?? .borrower
        )
    }

    static func wearInputs(_ value: JSONValue?) -> WearInputs? {
        guard let value, let seed = value["seed"]?.string, let stats = value["stats"] else { return nil }
        return WearInputs(
            seed: seed,
            playSeconds: stats["playSeconds"]?.double ?? 0,
            loads: stats["loads"]?.double ?? 0,
            ejects: stats["ejects"]?.double ?? 0,
            lentPlaySeconds: stats["lentPlaySeconds"]?.double ?? 0,
            version: value["version"]?.int ?? 1
        )
    }

    /// API times are epoch ms; `dropAt` uses 0 (context) or null (library) for "no scheduled drop".
    private static func dropDate(_ value: JSONValue?) -> Date? {
        guard let ms = value?.double, ms > 0 else { return nil }
        return Date(timeIntervalSince1970: ms / 1000)
    }

    // MARK: app.library

    /// `{ serverNow, releases }`. Owned and lent copies stay in `releases`; `locked` ones (before their drop)
    /// move to `upcoming`, in the server's order (RACK-1).
    static func library(_ value: JSONValue) -> LibrarySnapshot {
        let rows = (value["releases"]?.array ?? value.array ?? []).compactMap(release)
        return LibrarySnapshot(
            releases: rows.filter { $0.ownership != .upcoming },
            upcoming: rows.filter { $0.ownership == .upcoming },
            serverNow: value["serverNow"]?.date
        )
    }

    static func release(_ value: JSONValue) -> LibraryRelease? {
        guard let slug = value["slug"]?.string else { return nil }
        let owned = ownership(value["ownership"]?.string) ?? .locked
        return LibraryRelease(
            releaseId: value["releaseId"]?.string,
            slug: slug,
            title: value["title"]?.string ?? slug.uppercased(),
            artist: value["artist"]?.string,
            year: value["year"]?.string,
            coverURL: value["coverUrl"]?.string.flatMap(URL.init(string:)),
            editionNumber: value["editionNumber"]?.int,
            unwrapped: value["unwrapped"]?.bool ?? false,
            dropAt: dropDate(value["dropAt"]),
            ownership: owned == .locked ? .upcoming : owned,
            theme: theme(value["theme"]),
            bundle: bundle(value["bundle"]),
            lend: lend(value["lend"]),
            status: value["status"]?.string ?? "live",
            grantedAt: value["grantedAt"]?.date,
            trackCount: value["trackCount"]?.int,
            leaderboardSize: value["leaderboardSize"]?.int
        )
    }

    // MARK: app.context

    static func context(_ value: JSONValue, slug: String) -> ReleaseContext {
        ReleaseContext(
            releaseId: value["releaseId"]?.string,
            slug: value["slug"]?.string ?? slug,
            title: value["title"]?.string,
            ownership: ownership(value["ownership"]?.string) ?? .preview,
            editionNumber: value["editionNumber"]?.int,
            ownerDisplayName: value["ownerDisplayName"]?.string,
            wearLevel: value["wear"]?["level"]?.double,
            wearInputs: wearInputs(value["wearInputs"]),
            unwrapped: value["unwrapped"]?.bool ?? false,
            dropAt: dropDate(value["dropAt"]),
            status: value["status"]?.string ?? "live",
            serverNow: value["serverNow"]?.date,
            lend: lend(value["lend"])
        )
    }

    // MARK: app.tracks

    /// `Array<{ id, position, title, durationSeconds }>`, in album order.
    static func tracks(_ value: JSONValue) throws -> [Track] {
        let rows = value.array ?? []
        var tracks: [Track] = []
        for (index, row) in rows.enumerated() {
            guard let id = row["id"]?.string else { throw Failure(what: "track id") }
            tracks.append(Track(
                id: id,
                position: row["position"]?.int ?? index + 1,
                title: row["title"]?.string ?? "Track \(index + 1)",
                durationSeconds: row["durationSeconds"]?.double ?? 0
            ))
        }
        return tracks.sorted { $0.position < $1.position }
    }

    // MARK: media.getStreamUrl

    /// `{ url, expiresAt }` (5 minutes, AUD-2).
    static func streamURL(_ value: JSONValue, now: Date = Date()) throws -> StreamURL {
        guard let text = value["url"]?.string, let url = URL(string: text) else { throw Failure(what: "stream url") }
        return StreamURL(url: url, expiresAt: value["expiresAt"]?.date ?? now.addingTimeInterval(5 * 60))
    }

    // MARK: plays.recordPlayEvents

    static func playEventResults(_ value: JSONValue) -> [PlayEventResult] {
        (value["results"]?.array ?? []).compactMap { row in
            guard let key = row["idempotencyKey"]?.string else { return nil }
            return PlayEventResult(
                idempotencyKey: key,
                status: row["status"]?.string ?? "recorded",
                reason: row["reason"]?.string,
                countedSec: row["countedSec"]?.double ?? 0
            )
        }
    }

    // MARK: leaderboard

    static func leaderboard(_ value: JSONValue, slug: String) -> Leaderboard {
        let rows = value["rows"]?.array ?? []
        let entries: [LeaderboardEntry] = rows.enumerated().compactMap { index, row in
            guard let edition = row["editionNumber"]?.int else { return nil }
            return LeaderboardEntry(
                rank: row["rank"]?.int ?? index + 1,
                editionNumber: edition,
                displayName: row["displayName"]?.string ?? "Collector",
                retired: row["retired"]?.bool ?? false,
                anonymous: row["anonymous"]?.bool ?? false,
                isYou: row["isYou"]?.bool ?? false,
                awardTier: row["awardTier"]?.string
            )
        }
        return Leaderboard(
            slug: value["slug"]?.string ?? slug,
            title: value["title"]?.string ?? slug.uppercased(),
            size: value["leaderboardSize"]?.int ?? 100,
            entries: entries.sorted { $0.rank < $1.rank }
        )
    }

    static func awards(_ value: JSONValue) -> AwardsSummary {
        AwardsSummary(
            topPlacements: value["topPlacements"]?.int ?? 0,
            tier: value["tier"]?.string,
            nextTier: value["nextTier"]?["tier"]?.string,
            nextTierNeeds: value["nextTier"]?["needs"]?.int,
            placements: (value["placements"]?.array ?? []).compactMap { row in
                guard let slug = row["slug"]?.string else { return nil }
                return AwardsSummary.Placement(
                    slug: slug,
                    title: row["title"]?.string ?? slug.uppercased(),
                    rank: row["rank"]?.int ?? 0,
                    editionNumber: row["editionNumber"]?.int ?? 0
                )
            },
            leaderboardVisible: value["leaderboardVisible"]?.bool ?? true
        )
    }

    // MARK: Errors

    /// A `ConvexError` payload: `data = { code, message }`, where `message` is safe to show.
    static func error(convexErrorData data: String) -> APIError {
        if let value = try? JSONValue.parse(data) {
            if let message = value["message"]?.string {
                return APIError(code: value["code"]?.string ?? "ERROR", message: message)
            }
            if let text = value.string { return APIError(code: "ERROR", message: text) }
        }
        return APIError(code: "ERROR", message: "Something went wrong. Try again.")
    }

    /// A plain server error (a bug or a function that isn't deployed): never shown raw.
    static func error(serverMessage message: String) -> APIError {
        if message.localizedCaseInsensitiveContains("unauthenticated") {
            return .unauthenticated
        }
        if message.contains("Could not find public function") {
            return APIError(code: "NOT_DEPLOYED", message: "The server doesn't have this feature yet.")
        }
        return APIError(code: "SERVER", message: "Something went wrong on the server. Try again.")
    }
}

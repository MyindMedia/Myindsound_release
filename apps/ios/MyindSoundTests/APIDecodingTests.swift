import XCTest
@testable import MyindSound

/// The Convex returns in docs/app-v1/API.md, decoded into app models. Fixtures are written from API.md;
/// every value is made up (no customer data).
final class APIDecodingTests: XCTestCase {
    private func json(_ text: String) throws -> JSONValue { try JSONValue.parse(text) }

    // MARK: JSONValue

    func testConvexInt64Envelope() throws {
        // 7 as a little endian int64, base64.
        let seven = Data([7, 0, 0, 0, 0, 0, 0, 0]).base64EncodedString()
        let value = try json(#"{"n": {"$integer": "\#(seven)"}}"#)
        XCTAssertEqual(value["n"]?.int, 7)
    }

    // MARK: app.library

    func testLibrarySplitsOwnedFromLocked() throws {
        let value = try json("""
        {
          "serverNow": 1758000000000,
          "releases": [
            { "releaseId": "r1", "slug": "lit", "title": "LIT", "ownership": "owned", "editionNumber": 7,
              "unwrapped": true, "dropAt": null, "status": "live",
              "theme": { "accent": "#FF3DA8", "accent2": "#9FD8FF", "backdropImage": "city-comic.webp" },
              "bundle": null, "lend": null, "grantedAt": 1757000000000 },
            { "releaseId": "r2", "slug": "the-source", "title": "The Source", "ownership": "locked",
              "editionNumber": null, "unwrapped": false, "dropAt": 1759000000000, "status": "scheduled",
              "theme": null, "bundle": null, "lend": null, "grantedAt": null }
          ]
        }
        """)
        let library = APIDecoding.library(value)
        XCTAssertEqual(library.releases.map(\.slug), ["lit"])
        XCTAssertEqual(library.upcoming.map(\.slug), ["the-source"])
        let lit = try XCTUnwrap(library.releases.first)
        XCTAssertEqual(lit.releaseId, "r1")
        XCTAssertEqual(lit.editionNumber, 7)
        XCTAssertEqual(lit.ownership, .owned)
        XCTAssertTrue(lit.unwrapped)
        XCTAssertNil(lit.dropAt)
        XCTAssertEqual(lit.theme?.accent, "#FF3DA8")
        XCTAssertNil(lit.bundle)
        XCTAssertEqual(lit.grantedAt, Date(timeIntervalSince1970: 1_757_000_000))
        XCTAssertEqual(library.upcoming.first?.dropAt, Date(timeIntervalSince1970: 1_759_000_000))
        XCTAssertEqual(library.serverNow, Date(timeIntervalSince1970: 1_758_000_000))
    }

    func testLibraryToleratesMissingOptionalFields() throws {
        let value = try json(#"{ "releases": [ { "slug": "lit", "ownership": "owned" } ] }"#)
        let lit = try XCTUnwrap(APIDecoding.library(value).releases.first)
        XCTAssertEqual(lit.title, "LIT")
        XCTAssertNil(lit.editionNumber)
        XCTAssertFalse(lit.unwrapped)
        XCTAssertEqual(lit.status, "live")
    }

    func testLendInfo() throws {
        let value = try json(#"""
        { "lendId": "l1", "playsAllowed": 5, "playsUsed": 2, "expiresAt": 1758000000000,
          "status": "active", "endReason": null, "role": "borrower" }
        """#)
        let lend = try XCTUnwrap(APIDecoding.lend(value))
        XCTAssertEqual(lend.playsLeft, 3)
        XCTAssertEqual(lend.role, .borrower)
        XCTAssertTrue(lend.isActive)
        XCTAssertNil(APIDecoding.lend(.null))
    }

    // MARK: app.context

    func testContext() throws {
        let value = try json("""
        { "releaseId": "r1", "slug": "lit", "title": "LIT", "ownership": "owned", "editionNumber": 7,
          "ownerDisplayName": "Sample N.",
          "wear": { "version": 1, "seed": "00", "level": 0.412345, "scratches": [], "scuffZones": [],
                    "labelFade": 0, "edgeWear": 0, "dustAmount": 0 },
          "wearInputs": { "seed": "5f3a9c1e7b2d4f608a1c3e5f7b9d0a2c",
                          "stats": { "playSeconds": 3600, "loads": 4, "ejects": 3, "lentPlaySeconds": 0 },
                          "version": 1 },
          "unwrapped": true, "dropAt": 0, "status": "live", "serverNow": 1758000000000, "lend": null }
        """)
        let context = APIDecoding.context(value, slug: "lit")
        XCTAssertEqual(context.ownership, .owned)
        XCTAssertEqual(context.editionNumber, 7)
        XCTAssertEqual(context.wearLevel, 0.412345)
        XCTAssertEqual(context.wearInputs?.playSeconds, 3600)
        XCTAssertEqual(context.wearInputs?.loads, 4)
        XCTAssertNil(context.dropAt, "dropAt 0 means no scheduled drop")
        XCTAssertNil(context.lend)
    }

    func testUnknownOwnershipFallsBackToPreview() throws {
        let context = APIDecoding.context(try json(#"{ "slug": "lit", "ownership": "something-new" }"#), slug: "lit")
        XCTAssertEqual(context.ownership, .preview)
    }

    // MARK: app.tracks

    func testTracksSortByPosition() throws {
        let value = try json("""
        [ { "id": "t2", "position": 2, "title": "G. O. D.", "durationSeconds": 201.5 },
          { "id": "t1", "position": 1, "title": "L.I.T. (Living In Truth)", "durationSeconds": 188 } ]
        """)
        let tracks = try APIDecoding.tracks(value)
        XCTAssertEqual(tracks.map(\.id), ["t1", "t2"])
        XCTAssertEqual(tracks[1].durationSeconds, 201.5)
        XCTAssertEqual(tracks[0].durationText, "3:08")
    }

    func testTrackWithoutAnIdThrows() throws {
        XCTAssertThrowsError(try APIDecoding.tracks(try json(#"[ { "position": 1, "title": "x" } ]"#)))
    }

    // MARK: media.getStreamUrl

    func testStreamURL() throws {
        let value = try json(#"{ "url": "https://example.convex.site/media/stream?t=abc", "expiresAt": 1758000300000 }"#)
        let stream = try APIDecoding.streamURL(value)
        XCTAssertEqual(stream.url.absoluteString, "https://example.convex.site/media/stream?t=abc")
        XCTAssertEqual(stream.expiresAt, Date(timeIntervalSince1970: 1_758_000_300))
        XCTAssertTrue(stream.isValid(for: 60, now: Date(timeIntervalSince1970: 1_758_000_000)))
        XCTAssertFalse(stream.isValid(for: 60, now: Date(timeIntervalSince1970: 1_758_000_280)))
    }

    func testStreamURLWithoutAURLThrows() throws {
        XCTAssertThrowsError(try APIDecoding.streamURL(try json(#"{ "expiresAt": 1 }"#)))
    }

    // MARK: plays.recordPlayEvents

    func testPlayEventResults() throws {
        let value = try json("""
        { "results": [
            { "idempotencyKey": "k1", "status": "recorded", "reason": null, "countedSec": 30, "counted": true, "limitedBy": null },
            { "idempotencyKey": "k2", "status": "duplicate", "reason": null, "countedSec": 0, "counted": false, "limitedBy": null },
            { "idempotencyKey": "k3", "status": "rejected", "reason": "too_old", "countedSec": 0, "counted": false, "limitedBy": null }
          ], "recorded": 1, "duplicates": 1, "rejected": 1 }
        """)
        let results = APIDecoding.playEventResults(value)
        XCTAssertEqual(results.map(\.idempotencyKey), ["k1", "k2", "k3"], "every status leaves the queue")
        XCTAssertEqual(results[2].reason, "too_old")
        XCTAssertEqual(results[0].countedSec, 30)
    }

    // MARK: leaderboard

    func testLeaderboard() throws {
        let value = try json("""
        { "slug": "lit", "title": "LIT", "leaderboardSize": 100, "rows": [
            { "rank": 2, "editionNumber": 3, "displayName": "Retired", "retired": true, "anonymous": false, "isYou": false, "awardTier": null },
            { "rank": 1, "editionNumber": 1, "displayName": "Sample A.", "retired": false, "anonymous": false, "isYou": true, "awardTier": "gold" }
        ] }
        """)
        let board = APIDecoding.leaderboard(value, slug: "lit")
        XCTAssertEqual(board.size, 100)
        XCTAssertEqual(board.entries.map(\.rank), [1, 2])
        XCTAssertEqual(board.myEntry?.editionNumber, 1)
        XCTAssertEqual(board.entries[0].awardTier, "gold")
        XCTAssertTrue(board.entries[1].retired)
    }

    func testAwards() throws {
        let value = try json("""
        { "topPlacements": 3, "tier": "bronze", "nextTier": { "tier": "silver", "needs": 4 },
          "placements": [ { "slug": "lit", "title": "LIT", "rank": 7, "editionNumber": 7 } ],
          "leaderboardVisible": true }
        """)
        let awards = APIDecoding.awards(value)
        XCTAssertEqual(awards.tier, "bronze")
        XCTAssertEqual(awards.nextTier, "silver")
        XCTAssertEqual(awards.nextTierNeeds, 4)
        XCTAssertEqual(awards.placements.first?.editionNumber, 7)
        XCTAssertNil(APIDecoding.awards(try json(#"{ "topPlacements": 0, "tier": null, "nextTier": null, "placements": [], "leaderboardVisible": true }"#)).tier)
    }

    // MARK: Errors

    func testConvexErrorPayload() {
        let error = APIDecoding.error(convexErrorData: #"{"code":"NOT_ENTITLED","message":"You don't own this release."}"#)
        XCTAssertEqual(error.code, "NOT_ENTITLED")
        XCTAssertEqual(error.message, "You don't own this release.")
    }

    func testServerErrorsAreNeverShownRaw() {
        let error = APIDecoding.error(serverMessage: "[Request ID: 123] Server Error Uncaught TypeError: x is undefined")
        XCTAssertEqual(error.code, "SERVER")
        XCTAssertFalse(error.message.contains("TypeError"))
    }
}

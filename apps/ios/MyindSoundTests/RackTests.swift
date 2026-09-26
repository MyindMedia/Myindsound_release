import XCTest
@testable import MyindSound

/// RACK-1 rules: stickers (LB-1, LB-4), their stable placement, tile states, the drop countdown (DROP-1, DS-22)
/// and the sleeve-mode URL.
final class RackTests: XCTestCase {
    // MARK: Stickers

    func testEditionWithinTop20GetsBothEarlyBuyerStickers() {
        XCTAssertEqual(RackRules.stickers(edition: 7, leaderboardSize: 100, tier: nil, countsTowardTier: false), [.top20, .first100])
        XCTAssertEqual(RackRules.stickers(edition: 20, leaderboardSize: 100, tier: nil, countsTowardTier: false), [.top20, .first100])
    }

    func testEditionWithinLeaderboardOnlyGetsFirst100() {
        XCTAssertEqual(RackRules.stickers(edition: 21, leaderboardSize: 100, tier: nil, countsTowardTier: false), [.first100])
        XCTAssertEqual(RackRules.stickers(edition: 100, leaderboardSize: nil, tier: nil, countsTowardTier: false), [.first100])
    }

    func testEditionPastTheLeaderboardGetsNone() {
        XCTAssertEqual(RackRules.stickers(edition: 101, leaderboardSize: 100, tier: nil, countsTowardTier: false), [])
        XCTAssertEqual(RackRules.stickers(edition: 51, leaderboardSize: 50, tier: nil, countsTowardTier: false), [])
    }

    func testPresaleCopyHasNoEditionStickers() {
        XCTAssertEqual(RackRules.stickers(edition: nil, leaderboardSize: 100, tier: nil, countsTowardTier: false), [])
        XCTAssertEqual(RackRules.stickers(edition: 0, leaderboardSize: 100, tier: nil, countsTowardTier: false), [])
    }

    func testTierOnlyOnCopiesThatCountedTowardIt() {
        XCTAssertEqual(RackRules.stickers(edition: 64, leaderboardSize: 100, tier: "bronze", countsTowardTier: true), [.tier("bronze"), .first100])
        XCTAssertEqual(RackRules.stickers(edition: 64, leaderboardSize: 100, tier: "bronze", countsTowardTier: false), [.first100])
        XCTAssertEqual(RackRules.stickers(edition: 300, leaderboardSize: 100, tier: nil, countsTowardTier: true), [])
        XCTAssertEqual(RackRules.stickers(edition: 300, leaderboardSize: 100, tier: "platinum", countsTowardTier: true), [])
        XCTAssertEqual(RackRules.stickers(edition: 300, leaderboardSize: 100, tier: "GOLD", countsTowardTier: true), [.tier("gold")])
    }

    func testNeverMoreThanThreeStickers() {
        let stickers = RackRules.stickers(edition: 1, leaderboardSize: 100, tier: "gold", countsTowardTier: true)
        XCTAssertEqual(stickers, [.tier("gold"), .top20, .first100])
        XCTAssertLessThanOrEqual(stickers.count, RackRules.maxStickers)
    }

    func testStickerAngleAndPlaceAreStableAndBounded() {
        for edition in [1, 7, 64, 999] {
            for slot in 0..<3 {
                let angle = RackRules.stickerAngle(slug: "lit", edition: edition, slot: slot)
                XCTAssertEqual(angle, RackRules.stickerAngle(slug: "lit", edition: edition, slot: slot))
                XCTAssertLessThanOrEqual(abs(angle), 14)
                for tagged in [false, true] {
                    let centre = RackRules.stickerCentre(slug: "lit", edition: edition, slot: slot, tagged: tagged)
                    XCTAssert((0.15...0.85).contains(centre.x), "\(centre)")
                    // Clear of the loan tag across the foot of the sleeve.
                    XCTAssertLessThan(centre.y, tagged ? 0.64 : 0.86)
                    // A sleeve without art prints its title across the top: its stickers stay below it.
                    let generic = RackRules.stickerCentre(slug: "lit", edition: edition, slot: slot, tagged: tagged, generic: true)
                    XCTAssertGreaterThan(generic.y, 0.55)
                    XCTAssertLessThan(generic.y, tagged ? 0.66 : 0.88)
                }
            }
        }
        XCTAssertNotEqual(RackRules.stickerAngle(slug: "lit", edition: 7, slot: 0), RackRules.stickerAngle(slug: "lit", edition: 8, slot: 0))
    }

    // MARK: Countdown

    func testCountdownReadsHoursMinutesSecondsUnder100Hours() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(RackRules.countdown(dropAt: now.addingTimeInterval(2 * 3600 + 14 * 60 + 7), serverNow: now), "DROP 02:14:07")
        XCTAssertEqual(RackRules.countdown(dropAt: now.addingTimeInterval(62 * 3600 + 7 * 60), serverNow: now), "DROP 62:07:00")
        XCTAssertEqual(RackRules.countdown(dropAt: now.addingTimeInterval(59.9), serverNow: now), "DROP 00:00:59")
        XCTAssertEqual(RackRules.countdown(dropAt: now.addingTimeInterval(99 * 3600 + 3599), serverNow: now), "DROP 99:59:59")
    }

    func testCountdownSwitchesToDaysAt100Hours() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(RackRules.countdown(dropAt: now.addingTimeInterval(100 * 3600), serverNow: now), "DROP 4D 04H")
        XCTAssertEqual(RackRules.countdown(dropAt: now.addingTimeInterval(12 * 86_400 + 3 * 3600), serverNow: now), "DROP12D 03H")
    }

    func testCountdownAtOrPastTheDrop() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(RackRules.countdown(dropAt: now, serverNow: now), "DROPPING")
        XCTAssertEqual(RackRules.countdown(dropAt: now.addingTimeInterval(-30), serverNow: now), "DROPPING")
        XCTAssertEqual(RackRules.countdown(dropAt: nil, serverNow: now), "DROP SOON")
    }

    func testCountdownFitsTheElevenLCDCells() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        for seconds in [1.0, 3599, 86_400, 359_999, 360_000, 9_000_000] {
            let text = RackRules.countdown(dropAt: now.addingTimeInterval(seconds), serverNow: now)
            let layout = LCDGlyphs.layout(text)
            XCTAssertLessThanOrEqual(text.replacingOccurrences(of: ":", with: "").count, LCDGlyphs.characterCount, text)
            XCTAssertEqual(String(layout.cells).trimmingCharacters(in: .whitespaces), text.replacingOccurrences(of: ":", with: "").trimmingCharacters(in: .whitespaces))
        }
        XCTAssertEqual(LCDGlyphs.layout("DROP 02:14:07").colonsAfter, [6, 8])
        XCTAssertEqual(LCDGlyphs.layout("NO     0007").colonsAfter, [])
    }

    func testServerNowCorrectsTheDeviceClock() {
        let fetched = Date(timeIntervalSince1970: 1_000_000)
        // The server was 90 s ahead of the device when the library arrived.
        let server = fetched.addingTimeInterval(90)
        let later = fetched.addingTimeInterval(10)
        XCTAssertEqual(RackRules.serverNow(deviceNow: later, serverNowAtFetch: server, fetchedAt: fetched), fetched.addingTimeInterval(100))
        XCTAssertEqual(RackRules.serverNow(deviceNow: later, serverNowAtFetch: nil, fetchedAt: fetched), later)
        let dropAt = fetched.addingTimeInterval(3600)
        XCTAssertEqual(RackRules.countdown(dropAt: dropAt, serverNow: RackRules.serverNow(deviceNow: later, serverNowAtFetch: server, fetchedAt: fetched)), "DROP 00:58:20")
    }

    // MARK: Tile state and grid

    func testTileStates() {
        let lendOut = LendInfo(lendId: "l", playsAllowed: 10, playsUsed: 4, expiresAt: nil, status: "active", endReason: nil, role: .lender)
        let lendIn = LendInfo(lendId: "b", playsAllowed: 10, playsUsed: 6, expiresAt: nil, status: "active", endReason: nil, role: .borrower)
        XCTAssertEqual(RackTileState(release: MockAPI.lit, context: nil), .owned)
        XCTAssertEqual(RackTileState(release: MockAPI.theSource, context: nil), .locked(dropAt: MockAPI.theSource.dropAt))
        var out = MockAPI.lit
        out.lend = lendOut
        XCTAssertEqual(RackTileState(release: out, context: nil), .lentOut(playsLeft: 6))
        XCTAssertEqual(RackTileState(release: out, context: nil).tagLines?.1, "06 PLAYS LEFT")
        var borrowed = MockAPI.cook
        borrowed.lend = lendIn
        let context = ReleaseContext(slug: "cook", ownership: .lent, ownerDisplayName: "Dee M.", unwrapped: true, status: "live")
        let state = RackTileState(release: borrowed, context: context)
        XCTAssertEqual(state, .borrowed(from: "Dee M.", playsLeft: 4, ended: false))
        XCTAssertEqual(state.tagLines?.0, "FROM DEE M.")
        XCTAssertEqual(state.tagLines?.1, "04 PLAYS LEFT")
    }

    func testAccessibilityLabelNamesTitleEditionStickersAndState() {
        let label = RackSpeech.label(title: "LIT", edition: 7, stickers: [.tier("bronze"), .top20], state: .lentOut(playsLeft: 6), countdown: nil)
        XCTAssertEqual(label, "LIT, edition 7, stickers: Bronze collector, Top 20, On loan, 6 plays left")
    }

    func testColumns() {
        XCTAssertEqual(RackRules.columns(regularWidth: false, largeText: false), 3)
        XCTAssertEqual(RackRules.columns(regularWidth: true, largeText: false), 4)
        XCTAssertEqual(RackRules.columns(regularWidth: false, largeText: true), 2)
    }

    // MARK: Sleeve mode (RACK-3)

    func testSleeveModeURL() {
        XCTAssertEqual(ReleaseHostController.entryURL(slug: "lit", entry: "index.html", mode: .sleeve).absoluteString, "myind-bundle://lit/index.html?mode=sleeve")
        XCTAssertEqual(ReleaseHostController.entryURL(slug: "lit", entry: "index.html", mode: .full).absoluteString, "myind-bundle://lit/index.html")
        // The policy lets the bundle's `#loading` fragment through on the sleeve page.
        var expected: URL?
        let current = URL(string: "myind-bundle://lit/index.html?mode=sleeve")!
        XCTAssertTrue(ReleaseHostController.policy(for: URL(string: "myind-bundle://lit/index.html?mode=sleeve#loading"),
                                                   targetIsMainFrame: true, slug: "lit", expected: &expected, current: current))
    }
}

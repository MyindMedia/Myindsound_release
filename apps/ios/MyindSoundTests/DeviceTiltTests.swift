import XCTest
@testable import MyindSound

/// The deck leans with the phone only: gravity against how the phone is held, scaled and clamped.
final class DeviceTiltTests: XCTestCase {
    private let held = (x: 0.0, y: -0.7, z: -0.7)

    func testLevelWhereverThePhoneIsHeld() {
        let lean = DeviceTilt.lean(gravity: held, baseline: held)
        XCTAssertEqual(lean.x, 0, accuracy: 1e-9)
        XCTAssertEqual(lean.y, 0, accuracy: 1e-9)
    }

    func testRollLeansLeftRightAndPitchForwardBack() {
        let half = DeviceTilt.fullLean / 2
        let rolled = DeviceTilt.lean(gravity: (held.x + half, held.y, held.z), baseline: held)
        XCTAssertEqual(rolled.x, 0.5, accuracy: 1e-9)
        XCTAssertEqual(rolled.y, 0, accuracy: 1e-9)
        let pitched = DeviceTilt.lean(gravity: (held.x, held.y, held.z - half), baseline: held)
        XCTAssertEqual(pitched.y, 0.5, accuracy: 1e-9)
    }

    func testClampedToAFullLean() {
        let far = DeviceTilt.lean(gravity: (1, 0, 1), baseline: held)
        XCTAssertEqual(far.x, 1)
        XCTAssertEqual(far.y, -1)
    }
}

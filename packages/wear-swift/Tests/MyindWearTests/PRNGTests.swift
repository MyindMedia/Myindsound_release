// README section 3 known answers and seed derivation.
import XCTest
@testable import MyindWear

final class PRNGTests: XCTestCase {
  func testKnownAnswerFromState1234() {
    var rng = Xoshiro128StarStar(state: (1, 2, 3, 4))
    let got = (0..<5).map { _ in rng.next() }
    XCTAssertEqual(got, [11520, 0, 5927040, 70819200, 2031721883])
  }

  func testFmix32AndSeedConstants() {
    // XOR constants from the README: 0x9E3779B9 &* (i + 1).
    XCTAssertEqual(0x9E37_79B9 &* UInt32(1), 0x9E37_79B9)
    XCTAssertEqual(0x9E37_79B9 &* UInt32(2), 0x3C6E_F372)
    XCTAssertEqual(0x9E37_79B9 &* UInt32(3), 0xDAA6_6D2B)
    XCTAssertEqual(0x9E37_79B9 &* UInt32(4), 0x78DD_E6E4)
    // fmix32 is a bijection with fmix32(0) == 0, which is what makes the fallback seed exist.
    XCTAssertEqual(fmix32(0), 0)
  }

  func testFallbackSeedProducesAllZeroWordsAndIsRescued() {
    // Each group XORs to 0 -> fmix32(0) = 0 -> all zero state -> s0 = 0x9E3779B9.
    let rng = Xoshiro128StarStar(hexSeed: "9e3779b93c6ef372daa66d2b78dde6e4")
    XCTAssertEqual(rng.s0, 0x9E37_79B9)
    XCTAssertEqual(rng.s1, 0)
    XCTAssertEqual(rng.s2, 0)
    XCTAssertEqual(rng.s3, 0)
  }

  func testSeedCaseInsensitive() {
    var a = Xoshiro128StarStar(hexSeed: "0123456789abcdef0123456789abcdef")
    var b = Xoshiro128StarStar(hexSeed: "0123456789ABCDEF0123456789ABCDEF")
    for _ in 0..<16 { XCTAssertEqual(a.next(), b.next()) }
  }

  func testRotlWraps() {
    XCTAssertEqual(rotl(0x8000_0000, 1), 1)
    XCTAssertEqual(rotl(1, 31), 0x8000_0000)
  }
}

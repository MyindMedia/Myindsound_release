// PRD section 11.6 test 1: every frozen vector matches byte for byte (or throws as expected).
import XCTest
@testable import MyindWear

final class VectorTests: XCTestCase {
  func testVectorFileIsFrozen() throws {
    let data = try Vectors.data()
    XCTAssertEqual(Vectors.sha256Hex(data), FROZEN_SHA256,
                   "wear-vectors.json changed; update FROZEN_SHA256 from packages/wear/wear-vectors.sha256 only after P1 re-froze it")
    let file = try Vectors.load()
    XCTAssertEqual(file.format, 1)
    XCTAssertEqual(file.cases.count, FROZEN_CASE_COUNT, "README promises 186 frozen cases (158 descriptors + 28 rejected)")
    XCTAssertEqual(file.cases.filter { $0.expectedError != nil }.count, 28)
    XCTAssertEqual(file.cases.filter { $0.expected != nil }.count, 158)
    XCTAssertEqual(Set(file.cases.map(\.name)).count, file.cases.count, "case names are unique")
  }

  func testEveryVectorMatchesByteForByte() throws {
    let file = try Vectors.load()
    var passed = 0
    var failures: [String] = []
    for c in file.cases {
      if let reason = Vectors.run(c) {
        failures.append("[\(c.name)] \(reason)")
        XCTFail("vector '\(c.name)' (\(c.tags.joined(separator: ","))): \(reason)")
      } else {
        passed += 1
      }
    }
    print("wear-vectors: \(passed)/\(file.cases.count) passed")
    if !failures.isEmpty {
      print(failures.joined(separator: "\n"))
    }
    XCTAssertEqual(passed, FROZEN_CASE_COUNT)
  }

  /// The 28 rejected inputs: those the typed decoder can hold must throw `WearError` with the
  /// right marker word; the rest must have been rejected by the decoder in the same family.
  func testRejectedInputsThrowWearError() throws {
    let file = try Vectors.load()
    let rejected = file.cases.filter { $0.expectedError != nil }
    XCTAssertEqual(rejected.count, 28)
    var thrownByEngine = 0
    var rejectedByDecoder = 0
    for c in rejected {
      if let family = c.input.decodeRejection {
        XCTAssertEqual(family, c.expectedError, "vector '\(c.name)'")
        rejectedByDecoder += 1
        continue
      }
      thrownByEngine += 1
      XCTAssertThrowsError(
        try computeWear(seed: c.input.seed, stats: c.input.wearStats!, version: c.input.version!,
                        safeZones: c.input.safeZones),
        "vector '\(c.name)' must throw"
      ) { error in
        guard let wearError = error as? WearError else {
          return XCTFail("vector '\(c.name)' threw a non WearError: \(error)")
        }
        XCTAssertTrue(wearError.message.contains(c.expectedError!),
                      "vector '\(c.name)': '\(wearError.message)' lacks '\(c.expectedError!)'")
      }
    }
    print("rejected inputs: \(thrownByEngine) thrown by computeWear, \(rejectedByDecoder) rejected by the typed decoder")
    XCTAssertEqual(thrownByEngine + rejectedByDecoder, 28)
  }

  /// The decoder must hand the engine the exact doubles the vectors encode, or the rounding edge
  /// and huge cases test the decoder instead of the model.
  func testJSONDecoderPreservesExtremeDoubles() throws {
    let file = try Vectors.load()
    let byName = Dictionary(uniqueKeysWithValues: file.cases.map { ($0.name, $0) })
    XCTAssertEqual(byName["huge denormal"]?.input.stats?.playSeconds, Double.leastNonzeroMagnitude)
    XCTAssertEqual(byName["huge max value overflow"]?.input.stats?.playSeconds, Double.greatestFiniteMagnitude)
    XCTAssertEqual(byName["huge safe integer"]?.input.stats?.playSeconds, 9_007_199_254_740_991)
    XCTAssertEqual(byName["rounding edge 25000 below"]?.input.stats?.playSeconds, 1139.2782823756531)
    XCTAssertEqual(byName["rounding edge 25000 at"]?.input.stats?.playSeconds, 1139.2782823756534)
    XCTAssertEqual(byName["rounding edge 25000 at"]?.input.stats?.playSeconds.nextDown,
                   byName["rounding edge 25000 below"]?.input.stats?.playSeconds,
                   "the two rounding edge inputs are adjacent doubles")
  }

  /// README section 8: `-0` stats decode as `-0.0` and produce the zero-stats descriptor.
  func testNegativeZeroStatsDecodeAndBehaveAsZero() throws {
    let file = try Vectors.load()
    let raw = String(decoding: try Vectors.data(), as: UTF8.self)
    XCTAssertTrue(raw.contains("\"playSeconds\": -0,") || raw.contains("\"playSeconds\":-0,"),
                  "the frozen file carries a literal -0 stat")
    var seen = 0
    for c in file.cases {
      guard let s = c.input.stats else { continue }
      for v in [s.playSeconds, s.lentPlaySeconds, s.loads, s.ejects] where v == 0 && v.sign == .minus {
        seen += 1
      }
    }
    XCTAssertGreaterThan(seen, 0, "JSONDecoder must keep the sign of -0 (README section 8)")
    let d = try computeWear(seed: "0123456789abcdef0123456789abcdef",
                            stats: WearStats(playSeconds: -0.0, lentPlaySeconds: -0.0, loads: -0.0, ejects: -0.0),
                            version: 1)
    let z = try computeWear(seed: "0123456789abcdef0123456789abcdef",
                            stats: WearStats(playSeconds: 0, lentPlaySeconds: 0, loads: 0, ejects: 0),
                            version: 1)
    XCTAssertEqual(try serializeDescriptor(d), try serializeDescriptor(z))
  }
}

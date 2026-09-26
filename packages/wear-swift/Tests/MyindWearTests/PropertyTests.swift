// PRD section 11.6 tests 2, 3 and 9 as property tests over deterministic pseudo random inputs,
// plus serializer and validation unit checks.
import XCTest
@testable import MyindWear

final class PropertyTests: XCTestCase {
  private let seeds = [
    "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210",
    "00000000000000000000000000000000", "ffffffffffffffffffffffffffffffff",
    "9e3779b93c6ef372daa66d2b78dde6e4", "c0ffee00c0ffee00c0ffee00c0ffee00",
    "3141592653589793238462643383279a", "27182818284590452353602874713526",
  ]

  private let zoneSets: [[WearSafeZone]?] = [
    nil,
    [],
    [WearSafeZone(surface: "label", x: 0.1, y: 0.35, w: 0.8, h: 0.3)],
    [WearSafeZone(surface: "shell", x: 0.6, y: 0.7, w: 0.3, h: 0.2),
     WearSafeZone(surface: "disc", x: 0.4, y: 0.4, w: 0.2, h: 0.2),
     WearSafeZone(surface: "window", x: 0, y: 0, w: 0.5, h: 1)],
    [WearSafeZone(surface: "shell", x: 0, y: 0, w: 1, h: 1),
     WearSafeZone(surface: "window", x: 0, y: 0, w: 1, h: 1),
     WearSafeZone(surface: "label", x: 0, y: 0, w: 1, h: 1),
     WearSafeZone(surface: "disc", x: 0, y: 0, w: 1, h: 1)],
  ]

  /// Deterministic generator for the property inputs, independent of the model PRNG.
  private func inputs() -> [(seed: String, zones: [WearSafeZone]?, stats: [WearStats])] {
    var rng = Xoshiro128StarStar(state: (0xDEAD_BEEF, 0x1234_5678, 0x9ABC_DEF0, 0x0F1E_2D3C))
    var out: [(String, [WearSafeZone]?, [WearStats])] = []
    for seed in seeds {
      for zones in zoneSets {
        // A monotone ladder of stats: every step adds a non negative amount to some field.
        var stats = WearStats(playSeconds: 0, lentPlaySeconds: 0, loads: 0, ejects: 0)
        var ladder = [stats]
        for _ in 0..<24 {
          let field = Int(rng.next() % 4)
          let step = Double(rng.next() % 20_000) * (field < 2 ? 1 : 0.01)
          switch field {
          case 0: stats.playSeconds += step
          case 1: stats.lentPlaySeconds += step
          case 2: stats.loads += step
          default: stats.ejects += step
          }
          ladder.append(stats)
        }
        ladder.append(WearStats(playSeconds: 1e9, lentPlaySeconds: 0, loads: 0, ejects: 0))
        ladder.append(WearStats(playSeconds: .greatestFiniteMagnitude, lentPlaySeconds: .greatestFiniteMagnitude,
                                loads: .greatestFiniteMagnitude, ejects: .greatestFiniteMagnitude))
        out.append((seed, zones, ladder))
      }
    }
    return out
  }

  // PRD test 2: L1 > L0 -> descriptor(L1) is a prefix superset of descriptor(L0).
  func testHigherLevelIsPrefixSupersetOfLowerLevel() throws {
    var checked = 0
    for (seed, zones, ladder) in inputs() {
      var previous: WearDescriptor? = nil
      for stats in ladder {
        let d = try computeWear(seed: seed, stats: stats, version: 1, safeZones: zones)
        if let p = previous {
          XCTAssertGreaterThanOrEqual(d.level, p.level, "level never decreases as stats grow")
          XCTAssertEqual(Array(d.scratches.prefix(p.scratches.count)), p.scratches,
                         "seed \(seed): scratches re-rolled between levels \(p.level) and \(d.level)")
          XCTAssertEqual(Array(d.scuffZones.prefix(p.scuffZones.count)), p.scuffZones,
                         "seed \(seed): scuffs re-rolled between levels \(p.level) and \(d.level)")
          checked += 1
        }
        previous = d
      }
    }
    XCTAssertGreaterThan(checked, 1000)
  }

  // PRD test 3: ceilings. Also every scratch count matches floor(level * 40) without safe zones.
  func testCeilingsHoldForEveryInput() throws {
    for (seed, zones, ladder) in inputs() {
      for stats in ladder {
        let d = try computeWear(seed: seed, stats: stats, version: 1, safeZones: zones)
        XCTAssertLessThanOrEqual(d.level, 1.0)
        XCTAssertGreaterThanOrEqual(d.level, 0)
        XCTAssertLessThanOrEqual(d.labelFade, 0.35)
        XCTAssertLessThanOrEqual(d.edgeWear, 1.0)
        XCTAssertLessThanOrEqual(d.dustAmount, 0.3)
        XCTAssertLessThanOrEqual(d.scratches.count, 40)
        XCTAssertLessThanOrEqual(d.scuffZones.count, 12)
        let lm = Int64((d.level * 1_000_000).rounded())
        XCTAssertLessThanOrEqual(d.scratches.count, Int(lm * 40 / 1_000_000))
        XCTAssertLessThanOrEqual(d.scuffZones.count, Int(lm * 12 / 1_000_000))
        if zones == nil || zones!.isEmpty {
          XCTAssertEqual(d.scratches.count, Int(lm * 40 / 1_000_000))
          XCTAssertEqual(d.scuffZones.count, Int(lm * 12 / 1_000_000))
        }
        // README section 4: geometry stays inside the surface at any angle.
        for s in d.scratches {
          let cx = Int64((s.x * 1e6).rounded()), cy = Int64((s.y * 1e6).rounded())
          let len = Int64((s.length * 1e6).rounded())
          let half = (len + 1) / 2
          XCTAssertTrue((20_000..<180_000).contains(len))
          XCTAssertTrue((0..<180).contains(s.angle))
          XCTAssertTrue((0.15..<1.0).contains(s.depth))
          XCTAssertGreaterThanOrEqual(cx - half, 10_000, "scratch runs off the left/top edge")
          XCTAssertLessThan(cx + half, 990_000, "scratch runs off the right/bottom edge")
          XCTAssertGreaterThanOrEqual(cy - half, 10_000)
          XCTAssertLessThan(cy + half, 990_000)
        }
        for z in d.scuffZones {
          let cx = Int64((z.x * 1e6).rounded()), cy = Int64((z.y * 1e6).rounded())
          let r = Int64((z.radius * 1e6).rounded())
          XCTAssertTrue((20_000..<90_000).contains(r))
          XCTAssertTrue((0.1..<0.6).contains(z.intensity))
          XCTAssertGreaterThanOrEqual(cx - r, 20_000)
          XCTAssertLessThan(cx + r, 980_000)
          XCTAssertGreaterThanOrEqual(cy - r, 20_000)
          XCTAssertLessThan(cy + r, 980_000)
        }
      }
    }
  }

  func testSaturatedLevelHitsExactCeilings() throws {
    let stats = WearStats(playSeconds: .greatestFiniteMagnitude, lentPlaySeconds: .greatestFiniteMagnitude,
                          loads: .greatestFiniteMagnitude, ejects: .greatestFiniteMagnitude)
    let d = try computeWear(seed: seeds[0], stats: stats, version: 1)
    XCTAssertEqual(d.level, 1.0)
    XCTAssertEqual(d.labelFade, 0.35)
    XCTAssertEqual(d.edgeWear, 1.0)
    XCTAssertEqual(d.dustAmount, 0.3)
    XCTAssertEqual(d.scratches.count, 40)
    XCTAssertEqual(d.scuffZones.count, 12)
  }

  // PRD test 9: no scratch or scuff intersects a declared safe zone (README clearance test).
  func testNoOutputIntersectsASafeZone() throws {
    var checkedZones = 0
    for (seed, zones, ladder) in inputs() {
      guard let zones, !zones.isEmpty else { continue }
      let micro = try validateSafeZones(zones)
      for stats in ladder {
        let d = try computeWear(seed: seed, stats: stats, version: 1, safeZones: zones)
        for s in d.scratches {
          let cx = Int64((s.x * 1e6).rounded()), cy = Int64((s.y * 1e6).rounded())
          let len = Int64((s.length * 1e6).rounded())
          for z in micro where z.surface == s.surface {
            XCTAssertFalse(z.hits(cx: cx, cy: cy, d: len, margin: 5000), "scratch on \(s.surface) hits a zone")
            checkedZones += 1
          }
        }
        for c in d.scuffZones {
          let cx = Int64((c.x * 1e6).rounded()), cy = Int64((c.y * 1e6).rounded())
          let r = Int64((c.radius * 1e6).rounded())
          for z in micro where z.surface == c.surface {
            XCTAssertFalse(z.hits(cx: cx, cy: cy, d: 2 * r, margin: 5000), "scuff on \(c.surface) hits a zone")
            checkedZones += 1
          }
        }
      }
    }
    XCTAssertGreaterThan(checkedZones, 100)
  }

  func testSafeZonesOnlyRemoveSlotsTheyHit() throws {
    let stats = WearStats(playSeconds: 1_440_000, lentPlaySeconds: 0, loads: 0, ejects: 0)
    let plain = try computeWear(seed: seeds[1], stats: stats, version: 1)
    let zoned = try computeWear(seed: seeds[1], stats: stats, version: 1, safeZones: zoneSets[2])
    // Slots are not exposed, so check the observable consequences: a slot whose first candidate
    // was not on the zone's surface is untouched (so every plain non label scratch survives, in
    // order), and a zone can only empty or re-place slots, never add any.
    let zonedKeys = zoned.scratches.map(serializeScratch)
    var cursor = 0
    for s in plain.scratches where s.surface != .label {
      guard let at = zonedKeys[cursor...].firstIndex(of: serializeScratch(s)) else {
        return XCTFail("non label scratch disappeared under a label-only zone")
      }
      cursor = at + 1
    }
    XCTAssertLessThanOrEqual(zoned.scratches.count, plain.scratches.count)
    XCTAssertLessThanOrEqual(zoned.scuffZones.count, plain.scuffZones.count)
  }

  private func serializeScratch(_ s: WearScratch) -> String {
    "\(s.surface.rawValue)|\(s.x)|\(s.y)|\(s.angle)|\(s.length)|\(s.depth)"
  }

  // README section 7 formatting examples.
  func testFormatMicro() {
    XCTAssertEqual(formatMicro(0), "0.000000")
    XCTAssertEqual(formatMicro(350_000), "0.350000")
    XCTAssertEqual(formatMicro(123_456_789), "123.456789")
    XCTAssertEqual(formatMicro(1_000_000), "1.000000")
    XCTAssertEqual(formatMicro(179_999_999), "179.999999")
    XCTAssertEqual(formatMicro(5), "0.000005")
  }

  func testToMicroRoundTripsEveryRangeEnd() throws {
    for m: Int64 in [0, 1, 5, 20_000, 980_000, 999_999, 1_000_000, 150_000, 179_999_999, 180_000_000, 300_000, 350_000] {
      XCTAssertEqual(try toMicro(Double(m) / 1_000_000, field: "t"), m)
    }
    // Every micro value in the widest field range survives the double round trip.
    for m in stride(from: Int64(0), through: 180_000_000, by: 7_919) {
      XCTAssertEqual(try toMicro(Double(m) / 1_000_000, field: "t"), m)
    }
  }

  // README section 7: the serializer refuses a value that is not an exact micro quotient.
  func testSerializerRejectsNonCanonicalValues() throws {
    for bad in [0.1234567, -0.000001, 1e300, .nan, .infinity, 0.35.nextUp] as [Double] {
      XCTAssertThrowsError(try toMicro(bad, field: "level"), "\(bad)") {
        XCTAssertEqual($0 as? WearError, .nonCanonicalValue("level"))
      }
    }
    XCTAssertEqual(try toMicro(-0.0, field: "t"), 0)
    let d = WearDescriptor(version: 1, seed: "0123456789abcdef0123456789abcdef", level: 0.5,
                           scratches: [], scuffZones: [], labelFade: 0.175, edgeWear: 0.5, dustAmount: 0.15)
    XCTAssertNoThrow(try serializeDescriptor(d))
    let broken = WearDescriptor(version: 1, seed: d.seed, level: 0.5, scratches: [], scuffZones: [],
                                labelFade: 0.1750001, edgeWear: 0.5, dustAmount: 0.15)
    XCTAssertThrowsError(try serializeDescriptor(broken)) {
      XCTAssertEqual($0 as? WearError, .nonCanonicalValue("labelFade"))
    }
  }

  func testZeroStatsExampleFromReadme() throws {
    let d = try computeWear(seed: "0123456789abcdef0123456789abcdef",
                            stats: WearStats(playSeconds: 0, lentPlaySeconds: 0, loads: 0, ejects: 0),
                            version: 1)
    XCTAssertEqual(try serializeDescriptor(d),
      "{\"version\":1,\"seed\":\"0123456789abcdef0123456789abcdef\",\"level\":0.000000,\"scratches\":[],\"scuffZones\":[],\"labelFade\":0.000000,\"edgeWear\":0.000000,\"dustAmount\":0.000000}")
  }

  func testValidationOrderAndMessages() {
    let ok = WearStats(playSeconds: 0, lentPlaySeconds: 0, loads: 0, ejects: 0)
    // version first, even when the seed is also bad
    XCTAssertThrowsError(try computeWear(seed: "bad", stats: ok, version: 7)) {
      XCTAssertEqual($0 as? WearError, .invalidVersion(7))
    }
    XCTAssertThrowsError(try computeWear(seed: "0123456789abcdef0123456789abcde", stats: ok, version: 1)) {
      XCTAssertTrue(($0 as? WearError)?.message.contains("wearSeed") == true)
    }
    // README section 1 seed rule: 32 UTF-16 units, each ASCII hex.
    for badSeed in [
      "0123456789abcdef0123456789abcdé",         // 32 Characters, non ASCII
      "0123456789abcdef0123456789abcdee\u{301}", // combining mark: 32 Characters, 33 UTF-16 units
      "0123456789abcdef0123456789abcdef\n",
      " 0123456789abcdef0123456789abcde",
      "0123456789abcdef0123456789abcdef0",
      String(repeating: "\u{FF10}", count: 32),   // fullwidth digit zero
      String(repeating: "\u{0660}", count: 32),   // Arabic-Indic digit zero
      "0123456789abcdef0123456789abcdeg",
      "",
    ] {
      XCTAssertThrowsError(try computeWear(seed: badSeed, stats: ok, version: 1), badSeed.debugDescription) {
        XCTAssertTrue(($0 as? WearError)?.message.contains("wearSeed") == true)
      }
    }
    XCTAssertNoThrow(try computeWear(seed: "0123456789ABCDEF0123456789abcdef", stats: ok, version: 1))
    XCTAssertThrowsError(try computeWear(seed: seeds[0], stats: WearStats(playSeconds: .nan, lentPlaySeconds: 0, loads: 0, ejects: 0), version: 1)) {
      XCTAssertTrue(($0 as? WearError)?.message.contains("wearStats") == true)
    }
    XCTAssertThrowsError(try computeWear(seed: seeds[0], stats: WearStats(playSeconds: 0, lentPlaySeconds: .infinity, loads: 0, ejects: 0), version: 1)) {
      XCTAssertTrue(($0 as? WearError)?.message.contains("wearStats") == true)
    }
    XCTAssertThrowsError(try computeWear(seed: seeds[0], stats: WearStats(playSeconds: 0, lentPlaySeconds: 0, loads: -0.5, ejects: 0), version: 1)) {
      XCTAssertTrue(($0 as? WearError)?.message.contains("wearStats") == true)
    }
    XCTAssertThrowsError(try computeWear(seed: seeds[0], stats: ok, version: 1,
                                         safeZones: [WearSafeZone(surface: "disc", x: .nan, y: 0, w: 0, h: 0)])) {
      XCTAssertTrue(($0 as? WearError)?.message.contains("wearSafeZones") == true)
    }
    XCTAssertThrowsError(try computeWear(seed: seeds[0], stats: ok, version: 1,
                                         safeZones: [WearSafeZone(surface: "disc", x: 0, y: -0.1, w: 0, h: 0)])) {
      XCTAssertTrue(($0 as? WearError)?.message.contains("wearSafeZones") == true)
    }
    // Negative zero is a valid stat (>= 0 holds).
    XCTAssertNoThrow(try computeWear(seed: seeds[0], stats: WearStats(playSeconds: -0.0, lentPlaySeconds: 0, loads: 0, ejects: 0), version: 1))
  }

  func testExpNegMatchesReferencePoints() throws {
    XCTAssertEqual(try expNeg(0), 1)
    XCTAssertEqual(try expNeg(.infinity), 0)
    XCTAssertEqual(try expNeg(64), 0)
    XCTAssertEqual(try expNeg(1), 0.36787944117144233, accuracy: 1e-12)
    XCTAssertEqual(try expNeg(10), 4.5399929762484854e-05, accuracy: 1e-15)
    XCTAssertThrowsError(try expNeg(.nan))
    XCTAssertThrowsError(try expNeg(-1e-300))
  }

  // Every safe zone hit test: the centre range guarantees candidates can never leave the surface,
  // and a zone that covers a whole surface empties every slot on it but no other.
  func testFullSurfaceZoneEmptiesOnlyThatSurface() throws {
    let stats = WearStats(playSeconds: 1e9, lentPlaySeconds: 0, loads: 0, ejects: 0)
    for surface in WearSurface.allCases {
      let d = try computeWear(seed: seeds[3], stats: stats, version: 1,
                              safeZones: [WearSafeZone(surface: surface.rawValue, x: 0, y: 0, w: 1, h: 1)])
      XCTAssertFalse(d.scratches.contains { $0.surface == surface })
      XCTAssertFalse(d.scuffZones.contains { $0.surface == surface })
      XCTAssertTrue(d.scratches.contains { $0.surface != surface })
    }
  }
}

// Loader for packages/wear/wear-vectors.json (README section 8).
//
// Choice: the file is referenced by relative path from this source file, not copied into test
// resources. One frozen file, one source of truth, nothing to drift. Override with the
// `MYIND_WEAR_VECTORS` environment variable when the package is built outside the monorepo.
// The freeze is enforced here too: SHA-256 must equal `packages/wear/wear-vectors.sha256`
// (mirrored in `FROZEN_SHA256`) and the case count must be `FROZEN_CASE_COUNT`.
import CryptoKit
import Foundation
import XCTest
@testable import MyindWear

let FROZEN_CASE_COUNT = 186
let FROZEN_SHA256 = "254218bd90ed67516451d196836191763183bee8902eb68ecf95cbaeaea45b82"

struct VectorFile: Decodable {
  let format: Int
  let note: String
  let cases: [VectorCase]
}

struct VectorCase: Decodable {
  let name: String
  let tags: [String]
  let input: VectorInput
  let expected: String?
  let expectedError: String?
}

/// A typed decoder cannot hold every error-case input (`version: 1.5`, a string stat, a null zone).
/// README section 8: treat "cannot decode this input" as the rejection, remembering which input
/// family failed so the test can check it against `expectedError`. Fields are decoded in the same
/// order `computeWear` validates them.
struct VectorInput: Decodable {
  let seed: String
  let version: Int?
  let stats: VectorStats?
  let wearSafeZones: [VectorZone]?
  /// Set when the JSON could not be decoded into the typed input; the value is the error family.
  let decodeRejection: String?

  enum Keys: String, CodingKey { case seed, version, stats, wearSafeZones }

  init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: Keys.self)
    var rejection: String? = nil

    if let v = try? c.decode(Int.self, forKey: .version) {
      version = v
    } else {
      version = nil
      rejection = rejection ?? "wearModelVersion"
    }
    seed = try c.decode(String.self, forKey: .seed)
    if let s = try? c.decode(VectorStats.self, forKey: .stats) {
      stats = s
    } else {
      stats = nil
      rejection = rejection ?? "wearStats"
    }
    if !c.contains(.wearSafeZones) {
      wearSafeZones = nil                       // absent key: no zones
    } else if let z = try? c.decode([VectorZone].self, forKey: .wearSafeZones) {
      wearSafeZones = z                         // a JSON null fails this decode, as required
    } else {
      wearSafeZones = nil
      rejection = rejection ?? "wearSafeZones"
    }
    decodeRejection = rejection
  }

  var wearStats: WearStats? {
    guard let stats else { return nil }
    return WearStats(playSeconds: stats.playSeconds, lentPlaySeconds: stats.lentPlaySeconds,
                     loads: stats.loads, ejects: stats.ejects)
  }
  var safeZones: [WearSafeZone]? {
    wearSafeZones?.map { WearSafeZone(surface: $0.surface, x: $0.x, y: $0.y, w: $0.w, h: $0.h) }
  }
}

struct VectorStats: Decodable {
  let playSeconds: Double
  let lentPlaySeconds: Double
  let loads: Double
  let ejects: Double
}

struct VectorZone: Decodable {
  let surface: String
  let x: Double
  let y: Double
  let w: Double
  let h: Double
}

enum Vectors {
  static func path() -> String {
    if let env = ProcessInfo.processInfo.environment["MYIND_WEAR_VECTORS"], !env.isEmpty {
      return env
    }
    // Tests/MyindWearTests/Vectors.swift -> packages/wear-swift -> packages/wear/wear-vectors.json
    let here = URL(fileURLWithPath: #filePath)
    return here
      .deletingLastPathComponent()   // MyindWearTests
      .deletingLastPathComponent()   // Tests
      .deletingLastPathComponent()   // wear-swift
      .deletingLastPathComponent()   // packages
      .appendingPathComponent("wear")
      .appendingPathComponent("wear-vectors.json")
      .path
  }

  static func data() throws -> Data {
    try Data(contentsOf: URL(fileURLWithPath: path()))
  }

  static func sha256Hex(_ data: Data) -> String {
    SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
  }

  static func load() throws -> VectorFile {
    try JSONDecoder().decode(VectorFile.self, from: data())
  }

  /// Run one case exactly as README section 8 describes. Returns nil on pass, a reason on failure.
  static func run(_ c: VectorCase) -> String? {
    let input = c.input
    if let family = input.decodeRejection {
      guard let expectedError = c.expectedError else {
        return "input could not be decoded (\(family)) but the case expects a descriptor"
      }
      if family != expectedError {
        return "input could not be decoded as \(family) but the case expects '\(expectedError)'"
      }
      return nil
    }
    guard let version = input.version, let stats = input.wearStats else {
      return "decoder invariant broken: no rejection but a missing field"
    }
    do {
      let d = try computeWear(seed: input.seed, stats: stats, version: version, safeZones: input.safeZones)
      let actual = try serializeDescriptorBytes(d)
      if let expectedError = c.expectedError {
        return "expected an error containing '\(expectedError)', got a descriptor"
      }
      guard let expected = c.expected else { return "vector has neither expected nor expectedError" }
      let want = Array(expected.utf8)
      if actual != want {
        let firstDiff = zip(actual, want).enumerated().first { $0.element.0 != $0.element.1 }?.offset
          ?? min(actual.count, want.count)
        let lo = max(0, firstDiff - 40)
        let hiA = min(actual.count, firstDiff + 40)
        let hiW = min(want.count, firstDiff + 40)
        let a = String(decoding: actual[lo..<hiA], as: UTF8.self)
        let w = String(decoding: want[lo..<hiW], as: UTF8.self)
        return "bytes differ at offset \(firstDiff) (actual \(actual.count) B, expected \(want.count) B)\n  actual:   …\(a)…\n  expected: …\(w)…"
      }
      return nil
    } catch let error as WearError {
      guard let expectedError = c.expectedError else {
        return "unexpected error: \(error.message)"
      }
      if !error.message.contains(expectedError) {
        return "error message '\(error.message)' does not contain '\(expectedError)'"
      }
      return nil
    } catch {
      return "non WearError thrown: \(error)"
    }
  }
}

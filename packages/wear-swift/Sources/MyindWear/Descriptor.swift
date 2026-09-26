// Public types: inputs, output descriptor and errors (PRD section 11.2, 11.4; README section 1).

public enum WearSurface: String, Sendable, Equatable, CaseIterable {
  case shell, window, label, disc
}

public struct WearStats: Sendable, Equatable {
  public var playSeconds: Double
  public var lentPlaySeconds: Double
  public var loads: Double
  public var ejects: Double

  public init(playSeconds: Double, lentPlaySeconds: Double, loads: Double, ejects: Double) {
    self.playSeconds = playSeconds
    self.lentPlaySeconds = lentPlaySeconds
    self.loads = loads
    self.ejects = ejects
  }
}

/// A bundle's `manifest.json` safe zone. `surface` is a String on purpose: an unknown surface is an
/// input error (`wearSafeZones`), which `computeWear` reports rather than the decoder.
/// `x, y` are the top left corner in surface UV space, all four numbers in 0...1.
public struct WearSafeZone: Sendable, Equatable {
  public var surface: String
  public var x: Double
  public var y: Double
  public var w: Double
  public var h: Double

  public init(surface: String, x: Double, y: Double, w: Double, h: Double) {
    self.surface = surface
    self.x = x
    self.y = y
    self.w = w
    self.h = h
  }
}

public struct WearScratch: Sendable, Equatable {
  public let surface: WearSurface
  public let x: Double
  public let y: Double
  public let angle: Double      // degrees from +x towards +y
  public let length: Double
  public let depth: Double
}

public struct WearScuffZone: Sendable, Equatable {
  public let surface: WearSurface
  public let x: Double
  public let y: Double
  public let radius: Double
  public let intensity: Double
}

/// Output of `computeWear`. Every number is `micro / 1e6`; `serializeDescriptor` is the only
/// canonical byte form and the only thing compared across platforms.
public struct WearDescriptor: Sendable, Equatable {
  public let version: Int
  public let seed: String       // lower case
  public let level: Double      // 0...MAX_WEAR
  public let scratches: [WearScratch]
  public let scuffZones: [WearScuffZone]
  public let labelFade: Double  // 0...0.35
  public let edgeWear: Double   // 0...1
  public let dustAmount: Double // 0...0.3
}

/// Invalid input. Nothing is clamped or reinterpreted; the first failing check throws.
/// `message` contains the same marker word the TypeScript package uses
/// (`wearModelVersion`, `wearSeed`, `wearStats`, `wearSafeZones`).
public enum WearError: Error, Equatable, CustomStringConvertible {
  case invalidVersion(Int)
  case invalidSeed(String)
  case invalidStats(String)
  case invalidSafeZones(String)
  /// Only `serializeDescriptor` throws this: a descriptor value is not `m / 1e6` for an integer
  /// `m >= 0` below 2^53 (README section 7). `computeWear` never produces one.
  case nonCanonicalValue(String)
  /// Only reachable if NaN leaks past validation (README section 2 says throw, never return).
  case internalNaN(String)

  public var message: String {
    switch self {
    case .invalidVersion(let v):
      return "wearModelVersion \(v) is not a known wear model"
    case .invalidSeed(let why):
      return "wearSeed \(why)"
    case .invalidStats(let why):
      return "wearStats \(why)"
    case .invalidSafeZones(let why):
      return "wearSafeZones \(why)"
    case .nonCanonicalValue(let field):
      return "descriptor.\(field) is not an exact micro value"
    case .internalNaN(let step):
      return "internal NaN in \(step)"
    }
  }

  public var description: String { message }
}

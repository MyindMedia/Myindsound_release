// Versioned wear model constants (README section 2, 4, 5, 6; PRD section 11.3).
// Never edit an existing version: stored copies carry wearModelVersion and must render the same
// forever. A new formula, constant or range is a new entry in `WEAR_MODELS`.

/// Half open integer range in micro-units (1e-6 of UV space, or 1e-6 degrees for angles).
public struct MicroRange: Sendable, Equatable {
  public let lo: Int64
  public let hi: Int64
  public init(_ lo: Int64, _ hi: Int64) {
    self.lo = lo
    self.hi = hi
  }
}

/// Surface weights in the order the surface walk uses: shell, window, label, disc.
public struct SurfaceWeights: Sendable, Equatable {
  public let shell: Int64
  public let window: Int64
  public let label: Int64
  public let disc: Int64
  public init(shell: Int64, window: Int64, label: Int64, disc: Int64) {
    self.shell = shell
    self.window = window
    self.label = label
    self.disc = disc
  }
  /// Weights in walk order, paired with their surface.
  var ordered: [(WearSurface, Int64)] {
    [(.shell, shell), (.window, window), (.label, label), (.disc, disc)]
  }
  var sum: Int64 { shell + window + label + disc }
}

public struct WearModelConfig: Sendable {
  public let version: Int

  // Level curve (README section 2). [DECIDE] values carry the PRD default.
  public let maxWear: Double
  public let k: Double            // [DECIDE] PRD default 0.004
  public let lentWeight: Double   // [DECIDE] PRD default 1.0
  public let secondsPerPlay: Double
  public let loadWeight: Double
  public let ejectWeight: Double

  // Stream layout (README section 5).
  public let maxScratches: Int
  public let maxScuffZones: Int
  public let placementAttempts: Int
  public let safeZoneMargin: Int64   // micro-units

  // Draw ranges (README section 4).
  public let scratchSurfaceWeights: SurfaceWeights
  public let scuffSurfaceWeights: SurfaceWeights
  public let scratchLength: MicroRange
  public let scratchAngle: MicroRange
  public let scratchEdgeInset: Int64   // centre range: [inset + half, 1e6 - inset - half)
  public let scratchDepth: MicroRange
  public let scuffRadius: MicroRange
  public let scuffEdgeInset: Int64     // centre range: [inset + radius, 1e6 - inset - radius)
  public let scuffIntensity: MicroRange

  // Scalar ceilings in micro-units (README section 6).
  public let labelFadeMax: Int64
  public let edgeWearMax: Int64
  public let dustAmountMax: Int64
}

/// Version 1. Frozen by `packages/wear/wear-vectors.json`.
public let WEAR_MODEL_V1 = WearModelConfig(
  version: 1,
  maxWear: 1.0,
  k: 0.004,
  lentWeight: 1.0,
  secondsPerPlay: 180,
  loadWeight: 0.5,
  ejectWeight: 0.5,
  maxScratches: 40,
  maxScuffZones: 12,
  placementAttempts: 8,
  safeZoneMargin: 5000,
  scratchSurfaceWeights: SurfaceWeights(shell: 35, window: 20, label: 15, disc: 30),
  scuffSurfaceWeights: SurfaceWeights(shell: 45, window: 10, label: 10, disc: 35),
  scratchLength: MicroRange(20_000, 180_000),
  scratchAngle: MicroRange(0, 180_000_000),
  scratchEdgeInset: 10_000,
  scratchDepth: MicroRange(150_000, 1_000_000),
  scuffRadius: MicroRange(20_000, 90_000),
  scuffEdgeInset: 20_000,
  scuffIntensity: MicroRange(100_000, 600_000),
  labelFadeMax: 350_000,
  edgeWearMax: 1_000_000,
  dustAmountMax: 300_000
)

/// Registry of every wear model version. Unknown versions throw `WearError.invalidVersion`.
public let WEAR_MODELS: [Int: WearModelConfig] = [
  1: WEAR_MODEL_V1,
]

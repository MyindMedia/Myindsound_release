// computeWear (README sections 1, 2, 4, 5, 6; PRD section 11.3, 11.4).
// Level is the only floating point step. Everything after it is integer micro-units (Int64).

private let MICRO: Int64 = 1_000_000

/// `exp(-x)` for `x >= 0` using only + - * /, so every IEEE 754 platform rounds identically
/// (README section 2). Never replace with the platform `exp`. NaN or negative input throws.
func expNeg(_ x: Double) throws -> Double {
  if x.isNaN || x < 0 { throw WearError.internalNaN("expNeg") }
  if !(x < 64) { return 0 }  // x >= 64, including +Infinity
  let r = x / 1024
  var p = 1.0
  var k = 12
  while k >= 1 {
    let kd = Double(k)
    p = 1 - (r * p) / kd
    k -= 1
  }
  for _ in 0..<10 {
    p = p * p
  }
  return p
}

/// Level in micro-units, evaluated with exactly the README's grouping. Overflow to +Infinity is
/// fine (`expNeg(+Infinity) = 0`). NaN cannot arise from validated input; if it does, throw.
func levelMicro(stats: WearStats, config c: WearModelConfig) throws -> Int64 {
  let lent = c.lentWeight * stats.lentPlaySeconds
  let plays = (stats.playSeconds + lent) / c.secondsPerPlay
  let loads = c.loadWeight * stats.loads
  let ejects = c.ejectWeight * stats.ejects
  let eff = (plays + loads) + ejects
  let x = c.k * eff
  let level = c.maxWear * (1 - (try expNeg(x)))
  let scaled = level * 1_000_000 + 0.5
  if scaled.isNaN { throw WearError.internalNaN("levelMicro") }
  var micro = Int64(scaled.rounded(.down))
  let ceiling = Int64((c.maxWear * 1_000_000 + 0.5).rounded(.down))
  micro = min(max(micro, 0), ceiling)
  return micro
}

/// `lo + floor((u >> 8) * (hi - lo) / 2^24)`; every product stays below 2^53.
@inline(__always)
func drawMicro(_ u: UInt32, _ range: MicroRange) -> Int64 {
  range.lo + (Int64(u >> 8) * (range.hi - range.lo)) / 16_777_216
}

/// `r = floor((u >> 8) * sum / 2^24)`, then walk shell, window, label, disc.
@inline(__always)
func drawSurface(_ u: UInt32, _ weights: SurfaceWeights) -> WearSurface {
  var r = (Int64(u >> 8) * weights.sum) / 16_777_216
  for (surface, weight) in weights.ordered {
    if r < weight { return surface }
    r -= weight
  }
  // Unreachable: r < sum by construction. Fall through to the last surface.
  return .disc
}

/// A safe zone converted outwards to integer micro-units (README section 5).
struct MicroZone {
  let surface: WearSurface
  let x0: Int64
  let y0: Int64
  let x1: Int64
  let y1: Int64

  init(_ z: WearSafeZone, surface: WearSurface) {
    self.surface = surface
    x0 = Int64((z.x * 1_000_000).rounded(.down))
    y0 = Int64((z.y * 1_000_000).rounded(.down))
    x1 = Int64(((z.x + z.w) * 1_000_000).rounded(.up))
    y1 = Int64(((z.y + z.h) * 1_000_000).rounded(.up))
  }

  /// Circle-vs-rectangle test with margin. `d` is the candidate's diameter.
  func hits(cx: Int64, cy: Int64, d: Int64, margin: Int64) -> Bool {
    let dx = 2 * max(x0 - cx, 0, cx - x1)
    let dy = 2 * max(y0 - cy, 0, cy - y1)
    let reach = d + 2 * margin
    return dx * dx + dy * dy <= reach * reach
  }
}

@inline(__always)
func clears(_ zones: [MicroZone], surface: WearSurface, cx: Int64, cy: Int64, d: Int64, margin: Int64) -> Bool {
  for z in zones where z.surface == surface {
    if z.hits(cx: cx, cy: cy, d: d, margin: margin) { return false }
  }
  return true
}

/// Round half up, integer only: `floor((levelMicro * max + 500000) / 1000000)`.
@inline(__always)
func scale(_ levelMicro: Int64, _ maxMicro: Int64) -> Int64 {
  (levelMicro * maxMicro + 500_000) / MICRO
}

@inline(__always)
func fromMicro(_ m: Int64) -> Double {
  Double(m) / 1_000_000
}

// MARK: - Validation (README section 1, checked in this order)

func validateVersion(_ version: Int) throws -> WearModelConfig {
  guard let config = WEAR_MODELS[version] else {
    throw WearError.invalidVersion(version)
  }
  return config
}

/// README section 1: exactly 32 UTF-16 code units, each ASCII `0-9a-fA-F` (JS `/^[0-9a-fA-F]{32}$/`).
/// Counting UTF-16 units (not Characters) rejects combining marks; checking each unit against the
/// ASCII set rejects fullwidth and Arabic-Indic digits, whitespace and a trailing newline.
func validateSeed(_ seed: String) throws -> String {
  let units = seed.utf16
  guard units.count == 32 else {
    throw WearError.invalidSeed("must be exactly 32 hex chars")
  }
  guard units.allSatisfy({ $0 < 0x80 && isHexByte(UInt8($0)) }) else {
    throw WearError.invalidSeed("must be hex (0-9, a-f, A-F)")
  }
  return seed.lowercased()
}

func validateStats(_ stats: WearStats) throws {
  let fields: [(String, Double)] = [
    ("playSeconds", stats.playSeconds),
    ("lentPlaySeconds", stats.lentPlaySeconds),
    ("loads", stats.loads),
    ("ejects", stats.ejects),
  ]
  for (name, value) in fields {
    guard value.isFinite, value >= 0 else {
      throw WearError.invalidStats("\(name) must be a finite number >= 0")
    }
  }
}

func validateSafeZones(_ zones: [WearSafeZone]?) throws -> [MicroZone] {
  guard let zones else { return [] }  // nil = no zones; a JSON null is the decoder's rejection
  var out: [MicroZone] = []
  out.reserveCapacity(zones.count)
  for (i, z) in zones.enumerated() {
    guard let surface = WearSurface(rawValue: z.surface) else {
      throw WearError.invalidSafeZones("[\(i)].surface must be shell, window, label or disc")
    }
    for (name, value) in [("x", z.x), ("y", z.y), ("w", z.w), ("h", z.h)] {
      guard value.isFinite, value >= 0, value <= 1 else {
        throw WearError.invalidSafeZones("[\(i)].\(name) must be a finite number in 0..1")
      }
    }
    out.append(MicroZone(z, surface: surface))
  }
  return out
}

// MARK: - computeWear

/// Deterministic wear descriptor for one copy (PRD WEAR-1..5).
/// Throws `WearError` on invalid input; nothing is clamped.
public func computeWear(
  seed rawSeed: String,
  stats: WearStats,
  version: Int,
  safeZones: [WearSafeZone]? = nil
) throws -> WearDescriptor {
  let c = try validateVersion(version)
  let seed = try validateSeed(rawSeed)
  try validateStats(stats)
  let zones = try validateSafeZones(safeZones)

  let lm = try levelMicro(stats: stats, config: c)
  var rng = Xoshiro128StarStar(hexSeed: seed)

  // Fixed stream layout: every candidate of every slot is always drawn, so a safe zone only
  // changes the slots that would have hit it.
  var scratchSlots: [WearScratch?] = []
  scratchSlots.reserveCapacity(c.maxScratches)
  for _ in 0..<c.maxScratches {
    var chosen: WearScratch? = nil
    for _ in 0..<c.placementAttempts {
      // Draw order: surface, length, angle, x, y, depth. The centre range depends on length so the
      // whole segment stays inside [inset, 1 - inset] at any angle.
      let surface = drawSurface(rng.next(), c.scratchSurfaceWeights)
      let length = drawMicro(rng.next(), c.scratchLength)
      let angle = drawMicro(rng.next(), c.scratchAngle)
      let half = (length + 1) / 2
      let centre = MicroRange(c.scratchEdgeInset + half, MICRO - c.scratchEdgeInset - half)
      let x = drawMicro(rng.next(), centre)
      let y = drawMicro(rng.next(), centre)
      let depth = drawMicro(rng.next(), c.scratchDepth)
      if chosen == nil, clears(zones, surface: surface, cx: x, cy: y, d: length, margin: c.safeZoneMargin) {
        chosen = WearScratch(
          surface: surface, x: fromMicro(x), y: fromMicro(y),
          angle: fromMicro(angle), length: fromMicro(length), depth: fromMicro(depth))
      }
    }
    scratchSlots.append(chosen)
  }

  var scuffSlots: [WearScuffZone?] = []
  scuffSlots.reserveCapacity(c.maxScuffZones)
  for _ in 0..<c.maxScuffZones {
    var chosen: WearScuffZone? = nil
    for _ in 0..<c.placementAttempts {
      // Draw order: surface, radius, x, y, intensity. Centre range keeps the circle inside.
      let surface = drawSurface(rng.next(), c.scuffSurfaceWeights)
      let radius = drawMicro(rng.next(), c.scuffRadius)
      let centre = MicroRange(c.scuffEdgeInset + radius, MICRO - c.scuffEdgeInset - radius)
      let x = drawMicro(rng.next(), centre)
      let y = drawMicro(rng.next(), centre)
      let intensity = drawMicro(rng.next(), c.scuffIntensity)
      if chosen == nil, clears(zones, surface: surface, cx: x, cy: y, d: 2 * radius, margin: c.safeZoneMargin) {
        chosen = WearScuffZone(
          surface: surface, x: fromMicro(x), y: fromMicro(y),
          radius: fromMicro(radius), intensity: fromMicro(intensity))
      }
    }
    scuffSlots.append(chosen)
  }

  // Reveal: a prefix of the fixed sequence, non empty slots only.
  let scratchCount = Int((lm * Int64(c.maxScratches)) / MICRO)
  let scuffCount = Int((lm * Int64(c.maxScuffZones)) / MICRO)
  let scratches = scratchSlots.prefix(scratchCount).compactMap { $0 }
  let scuffZones = scuffSlots.prefix(scuffCount).compactMap { $0 }

  return WearDescriptor(
    version: c.version,
    seed: seed,
    level: fromMicro(lm),
    scratches: scratches,
    scuffZones: scuffZones,
    labelFade: fromMicro(scale(lm, c.labelFadeMax)),
    edgeWear: fromMicro(scale(lm, c.edgeWearMax)),
    dustAmount: fromMicro(scale(lm, c.dustAmountMax))
  )
}

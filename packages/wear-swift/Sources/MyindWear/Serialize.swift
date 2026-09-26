// Canonical serialization (README section 7). No whitespace, fixed key order, every non integer
// number written from its micro value as `floor(m / 1e6)` `.` `m % 1e6` zero padded to 6 digits.
// Never uses the platform float formatter.

/// Recover the micro value from a descriptor double (`v = m / 1e6`): `m = round(v * 1e6)`, and
/// throw unless `m >= 0`, `m` is a safe integer (< 2^53) and `m / 1e6 == v` (README section 7).
func toMicro(_ value: Double, field: String) throws -> Int64 {
  let scaled = value * 1_000_000
  guard scaled.isFinite else { throw WearError.nonCanonicalValue(field) }
  let rounded = scaled.rounded(.toNearestOrEven)   // JS Math.round differs only at .5, which is never exact here
  guard rounded >= 0, rounded < 9_007_199_254_740_992 else { throw WearError.nonCanonicalValue(field) }
  let m = Int64(rounded)
  guard Double(m) / 1_000_000 == value else { throw WearError.nonCanonicalValue(field) }
  return m
}

/// `123456789 -> 123.456789`, `0 -> 0.000000`, `350000 -> 0.350000`.
func formatMicro(_ m: Int64) -> String {
  precondition(m >= 0, "micro values are never negative")
  let whole = m / 1_000_000
  let frac = m % 1_000_000
  var fracText = String(frac)
  if fracText.count < 6 {
    fracText = String(repeating: "0", count: 6 - fracText.count) + fracText
  }
  return "\(whole).\(fracText)"
}

@inline(__always)
private func num(_ value: Double, _ field: String) throws -> String {
  formatMicro(try toMicro(value, field: field))
}

@inline(__always)
private func str(_ s: String) -> String {
  "\"" + s + "\""   // seed and surface are lower case ASCII; never need escaping
}

/// Throws `WearError.nonCanonicalValue` if a value is not an exact micro quotient.
public func serializeDescriptor(_ d: WearDescriptor) throws -> String {
  var out = "{"
  out += "\"version\":\(d.version)"
  out += ",\"seed\":" + str(d.seed)
  out += ",\"level\":" + (try num(d.level, "level"))
  out += ",\"scratches\":["
  for (i, s) in d.scratches.enumerated() {
    if i > 0 { out += "," }
    out += "{\"surface\":" + str(s.surface.rawValue)
    out += ",\"x\":" + (try num(s.x, "scratches[\(i)].x"))
    out += ",\"y\":" + (try num(s.y, "scratches[\(i)].y"))
    out += ",\"angle\":" + (try num(s.angle, "scratches[\(i)].angle"))
    out += ",\"length\":" + (try num(s.length, "scratches[\(i)].length"))
    out += ",\"depth\":" + (try num(s.depth, "scratches[\(i)].depth"))
    out += "}"
  }
  out += "],\"scuffZones\":["
  for (i, z) in d.scuffZones.enumerated() {
    if i > 0 { out += "," }
    out += "{\"surface\":" + str(z.surface.rawValue)
    out += ",\"x\":" + (try num(z.x, "scuffZones[\(i)].x"))
    out += ",\"y\":" + (try num(z.y, "scuffZones[\(i)].y"))
    out += ",\"radius\":" + (try num(z.radius, "scuffZones[\(i)].radius"))
    out += ",\"intensity\":" + (try num(z.intensity, "scuffZones[\(i)].intensity"))
    out += "}"
  }
  out += "],\"labelFade\":" + (try num(d.labelFade, "labelFade"))
  out += ",\"edgeWear\":" + (try num(d.edgeWear, "edgeWear"))
  out += ",\"dustAmount\":" + (try num(d.dustAmount, "dustAmount"))
  out += "}"
  return out
}

/// The canonical bytes (UTF-8 of `serializeDescriptor`; the output is pure ASCII).
public func serializeDescriptorBytes(_ d: WearDescriptor) throws -> [UInt8] {
  Array(try serializeDescriptor(d).utf8)
}

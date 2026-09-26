// xoshiro128** 1.1 (README section 3). 32 bit unsigned integers only; every op wraps.

@inline(__always)
func rotl(_ x: UInt32, _ k: UInt32) -> UInt32 {
  (x &<< k) | (x &>> (32 &- k))
}

/// MurmurHash3 fmix32 finaliser, used to spread the seed words into PRNG state.
@inline(__always)
func fmix32(_ input: UInt32) -> UInt32 {
  var h = input
  h ^= h &>> 16
  h = h &* 0x85EB_CA6B
  h ^= h &>> 13
  h = h &* 0xC2B2_AE35
  h ^= h &>> 16
  return h
}

public struct Xoshiro128StarStar: Sendable {
  public private(set) var s0: UInt32
  public private(set) var s1: UInt32
  public private(set) var s2: UInt32
  public private(set) var s3: UInt32

  /// Raw state constructor (known-answer tests use `[1, 2, 3, 4]`).
  public init(state: (UInt32, UInt32, UInt32, UInt32)) {
    s0 = state.0
    s1 = state.1
    s2 = state.2
    s3 = state.3
  }

  /// Seed derivation from a validated, lower case, 32 hex char seed (README section 3).
  /// 1. Four 8 hex char groups, left to right, each a big endian UInt32 `w[i]`.
  /// 2. `s[i] = fmix32(w[i] ^ (0x9E3779B9 &* UInt32(i + 1)))`.
  /// 3. All zero state falls back to `s[0] = 0x9E3779B9`.
  public init(hexSeed seed: String) {
    let bytes = Array(seed.utf8)
    precondition(bytes.count == 32, "seed must be validated before seeding the PRNG")
    var s: [UInt32] = [0, 0, 0, 0]
    for i in 0..<4 {
      var w: UInt32 = 0
      for j in 0..<8 {
        w = (w &<< 4) | UInt32(hexNibble(bytes[i * 8 + j]))
      }
      s[i] = fmix32(w ^ (0x9E37_79B9 &* UInt32(i + 1)))
    }
    if s[0] == 0 && s[1] == 0 && s[2] == 0 && s[3] == 0 {
      s[0] = 0x9E37_79B9
    }
    s0 = s[0]
    s1 = s[1]
    s2 = s[2]
    s3 = s[3]
  }

  public mutating func next() -> UInt32 {
    let result = rotl(s1 &* 5, 7) &* 9
    let t = s1 &<< 9
    s2 ^= s0
    s3 ^= s1
    s1 ^= s2
    s0 ^= s3
    s2 ^= t
    s3 = rotl(s3, 11)
    return result
  }
}

/// ASCII hex digit (either case) to its value. Caller guarantees validity.
@inline(__always)
func hexNibble(_ c: UInt8) -> UInt8 {
  switch c {
  case 0x30...0x39: return c - 0x30          // 0-9
  case 0x61...0x66: return c - 0x61 + 10     // a-f
  case 0x41...0x46: return c - 0x41 + 10     // A-F
  default: preconditionFailure("non hex byte reached the PRNG seeder")
  }
}

@inline(__always)
func isHexByte(_ c: UInt8) -> Bool {
  (0x30...0x39).contains(c) || (0x61...0x66).contains(c) || (0x41...0x46).contains(c)
}

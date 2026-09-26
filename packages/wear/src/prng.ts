// Seeded PRNG for the wear model (PRD §11.4, WEAR-1).
//
// SWIFT PORTERS: this file is the contract. Everything here is 32 bit unsigned
// integer arithmetic. In TypeScript `Math.imul` is a wrapping 32 bit multiply and
// `>>> 0` reinterprets as unsigned; in Swift use UInt32 with the wrapping
// operators `&*`, `&+` and plain `^`, `<<`, `>>` (logical on UInt32).
//
// 1. Seed derivation (`seedToState`)
//    - `wearSeed` is exactly 32 hex characters (128 bits), case insensitive.
//    - Split into four 8 character groups. Group i (i = 0..3, left to right)
//      is parsed as a big endian UInt32 w[i].
//    - s[i] = fmix32(w[i] ^ (0x9E3779B9 &* UInt32(i + 1)))
//      where the constants are 0x9E3779B9, 0x3C6EF372, 0xDAA66D2B, 0x78DDE6E4.
//    - fmix32 is the MurmurHash3 finaliser:
//        h ^= h >> 16; h = h &* 0x85EBCA6B; h ^= h >> 13; h = h &* 0xC2B2AE35; h ^= h >> 16
//    - If all four s[i] are 0 (exactly one seed does this), set s[0] = 0x9E3779B9.
//      xoshiro must never run from an all zero state.
//
// 2. Generator: xoshiro128** 1.1 (Blackman and Vigna), state s[0..3]:
//      result = rotl(s[1] &* 5, 7) &* 9
//      t = s[1] << 9
//      s[2] ^= s[0]; s[3] ^= s[1]; s[1] ^= s[2]; s[0] ^= s[3]
//      s[2] ^= t
//      s[3] = rotl(s[3], 11)
//      return result
//    rotl(x, k) = (x << k) | (x >> (32 - k)).
//    Known answer: from state [1, 2, 3, 4] the first outputs are
//    11520, 0, 5927040, 70819200, 2031721883, ...
//
// 3. No floats are produced here. `computeWear` maps each UInt32 onto an integer
//    range itself (see `drawMicro` there).

const GOLDEN = 0x9e3779b9;

export type PrngState = [number, number, number, number];

/** MurmurHash3 fmix32 finaliser. Bijective on UInt32. */
export function fmix32(h: number): number {
  h >>>= 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

const SEED_RE = /^[0-9a-fA-F]{32}$/;

/** True when `seed` is a valid 128 bit hex wearSeed. */
export function isWearSeed(seed: unknown): seed is string {
  return typeof seed === 'string' && SEED_RE.test(seed);
}

/** Derives the 128 bit xoshiro state from a wearSeed. Throws on a malformed seed. */
export function seedToState(seed: string): PrngState {
  if (!isWearSeed(seed)) {
    throw new TypeError('wearSeed must be exactly 32 hex characters (128 bits)');
  }
  const hex = seed.toLowerCase();
  const s = [0, 1, 2, 3].map((i) => {
    const w = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
    return fmix32((w ^ Math.imul(GOLDEN, i + 1)) >>> 0);
  }) as PrngState;
  if (s[0] === 0 && s[1] === 0 && s[2] === 0 && s[3] === 0) s[0] = GOLDEN;
  return s;
}

function rotl(x: number, k: number): number {
  return ((x << k) | (x >>> (32 - k))) >>> 0;
}

/** xoshiro128** 1.1. Every output is a UInt32 in 0..2^32-1. */
export class Xoshiro128StarStar {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;

  constructor(state: readonly [number, number, number, number]) {
    [this.s0, this.s1, this.s2, this.s3] = state.map((w) => w >>> 0);
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) {
      throw new RangeError('xoshiro128** state must not be all zero');
    }
  }

  nextU32(): number {
    const result = Math.imul(rotl(Math.imul(this.s1, 5) >>> 0, 7), 9) >>> 0;
    const t = (this.s1 << 9) >>> 0;
    this.s2 = (this.s2 ^ this.s0) >>> 0;
    this.s3 = (this.s3 ^ this.s1) >>> 0;
    this.s1 = (this.s1 ^ this.s2) >>> 0;
    this.s0 = (this.s0 ^ this.s3) >>> 0;
    this.s2 = (this.s2 ^ t) >>> 0;
    this.s3 = rotl(this.s3, 11);
    return result;
  }
}

/** The wear PRNG for a seed: xoshiro128** from `seedToState(seed)`. */
export function createWearPrng(seed: string): Xoshiro128StarStar {
  return new Xoshiro128StarStar(seedToState(seed));
}

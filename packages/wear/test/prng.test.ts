import { describe, expect, it } from 'vitest';
import { Xoshiro128StarStar, createWearPrng, fmix32, seedToState } from '../src/prng';

describe('xoshiro128** core', () => {
  it('matches the reference output for state [1, 2, 3, 4]', () => {
    // Reference sequence of xoshiro128** (Blackman and Vigna) from state {1,2,3,4},
    // as used by the rand_xoshiro crate test suite.
    const rng = new Xoshiro128StarStar([1, 2, 3, 4]);
    const out = Array.from({ length: 10 }, () => rng.nextU32());
    expect(out).toEqual([
      11520, 0, 5927040, 70819200, 2031721883, 1637235492, 1287239034, 3734860849, 3729100597,
      4258142804,
    ]);
  });

  it('always returns unsigned 32 bit integers', () => {
    const rng = createWearPrng('ffffffffffffffffffffffffffffffff');
    for (let i = 0; i < 10_000; i++) {
      const v = rng.nextU32();
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('rejects an all zero state', () => {
    expect(() => new Xoshiro128StarStar([0, 0, 0, 0])).toThrow();
  });
});

describe('fmix32', () => {
  it('matches MurmurHash3 fmix32 known values', () => {
    expect(fmix32(0)).toBe(0);
    expect(fmix32(1)).toBe(0x514e28b7);
    expect(fmix32(0xffffffff)).toBe(0x81f16f39);
  });
});

describe('seed derivation', () => {
  it('splits the hex seed into four big endian words, mixes each, and is case insensitive', () => {
    const lower = seedToState('0123456789abcdef0011223344556677');
    const upper = seedToState('0123456789ABCDEF0011223344556677');
    expect(lower).toEqual(upper);
    expect(lower).toEqual([
      fmix32((0x01234567 ^ Math.imul(0x9e3779b9, 1)) >>> 0),
      fmix32((0x89abcdef ^ Math.imul(0x9e3779b9, 2)) >>> 0),
      fmix32((0x00112233 ^ Math.imul(0x9e3779b9, 3)) >>> 0),
      fmix32((0x44556677 ^ Math.imul(0x9e3779b9, 4)) >>> 0),
    ]);
  });

  it('never yields an all zero state, even for the one seed that mixes to zero', () => {
    const hex = [1, 2, 3, 4]
      .map((i) => (Math.imul(0x9e3779b9, i) >>> 0).toString(16).padStart(8, '0'))
      .join('');
    const state = seedToState(hex);
    expect(state.some((w) => w !== 0)).toBe(true);
  });

  it('rejects seeds that are not exactly 32 hex characters', () => {
    for (const bad of ['', 'abc', '0'.repeat(31), '0'.repeat(33), 'g'.repeat(32), ` ${'0'.repeat(31)}`]) {
      expect(() => seedToState(bad)).toThrow();
    }
    expect(() => seedToState(42 as unknown as string)).toThrow();
  });

  it('gives different streams for different seeds and the same stream for the same seed', () => {
    const a1 = createWearPrng('00000000000000000000000000000001');
    const a2 = createWearPrng('00000000000000000000000000000001');
    const b = createWearPrng('00000000000000000000000000000002');
    const sa1 = Array.from({ length: 16 }, () => a1.nextU32());
    const sa2 = Array.from({ length: 16 }, () => a2.nextU32());
    const sb = Array.from({ length: 16 }, () => b.nextU32());
    expect(sa1).toEqual(sa2);
    expect(sa1).not.toEqual(sb);
  });
});

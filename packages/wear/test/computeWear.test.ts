import { describe, expect, it } from 'vitest';
import { WEAR_MODEL_V1 } from '../src/config';
import { computeWear, expNeg, type SafeZone, type WearStats } from '../src/computeWear';
import { serializeDescriptor } from '../src/serialize';
import { segmentHitsRect, testRandom, testSeeds } from './helpers';

const SEED = '0123456789abcdef0123456789abcdef';
const ZERO: WearStats = { playSeconds: 0, lentPlaySeconds: 0, loads: 0, ejects: 0 };
const plays = (n: number): WearStats => ({ ...ZERO, playSeconds: n * 180 });

/** Reference level straight from the PRD §11.3 formula using Math.exp. */
function prdLevel(s: WearStats): number {
  const eff = (s.playSeconds + 1.0 * s.lentPlaySeconds) / 180 + 0.5 * s.loads + 0.5 * s.ejects;
  return 1.0 * (1 - Math.exp(-0.004 * eff));
}

describe('computeWear: formula (§11.3)', () => {
  it('zero stats give a pristine copy', () => {
    const d = computeWear(SEED, ZERO, 1);
    expect(d).toEqual({
      version: 1,
      seed: SEED,
      level: 0,
      scratches: [],
      scuffZones: [],
      labelFade: 0,
      edgeWear: 0,
      dustAmount: 0,
    });
  });

  it('level matches the PRD formula to within the 1e-6 quantum', () => {
    const cases: WearStats[] = [
      plays(1),
      plays(10),
      plays(173.2868),
      plays(500),
      { playSeconds: 1234, lentPlaySeconds: 5678, loads: 9, ejects: 7 },
      { ...ZERO, loads: 100, ejects: 100 },
      { ...ZERO, lentPlaySeconds: 180 * 300 },
    ];
    for (const s of cases) {
      expect(Math.abs(computeWear(SEED, s, 1).level - prdLevel(s))).toBeLessThanOrEqual(1e-6);
    }
  });

  it('about 173 effective plays is half the ceiling (K = 0.004)', () => {
    expect(computeWear(SEED, plays(173.2868), 1).level).toBeCloseTo(0.5, 5);
  });

  it('lent seconds count like owner seconds at LENT_WEIGHT 1, loads and ejects count half a play', () => {
    const own = computeWear(SEED, plays(40), 1);
    const lent = computeWear(SEED, { ...ZERO, lentPlaySeconds: 40 * 180 }, 1);
    const handled = computeWear(SEED, { ...ZERO, loads: 40, ejects: 40 }, 1);
    expect(lent).toEqual(own);
    expect(handled).toEqual(own);
  });

  it('scratch count is floor(level * 40) when no safe zones exist', () => {
    for (const n of [1, 5, 20, 80, 170, 400, 900, 5000]) {
      const d = computeWear(SEED, plays(n), 1);
      expect(d.scratches.length).toBe(Math.floor(d.level * WEAR_MODEL_V1.MAX_SCRATCHES + 1e-9));
      expect(d.scuffZones.length).toBe(Math.floor(d.level * WEAR_MODEL_V1.MAX_SCUFF_ZONES + 1e-9));
    }
  });

  it('the scratch count from integers equals floor(level * max) on the double level, for every level', () => {
    // Exhaustive: a port may compute the count either way (README section 5).
    for (let m = 0; m <= 1_000_000; m++) {
      for (const max of [40, 12]) {
        if (Math.floor((m / 1e6) * max) !== Math.floor((m * max) / 1e6)) throw new Error(`differs at ${m}/${max}`);
      }
    }
  });

  it('labelFade, edgeWear and dustAmount scale with level', () => {
    const d = computeWear(SEED, plays(300), 1);
    expect(d.labelFade).toBeCloseTo(d.level * 0.35, 6);
    expect(d.edgeWear).toBeCloseTo(d.level, 6);
    expect(d.dustAmount).toBeCloseTo(d.level * 0.3, 6);
  });
});

describe('computeWear: determinism (WEAR-1)', () => {
  it('same input twice gives identical output', () => {
    const zones: SafeZone[] = [{ surface: 'label', x: 0.3, y: 0.3, w: 0.4, h: 0.2 }];
    for (const seed of testSeeds(50)) {
      for (const s of [plays(3), plays(250), { playSeconds: 99, lentPlaySeconds: 7, loads: 3, ejects: 2 }]) {
        const a = computeWear(seed, s, 1, { wearSafeZones: zones });
        const b = computeWear(seed, { ...s }, 1, { wearSafeZones: zones.map((z) => ({ ...z })) });
        expect(serializeDescriptor(a)).toBe(serializeDescriptor(b));
        expect(a).toEqual(b);
      }
    }
  });

  it('does not mutate its inputs', () => {
    const s = { ...plays(200) };
    const zones: SafeZone[] = [{ surface: 'disc', x: 0.1, y: 0.1, w: 0.2, h: 0.2 }];
    const before = JSON.stringify([s, zones]);
    computeWear(SEED, s, 1, { wearSafeZones: zones });
    expect(JSON.stringify([s, zones])).toBe(before);
  });

  it('upper case seeds are normalised to lower case', () => {
    const a = computeWear(SEED.toUpperCase(), plays(100), 1);
    expect(a.seed).toBe(SEED);
    expect(a).toEqual(computeWear(SEED, plays(100), 1));
  });

  it('different seeds give different scratches', () => {
    const [s1, s2] = testSeeds(2, 7);
    expect(computeWear(s1, plays(300), 1).scratches).not.toEqual(computeWear(s2, plays(300), 1).scratches);
  });
});

describe('computeWear: versioning (§11.2)', () => {
  it('rejects unknown versions instead of reinterpreting', () => {
    for (const v of [0, 2, -1, 1.5, NaN, Infinity]) {
      expect(() => computeWear(SEED, ZERO, v)).toThrow(/wearModelVersion/);
    }
    expect(() => computeWear(SEED, ZERO, '1' as unknown as number)).toThrow(/wearModelVersion/);
    expect(() => computeWear(SEED, ZERO, new Number(1) as unknown as number)).toThrow(/wearModelVersion/);
  });
});

describe('computeWear: input validation', () => {
  it('rejects negative, NaN, infinite or missing stats (documented: reject, never clamp)', () => {
    const bad: Array<Partial<Record<keyof WearStats, unknown>>> = [
      { playSeconds: -1 },
      { lentPlaySeconds: -0.001 },
      { loads: -5 },
      { ejects: -1 },
      { playSeconds: NaN },
      { playSeconds: Infinity },
      { loads: '3' },
      { ejects: undefined },
    ];
    for (const patch of bad) {
      expect(() => computeWear(SEED, { ...ZERO, ...patch } as WearStats, 1)).toThrow(/wearStats/);
    }
  });

  it('rejects malformed seeds, including non ASCII look alikes and a trailing newline', () => {
    for (const bad of ['xyz', `${SEED}\n`, '０'.repeat(32), '٠'.repeat(32), `${SEED.slice(0, 31)}e\u0301`, ` ${SEED.slice(1)}`]) {
      expect(() => computeWear(bad, ZERO, 1)).toThrow(/wearSeed/);
    }
  });

  it('accepts negative zero stats as zero', () => {
    const d = computeWear(SEED, { playSeconds: -0, lentPlaySeconds: -0, loads: -0, ejects: -0 }, 1);
    expect(serializeDescriptor(d)).toBe(serializeDescriptor(computeWear(SEED, ZERO, 1)));
  });

  it('reads each stat once, so a getter cannot pass validation and then feed NaN', () => {
    for (const late of [NaN, -1, Infinity, 1e308 * 10]) {
      let reads = 0;
      const tricky = {
        get playSeconds() {
          reads++;
          return reads === 1 ? 1000 : late;
        },
        lentPlaySeconds: 0,
        loads: 0,
        ejects: 0,
      } as WearStats;
      const d = computeWear(SEED, tricky, 1);
      expect(reads).toBe(1);
      expect(d).toEqual(computeWear(SEED, { ...ZERO, playSeconds: 1000 }, 1));
    }
  });

  it('expNeg throws on NaN and negative input instead of returning 0', () => {
    expect(() => expNeg(NaN)).toThrow();
    expect(() => expNeg(-1)).toThrow();
    expect(expNeg(Infinity)).toBe(0);
    expect(expNeg(0)).toBe(1);
  });

  it('rejects options and zone lists that are not plain dense arrays of zone objects', () => {
    const z = { surface: 'label', x: 0, y: 0, w: 0.1, h: 0.1 };
    // eslint-disable-next-line no-sparse-arrays
    const sparse = [, z];
    const bad: unknown[] = [null, 5, 'zones'];
    for (const options of bad) {
      expect(() => computeWear(SEED, plays(10), 1, options as never)).toThrow(/wearSafeZones/);
    }
    const badZones: unknown[] = [null, 5, 'label', {}, sparse, [null], [undefined], [1], ['label'], [[0, 0, 1, 1]]];
    for (const wearSafeZones of badZones) {
      expect(() => computeWear(SEED, plays(10), 1, { wearSafeZones } as never)).toThrow(/wearSafeZones/);
    }
    // Omitted, undefined options and an undefined list all mean "no zones".
    const none = computeWear(SEED, plays(10), 1);
    expect(computeWear(SEED, plays(10), 1, undefined)).toEqual(none);
    expect(computeWear(SEED, plays(10), 1, {})).toEqual(none);
    expect(computeWear(SEED, plays(10), 1, { wearSafeZones: undefined })).toEqual(none);
  });

  it('allows a zone to run past the surface edge (x + w > 1)', () => {
    expect(() => computeWear(SEED, plays(10), 1, { wearSafeZones: [{ surface: 'disc', x: 0.9, y: 0.9, w: 0.9, h: 0.9 }] })).not.toThrow();
  });

  it('rejects malformed safe zones', () => {
    const bad = [
      { surface: 'lid', x: 0, y: 0, w: 0.1, h: 0.1 },
      { surface: 'label', x: NaN, y: 0, w: 0.1, h: 0.1 },
      { surface: 'label', x: 0, y: 0, w: -0.1, h: 0.1 },
      { surface: 'label', x: 0, y: 0, w: 0.1 },
    ];
    for (const z of bad) {
      expect(() => computeWear(SEED, plays(10), 1, { wearSafeZones: [z as SafeZone] })).toThrow(/wearSafeZones/);
    }
  });
});

describe('§11.6 test 3: ceilings hold even with absurd stats', () => {
  const absurd: WearStats[] = [
    { playSeconds: 1e12, lentPlaySeconds: 1e12, loads: 1e9, ejects: 1e9 },
    { playSeconds: Number.MAX_VALUE, lentPlaySeconds: Number.MAX_VALUE, loads: Number.MAX_VALUE, ejects: Number.MAX_VALUE },
    { playSeconds: Number.MAX_SAFE_INTEGER, lentPlaySeconds: 0, loads: 0, ejects: 0 },
    { playSeconds: 5e-324, lentPlaySeconds: 0, loads: 0, ejects: 0 },
  ];
  it('level <= MAX_WEAR, labelFade <= 0.35, dust <= 0.3, edgeWear <= 1, counts <= maxima', () => {
    const rand = testRandom(3);
    const stats = [...absurd];
    for (let i = 0; i < 300; i++) {
      const mag = 10 ** (rand() * 14);
      stats.push({ playSeconds: rand() * mag, lentPlaySeconds: rand() * mag, loads: rand() * mag, ejects: rand() * mag });
    }
    for (const seed of testSeeds(10, 11)) {
      for (const s of stats) {
        const d = computeWear(seed, s, 1);
        expect(d.level).toBeGreaterThanOrEqual(0);
        expect(d.level).toBeLessThanOrEqual(WEAR_MODEL_V1.MAX_WEAR);
        expect(d.labelFade).toBeLessThanOrEqual(0.35);
        expect(d.dustAmount).toBeLessThanOrEqual(0.3);
        expect(d.edgeWear).toBeLessThanOrEqual(1);
        expect(d.scratches.length).toBeLessThanOrEqual(40);
        expect(d.scuffZones.length).toBeLessThanOrEqual(WEAR_MODEL_V1.MAX_SCUFF_ZONES);
        for (const v of [d.level, d.labelFade, d.dustAmount, d.edgeWear]) expect(Number.isFinite(v)).toBe(true);
      }
    }
  });

  it('saturated stats reach exactly the ceiling look', () => {
    const d = computeWear(SEED, absurd[1], 1);
    expect(d.level).toBe(1);
    expect(d.labelFade).toBe(0.35);
    expect(d.dustAmount).toBe(0.3);
    expect(d.edgeWear).toBe(1);
    expect(d.scratches.length).toBe(40);
    expect(d.scuffZones.length).toBe(12);
  });

  it('every emitted number sits inside its documented range', () => {
    for (const seed of testSeeds(40, 5)) {
      const d = computeWear(seed, plays(1e6), 1);
      for (const sc of d.scratches) {
        expect(sc.angle).toBeGreaterThanOrEqual(0);
        expect(sc.angle).toBeLessThan(180);
        expect(sc.length).toBeGreaterThanOrEqual(0.02);
        expect(sc.length).toBeLessThan(0.18);
        expect(sc.depth).toBeGreaterThanOrEqual(0.15);
        expect(sc.depth).toBeLessThan(1);
      }
      for (const z of d.scuffZones) {
        expect(z.radius).toBeGreaterThanOrEqual(0.02);
        expect(z.radius).toBeLessThan(0.09);
        expect(z.intensity).toBeGreaterThanOrEqual(0.1);
        expect(z.intensity).toBeLessThan(0.6);
      }
    }
  });
});

describe('geometry stays inside the surface', () => {
  it('every scratch end point and every scuff circle lies within [0, 1] squared (inset included)', () => {
    let n = 0;
    for (const seed of testSeeds(400, 61)) {
      const d = computeWear(seed, plays(1e6), 1);
      for (const sc of d.scratches) {
        const t = (sc.angle * Math.PI) / 180;
        const hx = (Math.cos(t) * sc.length) / 2;
        const hy = (Math.sin(t) * sc.length) / 2;
        for (const v of [sc.x - hx, sc.x + hx, sc.y - hy, sc.y + hy]) {
          expect(v).toBeGreaterThanOrEqual(0.01 - 1e-12);
          expect(v).toBeLessThanOrEqual(0.99 + 1e-12);
        }
        // Integer form of the guarantee: the bounding circle clears every edge.
        expect(sc.x - sc.length / 2).toBeGreaterThanOrEqual(0.01 - 1e-12);
        expect(sc.x + sc.length / 2).toBeLessThanOrEqual(0.99 + 1e-12);
        n++;
      }
      for (const z of d.scuffZones) {
        expect(z.x - z.radius).toBeGreaterThanOrEqual(0.02 - 1e-12);
        expect(z.x + z.radius).toBeLessThanOrEqual(0.98 + 1e-12);
        expect(z.y - z.radius).toBeGreaterThanOrEqual(0.02 - 1e-12);
        expect(z.y + z.radius).toBeLessThanOrEqual(0.98 + 1e-12);
      }
    }
    expect(n).toBe(400 * 40);
  });
});

describe('monotonic level (WEAR-5)', () => {
  it('level never decreases as any single stat grows', () => {
    const rand = testRandom(17);
    const keys: Array<keyof WearStats> = ['playSeconds', 'lentPlaySeconds', 'loads', 'ejects'];
    for (let trial = 0; trial < 200; trial++) {
      let s: WearStats = { playSeconds: rand() * 1e4, lentPlaySeconds: rand() * 1e4, loads: rand() * 50, ejects: rand() * 50 };
      let prev = computeWear(SEED, s, 1).level;
      for (let step = 0; step < 60; step++) {
        const k = keys[Math.floor(rand() * keys.length)];
        s = { ...s, [k]: s[k] + rand() * (k === 'loads' || k === 'ejects' ? 5 : 3600) };
        const next = computeWear(SEED, s, 1).level;
        expect(next).toBeGreaterThanOrEqual(prev);
        prev = next;
      }
    }
  });

  it('level is non decreasing over a fine sweep of play seconds', () => {
    let prev = -1;
    for (let sec = 0; sec <= 180 * 3000; sec += 97) {
      const l = computeWear(SEED, { ...ZERO, playSeconds: sec }, 1).level;
      expect(l).toBeGreaterThanOrEqual(prev);
      prev = l;
    }
  });
});

describe('§11.6 test 2: higher level is a prefix superset (no re-rolling)', () => {
  const zoneSets: Array<SafeZone[] | undefined> = [
    undefined,
    [
      { surface: 'label', x: 0.25, y: 0.35, w: 0.5, h: 0.3 },
      { surface: 'shell', x: 0.6, y: 0.05, w: 0.35, h: 0.15 },
    ],
  ];
  it('holds for every pair of increasing levels over many seeds', () => {
    const ladder = [0, 0.5, 3, 12, 40, 90, 170, 260, 400, 700, 1200, 2500, 1e5];
    for (const zones of zoneSets) {
      for (const seed of testSeeds(120, 23)) {
        const ds = ladder.map((n) => computeWear(seed, plays(n), 1, { wearSafeZones: zones }));
        for (let i = 1; i < ds.length; i++) {
          const lo = ds[i - 1];
          const hi = ds[i];
          expect(hi.level).toBeGreaterThanOrEqual(lo.level);
          expect(hi.scratches.length).toBeGreaterThanOrEqual(lo.scratches.length);
          expect(hi.scratches.slice(0, lo.scratches.length)).toEqual(lo.scratches);
          expect(hi.scuffZones.slice(0, lo.scuffZones.length)).toEqual(lo.scuffZones);
        }
      }
    }
  });

  it('scratch N is the same scratch whichever stats produced the level', () => {
    const a = computeWear(SEED, plays(400), 1);
    const b = computeWear(SEED, { playSeconds: 0, lentPlaySeconds: 200 * 180, loads: 200, ejects: 200 }, 1);
    expect(b.level).toBe(a.level);
    expect(b.scratches).toEqual(a.scratches);
  });
});

describe('§11.6 test 9: no scratch intersects a declared safe zone', () => {
  it('holds over many seeds and random zone layouts, checked with real segment geometry', () => {
    const rand = testRandom(99);
    let checked = 0;
    for (const seed of testSeeds(300, 31)) {
      const zones: SafeZone[] = [];
      const n = 1 + Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        const w = 0.05 + rand() * 0.5;
        const h = 0.05 + rand() * 0.5;
        zones.push({
          surface: (['shell', 'window', 'label', 'disc'] as const)[Math.floor(rand() * 4)],
          x: rand() * (1 - w),
          y: rand() * (1 - h),
          w,
          h,
        });
      }
      const d = computeWear(seed, plays(1e6), 1, { wearSafeZones: zones });
      for (const sc of d.scratches) {
        for (const z of zones) {
          if (z.surface !== sc.surface) continue;
          checked++;
          expect(segmentHitsRect(sc, z)).toBe(false);
          // Bounding circle clearance: stronger than the segment test, orientation independent.
          const dx = Math.max(z.x - sc.x, 0, sc.x - (z.x + z.w));
          const dy = Math.max(z.y - sc.y, 0, sc.y - (z.y + z.h));
          expect(Math.hypot(dx, dy)).toBeGreaterThan(sc.length / 2);
        }
      }
      for (const sz of d.scuffZones) {
        for (const z of zones) {
          if (z.surface !== sz.surface) continue;
          const dx = Math.max(z.x - sz.x, 0, sz.x - (z.x + z.w));
          const dy = Math.max(z.y - sz.y, 0, sz.y - (z.y + z.h));
          expect(Math.hypot(dx, dy)).toBeGreaterThan(sz.radius);
        }
      }
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('a zone only moves the slots that would have hit it; other slots are untouched', () => {
    const zone: SafeZone = { surface: 'label', x: 0.2, y: 0.2, w: 0.6, h: 0.6 };
    for (const seed of testSeeds(40, 41)) {
      const free = computeWear(seed, plays(1e6), 1);
      const zoned = computeWear(seed, plays(1e6), 1, { wearSafeZones: [zone] });
      const freeOffLabel = free.scratches.filter((s) => s.surface !== 'label');
      // Every free scratch that is on another surface and was accepted first try stays.
      for (const s of freeOffLabel) {
        const idx = free.scratches.indexOf(s);
        expect(zoned.scratches[idx]).toEqual(s);
      }
    }
  });

  it('a surface fully covered by a zone gets no scratches or scuffs, and the sequence stays fixed', () => {
    const cover: SafeZone[] = [{ surface: 'label', x: 0, y: 0, w: 1, h: 1 }];
    for (const seed of testSeeds(30, 43)) {
      const d = computeWear(seed, plays(1e6), 1, { wearSafeZones: cover });
      expect(d.scratches.every((s) => s.surface !== 'label')).toBe(true);
      expect(d.scuffZones.every((s) => s.surface !== 'label')).toBe(true);
      expect(d.scratches.length).toBeLessThanOrEqual(40);
    }
  });

  it('every surface fully covered yields no scratches at all (all slots skipped, no throw)', () => {
    const all: SafeZone[] = (['shell', 'window', 'label', 'disc'] as const).map((surface) => ({
      surface,
      x: 0,
      y: 0,
      w: 1,
      h: 1,
    }));
    const d = computeWear(SEED, plays(1e6), 1, { wearSafeZones: all });
    expect(d.level).toBe(1);
    expect(d.scratches).toEqual([]);
    expect(d.scuffZones).toEqual([]);
  });
});

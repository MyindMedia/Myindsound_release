// Input cases for wear-vectors.json (§11.6 test 1). The expected outputs are
// computed by gen-vectors.ts once, then frozen in the JSON file.
import { WEAR_MODEL_V1 } from '../src/config';
import { computeWear, levelMicro, type SafeZone, type WearStats } from '../src/computeWear';

export interface WearVectorInput {
  seed: string;
  version: number;
  stats: WearStats;
  /** Absent means no zones. null and malformed entries appear only in error cases. */
  wearSafeZones?: SafeZone[] | null;
}

export interface WearVectorCase {
  name: string;
  tags: string[];
  input: WearVectorInput;
  /** serializeDescriptor output, byte exact. */
  expected?: string;
  /** Substring of the thrown error message, for rejected inputs. */
  expectedError?: string;
}

export interface WearVectorFile {
  format: 1;
  note: string;
  cases: WearVectorCase[];
}

const SEEDS = [
  '0123456789abcdef0123456789abcdef',
  'fedcba9876543210fedcba9876543210',
  '00000000000000000000000000000000',
  'ffffffffffffffffffffffffffffffff',
  // The one seed whose mixed state is all zero, exercising the fallback.
  '9e3779b93c6ef372daa66d2b78dde6e4',
  '5f1d3c2a9b8e7d6c4a3b2c1d0e9f8a7b',
  'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  'c0ffee00c0ffee00c0ffee00c0ffee00',
  '3141592653589793238462643383279a',
  '27182818284590452353602874713526',
];

const Z: WearStats = { playSeconds: 0, lentPlaySeconds: 0, loads: 0, ejects: 0 };
const P = (plays: number, extra: Partial<WearStats> = {}): WearStats => ({ ...Z, playSeconds: plays * 180, ...extra });

const LABEL_TITLE: SafeZone[] = [
  { surface: 'label', x: 0.1, y: 0.35, w: 0.8, h: 0.3 },
  { surface: 'label', x: 0.7, y: 0.05, w: 0.25, h: 0.12 },
];
const SHELL_EDITION: SafeZone[] = [{ surface: 'shell', x: 0.62, y: 0.78, w: 0.3, h: 0.14 }];
const MIXED: SafeZone[] = [
  ...LABEL_TITLE,
  ...SHELL_EDITION,
  { surface: 'disc', x: 0.4, y: 0.4, w: 0.2, h: 0.2 },
  { surface: 'window', x: 0, y: 0, w: 1, h: 0.25 },
];
const LABEL_COVERED: SafeZone[] = [{ surface: 'label', x: 0, y: 0, w: 1, h: 1 }];
const ALL_COVERED: SafeZone[] = (['shell', 'window', 'label', 'disc'] as const).map((surface) => ({
  surface,
  x: 0,
  y: 0,
  w: 1,
  h: 1,
}));
const EDGE_ZONES: SafeZone[] = [
  { surface: 'disc', x: 0, y: 0, w: 0, h: 0 },
  { surface: 'shell', x: 0.999999, y: 0.5, w: 0.000001, h: 0.1 },
  { surface: 'label', x: 0.123457, y: 0.654321, w: 0.0000005, h: 0.3333333 },
];

/** Smallest integer playSeconds whose level reaches `targetMicro` (for threshold cases). */
function secondsForLevel(targetMicro: number): number {
  let lo = 0;
  let hi = 180 * 1_000_000;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (levelMicro({ ...Z, playSeconds: mid }, WEAR_MODEL_V1) >= targetMicro) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The pair of adjacent-ish doubles (lo, hi) of playSeconds where the level first
 * rounds up to `targetMicro`: level(lo) < target <= level(hi). A one ulp slip in
 * a port's evaluation order shows up here first.
 */
function roundingEdge(targetMicro: number): [number, number] {
  let lo = 0;
  let hi = 180 * 1_000_000;
  for (let i = 0; i < 2000; i++) {
    const mid = lo + (hi - lo) / 2;
    if (mid === lo || mid === hi) break;
    if (levelMicro({ ...Z, playSeconds: mid }, WEAR_MODEL_V1) >= targetMicro) hi = mid;
    else lo = mid;
  }
  return [lo, hi];
}

/** playSeconds pair (lo, hi) where the level flips to `targetMicro`, other stats fixed. */
function flipPair(base: Omit<WearStats, 'playSeconds'>, targetMicro: number): [number, number] {
  let lo = 0;
  let hi = 180 * 10_000_000;
  for (let i = 0; i < 3000; i++) {
    const mid = lo + (hi - lo) / 2;
    if (mid === lo || mid === hi) break;
    if (levelMicro({ ...base, playSeconds: mid }, WEAR_MODEL_V1) >= targetMicro) hi = mid;
    else lo = mid;
  }
  return [lo, hi];
}

const SATURATED: WearStats = { ...Z, playSeconds: 180 * 8000 };

/**
 * Zones engineered around the first scratch of `seed` (slot 0, first candidate,
 * which is the scratch at index 0 with no zones). Each zone sits on that
 * scratch's surface with one edge at an exact clearance distance, so the
 * boundary rules (<= at reach^2, floor/ceil outward rounding, ceil(x + w),
 * the 0.005 margin) decide whether the candidate is kept. `off` is the edge's
 * distance in micro-units beyond exact reach (0 = touching = hit), `frac` the
 * sub-micro part of the edge.
 */
function edgeZoneCases(seed: string): Array<{ label: string; zones: SafeZone[] }> {
  const sc = computeWear(seed, SATURATED, 1).scratches[0];
  const cx = Math.round(sc.x * 1_000_000);
  const cy = Math.round(sc.y * 1_000_000);
  const len = Math.round(sc.length * 1_000_000);
  if (len % 2 !== 0) throw new Error(`edge zone seed ${seed} needs an even first scratch length`);
  const half = (len + 2 * WEAR_MODEL_V1.SAFE_ZONE_MARGIN_MICRO) / 2; // exact reach / 2
  const out: Array<{ label: string; zones: SafeZone[] }> = [];
  const push = (label: string, z: Omit<SafeZone, 'surface'>) => {
    if ([z.x, z.y, z.w, z.h].every((v) => v >= 0 && v <= 1)) out.push({ label, zones: [{ surface: sc.surface, ...z }] });
  };
  // Near edge (x0 or y0) beyond the centre: edge at c + half + off (+ frac).
  for (const [off, frac] of [[0, 0], [0, 0.5], [0, 0.7], [1, 0], [-1, 0]] as const) {
    push(`x0 off ${off} frac ${frac}`, { x: (cx + half + off + frac) / 1e6, y: (cy - 50_000) / 1e6, w: 0.1, h: 0.1 });
    push(`y0 off ${off} frac ${frac}`, { x: (cx - 50_000) / 1e6, y: (cy + half + off + frac) / 1e6, w: 0.1, h: 0.1 });
  }
  // Far edge (x1 or y1) before the centre: ceil((x + w) * 1e6) should land on c - half - off.
  // `frac` is how far below that integer the sum sits (0 = exactly on it); `split` puts a
  // fractional part on x as well, so ceil(x) + ceil(w) and floor(x) + ceil(w) differ from ceil(x + w).
  for (const [off, frac, split] of [[0, 0, 0], [0, 0.7, 0], [0, 0, 0.6], [0, 0.7, 0.6], [1, 0, 0], [1, 0, 0.6], [1, 0, 0.3]] as const) {
    const e1x = cx - half - off;
    const x0 = e1x - 100_000;
    push(`x1 off ${off} frac ${frac} split ${split}`, { x: (x0 + split) / 1e6, y: (cy - 50_000) / 1e6, w: (e1x - frac - x0 - split) / 1e6, h: 0.1 });
    const e1y = cy - half - off;
    const y0 = e1y - 100_000;
    push(`y1 off ${off} frac ${frac} split ${split}`, { x: (cx - 50_000) / 1e6, y: (y0 + split) / 1e6, w: 0.1, h: (e1y - frac - y0 - split) / 1e6 });
  }
  return out;
}

export function buildCases(): WearVectorCase[] {
  const cases: WearVectorCase[] = [];
  const add = (name: string, tags: string[], input: Omit<WearVectorInput, 'version'> & { version?: number }) => {
    const zoned = input.wearSafeZones !== undefined;
    cases.push({
      name,
      tags: [...tags, zoned ? 'safe-zones' : 'no-safe-zones'],
      input: { version: 1, ...input },
    });
  };

  // Zero stats.
  for (const seed of SEEDS.slice(0, 4)) add(`zero ${seed.slice(0, 8)}`, ['zero'], { seed, stats: Z });

  // Tiny.
  add('tiny 1s', ['tiny'], { seed: SEEDS[0], stats: { ...Z, playSeconds: 1 } });
  add('tiny 1 play', ['tiny'], { seed: SEEDS[1], stats: P(1) });
  add('tiny 3 plays', ['tiny'], { seed: SEEDS[5], stats: P(3) });
  add('tiny first scratch', ['tiny'], { seed: SEEDS[6], stats: P(6.4) });
  add('tiny one load', ['tiny', 'handling-only'], { seed: SEEDS[7], stats: { ...Z, loads: 1 } });
  add('tiny fractional', ['tiny'], { seed: SEEDS[8], stats: { playSeconds: 12.5, lentPlaySeconds: 0.25, loads: 0, ejects: 1 } });

  // Mid.
  const mids: Array<[number, Partial<WearStats>]> = [
    [25, {}],
    [50, { loads: 12, ejects: 11 }],
    [100, { lentPlaySeconds: 900 }],
    [173.2868, {}],
    [250, { loads: 40, ejects: 40 }],
    [400, {}],
    [123.456789, { lentPlaySeconds: 3333.3, loads: 7, ejects: 6 }],
    [320, { loads: 3 }],
  ];
  mids.forEach(([n, extra], i) =>
    add(`mid ${n} plays`, ['mid'], { seed: SEEDS[i % SEEDS.length], stats: P(n, extra) }),
  );

  // Saturated.
  add('saturated 2000 plays', ['saturated'], { seed: SEEDS[0], stats: P(2000) });
  add('saturated 10000 plays', ['saturated'], { seed: SEEDS[3], stats: P(10000, { loads: 500, ejects: 500 }) });
  add('saturated all seeds 9', ['saturated'], { seed: SEEDS[9], stats: P(5000) });
  add('saturated fallback seed', ['saturated'], { seed: SEEDS[4], stats: P(3000) });

  // Lent heavy.
  add('lent only 100 plays', ['lent-heavy'], { seed: SEEDS[1], stats: { ...Z, lentPlaySeconds: 180 * 100 } });
  add('lent heavy 10x own', ['lent-heavy'], { seed: SEEDS[2], stats: P(20, { lentPlaySeconds: 180 * 200 }) });
  add('lent only saturated', ['lent-heavy', 'saturated'], { seed: SEEDS[5], stats: { ...Z, lentPlaySeconds: 180 * 4000 } });
  add('lent odd seconds', ['lent-heavy'], { seed: SEEDS[6], stats: { playSeconds: 61, lentPlaySeconds: 47_123.75, loads: 2, ejects: 1 } });
  add('lent equals own', ['lent-heavy'], { seed: SEEDS[7], stats: P(150, { lentPlaySeconds: 150 * 180 }) });

  // Loads and ejects only.
  add('loads only 10', ['handling-only'], { seed: SEEDS[0], stats: { ...Z, loads: 10 } });
  add('ejects only 25', ['handling-only'], { seed: SEEDS[1], stats: { ...Z, ejects: 25 } });
  add('loads ejects 300', ['handling-only'], { seed: SEEDS[8], stats: { ...Z, loads: 300, ejects: 299 } });
  add('loads ejects saturated', ['handling-only', 'saturated'], { seed: SEEDS[9], stats: { ...Z, loads: 50_000, ejects: 50_000 } });
  add('eject without load', ['handling-only'], { seed: SEEDS[3], stats: { ...Z, ejects: 1 } });

  // Huge values.
  add('huge safe integer', ['huge'], { seed: SEEDS[0], stats: { ...Z, playSeconds: Number.MAX_SAFE_INTEGER } });
  add('huge 1e300 everywhere', ['huge'], { seed: SEEDS[1], stats: { playSeconds: 1e300, lentPlaySeconds: 1e300, loads: 1e300, ejects: 1e300 } });
  add('huge max value overflow', ['huge'], {
    seed: SEEDS[2],
    stats: { playSeconds: Number.MAX_VALUE, lentPlaySeconds: Number.MAX_VALUE, loads: Number.MAX_VALUE, ejects: Number.MAX_VALUE },
  });
  add('huge loads only', ['huge', 'handling-only'], { seed: SEEDS[3], stats: { ...Z, loads: 1e15 } });
  add('huge denormal', ['huge', 'tiny'], { seed: SEEDS[4], stats: { ...Z, playSeconds: 5e-324 } });

  // Scratch count thresholds: exactly at and one second below k/40 of the ceiling.
  for (const k of [1, 7, 20, 33, 39]) {
    const sec = secondsForLevel((k * 1_000_000) / 40);
    add(`threshold ${k}/40 at`, ['threshold'], { seed: SEEDS[k % SEEDS.length], stats: { ...Z, playSeconds: sec } });
    add(`threshold ${k}/40 below`, ['threshold'], { seed: SEEDS[k % SEEDS.length], stats: { ...Z, playSeconds: sec - 1 } });
  }

  // Rounding edges: the 1e-6 round half up flip, to the last bit of playSeconds.
  for (const target of [25_000, 333_333, 500_000, 975_000]) {
    const [lo, hi] = roundingEdge(target);
    add(`rounding edge ${target} below`, ['rounding-edge'], { seed: SEEDS[2], stats: { ...Z, playSeconds: lo } });
    add(`rounding edge ${target} at`, ['rounding-edge'], { seed: SEEDS[2], stats: { ...Z, playSeconds: hi } });
  }

  // Safe zones.
  const zoneSets: Array<[string, SafeZone[]]> = [
    ['label title', LABEL_TITLE],
    ['shell edition', SHELL_EDITION],
    ['mixed', MIXED],
    ['label covered', LABEL_COVERED],
    ['edge zones', EDGE_ZONES],
  ];
  zoneSets.forEach(([label, zones], zi) => {
    for (const [lv, stats] of [
      ['mid', P(200)],
      ['saturated', P(8000)],
    ] as const) {
      add(`zones ${label} ${lv}`, [lv], { seed: SEEDS[(zi * 2 + (lv === 'mid' ? 0 : 1)) % SEEDS.length], stats, wearSafeZones: zones });
    }
  });
  add('zones all covered', ['saturated'], { seed: SEEDS[0], stats: P(8000), wearSafeZones: ALL_COVERED });
  add('zones empty list', ['mid'], { seed: SEEDS[5], stats: P(200), wearSafeZones: [] });
  add('zones with zero stats', ['zero'], { seed: SEEDS[6], stats: Z, wearSafeZones: MIXED });
  add('zones lent heavy', ['lent-heavy'], { seed: SEEDS[7], stats: { ...Z, lentPlaySeconds: 180 * 600 }, wearSafeZones: MIXED });
  add('zones handling only', ['handling-only'], { seed: SEEDS[8], stats: { ...Z, loads: 400, ejects: 400 }, wearSafeZones: LABEL_TITLE });
  add('zones huge', ['huge'], { seed: SEEDS[9], stats: { ...Z, playSeconds: 1e300 }, wearSafeZones: MIXED });
  add('zones fallback seed', ['saturated'], { seed: SEEDS[4], stats: P(9000), wearSafeZones: MIXED });

  // Rounding edges with every stat non zero: pins the evaluation order of eff.
  const mixedFlips: Array<[Omit<WearStats, 'playSeconds'>, number]> = [
    [{ lentPlaySeconds: 1234.567, loads: 7, ejects: 6 }, 52_663],
    [{ lentPlaySeconds: 4520.455, loads: 139, ejects: 397 }, 731_146],
    [{ lentPlaySeconds: 3707.972, loads: 161, ejects: 11 }, 619_368],
    [{ lentPlaySeconds: 98.25, loads: 3, ejects: 2 }, 12_345],
    [{ lentPlaySeconds: 60_000.5, loads: 20, ejects: 19 }, 333_334],
    [{ lentPlaySeconds: 0.001, loads: 1, ejects: 1 }, 100_000],
    // Found by searching flip points against scripts/mutants.ts, so each level
    // regrouping mutant fails at least three vectors.
    [{ lentPlaySeconds: 3181.475, loads: 230, ejects: 257 }, 747_018],
    [{ lentPlaySeconds: 1136.386, loads: 315, ejects: 130 }, 882_813],
    [{ lentPlaySeconds: 885.19, loads: 346, ejects: 164 }, 664_387],
    [{ lentPlaySeconds: 3434.472, loads: 377, ejects: 150 }, 714_418],
    [{ lentPlaySeconds: 3483.201, loads: 13, ejects: 160 }, 665_927],
    [{ lentPlaySeconds: 2626.761, loads: 211, ejects: 355 }, 798_046],
    [{ lentPlaySeconds: 784.099, loads: 98, ejects: 323 }, 854_785],
    [{ lentPlaySeconds: 1005.326, loads: 315, ejects: 367 }, 787_771],
    [{ lentPlaySeconds: 2417.808, loads: 96, ejects: 252 }, 530_044],
    [{ lentPlaySeconds: 2249.998, loads: 116, ejects: 334 }, 624_607],
  ];
  mixedFlips.forEach(([base, target], i) => {
    const [lo, hi] = flipPair(base, target);
    add(`mixed flip ${target} below`, ['rounding-edge', 'mixed-edge'], { seed: SEEDS[i % SEEDS.length], stats: { ...base, playSeconds: lo } });
    add(`mixed flip ${target} at`, ['rounding-edge', 'mixed-edge'], { seed: SEEDS[i % SEEDS.length], stats: { ...base, playSeconds: hi } });
  });
  add('mixed critic point', ['rounding-edge', 'mixed-edge'], {
    seed: SEEDS[0],
    stats: { playSeconds: 29.92673113128069, lentPlaySeconds: 1234.567, loads: 7, ejects: 6 },
  });

  // Safe zone boundary geometry (clearance <=, margin, outward rounding).
  for (const seed of ['5f1d3c2a9b8e7d6c4a3b2c1d0e9f8a7b', 'a1b2c3d4e5f60718293a4b5c6d7e8f90', '3141592653589793238462643383279a']) {
    for (const { label, zones } of edgeZoneCases(seed)) {
      add(`edge ${seed.slice(0, 8)} ${label}`, ['zone-edge'], { seed, stats: SATURATED, wearSafeZones: zones });
    }
  }

  // Zones reaching or passing the surface edge are allowed (x + w > 1).
  add('zone x+w exactly 1', ['saturated'], { seed: SEEDS[1], stats: SATURATED, wearSafeZones: [{ surface: 'shell', x: 0.5, y: 0.25, w: 0.5, h: 0.75 }] });
  add('zone x+w float sum 0.7+0.3', ['saturated'], { seed: SEEDS[2], stats: SATURATED, wearSafeZones: [{ surface: 'disc', x: 0.7, y: 0.1, w: 0.3, h: 0.9 }] });
  add('zone x+w just over 1', ['saturated'], { seed: SEEDS[3], stats: SATURATED, wearSafeZones: [{ surface: 'shell', x: 0.5, y: 0.25, w: 0.5000001, h: 0.7500001 }] });
  add('zone x+w far over 1', ['saturated'], { seed: SEEDS[5], stats: SATURATED, wearSafeZones: [{ surface: 'label', x: 0.9, y: 0.9, w: 0.9, h: 0.9 }] });

  // Negative zero stats are accepted and behave as 0.
  add('negative zero stats', ['zero'], { seed: SEEDS[0], stats: { playSeconds: -0, lentPlaySeconds: -0, loads: -0, ejects: -0 } });
  add('negative zero mixed', ['mid'], { seed: SEEDS[1], stats: { playSeconds: 180 * 120, lentPlaySeconds: -0, loads: 4, ejects: -0 } });

  // Case handling: upper case seed normalises to the lower case descriptor.
  add('upper case seed', ['mid'], { seed: SEEDS[0].toUpperCase(), stats: P(250) });

  // Rejected input. Never reinterpreted.
  const err = (name: string, expectedError: string, input: WearVectorInput) =>
    cases.push({ name, tags: ['error'], input, expectedError });
  err('error version 0', 'wearModelVersion', { seed: SEEDS[0], version: 0, stats: Z });
  err('error version 2', 'wearModelVersion', { seed: SEEDS[0], version: 2, stats: P(10) });
  err('error negative play seconds', 'wearStats', { seed: SEEDS[0], version: 1, stats: { ...Z, playSeconds: -1 } });
  err('error negative ejects', 'wearStats', { seed: SEEDS[1], version: 1, stats: { ...Z, ejects: -3 } });
  err('error short seed', 'wearSeed', { seed: 'abc123', version: 1, stats: Z });
  err('error non hex seed', 'wearSeed', { seed: 'z'.repeat(32), version: 1, stats: Z });
  err('error bad zone surface', 'wearSafeZones', {
    seed: SEEDS[0],
    version: 1,
    stats: P(10),
    wearSafeZones: [{ surface: 'lid' as never, x: 0, y: 0, w: 0.1, h: 0.1 }],
  });
  err('error zone out of range', 'wearSafeZones', {
    seed: SEEDS[0],
    version: 1,
    stats: P(10),
    wearSafeZones: [{ surface: 'label', x: 0, y: 0, w: 1.5, h: 0.1 }],
  });

  err('error version 1.5', 'wearModelVersion', { seed: SEEDS[0], version: 1.5, stats: P(10) });
  err('error seed fullwidth digits', 'wearSeed', { seed: '\uff10'.repeat(32), version: 1, stats: Z });
  err('error seed arabic indic digits', 'wearSeed', { seed: '\u0660'.repeat(32), version: 1, stats: Z });
  err('error seed trailing newline', 'wearSeed', { seed: `${SEEDS[0]}\n`, version: 1, stats: Z });
  err('error seed combining mark', 'wearSeed', { seed: `${SEEDS[0].slice(0, 31)}e\u0301`, version: 1, stats: Z });
  err('error seed 33 chars', 'wearSeed', { seed: `${SEEDS[0]}0`, version: 1, stats: Z });
  err('error stats string', 'wearStats', { seed: SEEDS[0], version: 1, stats: { ...Z, loads: '3' as never } });
  err('error stats null field', 'wearStats', { seed: SEEDS[0], version: 1, stats: { ...Z, playSeconds: null as never } });
  err('error stats missing field', 'wearStats', { seed: SEEDS[0], version: 1, stats: { playSeconds: 1, lentPlaySeconds: 0, loads: 0 } as never });
  const zoneErr = (name: string, wearSafeZones: unknown) =>
    err(`error zones ${name}`, 'wearSafeZones', { seed: SEEDS[0], version: 1, stats: P(10), wearSafeZones: wearSafeZones as never });
  zoneErr('null', null);
  zoneErr('object not array', { surface: 'label', x: 0, y: 0, w: 0.1, h: 0.1 });
  zoneErr('entry null', [null]);
  zoneErr('entry number', [1]);
  zoneErr('entry string', ['label']);
  zoneErr('entry array', [[0, 0, 0.1, 0.1]]);
  zoneErr('valid then null', [{ surface: 'label', x: 0, y: 0, w: 0.1, h: 0.1 }, null]);
  zoneErr('missing h', [{ surface: 'label', x: 0, y: 0, w: 0.1 }]);
  zoneErr('string number', [{ surface: 'label', x: '0.1', y: 0, w: 0.1, h: 0.1 }]);
  zoneErr('negative w', [{ surface: 'label', x: 0.1, y: 0, w: -0.1, h: 0.1 }]);
  zoneErr('upper case surface', [{ surface: 'Label', x: 0.1, y: 0, w: 0.1, h: 0.1 }]);

  return cases;
}

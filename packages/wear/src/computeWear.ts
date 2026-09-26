// computeWear: the one shared wear function (PRD §11.3, §11.4).
//
// Used by Convex, the web bundles and (ported) Swift. Same (seed, stats,
// version, wearSafeZones) in, byte identical `serializeDescriptor` output out,
// on every platform (WEAR-1). See README.md for the full porting contract.
//
// Determinism strategy:
//  - The level is the only floating point value. It uses +, -, *, / only (all
//    correctly rounded under IEEE 754, so identical in JS and Swift) and a
//    polynomial exp, never Math.exp (whose last bit differs between libms).
//    It is then quantised to integer micro-units (1e-6).
//  - Everything after the level (counts, geometry, fades, safe zone tests) is
//    integer arithmetic in micro-units, all values < 2^53.
//  - The PRNG stream layout is fixed: every slot's candidates are always drawn,
//    whatever the level and whatever the safe zones. So scratch N is the same
//    scratch for a seed, and a higher level only reveals more of the sequence.

import {
  SURFACES,
  getWearConfig,
  type MicroRange,
  type Surface,
  type SurfaceWeights,
  type WearConfig,
} from './config';
import { createWearPrng, isWearSeed, type Xoshiro128StarStar } from './prng';

export type { Surface } from './config';

export interface WearStats {
  playSeconds: number;
  lentPlaySeconds: number;
  loads: number;
  ejects: number;
}

/**
 * A rectangle on one surface that wear must stay clear of (edition number,
 * title). Surface UV coordinates, 0..1, x/y are the top left corner.
 * Declared per bundle in manifest.json as `wearSafeZones` (§11.4).
 */
export interface SafeZone {
  surface: Surface;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * A straight scratch in surface UV space: centre (x, y), direction `angle`
 * degrees (0 <= angle < 180, measured from +x towards +y), full `length` in UV
 * units, so its end points are (x, y) +/- (length / 2) * (cos angle, sin angle).
 */
export interface Scratch {
  surface: Surface;
  x: number;
  y: number;
  angle: number;
  length: number;
  depth: number;
}

export interface ScuffZone {
  surface: Surface;
  x: number;
  y: number;
  radius: number;
  intensity: number;
}

export interface WearDescriptor {
  version: number;
  seed: string;
  level: number; // 0..MAX_WEAR
  scratches: Scratch[];
  scuffZones: ScuffZone[];
  labelFade: number; // 0..0.35
  edgeWear: number; // 0..1
  dustAmount: number; // 0..0.3
}

export interface ComputeWearOptions {
  wearSafeZones?: readonly SafeZone[];
}

export const MICRO = 1_000_000;
const TWO_POW_24 = 16_777_216;

// ---------------------------------------------------------------------------
// Validation. Order: version, seed, stats, options / safe zones. Bad input
// always throws; nothing is clamped or reinterpreted (negative stats are a
// server bug, and hiding them would hide the bug). Every input field is read
// exactly once into a local snapshot, and only the snapshot is validated and
// used, so a getter or a concurrent mutation cannot slip NaN past validation.

const STAT_KEYS = ['playSeconds', 'lentPlaySeconds', 'loads', 'ejects'] as const;

/** Reads each stat once, validates the copy. -0 is accepted and behaves as 0. */
function snapshotStats(stats: WearStats): WearStats {
  if (stats === null || typeof stats !== 'object') {
    throw new TypeError('wearStats must be an object');
  }
  const snap: WearStats = {
    playSeconds: stats.playSeconds,
    lentPlaySeconds: stats.lentPlaySeconds,
    loads: stats.loads,
    ejects: stats.ejects,
  };
  for (const k of STAT_KEYS) {
    const v = snap[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      throw new RangeError(`wearStats.${k} must be a finite number >= 0`);
    }
  }
  return snap;
}

interface ZoneMicro {
  surface: Surface;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function isUnit(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

const ZONE_SHAPE = '{ surface: shell|window|label|disc, x, y, w, h } with each number in 0..1';

/** Reads `options.wearSafeZones` once. Absent or undefined means no zones; anything else must be a valid dense array. */
function readZones(options: unknown): ZoneMicro[] {
  if (options === undefined) return [];
  if (options === null || typeof options !== 'object') {
    throw new TypeError('wearSafeZones: options must be an object or omitted');
  }
  const zones: unknown = (options as ComputeWearOptions).wearSafeZones;
  if (zones === undefined) return [];
  if (!Array.isArray(zones)) throw new TypeError('wearSafeZones must be an array');
  const n = zones.length;
  const out: ZoneMicro[] = [];
  for (let i = 0; i < n; i++) {
    if (!(i in zones)) throw new TypeError(`wearSafeZones[${i}] is a hole (sparse array)`);
    const z: unknown = zones[i];
    if (z === null || typeof z !== 'object') throw new TypeError(`wearSafeZones[${i}] must be ${ZONE_SHAPE}`);
    const r = z as Record<string, unknown>;
    const surface = r.surface;
    const x = r.x;
    const y = r.y;
    const w = r.w;
    const h = r.h;
    if (
      typeof surface !== 'string' ||
      !(SURFACES as readonly string[]).includes(surface) ||
      !isUnit(x) ||
      !isUnit(y) ||
      !isUnit(w) ||
      !isUnit(h)
    ) {
      throw new RangeError(`wearSafeZones[${i}] must be ${ZONE_SHAPE}`);
    }
    // Closed rectangle [x, x + w] x [y, y + h], rounded outwards to the micro grid.
    // x + w may exceed 1 (the zone simply runs off the surface).
    out.push({
      surface: surface as Surface,
      x0: Math.floor(x * MICRO),
      y0: Math.floor(y * MICRO),
      x1: Math.ceil((x + w) * MICRO),
      y1: Math.ceil((y + h) * MICRO),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Level (§11.3)

/**
 * exp(-x) for x >= 0 using only IEEE basic operations, so it is bit identical
 * in every language. Returns 0 for x >= 64 (exp(-64) < 2e-28, far below the
 * 1e-6 quantum) and for x = +Infinity. Throws on NaN or negative x.
 *   r = x / 1024                       (exact: power of two)
 *   p = 1; for k = 12 down to 1: p = 1 - (r * p) / k     (Taylor, Horner form)
 *   repeat 10 times: p = p * p         (p^(2^10) = exp(-x))
 */
export function expNeg(x: number): number {
  if (Number.isNaN(x) || x < 0) throw new RangeError(`wearStats produced an invalid curve input: ${x}`);
  if (!(x < 64)) return 0;
  const r = x / 1024;
  let p = 1;
  for (let k = 12; k >= 1; k--) p = 1 - (r * p) / k;
  for (let i = 0; i < 10; i++) p = p * p;
  return p;
}

/** Level in integer micro-units, 0..MAX_WEAR * 1e6. Validates a snapshot of `stats`. */
export function levelMicro(stats: WearStats, cfg: WearConfig): number {
  const s = snapshotStats(stats);
  // Exact evaluation order (left to right, no fused multiply add):
  // eff = ((playSeconds + LENT_WEIGHT * lentPlaySeconds) / SECONDS_PER_PLAY
  //        + LOAD_WEIGHT * loads) + EJECT_WEIGHT * ejects
  const eff =
    (s.playSeconds + cfg.LENT_WEIGHT * s.lentPlaySeconds) / cfg.SECONDS_PER_PLAY +
    cfg.LOAD_WEIGHT * s.loads +
    cfg.EJECT_WEIGHT * s.ejects;
  const level = cfg.MAX_WEAR * (1 - expNeg(cfg.K * eff));
  // Round half up to the 1e-6 grid, then clamp (belt and braces: level is
  // already within 0..MAX_WEAR by construction).
  const micro = Math.floor(level * MICRO + 0.5);
  if (Number.isNaN(micro)) throw new RangeError('wearStats produced NaN');
  const maxMicro = Math.floor(cfg.MAX_WEAR * MICRO + 0.5);
  return Math.min(Math.max(micro, 0), maxMicro);
}

// ---------------------------------------------------------------------------
// Integer draws

/** Uniform integer in [lo, hi) from one UInt32: lo + floor((u >> 8) * (hi - lo) / 2^24). */
function drawMicro(u: number, [lo, hi]: MicroRange): number {
  return lo + Math.floor(((u >>> 8) * (hi - lo)) / TWO_POW_24);
}

/** Weighted surface pick from one UInt32: r = floor((u >> 8) * total / 2^24), walk the cumulative weights. */
function drawSurface(u: number, weights: SurfaceWeights): Surface {
  let total = 0;
  for (const w of weights) total += w;
  let r = Math.floor(((u >>> 8) * total) / TWO_POW_24);
  for (let i = 0; i < SURFACES.length; i++) {
    if (r < weights[i]) return SURFACES[i];
    r -= weights[i];
  }
  // Unreachable: r < total because (u >> 8) < 2^24.
  throw new Error('unreachable: surface weights');
}

/**
 * True when a circle (centre cx, cy, diameter d, micro-units) plus the margin
 * touches any zone on the same surface. Scratches use the circle around the
 * segment (diameter = length), so the test is exact integer maths, needs no
 * trigonometry, and holds for any angle. Compared doubled to stay integral:
 *   (2 * dx)^2 + (2 * dy)^2 <= (d + 2 * margin)^2   means "hit".
 */
function hitsZone(
  surface: Surface,
  cx: number,
  cy: number,
  d: number,
  zones: readonly ZoneMicro[],
  margin: number,
): boolean {
  const reach = d + 2 * margin;
  for (const z of zones) {
    if (z.surface !== surface) continue;
    const dx = 2 * Math.max(z.x0 - cx, 0, cx - z.x1);
    const dy = 2 * Math.max(z.y0 - cy, 0, cy - z.y1);
    if (dx * dx + dy * dy <= reach * reach) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Fixed candidate sequences

interface ScratchMicro {
  surface: Surface;
  x: number;
  y: number;
  angle: number;
  length: number;
  depth: number;
}

interface ScuffMicro {
  surface: Surface;
  x: number;
  y: number;
  radius: number;
  intensity: number;
}

/**
 * Slot i (0..MAX_SCRATCHES-1) draws PLACEMENT_ATTEMPTS candidates, ALWAYS,
 * each as 6 UInt32 in the order surface, length, angle, x, y, depth. The centre
 * range depends on the length so the segment stays inside the surface. The slot
 * takes its first candidate that clears every safe zone on its surface; if none
 * does, the slot is empty (skipped). Because every candidate is always drawn,
 * safe zones never shift the stream for later slots.
 *
 *   chosen = null
 *   for a in 0..<8 { c = draw(); if chosen == null && !hit(c) { chosen = c } }   // no break
 */
function scratchSlots(rng: Xoshiro128StarStar, cfg: WearConfig, zones: readonly ZoneMicro[]): Array<ScratchMicro | null> {
  const r = cfg.scratch;
  const slots: Array<ScratchMicro | null> = [];
  for (let i = 0; i < cfg.MAX_SCRATCHES; i++) {
    let chosen: ScratchMicro | null = null;
    for (let a = 0; a < cfg.PLACEMENT_ATTEMPTS; a++) {
      const surface = drawSurface(rng.nextU32(), r.surfaceWeights);
      const length = drawMicro(rng.nextU32(), r.length);
      const angle = drawMicro(rng.nextU32(), r.angle);
      const half = Math.floor((length + 1) / 2); // ceil(length / 2)
      const pos: MicroRange = [r.edgeInset + half, MICRO - r.edgeInset - half];
      const x = drawMicro(rng.nextU32(), pos);
      const y = drawMicro(rng.nextU32(), pos);
      const depth = drawMicro(rng.nextU32(), r.depth);
      if (chosen === null && !hitsZone(surface, x, y, length, zones, cfg.SAFE_ZONE_MARGIN_MICRO)) {
        chosen = { surface, x, y, angle, length, depth };
      }
    }
    slots.push(chosen);
  }
  return slots;
}

/** Same scheme for scuffs, drawn after all scratch slots: 5 UInt32 per candidate (surface, radius, x, y, intensity). */
function scuffSlots(rng: Xoshiro128StarStar, cfg: WearConfig, zones: readonly ZoneMicro[]): Array<ScuffMicro | null> {
  const r = cfg.scuff;
  const slots: Array<ScuffMicro | null> = [];
  for (let i = 0; i < cfg.MAX_SCUFF_ZONES; i++) {
    let chosen: ScuffMicro | null = null;
    for (let a = 0; a < cfg.PLACEMENT_ATTEMPTS; a++) {
      const surface = drawSurface(rng.nextU32(), r.surfaceWeights);
      const radius = drawMicro(rng.nextU32(), r.radius);
      const pos: MicroRange = [r.edgeInset + radius, MICRO - r.edgeInset - radius];
      const x = drawMicro(rng.nextU32(), pos);
      const y = drawMicro(rng.nextU32(), pos);
      const intensity = drawMicro(rng.nextU32(), r.intensity);
      if (chosen === null && !hitsZone(surface, x, y, 2 * radius, zones, cfg.SAFE_ZONE_MARGIN_MICRO)) {
        chosen = { surface, x, y, radius, intensity };
      }
    }
    slots.push(chosen);
  }
  return slots;
}

/** Round half up of levelMicro * maxMicro / 1e6, integer only. */
function scaleMicro(levelM: number, maxMicro: number): number {
  return Math.floor((levelM * maxMicro + MICRO / 2) / MICRO);
}

/** Number of slots revealed: floor(levelMicro * max / 1e6), integer only. */
function revealCount(levelM: number, max: number): number {
  return Math.floor((levelM * max) / MICRO);
}

const toUnit = (m: number): number => m / MICRO;

// ---------------------------------------------------------------------------

/**
 * Computes the wear descriptor for one copy.
 * Throws on an unknown version, a malformed seed, negative or non finite stats,
 * or malformed safe zones. Never mutates its inputs.
 */
export function computeWear(
  seed: string,
  stats: WearStats,
  version: number,
  options?: ComputeWearOptions,
): WearDescriptor {
  const cfg = getWearConfig(version);
  if (!isWearSeed(seed)) throw new TypeError('wearSeed must be exactly 32 hex characters (128 bits)');
  const snap = snapshotStats(stats);
  const zones = readZones(options);

  const levelM = levelMicro(snap, cfg);

  // The full fixed sequence is generated regardless of level (no re-rolls).
  const rng = createWearPrng(seed);
  const scratchSeq = scratchSlots(rng, cfg, zones);
  const scuffSeq = scuffSlots(rng, cfg, zones);

  const scratches: Scratch[] = [];
  for (const s of scratchSeq.slice(0, revealCount(levelM, cfg.MAX_SCRATCHES))) {
    if (s === null) continue;
    scratches.push({
      surface: s.surface,
      x: toUnit(s.x),
      y: toUnit(s.y),
      angle: toUnit(s.angle),
      length: toUnit(s.length),
      depth: toUnit(s.depth),
    });
  }
  const scuffZones: ScuffZone[] = [];
  for (const s of scuffSeq.slice(0, revealCount(levelM, cfg.MAX_SCUFF_ZONES))) {
    if (s === null) continue;
    scuffZones.push({
      surface: s.surface,
      x: toUnit(s.x),
      y: toUnit(s.y),
      radius: toUnit(s.radius),
      intensity: toUnit(s.intensity),
    });
  }

  return {
    version: cfg.version,
    seed: seed.toLowerCase(),
    level: toUnit(levelM),
    scratches,
    scuffZones,
    labelFade: toUnit(scaleMicro(levelM, cfg.LABEL_FADE_MAX_MICRO)),
    edgeWear: toUnit(scaleMicro(levelM, cfg.EDGE_WEAR_MAX_MICRO)),
    dustAmount: toUnit(scaleMicro(levelM, cfg.DUST_MAX_MICRO)),
  };
}

/**
 * Timings and the fold maths for unwrapping the cartridge (`wrap.ts`). Two beats and no more: the plastic
 * peels off the printed sleeve and is carried out of shot, then the sleeve slides down off the screen.
 * Pure, so it's unit-tested.
 */

export const UNWRAP = {
  /** The film tightens before it gives. */
  squeeze: { at: 0, duration: 0.45 },
  /** Beat one: the plastic peels off in one pass, from the far corner to the near one. */
  peel: { at: 0.35, duration: 1.85 },
  /** ...and the coil is carried out of shot as it finishes rolling. */
  discard: { at: 1.95, duration: 1.4 },
  /** Beat two: the sleeve slides down and off the screen. */
  slide: { at: 3.3, duration: 1.7 },
  /** The sleeve is off the screen: only now does the rest of the site fade in. */
  revealAt: 5.05,
  total: 5.4,
} as const;

/** 0 before `at`, 1 after `at + duration`, eased in between (smoothstep). */
export function phase(elapsed: number, at: number, duration: number): number {
  const t = Math.max(0, Math.min(1, (elapsed - at) / Math.max(1e-6, duration)));
  return t * t * (3 - 2 * t);
}

/**
 * Where the fold sits, measured along the peel direction in the sheet's own units. It starts past the far
 * corner (nothing curled) and ends past the near one (all of it rolled up).
 * `extent` is half the sheet's reach along that direction.
 */
export function foldAt(progress: number, extent: number, radius: number): number {
  const start = extent + radius;
  const end = -extent - radius * 2;
  return start + (end - start) * Math.max(0, Math.min(1, progress));
}

/** Curl angle of a point `distance` past the fold, capped so the roll never eats itself. */
export function curlAngle(distance: number, radius: number, maxTurns = 1.6): number {
  return Math.min(Math.max(0, distance) / radius, Math.PI * maxTurns);
}

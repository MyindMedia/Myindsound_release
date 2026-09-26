// Test helpers: a seed generator independent of the wear PRNG, and a trig based
// segment vs rectangle check that does not reuse the production safe zone code.
import type { SafeZone, Scratch } from '../src/computeWear';

/** Deterministic 32 hex char seeds from a simple LCG, so failures are reproducible. */
export function testSeeds(count: number, salt = 1): string[] {
  let s = (0x12345678 ^ salt) >>> 0;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
  return Array.from({ length: count }, () =>
    [next(), next(), next(), next()].map((w) => w.toString(16).padStart(8, '0')).join(''),
  );
}

/** Small deterministic float source for property tests. */
export function testRandom(salt: number): () => number {
  let s = (0x9e3779b9 ^ salt) >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Liang-Barsky clip: does the scratch segment touch the closed rectangle? */
export function segmentHitsRect(sc: Scratch, z: SafeZone): boolean {
  const theta = (sc.angle * Math.PI) / 180;
  const hx = (Math.cos(theta) * sc.length) / 2;
  const hy = (Math.sin(theta) * sc.length) / 2;
  const x0 = sc.x - hx;
  const y0 = sc.y - hy;
  const dx = 2 * hx;
  const dy = 2 * hy;
  let t0 = 0;
  let t1 = 1;
  const p = [-dx, dx, -dy, dy];
  const q = [x0 - z.x, z.x + z.w - x0, y0 - z.y, z.y + z.h - y0];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
    } else {
      const r = q[i] / p[i];
      if (p[i] < 0) t0 = Math.max(t0, r);
      else t1 = Math.min(t1, r);
      if (t0 > t1) return false;
    }
  }
  return true;
}

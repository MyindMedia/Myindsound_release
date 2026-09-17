import { describe, expect, test } from 'vitest';
import { curlAngle, foldAt, phase, UNWRAP } from './wrap-math';

describe('unwrap timings', () => {
  test('the phases run in order and finish inside the sequence', () => {
    const { squeeze, peel, discard, slide, revealAt, total } = UNWRAP;
    expect(squeeze.at).toBeLessThan(peel.at);
    for (const window of [peel, discard, slide]) {
      expect(window.at + window.duration).toBeLessThanOrEqual(total);
    }
    // Two beats: the plastic is gone before the sleeve starts moving.
    expect(slide.at).toBeGreaterThanOrEqual(discard.at + discard.duration * 0.9);
    // The disc is clear once the sleeve is off, and before the sequence ends.
    expect(revealAt).toBeGreaterThanOrEqual(slide.at + slide.duration * 0.85);
    expect(revealAt).toBeLessThan(total);
  });

  test('phase eases from 0 to 1 across its window and holds outside it', () => {
    expect(phase(0, 1, 2)).toBe(0);
    expect(phase(1, 1, 2)).toBe(0);
    expect(phase(2, 1, 2)).toBeCloseTo(0.5);
    expect(phase(3, 1, 2)).toBe(1);
    expect(phase(99, 1, 2)).toBe(1);
  });
});

describe('peel fold', () => {
  test('starts clear of the sheet and ends past the other side, so nothing is left flat', () => {
    const extent = 0.5;
    const radius = 0.05;
    expect(foldAt(0, extent, radius)).toBeGreaterThan(extent);
    expect(foldAt(1, extent, radius)).toBeLessThan(-extent);
    expect(foldAt(0.5, extent, radius)).toBeLessThan(foldAt(0.2, extent, radius));
  });

  test('the curl grows with distance past the fold and is capped', () => {
    expect(curlAngle(-1, 0.05)).toBe(0);
    expect(curlAngle(0.05, 0.05)).toBeCloseTo(1);
    expect(curlAngle(99, 0.05)).toBeCloseTo(Math.PI * 1.6);
  });
});

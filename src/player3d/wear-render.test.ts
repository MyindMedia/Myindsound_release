import { describe, expect, test } from 'vitest';
import { computeWear, type SafeZone } from '../../packages/wear/src';
import manifest from '../../bundles/lit/bundle.json';
import { clipSegment, DEFAULT_LAYOUT, planWear, type Clip, type LayerSpec, type WearInput, type WearLayerName } from './wear-render';

const SPECS: Record<WearLayerName, LayerSpec> = {
  shell: { width: 1000, height: 800, worldWidth: 0.84 },
  label: { width: 500, height: 280, worldWidth: 0.3 },
  disc: { width: 1000, height: 1000, worldWidth: 0.74 },
};
const ZONES = manifest.wearSafeZones as SafeZone[];

const empty: WearInput = { seed: '0'.repeat(32), level: 0, scratches: [], scuffZones: [], labelFade: 0, edgeWear: 0, dustAmount: 0 };

function seedFor(i: number): string {
  return (i * 2654435761 >>> 0).toString(16).padStart(8, '0').repeat(4);
}

function worn(seed: string, level: number) {
  // Plays solved from the §11.3 curve (K = 0.004, 180 s a play).
  const plays = level >= 1 ? 1e7 : -Math.log(1 - level) / 0.004;
  return computeWear(seed, { playSeconds: plays * 180, lentPlaySeconds: 0, loads: 0, ejects: 0 }, 1, { wearSafeZones: ZONES });
}

/** Distance from a point to a closed rectangle. */
function rectDistance(x: number, y: number, r: { x0: number; y0: number; x1: number; y1: number }): number {
  return Math.hypot(Math.max(r.x0 - x, 0, x - r.x1), Math.max(r.y0 - y, 0, y - r.y1));
}

function insideClip(x: number, y: number, clip: Clip, eps = 1e-6): boolean {
  if (clip.kind === 'ellipse') return ((x - clip.cx) / clip.rx) ** 2 + ((y - clip.cy) / clip.ry) ** 2 <= 1 + eps;
  const r = Math.hypot(x - clip.cx, y - clip.cy);
  return r <= clip.outer * (1 + eps) && r >= clip.inner * (1 - eps);
}

describe('planWear', () => {
  test('level 0 draws nothing on any layer', () => {
    const plan = planWear(empty, SPECS);
    for (const layer of Object.values(plan.layers)) expect(layer.groups).toEqual([]);
    expect(plan.labelFade).toBe(0);
    expect(plan.edgeWear).toBe(0);
  });

  test('each surface maps onto its layer: shell, label and disc 1:1, the window into its ellipse', () => {
    const scratch = { x: 0.5, y: 0.5, angle: 0, length: 0.2, depth: 1 };
    const plan = planWear(
      {
        ...empty,
        level: 0.5,
        scratches: (['shell', 'window', 'label', 'disc'] as const).map((surface) => ({ surface, ...scratch })),
      },
      SPECS,
    );
    const [shell, window] = plan.layers.shell.groups;
    expect(shell.surface).toBe('shell');
    expect(shell.clip).toBeNull();
    expect(shell.scratches[0]).toMatchObject({ x0: 400, y0: 400, x1: 600, y1: 400, angle: 0 });

    const w = DEFAULT_LAYOUT.window;
    expect(window.surface).toBe('window');
    expect(window.clip).toMatchObject({ kind: 'ellipse', cx: w.cx * 1000, cy: w.cy * 800 });
    // Window UV (0.5, 0.5) is the ellipse centre; 0.2 of the window is 0.2 * 2rx of the shell.
    const s = window.scratches[0];
    expect((s.x0 + s.x1) / 2).toBeCloseTo(w.cx * 1000, 6);
    expect(s.y0).toBeCloseTo(w.cy * 800, 6);
    expect(s.x1 - s.x0).toBeCloseTo(0.2 * 2 * w.rx * 1000, 6);

    expect(plan.layers.label.groups[0].scratches[0]).toMatchObject({ x0: 200, y0: 140, x1: 300, y1: 140 });
    expect(plan.layers.disc.groups[0].surface).toBe('disc');
    expect(plan.layers.disc.groups[0].clip).toMatchObject({ kind: 'annulus', cx: 500, cy: 500 });
  });

  test('a scratch angle is measured in the layer space, y down', () => {
    const plan = planWear({ ...empty, level: 0.1, scratches: [{ surface: 'label', x: 0.5, y: 0.5, angle: 90, length: 0.2, depth: 0.5 }] }, SPECS);
    const s = plan.layers.label.groups[0].scratches[0];
    expect(s.angle).toBeCloseTo(Math.PI / 2, 6);
    expect(s.y1 - s.y0).toBeCloseTo(0.2 * 280, 6);
  });

  test('hairlines are fine: well under a millimetre-scale world width, deeper ones a little wider', () => {
    const plan = planWear(
      {
        ...empty,
        level: 0.1,
        scratches: [
          { surface: 'shell', x: 0.3, y: 0.3, angle: 10, length: 0.1, depth: 0.15 },
          { surface: 'shell', x: 0.6, y: 0.6, angle: 10, length: 0.1, depth: 1 },
        ],
      },
      SPECS,
    );
    const [shallow, deep] = plan.layers.shell.groups[0].scratches;
    const pxPerWorld = 1000 / 0.84;
    expect(deep.width).toBeGreaterThan(shallow.width);
    expect(deep.width / pxPerWorld).toBeLessThan(0.0015);
  });

  test('the same descriptor always gives the same plan (WEAR-1)', () => {
    const d = worn(seedFor(7), 0.8);
    expect(planWear(d, SPECS, DEFAULT_LAYOUT, ZONES)).toEqual(planWear(d, SPECS, DEFAULT_LAYOUT, ZONES));
  });

  test('more dust reveals more of the same speckle, never a new one', () => {
    const low = planWear({ ...empty, seed: seedFor(3), level: 0.2, dustAmount: 0.06 }, SPECS);
    const high = planWear({ ...empty, seed: seedFor(3), level: 0.9, dustAmount: 0.27 }, SPECS);
    const lowDust = low.layers.shell.groups[0].dust;
    const highDust = high.layers.shell.groups[0].dust;
    expect(lowDust.length).toBeGreaterThan(0);
    expect(highDust.length).toBeGreaterThan(lowDust.length * 3);
    expect(highDust.slice(0, lowDust.length)).toEqual(lowDust);
  });
});

describe('disc and window clipping', () => {
  const disc: Clip = { kind: 'annulus', cx: 500, cy: 500, outer: 487.5, inner: 132.5 };

  test('a scratch across the hub splits into two pieces, both on the visible disc', () => {
    const pieces = clipSegment(200, 500, 800, 500, disc);
    expect(pieces).toHaveLength(2);
    const [a, b] = pieces;
    expect(200 + 600 * a[1]).toBeCloseTo(500 - 132.5, 6);
    expect(200 + 600 * b[0]).toBeCloseTo(500 + 132.5, 6);
  });

  test('a scratch past the rim is cut at the rim; one wholly outside or inside the hub is dropped', () => {
    expect(clipSegment(700, 500, 800, 500, disc)).toEqual([[0, 1]]);
    expect(clipSegment(0, 0, 60, 30, disc)).toEqual([]);
    expect(clipSegment(480, 490, 520, 510, disc)).toEqual([]);
    const [[, end]] = clipSegment(600, 500, 1000, 500, disc);
    expect(600 + 400 * end).toBeCloseTo(987.5, 6);
  });

  test('every planned disc and window scratch lies inside its clip, at every wear level', () => {
    for (let i = 0; i < 40; i++) {
      const plan = planWear(worn(seedFor(i), 1), SPECS, DEFAULT_LAYOUT, ZONES);
      for (const layer of [plan.layers.disc, plan.layers.shell]) {
        for (const g of layer.groups) {
          if (!g.clip) continue;
          for (const s of g.scratches) {
            for (let k = 0; k <= 10; k++) {
              const t = k / 10;
              expect(insideClip(s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t, g.clip)).toBe(true);
            }
          }
          for (const speck of g.dust) expect(insideClip(speck.x, speck.y, g.clip)).toBe(true);
        }
      }
    }
  });
});

describe('safe zones (PRD §11.6 test 9, as drawn)', () => {
  test('no hairline, scuff or speck reaches the edition stamp or the disc title, for 60 copies at full wear', () => {
    const zonesOn = (layer: WearLayerName) =>
      ZONES.filter((z) => z.surface === layer).map((z) => ({
        x0: z.x * SPECS[layer].width,
        y0: z.y * SPECS[layer].height,
        x1: (z.x + z.w) * SPECS[layer].width,
        y1: (z.y + z.h) * SPECS[layer].height,
      }));
    let checked = 0;
    for (let i = 0; i < 60; i++) {
      const plan = planWear(worn(seedFor(i + 100), 1), SPECS, DEFAULT_LAYOUT, ZONES);
      for (const layer of ['label', 'disc'] as const) {
        const rects = zonesOn(layer);
        expect(rects.length).toBeGreaterThan(0);
        for (const g of plan.layers[layer].groups) {
          for (const rect of rects) {
            for (const s of g.scratches) {
              for (let k = 0; k <= 40; k++) {
                const t = k / 40;
                expect(rectDistance(s.x0 + (s.x1 - s.x0) * t, s.y0 + (s.y1 - s.y0) * t, rect)).toBeGreaterThan(s.width / 2);
              }
              checked++;
            }
            for (const scuff of g.scuffs) {
              for (const blob of scuff.blobs) expect(rectDistance(blob.x, blob.y, rect)).toBeGreaterThan(blob.r);
            }
            for (const speck of g.dust) expect(rectDistance(speck.x, speck.y, rect)).toBeGreaterThanOrEqual(speck.r * 0.99);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });
});

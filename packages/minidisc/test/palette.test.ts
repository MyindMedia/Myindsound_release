import { describe, expect, it } from 'vitest';
import { dominantColours, keyColour, rgbToHsl, shellForColour, suggestShellFromPixels, toHex } from '../src/palette';

/** RGBA pixels from weighted swatches: `[r, g, b, count]`. */
function pixels(...swatches: [number, number, number, number][]): Uint8ClampedArray {
  const total = swatches.reduce((sum, s) => sum + s[3], 0);
  const data = new Uint8ClampedArray(total * 4);
  let i = 0;
  for (const [r, g, b, count] of swatches) {
    for (let n = 0; n < count; n++) {
      data[i++] = r;
      data[i++] = g;
      data[i++] = b;
      data[i++] = 255;
    }
  }
  return data;
}

describe('dominantColours', () => {
  it('finds the swatches of a two-colour image, biggest first', () => {
    const result = dominantColours(pixels([200, 20, 20, 300], [10, 10, 240, 100]), 4);
    expect(result[0]).toEqual(expect.objectContaining({ r: 200, g: 20, b: 20 }));
    expect(result[0].weight).toBeCloseTo(0.75, 2);
    expect(result[1]).toEqual(expect.objectContaining({ r: 10, g: 10, b: 240 }));
  });

  it('ignores transparent pixels and copes with an empty image', () => {
    const data = pixels([255, 0, 0, 10]);
    data[3] = 0; // one transparent pixel
    expect(dominantColours(data)[0].weight).toBeCloseTo(1, 5);
    expect(dominantColours(new Uint8ClampedArray(0))).toEqual([]);
  });

  it('subsamples with step', () => {
    const data = pixels([0, 255, 0, 40]);
    expect(dominantColours(data, 3, 4)[0]).toEqual({ r: 0, g: 255, b: 0, weight: 1 });
  });
});

describe('rgbToHsl and toHex', () => {
  it('converts the primaries', () => {
    expect(rgbToHsl(255, 0, 0)).toEqual({ h: 0, s: 1, l: 0.5 });
    expect(rgbToHsl(0, 0, 255).h).toBe(240);
    expect(rgbToHsl(128, 128, 128).s).toBe(0);
    expect(toHex(253, 185, 19)).toBe('#FDB913');
  });
});

describe('shellForColour (synthetic swatches)', () => {
  const cases: [string, [number, number, number], string][] = [
    ['blood red', [180, 20, 24], 'red'],
    ['scarlet', [230, 40, 30], 'red'],
    ['deep blue', [20, 60, 220], 'blue'],
    ['cyan-blue', [40, 150, 230], 'blue'],
    ['violet', [120, 50, 200], 'purple'],
    ['hot pink', [255, 61, 168], 'clear-pink'],
    ['magenta', [220, 40, 200], 'clear-pink'],
    ['near black', [16, 16, 20], 'smoke-black'],
    ['mid grey', [120, 120, 124], 'smoke-black'],
    ['white', [245, 241, 230], 'clear'],
    ['gold', [253, 185, 19], 'smoke-gold'],
    ['mustard', [200, 170, 40], 'smoke-gold'],
    ['dark brown', [90, 50, 20], 'red'],
  ];
  for (const [name, [r, g, b], shell] of cases) {
    it(`${name} → ${shell}`, () => expect(shellForColour(r, g, b).shell).toBe(shell));
  }

  it('greens and cyans get the clear shell tinted the colour', () => {
    expect(shellForColour(30, 200, 90)).toEqual({ shell: 'clear', tint: '#1EC85A' });
    expect(shellForColour(20, 210, 200).shell).toBe('clear');
    expect(shellForColour(20, 210, 200).tint).toBeDefined();
  });
});

describe('suggestShellFromPixels', () => {
  it('lets a saturated accent outrank a bigger dark background', () => {
    // 70% near-black, 30% blood red: the red is what the shell should answer.
    const result = suggestShellFromPixels(pixels([14, 12, 16, 700], [170, 20, 26, 300]));
    expect(result.shell).toBe('red');
    expect(result.key).toEqual(expect.objectContaining({ r: 170, g: 20, b: 26 }));
  });

  it('a tiny accent does not outrank the field', () => {
    // 96% near-black with a 4% red speck: smoke black.
    expect(suggestShellFromPixels(pixels([14, 12, 16, 960], [170, 20, 26, 40])).shell).toBe('smoke-black');
  });

  it('light monochrome art → clear; a pink field → clear pink', () => {
    expect(suggestShellFromPixels(pixels([235, 232, 228, 900], [80, 80, 80, 100])).shell).toBe('clear');
    expect(suggestShellFromPixels(pixels([255, 80, 190, 600], [250, 250, 250, 400])).shell).toBe('clear-pink');
  });

  it('falls back to smoke black on an empty image', () => {
    expect(suggestShellFromPixels(new Uint8ClampedArray(0)).shell).toBe('smoke-black');
  });

  it('keyColour returns the biggest swatch when nothing is saturated', () => {
    const swatches = [
      { r: 30, g: 30, b: 30, weight: 0.6 },
      { r: 200, g: 200, b: 200, weight: 0.4 },
    ];
    expect(keyColour(swatches)).toBe(swatches[0]);
  });
});

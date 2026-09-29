import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLUR_PX,
  DEFAULT_SCRIM,
  SHELL_PRESET_IDS,
  assertDesign,
  catalogueNumber,
  designArtRefs,
  placeImageSticker,
  formatDuration,
  resolveShellWindow,
  resolveTheme,
  validateDesign,
  type DiscDesign,
} from '../src/design';
import { SHELL_PRESETS } from '../src/presets';

const ROOT = join(__dirname, '..');

function valid(): DiscDesign {
  return {
    v: 1,
    slug: 'blood',
    title: 'BLOOD',
    artist: 'Tha Myind',
    year: 2026,
    tracks: [
      { n: 1, title: 'Blood', durationSec: 201 },
      { n: 2, title: 'Vein', durationSec: 184.5 },
    ],
    coverArt: 'blood/cover.png',
    shell: 'red',
    labelStyle: 'sticker',
  };
}

describe('validateDesign', () => {
  it('accepts a minimal valid design', () => {
    const result = validateDesign(valid());
    expect(result.ok).toBe(true);
  });

  it('accepts every sample design in samples/', () => {
    const files = readdirSync(join(ROOT, 'samples')).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const design = JSON.parse(readFileSync(join(ROOT, 'samples', file), 'utf8'));
      const result = validateDesign(design);
      expect(result, file).toEqual(expect.objectContaining({ ok: true }));
    }
  });

  it('reports every problem, with its path', () => {
    const result = validateDesign({ ...valid(), v: 2, slug: 'Bad Slug', year: 1800, shell: 'chrome', labelStyle: 'paper' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^v:/),
        expect.stringMatching(/^slug:/),
        expect.stringMatching(/^year:/),
        expect.stringMatching(/^shell:/),
        expect.stringMatching(/^labelStyle:/),
      ]),
    );
  });

  it('rejects non-objects, empty tracks, duplicate positions and bad durations', () => {
    expect(validateDesign(null).ok).toBe(false);
    expect(validateDesign('blood').ok).toBe(false);
    expect(validateDesign({ ...valid(), tracks: [] }).ok).toBe(false);
    const dup = validateDesign({ ...valid(), tracks: [{ n: 1, title: 'A', durationSec: 1 }, { n: 1, title: 'B', durationSec: 2 }] });
    expect(dup).toEqual({ ok: false, errors: ['tracks[1].n: duplicate position 1'] });
    expect(validateDesign({ ...valid(), tracks: [{ n: 1, title: 'A', durationSec: -1 }] }).ok).toBe(false);
    expect(validateDesign({ ...valid(), tracks: [{ n: 1, title: 'A', durationSec: Number.NaN }] }).ok).toBe(false);
  });

  it('checks colours, stickers and the theme backdrop', () => {
    expect(validateDesign({ ...valid(), accent: 'gold' }).ok).toBe(false);
    expect(validateDesign({ ...valid(), accent: '#FDB913', shellTint: '#ff00aa' }).ok).toBe(true);
    expect(validateDesign({ ...valid(), stickers: [{ kind: 'text', x: 0.1, y: 0.1, w: 0.3 }] }).ok).toBe(true);
    expect(validateDesign({ ...valid(), stickers: [{ kind: 'text', x: 1.5, y: 0.1, w: 0.3 }] }).ok).toBe(false);
    expect(validateDesign({ ...valid(), stickers: [{ kind: 'glitter', x: 0.1, y: 0.1, w: 0.3 }] }).ok).toBe(false);
    expect(validateDesign({ ...valid(), stickers: [{ kind: 'text', x: 0.1, y: 0.1, w: 0.3, rotation: 90 }] }).ok).toBe(false);
    expect(validateDesign({ ...valid(), theme: { backdrop: { blurPx: 12, scrim: 0.6 } } }).ok).toBe(true);
    expect(validateDesign({ ...valid(), theme: { backdrop: { blurPx: 100 } } }).ok).toBe(false);
    expect(validateDesign({ ...valid(), theme: { backdrop: { scrim: 2 } } }).ok).toBe(false);
    expect(validateDesign({ ...valid(), theme: { accent: 'nope' } }).ok).toBe(false);
  });

  it('shellWindow: validated, and derived as clear over a disc with art', () => {
    expect(validateDesign({ ...valid(), shellWindow: 'frosted' }).ok).toBe(false);
    for (const window of ['auto', 'clear', 'tinted', 'opaque'] as const) expect(validateDesign({ ...valid(), shellWindow: window }).ok).toBe(true);
    expect(resolveShellWindow(valid())).toBe('clear');
    expect(resolveShellWindow({ ...valid(), shellWindow: 'auto' })).toBe('clear');
    expect(resolveShellWindow({ ...valid(), shellWindow: 'tinted' })).toBe('tinted');
    expect(resolveShellWindow({ ...valid(), shellWindow: 'opaque' })).toBe('opaque');
    // A blank disc (no art) may be solid.
    expect(resolveShellWindow({ ...valid(), coverArt: '' } as DiscDesign)).toBe('opaque');
  });

  it('assertDesign throws with every error in the message', () => {
    expect(() => assertDesign({ ...valid(), slug: 'X', year: 'now' })).toThrow(/slug:.*\n.*year:/s);
    expect(assertDesign(valid()).slug).toBe('blood');
  });

  it('every shell preset id has a preset', () => {
    for (const id of SHELL_PRESET_IDS) expect(SHELL_PRESETS[id].id).toBe(id);
  });

  it('the JSON Schema agrees with the validator on the enums and required keys', () => {
    const schema = JSON.parse(readFileSync(join(ROOT, 'schema/disc-design.schema.json'), 'utf8'));
    expect(schema.properties.shell.enum).toEqual([...SHELL_PRESET_IDS]);
    expect(schema.required).toEqual(['v', 'slug', 'title', 'artist', 'year', 'tracks', 'coverArt', 'shell', 'labelStyle']);
    for (const key of schema.required) {
      const missing = { ...valid() } as Record<string, unknown>;
      delete missing[key];
      expect(validateDesign(missing).ok, `missing ${key}`).toBe(false);
    }
  });
});

describe('resolveTheme and helpers', () => {
  it('fills the backdrop defaults from the cover art', () => {
    expect(resolveTheme(valid())).toEqual({
      accent: '#FDB913',
      accent2: '#F5F1E6',
      lcdTint: null,
      backdrop: { image: 'blood/cover.png', blurPx: DEFAULT_BLUR_PX, scrim: DEFAULT_SCRIM },
    });
  });

  it('prefers theme.backdrop.image over backdropImage over the cover', () => {
    const design = { ...valid(), theme: { backdropImage: 'city.png', backdrop: { image: 'night.png', blurPx: 8 } } };
    expect(resolveTheme(design).backdrop).toEqual({ image: 'night.png', blurPx: 8, scrim: DEFAULT_SCRIM });
    expect(resolveTheme({ ...valid(), theme: { backdropImage: 'city.png' } }).backdrop.image).toBe('city.png');
    expect(designArtRefs(design)).toEqual(['blood/cover.png', 'night.png']);
  });

  it('formats durations and catalogue numbers', () => {
    expect(formatDuration(201)).toBe('3:21');
    expect(formatDuration(59.6)).toBe('1:00');
    expect(formatDuration(-3)).toBe('0:00');
    expect(catalogueNumber(valid())).toBe('MS-BLOOD-26');
    expect(catalogueNumber({ ...valid(), slug: 'let-him-cook', year: 2025 })).toBe('MS-LETHIMCOOK-25');
  });
});

describe('image stickers (uploaded art on the slide cover or the shell)', () => {
  const image = (area: 'shutter' | 'shell', extra: Record<string, unknown> = {}) => ({ kind: 'image', src: 'star.png', area, x: 0.5, y: 0.5, size: 0.3, ...extra });

  it('validates the area, the place, the size and the turn', () => {
    expect(validateDesign({ ...valid(), stickers: [image('shutter', { rotation: -170 })] }).ok).toBe(true);
    expect(validateDesign({ ...valid(), stickers: [image('shell')] }).ok).toBe(true);
    expect(validateDesign({ ...valid(), stickers: [image('lid' as 'shell')] }).ok).toBe(false);
    expect(validateDesign({ ...valid(), stickers: [image('shell', { src: '' })] }).ok).toBe(false);
    expect(validateDesign({ ...valid(), stickers: [image('shell', { size: 0.01 })] }).ok).toBe(false);
    expect(validateDesign({ ...valid(), stickers: [image('shell', { rotation: 200 })] }).ok).toBe(false);
  });

  it('allows four on the slide cover, more on the shell up to eight in all', () => {
    expect(validateDesign({ ...valid(), stickers: Array.from({ length: 4 }, () => image('shutter')) }).ok).toBe(true);
    expect(validateDesign({ ...valid(), stickers: Array.from({ length: 5 }, () => image('shutter')) }).ok).toBe(false);
    expect(validateDesign({ ...valid(), stickers: [...Array.from({ length: 4 }, () => image('shutter')), ...Array.from({ length: 4 }, () => image('shell'))] }).ok).toBe(true);
  });

  it('ships their art with the design', () => {
    expect(designArtRefs({ ...valid(), stickers: [image('shell') as never] })).toContain('star.png');
  });

  it('keeps a sticker whole inside its area, however it is placed, sized or turned', () => {
    const area = { x0: 0, y0: 0, x1: 2, y1: 1 };
    const inside = (p: { x: number; y: number; width: number; height: number }, rotation: number) => {
      const a = (rotation * Math.PI) / 180;
      const hw = (Math.abs(Math.cos(a)) * p.width + Math.abs(Math.sin(a)) * p.height) / 2;
      const hh = (Math.abs(Math.sin(a)) * p.width + Math.abs(Math.cos(a)) * p.height) / 2;
      return p.x - hw >= area.x0 - 1e-9 && p.x + hw <= area.x1 + 1e-9 && p.y - hh >= area.y0 - 1e-9 && p.y + hh <= area.y1 + 1e-9;
    };
    for (const [x, y, size, rotation] of [[0, 0, 0.3, 0], [1, 1, 0.5, 45], [0.5, 0.5, 1, 90], [0.9, 0.1, 0.8, -30]]) {
      const place = placeImageSticker({ x, y, size, rotation }, area, { width: 400, height: 200 });
      expect(inside(place, rotation)).toBe(true);
    }
  });

  it('keeps the art\'s own shape and its asked size when it fits', () => {
    const place = placeImageSticker({ x: 0.5, y: 0.5, size: 0.25 }, { x0: 0, y0: 0, x1: 2, y1: 1 }, { width: 400, height: 200 });
    expect(place.width).toBeCloseTo(0.5);
    expect(place.height).toBeCloseTo(0.25);
    expect(place.x).toBeCloseTo(1);
    expect(place.y).toBeCloseTo(0.5);
  });
});

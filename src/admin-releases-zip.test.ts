import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { validateDesign, type DiscDesign } from '../packages/minidisc/src/design';
import { assembleReleaseZip, buildZip, crc32, imageExtension, type GenericBundleIndex } from './admin-releases-zip';

/** Reads a zip back through its central directory, the way an unzip tool (and the iOS app) does. */
function readZip(zip: Uint8Array): Map<string, Buffer> {
  const view = Buffer.from(zip);
  const endAt = view.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = view.readUInt16LE(endAt + 10);
  let at = view.readUInt32LE(endAt + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    expect(view.readUInt32LE(at)).toBe(0x02014b50);
    const method = view.readUInt16LE(at + 10);
    const crc = view.readUInt32LE(at + 16);
    const compressed = view.readUInt32LE(at + 20);
    const size = view.readUInt32LE(at + 24);
    const nameLength = view.readUInt16LE(at + 28);
    const local = view.readUInt32LE(at + 42);
    const name = view.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28);
    const body = view.subarray(start, start + compressed);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    at += 46 + nameLength;
  }
  return out;
}

const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe('buildZip', () => {
  test('round-trips, sorted, deflating text and storing images; same input, same bytes', async () => {
    const text = new TextEncoder().encode('hello '.repeat(200));
    const image = new Uint8Array([...PNG_HEAD, 1, 2, 3]);
    const zip = await buildZip([
      { name: 'b.txt', data: text },
      { name: 'a/cover.png', data: image },
    ]);
    const files = readZip(zip);
    expect([...files.keys()]).toEqual(['a/cover.png', 'b.txt']);
    expect(files.get('b.txt')!.toString()).toBe('hello '.repeat(200));
    expect([...files.get('a/cover.png')!]).toEqual([...image]);
    expect(zip.length).toBeLessThan(text.length);
    const again = await buildZip([
      { name: 'a/cover.png', data: image },
      { name: 'b.txt', data: text },
    ]);
    expect(Buffer.from(again).equals(Buffer.from(zip))).toBe(true);
  });

  test('crc32 matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  test('image extensions come from the bytes', () => {
    expect(imageExtension(new Uint8Array(PNG_HEAD))).toBe('png');
    expect(imageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe('jpg');
    expect(imageExtension(new TextEncoder().encode('RIFF\0\0\0\0WEBP'))).toBe('webp');
    expect(imageExtension(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });
});

describe('assembleReleaseZip', () => {
  const coverUrl = 'https://x.convex.cloud/api/storage/abc';
  const design = validateDesign({
    v: 1,
    slug: 'blood',
    title: 'BLOOD',
    artist: 'Tha Myind',
    year: 2026,
    tracks: [{ n: 1, title: 'Blood', durationSec: 201 }],
    coverArt: coverUrl,
    shell: 'red',
    labelStyle: 'sticker',
    theme: { backdrop: { blurPx: 10 } },
  });
  if (!design.ok) throw new Error(design.errors.join());
  const index: GenericBundleIndex = {
    version: '1.0.0',
    entry: 'index.html',
    bridgeVersion: 1,
    minAppVersion: '1.0.0',
    wearSafeZones: [{ surface: 'label', x: 0.58, y: 0.64, w: 0.42, h: 0.34 }],
    files: [
      { path: 'index.html', size: 5 },
      { path: 'assets/boot.js', size: 7 },
    ],
  };
  const files = new Map([
    ['index.html', new TextEncoder().encode('<html>')],
    ['assets/boot.js', new TextEncoder().encode('boot();')],
  ]);
  const cover = new Uint8Array([...PNG_HEAD, 9, 9, 9, 9]);

  test('design.json ships with its cover beside it, and the manifest matches build-bundle.mjs', async () => {
    const result = await assembleReleaseZip({ index, files, design: design.design as DiscDesign, cover, releaseId: 'k123', version: '1.0.0+r2' });
    expect(result.sha256).toBe(createHash('sha256').update(result.zip).digest('hex'));
    const zip = readZip(result.zip);
    expect([...zip.keys()]).toEqual(['assets/boot.js', 'design/cover.png', 'design/design.json', 'index.html', 'manifest.json']);
    const shipped = JSON.parse(zip.get('design/design.json')!.toString());
    expect(shipped).toMatchObject({ slug: 'blood', coverArt: 'cover.png', shell: 'red', theme: { backdrop: { blurPx: 10 } } });
    expect(validateDesign(shipped).ok).toBe(true);
    const manifest = JSON.parse(zip.get('manifest.json')!.toString());
    expect(manifest).toEqual({
      releaseId: 'k123',
      slug: 'blood',
      version: '1.0.0+r2',
      entry: 'index.html',
      bridgeVersion: 1,
      minAppVersion: '1.0.0',
      wearSafeZones: index.wearSafeZones,
      generator: 'minidisc/1',
      design: {
        title: 'BLOOD',
        artist: 'Tha Myind',
        year: 2026,
        shell: 'red',
        labelStyle: 'sticker',
        theme: { accent: '#FDB913', accent2: '#F5F1E6', lcdTint: null, backdrop: { image: 'cover.png', blurPx: 10, scrim: 0.62 } },
      },
    });
  });

  test('refuses a missing generic file, art that is not the cover, and a non-image cover', async () => {
    const base = { index, design: design.design as DiscDesign, cover, releaseId: 'k', version: '1.0.0' };
    await expect(assembleReleaseZip({ ...base, files: new Map([['index.html', new Uint8Array(1)]]) })).rejects.toThrow(/missing: assets\/boot.js/);
    await expect(assembleReleaseZip({ ...base, files, design: { ...(design.design as DiscDesign), discArt: 'https://elsewhere/x.png' } })).rejects.toThrow(
      /other than its cover/,
    );
    await expect(assembleReleaseZip({ ...base, files, cover: new Uint8Array([1, 2, 3]) })).rejects.toThrow(/not a PNG/);
  });
});

describe('portal helpers', () => {
  test('track titles from file names, slugs from titles', async () => {
    const { titleFromFileName, slugify } = await import('./admin-releases');
    expect(titleFromFileName('01 - Blood (Final).mp3')).toBe('Blood (Final)');
    expect(titleFromFileName('03-victory-in-the-valley.mp3')).toBe('victory-in-the-valley');
    expect(titleFromFileName('Track 2 Sweat.mp3')).toBe('Sweat');
    expect(titleFromFileName('1999.mp3')).toBe('1999');
    expect(slugify('BLOOD (Deluxe)!')).toBe('blood-deluxe');
    expect(slugify('Café Noir')).toBe('cafe-noir');
  });
});

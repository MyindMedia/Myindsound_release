import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  base64ToHex,
  buildDesign,
  canonicalJson,
  checkCoverSize,
  checkDuration,
  checkSpriteMeta,
  checkUpload,
  designHash,
  imageSize,
  publishProblems,
  sniffKind,
  type PublishState,
  type ReleaseFacts,
} from './releasesLogic';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

/** The release portal (Grilled.md "Release portal + generated discs", ADM-7): validation, admin only, publish rules, library shape. */

type T = ReturnType<typeof newTest>;

const ADMIN = { subject: 'user_admin', email: 'admin@example.test' };
const SLUG = 'blood';
const HOUR = 60 * 60 * 1000;
const META = { frames: 36, cols: 6, rows: 6, frameW: 512, frameH: 512, sheetW: 3072, sheetH: 3072, fps: 24, format: 'image/webp' };

// ── Fake files: real headers, filler bodies ───────────────────────────────────────────────────────────────

const bytes = (...parts: (number[] | string | Uint8Array)[]) => {
  const out: number[] = [];
  for (const part of parts) {
    if (typeof part === 'string') out.push(...[...part].map((c) => c.charCodeAt(0)));
    else out.push(...part);
  }
  return new Uint8Array(out);
};
const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];
const pad = (head: Uint8Array, size: number) => {
  const out = new Uint8Array(Math.max(size, head.length));
  out.set(head);
  return out;
};

const png = (w: number, h: number, size = 4096) =>
  pad(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), 'IHDR', u32be(w), u32be(h), [8, 6, 0, 0, 0]), size);
const webp = (w: number, h: number, size = 4096) => pad(bytes('RIFF', u32be(0), 'WEBP', 'VP8X', u32be(10), [0, 0, 0, 0], u24le(w - 1), u24le(h - 1)), size);
const jpeg = (w: number, h: number) =>
  pad(
    bytes([0xff, 0xd8], [0xff, 0xe0, 0x00, 0x10], 'JFIF', [0, 1, 1, 0, 0, 1, 0, 1, 0, 0], [0xff, 0xc0, 0x00, 0x11, 0x08], [h >> 8, h & 255, w >> 8, w & 255], [3]),
    2048,
  );
/** 20 kB per second of "audio" (160 kbps). */
const mp3 = (seconds: number) => pad(bytes('ID3', [4, 0, 0, 0, 0, 0, 0]), seconds * 20_000);
const zipBytes = (size = 8192) => {
  const out = pad(bytes([0x50, 0x4b, 0x03, 0x04]), size);
  for (let i = 4; i < out.length; i++) out[i] = (i * 31) & 255;
  return out;
};

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(data)));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

async function store(t: T, data: Uint8Array): Promise<Id<'_storage'>> {
  return await t.run((ctx) => ctx.storage.store(new Blob([new Uint8Array(data)])));
}

async function exists(t: T, id: Id<'_storage'>): Promise<boolean> {
  return await t.run(async (ctx) => (await ctx.db.system.get(id)) !== null);
}

async function seed(t: T) {
  const base = await seedLitWithOwner(t);
  const adminId = await t.run((ctx) => ctx.db.insert('users', { clerkId: ADMIN.subject, email: ADMIN.email, isAdmin: true }));
  return { ...base, adminId };
}

const DESIGN_LOOK = { shell: 'red', labelStyle: 'sticker', labelText: 'BLOOD\nTHA MYIND' };

/** A draft with two tracks and a cover. */
async function draftWithMedia(t: T) {
  const admin = t.withIdentity(ADMIN);
  await admin.mutation(api.releases.createDraft, { slug: SLUG, title: 'BLOOD', artist: 'Tha Myind', year: 2026 });
  const one = await admin.action(api.releases.attachTrackAudio, { slug: SLUG, file: await store(t, mp3(10)), durationSec: 10, title: 'Blood' });
  const two = await admin.action(api.releases.attachTrackAudio, { slug: SLUG, file: await store(t, mp3(12)), durationSec: 12, title: 'Sweat' });
  await admin.action(api.releases.attachCover, { slug: SLUG, file: await store(t, png(1500, 1500)) });
  return { admin, one, two };
}

/** Rack art and a bundle for the current design. */
async function renderAndBundle(t: T, admin: ReturnType<T['withIdentity']>, hash: string) {
  await admin.action(api.releases.attachRackArt, {
    slug: SLUG,
    spriteWebp: await store(t, webp(3072, 3072)),
    spritePng: await store(t, png(3072, 3072)),
    spriteMeta: META,
    still: await store(t, png(1024, 1024)),
    designHash: hash,
  });
  const zip = zipBytes();
  return await admin.action(api.releases.attachBundle, {
    slug: SLUG,
    version: '1.0.0+r1',
    zip: await store(t, zip),
    sha256: await sha256Hex(zip),
    designHash: hash,
  });
}

async function readyDraft(t: T) {
  const { admin, one, two } = await draftWithMedia(t);
  const saved = await admin.mutation(api.releases.saveDesign, { slug: SLUG, design: DESIGN_LOOK });
  const bundle = await renderAndBundle(t, admin, saved.designHash);
  return { admin, one, two, saved, bundle };
}

// ── Pure rules ───────────────────────────────────────────────────────────────────────────────────────────

describe('file checks', () => {
  test('formats come from the bytes', () => {
    expect(sniffKind(png(1, 1))).toBe('png');
    expect(sniffKind(jpeg(1, 1))).toBe('jpeg');
    expect(sniffKind(webp(1, 1))).toBe('webp');
    expect(sniffKind(zipBytes())).toBe('zip');
    expect(sniffKind(mp3(1))).toBe('mp3');
    expect(sniffKind(bytes([0xff, 0xfb, 0x90, 0x64]))).toBe('mp3');
    expect(sniffKind(bytes('<html>'))).toBeNull();
  });

  test('image sizes from PNG, WebP (VP8X) and JPEG headers', () => {
    expect(imageSize(png(3000, 2000), 'png')).toEqual({ width: 3000, height: 2000 });
    expect(imageSize(webp(1500, 1500), 'webp')).toEqual({ width: 1500, height: 1500 });
    expect(imageSize(jpeg(1600, 1600), 'jpeg')).toEqual({ width: 1600, height: 1600 });
  });

  test('size caps, wrong formats and mismatched content types are refused', () => {
    expect(checkUpload('audio', { size: 100 }, mp3(1))).toEqual({ kind: 'mp3' });
    expect(checkUpload('audio', { size: 81 * 1024 * 1024 }, mp3(1))).toHaveProperty('error');
    expect(checkUpload('audio', { size: 100 }, png(1, 1))).toEqual({ error: 'That is not a MP3.' });
    expect(checkUpload('cover', { size: 100, contentType: 'audio/mpeg' }, png(1, 1))).toHaveProperty('error');
    expect(checkUpload('cover', { size: 100, contentType: 'image/png' }, png(1, 1))).toEqual({ kind: 'png' });
    expect(checkUpload('bundle', { size: 0 }, zipBytes())).toHaveProperty('error');
    expect(checkUpload('bundle', { size: 41 * 1024 * 1024 }, zipBytes())).toHaveProperty('error');
  });

  test('covers are square and at least 1024 px; durations fit the file size; sprite meta fits the sheet', () => {
    expect(checkCoverSize({ width: 1500, height: 1500 })).toBeNull();
    expect(checkCoverSize({ width: 1500, height: 1200 })).toMatch(/square/);
    expect(checkCoverSize({ width: 800, height: 800 })).toMatch(/1024/);
    expect(checkDuration(200_000, 10)).toBeNull();
    expect(checkDuration(200_000, 0)).toMatch(/could not be read/);
    expect(checkDuration(200_000, 1000)).toMatch(/should not be/);
    expect(checkSpriteMeta(META, { width: 3072, height: 3072 })).toBeNull();
    expect(checkSpriteMeta(META, { width: 2048, height: 2048 })).toMatch(/not the size/);
    expect(checkSpriteMeta({ ...META, cols: 5 }, { width: 3072, height: 3072 })).toMatch(/fewer cells/);
  });

  test('base64 storage hashes read as hex', () => {
    expect(base64ToHex(btoa(String.fromCharCode(0, 15, 255)))).toBe('000fff');
  });
});

describe('the design', () => {
  const facts: ReleaseFacts = {
    slug: SLUG,
    title: 'BLOOD',
    artist: 'Tha Myind',
    year: 2026,
    coverUrl: 'https://x.convex.cloud/api/storage/cover',
    tracks: [{ n: 1, title: 'Blood', durationSec: 201 }],
  };

  test('the server owns the facts; the portal owns the look; unknown keys are dropped', () => {
    const result = buildDesign({ ...DESIGN_LOOK, slug: 'other', title: 'X', tracks: [], coverArt: 'evil.png', junk: 1 }, facts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.design).toMatchObject({ v: 1, slug: SLUG, title: 'BLOOD', coverArt: facts.coverUrl, shell: 'red', tracks: facts.tracks });
    expect(result.design).not.toHaveProperty('junk');
  });

  test('validateDesign errors come back, and art other than the cover is refused', () => {
    const bad = buildDesign({ shell: 'green', labelStyle: 'sticker' }, facts);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.errors.join()).toMatch(/shell: must be one of/);
    const foreign = buildDesign({ ...DESIGN_LOOK, discArt: 'https://elsewhere.test/a.png' }, facts);
    expect(foreign.ok).toBe(false);
    if (!foreign.ok) expect(foreign.errors.join()).toMatch(/only the release's cover art/);
    expect(buildDesign({ ...DESIGN_LOOK, discArt: facts.coverUrl }, facts).ok).toBe(true);
  });

  test('the hash ignores key order', async () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(await designHash({ a: 1, b: 2 })).toBe(await designHash({ b: 2, a: 1 }));
  });

  test('publish problems list every missing piece, and stale art', () => {
    const ready: PublishState = {
      status: 'draft',
      tracks: [{ position: 1, hasAudio: true, durationSeconds: 10 }],
      hasCover: true,
      designHash: 'h1',
      rackDesignHash: 'h1',
      bundleDesignHash: 'h1',
    };
    expect(publishProblems(ready)).toEqual([]);
    expect(publishProblems({ ...ready, status: 'live' })[0]).toMatch(/Only a draft/);
    expect(publishProblems({ ...ready, tracks: [] })).toContain('Upload at least one track.');
    expect(publishProblems({ ...ready, tracks: [{ position: 2, hasAudio: false, durationSeconds: 0 }] })).toContain('Track 2 has no audio.');
    expect(publishProblems({ ...ready, hasCover: false })).toContain('Upload the cover art.');
    expect(publishProblems({ ...ready, designHash: null })).toContain('Save the casing (the design).');
    expect(publishProblems({ ...ready, rackDesignHash: 'h0' })).toContain('The rack art is out of date: render it again.');
    expect(publishProblems({ ...ready, bundleDesignHash: null })).toContain('Build and upload the bundle.');
  });
});

// ── Admin only ─────────────────────────────────────────────────────────────────────────────────────────────

describe('admin only', () => {
  test('every portal function refuses a non-admin and a signed-out caller, and writes nothing', async () => {
    const t = newTest();
    await seed(t);
    const file = await store(t, mp3(10));
    for (const caller of [t.withIdentity(STRANGER), t.withIdentity(OWNER)]) {
      await expect(caller.mutation(api.releases.createDraft, { slug: SLUG, title: 'B', artist: 'A', year: 2026 })).rejects.toThrow(/FORBIDDEN|Admins only/);
      await expect(caller.query(api.releases.drafts, {})).rejects.toThrow(/Admins only/);
      await expect(caller.query(api.releases.get, { slug: 'lit' })).rejects.toThrow(/Admins only/);
      await expect(caller.mutation(api.releases.generateUploadUrl, { slug: 'lit' })).rejects.toThrow(/Admins only/);
      await expect(caller.mutation(api.releases.saveDesign, { slug: 'lit', design: DESIGN_LOOK })).rejects.toThrow(/Admins only/);
      await expect(caller.mutation(api.releases.setTracks, { slug: 'lit', tracks: [] })).rejects.toThrow(/Admins only/);
      await expect(caller.action(api.releases.attachTrackAudio, { slug: 'lit', file, durationSec: 10 })).rejects.toThrow(/Admins only/);
      await expect(caller.action(api.releases.attachCover, { slug: 'lit', file })).rejects.toThrow(/Admins only/);
      await expect(
        caller.action(api.releases.attachBundle, { slug: 'lit', version: '1.0.0', zip: file, sha256: '0'.repeat(64), designHash: 'x' }),
      ).rejects.toThrow(/Admins only/);
      await expect(caller.mutation(api.releases.publish, { slug: 'lit', status: 'live', reason: 'go' })).rejects.toThrow(/Admins only/);
    }
    await expect(t.mutation(api.releases.createDraft, { slug: SLUG, title: 'B', artist: 'A', year: 2026 })).rejects.toThrow(/Sign in/);
    // A refused attach never deletes someone else's file.
    expect(await exists(t, file)).toBe(true);
    const audit = await t.run((ctx) => ctx.db.query('auditLog').collect());
    expect(audit).toHaveLength(0);
  });
});

// ── The flow ───────────────────────────────────────────────────────────────────────────────────────────────

describe('drafts', () => {
  test('createDraft makes an inactive digital draft; bad facts and taken slugs are refused', async () => {
    const t = newTest();
    await seed(t);
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.releases.createDraft, { slug: SLUG, title: ' BLOOD ', artist: 'Tha Myind', year: 2026 });
    const product = await t.run(async (ctx) => (await ctx.db.query('products').withIndex('by_slug', (q) => q.eq('slug', SLUG)).unique())!);
    expect(product).toMatchObject({ name: 'BLOOD', artist: 'Tha Myind', year: 2026, kind: 'digital', status: 'draft', active: false });
    await expect(admin.mutation(api.releases.createDraft, { slug: SLUG, title: 'B', artist: 'A', year: 2026 })).rejects.toThrow(/taken/);
    await expect(admin.mutation(api.releases.createDraft, { slug: 'lit', title: 'B', artist: 'A', year: 2026 })).rejects.toThrow(/taken/);
    await expect(admin.mutation(api.releases.createDraft, { slug: 'Bad Slug', title: 'B', artist: 'A', year: 2026 })).rejects.toThrow(/slug/);
    await expect(admin.mutation(api.releases.createDraft, { slug: 'ok', title: '', artist: 'A', year: 1800 })).rejects.toThrow(/Title is required.*Year/);
    const drafts = await admin.query(api.releases.drafts, {});
    expect(drafts).toEqual([expect.objectContaining({ slug: SLUG, tracks: 0, hasCover: false, hasDesign: false, ready: false })]);
    const audit = await t.run((ctx) => ctx.db.query('auditLog').collect());
    expect(audit.map((row) => [row.action, row.target])).toEqual([['release.create', `product:${SLUG}`]]);
  });

  test('audio: appended in order, bad bytes and implausible lengths refused and deleted', async () => {
    const t = newTest();
    await seed(t);
    const { admin, one, two } = await draftWithMedia(t);
    expect([one.position, two.position]).toEqual([1, 2]);
    const notAudio = await store(t, png(10, 10));
    await expect(admin.action(api.releases.attachTrackAudio, { slug: SLUG, file: notAudio, durationSec: 10 })).rejects.toThrow(/not a MP3/);
    expect(await exists(t, notAudio)).toBe(false);
    const tooShort = await store(t, mp3(10));
    await expect(admin.action(api.releases.attachTrackAudio, { slug: SLUG, file: tooShort, durationSec: 1000 })).rejects.toThrow(/should not be/);
    expect(await exists(t, tooShort)).toBe(false);
    // A file already in use (LIT's audio) is never attached again or deleted.
    const litAudio = await t.run(async (ctx) => (await ctx.db.query('tracks').first())!.streamFile!);
    await expect(admin.action(api.releases.attachTrackAudio, { slug: SLUG, file: litAudio, durationSec: 7 })).rejects.toThrow();
    expect(await exists(t, litAudio)).toBe(true);
    const state = await admin.query(api.releases.get, { slug: SLUG });
    expect(state.tracks.map((row) => [row.position, row.title, row.durationSeconds, row.hasAudio])).toEqual([
      [1, 'Blood', 10, true],
      [2, 'Sweat', 12, true],
    ]);
  });

  test('cover: non-square and small images refused; replacing deletes the old one', async () => {
    const t = newTest();
    await seed(t);
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.releases.createDraft, { slug: SLUG, title: 'BLOOD', artist: 'Tha Myind', year: 2026 });
    const wide = await store(t, png(2000, 1500));
    await expect(admin.action(api.releases.attachCover, { slug: SLUG, file: wide })).rejects.toThrow(/square/);
    expect(await exists(t, wide)).toBe(false);
    await expect(admin.action(api.releases.attachCover, { slug: SLUG, file: await store(t, jpeg(900, 900)) })).rejects.toThrow(/1024/);
    const first = await store(t, jpeg(1200, 1200));
    const attached = await admin.action(api.releases.attachCover, { slug: SLUG, file: first });
    expect(attached).toMatchObject({ width: 1200, height: 1200 });
    await admin.action(api.releases.attachCover, { slug: SLUG, file: await store(t, webp(2000, 2000)) });
    expect(await exists(t, first)).toBe(false);
  });

  test('setTracks reorders, renames and removes (with the audio); the design follows and the art goes stale', async () => {
    const t = newTest();
    await seed(t);
    const { admin, one, two, saved } = await readyDraft(t);
    const removedFile = await t.run(async (ctx) => (await ctx.db.get(one.trackId))!.streamFile!);
    await admin.mutation(api.releases.setTracks, { slug: SLUG, tracks: [{ trackId: two.trackId, title: ' Sweat (Intro) ' }] });
    const state = await admin.query(api.releases.get, { slug: SLUG });
    expect(state.tracks.map((row) => [row.position, row.title])).toEqual([[1, 'Sweat (Intro)']]);
    expect(await exists(t, removedFile)).toBe(false);
    expect(state.design?.tracks).toEqual([{ n: 1, title: 'Sweat (Intro)', durationSec: 12 }]);
    expect(state.designHash).not.toBe(saved.designHash);
    expect(state.rack?.fresh).toBe(false);
    expect(state.bundle?.fresh).toBe(false);
    expect(state.problems).toEqual(['The rack art is out of date: render it again.', 'The bundle is out of date: build it again.']);
    await expect(admin.mutation(api.releases.setTracks, { slug: SLUG, tracks: [{ trackId: one.trackId, title: 'x' }] })).rejects.toThrow(/not on this release/);
    await expect(
      admin.mutation(api.releases.setTracks, { slug: SLUG, tracks: [{ trackId: two.trackId, title: 'a' }, { trackId: two.trackId, title: 'b' }] }),
    ).rejects.toThrow(/twice/);
  });

  test('saveDesign validates with validateDesign and needs tracks and a cover first', async () => {
    const t = newTest();
    await seed(t);
    const admin = t.withIdentity(ADMIN);
    await admin.mutation(api.releases.createDraft, { slug: SLUG, title: 'BLOOD', artist: 'Tha Myind', year: 2026 });
    await expect(admin.mutation(api.releases.saveDesign, { slug: SLUG, design: DESIGN_LOOK })).rejects.toThrow(/tracks and the cover/);
    await draftWithMediaOn(t, admin);
    await expect(admin.mutation(api.releases.saveDesign, { slug: SLUG, design: { ...DESIGN_LOOK, shell: 'green' } })).rejects.toThrow(/shell: must be one of/);
    await expect(admin.mutation(api.releases.saveDesign, { slug: SLUG, design: { ...DESIGN_LOOK, shellTint: 'red' } })).rejects.toThrow(/shellTint/);
    const saved = await admin.mutation(api.releases.saveDesign, { slug: SLUG, design: DESIGN_LOOK });
    expect(saved).toMatchObject({ changed: true, designRev: 1 });
    const again = await admin.mutation(api.releases.saveDesign, { slug: SLUG, design: { ...DESIGN_LOOK } });
    expect(again).toMatchObject({ changed: false, designRev: 1, designHash: saved.designHash });
    expect(saved.design.coverArt).toMatch(/^https:\/\//);
  });

  test('rack art and bundles made from an older design, a wrong SHA-256 or a mismatched sheet are refused', async () => {
    const t = newTest();
    await seed(t);
    const { admin } = await draftWithMedia(t);
    const saved = await admin.mutation(api.releases.saveDesign, { slug: SLUG, design: DESIGN_LOOK });
    const png1 = await store(t, png(3072, 3072));
    await expect(
      admin.action(api.releases.attachRackArt, {
        slug: SLUG,
        spritePng: png1,
        spriteMeta: META,
        still: await store(t, png(1024, 1024)),
        designHash: 'stale',
      }),
    ).rejects.toThrow(/casing changed/);
    expect(await exists(t, png1)).toBe(false);
    await expect(
      admin.action(api.releases.attachRackArt, {
        slug: SLUG,
        spritePng: await store(t, png(2048, 2048)),
        spriteMeta: META,
        still: await store(t, png(1024, 1024)),
        designHash: saved.designHash,
      }),
    ).rejects.toThrow(/not the size/);
    const zip = zipBytes();
    const zipId = await store(t, zip);
    await expect(
      admin.action(api.releases.attachBundle, { slug: SLUG, version: '1.0.0', zip: zipId, sha256: 'a'.repeat(64), designHash: saved.designHash }),
    ).rejects.toThrow(/does not match its SHA-256/);
    expect(await exists(t, zipId)).toBe(false);
    await expect(
      admin.action(api.releases.attachBundle, { slug: SLUG, version: 'v1', zip: await store(t, zip), sha256: await sha256Hex(zip), designHash: saved.designHash }),
    ).rejects.toThrow(/look like 1.0.0/);
    await expect(
      admin.action(api.releases.attachBundle, { slug: SLUG, version: '1.0.0', zip: await store(t, png(10, 10)), sha256: await sha256Hex(zip), designHash: saved.designHash }),
    ).rejects.toThrow(/not a zip/);
  });
});

async function draftWithMediaOn(t: T, admin: ReturnType<T['withIdentity']>) {
  await admin.action(api.releases.attachTrackAudio, { slug: SLUG, file: await store(t, mp3(10)), durationSec: 10, title: 'Blood' });
  await admin.action(api.releases.attachCover, { slug: SLUG, file: await store(t, png(1500, 1500)) });
}

describe('publish', () => {
  test('refused until every piece is there, with a reason, and a schedule needs a future drop', async () => {
    const t = newTest();
    await seed(t);
    const { admin } = await draftWithMedia(t);
    await expect(admin.mutation(api.releases.publish, { slug: SLUG, status: 'live', reason: 'Launch' })).rejects.toThrow(
      /Save the casing/,
    );
    const saved = await admin.mutation(api.releases.saveDesign, { slug: SLUG, design: DESIGN_LOOK });
    await expect(admin.mutation(api.releases.publish, { slug: SLUG, status: 'live', reason: 'Launch' })).rejects.toThrow(
      /Render the rack art.*Build and upload the bundle/,
    );
    await renderAndBundle(t, admin, saved.designHash);
    await expect(admin.mutation(api.releases.publish, { slug: SLUG, status: 'live', reason: '  ' })).rejects.toThrow(/reason is required/);
    await expect(admin.mutation(api.releases.publish, { slug: SLUG, status: 'scheduled', reason: 'Launch' })).rejects.toThrow(/drop date/);
    await expect(
      admin.mutation(api.releases.publish, { slug: SLUG, status: 'scheduled', dropAt: Date.now() - HOUR, reason: 'Launch' }),
    ).rejects.toThrow(/future/);
    await expect(
      admin.mutation(api.releases.publish, { slug: SLUG, status: 'live', dropAt: Date.now() + HOUR, reason: 'Launch' }),
    ).rejects.toThrow(/future dropAt/);
    const dropAt = Date.now() + 24 * HOUR;
    const published = await admin.mutation(api.releases.publish, { slug: SLUG, status: 'scheduled', dropAt, reason: 'Launch' });
    expect(published).toMatchObject({ slug: SLUG, status: 'scheduled', dropAt });
    const product = await t.run(async (ctx) => (await ctx.db.query('products').withIndex('by_slug', (q) => q.eq('slug', SLUG)).unique())!);
    expect(product).toMatchObject({ status: 'scheduled', dropAt, active: true });
    // Published: the portal no longer edits it.
    await expect(admin.mutation(api.releases.saveDesign, { slug: SLUG, design: DESIGN_LOOK })).rejects.toThrow(/already published/);
    await expect(admin.mutation(api.releases.publish, { slug: SLUG, status: 'live', reason: 'Again' })).rejects.toThrow(/Only a draft/);
    const actions = (await t.run((ctx) => ctx.db.query('auditLog').collect())).map((row) => row.action);
    expect(actions).toEqual([
      'release.create',
      'release.track.audio',
      'release.track.audio',
      'release.cover',
      'release.design',
      'release.rack',
      'release.bundle',
      'release.publish',
    ]);
    const publishRow = await t.run(async (ctx) => (await ctx.db.query('auditLog').collect()).at(-1)!);
    expect(publishRow).toMatchObject({ reason: 'Launch', target: `product:${SLUG}` });
    expect(publishRow.before).toMatchObject({ status: 'draft', active: false });
    expect(publishRow.after).toMatchObject({ status: 'scheduled', active: true, dropAt });
  });

  test('live now takes dropAt = now', async () => {
    const t = newTest();
    await seed(t);
    await readyDraft(t);
    const before = Date.now();
    const published = await t.withIdentity(ADMIN).mutation(api.releases.publish, { slug: SLUG, status: 'live', reason: 'Surprise drop' });
    expect(published.status).toBe('live');
    expect(published.dropAt).toBeGreaterThanOrEqual(before);
  });
});

// ── What the app sees ──────────────────────────────────────────────────────────────────────────────────────

describe('app.library and app.context', () => {
  test('a published release carries design, rack and bundle; LIT carries nulls; drafts leak nothing', async () => {
    const t = newTest();
    await seed(t);
    const { saved, bundle } = await readyDraft(t);

    // While it's a draft: not in the library, and the context hides its art and bundle.
    const draftContext = await t.withIdentity(STRANGER).query(api.app.context, { slug: SLUG });
    expect(draftContext).toMatchObject({ design: null, rack: null, bundle: null });
    expect((await t.withIdentity(STRANGER).query(api.app.library, {})).releases.map((r) => r.slug)).not.toContain(SLUG);

    const dropAt = Date.now() + 2 * HOUR;
    await t.withIdentity(ADMIN).mutation(api.releases.publish, { slug: SLUG, status: 'scheduled', dropAt, reason: 'Launch' });

    const library = await t.withIdentity(OWNER).query(api.app.library, {});
    const lit = library.releases.find((r) => r.slug === 'lit')!;
    expect(lit).toMatchObject({ ownership: 'owned', design: null, rack: null, bundle: null });
    const blood = library.releases.find((r) => r.slug === SLUG)!;
    expect(blood).toMatchObject({ ownership: 'locked', status: 'scheduled', dropAt, title: 'BLOOD' });
    expect(blood.design).toEqual(saved.design);
    expect(blood.design).toMatchObject({ v: 1, slug: SLUG, shell: 'red', labelStyle: 'sticker', tracks: [{ n: 1 }, { n: 2 }] });
    expect(blood.rack).toEqual({
      spriteUrl: expect.stringMatching(/^https:\/\//),
      spriteFormat: 'webp',
      spriteMeta: { ...META, format: 'image/webp' },
      pngSpriteUrl: expect.stringMatching(/^https:\/\//),
      stillUrl: expect.stringMatching(/^https:\/\//),
    });
    expect(blood.bundle).toEqual({ version: '1.0.0+r1', url: bundle.url, sha256: bundle.sha256 });
    expect(blood.bundle?.url).toMatch(/^https:\/\//);

    const context = await t.query(api.app.context, { slug: SLUG });
    expect(context).toMatchObject({ ownership: 'locked', design: saved.design, bundle: blood.bundle, rack: blood.rack });

    // Audio stays gated: no track storage id or URL reaches the app.
    const audioIds = await t.run(async (ctx) => (await ctx.db.query('tracks').collect()).map((track) => track.streamFile!));
    const json = JSON.stringify([library, context]);
    for (const id of audioIds) expect(json).not.toContain(id);
  });

  test('without a WebP sheet the rack falls back to the PNG', async () => {
    const t = newTest();
    await seed(t);
    const { admin } = await draftWithMedia(t);
    const saved = await admin.mutation(api.releases.saveDesign, { slug: SLUG, design: DESIGN_LOOK });
    await admin.action(api.releases.attachRackArt, {
      slug: SLUG,
      spritePng: await store(t, png(3072, 3072)),
      spriteMeta: { ...META, format: 'image/png' },
      still: await store(t, png(1024, 1024)),
      designHash: saved.designHash,
    });
    const zip = zipBytes();
    await admin.action(api.releases.attachBundle, { slug: SLUG, version: '1.0.0', zip: await store(t, zip), sha256: await sha256Hex(zip), designHash: saved.designHash });
    await admin.mutation(api.releases.publish, { slug: SLUG, status: 'live', reason: 'Launch' });
    const context = await t.query(api.app.context, { slug: SLUG });
    expect(context.rack).toMatchObject({ spriteFormat: 'png', spriteMeta: { format: 'image/png' } });
    expect(context.rack?.spriteUrl).toBe(context.rack?.pngSpriteUrl);
  });
});

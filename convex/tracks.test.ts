import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';


describe('entitlements.mine', () => {
  test('owner sees lit, stranger and signed-out see nothing', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    expect(await t.withIdentity(OWNER).query(api.entitlements.mine, {})).toEqual(['lit']);
    expect(await t.withIdentity(STRANGER).query(api.entitlements.mine, {})).toEqual([]);
    expect(await t.query(api.entitlements.mine, {})).toEqual([]);
  });
});

describe('tracks.listForPlayer', () => {
  test('owner gets 6 ordered tracks with their own file links from Convex storage', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    const before = Date.now();
    const result = await t.withIdentity(OWNER).action(api.tracks.listForPlayer, { product: 'lit' });
    expect(result.tracks.map((track) => track.position)).toEqual([1, 2, 3, 4, 5, 6]);
    const urls = result.tracks.map((track) => track.streamUrl);
    expect(urls.every((url) => typeof url === 'string' && url.length > 0)).toBe(true);
    expect(new Set(urls).size).toBe(6);
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 6 * 60 * 60 * 1000);
  });

  test('before the songs are uploaded, owners get a not-configured error (the page falls back to previews)', async () => {
    const t = newTest();
    await seedLitWithOwner(t, { uploaded: false });
    await expect(t.withIdentity(OWNER).action(api.tracks.listForPlayer, { product: 'lit' })).rejects.toThrow(
      /NOT_CONFIGURED|not been uploaded/,
    );
  });

  test('stranger is refused', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    await expect(t.withIdentity(STRANGER).action(api.tracks.listForPlayer, { product: 'lit' })).rejects.toThrow(
      /NOT_ENTITLED|No license/,
    );
  });

  test('signed-out visitor is refused', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    await expect(t.action(api.tracks.listForPlayer, { product: 'lit' })).rejects.toThrow(/UNAUTHENTICATED|Sign in/);
  });

  test('seed upserts by position', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    await t.mutation(internal.tracks.seed, {
      slug: 'lit',
      tracks: [{ position: 1, title: 'Renamed', durationSeconds: 191.84 }],
    });
    const rows = await t.query(internal.tracks.listBySlug, { slug: 'lit' });
    expect(rows).toHaveLength(6);
    expect(rows[0].title).toBe('Renamed');
  });
});

describe('upload flow', () => {
  test('attaching a new file replaces the old one and deletes it from storage', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t);
    const oldFile = (await t.run((ctx) => ctx.db.get(trackIds[0])))!.streamFile!;
    const newFile = await t.run((ctx) => ctx.storage.store(new Blob(['new master'], { type: 'audio/mpeg' })));
    const result = await t.mutation(internal.tracks.attachTrackFile, { slug: 'lit', position: 1, kind: 'stream', file: newFile });
    expect(result.replaced).toBe(true);
    expect((await t.run((ctx) => ctx.db.get(trackIds[0])))!.streamFile).toBe(newFile);
    expect(await t.run((ctx) => ctx.storage.getUrl(oldFile))).toBeNull();
    const hashes = await t.query(internal.tracks.fileHashes, { slug: 'lit' });
    expect(hashes.tracks[0].stream).toEqual(expect.any(String));
    expect(hashes.download).toEqual(expect.any(String));
  });
});

describe('downloads.mine', () => {
  test('owner gets the album download link, stranger is refused', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    const { url } = await t.withIdentity(OWNER).action(api.downloads.mine, { product: 'lit' });
    expect(url.length).toBeGreaterThan(0);
    await expect(t.withIdentity(STRANGER).action(api.downloads.mine, { product: 'lit' })).rejects.toThrow(/NOT_ENTITLED|No license/);
  });
});

describe('plays', () => {
  test('owner can log, stranger cannot', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t);
    await t.withIdentity(OWNER).mutation(api.plays.log, { trackId: trackIds[0] });
    await expect(t.withIdentity(STRANGER).mutation(api.plays.log, { trackId: trackIds[0] })).rejects.toThrow(
      /NOT_ENTITLED|No license/,
    );
    const plays = await t.run((ctx) => ctx.db.query('plays').collect());
    expect(plays).toHaveLength(1);
  });

  test('prune removes only plays older than 365 days', async () => {
    const t = newTest();
    const { trackIds, ownerId } = await seedLitWithOwner(t);
    const day = 24 * 60 * 60 * 1000;
    await t.run(async (ctx) => {
      await ctx.db.insert('plays', { userId: ownerId, trackId: trackIds[0], playedAt: Date.now() - 366 * day });
      await ctx.db.insert('plays', { userId: ownerId, trackId: trackIds[0], playedAt: Date.now() - 364 * day });
    });
    const result = await t.mutation(internal.plays.prune, {});
    expect(result.deleted).toBe(1);
    expect(await t.run((ctx) => ctx.db.query('plays').collect())).toHaveLength(1);
  });
});

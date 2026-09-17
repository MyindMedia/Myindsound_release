import { describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

vi.mock('./lib/r2', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./lib/r2')>();
  return { ...actual, signGetUrl: vi.fn(async (key: string, ttl: number) => `https://r2.test/${key}?ttl=${ttl}`) };
});

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
  test('owner gets 6 ordered tracks with 2-hour signed URLs', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    const before = Date.now();
    const result = await t.withIdentity(OWNER).action(api.tracks.listForPlayer, { product: 'lit' });
    expect(result.tracks.map((track) => track.position)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.tracks[0].streamUrl).toBe('https://r2.test/lit/stream/01.mp3?ttl=7200');
    expect(result.expiresAt).toBeGreaterThanOrEqual(before + 7200 * 1000);
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
      tracks: [{ position: 1, title: 'Renamed', durationSeconds: 191.84, streamKey: 'a', originalKey: 'a' }],
    });
    const rows = await t.query(internal.tracks.listBySlug, { slug: 'lit' });
    expect(rows).toHaveLength(6);
    expect(rows[0].title).toBe('Renamed');
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

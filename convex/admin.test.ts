import { describe, expect, test } from 'vitest';
import { api } from './_generated/api';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

describe('admin.stats', () => {
  test('refuses non-admins and allows the users.isAdmin flag', async () => {
    const t = newTest();
    const { ownerId, trackIds } = await seedLitWithOwner(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('plays', { userId: ownerId, trackId: trackIds[2], playedAt: Date.now() });
      await ctx.db.patch(ownerId, { isAdmin: true });
    });
    await expect(t.withIdentity(STRANGER).query(api.admin.stats, {})).rejects.toThrow(/FORBIDDEN|Admins only/);
    const stats = await t.withIdentity(OWNER).query(api.admin.stats, {});
    expect(stats.totals).toEqual({ plays: 1, users: 2, purchases: 1 });
    expect(stats.recentPlays[0]).toMatchObject({ track: 'Track 3', listener: OWNER.subject });
    expect(JSON.stringify(stats)).not.toContain('@');
  });

  test('ADMIN_EMAILS grants admin by verified email', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    process.env.ADMIN_EMAILS = 'stranger@example.test';
    try {
      const stats = await t.withIdentity(STRANGER).query(api.admin.stats, {});
      expect(stats.totals.users).toBe(2);
      expect(await t.withIdentity(STRANGER).query(api.users.me, {})).toMatchObject({ isAdmin: true });
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });
});

describe('dashboard queries', () => {
  test('owned products and orders are scoped to the caller', async () => {
    const t = newTest();
    const { ownerId } = await seedLitWithOwner(t);
    await t.run((ctx) =>
      ctx.db.insert('orders', {
        userId: ownerId,
        stripeSessionId: 'cs_test_order',
        totalCents: 4500,
        currency: 'usd',
        status: 'paid',
        createdAt: Date.now(),
      }),
    );
    expect(await t.withIdentity(OWNER).query(api.products.owned, {})).toEqual([
      expect.objectContaining({ slug: 'lit', hasDownload: true }),
    ]);
    expect(await t.withIdentity(STRANGER).query(api.products.owned, {})).toEqual([]);
    expect(await t.withIdentity(OWNER).query(api.orders.mine, {})).toHaveLength(1);
    expect(await t.withIdentity(STRANGER).query(api.orders.mine, {})).toEqual([]);
  });
});

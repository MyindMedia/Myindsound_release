import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

describe('privacy', () => {
  test('export contains only the caller data', async () => {
    const t = newTest();
    const { trackIds, ownerId, strangerId } = await seedLitWithOwner(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('plays', { userId: ownerId, trackId: trackIds[0], playedAt: Date.now() });
      await ctx.db.insert('plays', { userId: strangerId, trackId: trackIds[1], playedAt: Date.now() });
    });
    const data = await t.withIdentity(OWNER).query(api.privacy.exportMyData, {});
    expect(data.profile.email).toBe(OWNER.email);
    expect(data.purchases).toEqual([expect.objectContaining({ product: 'LIT' })]);
    expect(data.plays).toHaveLength(1);
    expect(data.plays[0].track).toBe('Track 1');
  });

  test('export requires sign-in', async () => {
    const t = newTest();
    await expect(t.query(api.privacy.exportMyData, {})).rejects.toThrow(/UNAUTHENTICATED|Sign in/);
  });

  test('wipe deletes plays, entitlements and the profile, and strips shipping from orders', async () => {
    const t = newTest();
    const { trackIds, ownerId } = await seedLitWithOwner(t);
    await t.run(async (ctx) => {
      await ctx.db.insert('plays', { userId: ownerId, trackId: trackIds[0], playedAt: Date.now() });
      await ctx.db.insert('orders', {
        userId: ownerId,
        stripeSessionId: 'cs_test_order',
        totalCents: 4500,
        currency: 'usd',
        shipping: { name: 'Owner', line1: '1 Main', city: 'LA', postalCode: '90001', country: 'US' },
        status: 'paid',
        createdAt: Date.now(),
      });
    });
    const result = await t.mutation(internal.privacy.wipeUserData, { userId: ownerId });
    expect(result).toEqual({ plays: 1, entitlements: 1, ordersAnonymised: 1 });
    const [order] = await t.run((ctx) => ctx.db.query('orders').collect());
    expect(order.shipping).toBeUndefined();
    expect(order.totalCents).toBe(4500);
    expect(await t.run((ctx) => ctx.db.get(ownerId))).toBeNull();
    expect(await t.withIdentity(STRANGER).query(api.entitlements.mine, {})).toEqual([]);
  });
});

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

  test('export and wipe cover app play events and push tokens; the wear they added stays on the copy (NFR-2)', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t);
    await t.mutation(internal.migrations.assignEditions, {});
    const startedAtClient = Date.now() - 60 * 60 * 1000;
    await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, {
      events: [{ idempotencyKey: 'privacy-0000-0001', trackId: trackIds[0], startedAtClient, playedSec: 60 }],
    });
    await t.withIdentity(OWNER).mutation(api.push.registerToken, { token: 'c'.repeat(64), platform: 'ios', wantsDropAlerts: true });
    await t.withIdentity(STRANGER).mutation(api.push.registerToken, { token: 'd'.repeat(64), platform: 'ios', wantsDropAlerts: true });

    const data = await t.withIdentity(OWNER).query(api.privacy.exportMyData, {});
    expect(data.playEvents).toEqual([expect.objectContaining({ kind: 'play', track: 'Track 1', playedSec: 60, countedSec: 60, borrowed: false })]);
    expect(data.pushTokens).toEqual([expect.objectContaining({ platform: 'ios', token: 'c'.repeat(64), wantsDropAlerts: true })]);
    expect(data.profile.leaderboardVisible).toBe(true);

    const ownerId = (await t.run((ctx) => ctx.db.query('users').collect())).find((u) => u.clerkId === OWNER.subject)!._id;
    const result = await t.mutation(internal.privacy.wipeUserData, { userId: ownerId });
    expect(result).toMatchObject({ playEvents: 1, pushTokens: 1 });
    expect(await t.run((ctx) => ctx.db.query('playEvents').collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query('pushTokens').collect())).toHaveLength(1);
    const [row] = await t.run((ctx) => ctx.db.query('entitlements').collect());
    expect(row.status).toBe('retired');
    expect(row.wearStats!.playSeconds).toBe(60);
  });

  test('export requires sign-in', async () => {
    const t = newTest();
    await expect(t.query(api.privacy.exportMyData, {})).rejects.toThrow(/UNAUTHENTICATED|Sign in/);
  });

  test('wipe deletes plays and the profile, retires licences, and strips shipping from orders', async () => {
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
    expect(result).toEqual({ plays: 1, playEvents: 0, pushTokens: 0, entitlementsRetired: 1, ordersAnonymised: 1 });
    const [order] = await t.run((ctx) => ctx.db.query('orders').collect());
    expect(order.shipping).toBeUndefined();
    expect(order.totalCents).toBe(4500);
    expect(await t.run((ctx) => ctx.db.get(ownerId))).toBeNull();
    expect(await t.withIdentity(STRANGER).query(api.entitlements.mine, {})).toEqual([]);
  });

  test('a deleted account keeps its edition reserved as retired: never deleted, never owned, never reissued', async () => {
    const t = newTest();
    const { litId, ownerId } = await seedLitWithOwner(t);
    await t.mutation(internal.migrations.assignEditions, {});
    const [before] = await t.run((ctx) => ctx.db.query('entitlements').collect());
    expect(before.editionNumber).toBe(1);

    await t.mutation(internal.privacy.wipeUserData, { userId: ownerId });
    const [retired] = await t.run((ctx) => ctx.db.query('entitlements').collect());
    expect(retired._id).toBe(before._id);
    expect(retired.userId).toBeUndefined();
    expect(retired).toMatchObject({
      status: 'retired',
      editionNumber: 1,
      wearSeed: before.wearSeed,
      wearStats: before.wearStats,
      productId: litId,
    });
    expect(retired.retiredAt).toBeTypeOf('number');

    // The same person signing up again and buying is a new licence with a new edition.
    const again = await t.mutation(internal.fulfilment.record, {
      sessionId: 'cs_after_delete',
      clerkId: OWNER.subject,
      email: OWNER.email,
      amountTotal: 500,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    });
    expect(again.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 2 }]);
    // Replaying the deleted account's old session does not revive it.
    const replay = await t.mutation(internal.fulfilment.record, {
      sessionId: 'cs_test_owner',
      clerkId: OWNER.subject,
      email: OWNER.email,
      amountTotal: 500,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    });
    expect(replay.grants).toEqual([{ slug: 'lit', outcome: 'retired', editionNumber: 1 }]);
    expect(await t.query(internal.fulfilment.sessionHolder, { sessionId: 'cs_test_owner' })).toEqual({ status: 'retired' });
    expect(await t.withIdentity(OWNER).query(api.entitlements.mine, {})).toEqual(['lit']);
  });

  test('a refunded licence whose account is deleted stays revoked, and replaying it says revoked, not taken', async () => {
    const t = newTest();
    const { ownerId } = await seedLitWithOwner(t);
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_owner' });
    await t.mutation(internal.privacy.wipeUserData, { userId: ownerId });
    const [row] = await t.run((ctx) => ctx.db.query('entitlements').collect());
    expect(row.status).toBe('revoked');
    expect(row.userId).toBeUndefined();
    const replay = await t.mutation(internal.fulfilment.record, {
      sessionId: 'cs_test_owner',
      clerkId: 'user_someone_new',
      email: 'new@example.test',
      amountTotal: 500,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    });
    expect(replay.grants[0].outcome).toBe('revoked');
  });
});

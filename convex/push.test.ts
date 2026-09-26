import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

const TOKEN = 'a'.repeat(64);

describe('push tokens (DROP-6)', () => {
  test('registerToken upserts by token; a device that switches accounts moves with it', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    const first = await t.withIdentity(OWNER).mutation(api.push.registerToken, { token: TOKEN, platform: 'ios', wantsDropAlerts: true });
    expect(first).toEqual({ registered: true, created: true });
    const again = await t.withIdentity(OWNER).mutation(api.push.registerToken, { token: TOKEN, platform: 'ios', wantsDropAlerts: false });
    expect(again.created).toBe(false);
    let rows = await t.run((ctx) => ctx.db.query('pushTokens').collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ wantsDropAlerts: false, wantsLendAlerts: true, platform: 'ios' });

    await t.withIdentity(STRANGER).mutation(api.push.registerToken, { token: TOKEN, platform: 'ios', wantsDropAlerts: true });
    rows = await t.run((ctx) => ctx.db.query('pushTokens').collect());
    expect(rows).toHaveLength(1);
    expect((await t.withIdentity(OWNER).query(api.push.preferences, {})).devices).toBe(0);
    expect((await t.withIdentity(STRANGER).query(api.push.preferences, {})).devices).toBe(1);
  });

  test('category toggles apply to every device; unregister only removes your own token', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    const owner = t.withIdentity(OWNER);
    await owner.mutation(api.push.registerToken, { token: TOKEN, platform: 'ios', wantsDropAlerts: true });
    await owner.mutation(api.push.registerToken, { token: 'b'.repeat(64), platform: 'ios', wantsDropAlerts: true, environment: 'sandbox' });
    expect(await owner.query(api.push.preferences, {})).toEqual({ devices: 2, drops: true, lends: true });
    expect(await owner.mutation(api.push.setAlertCategory, { category: 'drops', enabled: false })).toEqual({ updated: 2 });
    expect(await owner.mutation(api.push.setAlertCategory, { category: 'lends', enabled: false })).toEqual({ updated: 2 });
    expect(await owner.query(api.push.preferences, {})).toEqual({ devices: 2, drops: false, lends: false });
    expect(await t.query(internal.push.dropAlertTokenCount, {})).toBe(0);

    expect(await t.withIdentity(STRANGER).mutation(api.push.unregisterToken, { token: TOKEN })).toEqual({ removed: false });
    expect(await owner.mutation(api.push.unregisterToken, { token: TOKEN })).toEqual({ removed: true });
    expect((await owner.query(api.push.preferences, {})).devices).toBe(1);
  });

  test('rejects junk tokens and signed-out callers', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    await expect(
      t.withIdentity(OWNER).mutation(api.push.registerToken, { token: 'x', platform: 'ios', wantsDropAlerts: true }),
    ).rejects.toThrow(/INVALID_INPUT|device token/);
    await expect(t.mutation(api.push.registerToken, { token: TOKEN, platform: 'ios', wantsDropAlerts: true })).rejects.toThrow(
      /UNAUTHENTICATED|Sign in/,
    );
  });

  test('the drop-live sender is a stub until APNs is configured', async () => {
    const t = newTest();
    const { litId } = await seedLitWithOwner(t);
    await t.withIdentity(OWNER).mutation(api.push.registerToken, { token: TOKEN, platform: 'ios', wantsDropAlerts: true });
    expect(await t.action(internal.push.sendDropLive, { productId: litId })).toEqual({
      sent: 0,
      devices: 1,
      reason: 'APNS_NOT_CONFIGURED',
    });
  });
});

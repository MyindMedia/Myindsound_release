import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalQuery, mutation, query } from './_generated/server';
import { ensureViewer, getViewer } from './lib/auth';
import { fail } from './lib/errors';

/**
 * Push device tokens and alert categories (DROP-6, LEND-11). Registration is live; sending is a stub until the
 * APNs key is set up (see `sendDropLive`).
 */

export type AlertCategory = 'drops' | 'lends';

// APNs tokens are 64 hex characters today; FCM tokens are longer and use a wider alphabet.
const TOKEN_PATTERN = /^[A-Za-z0-9:_\-.]{16,512}$/;

/** Upserts by token: a device that signs in to another account moves to that account. */
export const registerToken = mutation({
  args: {
    token: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android')),
    wantsDropAlerts: v.boolean(),
    wantsLendAlerts: v.optional(v.boolean()),
    environment: v.optional(v.union(v.literal('sandbox'), v.literal('production'))),
  },
  handler: async (ctx, { token, platform, wantsDropAlerts, wantsLendAlerts, environment }) => {
    if (!TOKEN_PATTERN.test(token)) fail('INVALID_INPUT', 'That does not look like a device token.');
    const user = await ensureViewer(ctx);
    const existing = await ctx.db
      .query('pushTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();
    const row = {
      userId: user._id,
      token,
      platform,
      wantsDropAlerts,
      wantsLendAlerts: wantsLendAlerts ?? existing?.wantsLendAlerts ?? true,
      ...(environment ? { environment } : existing?.environment ? { environment: existing.environment } : {}),
      updatedAt: Date.now(),
    };
    if (existing) await ctx.db.replace(existing._id, row);
    else await ctx.db.insert('pushTokens', row);
    return { registered: true, created: existing === null };
  },
});

/** Sign out on this device: stops its alerts. Only the token's own account can remove it. */
export const unregisterToken = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await ensureViewer(ctx);
    const existing = await ctx.db
      .query('pushTokens')
      .withIndex('by_token', (q) => q.eq('token', token))
      .unique();
    if (!existing || existing.userId !== user._id) return { removed: false };
    await ctx.db.delete(existing._id);
    return { removed: true };
  },
});

/** DROP-6 category toggle, applied to every device of the caller. */
export const setAlertCategory = mutation({
  args: { category: v.union(v.literal('drops'), v.literal('lends')), enabled: v.boolean() },
  handler: async (ctx, { category, enabled }) => {
    const user = await ensureViewer(ctx);
    const rows = await ctx.db
      .query('pushTokens')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();
    const now = Date.now();
    for (const row of rows) {
      await ctx.db.patch(row._id, {
        ...(category === 'drops' ? { wantsDropAlerts: enabled } : { wantsLendAlerts: enabled }),
        updatedAt: now,
      });
    }
    return { updated: rows.length };
  },
});

/** The caller's alert settings. A category is on when any of their devices wants it (on by default). */
export const preferences = query({
  args: {},
  handler: async (ctx) => {
    const user = await getViewer(ctx);
    const rows = user
      ? await ctx.db
          .query('pushTokens')
          .withIndex('by_user', (q) => q.eq('userId', user._id))
          .collect()
      : [];
    return {
      devices: rows.length,
      drops: rows.length === 0 ? true : rows.some((r) => r.wantsDropAlerts),
      lends: rows.length === 0 ? true : rows.some((r) => r.wantsLendAlerts !== false),
    };
  },
});

export const dropAlertTokenCount = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('pushTokens').collect();
    return rows.filter((r) => r.wantsDropAlerts).length;
  },
});

/**
 * STUB (DROP-6): "drop is live" push, scheduled by `app.flipDueDrops`. APNs keys are not set up, so this only
 * counts the devices it would reach. To go live: add `APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY` (p8) and
 * `APNS_TOPIC` (bundle id) to the Convex env, sign an ES256 provider JWT, and POST to
 * `https://api.push.apple.com/3/device/<token>` (sandbox tokens to api.sandbox.push.apple.com), deleting tokens
 * APNs answers 410 for. T-24h, T-1h and lend alerts (LEND-11) follow the same shape.
 */
export const sendDropLive = internalAction({
  args: { productId: v.id('products') },
  handler: async (
    ctx,
    { productId },
  ): Promise<{ sent: number; devices: number; reason: 'APNS_NOT_CONFIGURED' | 'NOT_IMPLEMENTED' }> => {
    const devices: number = await ctx.runQuery(internal.push.dropAlertTokenCount, {});
    if (!process.env.APNS_KEY_ID) {
      console.log(`push stub: drop live for ${productId}, ${devices} device(s) opted in, APNs not configured`);
      return { sent: 0, devices, reason: 'APNS_NOT_CONFIGURED' as const };
    }
    // TODO(push): send through APNs here.
    return { sent: 0, devices, reason: 'NOT_IMPLEMENTED' as const };
  },
});

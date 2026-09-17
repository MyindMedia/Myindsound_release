import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action, internalMutation, internalQuery, query } from './_generated/server';
import { requireViewer } from './lib/auth';
import { deleteClerkUser } from './lib/clerkApi';
import { fail } from './lib/errors';
import { deleteGhlContactByEmail, ghlConfigured } from './lib/ghlApi';

export const exportMyData = query({
  args: {},
  handler: async (ctx) => {
    const user = await requireViewer(ctx);
    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_user_product', (q) => q.eq('userId', user._id))
      .collect();
    const purchases = [];
    for (const row of entitlements) {
      const product = await ctx.db.get(row.productId);
      purchases.push({ product: product?.name ?? 'Unknown', grantedAt: new Date(row.grantedAt).toISOString() });
    }
    const orderRows = await ctx.db
      .query('orders')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();
    const orders = [];
    for (const order of orderRows) {
      const items = await ctx.db
        .query('orderItems')
        .withIndex('by_order', (q) => q.eq('orderId', order._id))
        .collect();
      orders.push({
        createdAt: new Date(order.createdAt).toISOString(),
        status: order.status,
        totalCents: order.totalCents,
        currency: order.currency,
        shipping: order.shipping ?? null,
        items: items.map((item) => ({ description: item.description, quantity: item.quantity, unitCents: item.unitCents })),
      });
    }
    const playRows = await ctx.db
      .query('plays')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();
    const plays = [];
    for (const play of playRows) {
      const track = await ctx.db.get(play.trackId);
      plays.push({ track: track?.title ?? 'Unknown', playedAt: new Date(play.playedAt).toISOString() });
    }
    return {
      exportedAt: new Date().toISOString(),
      profile: {
        email: user.email,
        name: user.name ?? null,
        marketingConsentAt: user.marketingConsentAt ? new Date(user.marketingConsentAt).toISOString() : null,
      },
      purchases,
      orders,
      plays,
    };
  },
});

export const userByClerkId = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    return await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique();
  },
});

// Deletes personal data. Orders keep amounts (tax records) with shipping details removed.
export const wipeUserData = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const plays = await ctx.db
      .query('plays')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const row of plays) await ctx.db.delete(row._id);
    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_user_product', (q) => q.eq('userId', userId))
      .collect();
    for (const row of entitlements) await ctx.db.delete(row._id);
    const orders = await ctx.db
      .query('orders')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const order of orders) await ctx.db.patch(order._id, { shipping: undefined });
    await ctx.db.delete(userId);
    return { plays: plays.length, entitlements: entitlements.length, ordersAnonymised: orders.length };
  },
});

export const deleteMyData = action({
  args: { confirm: v.literal('DELETE') },
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) fail('UNAUTHENTICATED', 'Sign in to delete your account.');
    const user = await ctx.runQuery(internal.privacy.userByClerkId, { clerkId: identity.subject });
    if (user) await ctx.runMutation(internal.privacy.wipeUserData, { userId: user._id });

    let crm = 'skipped';
    if (user?.email && ghlConfigured()) {
      crm = (await deleteGhlContactByEmail(user.email).catch(() => false)) ? 'deleted' : 'failed';
    }
    const account = (await deleteClerkUser(identity.subject).catch(() => false)) ? 'deleted' : 'failed';
    if (crm === 'failed' || account === 'failed') {
      console.error(`privacy delete incomplete for ${identity.subject}: account=${account} crm=${crm}`);
    }
    return { account, crm };
  },
});

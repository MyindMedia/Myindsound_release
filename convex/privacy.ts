import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action, internalMutation, internalQuery, query } from './_generated/server';
import { requireViewer } from './lib/auth';
import { deleteClerkUser } from './lib/clerkApi';
import { fail } from './lib/errors';
import { deleteGhlContactByEmail, ghlConfigured } from './lib/ghlApi';
import { transitionLend } from './lendLogic';

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
      purchases.push({
        product: product?.name ?? 'Unknown',
        grantedAt: new Date(row.grantedAt).toISOString(),
        editionNumber: row.editionNumber ?? null,
        status: row.status ?? 'active',
      });
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
    // App play, load and eject events this account made (as owner or borrower).
    const eventRows = await ctx.db
      .query('playEvents')
      .withIndex('by_actor', (q) => q.eq('actorUserId', user._id))
      .collect();
    const playEvents = [];
    for (const event of eventRows) {
      const track = event.trackId ? await ctx.db.get(event.trackId) : null;
      playEvents.push({
        kind: event.kind,
        track: track?.title ?? null,
        startedAt: new Date(event.startedAtClient).toISOString(),
        receivedAt: new Date(event.receivedAt).toISOString(),
        playedSec: event.playedSec,
        countedSec: event.countedSec,
        borrowed: event.lendId !== undefined,
      });
    }
    const tokenRows = await ctx.db
      .query('pushTokens')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .collect();
    const pushTokens = tokenRows.map((row) => ({
      platform: row.platform,
      token: row.token,
      wantsDropAlerts: row.wantsDropAlerts,
      wantsLendAlerts: row.wantsLendAlerts !== false,
      updatedAt: new Date(row.updatedAt).toISOString(),
    }));
    // Lends in both roles (NFR-2). The other person is never named: their data is not the caller's.
    const lends = [];
    const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
    const lendRows = [
      ...(await ctx.db
        .query('lends')
        .withIndex('by_lender', (q) => q.eq('lenderUserId', user._id))
        .collect()).map((row) => ({ row, role: 'lender' as const })),
      ...(await ctx.db
        .query('lends')
        .withIndex('by_borrower_status', (q) => q.eq('borrowerUserId', user._id))
        .collect()).map((row) => ({ row, role: 'borrower' as const })),
    ];
    for (const { row, role } of lendRows) {
      const copy = await ctx.db.get(row.entitlementId);
      const product = copy ? await ctx.db.get(copy.productId) : null;
      lends.push({
        role,
        release: product?.name ?? 'Unknown',
        status: row.status,
        channel: row.channel,
        playsAllowed: row.playsAllowed,
        playsUsed: row.playsUsed,
        offeredAt: iso(row.offeredAt),
        claimedAt: iso(row.claimedAt),
        expiresAt: iso(row.expiresAt),
        endedAt: iso(row.endedAt),
        endReason: row.endReason ?? null,
      });
    }
    return {
      exportedAt: new Date().toISOString(),
      profile: {
        email: user.email,
        name: user.name ?? null,
        marketingConsentAt: user.marketingConsentAt ? new Date(user.marketingConsentAt).toISOString() : null,
        leaderboardVisible: user.leaderboardVisible !== false,
      },
      purchases,
      orders,
      plays,
      playEvents,
      pushTokens,
      lends,
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

// Deletes personal data. Orders keep amounts (tax records) with shipping details removed. Licences are never
// deleted: they are detached from the account and kept as retired editions (edition number, wear and payment
// refs stay, nothing personal does), so the number stays reserved and is never reissued (§3A, NFR-2).
export const wipeUserData = internalMutation({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const plays = await ctx.db
      .query('plays')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const row of plays) await ctx.db.delete(row._id);
    // App play events this account made. The wear they added stays on the copy (cumulative wearStats, NFR-2).
    const playEvents = await ctx.db
      .query('playEvents')
      .withIndex('by_actor', (q) => q.eq('actorUserId', userId))
      .collect();
    for (const row of playEvents) await ctx.db.delete(row._id);
    const pushTokens = await ctx.db
      .query('pushTokens')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const row of pushTokens) await ctx.db.delete(row._id);
    // Lends (NFR-2). As borrower: an open lend ends (the lender gets their copy back) and the row is detached,
    // so the lender keeps their history with nobody named. As lender: the copy is about to be retired, so its
    // lends, their play sessions and push intents are deleted, which also ends the borrower's access at once.
    const now = Date.now();
    const borrowed = await ctx.db
      .query('lends')
      .withIndex('by_borrower_status', (q) => q.eq('borrowerUserId', userId))
      .collect();
    for (const row of borrowed) {
      if (row.status === 'active') await transitionLend(ctx, row, 'returned', now, 'borrower_deleted');
      await ctx.db.patch(row._id, { borrowerUserId: undefined });
    }
    const lent = await ctx.db
      .query('lends')
      .withIndex('by_lender', (q) => q.eq('lenderUserId', userId))
      .collect();
    for (const row of lent) {
      const sessions = await ctx.db
        .query('lentPlays')
        .withIndex('by_lend_track', (q) => q.eq('lendId', row._id))
        .collect();
      for (const session of sessions) await ctx.db.delete(session._id);
      const lendNotices = await ctx.db
        .query('lendNotices')
        .withIndex('by_lend_kind', (q) => q.eq('lendId', row._id))
        .collect();
      for (const notice of lendNotices) await ctx.db.delete(notice._id);
      await ctx.db.delete(row._id);
    }
    const ownNotices = await ctx.db
      .query('lendNotices')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const notice of ownNotices) await ctx.db.delete(notice._id);
    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_user_product', (q) => q.eq('userId', userId))
      .collect();
    for (const row of entitlements) {
      // A refunded licence keeps its revoked status; everything else becomes retired.
      await ctx.db.patch(row._id, {
        userId: undefined,
        retiredAt: now,
        ...(row.status === 'revoked' ? {} : { status: 'retired' as const }),
      });
    }
    const orders = await ctx.db
      .query('orders')
      .withIndex('by_user', (q) => q.eq('userId', userId))
      .collect();
    for (const order of orders) await ctx.db.patch(order._id, { shipping: undefined });
    await ctx.db.delete(userId);
    return {
      plays: plays.length,
      playEvents: playEvents.length,
      pushTokens: pushTokens.length,
      entitlementsRetired: entitlements.length,
      ordersAnonymised: orders.length,
    };
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

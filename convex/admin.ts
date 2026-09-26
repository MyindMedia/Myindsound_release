import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { query, type QueryCtx } from './_generated/server';
import { productBySlug, releaseSnapshot, userByEmail } from './adminActions';
import { effectiveStatus } from './lendLogic';
import { emailHash, requireAdmin } from './lib/auth';
import { isActiveEntitlement } from './lib/editions';
import { fail } from './lib/errors';
import { wearDescriptorFor } from './wear';

const RECENT = 10;

/** Play and purchase stats. Admin only; identifies listeners by Clerk ID, never by email. */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [plays, users, entitlements, tracks, products] = await Promise.all([
      ctx.db.query('plays').collect(),
      ctx.db.query('users').collect(),
      ctx.db.query('entitlements').collect(),
      ctx.db.query('tracks').collect(),
      ctx.db.query('products').collect(),
    ]);
    const clerkIdFor = new Map(users.map((user) => [user._id, user.clerkId]));
    const titleFor = new Map(tracks.map((track) => [track._id, track.title]));
    const productFor = new Map(products.map((product) => [product._id, product.name]));

    const playsByTrack = new Map<Id<'tracks'>, number>();
    for (const play of plays) playsByTrack.set(play.trackId, (playsByTrack.get(play.trackId) ?? 0) + 1);

    return {
      // Live licences only: refunded, charged-back and deleted-account rows are kept but not counted.
      totals: { plays: plays.length, users: users.length, purchases: entitlements.filter(isActiveEntitlement).length },
      recentPlays: [...plays]
        .sort((a, b) => b.playedAt - a.playedAt)
        .slice(0, RECENT)
        .map((play) => ({
          track: titleFor.get(play.trackId) ?? 'Unknown track',
          listener: clerkIdFor.get(play.userId) ?? 'deleted user',
          playedAt: play.playedAt,
        })),
      recentPurchases: [...entitlements]
        .sort((a, b) => b.grantedAt - a.grantedAt)
        .slice(0, RECENT)
        .map((entitlement) => ({
          product: productFor.get(entitlement.productId) ?? 'Unknown product',
          // Retired licences (deleted accounts) have no user.
          buyer: (entitlement.userId && clerkIdFor.get(entitlement.userId)) ?? 'deleted user',
          grantedAt: entitlement.grantedAt,
        })),
      playsByTrack: [...playsByTrack.entries()]
        .map(([trackId, count]) => ({ track: titleFor.get(trackId) ?? 'Unknown track', count }))
        .sort((a, b) => b.count - a.count),
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// ADM-2 lookup, ADM-6 audit log, ADM-7 releases. Admin only; ids and counts, never a stored email (ADM-1).

/** Play event rows scanned per copy for the lookup's counts; a copy with more says so (`capped`). */
const EVENT_SCAN = 5000;

function lendRow(lend: Doc<'lends'>, copyActive: boolean, now: number) {
  return {
    id: lend._id,
    entitlementId: lend.entitlementId,
    lenderUserId: lend.lenderUserId,
    borrowerUserId: lend.borrowerUserId ?? null,
    channel: lend.channel,
    /** What the lend is at `now` (LEND-7), which the 15 minute job may not have written yet. */
    status: effectiveStatus(lend, now, copyActive).status,
    storedStatus: lend.status,
    playsUsed: lend.playsUsed,
    playsAllowed: lend.playsAllowed,
    offeredAt: lend.offeredAt,
    claimedAt: lend.claimedAt ?? null,
    expiresAt: lend.expiresAt ?? null,
    endedAt: lend.endedAt ?? null,
    endReason: lend.endReason ?? null,
  };
}

async function playEventSummary(ctx: QueryCtx, entitlementId: Id<'entitlements'>) {
  const rows = await ctx.db
    .query('playEvents')
    .withIndex('by_entitlement', (q) => q.eq('entitlementId', entitlementId))
    .order('desc')
    .take(EVENT_SCAN);
  const counts = { play: 0, load: 0, eject: 0 };
  for (const row of rows) counts[row.kind]++;
  const lastPlay = rows.find((row) => row.kind === 'play');
  return {
    ...counts,
    lentPlays: rows.filter((row) => row.kind === 'play' && row.lendId !== undefined).length,
    lastPlayedAt: lastPlay?.startedAtClient ?? null,
    lastEventAt: rows[0]?.receivedAt ?? null,
    capped: rows.length === EVENT_SCAN,
  };
}

async function entitlementView(ctx: QueryCtx, row: Doc<'entitlements'>, now: number) {
  const product = await ctx.db.get(row.productId);
  const active = isActiveEntitlement(row);
  const refs = await ctx.db
    .query('entitlementRefs')
    .withIndex('by_entitlement', (q) => q.eq('entitlementId', row._id))
    .collect();
  const lends = await ctx.db
    .query('lends')
    .withIndex('by_entitlement_status', (q) => q.eq('entitlementId', row._id))
    .collect();
  return {
    id: row._id,
    slug: product?.slug ?? null,
    release: product?.name ?? null,
    editionNumber: row.editionNumber ?? null,
    status: row.status ?? 'active',
    presale: row.presale ?? false,
    source: row.source ?? (row.stripeSessionId ? 'stripe' : null),
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt ?? null,
    unwrappedAt: row.unwrappedAt ?? null,
    wearStats: row.wearStats ?? null,
    wearModelVersion: row.wearModelVersion ?? null,
    hasWearSeed: row.wearSeed !== undefined,
    /** computeWear(seed, stats, version).level, 0..1; null before the ED-0 migration gave the copy a seed. */
    wearLevel: wearDescriptorFor(row)?.level ?? null,
    convertedFromLendId: row.convertedFromLendId ?? null,
    /** Payment refs: checkout session ids, StoreKit transaction ids, tag uids or audit ids. */
    paymentRefs: refs.map((ref) => ({ source: ref.source, sourceRef: ref.sourceRef, status: ref.status, at: ref.at })),
    lends: lends.sort((a, b) => b.offeredAt - a.offeredAt).map((lend) => lendRow(lend, active, now)),
    playEvents: await playEventSummary(ctx, row._id),
  };
}

async function accountView(ctx: QueryCtx, user: Doc<'users'>, now: number) {
  const entitlements = await ctx.db
    .query('entitlements')
    .withIndex('by_user_product', (q) => q.eq('userId', user._id))
    .collect();
  const borrowing = await ctx.db
    .query('lends')
    .withIndex('by_borrower_status', (q) => q.eq('borrowerUserId', user._id))
    .collect();
  const borrowed = [];
  for (const lend of borrowing) {
    const copy = await ctx.db.get(lend.entitlementId);
    const product = copy ? await ctx.db.get(copy.productId) : null;
    borrowed.push({
      ...lendRow(lend, copy !== null && isActiveEntitlement(copy), now),
      slug: product?.slug ?? null,
      editionNumber: copy?.editionNumber ?? null,
    });
  }
  const plays = await ctx.db
    .query('plays')
    .withIndex('by_user', (q) => q.eq('userId', user._id))
    .take(EVENT_SCAN);
  const orders = await ctx.db
    .query('orders')
    .withIndex('by_user', (q) => q.eq('userId', user._id))
    .collect();
  return {
    account: {
      id: user._id,
      displayName: user.name ?? null,
      createdAt: user._creationTime,
      isAdmin: user.isAdmin,
    },
    entitlements: await Promise.all(entitlements.map((row) => entitlementView(ctx, row, now))),
    borrowing: borrowed,
    websitePlays: {
      count: plays.length,
      lastPlayedAt: plays.reduce<number | null>((last, play) => Math.max(last ?? 0, play.playedAt), null),
      capped: plays.length === EVENT_SCAN,
    },
    // Payment refs only: no shipping address (ADM-1).
    orders: orders.map((order) => ({
      id: order._id,
      stripeSessionId: order.stripeSessionId,
      totalCents: order.totalCents,
      currency: order.currency,
      status: order.status,
      createdAt: order.createdAt,
    })),
  };
}

type AccountView = Awaited<ReturnType<typeof accountView>>;
type PendingGrantView = { id: Id<'pendingGrants'>; slug: string | null; status: 'pending' | 'claimed'; createdAt: number; claimedAt: number | null; auditId: Id<'auditLog'> };

/** Every lookup answer has the same shape; this is the empty one. */
const NOT_FOUND = {
  found: false,
  account: null as AccountView['account'] | null,
  entitlements: [] as AccountView['entitlements'],
  borrowing: [] as AccountView['borrowing'],
  websitePlays: { count: 0, lastPlayedAt: null, capped: false } as AccountView['websitePlays'],
  orders: [] as AccountView['orders'],
  pendingGrants: [] as PendingGrantView[],
  matchedEntitlementId: null as Id<'entitlements'> | null,
  /** PRD §16: the nfcTags table does not exist yet. */
  nfcTags: null,
};

/**
 * ADM-2: one fan, by the email the admin typed or by (release slug, edition number). Returns the account (id,
 * display name, created), its licences with edition, status, source, wear and unwrap state, lends both ways, play
 * counts and payment refs. The stored email is never returned: the admin already has the one they typed.
 */
export const lookup = query({
  args: {
    email: v.optional(v.string()),
    slug: v.optional(v.string()),
    editionNumber: v.optional(v.number()),
  },
  handler: async (ctx, { email, slug, editionNumber }) => {
    await requireAdmin(ctx);
    const now = Date.now();
    if (email !== undefined && email.trim() !== '') {
      const user = await userByEmail(ctx, email);
      const hash = await emailHash(email);
      const pending = await ctx.db
        .query('pendingGrants')
        .withIndex('by_email_status', (q) => q.eq('emailHash', hash))
        .collect();
      const pendingGrants: PendingGrantView[] = [];
      for (const row of pending) {
        const product = await ctx.db.get(row.productId);
        pendingGrants.push({
          id: row._id,
          slug: product?.slug ?? null,
          status: row.status,
          createdAt: row.createdAt,
          claimedAt: row.claimedAt ?? null,
          auditId: row.auditId,
        });
      }
      if (!user) return { ...NOT_FOUND, by: 'email' as const, pendingGrants };
      return { ...NOT_FOUND, found: true, by: 'email' as const, ...(await accountView(ctx, user, now)), pendingGrants };
    }

    if (slug === undefined || editionNumber === undefined) {
      fail('INVALID_INPUT', 'Look up by email, or by release slug and edition number.');
    }
    if (!Number.isInteger(editionNumber) || editionNumber < 1) fail('INVALID_INPUT', 'Edition numbers start at 1.');
    const product = await productBySlug(ctx, slug);
    const row = await ctx.db
      .query('entitlements')
      .withIndex('by_product_edition', (q) => q.eq('productId', product._id).eq('editionNumber', editionNumber))
      .first();
    if (!row) return { ...NOT_FOUND, by: 'edition' as const };
    const user = row.userId ? await ctx.db.get(row.userId) : null;
    if (!user) {
      // A retired edition (deleted account, NFR-2): the copy alone.
      return {
        ...NOT_FOUND,
        found: true,
        by: 'edition' as const,
        matchedEntitlementId: row._id,
        entitlements: [await entitlementView(ctx, row, now)],
      };
    }
    return {
      ...NOT_FOUND,
      found: true,
      by: 'edition' as const,
      matchedEntitlementId: row._id,
      ...(await accountView(ctx, user, now)),
    };
  },
});

/** ADM-6: the audit log, newest first, paginated. Read only: nothing exports an update or a delete. */
export const auditLog = query({
  args: { paginationOpts: paginationOptsValidator, target: v.optional(v.string()) },
  handler: async (ctx, { paginationOpts, target }) => {
    await requireAdmin(ctx);
    const base =
      target !== undefined && target.trim() !== ''
        ? ctx.db.query('auditLog').withIndex('by_target', (q) => q.eq('target', target.trim()))
        : ctx.db.query('auditLog');
    const page = await base.order('desc').paginate(paginationOpts);
    return {
      ...page,
      page: page.page.map((row) => ({
        id: row._id,
        at: row.at,
        actorUserId: row.actorUserId,
        action: row.action,
        target: row.target,
        reason: row.reason,
        before: row.before,
        after: row.after,
      })),
    };
  },
});

/** ADM-7: the digital releases and their app fields, for the release panel. */
export const releases = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const products = await ctx.db.query('products').collect();
    return products
      .filter((product) => product.kind === 'digital')
      .map((product) => ({ name: product.name, ...releaseSnapshot(product) }));
  },
});

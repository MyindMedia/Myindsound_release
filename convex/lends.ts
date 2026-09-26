import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { action, internalMutation, mutation, query, type MutationCtx, type QueryCtx } from './_generated/server';
import { publicName } from './leaderboard';
import {
  claimUrlFor,
  deadlineOf,
  isClaimToken,
  isTerminal,
  LEND_DURATION_DAYS,
  LEND_DURATION_MS,
  LEND_EXPIRY_WARNING_MS,
  LEND_PLAYS_ALLOWED,
  LEND_UNCLAIMED_EXPIRY_MS,
  LENT_PLAY_MIN_SEC,
  lendViewOf,
  MAX_ACTIVE_LENDS_PER_COPY,
  newClaimToken,
  openLendsOfCopy,
  recordLendNotice,
  settleLend,
  transitionLend,
  type LendChannel,
  type LendEndScreen,
} from './lendLogic';
import { ensureViewer, getViewer } from './lib/auth';
import { activeEntitlement, isPrelaunch } from './lib/editions';
import { fail } from './lib/errors';
import { wearDescriptorFor } from './wear';

/**
 * The lending API (PRD §12, docs/app-v1/API.md "lends"). Every rule runs in a Convex mutation, on server time,
 * against the state machine in `lendLogic.ts`. Every call evaluates the status the lend has reached by now
 * (LEND-7), so an expired lend is refused on the next call even before the 15 minute job gets to it. A call that
 * succeeds also writes that status; a refused call throws, which rolls its transaction back, so the job persists
 * it (at most 15 minutes later). Reads never depend on the written status alone.
 */

const SECOND = 1000;
/** A job run settles at most this many lends of each kind, then schedules itself again. */
const SETTLE_BATCH = 200;

const ENDED = 'This loan has ended.';
const TAKEN = 'This disc is already on loan to someone else.';
const LAPSED = 'This lend link has expired.';

async function productBySlug(ctx: QueryCtx, slug: string): Promise<Doc<'products'>> {
  const product = await ctx.db
    .query('products')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .unique();
  if (!product || product.kind !== 'digital') fail('NOT_FOUND', `No release with slug ${slug}.`);
  return product;
}

async function lendByToken(ctx: QueryCtx, token: string): Promise<Doc<'lends'>> {
  const row = isClaimToken(token)
    ? await ctx.db
        .query('lends')
        .withIndex('by_token', (q) => q.eq('claimToken', token))
        .unique()
    : null;
  if (!row) fail('NOT_FOUND', "This lend link isn't valid.");
  return row;
}

/** The caller's lend by id in one role; NOT_FOUND otherwise, so nobody learns another person's lend exists. */
async function lendFor(ctx: MutationCtx, lendIdText: string, userId: Id<'users'>, role: 'lender' | 'borrower') {
  const id = ctx.db.normalizeId('lends', lendIdText);
  const row = id ? await ctx.db.get(id) : null;
  const holder = row && (role === 'lender' ? row.lenderUserId : row.borrowerUserId);
  if (!row || holder !== userId) fail('NOT_FOUND', 'Lend not found.');
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// Create, claim, call back, cancel

/**
 * Creates an offer of the lender's copy. Shared by the link flow (`create`) and, later, NFC tap to lend (NFC-7:
 * the server creates and claims in one step with `channel: 'nfc'`, under the same rules).
 */
export async function createOffer(
  ctx: MutationCtx,
  lender: Doc<'users'>,
  product: Doc<'products'>,
  claimToken: string,
  channel: LendChannel,
  now: number,
): Promise<Doc<'lends'>> {
  const entitlement = await activeEntitlement(ctx, lender._id, product._id);
  if (!entitlement) {
    // LEND-1: only a live licence owner lends. A borrower holds no licence, so a lent copy can't be re-lent.
    const borrowing = await ctx.db
      .query('lends')
      .withIndex('by_borrower_status', (q) => q.eq('borrowerUserId', lender._id).eq('status', 'active'))
      .first();
    fail('NOT_ENTITLED', borrowing ? "Lent copies can't be lent again." : 'No license found for this release.');
  }
  if (isPrelaunch(product, now)) fail('NOT_YET_LIVE', 'This release is not out yet.');
  // Settle stale offers first so a lapsed one never blocks a new lend.
  for (const status of ['offered', 'active'] as const) {
    const rows = await ctx.db
      .query('lends')
      .withIndex('by_entitlement_status', (q) => q.eq('entitlementId', entitlement._id).eq('status', status))
      .collect();
    for (const row of rows) await settleLend(ctx, row, now);
  }
  if ((await openLendsOfCopy(ctx, entitlement._id, now)).length >= MAX_ACTIVE_LENDS_PER_COPY) {
    fail('FORBIDDEN', 'Your copy is already out on loan.');
  }
  const id = await ctx.db.insert('lends', {
    entitlementId: entitlement._id,
    lenderUserId: lender._id,
    claimToken,
    channel,
    status: 'offered',
    playsAllowed: LEND_PLAYS_ALLOWED,
    playsUsed: 0,
    offeredAt: now,
  });
  console.log(`lend ${id}: created (${channel})`);
  return (await ctx.db.get(id))!;
}

/** LEND-2, LEND-3, LEND-4. Retrying by the borrower who holds it returns the same lend. */
export async function claimOffer(ctx: MutationCtx, lend: Doc<'lends'>, borrower: Doc<'users'>, now: number) {
  if (lend.lenderUserId === borrower._id) fail('FORBIDDEN', "That's your own disc.");
  const settled = await settleLend(ctx, lend, now);
  if (settled.borrowerUserId !== undefined) {
    if (settled.borrowerUserId !== borrower._id) fail('FORBIDDEN', TAKEN);
    if (settled.status !== 'active') fail('FORBIDDEN', ENDED);
    return settled;
  }
  if (settled.status !== 'offered') fail('FORBIDDEN', LAPSED);
  const lenderCopy = (await ctx.db.get(settled.entitlementId))!;
  if (await activeEntitlement(ctx, borrower._id, lenderCopy.productId)) fail('ALREADY_OWNED', 'You already own this.');
  // One lend per borrower per release, so the rack and `lendId`-less calls are never ambiguous.
  const current = await ctx.db
    .query('lends')
    .withIndex('by_borrower_status', (q) => q.eq('borrowerUserId', borrower._id).eq('status', 'active'))
    .collect();
  for (const row of current) {
    const other = await settleLend(ctx, row, now);
    const copy = await ctx.db.get(other.entitlementId);
    if (other.status === 'active' && copy?.productId === lenderCopy.productId) {
      fail('FORBIDDEN', "You're already borrowing this release.");
    }
  }
  const claimed = await transitionLend(ctx, settled, 'active', now, undefined, {
    borrowerUserId: borrower._id,
    claimedAt: now,
    expiresAt: now + LEND_DURATION_MS,
  });
  await recordLendNotice(ctx, claimed._id, claimed.lenderUserId, 'claimed', now);
  return claimed;
}

/** Internal half of `create`: the action supplies the token from the platform CSPRNG. */
export const createForClerk = internalMutation({
  args: { clerkId: v.string(), slug: v.string(), claimToken: v.string(), channel: v.union(v.literal('link'), v.literal('nfc')) },
  handler: async (ctx, { clerkId, slug, claimToken, channel }) => {
    if (!isClaimToken(claimToken)) fail('INVALID_INPUT', 'Bad claim token.');
    const lender = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique();
    if (!lender) fail('NOT_ENTITLED', 'No license found for this release.');
    const product = await productBySlug(ctx, slug);
    const lend = await createOffer(ctx, lender, product, claimToken, channel, Date.now());
    return {
      lendId: lend._id,
      claimUrl: claimUrlFor(lend.claimToken),
      offerExpiresAt: lend.offeredAt + LEND_UNCLAIMED_EXPIRY_MS,
      playsAllowed: lend.playsAllowed,
    };
  },
});

/** LEND-1: offer the caller's copy of a release. Returns the universal link to send (LEND-12). */
export const create = action({
  args: { slug: v.string() },
  handler: async (
    ctx,
    { slug },
  ): Promise<{ lendId: Id<'lends'>; claimUrl: string; offerExpiresAt: number; playsAllowed: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) fail('UNAUTHENTICATED', 'Sign in to continue.');
    return await ctx.runMutation(internal.lends.createForClerk, {
      clerkId: identity.subject,
      slug,
      claimToken: newClaimToken(),
      channel: 'link',
    });
  },
});

export const claim = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const borrower = await ensureViewer(ctx);
    const lend = await lendByToken(ctx, token);
    const now = Date.now();
    const claimed = await claimOffer(ctx, lend, borrower, now);
    const product = await ctx.db.get((await ctx.db.get(claimed.entitlementId))!.productId);
    return {
      lendId: claimed._id,
      slug: product?.slug ?? '',
      status: claimed.status,
      playsAllowed: claimed.playsAllowed,
      playsUsed: claimed.playsUsed,
      expiresAt: claimed.expiresAt!,
    };
  },
});

/** The lender takes their disc back from the borrower (active to returned). LOCK_WHILE_LENT lifts at once. */
export const callBack = mutation({
  args: { lendId: v.string() },
  handler: async (ctx, { lendId }) => {
    const user = await ensureViewer(ctx);
    const now = Date.now();
    const lend = await settleLend(ctx, await lendFor(ctx, lendId, user._id, 'lender'), now);
    if (lend.status === 'offered') fail('INVALID_INPUT', 'This lend has not been claimed yet; cancel it instead.');
    const ended = await transitionLend(ctx, lend, 'returned', now, 'called_back');
    return { lendId: ended._id, status: ended.status };
  },
});

/** The lender withdraws an unclaimed offer (offered to returned). The link stops working. */
export const cancel = mutation({
  args: { lendId: v.string() },
  handler: async (ctx, { lendId }) => {
    const user = await ensureViewer(ctx);
    const now = Date.now();
    const lend = await settleLend(ctx, await lendFor(ctx, lendId, user._id, 'lender'), now);
    if (lend.status === 'active') fail('INVALID_INPUT', 'This lend has been claimed; call it back instead.');
    const ended = await transitionLend(ctx, lend, 'returned', now, 'cancelled');
    return { lendId: ended._id, status: ended.status };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Lent plays (LEND-5)

async function playableLend(ctx: MutationCtx, lendId: string, borrower: Doc<'users'>, trackId: string, now: number) {
  const lend = await settleLend(ctx, await lendFor(ctx, lendId, borrower._id, 'borrower'), now);
  if (lend.status !== 'active') fail('NOT_ENTITLED', ENDED);
  const copy = (await ctx.db.get(lend.entitlementId))!;
  const id = ctx.db.normalizeId('tracks', trackId);
  const track = id ? await ctx.db.get(id) : null;
  if (!track || track.productId !== copy.productId) fail('NOT_FOUND', 'Track not found.');
  const product = await ctx.db.get(copy.productId);
  if (product && isPrelaunch(product, now)) fail('NOT_YET_LIVE', 'This release is not out yet.');
  return { lend, track };
}

const playsState = (lend: Doc<'lends'>) => ({
  playsUsed: lend.playsUsed,
  playsAllowed: lend.playsAllowed,
  playsLeft: Math.max(0, lend.playsAllowed - lend.playsUsed),
  status: lend.status,
  expiresAt: deadlineOf(lend),
});

/**
 * The online check before every borrowed play: the lend is active, not expired and has plays left. Opens a play
 * session on server time; `commitLentPlay` counts it once the track has passed 30 seconds. Call
 * `media.getStreamUrl({ trackId, lendId })` after this.
 */
export const startLentPlay = mutation({
  args: { lendId: v.string(), trackId: v.string() },
  handler: async (ctx, { lendId, trackId }) => {
    const borrower = await ensureViewer(ctx);
    const now = Date.now();
    const { lend, track } = await playableLend(ctx, lendId, borrower, trackId, now);
    if (lend.playsUsed >= lend.playsAllowed) fail('NOT_ENTITLED', ENDED);
    const playId = await ctx.db.insert('lentPlays', { lendId: lend._id, trackId: track._id, startedAt: now });
    return { playId, ...playsState(lend) };
  },
});

/**
 * Counts one play, once, when the track has passed LENT_PLAY_MIN_SEC of server time since its `startLentPlay`.
 * Idempotent per `playId`: a retry returns `duplicate: true` and counts nothing. The check and the increment are
 * one transaction, so plays never exceed the allowance however many sessions were open (12.5 test 2).
 */
export const commitLentPlay = mutation({
  args: { lendId: v.string(), trackId: v.string(), playId: v.string() },
  handler: async (ctx, { lendId, trackId, playId }) => {
    const borrower = await ensureViewer(ctx);
    const now = Date.now();
    const row = await lendFor(ctx, lendId, borrower._id, 'borrower');
    const sessionId = ctx.db.normalizeId('lentPlays', playId);
    const session = sessionId ? await ctx.db.get(sessionId) : null;
    if (!session || session.lendId !== row._id || session.trackId !== trackId) fail('NOT_FOUND', 'Play not found.');
    if (session.committedAt !== undefined) {
      return { counted: false, duplicate: true, ...playsState((await ctx.db.get(row._id))!) };
    }
    const { lend } = await playableLend(ctx, lendId, borrower, trackId, now);
    if (now - session.startedAt < LENT_PLAY_MIN_SEC * SECOND) {
      fail('INVALID_INPUT', `A play counts after 30 seconds; commit it once the track passes that.`);
    }
    if (lend.playsUsed >= lend.playsAllowed) fail('NOT_ENTITLED', ENDED);
    const playsUsed = lend.playsUsed + 1;
    await ctx.db.patch(session._id, { committedAt: now });
    let updated: Doc<'lends'>;
    if (playsUsed >= lend.playsAllowed) {
      updated = await transitionLend(ctx, lend, 'exhausted', now, 'plays_used', { playsUsed });
    } else {
      await ctx.db.patch(lend._id, { playsUsed });
      updated = (await ctx.db.get(lend._id))!;
      if (playsUsed === lend.playsAllowed - 1) await recordLendNotice(ctx, lend._id, borrower._id, 'one_play_left', now);
    }
    return { counted: true, duplicate: false, ...playsState(updated) };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Reads

type LendRow = {
  lendId: Id<'lends'>;
  role: 'lender' | 'borrower';
  slug: string;
  title: string;
  status: Doc<'lends'>['status'];
  channel: LendChannel;
  playsAllowed: number;
  playsUsed: number;
  playsLeft: number;
  offeredAt: number;
  claimedAt: number | null;
  /** Active: expiry. Offered: when the link lapses. */
  expiresAt: number;
  endedAt: number | null;
  endReason: string | null;
  editionNumber: number | null;
  /** The lender's public name (the borrower's view) or the caller's own (the lender's view). */
  ownerDisplayName: string;
  /** Lender's view only, once claimed. */
  borrowerDisplayName: string | null;
  /** Lender's view, while offered: the link to share again. */
  claimUrl: string | null;
  wear: ReturnType<typeof wearDescriptorFor>;
  endScreen: LendEndScreen | null;
};

async function rowFor(ctx: QueryCtx, lend: Doc<'lends'>, role: LendRow['role'], now: number): Promise<LendRow | null> {
  const view = await lendViewOf(ctx, lend, now);
  if (!view) return null;
  const product = await ctx.db.get(view.entitlement.productId);
  const lender = await ctx.db.get(lend.lenderUserId);
  const borrower = lend.borrowerUserId ? await ctx.db.get(lend.borrowerUserId) : null;
  return {
    lendId: lend._id,
    role,
    slug: product?.slug ?? '',
    title: product?.name ?? '',
    status: view.status,
    channel: lend.channel,
    playsAllowed: lend.playsAllowed,
    playsUsed: lend.playsUsed,
    playsLeft: Math.max(0, lend.playsAllowed - lend.playsUsed),
    offeredAt: lend.offeredAt,
    claimedAt: lend.claimedAt ?? null,
    expiresAt: view.expiresAt,
    endedAt: lend.endedAt ?? (isTerminal(view.status) ? view.expiresAt : null),
    endReason: view.endReason ?? null,
    editionNumber: view.entitlement.editionNumber ?? null,
    ownerDisplayName: publicName(lender),
    borrowerDisplayName: role === 'lender' && lend.borrowerUserId ? publicName(borrower) : null,
    claimUrl: role === 'lender' && view.status === 'offered' ? claimUrlFor(lend.claimToken) : null,
    wear: wearDescriptorFor(view.entitlement),
    endScreen: role === 'borrower' ? view.endScreen : null,
  };
}

const newestFirst = (a: LendRow, b: LendRow) => b.offeredAt - a.offeredAt;

/** The caller's lends in both roles, newest first, with status, plays and expiry at server time now. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const viewer = await getViewer(ctx);
    if (!viewer) return { serverNow: now, asLender: [], asBorrower: [] };
    const asLender: LendRow[] = [];
    for (const lend of await ctx.db
      .query('lends')
      .withIndex('by_lender', (q) => q.eq('lenderUserId', viewer._id))
      .collect()) {
      const row = await rowFor(ctx, lend, 'lender', now);
      if (row) asLender.push(row);
    }
    const asBorrower: LendRow[] = [];
    for (const lend of await ctx.db
      .query('lends')
      .withIndex('by_borrower_status', (q) => q.eq('borrowerUserId', viewer._id))
      .collect()) {
      const row = await rowFor(ctx, lend, 'borrower', now);
      if (row) asBorrower.push(row);
    }
    return { serverNow: now, asLender: asLender.sort(newestFirst), asBorrower: asBorrower.sort(newestFirst) };
  },
});

/**
 * LEND-12: the landing page and the app's claim sheet for a lend link. Public. The disc (edition, the lender's
 * public name, wear) and whether it can still be claimed; no ids, emails or account data.
 */
export const preview = query({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const now = Date.now();
    const lend = await lendByToken(ctx, token);
    const view = await lendViewOf(ctx, lend, now);
    if (!view) fail('NOT_FOUND', "This lend link isn't valid.");
    const product = await ctx.db.get(view.entitlement.productId);
    const lender = await ctx.db.get(lend.lenderUserId);
    const availability: 'available' | 'on_loan' | 'ended' =
      view.status === 'offered' ? 'available' : view.status === 'active' ? 'on_loan' : 'ended';
    return {
      availability,
      slug: product?.slug ?? '',
      releaseTitle: product?.name ?? '',
      editionNumber: view.entitlement.editionNumber ?? null,
      ownerDisplayName: publicName(lender),
      // The descriptor without its seed: a public page needs the marks, not the copy's permanent identifier.
      wear: publicWear(view.entitlement),
      playsAllowed: lend.playsAllowed,
      lendDays: LEND_DURATION_DAYS,
      offerExpiresAt: availability === 'available' ? view.expiresAt : null,
    };
  },
});

function publicWear(entitlement: Doc<'entitlements'>) {
  const wear = wearDescriptorFor(entitlement);
  if (!wear) return null;
  const { seed: _seed, ...marks } = wear;
  return marks;
}

// ---------------------------------------------------------------------------------------------------------------
// LEND-7 job (crons.ts, every 15 minutes)

/**
 * Moves lends past their deadline to their terminal state (unclaimed after 72 hours; expired at `expiresAt`),
 * which also restores the lender's access, and records the borrower's 24 hour reminder (LEND-11) once.
 */
export const settleDue = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const stale = await ctx.db
      .query('lends')
      .withIndex('by_status_offered', (q) => q.eq('status', 'offered').lte('offeredAt', now - LEND_UNCLAIMED_EXPIRY_MS))
      .take(SETTLE_BATCH);
    for (const lend of stale) await settleLend(ctx, lend, now);
    const expired = await ctx.db
      .query('lends')
      .withIndex('by_status_expires', (q) => q.eq('status', 'active').lte('expiresAt', now))
      .take(SETTLE_BATCH);
    for (const lend of expired) await settleLend(ctx, lend, now);
    const soon = await ctx.db
      .query('lends')
      .withIndex('by_status_expires', (q) =>
        q.eq('status', 'active').gt('expiresAt', now).lte('expiresAt', now + LEND_EXPIRY_WARNING_MS),
      )
      .take(SETTLE_BATCH);
    let reminders = 0;
    for (const lend of soon) {
      if (lend.borrowerUserId && (await recordLendNotice(ctx, lend._id, lend.borrowerUserId, 'expiring_soon', now))) {
        reminders++;
      }
    }
    if (stale.length === SETTLE_BATCH || expired.length === SETTLE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.lends.settleDue, {});
    }
    return { unclaimedExpired: stale.length, expired: expired.length, reminders };
  },
});

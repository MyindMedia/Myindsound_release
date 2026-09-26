import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { publicName } from './leaderboard';
import { isActiveEntitlement } from './lib/editions';
import { fail } from './lib/errors';

/**
 * Lending (PRD §12, HIGH RISK). The state machine, its config and the database helpers that `lends.ts`,
 * `wear.ts` (the lend hooks) and `fulfilment.ts` (LEND-9, LEND-10) share. It imports nothing from those
 * modules, so there is no import cycle.
 *
 * Time is always server time (`Date.now()` in the function). The app never sends a time to a lend rule, so a
 * device clock cannot move an expiry (12.5 test 6).
 */

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;
const DAY = 24 * HOUR;

// ---------------------------------------------------------------------------------------------------------------
// Config (PRD §12.2) [DECIDE]

/** Plays per lend, per track: one play is one track played past LENT_PLAY_MIN_SEC. Copied into the lend. */
export const LEND_PLAYS_ALLOWED = 10;
export const LEND_DURATION_DAYS = 7;
export const LEND_DURATION_MS = LEND_DURATION_DAYS * DAY;
export const LEND_UNCLAIMED_EXPIRY_HOURS = 72;
export const LEND_UNCLAIMED_EXPIRY_MS = LEND_UNCLAIMED_EXPIRY_HOURS * HOUR;
/** One physical copy can only be in one place at a time. */
export const MAX_ACTIVE_LENDS_PER_COPY = 1;
/** The lender cannot play their copy while it is out (offered or active). */
export const LOCK_WHILE_LENT = true;
/** LEND-5: a lent play counts once the track has passed this many seconds (server time since `startLentPlay`). */
export const LENT_PLAY_MIN_SEC = 30;
/** LEND-11: the borrower's reminder goes out this long before expiry. */
export const LEND_EXPIRY_WARNING_MS = 24 * HOUR;
/** [DECIDE] An ended lend stays on the borrower's rack (with its end screen, LEND-8) this long, then drops off. */
export const LEND_ENDED_VISIBLE_MS = 7 * DAY;
/** LEND-12 universal link. */
export const LEND_URL_BASE = 'https://myindsound.com/lend/';
/** The final lent track may finish streaming after the lend is exhausted: its length times this (WEAR-7). */
const FINAL_PLAY_GRACE_FACTOR = 1.05;

// ---------------------------------------------------------------------------------------------------------------
// State machine (PRD §12.3)

export type LendStatus = Doc<'lends'>['status'];
export type LendChannel = Doc<'lends'>['channel'];

export const LEND_STATUSES: readonly LendStatus[] = [
  'offered',
  'active',
  'exhausted',
  'expired',
  'returned',
  'revoked',
  'converted',
  'unclaimed_expired',
];

const TRANSITIONS: Record<LendStatus, readonly LendStatus[]> = {
  // LEND-10 revokes "all its lends", so an open offer can be revoked too.
  offered: ['active', 'unclaimed_expired', 'returned', 'revoked'],
  active: ['exhausted', 'expired', 'returned', 'revoked', 'converted'],
  exhausted: [],
  expired: [],
  returned: [],
  revoked: [],
  converted: [],
  unclaimed_expired: [],
};

export function isTerminal(status: LendStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

export function canTransition(from: LendStatus, to: LendStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Why a lend ended (`lends.endReason`). Display only. */
export type EndReason =
  | 'plays_used'
  | 'time_up'
  | 'called_back'
  | 'cancelled'
  | 'lender_revoked'
  | 'bought_own_copy'
  | 'unclaimed'
  | 'borrower_deleted';

/** Ends the lender asked for themselves: no "your lend ended" push to them. */
const LENDER_INITIATED: readonly EndReason[] = ['called_back', 'cancelled'];

type LendTimes = Pick<Doc<'lends'>, 'status' | 'offeredAt' | 'expiresAt' | 'playsUsed' | 'playsAllowed'>;

/**
 * The status a lend has at `now`, whether or not a mutation has written it yet (LEND-7: expiry is enforced on
 * every call, and the 15 minute job only persists it). Terminal states never change.
 */
export function effectiveStatus(
  lend: LendTimes,
  now: number,
  lenderCopyActive: boolean,
): { status: LendStatus; endReason?: EndReason } {
  if (isTerminal(lend.status)) return { status: lend.status };
  if (!lenderCopyActive) return { status: 'revoked', endReason: 'lender_revoked' };
  if (lend.status === 'offered') {
    return now >= lend.offeredAt + LEND_UNCLAIMED_EXPIRY_MS
      ? { status: 'unclaimed_expired', endReason: 'unclaimed' }
      : { status: 'offered' };
  }
  if (lend.expiresAt !== undefined && now >= lend.expiresAt) return { status: 'expired', endReason: 'time_up' };
  if (lend.playsUsed >= lend.playsAllowed) return { status: 'exhausted', endReason: 'plays_used' };
  return { status: 'active' };
}

/** When the lend stops (or stopped) being usable: the claim deadline while offered, else `expiresAt`. */
export function deadlineOf(lend: Pick<Doc<'lends'>, 'status' | 'offeredAt' | 'expiresAt'>): number {
  return lend.expiresAt ?? lend.offeredAt + LEND_UNCLAIMED_EXPIRY_MS;
}

// ---------------------------------------------------------------------------------------------------------------
// Claim tokens (LEND-4, LEND-12)

const TOKEN_BYTES = 16; // 128 bits
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/**
 * 128 random bits, base64url (22 characters). Generated in an action (`lends.create`), where `crypto` is the
 * platform's CSPRNG; mutations get a seeded generator, which is fine for wear seeds but not for a bearer secret.
 */
export function newClaimToken(): string {
  const bytes = new Uint8Array(TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isClaimToken(token: string): boolean {
  return TOKEN_PATTERN.test(token);
}

export function claimUrlFor(token: string): string {
  return `${LEND_URL_BASE}${token}`;
}

// ---------------------------------------------------------------------------------------------------------------
// Views

/** LEND-8: what the borrower's native end screen shows, with the "Get your own copy" StoreKit products. */
export type LendEndScreen = {
  reason: 'exhausted' | 'expired';
  headline: string;
  slug: string;
  releaseTitle: string;
  editionNumber: number | null;
  ownerDisplayName: string;
  /** Any of these (PAY-11 price tiers) buys the release in app. Empty until the products are set up. */
  appStoreProductIds: string[];
};

/** A lend as the hooks and the API see it, at `now`. */
export type LendView = {
  lendId: Id<'lends'>;
  /** The lender's copy: wear and edition come from it. */
  entitlement: Doc<'entitlements'>;
  lenderUserId: Id<'users'>;
  borrowerUserId: Id<'users'> | null;
  playsAllowed: number;
  playsUsed: number;
  /** Active: when it expires. Offered: when the link lapses. Ended: the deadline it had. */
  expiresAt: number;
  status: LendStatus;
  endReason?: string;
  /**
   * May the borrower stream and report plays on it right now: active, or exhausted while its final track is
   * still inside that track's length (so play 10 is not cut off mid song).
   */
  usable: boolean;
  endScreen: LendEndScreen | null;
};

async function lenderCopy(ctx: QueryCtx, lend: Doc<'lends'>) {
  const entitlement = await ctx.db.get(lend.entitlementId);
  return { entitlement, active: entitlement !== null && isActiveEntitlement(entitlement) };
}

/** Until when an exhausted lend may keep streaming its final track (0 when there is nothing to finish). */
async function finalPlayGraceUntil(ctx: QueryCtx, lendId: Id<'lends'>): Promise<number> {
  const sessions = await ctx.db
    .query('lentPlays')
    .withIndex('by_lend_track', (q) => q.eq('lendId', lendId))
    .collect();
  let until = 0;
  for (const session of sessions) {
    if (session.committedAt === undefined) continue;
    const track = await ctx.db.get(session.trackId);
    if (!track) continue;
    until = Math.max(until, session.startedAt + track.durationSeconds * FINAL_PLAY_GRACE_FACTOR * SECOND);
  }
  return until;
}

export async function endScreenFor(
  ctx: QueryCtx,
  lend: Pick<Doc<'lends'>, 'lenderUserId'>,
  entitlement: Doc<'entitlements'>,
  reason: 'exhausted' | 'expired',
): Promise<LendEndScreen> {
  const product = await ctx.db.get(entitlement.productId);
  const lender = await ctx.db.get(lend.lenderUserId);
  return {
    reason,
    headline: reason === 'exhausted' ? 'That was the last play on this loan.' : 'This loan has ended.',
    slug: product?.slug ?? '',
    releaseTitle: product?.name ?? '',
    editionNumber: entitlement.editionNumber ?? null,
    ownerDisplayName: publicName(lender),
    appStoreProductIds: product?.appStoreProductIds ?? [],
  };
}

/** The view of a lend at `now`, or null when the lender's copy no longer exists. */
export async function lendViewOf(ctx: QueryCtx, lend: Doc<'lends'>, now: number): Promise<LendView | null> {
  const copy = await lenderCopy(ctx, lend);
  if (!copy.entitlement) return null;
  const effective = effectiveStatus(lend, now, copy.active);
  const status = effective.status;
  let usable = status === 'active';
  if (status === 'exhausted') usable = now < (await finalPlayGraceUntil(ctx, lend._id));
  const endScreen =
    lend.borrowerUserId !== undefined && (status === 'exhausted' || status === 'expired')
      ? await endScreenFor(ctx, lend, copy.entitlement, status)
      : null;
  return {
    lendId: lend._id,
    entitlement: copy.entitlement,
    lenderUserId: lend.lenderUserId,
    borrowerUserId: lend.borrowerUserId ?? null,
    playsAllowed: lend.playsAllowed,
    playsUsed: lend.playsUsed,
    expiresAt: deadlineOf(lend),
    status,
    endReason: effective.endReason ?? lend.endReason,
    usable,
    endScreen,
  };
}

/** When a lend ended, or (for one that ended by time but is not written yet) its deadline. */
function endedAtOf(lend: Doc<'lends'>, view: LendView): number {
  return lend.endedAt ?? view.expiresAt;
}

/**
 * The borrower's lend of one release: the one in play, else the most recently ended one for LEND_ENDED_VISIBLE_MS
 * (it keeps `ownership: 'lent'` with its terminal status and end screen). A converted lend never shows: the
 * borrower owns the release then.
 */
export async function borrowerLendFor(
  ctx: QueryCtx,
  borrowerId: Id<'users'>,
  productId: Id<'products'>,
  now: number,
): Promise<LendView | null> {
  const rows = await ctx.db
    .query('lends')
    .withIndex('by_borrower_status', (q) => q.eq('borrowerUserId', borrowerId))
    .collect();
  let ended: { view: LendView; endedAt: number } | null = null;
  for (const row of rows) {
    const view = await lendViewOf(ctx, row, now);
    if (!view || view.entitlement.productId !== productId) continue;
    if (view.status === 'active' || view.usable) return view;
    if (view.status === 'converted') continue;
    const endedAt = endedAtOf(row, view);
    if (now - endedAt > LEND_ENDED_VISIBLE_MS) continue;
    if (!ended || endedAt > ended.endedAt) ended = { view, endedAt };
  }
  return ended?.view ?? null;
}

/** The lend a copy is out on (offered or active at `now`): LOCK_WHILE_LENT and MAX_ACTIVE_LENDS_PER_COPY. */
export async function openLendsOfCopy(ctx: QueryCtx, entitlementId: Id<'entitlements'>, now: number): Promise<LendView[]> {
  const open: LendView[] = [];
  for (const status of ['offered', 'active'] as const) {
    const rows = await ctx.db
      .query('lends')
      .withIndex('by_entitlement_status', (q) => q.eq('entitlementId', entitlementId).eq('status', status))
      .collect();
    for (const row of rows) {
      const view = await lendViewOf(ctx, row, now);
      if (view && (view.status === 'offered' || view.status === 'active')) open.push(view);
    }
  }
  return open;
}

// ---------------------------------------------------------------------------------------------------------------
// Transitions (mutations only)

export type NoticeKind = Doc<'lendNotices'>['kind'];

/**
 * LEND-11: records a push intent, at most one per lend and kind. Sending is a stub (APNs is not configured):
 * the future sender delivers rows without `sentAt`, honouring `pushTokens.wantsLendAlerts`.
 */
export async function recordLendNotice(
  ctx: MutationCtx,
  lendId: Id<'lends'>,
  userId: Id<'users'>,
  kind: NoticeKind,
  now: number,
): Promise<boolean> {
  const existing = await ctx.db
    .query('lendNotices')
    .withIndex('by_lend_kind', (q) => q.eq('lendId', lendId).eq('kind', kind))
    .first();
  if (existing) return false;
  await ctx.db.insert('lendNotices', { lendId, userId, kind, createdAt: now });
  return true;
}

/**
 * The one writer of `lends.status`. Refuses anything the state machine does not allow, so nothing ever leaves a
 * terminal state. Logs the transition with ids only (NFR-5).
 */
export async function transitionLend(
  ctx: MutationCtx,
  lend: Doc<'lends'>,
  to: LendStatus,
  now: number,
  endReason?: EndReason,
  extra: Partial<Pick<Doc<'lends'>, 'borrowerUserId' | 'claimedAt' | 'expiresAt' | 'playsUsed'>> = {},
): Promise<Doc<'lends'>> {
  if (!canTransition(lend.status, to)) {
    fail(isTerminal(lend.status) ? 'FORBIDDEN' : 'INVALID_INPUT', isTerminal(lend.status) ? 'This lend has already ended.' : 'That change is not allowed for this lend.');
  }
  const ending = isTerminal(to);
  await ctx.db.patch(lend._id, {
    status: to,
    ...extra,
    ...(ending ? { endedAt: now, endReason } : {}),
  });
  console.log(`lend ${lend._id}: ${lend.status} -> ${to}${endReason ? ` (${endReason})` : ''}`);
  if (ending && (endReason === undefined || !LENDER_INITIATED.includes(endReason))) {
    await recordLendNotice(ctx, lend._id, lend.lenderUserId, 'ended', now);
  }
  return (await ctx.db.get(lend._id))!;
}

/** Writes the status a lend has at `now` (LEND-7), and returns the fresh row. */
export async function settleLend(ctx: MutationCtx, lend: Doc<'lends'>, now: number): Promise<Doc<'lends'>> {
  if (isTerminal(lend.status)) return lend;
  const { active } = await lenderCopy(ctx, lend);
  const effective = effectiveStatus(lend, now, active);
  if (effective.status === lend.status) return lend;
  return await transitionLend(ctx, lend, effective.status, now, effective.endReason);
}

/** LEND-10: the lender's copy was revoked (refund, chargeback, App Store refund): all its open lends end now. */
export async function revokeLendsOfCopy(ctx: MutationCtx, entitlementId: Id<'entitlements'>, now: number): Promise<number> {
  let revoked = 0;
  for (const status of ['offered', 'active'] as const) {
    const rows = await ctx.db
      .query('lends')
      .withIndex('by_entitlement_status', (q) => q.eq('entitlementId', entitlementId).eq('status', status))
      .collect();
    for (const row of rows) {
      await transitionLend(ctx, row, 'revoked', now, 'lender_revoked');
      revoked++;
    }
  }
  return revoked;
}

/**
 * LEND-9: the borrower was just granted the release (any source). Their active lend of it ends as `converted`
 * and its id goes on the new licence. With no active lend, a lend of it that ended (exhausted or expired) in the
 * last LEND_ENDED_VISIBLE_MS is still attributed, without changing its terminal status: that is the end screen's
 * "Get your own copy" purchase.
 */
export async function convertBorrowerLend(
  ctx: MutationCtx,
  borrowerId: Id<'users'>,
  productId: Id<'products'>,
  now: number,
): Promise<Id<'lends'> | null> {
  const rows = await ctx.db
    .query('lends')
    .withIndex('by_borrower_status', (q) => q.eq('borrowerUserId', borrowerId))
    .collect();
  let attributed: { id: Id<'lends'>; endedAt: number } | null = null;
  for (const row of rows) {
    const entitlement = await ctx.db.get(row.entitlementId);
    if (!entitlement || entitlement.productId !== productId) continue;
    const settled = await settleLend(ctx, row, now);
    if (settled.status === 'active') {
      await transitionLend(ctx, settled, 'converted', now, 'bought_own_copy');
      return settled._id;
    }
    const endedAt = settled.endedAt ?? 0;
    if ((settled.status === 'exhausted' || settled.status === 'expired') && now - endedAt <= LEND_ENDED_VISIBLE_MS) {
      if (!attributed || endedAt > attributed.endedAt) attributed = { id: settled._id, endedAt };
    }
  }
  return attributed?.id ?? null;
}

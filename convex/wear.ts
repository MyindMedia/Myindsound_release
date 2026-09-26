import type { Doc, Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './_generated/server';
import { borrowerLendFor, lendViewOf, LOCK_WHILE_LENT, openLendsOfCopy, type LendView } from './lendLogic';
import { activeEntitlement, WEAR_MODEL_VERSION, zeroWearStats } from './lib/editions';
// Relative import: `@myind/wear` is not an npm workspace, so neither the Convex bundler nor vite can resolve the
// package name. The package has no runtime dependencies, so esbuild bundles its source straight in.
import { computeWear, type WearDescriptor } from '../packages/wear/src/index';

/**
 * A copy and its wear (PRD §11, §3A). Three things live here because app, plays and media all need them and must
 * agree: which copy an actor is holding (their own licence, or a lend of someone else's), the wear descriptor for
 * a copy, and play event ingestion (WEAR-6..8).
 *
 * Wear reads only the cumulative `entitlements.wearStats`. Ingestion only ever adds to it, so pruning `plays`,
 * `playEvents` or `wearDays` can never lower wear (WEAR-5, NFR-2).
 */

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** WEAR-7: an event counts at most this multiple of its track's duration. */
export const PLAY_CLAMP_FACTOR = 1.05;
/** WEAR-7: events that started longer ago than this are rejected. */
export const MAX_EVENT_AGE_MS = 60 * DAY;
/**
 * [DECIDE] How far ahead of server time a device clock may run before its events count as "in the future"
 * (WEAR-7). A play also can't claim more seconds than have elapsed since it started, within this tolerance.
 */
export const CLOCK_SKEW_MS = 15 * MINUTE;
/** WEAR-8: counted play per copy per 24 hours (a UTC day of `startedAtClient`). Owner and lent plays share it. */
export const DAILY_PLAY_CAP_SEC = 8 * 60 * 60;
/** Cartridge loads and ejects: at most one of each kind per this interval per copy. */
export const HANDLING_MIN_INTERVAL_MS = 2000;
/** [DECIDE] Counted loads plus ejects per copy per UTC day (anti farming; 100 handling events = 50 plays). */
export const DAILY_HANDLING_CAP = 100;
/** One call's batch. An offline queue larger than this flushes in several calls. */
export const MAX_EVENTS_PER_BATCH = 500;

export type PlayEventKind = 'play' | 'load' | 'eject';

// ---------------------------------------------------------------------------------------------------------------
// Copies and lends

/**
 * The lend hooks (PRD §12). `app.*`, `media.*` and `plays.recordPlayEvents` call these three; the state machine
 * and its rules live in `lendLogic.ts`. Every lookup evaluates the lend at server time now (LEND-7), so a lend
 * past its deadline stops working on the next call even before the 15 minute job writes its terminal status.
 */
export type { LendView } from './lendLogic';

/**
 * The caller's lend of a release, if they hold one (the borrower's view): the one in play, else one that ended
 * in the last LEND_ENDED_VISIBLE_MS, so the rack keeps the disc with its end screen (LEND-8).
 */
export async function lendForBorrower(
  ctx: QueryCtx,
  borrowerId: Id<'users'>,
  productId: Id<'products'>,
): Promise<LendView | null> {
  return await borrowerLendFor(ctx, borrowerId, productId, Date.now());
}

/** A lend by id, only when `borrowerId` is its borrower (any status; `usable` says whether it plays now). */
export async function lendById(ctx: QueryCtx, lendId: string, borrowerId: Id<'users'>): Promise<LendView | null> {
  const id = ctx.db.normalizeId('lends', lendId);
  const row = id ? await ctx.db.get(id) : null;
  if (!row || row.borrowerUserId !== borrowerId) return null;
  return await lendViewOf(ctx, row, Date.now());
}

/** The lend an owner's copy is out on (offered or active), for LOCK_WHILE_LENT. */
export async function lendOutFor(ctx: QueryCtx, entitlementId: Id<'entitlements'>): Promise<LendView | null> {
  if (!LOCK_WHILE_LENT) return null;
  const [open] = await openLendsOfCopy(ctx, entitlementId, Date.now());
  return open ?? null;
}

/** The copy an actor plays: their own live licence, or the lender's copy through an active lend they hold. */
export type HeldCopy = { entitlement: Doc<'entitlements'>; lend: LendView | null };

export async function heldCopy(
  ctx: QueryCtx,
  actorId: Id<'users'>,
  productId: Id<'products'>,
  lendId: string | undefined,
): Promise<HeldCopy | null> {
  if (lendId !== undefined) {
    const lend = await lendById(ctx, lendId, actorId);
    if (!lend || !lend.usable || lend.entitlement.productId !== productId) return null;
    return { entitlement: lend.entitlement, lend };
  }
  const entitlement = await activeEntitlement(ctx, actorId, productId);
  return entitlement ? { entitlement, lend: null } : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Descriptor

export type WearInputs = {
  seed: string;
  stats: NonNullable<Doc<'entitlements'>['wearStats']>;
  version: number;
};

/** The server's wear inputs for a copy, or null for a licence from before the ED-0 migration (no seed yet). */
export function wearInputsFor(row: Doc<'entitlements'>): WearInputs | null {
  if (!row.wearSeed) return null;
  return {
    seed: row.wearSeed,
    stats: row.wearStats ?? zeroWearStats(),
    version: row.wearModelVersion ?? WEAR_MODEL_VERSION,
  };
}

/**
 * `computeWear(seed, stats, version)` with no safe zones: bundles that declare `wearSafeZones` recompute from
 * `wearInputsFor` with their manifest (the stream layout is identical, only zone-hitting slots differ).
 */
export function wearDescriptorFor(row: Doc<'entitlements'>): WearDescriptor | null {
  const inputs = wearInputsFor(row);
  if (!inputs) return null;
  try {
    return computeWear(inputs.seed, inputs.stats, inputs.version);
  } catch (error) {
    // Only a server bug gets here (a malformed stored seed or stat). IDs only, never PII.
    console.error(`wear descriptor failed for entitlement ${row._id}: ${(error as Error).message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Ingestion (WEAR-6..8), pure parts

/** The UTC day a client timestamp falls in: the WEAR-8 "24 hours" bucket. */
export function dayBucket(startedAtClient: number): number {
  return Math.floor(startedAtClient / DAY);
}

export type TimeCheck = 'ok' | 'future' | 'too_old' | 'invalid';

/** WEAR-7: events in the future (beyond the clock tolerance) or older than 60 days are rejected. */
export function checkEventTime(startedAtClient: number, now: number): TimeCheck {
  if (!Number.isFinite(startedAtClient)) return 'invalid';
  if (startedAtClient > now + CLOCK_SKEW_MS) return 'future';
  if (startedAtClient < now - MAX_EVENT_AGE_MS) return 'too_old';
  return 'ok';
}

/**
 * WEAR-7 clamp: at most `durationSec × 1.05`, and no more seconds than have elapsed since the play started (within
 * the clock tolerance). Returns null for a value that is not a finite, non negative number.
 */
export function clampPlayedSec(playedSec: number, durationSec: number, startedAtClient: number, now: number): number | null {
  if (!Number.isFinite(playedSec) || playedSec < 0) return null;
  const elapsedSec = Math.max(0, (now + CLOCK_SKEW_MS - startedAtClient) / 1000);
  return Math.min(playedSec, durationSec * PLAY_CLAMP_FACTOR, elapsedSec);
}

/** WEAR-8: how much of `seconds` still fits under the day's cap, given what the day already counted. */
export function countableSec(seconds: number, alreadyCountedSec: number): number {
  return Math.max(0, Math.min(seconds, DAILY_PLAY_CAP_SEC - alreadyCountedSec));
}

// ---------------------------------------------------------------------------------------------------------------
// Ingestion, database parts

export type PlayEventInput = {
  idempotencyKey: string;
  kind?: PlayEventKind;
  /** Required for `play`. A load or eject names its track or its release (`slug`). */
  trackId?: string;
  slug?: string;
  startedAtClient: number;
  /** Seconds heard. Ignored for loads and ejects. */
  playedSec?: number;
  /** Set when the actor plays a borrowed copy. */
  lendId?: string;
};

export type RejectReason =
  | 'invalid' // malformed key, time or seconds, or a play with no track
  | 'future' // startedAtClient ahead of the server beyond CLOCK_SKEW_MS
  | 'too_old' // older than 60 days
  | 'unknown_track' // no such track or release
  | 'no_access'; // the actor holds no live copy (or active lend) of the release

export type PlayEventResult = {
  idempotencyKey: string;
  /** recorded: stored now. duplicate: already stored (this call or before); a no-op. rejected: never stored. */
  status: 'recorded' | 'duplicate' | 'rejected';
  reason: RejectReason | null;
  /** Seconds added to wear (after the clamp and the daily cap). 0 for loads, ejects, duplicates, rejections. */
  countedSec: number;
  /** Whether it added wear: a play with countedSec > 0, or a load/eject within the rate limit and daily cap. */
  counted: boolean;
  /** Why a recorded event added less than it claimed, if it did. */
  limitedBy: 'clamp' | 'daily_cap' | 'rate_limited' | null;
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9:_-]{8,128}$/;

async function dayRow(ctx: MutationCtx, entitlementId: Id<'entitlements'>, day: number) {
  const row = await ctx.db
    .query('wearDays')
    .withIndex('by_entitlement_day', (q) => q.eq('entitlementId', entitlementId).eq('day', day))
    .unique();
  if (row) return row;
  const id = await ctx.db.insert('wearDays', { entitlementId, day, playSec: 0, handling: 0 });
  return (await ctx.db.get(id))!;
}

async function resolveProduct(
  ctx: MutationCtx,
  event: PlayEventInput,
): Promise<{ productId: Id<'products'>; track: Doc<'tracks'> | null } | null> {
  if (event.trackId !== undefined) {
    const trackId = ctx.db.normalizeId('tracks', event.trackId);
    const track = trackId ? await ctx.db.get(trackId) : null;
    return track ? { productId: track.productId, track } : null;
  }
  if (event.slug !== undefined) {
    const product = await ctx.db
      .query('products')
      .withIndex('by_slug', (q) => q.eq('slug', event.slug!))
      .unique();
    return product ? { productId: product._id, track: null } : null;
  }
  return null;
}

/**
 * The copy an event wears. Owners: their live licence, except while it is out on a lend (LOCK_WHILE_LENT: plays
 * and handling reported while it is out are refused, like plays queued before a refund). Borrowers: the lender's
 * copy while the lend is usable. A play reported after the lend ended still counts (LEND-6) when it matches a
 * committed `lentPlays` session for that track that no event has claimed yet, so each authorised play reaches
 * the lender's wear once and nothing after the end can add more.
 */
async function copyForEvent(
  ctx: MutationCtx,
  actorId: Id<'users'>,
  productId: Id<'products'>,
  event: PlayEventInput,
  kind: PlayEventKind,
  track: Doc<'tracks'> | null,
): Promise<(HeldCopy & { claim?: Id<'lentPlays'> }) | null> {
  if (event.lendId === undefined) {
    const entitlement = await activeEntitlement(ctx, actorId, productId);
    if (!entitlement) return null;
    if (await lendOutFor(ctx, entitlement._id)) return null;
    return { entitlement, lend: null };
  }
  const lend = await lendById(ctx, event.lendId, actorId);
  if (!lend || lend.entitlement.productId !== productId) return null;
  const sessions =
    kind === 'play' && track
      ? (
          await ctx.db
            .query('lentPlays')
            .withIndex('by_lend_track', (q) => q.eq('lendId', lend.lendId).eq('trackId', track._id))
            .collect()
        ).filter((session) => session.eventKey === undefined)
      : [];
  const committed = sessions.filter((session) => session.committedAt !== undefined);
  // Revoked is left out: the lender's copy was refunded and nothing more reaches it.
  const ended = ['exhausted', 'expired', 'returned', 'converted'].includes(lend.status);
  let session: Doc<'lentPlays'> | undefined;
  if (lend.usable) session = committed[0] ?? sessions[0];
  else if (ended) session = committed[0];
  if (!lend.usable && !session) return null;
  // The caller marks the session claimed once the event is accepted.
  return { entitlement: lend.entitlement, lend, ...(session ? { claim: session._id } : {}) };
}

async function ingestOne(
  ctx: MutationCtx,
  actor: Doc<'users'>,
  event: PlayEventInput,
  now: number,
  seenInBatch: Set<string>,
): Promise<PlayEventResult> {
  const key = event.idempotencyKey;
  const result = (
    status: PlayEventResult['status'],
    reason: RejectReason | null = null,
    extra: Partial<PlayEventResult> = {},
  ): PlayEventResult => ({ idempotencyKey: key, status, reason, countedSec: 0, counted: false, limitedBy: null, ...extra });

  if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) return result('rejected', 'invalid');
  // WEAR-6: a key seen earlier in this batch, or stored by any earlier call, is ignored.
  if (seenInBatch.has(key)) return result('duplicate');
  seenInBatch.add(key);
  const existing = await ctx.db
    .query('playEvents')
    .withIndex('by_idem', (q) => q.eq('idempotencyKey', key))
    .first();
  if (existing) return result('duplicate');

  const kind: PlayEventKind = event.kind ?? 'play';
  if (kind === 'play' && event.trackId === undefined) return result('rejected', 'invalid');
  const time = checkEventTime(event.startedAtClient, now);
  if (time !== 'ok') return result('rejected', time);

  const target = await resolveProduct(ctx, event);
  if (!target) return result('rejected', 'unknown_track');
  const copy = await copyForEvent(ctx, actor._id, target.productId, event, kind, target.track);
  if (!copy) return result('rejected', 'no_access');
  const entitlement = copy.entitlement;

  const clamped =
    kind === 'play'
      ? clampPlayedSec(event.playedSec ?? 0, target.track!.durationSeconds, event.startedAtClient, now)
      : 0;
  if (clamped === null) return result('rejected', 'invalid');
  if (copy.claim) await ctx.db.patch(copy.claim, { eventKey: key });

  let playedSec = 0;
  let countedSec = 0;
  let counted = false;
  let limitedBy: PlayEventResult['limitedBy'] = null;
  const day = await dayRow(ctx, entitlement._id, dayBucket(event.startedAtClient));

  if (kind === 'play') {
    playedSec = clamped;
    countedSec = countableSec(clamped, day.playSec);
    counted = countedSec > 0;
    if (countedSec < clamped) limitedBy = 'daily_cap';
    else if (clamped < (event.playedSec ?? 0)) limitedBy = 'clamp';
    if (countedSec > 0) await ctx.db.patch(day._id, { playSec: day.playSec + countedSec });
  } else {
    const last = kind === 'load' ? day.lastLoadAt : day.lastEjectAt;
    if (day.handling >= DAILY_HANDLING_CAP) limitedBy = 'daily_cap';
    else if (last !== undefined && Math.abs(event.startedAtClient - last) < HANDLING_MIN_INTERVAL_MS) {
      limitedBy = 'rate_limited';
    } else {
      counted = true;
      await ctx.db.patch(day._id, {
        handling: day.handling + 1,
        ...(kind === 'load' ? { lastLoadAt: event.startedAtClient } : { lastEjectAt: event.startedAtClient }),
      });
    }
  }

  // Excess is recorded but adds no wear (WEAR-8).
  await ctx.db.insert('playEvents', {
    idempotencyKey: key,
    entitlementId: entitlement._id,
    actorUserId: actor._id,
    ...(copy.lend ? { lendId: copy.lend.lendId } : {}),
    ...(target.track ? { trackId: target.track._id } : {}),
    kind,
    startedAtClient: event.startedAtClient,
    receivedAt: now,
    playedSec,
    countedSec,
    counted,
  });

  if (counted) {
    // Re-read: an earlier event in this batch may have patched the same copy.
    const fresh = (await ctx.db.get(entitlement._id))!;
    const stats = { ...(fresh.wearStats ?? zeroWearStats()) };
    if (kind === 'play') {
      if (copy.lend) stats.lentPlaySeconds += countedSec; // LEND-6, LENT_WEIGHT applies in computeWear
      else stats.playSeconds += countedSec;
    } else if (kind === 'load') stats.loads += 1;
    else stats.ejects += 1;
    await ctx.db.patch(entitlement._id, { wearStats: stats });
  }

  return result('recorded', null, { countedSec, counted, limitedBy });
}

/** Stores a batch of play, load and eject events for `actor` and adds what counts to each copy's wear. */
export async function ingestPlayEvents(
  ctx: MutationCtx,
  actor: Doc<'users'>,
  events: PlayEventInput[],
  now: number,
): Promise<PlayEventResult[]> {
  const seen = new Set<string>();
  const results: PlayEventResult[] = [];
  for (const event of events) results.push(await ingestOne(ctx, actor, event, now, seen));
  return results;
}

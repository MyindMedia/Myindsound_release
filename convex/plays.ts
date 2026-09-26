import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, mutation } from './_generated/server';
import { hasEntitlement } from './entitlements';
import { ensureViewer } from './lib/auth';
import { fail } from './lib/errors';
import { ingestPlayEvents, MAX_EVENT_AGE_MS, MAX_EVENTS_PER_BATCH, dayBucket } from './wear';

export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

/** The website's play history (one row per play). Unchanged; the app reports through `recordPlayEvents`. */
export const log = mutation({
  args: { trackId: v.id('tracks') },
  handler: async (ctx, { trackId }) => {
    const user = await ensureViewer(ctx);
    const track = await ctx.db.get(trackId);
    if (!track) fail('NOT_FOUND', 'Track not found.');
    if (!(await hasEntitlement(ctx, user._id, track.productId))) {
      fail('NOT_ENTITLED', 'No license found for this release.');
    }
    await ctx.db.insert('plays', { userId: user._id, trackId, playedAt: Date.now() });
  },
});

const playEventInput = v.object({
  idempotencyKey: v.string(),
  kind: v.optional(v.union(v.literal('play'), v.literal('load'), v.literal('eject'))),
  // Strings, not v.id: one stale or malformed id in an offline queue must reject that event, not the whole batch.
  trackId: v.optional(v.string()),
  slug: v.optional(v.string()),
  startedAtClient: v.number(),
  playedSec: v.optional(v.number()),
  lendId: v.optional(v.string()),
});

/**
 * WEAR-6..8: the app's (possibly offline, WEAR-9) queue of play sessions, loads and ejects. Idempotent per
 * `idempotencyKey`; each event is clamped, time checked and capped, and what counts is added to the copy's
 * cumulative `wearStats` (lent plays to `lentPlaySeconds`). Per-event outcomes come back in order; the client
 * drops every event whose status is `recorded`, `duplicate` or `rejected` from its queue.
 */
export const recordPlayEvents = mutation({
  args: { events: v.array(playEventInput) },
  handler: async (ctx, { events }) => {
    if (events.length > MAX_EVENTS_PER_BATCH) {
      fail('INVALID_INPUT', `At most ${MAX_EVENTS_PER_BATCH} events per call.`);
    }
    const user = await ensureViewer(ctx);
    const results = await ingestPlayEvents(ctx, user, events, Date.now());
    return {
      results,
      recorded: results.filter((r) => r.status === 'recorded').length,
      duplicates: results.filter((r) => r.status === 'duplicate').length,
      rejected: results.filter((r) => r.status === 'rejected').length,
    };
  },
});

/**
 * Daily retention job: website plays and app play events older than 12 months, and wear day tallies no event
 * can reach any more. None of these are read by wear, so wear never drops (NFR-2, §3A).
 */
export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const cutoff = now - RETENTION_MS;
    const old = await ctx.db
      .query('plays')
      .withIndex('by_playedAt', (q) => q.lt('playedAt', cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    const oldEvents = await ctx.db
      .query('playEvents')
      .withIndex('by_receivedAt', (q) => q.lt('receivedAt', cutoff))
      .take(PRUNE_BATCH);
    for (const row of oldEvents) await ctx.db.delete(row._id);
    // A day bucket is closed once its whole day is older than the 60 day window (one day of slack).
    const lastOpenDay = dayBucket(now - MAX_EVENT_AGE_MS) - 1;
    const oldDays = await ctx.db
      .query('wearDays')
      .withIndex('by_day', (q) => q.lt('day', lastOpenDay))
      .take(PRUNE_BATCH);
    for (const row of oldDays) await ctx.db.delete(row._id);
    if (old.length === PRUNE_BATCH || oldEvents.length === PRUNE_BATCH || oldDays.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.plays.prune, {});
    }
    return { deleted: old.length, playEvents: oldEvents.length, wearDays: oldDays.length };
  },
});

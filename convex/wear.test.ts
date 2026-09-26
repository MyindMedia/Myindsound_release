import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';
import {
  CLOCK_SKEW_MS,
  DAILY_PLAY_CAP_SEC,
  MAX_EVENT_AGE_MS,
  checkEventTime,
  clampPlayedSec,
  countableSec,
  dayBucket,
} from './wear';

const DAY = 24 * 60 * 60 * 1000;
type T = ReturnType<typeof newTest>;

/** LIT with OWNER's licence migrated (edition, wear seed, zero stats), track 1 set to exactly 3 minutes. */
async function seed(t: T) {
  const seeded = await seedLitWithOwner(t);
  await t.mutation(internal.migrations.assignEditions, {});
  await t.run((ctx) => ctx.db.patch(seeded.trackIds[0], { durationSeconds: 180 }));
  const entitlementId = await t.run(async (ctx) => (await ctx.db.query('entitlements').first())!._id);
  return { ...seeded, entitlementId };
}

const stats = (t: T, id: Id<'entitlements'>) => t.run(async (ctx) => (await ctx.db.get(id))!.wearStats!);
const eventCount = (t: T) => t.run(async (ctx) => (await ctx.db.query('playEvents').collect()).length);
const wearOf = async (t: T) => (await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' })).wear;

/** A UTC day start two days back, so a whole day of events is in the past and inside the 60 day window. */
function pastDayStart() {
  return (dayBucket(Date.now()) - 2) * DAY;
}

function plays(trackId: string, count: number, start: number, playedSec = 180, prefix = 'evt') {
  return Array.from({ length: count }, (_, i) => ({
    idempotencyKey: `${prefix}-${String(i).padStart(4, '0')}-0000-4000-8000-000000000000`,
    trackId,
    startedAtClient: start + i * 200_000,
    playedSec,
  }));
}

describe('wear ingestion, pure parts', () => {
  test('clamp: at most duration x 1.05, never more than has elapsed, and invalid seconds rejected', () => {
    const now = 10 * DAY;
    expect(clampPlayedSec(36_000, 180, now - DAY, now)).toBe(189);
    expect(clampPlayedSec(100, 180, now - DAY, now)).toBe(100);
    expect(clampPlayedSec(180, 180, now + CLOCK_SKEW_MS - 120_000, now)).toBe(120);
    expect(clampPlayedSec(-1, 180, now - DAY, now)).toBeNull();
    expect(clampPlayedSec(Number.NaN, 180, now - DAY, now)).toBeNull();
  });

  test('time check: future beyond the tolerance and older than 60 days are rejected', () => {
    const now = 100 * DAY;
    expect(checkEventTime(now, now)).toBe('ok');
    expect(checkEventTime(now + CLOCK_SKEW_MS, now)).toBe('ok');
    expect(checkEventTime(now + CLOCK_SKEW_MS + 1, now)).toBe('future');
    expect(checkEventTime(now - MAX_EVENT_AGE_MS, now)).toBe('ok');
    expect(checkEventTime(now - MAX_EVENT_AGE_MS - 1, now)).toBe('too_old');
    expect(checkEventTime(Number.POSITIVE_INFINITY, now)).toBe('invalid');
  });

  test('daily cap: whatever fits under 8 hours', () => {
    expect(countableSec(100, 0)).toBe(100);
    expect(countableSec(100, DAILY_PLAY_CAP_SEC - 40)).toBe(40);
    expect(countableSec(100, DAILY_PLAY_CAP_SEC)).toBe(0);
  });
});

describe('plays.recordPlayEvents (WEAR-6..8, PRD 11.6)', () => {
  test('11.6 test 4: replaying the same batch twice changes nothing', async () => {
    const t = newTest();
    const { trackIds, entitlementId } = await seed(t);
    const batch = plays(trackIds[0], 5, pastDayStart());
    const first = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: batch });
    expect(first).toMatchObject({ recorded: 5, duplicates: 0, rejected: 0 });
    const afterFirst = { stats: await stats(t, entitlementId), wear: await wearOf(t), events: await eventCount(t) };
    expect(afterFirst.stats.playSeconds).toBe(900);

    const second = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: batch });
    expect(second).toMatchObject({ recorded: 0, duplicates: 5, rejected: 0 });
    expect(await stats(t, entitlementId)).toEqual(afterFirst.stats);
    expect(await wearOf(t)).toEqual(afterFirst.wear);
    expect(await eventCount(t)).toBe(afterFirst.events);
  });

  test('a key repeated inside one batch counts once', async () => {
    const t = newTest();
    const { trackIds, entitlementId } = await seed(t);
    const [event] = plays(trackIds[0], 1, pastDayStart());
    const result = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: [event, event] });
    expect(result.results.map((r) => r.status)).toEqual(['recorded', 'duplicate']);
    expect((await stats(t, entitlementId)).playSeconds).toBe(180);
  });

  test('11.6 test 5: an event of 10 hours on a 3 minute track is clamped to 189 seconds', async () => {
    const t = newTest();
    const { trackIds, entitlementId } = await seed(t);
    const [event] = plays(trackIds[0], 1, pastDayStart(), 10 * 60 * 60);
    const { results } = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: [event] });
    expect(results[0]).toMatchObject({ status: 'recorded', countedSec: 189, counted: true, limitedBy: 'clamp' });
    expect((await stats(t, entitlementId)).playSeconds).toBe(189);
    const [row] = await t.run((ctx) => ctx.db.query('playEvents').collect());
    expect(row.playedSec).toBe(189);
  });

  test('11.6 test 8: an offline queue of 200 events flushes exactly once after reconnect', async () => {
    const t = newTest();
    const { trackIds, entitlementId } = await seed(t);
    // 200 plays of 60 s, spread over 3 days so the daily cap never bites.
    const start = (dayBucket(Date.now()) - 5) * DAY;
    const queue = Array.from({ length: 200 }, (_, i) => ({
      idempotencyKey: `offline-${String(i).padStart(4, '0')}-4000-8000-000000000000`,
      trackId: trackIds[0],
      startedAtClient: start + i * 1_200_000,
      playedSec: 60,
    }));
    // The connection drops after the server committed the first 120; the client retries the whole queue.
    const partial = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: queue.slice(0, 120) });
    expect(partial.recorded).toBe(120);
    const flush = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: queue });
    expect(flush).toMatchObject({ recorded: 80, duplicates: 120, rejected: 0 });
    // And a third, redundant flush.
    const again = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: queue });
    expect(again).toMatchObject({ recorded: 0, duplicates: 200, rejected: 0 });
    expect(await eventCount(t)).toBe(200);
    expect((await stats(t, entitlementId)).playSeconds).toBe(200 * 60);
  });

  test('WEAR-8: at most 8 hours count per day; the excess is recorded without wear', async () => {
    const t = newTest();
    const { trackIds, entitlementId } = await seed(t);
    // 200 x 180 s = 10 hours inside one UTC day.
    const batch = plays(trackIds[0], 200, pastDayStart());
    const { results } = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: batch });
    expect(results.every((r) => r.status === 'recorded')).toBe(true);
    expect((await stats(t, entitlementId)).playSeconds).toBe(DAILY_PLAY_CAP_SEC);
    expect(results.filter((r) => r.limitedBy === 'daily_cap').length).toBe(40);
    expect(await eventCount(t)).toBe(200);
    // The next day has its own allowance.
    const nextDay = plays(trackIds[0], 1, pastDayStart() + DAY, 180, 'next');
    await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: nextDay });
    expect((await stats(t, entitlementId)).playSeconds).toBe(DAILY_PLAY_CAP_SEC + 180);
  });

  test('WEAR-7: future and 60+ day old events are rejected and never stored', async () => {
    const t = newTest();
    const { trackIds, entitlementId } = await seed(t);
    const now = Date.now();
    const events = [
      { idempotencyKey: 'future-0000-0000', trackId: trackIds[0], startedAtClient: now + 60 * 60 * 1000, playedSec: 60 },
      { idempotencyKey: 'tooold-0000-0000', trackId: trackIds[0], startedAtClient: now - 61 * DAY, playedSec: 60 },
      { idempotencyKey: 'badkey' , trackId: trackIds[0], startedAtClient: now - DAY, playedSec: 60 },
      { idempotencyKey: 'notrack-0000-000', trackId: 'not-an-id', startedAtClient: now - DAY, playedSec: 60 },
      { idempotencyKey: 'negative-000-000', trackId: trackIds[0], startedAtClient: now - DAY, playedSec: -5 },
    ];
    const { results } = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events });
    expect(results.map((r) => r.reason)).toEqual(['future', 'too_old', 'invalid', 'unknown_track', 'invalid']);
    expect(await eventCount(t)).toBe(0);
    expect((await stats(t, entitlementId)).playSeconds).toBe(0);
  });

  test('no licence, no wear: a stranger and a lend id (lends not built yet) are rejected', async () => {
    const t = newTest();
    const { trackIds } = await seed(t);
    const [event] = plays(trackIds[0], 1, pastDayStart());
    const stranger = await t.withIdentity(STRANGER).mutation(api.plays.recordPlayEvents, { events: [event] });
    expect(stranger.results[0]).toMatchObject({ status: 'rejected', reason: 'no_access' });
    const lent = await t
      .withIdentity(OWNER)
      .mutation(api.plays.recordPlayEvents, { events: [{ ...event, idempotencyKey: 'lent-0000-0000', lendId: 'lend_1' }] });
    expect(lent.results[0]).toMatchObject({ status: 'rejected', reason: 'no_access' });
    await expect(t.mutation(api.plays.recordPlayEvents, { events: [event] })).rejects.toThrow(/UNAUTHENTICATED|Sign in/);
  });

  test('loads and ejects wear the copy, one per kind per 2 seconds', async () => {
    const t = newTest();
    const { entitlementId } = await seed(t);
    const at = pastDayStart();
    const handling = (key: string, kind: 'load' | 'eject', offset: number) => ({
      idempotencyKey: `${key}-0000-0000`,
      kind,
      slug: 'lit',
      startedAtClient: at + offset,
    });
    const { results } = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, {
      events: [handling('load1', 'load', 0), handling('load2', 'load', 1000), handling('ejct1', 'eject', 1500), handling('load3', 'load', 5000)],
    });
    expect(results.map((r) => r.counted)).toEqual([true, false, true, true]);
    expect(results[1].limitedBy).toBe('rate_limited');
    expect(await stats(t, entitlementId)).toMatchObject({ loads: 2, ejects: 1 });
  });

  test('wear survives pruning: deleting old plays, events and day tallies leaves wear unchanged', async () => {
    const t = newTest();
    const { trackIds, entitlementId, ownerId } = await seed(t);
    await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, { events: plays(trackIds[0], 10, pastDayStart()) });
    await t.withIdentity(OWNER).mutation(api.plays.log, { trackId: trackIds[0] });
    const before = { stats: await stats(t, entitlementId), wear: await wearOf(t) };
    expect(before.wear!.level).toBeGreaterThan(0);

    // Thirteen months later: every row is past retention.
    const old = Date.now() - 400 * DAY;
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('playEvents').collect()) await ctx.db.patch(row._id, { receivedAt: old });
      for (const row of await ctx.db.query('plays').collect()) await ctx.db.patch(row._id, { playedAt: old });
      for (const row of await ctx.db.query('wearDays').collect()) await ctx.db.patch(row._id, { day: dayBucket(old) });
    });
    const pruned = await t.mutation(internal.plays.prune, {});
    expect(pruned).toEqual({ deleted: 1, playEvents: 10, wearDays: 1 });
    expect(await t.run((ctx) => ctx.db.query('playEvents').collect())).toHaveLength(0);
    expect(await stats(t, entitlementId)).toEqual(before.stats);
    expect(await wearOf(t)).toEqual(before.wear);
    expect(ownerId).toBeDefined();
  });
});

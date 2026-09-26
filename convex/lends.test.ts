import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import {
  LEND_DURATION_MS,
  LEND_PLAYS_ALLOWED,
  LEND_UNCLAIMED_EXPIRY_MS,
  LENT_PLAY_MIN_SEC,
  canTransition,
  isTerminal,
  LEND_STATUSES,
  type LendStatus,
} from './lendLogic';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

/**
 * PRD §12 lending. The eight required tests of §12.5 come first, then the extras the build asked for.
 *
 * Time: every lend rule runs on server time. The tests move the server clock with fake `Date` only (timers stay
 * real so convex-test's own machinery is untouched); the app never sends a time to `lends.*`.
 */

const THIRD = { subject: 'user_third', email: 'third@example.test', name: 'Third Person' };
const SECRET = 'test-media-secret-0123456789abcdef-0123456789';
const SEC = 1000;
const HOUR = 60 * 60 * SEC;
const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
type T = ReturnType<typeof newTest>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  vi.stubEnv('MEDIA_TOKEN_SECRET', SECRET);
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function seed(t: T) {
  const seeded = await seedLitWithOwner(t);
  await t.mutation(internal.migrations.assignEditions, {});
  const entitlementId = await t.run(async (ctx) => (await ctx.db.query('entitlements').first())!._id);
  return { ...seeded, entitlementId };
}

async function offer(t: T) {
  const created = await t.withIdentity(OWNER).action(api.lends.create, { slug: 'lit' });
  const token = created.claimUrl.split('/').pop()!;
  return { ...created, token };
}

async function lentToStranger(t: T) {
  const seeded = await seed(t);
  const created = await offer(t);
  await t.withIdentity(STRANGER).mutation(api.lends.claim, { token: created.token });
  return { ...seeded, ...created };
}

const lendRow = (t: T, lendId: Id<'lends'>) => t.run(async (ctx) => (await ctx.db.get(lendId))!);
const notices = (t: T) =>
  t.run(async (ctx) => (await ctx.db.query('lendNotices').collect()).map((n) => `${n.kind}:${n.userId}`));

/** One counted borrower play: start, let 31 seconds of server time pass, commit. */
async function playOnce(t: T, lendId: Id<'lends'>, trackId: Id<'tracks'>) {
  const borrower = t.withIdentity(STRANGER);
  const { playId } = await borrower.mutation(api.lends.startLentPlay, { lendId, trackId });
  advance((LENT_PLAY_MIN_SEC + 1) * SEC);
  return await borrower.mutation(api.lends.commitLentPlay, { lendId, trackId, playId });
}

const streamAs = (t: T, who: typeof OWNER | typeof STRANGER, trackId: string, lendId?: string) =>
  t.withIdentity(who).action(api.media.getStreamUrl, { trackId, ...(lendId ? { lendId } : {}) });

describe('PRD 12.5 required tests', () => {
  test('12.5-1: two devices claim the same token: exactly one succeeds', async () => {
    const t = newTest();
    await seed(t);
    const { token, lendId } = await offer(t);
    // convex-test runs mutations one at a time, so this is the serialised version of the race. In production the
    // guarantee comes from Convex's optimistic concurrency control: both claims read the lend row (status
    // `offered`) and write it; mutations are serialisable, so whichever commits second finds its read set changed,
    // is retried from scratch, and then reads `active` with the first borrower and is refused. There is no
    // interleaving in which both commit.
    const results = await Promise.allSettled([
      t.withIdentity(STRANGER).mutation(api.lends.claim, { token }),
      t.withIdentity(THIRD).mutation(api.lends.claim, { token }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(refused.reason)).toMatch(/already on loan to someone else/);

    // Single use, sequentially: the forwarded link is refused for anyone else, and retrying is idempotent for the
    // borrower who holds it.
    await expect(t.withIdentity(THIRD).mutation(api.lends.claim, { token })).rejects.toThrow(/already on loan/);
    const again = await t.withIdentity(STRANGER).mutation(api.lends.claim, { token });
    expect(again).toMatchObject({ lendId, status: 'active' });
    const row = await lendRow(t, lendId);
    expect(row.borrowerUserId).toBeDefined();
    expect(row.claimedAt).toBe(T0);
    expect(row.expiresAt).toBe(T0 + LEND_DURATION_MS);
  });

  test('12.5-2: play 11 is refused, including plays started "offline" before the allowance ran out', async () => {
    const t = newTest();
    const { lendId, trackIds } = await lentToStranger(t);
    const borrower = t.withIdentity(STRANGER);
    for (let i = 1; i <= LEND_PLAYS_ALLOWED - 2; i++) {
      const played = await playOnce(t, lendId, trackIds[i % trackIds.length]);
      expect(played).toMatchObject({ counted: true, playsUsed: i });
    }
    // Three sessions opened while two plays remain (the app then loses its connection), committed later.
    const a = await borrower.mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[0] });
    const b = await borrower.mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[1] });
    const c = await borrower.mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[2] });
    advance(60 * SEC);
    expect(await borrower.mutation(api.lends.commitLentPlay, { lendId, trackId: trackIds[0], playId: a.playId })).toMatchObject({
      counted: true,
      playsUsed: 9,
      playsLeft: 1,
    });
    expect(await borrower.mutation(api.lends.commitLentPlay, { lendId, trackId: trackIds[1], playId: b.playId })).toMatchObject({
      counted: true,
      playsUsed: 10,
      playsLeft: 0,
      status: 'exhausted',
    });
    // Play 11 is refused both ways: its commit, and a fresh start.
    await expect(
      borrower.mutation(api.lends.commitLentPlay, { lendId, trackId: trackIds[2], playId: c.playId }),
    ).rejects.toThrow(/NOT_ENTITLED|ended/);
    await expect(borrower.mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[0] })).rejects.toThrow(/ended/);
    // A retried commit of play 10 is idempotent, not an error and not a second count.
    expect(await borrower.mutation(api.lends.commitLentPlay, { lendId, trackId: trackIds[1], playId: b.playId })).toMatchObject({
      counted: false,
      duplicate: true,
      playsUsed: 10,
    });
    const row = await lendRow(t, lendId);
    expect(row).toMatchObject({ status: 'exhausted', playsUsed: 10, endReason: 'plays_used' });

    // The final track may finish streaming, then the stream is closed.
    await streamAs(t, STRANGER, trackIds[1], lendId);
    advance(10 * 60 * SEC);
    await expect(streamAs(t, STRANGER, trackIds[1], lendId)).rejects.toThrow(/NOT_ENTITLED/);
  });

  test('12.5-3: the lender is locked out while the copy is out (offered or active), and back after call back', async () => {
    const t = newTest();
    const { trackIds } = await seed(t);
    await expect(streamAs(t, OWNER, trackIds[0])).resolves.toMatchObject({ url: expect.any(String) });
    const { token, lendId } = await offer(t);
    await expect(streamAs(t, OWNER, trackIds[0])).rejects.toThrow(/out on loan/);
    await t.withIdentity(STRANGER).mutation(api.lends.claim, { token });
    await expect(streamAs(t, OWNER, trackIds[0])).rejects.toThrow(/out on loan/);
    // Offline plays and cartridge handling by the lender don't count while it's out either.
    const flushed = await t.withIdentity(OWNER).mutation(api.plays.recordPlayEvents, {
      events: [{ idempotencyKey: 'owner-while-lent-0001', trackId: trackIds[0], startedAtClient: Date.now() - 200 * SEC, playedSec: 100 }],
    });
    expect(flushed.results[0]).toMatchObject({ status: 'rejected', reason: 'no_access' });
    // The borrower streams the lender's copy.
    await expect(streamAs(t, STRANGER, trackIds[0], lendId)).resolves.toMatchObject({ url: expect.any(String) });

    const back = await t.withIdentity(OWNER).mutation(api.lends.callBack, { lendId });
    expect(back).toMatchObject({ status: 'returned' });
    await expect(streamAs(t, OWNER, trackIds[0])).resolves.toMatchObject({ url: expect.any(String) });
    await expect(streamAs(t, STRANGER, trackIds[0], lendId)).rejects.toThrow(/NOT_ENTITLED/);
  });

  test('12.5-4: lender refunded mid lend: the lend is revoked and the borrower\'s next play is refused', async () => {
    const t = newTest();
    const { lendId, trackIds } = await lentToStranger(t);
    await playOnce(t, lendId, trackIds[0]);
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_owner' });
    expect(await lendRow(t, lendId)).toMatchObject({ status: 'revoked', endReason: 'lender_revoked' });
    await expect(t.withIdentity(STRANGER).mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[1] })).rejects.toThrow(
      /ended/,
    );
    await expect(streamAs(t, STRANGER, trackIds[1], lendId)).rejects.toThrow(/NOT_ENTITLED/);
    const mine = await t.withIdentity(STRANGER).query(api.lends.mine, {});
    expect(mine.asBorrower[0]).toMatchObject({ lendId, status: 'revoked' });
  });

  test('12.5-5: borrower buys during the lend: converted, with their own entitlement and a new edition', async () => {
    const t = newTest();
    const { lendId, litId } = await lentToStranger(t);
    await t.mutation(internal.fulfilment.record, {
      sessionId: 'cs_test_borrower',
      clerkId: STRANGER.subject,
      email: STRANGER.email,
      amountTotal: 500,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    });
    expect(await lendRow(t, lendId)).toMatchObject({ status: 'converted', endReason: 'bought_own_copy' });
    const own = await t.run(async (ctx) => {
      const user = await ctx.db.query('users').withIndex('by_clerkId', (q) => q.eq('clerkId', STRANGER.subject)).unique();
      return await ctx.db
        .query('entitlements')
        .withIndex('by_user_product', (q) => q.eq('userId', user!._id).eq('productId', litId))
        .unique();
    });
    expect(own).toMatchObject({ editionNumber: 2, convertedFromLendId: lendId, status: 'active' });
    const context = await t.withIdentity(STRANGER).query(api.app.context, { slug: 'lit' });
    expect(context).toMatchObject({ ownership: 'owned', editionNumber: 2, lend: null });
    // The lender has their copy back.
    expect((await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' })).lend).toBeNull();
  });

  test('12.5-6: device clock tampering has no effect on expiry', async () => {
    const t = newTest();
    const { lendId, trackIds } = await lentToStranger(t);
    const borrower = t.withIdentity(STRANGER);
    // A device clock set 30 days ahead or 30 days back: its play events are rejected or clamped, never extend.
    const skewed = await borrower.mutation(api.plays.recordPlayEvents, {
      events: [
        { idempotencyKey: 'skew-ahead-000001', trackId: trackIds[0], lendId, startedAtClient: Date.now() + 30 * 24 * HOUR, playedSec: 100 },
      ],
    });
    expect(skewed.results[0]).toMatchObject({ status: 'rejected', reason: 'future' });
    // lends.* takes no client time at all; a commit right after start is refused on server time.
    const { playId } = await borrower.mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[0] });
    advance(5 * SEC);
    await expect(borrower.mutation(api.lends.commitLentPlay, { lendId, trackId: trackIds[0], playId })).rejects.toThrow(/30 seconds/);

    // Server time passes expiresAt: refused on the next call, before the cron has run.
    advance(LEND_DURATION_MS);
    await expect(borrower.mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[0] })).rejects.toThrow(/ended/);
    await expect(streamAs(t, STRANGER, trackIds[0], lendId)).rejects.toThrow(/NOT_ENTITLED/);
    await expect(streamAs(t, OWNER, trackIds[0])).resolves.toMatchObject({ url: expect.any(String) });
    expect((await borrower.query(api.lends.mine, {})).asBorrower[0]).toMatchObject({ status: 'expired', endReason: 'time_up' });
    // The refused call rolled back; the 15 minute job writes the terminal state.
    expect(await t.mutation(internal.lends.settleDue, {})).toMatchObject({ expired: 1 });
    expect(await lendRow(t, lendId)).toMatchObject({ status: 'expired', endReason: 'time_up' });
  });

  test('12.5-7: a lent copy cannot be lent again (and one copy is in one place at a time)', async () => {
    const t = newTest();
    await lentToStranger(t);
    await expect(t.withIdentity(STRANGER).action(api.lends.create, { slug: 'lit' })).rejects.toThrow(/can't be lent again/);
    await expect(t.withIdentity(OWNER).action(api.lends.create, { slug: 'lit' })).rejects.toThrow(/already out on loan/);
    await expect(t.withIdentity(THIRD).action(api.lends.create, { slug: 'lit' })).rejects.toThrow(/NOT_ENTITLED/);
  });

  test('12.5-8: an unclaimed lend expires after 72 hours and the lender\'s access returns', async () => {
    const t = newTest();
    const { trackIds } = await seed(t);
    const { token, lendId } = await offer(t);
    await expect(streamAs(t, OWNER, trackIds[0])).rejects.toThrow(/out on loan/);
    advance(LEND_UNCLAIMED_EXPIRY_MS - SEC);
    expect(await t.mutation(internal.lends.settleDue, {})).toMatchObject({ unclaimedExpired: 0 });
    advance(SEC);
    // Access is back on read, before the job persists it...
    await expect(streamAs(t, OWNER, trackIds[0])).resolves.toMatchObject({ url: expect.any(String) });
    // ...and the 15 minute job moves it to its terminal state.
    expect(await t.mutation(internal.lends.settleDue, {})).toMatchObject({ unclaimedExpired: 1 });
    expect(await lendRow(t, lendId)).toMatchObject({ status: 'unclaimed_expired', endReason: 'unclaimed' });
    await expect(t.withIdentity(STRANGER).mutation(api.lends.claim, { token })).rejects.toThrow(/expired/);
  });
});

describe('lends through the app API', () => {
  test('app.context and app.library show the lent copy with the lender\'s edition, name and wear', async () => {
    const t = newTest();
    const { lendId, entitlementId } = await lentToStranger(t);
    const owner = await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' });
    const borrowed = await t.withIdentity(STRANGER).query(api.app.context, { slug: 'lit' });
    expect(borrowed).toMatchObject({
      ownership: 'lent',
      editionNumber: 1,
      ownerDisplayName: 'Owner T.',
      lend: { lendId, role: 'borrower', status: 'active', playsAllowed: 10, playsUsed: 0, expiresAt: T0 + LEND_DURATION_MS, endScreen: null },
    });
    expect(borrowed.wear).toEqual(owner.wear);
    expect(owner.lend).toMatchObject({ lendId, role: 'lender', status: 'active' });
    const library = await t.withIdentity(STRANGER).query(api.app.library, {});
    expect(library.releases[0]).toMatchObject({ slug: 'lit', ownership: 'lent', editionNumber: 1, lend: { role: 'borrower' } });
    const row = await t.run(async (ctx) => (await ctx.db.get(entitlementId))!);
    expect(JSON.stringify(borrowed)).not.toContain(row.userId!);
  });

  test('LEND-6: borrower play seconds wear the lender\'s copy as lentPlaySeconds', async () => {
    const t = newTest();
    const { lendId, trackIds, entitlementId } = await lentToStranger(t);
    const result = await t.withIdentity(STRANGER).mutation(api.plays.recordPlayEvents, {
      events: [{ idempotencyKey: 'borrowed-play-0001', trackId: trackIds[0], lendId, startedAtClient: Date.now() - 300 * SEC, playedSec: 100 }],
    });
    expect(result.results[0]).toMatchObject({ status: 'recorded', countedSec: 100 });
    const stats = await t.run(async (ctx) => (await ctx.db.get(entitlementId))!.wearStats!);
    expect(stats).toMatchObject({ playSeconds: 0, lentPlaySeconds: 100 });
  });

  test('LEND-6: a committed lent play flushed after the lend ended still reaches the lender, once', async () => {
    const t = newTest();
    const { lendId, trackIds, entitlementId } = await lentToStranger(t);
    await playOnce(t, lendId, trackIds[0]);
    await t.withIdentity(OWNER).mutation(api.lends.callBack, { lendId });
    const event = (key: string) => ({ idempotencyKey: key, trackId: trackIds[0], lendId, startedAtClient: Date.now() - 200 * SEC, playedSec: 120 });
    const late = await t.withIdentity(STRANGER).mutation(api.plays.recordPlayEvents, { events: [event('late-flush-0001'), event('late-flush-0002')] });
    expect(late.results.map((r) => r.status)).toEqual(['recorded', 'rejected']);
    const stats = await t.run(async (ctx) => (await ctx.db.get(entitlementId))!.wearStats!);
    expect(stats.lentPlaySeconds).toBe(120);
  });

  test('LEND-8: exhausted and expired lends carry the end screen in lends.mine and app.context', async () => {
    const t = newTest();
    const { lendId, trackIds } = await lentToStranger(t);
    await t.run(async (ctx) => {
      const lit = (await ctx.db.query('products').first())!;
      await ctx.db.patch(lit._id, { appStoreProductIds: ['com.myindsound.app.lit.tier1'] });
    });
    for (let i = 0; i < LEND_PLAYS_ALLOWED; i++) await playOnce(t, lendId, trackIds[i % 6]);
    advance(HOUR);
    const context = await t.withIdentity(STRANGER).query(api.app.context, { slug: 'lit' });
    expect(context.ownership).toBe('lent');
    expect(context.lend).toMatchObject({
      status: 'exhausted',
      endScreen: {
        reason: 'exhausted',
        slug: 'lit',
        releaseTitle: 'LIT',
        editionNumber: 1,
        ownerDisplayName: 'Owner T.',
        appStoreProductIds: ['com.myindsound.app.lit.tier1'],
      },
    });
    const mine = await t.withIdentity(STRANGER).query(api.lends.mine, {});
    expect(mine.asBorrower[0]).toMatchObject({ status: 'exhausted', endScreen: { reason: 'exhausted' }, wear: context.wear });
    // The lender sees the history without the end screen.
    const lender = await t.withIdentity(OWNER).query(api.lends.mine, {});
    expect(lender.asLender[0]).toMatchObject({ lendId, status: 'exhausted', endScreen: null, borrowerDisplayName: 'Collector' });
  });

  test('LEND-2 and LEND-3: an owner cannot borrow, and a lender cannot claim their own lend', async () => {
    const t = newTest();
    await seed(t);
    await t.mutation(internal.fulfilment.record, {
      sessionId: 'cs_test_third',
      clerkId: THIRD.subject,
      email: THIRD.email,
      amountTotal: 500,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    });
    const { token } = await offer(t);
    await expect(t.withIdentity(THIRD).mutation(api.lends.claim, { token })).rejects.toThrow(/You already own this/);
    await expect(t.withIdentity(OWNER).mutation(api.lends.claim, { token })).rejects.toThrow(/your own disc/);
    await expect(t.withIdentity(STRANGER).mutation(api.lends.claim, { token: 'x'.repeat(22) })).rejects.toThrow(/NOT_FOUND/);
  });

  test('lends.preview (LEND-12) is public and carries no personal data', async () => {
    const t = newTest();
    const { entitlementId } = await seed(t);
    const { token } = await offer(t);
    const preview = await t.query(api.lends.preview, { token });
    expect(preview).toMatchObject({
      availability: 'available',
      slug: 'lit',
      releaseTitle: 'LIT',
      editionNumber: 1,
      ownerDisplayName: 'Owner T.',
      playsAllowed: LEND_PLAYS_ALLOWED,
      lendDays: 7,
    });
    expect(preview.wear).toMatchObject({ level: expect.any(Number), scratches: expect.any(Array) });
    const json = JSON.stringify(preview);
    const row = await t.run(async (ctx) => (await ctx.db.get(entitlementId))!);
    for (const secret of [OWNER.email, OWNER.subject, row.userId!, entitlementId, row.wearSeed!]) expect(json).not.toContain(secret);
    await t.withIdentity(STRANGER).mutation(api.lends.claim, { token });
    expect((await t.query(api.lends.preview, { token })).availability).toBe('on_loan');
  });

  test('LEND-11: push intents at claim, one play left, end, and 24 hours before expiry (once each)', async () => {
    const t = newTest();
    const { lendId, trackIds, ownerId, strangerId } = await lentToStranger(t);
    expect(await notices(t)).toEqual([`claimed:${ownerId}`]);
    advance(LEND_DURATION_MS - 23 * HOUR);
    await t.mutation(internal.lends.settleDue, {});
    await t.mutation(internal.lends.settleDue, {});
    expect(await notices(t)).toEqual([`claimed:${ownerId}`, `expiring_soon:${strangerId}`]);
    for (let i = 0; i < LEND_PLAYS_ALLOWED - 1; i++) await playOnce(t, lendId, trackIds[0]);
    expect((await notices(t)).at(-1)).toBe(`one_play_left:${strangerId}`);
    await playOnce(t, lendId, trackIds[0]);
    expect((await notices(t)).at(-1)).toBe(`ended:${ownerId}`);
    expect(await notices(t)).toHaveLength(4);
  });

  test('cancel an offer, and every terminal state refuses further transitions', async () => {
    const t = newTest();
    const { trackIds } = await seed(t);
    const { lendId, token } = await offer(t);
    await expect(t.withIdentity(OWNER).mutation(api.lends.callBack, { lendId })).rejects.toThrow(/not been claimed/);
    expect(await t.withIdentity(OWNER).mutation(api.lends.cancel, { lendId })).toMatchObject({ status: 'returned' });
    await expect(t.withIdentity(STRANGER).mutation(api.lends.claim, { token })).rejects.toThrow(/expired|ended/);

    const terminal: LendStatus[] = ['exhausted', 'expired', 'returned', 'revoked', 'converted', 'unclaimed_expired'];
    for (const status of terminal) {
      const next = await offer(t);
      await t.withIdentity(STRANGER).mutation(api.lends.claim, { token: next.token });
      await t.run((ctx) => ctx.db.patch(next.lendId, { status, endedAt: Date.now() }));
      const borrower = t.withIdentity(STRANGER);
      await expect(t.withIdentity(OWNER).mutation(api.lends.callBack, { lendId: next.lendId })).rejects.toThrow(/already ended/);
      await expect(t.withIdentity(OWNER).mutation(api.lends.cancel, { lendId: next.lendId })).rejects.toThrow(/already ended/);
      await expect(borrower.mutation(api.lends.claim, { token: next.token })).rejects.toThrow(/ended|on loan/);
      await expect(borrower.mutation(api.lends.startLentPlay, { lendId: next.lendId, trackId: trackIds[0] })).rejects.toThrow(/ended/);
      await t.mutation(internal.lends.settleDue, {});
      expect((await lendRow(t, next.lendId)).status).toBe(status);
    }
  });

  test('the state machine has no way out of a terminal state', () => {
    for (const from of LEND_STATUSES) {
      for (const to of LEND_STATUSES) {
        if (isTerminal(from)) expect(canTransition(from, to)).toBe(false);
      }
    }
    expect(canTransition('offered', 'active')).toBe(true);
    expect(canTransition('offered', 'exhausted')).toBe(false);
    expect(canTransition('active', 'offered')).toBe(false);
    expect(canTransition('active', 'converted')).toBe(true);
  });

  test('only the lender calls back, only the borrower plays, and nobody else learns the lend exists', async () => {
    const t = newTest();
    const { lendId, trackIds } = await lentToStranger(t);
    await expect(t.withIdentity(STRANGER).mutation(api.lends.callBack, { lendId })).rejects.toThrow(/NOT_FOUND/);
    await expect(t.withIdentity(THIRD).mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[0] })).rejects.toThrow(/NOT_FOUND/);
    await expect(t.withIdentity(OWNER).mutation(api.lends.startLentPlay, { lendId, trackId: trackIds[0] })).rejects.toThrow(/NOT_FOUND/);
    await expect(t.mutation(api.lends.claim, { token: 'x'.repeat(22) })).rejects.toThrow(/UNAUTHENTICATED|Sign in/);
  });
});

describe('privacy (NFR-2)', () => {
  test('export lists lends in both roles; deleting the borrower ends and detaches their lend', async () => {
    const t = newTest();
    const { lendId } = await lentToStranger(t);
    const exported = await t.withIdentity(STRANGER).query(api.privacy.exportMyData, {});
    expect(exported.lends).toEqual([expect.objectContaining({ role: 'borrower', release: 'LIT', status: 'active', playsUsed: 0 })]);
    expect(JSON.stringify(exported.lends)).not.toContain(OWNER.email);
    const lenderExport = await t.withIdentity(OWNER).query(api.privacy.exportMyData, {});
    expect(lenderExport.lends).toEqual([expect.objectContaining({ role: 'lender', status: 'active' })]);

    const strangerId = await t.run(async (ctx) => (await ctx.db.query('users').withIndex('by_clerkId', (q) => q.eq('clerkId', STRANGER.subject)).unique())!._id);
    await t.mutation(internal.privacy.wipeUserData, { userId: strangerId });
    const row = await lendRow(t, lendId);
    expect(row).toMatchObject({ status: 'returned', endReason: 'borrower_deleted' });
    expect(row.borrowerUserId).toBeUndefined();
  });

  test('deleting the lender removes their lends', async () => {
    const t = newTest();
    const { lendId, ownerId } = await lentToStranger(t);
    await t.mutation(internal.privacy.wipeUserData, { userId: ownerId });
    expect(await t.run((ctx) => ctx.db.get(lendId))).toBeNull();
    expect(await t.run(async (ctx) => (await ctx.db.query('lendNotices').collect()).length)).toBe(0);
  });
});

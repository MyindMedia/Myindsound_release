import { afterEach, describe, expect, test, vi } from 'vitest';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { newTest } from './test.setup';

type T = ReturnType<typeof newTest>;

// Rows shaped exactly like production before this change: no edition, wear, status or source.
async function seedLegacy(t: T, grants: { product: 'lit' | 'the-source'; grantedAt: number }[]) {
  return await t.run(async (ctx) => {
    const litId = await ctx.db.insert('products', {
      slug: 'lit',
      name: 'LIT',
      kind: 'digital',
      stripeProductIds: ['prod_lit'],
      active: true,
    });
    const sourceId = await ctx.db.insert('products', {
      slug: 'the-source',
      name: 'THE SOURCE',
      kind: 'digital',
      stripeProductIds: ['prod_source'],
      active: true,
    });
    const ids: Id<'entitlements'>[] = [];
    for (const [i, grant] of grants.entries()) {
      const userId = await ctx.db.insert('users', {
        clerkId: `user_legacy_${i}`,
        email: `legacy${i}@example.test`,
        isAdmin: false,
      });
      ids.push(
        await ctx.db.insert('entitlements', {
          userId,
          productId: grant.product === 'lit' ? litId : sourceId,
          stripeSessionId: `cs_legacy_${i}`,
          grantedAt: grant.grantedAt,
        }),
      );
    }
    return { litId, sourceId, ids };
  });
}

async function runUntilDone(t: T, batchSize: number) {
  const runs = [];
  for (let i = 0; i < 50; i++) {
    const result = await t.mutation(internal.migrations.assignEditions, { batchSize });
    runs.push(result);
    if (result.done) return runs;
  }
  throw new Error('migration did not finish');
}

async function counterFor(t: T, productId: Id<'products'>) {
  return await t.run((ctx) =>
    ctx.db
      .query('releaseCounters')
      .withIndex('by_product', (q) => q.eq('productId', productId))
      .unique(),
  );
}

const T0 = Date.UTC(2026, 0, 1);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('migrations.assignEditions (ED-0)', () => {
  test('numbers legacy LIT rows in grantedAt order (ties by creation order); THE SOURCE rows become presale', async () => {
    const t = newTest();
    const { litId, sourceId, ids } = await seedLegacy(t, [
      { product: 'lit', grantedAt: T0 + 300 }, // 0
      { product: 'lit', grantedAt: T0 + 100 }, // 1
      { product: 'the-source', grantedAt: T0 + 50 }, // 2
      { product: 'lit', grantedAt: T0 + 200 }, // 3: tie with 4, created first
      { product: 'lit', grantedAt: T0 + 200 }, // 4
      { product: 'the-source', grantedAt: T0 + 10 }, // 5
    ]);
    const result = await t.mutation(internal.migrations.assignEditions, {});
    expect(result).toMatchObject({ dryRun: false, numbered: 4, presaleMarked: 2, done: true });

    const row = async (id: Id<'entitlements'>) => (await t.run((ctx) => ctx.db.get(id)))!;
    const rows = await Promise.all(ids.map(row));
    expect(rows.map((r) => r.editionNumber)).toEqual([4, 1, undefined, 2, 3, undefined]);
    expect(rows.map((r) => r.presale ?? false)).toEqual([false, false, true, false, false, true]);
    expect(rows[2]).toMatchObject({ status: 'active', source: 'stripe', sourceRef: 'cs_legacy_2' });
    expect((await counterFor(t, litId))?.nextEdition).toBe(5);
    expect((await counterFor(t, sourceId))?.nextEdition).toBe(1);
  });

  test('backfills wear seed, zeroed wear, active status and the Stripe source, and reports counts only', async () => {
    const t = newTest();
    const { ids } = await seedLegacy(t, [{ product: 'lit', grantedAt: T0 }]);
    const log = vi.spyOn(console, 'log');
    const result = await t.mutation(internal.migrations.assignEditions, {});

    const row = (await t.run((ctx) => ctx.db.get(ids[0])))!;
    expect(row).toMatchObject({
      editionNumber: 1,
      status: 'active',
      source: 'stripe',
      sourceRef: 'cs_legacy_0',
      stripeSessionId: 'cs_legacy_0',
      wearStats: { playSeconds: 0, loads: 0, ejects: 0, lentPlaySeconds: 0 },
      wearModelVersion: 1,
      grantedAt: T0,
    });
    expect(row.wearSeed).toMatch(/^[0-9a-f]{32}$/);
    const refs = await t.run((ctx) => ctx.db.query('entitlementRefs').collect());
    expect(refs).toMatchObject([{ entitlementId: ids[0], source: 'stripe', sourceRef: 'cs_legacy_0', status: 'active' }]);

    for (const value of Object.values(result)) expect(['number', 'boolean']).toContain(typeof value);
    const printed = log.mock.calls.flat().join(' ');
    expect(printed).not.toMatch(/@|cs_legacy|user_legacy/);
  });

  test('runs in resumable batches and a second run changes nothing', async () => {
    const t = newTest();
    const { litId } = await seedLegacy(
      t,
      Array.from({ length: 7 }, (_, i) => ({ product: 'lit' as const, grantedAt: T0 + (7 - i) * 1000 })),
    );
    const runs = await runUntilDone(t, 3);
    expect(runs.map((run) => run.numbered)).toEqual([3, 3, 1]);
    expect(runs.map((run) => run.done)).toEqual([false, false, true]);

    const before = await t.run((ctx) => ctx.db.query('entitlements').collect());
    const counterBefore = await counterFor(t, litId);
    const again = await t.mutation(internal.migrations.assignEditions, { batchSize: 3 });
    expect(again).toMatchObject({ numbered: 0, presaleMarked: 0, countersSet: 0, done: true });
    expect(await t.run((ctx) => ctx.db.query('entitlements').collect())).toEqual(before);
    expect(await counterFor(t, litId)).toEqual(counterBefore);

    // Latest grantedAt was inserted first, so it is the last edition.
    const ordered = [...before].sort((a, b) => a.grantedAt - b.grantedAt).map((row) => row.editionNumber);
    expect(ordered).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(counterBefore?.nextEdition).toBe(8);
  });

  test('a dry run counts what it would do and writes nothing', async () => {
    const t = newTest();
    await seedLegacy(t, [
      { product: 'lit', grantedAt: T0 },
      { product: 'the-source', grantedAt: T0 },
    ]);
    const before = await t.run((ctx) => ctx.db.query('entitlements').collect());
    const result = await t.mutation(internal.migrations.assignEditions, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, numbered: 0, pending: 2, done: false });
    expect(await t.run((ctx) => ctx.db.query('entitlements').collect())).toEqual(before);
    expect(await t.run((ctx) => ctx.db.query('releaseCounters').collect())).toEqual([]);
  });

  test('a new grant after the migration continues the numbering', async () => {
    const t = newTest();
    const { litId } = await seedLegacy(t, [
      { product: 'lit', grantedAt: T0 },
      { product: 'lit', grantedAt: T0 + 1 },
    ]);
    await t.mutation(internal.migrations.assignEditions, {});
    const result = await t.mutation(internal.fulfilment.record, {
      sessionId: 'cs_new',
      clerkId: 'user_new',
      email: 'new@example.test',
      amountTotal: 500,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    });
    expect(result.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 3 }]);
    expect((await counterFor(t, litId))?.nextEdition).toBe(4);
  });

  test('grants made after deploy but before the migration wait for it, then number after the legacy buyers', async () => {
    const t = newTest();
    const { litId, ids } = await seedLegacy(t, [{ product: 'lit', grantedAt: T0 }]);
    const early = await t.mutation(internal.fulfilment.record, {
      sessionId: 'cs_between',
      clerkId: 'user_between',
      email: 'between@example.test',
      amountTotal: 500,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    });
    // Owned straight away, numbered by the migration so the legacy buyer keeps edition 1.
    expect(early.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: null }]);
    expect(await counterFor(t, litId)).toBeNull();
    const waiting = (await t.run((ctx) => ctx.db.query('entitlements').collect())).find((row) => row.sourceRef === 'cs_between')!;
    expect(waiting.status).toBe('active');
    expect(waiting.wearSeed).toMatch(/^[0-9a-f]{32}$/);

    await runUntilDone(t, 100);
    expect((await t.run((ctx) => ctx.db.get(ids[0])))!.editionNumber).toBe(1);
    const numbered = (await t.run((ctx) => ctx.db.get(waiting._id)))!;
    expect(numbered.editionNumber).toBe(2);
    expect(numbered.wearSeed).toBe(waiting.wearSeed); // ENT-3: the migration never re-seeds
    expect((await counterFor(t, litId))?.nextEdition).toBe(3);
  });

  test('products with no licences get a counter at 1', async () => {
    const t = newTest();
    const { litId, sourceId } = await seedLegacy(t, []);
    const result = await t.mutation(internal.migrations.assignEditions, {});
    expect(result).toMatchObject({ numbered: 0, countersSet: 2, done: true });
    expect((await counterFor(t, litId))?.nextEdition).toBe(1);
    expect((await counterFor(t, sourceId))?.nextEdition).toBe(1);
  });

  test('THE SOURCE: presale rows stay unnumbered and its first buyer at the drop is edition 1', async () => {
    const t = newTest();
    const { sourceId } = await seedLegacy(t, [
      { product: 'the-source', grantedAt: T0 },
      { product: 'the-source', grantedAt: T0 + 1 },
    ]);
    const atDrop = {
      clerkId: 'user_at_drop',
      email: 'atdrop@example.test',
      amountTotal: 900,
      currency: 'usd',
      lineItems: [{ description: 'THE SOURCE', quantity: 1, unitAmount: 900, stripeProductId: 'prod_source' }],
    };
    // Before the migration: the legacy presale rows do not hold the new buyer back.
    const first = await t.mutation(internal.fulfilment.record, { ...atDrop, sessionId: 'cs_drop_1' });
    expect(first.grants).toEqual([{ slug: 'the-source', outcome: 'created', editionNumber: 1 }]);
    await runUntilDone(t, 100);
    const second = await t.mutation(internal.fulfilment.record, {
      ...atDrop,
      clerkId: 'user_at_drop_2',
      sessionId: 'cs_drop_2',
    });
    expect(second.grants).toEqual([{ slug: 'the-source', outcome: 'created', editionNumber: 2 }]);
    const presale = (await t.run((ctx) => ctx.db.query('entitlements').collect())).filter((row) => row.presale);
    expect(presale).toHaveLength(2);
    expect(presale.every((row) => row.editionNumber === undefined)).toBe(true);
    expect((await counterFor(t, sourceId))?.nextEdition).toBe(3);
  });

  // convex-test runs one transaction at a time, so this checks the ordering logic across interleaved
  // transactions, not Convex's optimistic concurrency control (which production relies on for races).
  test('deploy window: grant, partial batch, grant, refund, resume give exact numbers', async () => {
    const t = newTest();
    const { litId, ids } = await seedLegacy(t, [
      { product: 'lit', grantedAt: T0 },
      { product: 'lit', grantedAt: T0 + 1 },
      { product: 'lit', grantedAt: T0 + 2 },
    ]);
    const buy = (n: number) =>
      t.mutation(internal.fulfilment.record, {
        sessionId: `cs_window_${n}`,
        clerkId: `user_window_${n}`,
        email: `window${n}@example.test`,
        amountTotal: 500,
        currency: 'usd',
        lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
      });
    const editionOf = async (sessionId: string) =>
      (await t.run((ctx) => ctx.db.query('entitlements').collect())).find((row) => row.stripeSessionId === sessionId)!
        .editionNumber;

    expect((await buy(1)).grants[0].editionNumber).toBeNull(); // G1 waits
    const partial = await t.mutation(internal.migrations.assignEditions, { batchSize: 2 });
    expect(partial).toMatchObject({ numbered: 2, done: false });
    expect((await counterFor(t, litId))?.nextEdition).toBe(3);
    expect((await buy(2)).grants[0].editionNumber).toBeNull(); // G2 still waits: L3 and G1 are unnumbered
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_window_1' });
    await runUntilDone(t, 2);

    const legacy = await Promise.all(ids.map(async (id) => (await t.run((ctx) => ctx.db.get(id)))!.editionNumber));
    expect(legacy).toEqual([1, 2, 3]);
    expect(await editionOf('cs_window_1')).toBe(4); // refunded: numbered in commit order, retired
    expect(await editionOf('cs_window_2')).toBe(5);
    expect((await counterFor(t, litId))?.nextEdition).toBe(6);
    expect((await buy(3)).grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 6 }]);
    expect((await buy(1)).grants).toEqual([{ slug: 'lit', outcome: 'revoked', editionNumber: 4 }]);
  });
});

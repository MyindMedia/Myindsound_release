import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

type T = ReturnType<typeof newTest>;

const HOUR = 60 * 60 * 1000;

async function seedProducts(t: T, lit: { dropAt?: number } = {}) {
  return await t.run(async (ctx) => {
    const litId = await ctx.db.insert('products', {
      slug: 'lit',
      name: 'LIT',
      kind: 'digital',
      stripeProductIds: ['prod_lit'],
      appStoreProductIds: ['app.lit.tier1', 'app.lit.tier2'],
      active: true,
      ...lit,
    });
    const sourceId = await ctx.db.insert('products', {
      slug: 'the-source',
      name: 'THE SOURCE',
      kind: 'digital',
      stripeProductIds: ['prod_source'],
      active: true,
    });
    return { litId, sourceId };
  });
}

function buyer(n: number) {
  return { clerkId: `user_buyer_${n}`, email: `buyer${n}@example.test`, name: `Buyer ${n}` };
}

function stripeInput(n: number, overrides: Record<string, unknown> = {}) {
  return {
    sessionId: `cs_test_${n}`,
    ...buyer(n),
    amountTotal: 500,
    currency: 'usd',
    lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    ...overrides,
  };
}

function storekitInput(n: number, transactionId: string, overrides: Record<string, unknown> = {}) {
  return {
    source: 'storekit' as const,
    sourceRef: transactionId,
    ...buyer(n),
    amountTotal: 499,
    currency: 'usd',
    lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 499, appStoreProductId: 'app.lit.tier1' }],
    ...overrides,
  };
}

async function litRows(t: T, litId: Id<'products'>) {
  const rows = await t.run((ctx) => ctx.db.query('entitlements').collect());
  return rows.filter((row) => row.productId === litId);
}

async function counter(t: T, productId: Id<'products'>) {
  return await t.run((ctx) =>
    ctx.db
      .query('releaseCounters')
      .withIndex('by_product', (q) => q.eq('productId', productId))
      .unique(),
  );
}

describe('fulfilment.record: editions (ED-1, ED-2)', () => {
  test('a Stripe grant stamps edition 1, a 128-bit wear seed, zeroed wear, active status and its source', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const result = await t.mutation(internal.fulfilment.record, stripeInput(1));
    expect(result.grantedSlugs).toEqual(['lit']);
    expect(result.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 1 }]);

    const [row] = await litRows(t, litId);
    expect(row).toMatchObject({
      editionNumber: 1,
      source: 'stripe',
      sourceRef: 'cs_test_1',
      stripeSessionId: 'cs_test_1',
      status: 'active',
      wearStats: { playSeconds: 0, loads: 0, ejects: 0, lentPlaySeconds: 0 },
      wearModelVersion: 1,
    });
    expect(row.wearSeed).toMatch(/^[0-9a-f]{32}$/);
    expect(row.unwrappedAt).toBeUndefined();
    expect((await counter(t, litId))?.nextEdition).toBe(2);
  });

  test('many grants get unique, gapless editions and distinct wear seeds', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const buyers = Array.from({ length: 30 }, (_, i) => i + 1);
    await Promise.all(buyers.map((n) => t.mutation(internal.fulfilment.record, stripeInput(n))));

    const rows = await litRows(t, litId);
    expect(rows).toHaveLength(30);
    expect(rows.map((row) => row.editionNumber).sort((a, b) => a! - b!)).toEqual(buyers);
    expect(new Set(rows.map((row) => row.wearSeed)).size).toBe(30);
    // Server commit order: editions follow insertion order.
    const byCommit = [...rows].sort((a, b) => a._creationTime - b._creationTime);
    expect(byCommit.map((row) => row.editionNumber)).toEqual(buyers);
    expect((await counter(t, litId))?.nextEdition).toBe(31);
  });

  test('each product keeps its own queue', async () => {
    const t = newTest();
    const { litId, sourceId } = await seedProducts(t);
    await t.mutation(internal.fulfilment.record, stripeInput(1));
    await t.mutation(
      internal.fulfilment.record,
      stripeInput(2, {
        lineItems: [
          { description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' },
          { description: 'THE SOURCE', quantity: 1, unitAmount: 900, stripeProductId: 'prod_source' },
        ],
      }),
    );
    const rows = await t.run((ctx) => ctx.db.query('entitlements').collect());
    const editions = rows.map((row) => [row.productId === litId ? 'lit' : 'source', row.editionNumber]);
    expect(editions.sort()).toEqual([
      ['lit', 1],
      ['lit', 2],
      ['source', 1],
    ]);
    expect((await counter(t, sourceId))?.nextEdition).toBe(2);
  });
});

describe('fulfilment.record: idempotency and ENT-3', () => {
  test('replaying the same Stripe session changes nothing, including edition and wear seed', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    await t.mutation(internal.fulfilment.record, stripeInput(1, { eventId: 'evt_1', eventType: 'checkout.session.completed' }));
    const [before] = await litRows(t, litId);

    // A different event for the same session (async_payment_succeeded), and the claim path with no event.
    const replay = await t.mutation(
      internal.fulfilment.record,
      stripeInput(1, { eventId: 'evt_2', eventType: 'checkout.session.async_payment_succeeded' }),
    );
    await t.mutation(internal.fulfilment.record, stripeInput(1));

    expect(replay.grantedSlugs).toEqual(['lit']);
    expect(replay.grants).toEqual([{ slug: 'lit', outcome: 'replayed', editionNumber: 1 }]);
    const after = await litRows(t, litId);
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
    expect((await counter(t, litId))?.nextEdition).toBe(2);
  });

  test('StoreKit grants use the same path and are idempotent on source and sourceRef', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const first = await t.mutation(internal.fulfilment.record, storekitInput(1, 'txn_1'));
    const replay = await t.mutation(internal.fulfilment.record, storekitInput(1, 'txn_1'));
    expect(first.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 1 }]);
    expect(replay.grants).toEqual([{ slug: 'lit', outcome: 'replayed', editionNumber: 1 }]);

    const [row] = await litRows(t, litId);
    expect(row).toMatchObject({ source: 'storekit', sourceRef: 'txn_1', status: 'active', editionNumber: 1 });
    expect(row.stripeSessionId).toBeUndefined();
    const buyerView = await t.withIdentity({ subject: buyer(1).clerkId }).query(api.entitlements.mine, {});
    expect(buyerView).toEqual(['lit']);
  });

  test('a transaction already granted to one account is not granted again to another', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    await t.mutation(internal.fulfilment.record, storekitInput(1, 'txn_shared'));
    const other = await t.mutation(internal.fulfilment.record, storekitInput(2, 'txn_shared'));
    expect(other.grantedSlugs).toEqual([]);
    expect(other.grants).toEqual([{ slug: 'lit', outcome: 'taken', editionNumber: null }]);
    expect(await litRows(t, litId)).toHaveLength(1);
    expect((await counter(t, litId))?.nextEdition).toBe(2);
  });

  test('NFC and admin grants can name the product directly', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const nfc = await t.mutation(internal.fulfilment.record, {
      source: 'nfc',
      sourceRef: 'tag_04a2',
      ...buyer(1),
      amountTotal: 0,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 0, productId: litId }],
    });
    const admin = await t.mutation(internal.fulfilment.record, {
      source: 'admin',
      sourceRef: 'audit_1',
      ...buyer(2),
      amountTotal: 0,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 0, productId: litId }],
    });
    expect(nfc.grants[0]).toEqual({ slug: 'lit', outcome: 'created', editionNumber: 1 });
    expect(admin.grants[0]).toEqual({ slug: 'lit', outcome: 'created', editionNumber: 2 });
  });

  test('a grant without a reference is refused, and so is a Stripe reference that is not its session', async () => {
    const t = newTest();
    await seedProducts(t);
    await expect(t.mutation(internal.fulfilment.record, storekitInput(1, 'txn_1', { sourceRef: undefined }))).rejects.toThrow(
      /INVALID_INPUT/,
    );
    await expect(t.mutation(internal.fulfilment.record, stripeInput(1, { sessionId: undefined }))).rejects.toThrow(
      /INVALID_INPUT/,
    );
    await expect(t.mutation(internal.fulfilment.record, stripeInput(1, { sourceRef: 'pi_other' }))).rejects.toThrow(
      /INVALID_INPUT/,
    );
    await expect(
      t.mutation(internal.fulfilment.record, storekitInput(1, 'txn_1', { orderType: 'physical' })),
    ).rejects.toThrow(/INVALID_INPUT/);
    expect(await t.run((ctx) => ctx.db.query('entitlements').collect())).toHaveLength(0);
  });
});

describe('fulfilment.record: ENT-5 and ED-3', () => {
  test('an owner buying again gets no second entitlement and consumes no edition', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    await t.mutation(internal.fulfilment.record, stripeInput(1));
    const again = await t.mutation(internal.fulfilment.record, stripeInput(1, { sessionId: 'cs_test_1_again' }));
    const inApp = await t.mutation(internal.fulfilment.record, storekitInput(1, 'txn_owner'));
    expect(again.grants).toEqual([{ slug: 'lit', outcome: 'owned', editionNumber: 1 }]);
    expect(inApp.grants).toEqual([{ slug: 'lit', outcome: 'owned', editionNumber: 1 }]);
    expect(again.grantedSlugs).toEqual(['lit']);
    expect(await litRows(t, litId)).toHaveLength(1);
    // Every payment is kept against the one licence, so a refund of either can be traced (PAY-3).
    const refs = await t.run((ctx) => ctx.db.query('entitlementRefs').collect());
    expect(refs.map((ref) => `${ref.source}:${ref.sourceRef}:${ref.status}`).sort()).toEqual([
      'storekit:txn_owner:active',
      'stripe:cs_test_1:active',
      'stripe:cs_test_1_again:active',
    ]);
    expect((await counter(t, litId))?.nextEdition).toBe(2);
    await t.mutation(internal.fulfilment.record, stripeInput(2));
    expect((await litRows(t, litId)).map((row) => row.editionNumber).sort()).toEqual([1, 2]);
  });

  test('a paid grant before dropAt is still granted, as an unnumbered presale that consumes no edition', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t, { dropAt: Date.now() + HOUR });
    const paid = await t.mutation(internal.fulfilment.record, stripeInput(1));
    const inApp = await t.mutation(internal.fulfilment.record, storekitInput(2, 'txn_early'));
    expect(paid.grantedSlugs).toEqual(['lit']);
    expect(paid.grants).toEqual([{ slug: 'lit', outcome: 'early_paid', editionNumber: null }]);
    expect(inApp.grants).toEqual([{ slug: 'lit', outcome: 'early_paid', editionNumber: null }]);
    const rows = await litRows(t, litId);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({ presale: true, status: 'active' });
      expect(row.editionNumber).toBeUndefined();
      expect(row.wearSeed).toMatch(/^[0-9a-f]{32}$/);
    }
    expect(await counter(t, litId)).toBeNull();
    expect(await t.withIdentity({ subject: buyer(1).clerkId }).query(api.entitlements.mine, {})).toEqual(['lit']);
  });

  test("a product marked 'scheduled' with no dropAt yet also sells as an unnumbered presale", async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    await t.run((ctx) => ctx.db.patch(litId, { status: 'scheduled' }));
    const paid = await t.mutation(internal.fulfilment.record, stripeInput(1));
    expect(paid.grants).toEqual([{ slug: 'lit', outcome: 'early_paid', editionNumber: null }]);
    // Once live (status or a past dropAt), editions start at 1 with the first paid grant.
    await t.run((ctx) => ctx.db.patch(litId, { status: 'live' }));
    const live = await t.mutation(internal.fulfilment.record, stripeInput(2));
    expect(live.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 1 }]);
  });

  test('an unpaid (NFC or admin) grant before dropAt is refused', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t, { dropAt: Date.now() + HOUR });
    for (const source of ['nfc', 'admin'] as const) {
      const result = await t.mutation(internal.fulfilment.record, {
        source,
        sourceRef: `${source}_1`,
        ...buyer(1),
        amountTotal: 0,
        currency: 'usd',
        lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 0, productId: litId }],
      });
      expect(result.grantedSlugs).toEqual([]);
      expect(result.grants).toEqual([{ slug: 'lit', outcome: 'early', editionNumber: null }]);
    }
    expect(await litRows(t, litId)).toHaveLength(0);
  });

  test('presale rows never hold back numbering once the drop has passed', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t, { dropAt: Date.now() + HOUR });
    await t.mutation(internal.fulfilment.record, stripeInput(1));
    await t.run((ctx) => ctx.db.patch(litId, { dropAt: Date.now() - HOUR }));
    const atDrop = await t.mutation(internal.fulfilment.record, stripeInput(2));
    expect(atDrop.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 1 }]);
  });

  test('a grant after dropAt goes through', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t, { dropAt: Date.now() - HOUR });
    const result = await t.mutation(internal.fulfilment.record, stripeInput(1));
    expect(result.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 1 }]);
    expect(await litRows(t, litId)).toHaveLength(1);
  });
});

describe('fulfilment.revokeEntitlement (ENT-4)', () => {
  test('revoking retires the edition: never reused, number and seed unchanged', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    await t.mutation(internal.fulfilment.record, stripeInput(1));
    await t.mutation(internal.fulfilment.record, stripeInput(2));
    const [before] = (await litRows(t, litId)).filter((row) => row.sourceRef === 'cs_test_1');

    const revoked = await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_1' });
    expect(revoked).toMatchObject({ matched: 1, refsChanged: 1, alreadyRevoked: 0, entitlementsRevoked: 1 });
    const after = (await t.run((ctx) => ctx.db.get(before._id)))!;
    expect(after.status).toBe('revoked');
    expect(after.revokedAt).toBeTypeOf('number');
    expect(after.editionNumber).toBe(before.editionNumber);
    expect(after.wearSeed).toBe(before.wearSeed);

    await t.mutation(internal.fulfilment.record, stripeInput(3));
    // Replaying the refunded session does not bring it back.
    const replay = await t.mutation(internal.fulfilment.record, stripeInput(1));
    expect(replay.grantedSlugs).toEqual([]);
    expect(replay.grants).toEqual([{ slug: 'lit', outcome: 'revoked', editionNumber: 1 }]);
    // Buying again after a refund is a new purchase with a new edition.
    const rebuy = await t.mutation(internal.fulfilment.record, stripeInput(1, { sessionId: 'cs_test_1_rebuy' }));
    expect(rebuy.grants).toEqual([{ slug: 'lit', outcome: 'created', editionNumber: 4 }]);

    const editions = (await litRows(t, litId)).map((row) => [row.editionNumber, row.status]);
    expect(editions.sort()).toEqual([
      [1, 'revoked'],
      [2, 'active'],
      [3, 'active'],
      [4, 'active'],
    ]);
    expect((await counter(t, litId))?.nextEdition).toBe(5);
  });

  test('is idempotent and reports an unknown reference as no match', async () => {
    const t = newTest();
    await seedProducts(t);
    await t.mutation(internal.fulfilment.record, storekitInput(1, 'txn_1'));
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'storekit', sourceRef: 'txn_1' });
    const again = await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'storekit', sourceRef: 'txn_1' });
    expect(again).toMatchObject({ matched: 1, refsChanged: 0, alreadyRevoked: 1, entitlementsRevoked: 0 });
    const unknown = await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_nope' });
    expect(unknown).toMatchObject({ matched: 0, refsChanged: 0, alreadyRevoked: 0, entitlementsRevoked: 0 });
  });

  test('a session that bought two releases revokes both, or only the one named', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const both = {
      lineItems: [
        { description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' },
        { description: 'THE SOURCE', quantity: 1, unitAmount: 900, stripeProductId: 'prod_source' },
      ],
    };
    await t.mutation(internal.fulfilment.record, stripeInput(1, both));
    await t.mutation(internal.fulfilment.record, stripeInput(2, both));
    const one = await t.mutation(internal.fulfilment.revokeEntitlement, {
      source: 'stripe',
      sourceRef: 'cs_test_1',
      productId: litId,
    });
    expect(one.entitlementsRevoked).toBe(1);
    const all = await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_2' });
    expect(all.entitlementsRevoked).toBe(2);
    expect(await t.withIdentity({ subject: buyer(1).clerkId }).query(api.entitlements.mine, {})).toEqual(['the-source']);
    expect(await t.withIdentity({ subject: buyer(2).clerkId }).query(api.entitlements.mine, {})).toEqual([]);
  });
});

describe('several payments behind one licence (ENT-5, PAY-3)', () => {
  test('pay twice, refund the first: still owned; refund both: revoked; replays change nothing', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    await t.mutation(internal.fulfilment.record, stripeInput(1));
    await t.mutation(internal.fulfilment.record, stripeInput(1, { sessionId: 'cs_test_1_second' }));
    const owner = t.withIdentity({ subject: buyer(1).clerkId });

    const first = await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_1' });
    expect(first).toMatchObject({ refsChanged: 1, entitlementsRevoked: 0 });
    expect(await owner.query(api.entitlements.mine, {})).toEqual(['lit']);

    const [before] = await litRows(t, litId);
    await t.mutation(internal.fulfilment.record, stripeInput(1)); // replay of the refunded payment
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_1' });
    expect(await litRows(t, litId)).toEqual([before]);

    const second = await t.mutation(internal.fulfilment.revokeEntitlement, {
      source: 'stripe',
      sourceRef: 'cs_test_1_second',
    });
    expect(second).toMatchObject({ refsChanged: 1, entitlementsRevoked: 1 });
    expect(await owner.query(api.entitlements.mine, {})).toEqual([]);
    const [after] = await litRows(t, litId);
    expect(after).toMatchObject({ status: 'revoked', editionNumber: 1, wearSeed: before.wearSeed });
    const replay = await t.mutation(internal.fulfilment.record, stripeInput(1, { sessionId: 'cs_test_1_second' }));
    expect(replay.grants).toEqual([{ slug: 'lit', outcome: 'revoked', editionNumber: 1 }]);
    expect(await litRows(t, litId)).toHaveLength(1);
  });

  test('a licence from before payment refs still keeps a second payment when the first is refunded', async () => {
    const t = newTest();
    await seedLitWithOwner(t); // a legacy row: session cs_test_owner, no ref row, no status
    await t.mutation(internal.fulfilment.record, {
      sessionId: 'cs_test_owner_again',
      clerkId: OWNER.subject,
      email: OWNER.email,
      amountTotal: 500,
      currency: 'usd',
      lineItems: [{ description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' }],
    });
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_owner_again' });
    expect(await t.withIdentity(OWNER).query(api.entitlements.mine, {})).toEqual(['lit']);
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_owner' });
    expect(await t.withIdentity(OWNER).query(api.entitlements.mine, {})).toEqual([]);
  });

  test('a dispute revokes, winning it reinstates; a refund during the dispute is final', async () => {
    const t = newTest();
    await seedProducts(t);
    await t.mutation(internal.fulfilment.record, stripeInput(1));
    await t.mutation(internal.fulfilment.record, stripeInput(2));
    const one = t.withIdentity({ subject: buyer(1).clerkId });
    const two = t.withIdentity({ subject: buyer(2).clerkId });

    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_1', reason: 'disputed' });
    expect(await one.query(api.entitlements.mine, {})).toEqual([]);
    const won = await t.mutation(internal.fulfilment.reinstateEntitlement, { source: 'stripe', sourceRef: 'cs_test_1' });
    expect(won).toMatchObject({ refsReinstated: 1, entitlementsReinstated: 1 });
    expect(await one.query(api.entitlements.mine, {})).toEqual(['lit']);

    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_2', reason: 'disputed' });
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_2' });
    const late = await t.mutation(internal.fulfilment.reinstateEntitlement, { source: 'stripe', sourceRef: 'cs_test_2' });
    expect(late).toMatchObject({ refsReinstated: 0, entitlementsReinstated: 0 });
    expect(await two.query(api.entitlements.mine, {})).toEqual([]);
  });

  test('a Stripe event id is applied once', async () => {
    const t = newTest();
    await seedProducts(t);
    await t.mutation(internal.fulfilment.record, stripeInput(1));
    const args = { source: 'stripe' as const, sourceRef: 'cs_test_1', eventId: 'evt_refund', eventType: 'charge.refunded' };
    expect(await t.mutation(internal.fulfilment.revokeEntitlement, args)).toMatchObject({ alreadyProcessed: false });
    expect(await t.mutation(internal.fulfilment.revokeEntitlement, args)).toMatchObject({ alreadyProcessed: true });
    expect(await t.query(internal.fulfilment.eventSeen, { eventId: 'evt_refund' })).toBe(true);
  });
});

describe('ownership readers treat revoked as not owned', () => {
  test('a pre-migration row with no status still counts as owned', async () => {
    const t = newTest();
    await seedLitWithOwner(t);
    const owner = t.withIdentity(OWNER);
    expect(await owner.query(api.entitlements.mine, {})).toEqual(['lit']);
    expect((await owner.query(api.products.owned, {})).map((row) => row.slug)).toEqual(['lit']);
    const tracks = await owner.action(api.tracks.listForPlayer, { product: 'lit' });
    expect(tracks.tracks).toHaveLength(6);
  });

  test('after a refund: no tracks, no download, no play logging, gone from the dashboard', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t);
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_owner' });
    const owner = t.withIdentity(OWNER);
    expect(await owner.query(api.entitlements.mine, {})).toEqual([]);
    expect(await owner.query(api.products.owned, {})).toEqual([]);
    await expect(owner.action(api.tracks.listForPlayer, { product: 'lit' })).rejects.toThrow(/NOT_ENTITLED/);
    await expect(owner.action(api.downloads.mine, { product: 'lit' })).rejects.toThrow(/NOT_ENTITLED/);
    await expect(owner.mutation(api.plays.log, { trackId: trackIds[0] })).rejects.toThrow(/NOT_ENTITLED/);
    // The stranger was never an owner and still is not.
    expect(await t.withIdentity(STRANGER).query(api.entitlements.mine, {})).toEqual([]);
  });
});

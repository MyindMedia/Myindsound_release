import { describe, expect, test } from 'vitest';
import { api, internal } from './_generated/api';
import { newTest } from './test.setup';

async function seedProducts(t: ReturnType<typeof newTest>) {
  await t.run(async (ctx) => {
    await ctx.db.insert('products', {
      slug: 'lit',
      name: 'LIT',
      kind: 'digital',
      stripeProductIds: ['prod_lit'],
      downloadKey: 'lit/download/x.zip',
      active: true,
    });
    await ctx.db.insert('products', {
      slug: 'the-source',
      name: 'THE SOURCE',
      kind: 'digital',
      stripeProductIds: ['prod_source'],
      active: true,
    });
  });
}

const buyer = { clerkId: 'user_buyer', email: 'buyer@example.test', name: 'Buyer Person' };

function digitalInput(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: 'cs_test_1',
    ...buyer,
    amountTotal: 1400,
    currency: 'usd',
    lineItems: [
      { description: 'LIT', quantity: 1, unitAmount: 500, stripeProductId: 'prod_lit' },
      { description: 'THE SOURCE', quantity: 1, unitAmount: 900, stripeProductId: 'prod_source' },
    ],
    ...overrides,
  };
}

describe('fulfilment.record', () => {
  test('grants every matched digital product once, even when replayed', async () => {
    const t = newTest();
    await seedProducts(t);
    const first = await t.mutation(internal.fulfilment.record, digitalInput());
    const second = await t.mutation(internal.fulfilment.record, digitalInput());
    expect(first.grantedSlugs.sort()).toEqual(['lit', 'the-source']);
    expect(second.alreadyProcessed).toBe(false);
    const entitlements = await t.run((ctx) => ctx.db.query('entitlements').collect());
    expect(entitlements).toHaveLength(2);
    const buyerView = await t.withIdentity({ subject: buyer.clerkId }).query(api.entitlements.mine, {});
    expect(buyerView.sort()).toEqual(['lit', 'the-source']);
  });

  test('a repeated Stripe event id is ignored', async () => {
    const t = newTest();
    await seedProducts(t);
    await t.mutation(internal.fulfilment.record, digitalInput({ eventId: 'evt_1', eventType: 'checkout.session.completed' }));
    const replay = await t.mutation(
      internal.fulfilment.record,
      digitalInput({ eventId: 'evt_1', eventType: 'checkout.session.completed' }),
    );
    expect(replay.alreadyProcessed).toBe(true);
    expect(await t.query(internal.fulfilment.eventSeen, { eventId: 'evt_1' })).toBe(true);
  });

  test('unmatched products are counted, not thrown', async () => {
    const t = newTest();
    await seedProducts(t);
    const result = await t.mutation(
      internal.fulfilment.record,
      digitalInput({ lineItems: [{ description: 'Mystery', quantity: 1, unitAmount: 100, stripeProductId: 'prod_other' }] }),
    );
    expect(result.unmatched).toBe(1);
    expect(result.grantedSlugs).toEqual([]);
  });

  test('physical orders are written once with items and shipping', async () => {
    const t = newTest();
    await seedProducts(t);
    const input = digitalInput({
      sessionId: 'cs_test_physical',
      orderType: 'physical',
      shipping: { name: 'Buyer Person', line1: '1 Main St', city: 'LA', postalCode: '90001', country: 'US' },
      lineItems: [{ description: 'Hoodie', quantity: 2, unitAmount: 4500 }],
    });
    const first = await t.mutation(internal.fulfilment.record, input);
    await t.mutation(internal.fulfilment.record, input);
    const orders = await t.run((ctx) => ctx.db.query('orders').collect());
    const items = await t.run((ctx) => ctx.db.query('orderItems').collect());
    expect(orders).toHaveLength(1);
    expect(orders[0]._id).toBe(first.orderId);
    expect(items).toHaveLength(1);
    expect(await t.query(internal.fulfilment.sessionState, { sessionId: 'cs_test_physical' })).toEqual({ fulfilled: true });
  });

  test('marketing consent from checkout metadata is stored once', async () => {
    const t = newTest();
    await seedProducts(t);
    await t.mutation(internal.fulfilment.record, digitalInput({ marketingConsent: true }));
    const [user] = await t.run((ctx) => ctx.db.query('users').collect());
    expect(user.marketingConsentAt).toBeTypeOf('number');
  });

  test('productsByStripeIds maps Stripe ids to products', async () => {
    const t = newTest();
    await seedProducts(t);
    const rows = await t.query(internal.fulfilment.productsByStripeIds, { stripeProductIds: ['prod_lit', 'nope'] });
    expect(rows.map((row) => row.slug)).toEqual(['lit']);
  });
});

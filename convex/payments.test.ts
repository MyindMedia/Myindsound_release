import Stripe from 'stripe';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { newTest } from './test.setup';

/**
 * Stripe and Clerk are mocked at `fetch`, so the real SDK code (request building, pagination, webhook
 * signature verification) runs. Webhooks are signed with the test secret exactly as Stripe signs them.
 */

type T = ReturnType<typeof newTest>;

const WEBHOOK_SECRET = 'whsec_test_secret';
const HOUR = 60 * 60 * 1000;

type FakeSession = {
  id: string;
  email: string;
  paymentIntent: string;
  products: { id: string; description: string; amount: number }[];
};

type FakeClerkUser = { id: string; lastSignInAt: number | null; createdByCheckout?: string };

type Fake = {
  sessions: Map<string, FakeSession>;
  clerk: Map<string, FakeClerkUser>; // email -> account
  refunded: Set<string>; // payment intents whose charge is fully refunded
  created: string[]; // emails Clerk accounts were created for
  tickets: string[]; // Clerk ids tickets were minted for
  checkoutCreates: number;
};

let fake: Fake;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sessionObject(session: FakeSession) {
  return {
    id: session.id,
    object: 'checkout.session',
    status: 'complete',
    payment_status: 'paid',
    payment_intent: session.paymentIntent,
    created: Math.floor(Date.now() / 1000),
    amount_total: session.products.reduce((sum, p) => sum + p.amount, 0),
    currency: 'usd',
    customer_details: { email: session.email, name: 'Test Buyer' },
    metadata: { marketing_consent: 'false' },
  };
}

function clerkJson(user: FakeClerkUser) {
  return {
    id: user.id,
    last_sign_in_at: user.lastSignInAt,
    private_metadata: user.createdByCheckout ? { createdByCheckout: user.createdByCheckout } : {},
  };
}

function clerkUserById(id: string) {
  return [...fake.clerk.values()].find((user) => user.id === id);
}

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  if (url.host === 'api.stripe.com') {
    if (method === 'POST' && path === '/v1/checkout/sessions') {
      fake.checkoutCreates++;
      return json({ id: 'cs_created', object: 'checkout.session', url: 'https://checkout.stripe.test/cs_created' });
    }
    if (method === 'GET' && path === '/v1/checkout/sessions') {
      const intent = url.searchParams.get('payment_intent');
      const data = [...fake.sessions.values()]
        .filter((s) => intent === null || s.paymentIntent === intent)
        .map(sessionObject);
      return json({ object: 'list', data, has_more: false, url: path });
    }
    const lineItems = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/);
    if (lineItems) {
      const session = fake.sessions.get(lineItems[1])!;
      const data = session.products.map((p, i) => ({
        id: `li_${i}`,
        object: 'item',
        description: p.description,
        quantity: 1,
        price: { id: `price_${i}`, object: 'price', unit_amount: p.amount, product: p.id },
      }));
      return json({ object: 'list', data, has_more: false, url: path });
    }
    const retrieve = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (retrieve && fake.sessions.has(retrieve[1])) return json(sessionObject(fake.sessions.get(retrieve[1])!));
    const intent = path.match(/^\/v1\/payment_intents\/([^/]+)$/);
    if (intent) {
      const refunded = fake.refunded.has(intent[1]);
      return json({
        id: intent[1],
        object: 'payment_intent',
        latest_charge: { id: `ch_${intent[1]}`, object: 'charge', refunded, amount_refunded: refunded ? 500 : 0 },
      });
    }
  }

  if (url.host === 'api.clerk.com') {
    if (method === 'GET' && path === '/v1/users') {
      const user = fake.clerk.get(url.searchParams.get('email_address') ?? '');
      return json(user ? [clerkJson(user)] : []);
    }
    const byId = path.match(/^\/v1\/users\/([^/]+)$/);
    if (method === 'GET' && byId) {
      const user = clerkUserById(decodeURIComponent(byId[1]));
      return user ? json(clerkJson(user)) : json({}, 404);
    }
    if (method === 'POST' && path === '/v1/users') {
      const body = JSON.parse(String(init?.body)) as {
        email_address: string[];
        private_metadata?: { createdByCheckout?: string };
      };
      const user = {
        id: `user_created_${fake.created.length + 1}`,
        lastSignInAt: null,
        createdByCheckout: body.private_metadata?.createdByCheckout,
      };
      fake.clerk.set(body.email_address[0], user);
      fake.created.push(body.email_address[0]);
      return json(clerkJson(user));
    }
    if (method === 'POST' && path === '/v1/sign_in_tokens') {
      const body = JSON.parse(String(init?.body)) as { user_id: string };
      fake.tickets.push(body.user_id);
      return json({ token: `ticket_for_${body.user_id}` });
    }
  }
  return json({ error: { message: `unmocked ${method} ${url.href}` } }, 404);
}

beforeEach(() => {
  fake = { sessions: new Map(), clerk: new Map(), refunded: new Set(), created: [], tickets: [], checkoutCreates: 0 };
  vi.stubGlobal('fetch', vi.fn(route));
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
  vi.stubEnv('STRIPE_WEBHOOK_SECRET', WEBHOOK_SECRET);
  vi.stubEnv('STRIPE_PRODUCT_ID_LIT', 'prod_lit');
  vi.stubEnv('STRIPE_PRODUCT_ID_SOURCE', 'prod_source');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_clerk_fake');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

type ProductOptions = { dropAt?: number; presaleAllowed?: boolean; status?: 'draft' | 'scheduled' | 'live' };

async function seedProducts(t: T, options: { lit?: ProductOptions; source?: ProductOptions } = {}) {
  return await t.run(async (ctx) => {
    const litId = await ctx.db.insert('products', {
      slug: 'lit',
      name: 'LIT',
      kind: 'digital',
      stripeProductIds: ['prod_lit'],
      active: true,
      ...options.lit,
    });
    const sourceId = await ctx.db.insert('products', {
      slug: 'the-source',
      name: 'THE SOURCE',
      kind: 'digital',
      stripeProductIds: ['prod_source'],
      active: true,
      ...options.source,
    });
    return { litId, sourceId };
  });
}

const LIT = { id: 'prod_lit', description: 'LIT', amount: 500 };
const SOURCE = { id: 'prod_source', description: 'THE SOURCE', amount: 900 };

function addSession(n: number | string, products = [LIT], email = `buyer${n}@example.test`): FakeSession {
  const session = { id: `cs_test_${n}`, email, paymentIntent: `pi_${n}`, products };
  fake.sessions.set(session.id, session);
  return session;
}

let eventCounter = 0;

async function deliver(t: T, type: string, object: Record<string, unknown>, id = `evt_${++eventCounter}`) {
  const payload = JSON.stringify({ id, object: 'event', type, data: { object } });
  const signer = new Stripe('sk_test_fake', { httpClient: Stripe.createFetchHttpClient() });
  const signature = await signer.webhooks.generateTestHeaderStringAsync({
    payload,
    secret: WEBHOOK_SECRET,
    cryptoProvider: Stripe.createSubtleCryptoProvider(),
  });
  return await t.action(internal.payments.handleWebhook, { payload, signature });
}

function completed(t: T, session: FakeSession, id?: string) {
  return deliver(t, 'checkout.session.completed', sessionObject(session), id);
}

function logLines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((call) => call.join(' '));
}

function logged(spy: { mock: { calls: unknown[][] } }, ending: string): boolean {
  return logLines(spy).some((line) => line.endsWith(ending));
}

async function mine(t: T, clerkId: string) {
  return await t.withIdentity({ subject: clerkId }).query(api.entitlements.mine, {});
}

async function rowsFor(t: T, productId: Id<'products'>) {
  return (await t.run((ctx) => ctx.db.query('entitlements').collect())).filter((row) => row.productId === productId);
}

function claim(t: T, session: FakeSession) {
  return t.action(api.payments.claimAccountForCheckoutSession, { sessionId: session.id });
}

describe('payments.handleWebhook: fulfilment', () => {
  test('a normal LIT purchase is granted as before, now with edition 1', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const log = vi.spyOn(console, 'log');
    const session = addSession(1);
    expect(await completed(t, session)).toEqual({ status: 200 });
    expect(logged(log, `${session.id} -> granted`)).toBe(true);
    expect(fake.created).toHaveLength(1);
    expect(await mine(t, 'user_created_1')).toEqual(['lit']);
    const [row] = await rowsFor(t, litId);
    expect(row).toMatchObject({ editionNumber: 1, source: 'stripe', sourceRef: session.id, status: 'active' });
  });

  test('a two-product session where one product is early grants both and logs early_paid', async () => {
    const t = newTest();
    const { sourceId } = await seedProducts(t, { source: { dropAt: Date.now() + HOUR } });
    const log = vi.spyOn(console, 'log');
    const session = addSession(1, [LIT, SOURCE]);
    expect(await completed(t, session)).toEqual({ status: 200 });
    expect(logged(log, `${session.id} -> early_paid`)).toBe(true);
    expect((await mine(t, 'user_created_1')).sort()).toEqual(['lit', 'the-source']);
    const [presale] = await rowsFor(t, sourceId);
    expect(presale).toMatchObject({ presale: true, status: 'active' });
    expect(presale.editionNumber).toBeUndefined();
  });

  test('a session already bound to an account stays with it, even when the email now finds nobody', async () => {
    const t = newTest();
    await seedProducts(t);
    const session = addSession(1);
    await completed(t, session);
    fake.clerk.clear(); // the buyer changed their email in Clerk
    const log = vi.spyOn(console, 'log');
    await completed(t, session); // a redelivery under a new event id
    expect(fake.created).toHaveLength(1); // no second, empty account
    expect(logged(log, `${session.id} -> granted`)).toBe(true);
  });
});

describe('payments.claimAccountForCheckoutSession: tickets only for the account this checkout made', () => {
  test("paying with someone else's email never signs the payer into their account", async () => {
    const t = newTest();
    await seedProducts(t);
    fake.clerk.set('admin@example.test', { id: 'user_admin', lastSignInAt: Date.now() - HOUR });
    const attack = addSession('attack', [LIT], 'admin@example.test');
    const result = await claim(t, attack);
    expect(result).toEqual({ ticket: null, email: 'admin@example.test' });
    expect(fake.tickets).toEqual([]);
    // The victim still gets what was paid for; only the sign-in is withheld.
    expect(await mine(t, 'user_admin')).toEqual(['lit']);
  });

  test('a new buyer gets a ticket for the account their checkout created', async () => {
    const t = newTest();
    await seedProducts(t);
    const session = addSession(1);
    expect(await claim(t, session)).toEqual({ ticket: 'ticket_for_user_created_1', email: session.email });
    expect(await mine(t, 'user_created_1')).toEqual(['lit']);
  });

  test('the holder account (made by this checkout, never signed in) gets the ticket, not the account the email finds now', async () => {
    const t = newTest();
    await seedProducts(t);
    const session = addSession(1);
    await completed(t, session); // creates user_created_1, never signed in
    // The holder changed their email; the checkout email now finds a different account.
    fake.clerk.set('changed@example.test', fake.clerk.get(session.email)!);
    fake.clerk.set(session.email, { id: 'user_someone_else', lastSignInAt: null, createdByCheckout: session.id });
    expect(await claim(t, session)).toMatchObject({ ticket: 'ticket_for_user_created_1' });
    expect(fake.tickets).toEqual(['user_created_1']);
  });

  test('a holder account made by a different checkout gets no ticket', async () => {
    const t = newTest();
    await seedProducts(t);
    const first = addSession(1);
    await completed(t, first); // user_created_1, stamped with cs_test_1
    const second = addSession(2, [SOURCE], first.email); // same buyer, second checkout, bound to the same account
    await completed(t, second);
    expect(await claim(t, second)).toEqual({ ticket: null, email: first.email });
    expect(fake.tickets).toEqual([]);
  });

  test('a holder account that has been signed in to gets no ticket', async () => {
    const t = newTest();
    await seedProducts(t);
    const session = addSession(1);
    await completed(t, session);
    fake.clerk.get(session.email)!.lastSignInAt = Date.now();
    expect(await claim(t, session)).toEqual({ ticket: null, email: session.email });
    expect(fake.tickets).toEqual([]);
  });

  test('a session whose account was deleted recreates neither the Clerk account nor the profile', async () => {
    const t = newTest();
    await seedProducts(t);
    const session = addSession(1);
    await completed(t, session);
    const [user] = await t.run((ctx) => ctx.db.query('users').collect());
    await t.mutation(internal.privacy.wipeUserData, { userId: user._id });
    fake.clerk.clear(); // deleteMyData removed the Clerk account too

    expect(await claim(t, session)).toEqual({ ticket: null, email: session.email });
    await completed(t, session); // a late redelivery
    expect(fake.created).toHaveLength(1);
    expect(fake.tickets).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('users').collect())).toEqual([]);
  });
});

describe('payments.handleWebhook: refunds and disputes (PAY-3)', () => {
  test('a full refund revokes; a redelivery of the same event changes nothing', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const session = addSession(1);
    await completed(t, session);
    const log = vi.spyOn(console, 'log');
    const charge = { id: 'ch_1', object: 'charge', refunded: true, payment_intent: session.paymentIntent };
    expect(await deliver(t, 'charge.refunded', charge, 'evt_refund_1')).toEqual({ status: 200 });
    expect(logged(log, 'charge.refunded -> refund_revoked')).toBe(true);
    expect(await mine(t, 'user_created_1')).toEqual([]);
    const [before] = await rowsFor(t, litId);
    expect(before).toMatchObject({ status: 'revoked', editionNumber: 1 });

    expect(await deliver(t, 'charge.refunded', charge, 'evt_refund_1')).toEqual({ status: 200 });
    expect(await rowsFor(t, litId)).toEqual([before]);
  });

  test('a refund delivered before the checkout completes leaves a tombstone, so the licence is never granted', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const session = addSession(1);
    const log = vi.spyOn(console, 'log');
    // The charge state is left unrefunded here, so only the tombstone can stop the grant.
    await deliver(t, 'charge.refunded', { id: 'ch_1', object: 'charge', refunded: true, payment_intent: session.paymentIntent });
    expect(logged(log, 'charge.refunded -> revoked_before_fulfilment')).toBe(true);
    await completed(t, session);
    expect(logged(log, `${session.id} -> revoked`)).toBe(true);
    expect(await rowsFor(t, litId)).toEqual([]);
    expect(await mine(t, 'user_created_1')).toEqual([]);
  });

  test('fulfilment checks the charge: a refunded payment is never granted, even with no refund event', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const session = addSession(1);
    fake.refunded.add(session.paymentIntent);
    const log = vi.spyOn(console, 'log');
    await completed(t, session);
    expect(logged(log, `${session.id} -> revoked`)).toBe(true);
    expect(await rowsFor(t, litId)).toEqual([]);
    expect(fake.created).toEqual([]); // no account made for a refunded payment
    expect(await claim(t, session)).toEqual({ ticket: null, email: session.email });
  });

  test('a partial refund is logged and leaves the licence', async () => {
    const t = newTest();
    await seedProducts(t);
    const session = addSession(1);
    await completed(t, session);
    const log = vi.spyOn(console, 'log');
    await deliver(t, 'charge.refunded', { id: 'ch_1', object: 'charge', refunded: false, payment_intent: session.paymentIntent });
    expect(logged(log, 'charge.refunded -> partial_refund')).toBe(true);
    expect(await mine(t, 'user_created_1')).toEqual(['lit']);
  });

  test('a dispute revokes and a won dispute reinstates', async () => {
    const t = newTest();
    await seedProducts(t);
    const session = addSession(1);
    await completed(t, session);
    const dispute = { id: 'dp_1', object: 'dispute', payment_intent: session.paymentIntent, status: 'needs_response' };
    await deliver(t, 'charge.dispute.created', dispute);
    expect(await mine(t, 'user_created_1')).toEqual([]);
    await deliver(t, 'charge.dispute.closed', { ...dispute, status: 'won' });
    expect(await mine(t, 'user_created_1')).toEqual(['lit']);
  });

  test('an inquiry is not a chargeback: nothing is revoked; warning_closed reinstates a revoked licence', async () => {
    const t = newTest();
    await seedProducts(t);
    const session = addSession(1);
    await completed(t, session);
    const log = vi.spyOn(console, 'log');
    for (const status of ['warning_needs_response', 'warning_under_review']) {
      await deliver(t, 'charge.dispute.created', { id: 'dp_i', object: 'dispute', payment_intent: session.paymentIntent, status });
    }
    expect(logLines(log).filter((line) => line.endsWith('-> dispute_inquiry'))).toHaveLength(2);
    expect(await mine(t, 'user_created_1')).toEqual(['lit']);

    const dispute = { id: 'dp_2', object: 'dispute', payment_intent: session.paymentIntent, status: 'needs_response' };
    await deliver(t, 'charge.dispute.created', dispute);
    expect(await mine(t, 'user_created_1')).toEqual([]);
    await deliver(t, 'charge.dispute.closed', { ...dispute, status: 'warning_closed' });
    expect(await mine(t, 'user_created_1')).toEqual(['lit']);
  });

  test('a refund of a payment that did not come through Checkout is a no-op', async () => {
    const t = newTest();
    await seedProducts(t);
    const log = vi.spyOn(console, 'log');
    await deliver(t, 'charge.refunded', { id: 'ch_x', object: 'charge', refunded: true, payment_intent: 'pi_unknown' });
    expect(logged(log, 'charge.refunded -> no_session')).toBe(true);
  });
});

describe('payments.rebuildFromStripe', () => {
  test('never grants a refunded session, in a dry run or for real', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const session = addSession(1);
    fake.refunded.add(session.paymentIntent);
    expect(await t.action(internal.payments.rebuildFromStripe, { dryRun: true })).toMatchObject({ revoked: 1, granted: 0 });
    expect(await t.action(internal.payments.rebuildFromStripe, { dryRun: false })).toMatchObject({ revoked: 1, granted: 0 });
    expect(await rowsFor(t, litId)).toEqual([]);
  });

  test('never recreates an account for a buyer with no Clerk account (a deleted account), unless told to', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    // Before this deploy, deleting an account deleted its licence, so its paid session looks never fulfilled.
    addSession('gone', [LIT], 'deleted@example.test');

    expect(await t.action(internal.payments.rebuildFromStripe, { dryRun: true })).toMatchObject({
      no_account: 1,
      granted: 0,
    });
    expect(await t.action(internal.payments.rebuildFromStripe, { dryRun: false })).toMatchObject({
      no_account: 1,
      granted: 0,
    });
    expect(fake.created).toEqual([]);
    expect(await rowsFor(t, litId)).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('users').collect())).toEqual([]);

    // A session the operator has confirmed was simply never fulfilled.
    expect(
      await t.action(internal.payments.rebuildFromStripe, { dryRun: false, createAccounts: true }),
    ).toMatchObject({ no_account: 0, granted: 1 });
    expect(fake.created).toEqual(['deleted@example.test']);
    expect(await rowsFor(t, litId)).toHaveLength(1);
  });

  test('the webhook and the claim link still create the account for a new buyer', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    const session = addSession('new');
    expect((await completed(t, session)).status).toBe(200);
    expect(fake.created).toEqual([session.email]);
    expect(await rowsFor(t, litId)).toHaveLength(1);
  });

  test('a legacy double payer: the second payment becomes a ref, so refunding the first keeps the licence', async () => {
    const t = newTest();
    const { litId } = await seedProducts(t);
    // Before refs: s1 made the licence; s2 (same email) was paid but left no trace.
    const s1 = addSession('s1', [LIT], 'double@example.test');
    const s2 = addSession('s2', [LIT], 'double@example.test');
    fake.clerk.set('double@example.test', { id: 'user_double', lastSignInAt: Date.now() });
    await t.run(async (ctx) => {
      const userId = await ctx.db.insert('users', { clerkId: 'user_double', email: 'double@example.test', isAdmin: false });
      await ctx.db.insert('entitlements', { userId, productId: litId, stripeSessionId: s1.id, grantedAt: Date.now() });
    });

    const rebuilt = await t.action(internal.payments.rebuildFromStripe, { dryRun: false });
    expect(rebuilt).toMatchObject({ already: 1, granted: 1 });
    expect(await rowsFor(t, litId)).toHaveLength(1);

    await deliver(t, 'charge.refunded', { id: 'ch_s1', object: 'charge', refunded: true, payment_intent: s1.paymentIntent });
    expect(await mine(t, 'user_double')).toEqual(['lit']);
    await deliver(t, 'charge.refunded', { id: 'ch_s2', object: 'charge', refunded: true, payment_intent: s2.paymentIntent });
    expect(await mine(t, 'user_double')).toEqual([]);
  });
});

describe('payments.createDigitalSession: guards before money moves', () => {
  const args = { amountCents: 500, withUpsell: false, email: 'buyer1@example.test', marketingConsent: false };

  test('THE SOURCE before its drop sells through the upsell as a presale, unnumbered', async () => {
    const t = newTest();
    const { sourceId } = await seedProducts(t, { source: { dropAt: Date.now() + HOUR } });
    expect(await t.action(api.payments.createDigitalSession, { ...args, withUpsell: true })).toEqual({
      url: 'https://checkout.stripe.test/cs_created',
    });
    await completed(t, addSession(1, [LIT, SOURCE]));
    const [presale] = await rowsFor(t, sourceId);
    expect(presale).toMatchObject({ presale: true, status: 'active' });
    expect(presale.editionNumber).toBeUndefined();
  });

  test('only a product flagged presaleAllowed: false is refused before its drop, without calling Stripe', async () => {
    const t = newTest();
    await seedProducts(t, { source: { dropAt: Date.now() + HOUR, presaleAllowed: false } });
    await expect(t.action(api.payments.createDigitalSession, { ...args, withUpsell: true })).rejects.toThrow(
      /NOT_YET_LIVE/,
    );
    // No dropAt yet: `status: 'scheduled'` is what marks it as not out.
    const scheduled = newTest();
    await seedProducts(scheduled, { lit: { status: 'scheduled', presaleAllowed: false } });
    await expect(scheduled.action(api.payments.createDigitalSession, args)).rejects.toThrow(/NOT_YET_LIVE/);
    expect(fake.checkoutCreates).toBe(0);
    // Without the upsell, LIT alone still sells.
    expect(await t.action(api.payments.createDigitalSession, args)).toEqual({
      url: 'https://checkout.stripe.test/cs_created',
    });
  });

  test('a signed-in owner buying again with their own email is stopped; a guest typing that email is not told', async () => {
    const t = newTest();
    await seedProducts(t);
    await completed(t, addSession(1));
    const owner = t.withIdentity({ subject: 'user_created_1', email: 'Buyer1@Example.test' });
    await expect(owner.action(api.payments.createDigitalSession, args)).rejects.toThrow(/ALREADY_OWNED/);
    // Buying as a gift to another address is not blocked, and a guest learns nothing about the owner.
    expect(await owner.action(api.payments.createDigitalSession, { ...args, email: 'friend@example.test' })).toEqual({
      url: 'https://checkout.stripe.test/cs_created',
    });
    expect(await t.action(api.payments.createDigitalSession, args)).toEqual({
      url: 'https://checkout.stripe.test/cs_created',
    });
    // Owning LIT does not stop buying the upsell they do not own yet.
    expect(await owner.action(api.payments.createDigitalSession, { ...args, withUpsell: true })).toEqual({
      url: 'https://checkout.stripe.test/cs_created',
    });
  });
});

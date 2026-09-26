import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api } from './_generated/api';
import { newTest } from './test.setup';

/**
 * The post-purchase sign-in, end to end through the real action. Stripe and Clerk are mocked at `fetch`, so
 * the SDK and the Clerk helper code run as they do in production. The point of these tests is that paying
 * with someone else's email must never sign you into their account.
 */

type ClerkUser = { id: string; last_sign_in_at?: number | null; private_metadata?: { createdByCheckout?: string } };

type Fake = {
  sessions: Map<string, { email: string }>;
  clerk: Map<string, ClerkUser>; // email -> user
  extraMatches: Map<string, ClerkUser[]>; // email -> further users the lookup also returns
  tickets: string[]; // Clerk user ids a ticket was minted for
};

let fake: Fake;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function sessionObject(id: string, email: string) {
  return {
    id,
    object: 'checkout.session',
    status: 'complete',
    payment_status: 'paid',
    created: Math.floor(Date.now() / 1000),
    amount_total: 100,
    currency: 'usd',
    customer_details: { email, name: 'Test Buyer' },
    metadata: { marketing_consent: 'false' },
  };
}

async function route(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = url.pathname;

  if (url.host === 'api.stripe.com') {
    const lineItems = path.match(/^\/v1\/checkout\/sessions\/([^/]+)\/line_items$/);
    if (lineItems) {
      const data = [
        {
          id: 'li_0',
          object: 'item',
          description: 'LIT',
          quantity: 1,
          price: { id: 'price_0', object: 'price', unit_amount: 100, product: 'prod_lit' },
        },
      ];
      return json({ object: 'list', data, has_more: false, url: path });
    }
    const retrieve = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (retrieve && fake.sessions.has(retrieve[1])) {
      return json(sessionObject(retrieve[1], fake.sessions.get(retrieve[1])!.email));
    }
  }

  if (url.host === 'api.clerk.com') {
    if (method === 'GET' && path === '/v1/users') {
      const email = url.searchParams.get('email_address') ?? '';
      const user = fake.clerk.get(email);
      return json(user ? [user, ...(fake.extraMatches.get(email) ?? [])] : []);
    }
    if (method === 'POST' && path === '/v1/users') {
      const body = JSON.parse(String(init?.body)) as {
        email_address: string[];
        private_metadata?: { createdByCheckout?: string };
      };
      const user: ClerkUser = {
        id: `user_created_${fake.clerk.size + 1}`,
        last_sign_in_at: null,
        private_metadata: body.private_metadata,
      };
      fake.clerk.set(body.email_address[0], user);
      return json(user);
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
  fake = { sessions: new Map(), clerk: new Map(), extraMatches: new Map(), tickets: [] };
  vi.stubGlobal('fetch', vi.fn(route));
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
  vi.stubEnv('STRIPE_PRODUCT_ID_LIT', 'prod_lit');
  vi.stubEnv('CLERK_SECRET_KEY', 'sk_clerk_fake');
  vi.stubEnv('ADMIN_EMAILS', 'boss@example.test');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function setup() {
  const t = newTest();
  await t.run(async (ctx) => {
    await ctx.db.insert('products', {
      slug: 'lit',
      name: 'LIT',
      kind: 'digital',
      stripeProductIds: ['prod_lit'],
      active: true,
    });
  });
  return t;
}

async function claim(t: ReturnType<typeof newTest>, sessionId: string) {
  return await t.action(api.payments.claimAccountForCheckoutSession, { sessionId });
}

describe('claimAccountForCheckoutSession', () => {
  test('a first-time buyer is signed straight into the account their checkout made', async () => {
    const t = await setup();
    fake.sessions.set('cs_test_new', { email: 'new@example.test' });
    const result = await claim(t, 'cs_test_new');
    expect(result.ticket).toBe('ticket_for_user_created_1');
    expect(fake.clerk.get('new@example.test')?.private_metadata?.createdByCheckout).toBe('cs_test_new');
  });

  test('paying with the email of an existing, signed-in account mints no ticket', async () => {
    const t = await setup();
    fake.clerk.set('victim@example.test', { id: 'user_victim', last_sign_in_at: Date.now() - 3_600_000 });
    fake.sessions.set('cs_test_attack', { email: 'victim@example.test' });
    const result = await claim(t, 'cs_test_attack');
    expect(result.ticket).toBeNull();
    expect(fake.tickets).toEqual([]);
  });

  test('an account another checkout made, never signed into, cannot be claimed by a different checkout', async () => {
    const t = await setup();
    // The victim bought as a guest and never finished signing in.
    fake.clerk.set('victim@example.test', {
      id: 'user_victim',
      last_sign_in_at: null,
      private_metadata: { createdByCheckout: 'cs_test_victim' },
    });
    fake.sessions.set('cs_test_early', { email: 'victim@example.test' });
    const result = await claim(t, 'cs_test_early');
    expect(result.ticket).toBeNull();
    expect(fake.tickets).toEqual([]);
  });

  test('an older account with no checkout stamp is never claimable', async () => {
    const t = await setup();
    fake.clerk.set('legacy@example.test', { id: 'user_legacy', last_sign_in_at: null });
    fake.sessions.set('cs_test_legacy', { email: 'legacy@example.test' });
    expect((await claim(t, 'cs_test_legacy')).ticket).toBeNull();
    expect(fake.tickets).toEqual([]);
  });

  test('an admin address never gets a ticket, even when the checkout creates the account', async () => {
    const t = await setup();
    fake.sessions.set('cs_test_admin', { email: 'Boss@Example.test' });
    expect((await claim(t, 'cs_test_admin')).ticket).toBeNull();
    expect(fake.tickets).toEqual([]);
  });

  test('a lookup that matches two accounts mints no ticket, even if one looks fresh', async () => {
    const t = await setup();
    fake.clerk.set('twin@example.test', {
      id: 'user_fresh',
      last_sign_in_at: null,
      private_metadata: { createdByCheckout: 'cs_test_twin' },
    });
    fake.extraMatches.set('twin@example.test', [{ id: 'user_other', last_sign_in_at: Date.now() }]);
    fake.sessions.set('cs_test_twin', { email: 'twin@example.test' });
    expect((await claim(t, 'cs_test_twin')).ticket).toBeNull();
    expect(fake.tickets).toEqual([]);
  });

  test('an account whose sign-in time Clerk leaves out is treated as signed in', async () => {
    const t = await setup();
    fake.clerk.set('quiet@example.test', { id: 'user_quiet', private_metadata: { createdByCheckout: 'cs_test_quiet' } });
    fake.sessions.set('cs_test_quiet', { email: 'quiet@example.test' });
    expect((await claim(t, 'cs_test_quiet')).ticket).toBeNull();
    expect(fake.tickets).toEqual([]);
  });

  test('an admin address with stray whitespace or capitals is still refused', async () => {
    const t = await setup();
    vi.stubEnv('ADMIN_EMAILS', '  Boss@Example.test , other@example.test');
    fake.sessions.set('cs_test_adminws', { email: 'boss@example.test' });
    expect((await claim(t, 'cs_test_adminws')).ticket).toBeNull();
    expect(fake.tickets).toEqual([]);
  });
});

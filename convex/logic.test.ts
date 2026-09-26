import { describe, expect, test } from 'vitest';
import { DOWNLOAD_WINDOW_MS, isCheckoutSessionId, withinDownloadWindow } from './downloadLogic';
import { leadTags, purchaseTags } from './ghlLogic';
import {
  buildDigitalLineItems,
  isPaidSession,
  mayIssueCheckoutTicket,
  paymentEventPlan,
  sessionOutcome,
  summariseRebuild,
  toFulfilmentInput,
  validateCheckoutInput,
  type SessionLike,
} from './stripeLogic';

const baseSession: SessionLike = {
  id: 'cs_test_abc',
  status: 'complete',
  payment_status: 'paid',
  created: 1_700_000_000,
  amount_total: 1400,
  currency: 'usd',
  customer_details: { email: 'buyer@example.test', name: 'Buyer Person' },
  metadata: { marketing_consent: 'true' },
};

describe('stripeLogic', () => {
  test('isPaidSession', () => {
    expect(isPaidSession(baseSession)).toBe(true);
    expect(isPaidSession({ ...baseSession, payment_status: 'unpaid' })).toBe(false);
    expect(isPaidSession({ ...baseSession, payment_status: 'no_payment_required' })).toBe(true);
  });

  test('toFulfilmentInput maps line items and consent', () => {
    const input = toFulfilmentInput({
      session: baseSession,
      lineItems: [
        { description: 'LIT', quantity: 1, price: { unit_amount: 500, product: 'prod_lit' } },
        { description: 'THE SOURCE', quantity: 1, price: { unit_amount: 900, product: { id: 'prod_source' } } },
      ],
      clerkId: 'user_1',
      email: 'buyer@example.test',
      eventId: 'evt_1',
    });
    expect(input.marketingConsent).toBe(true);
    expect(input.shipping).toBeUndefined();
    expect(input.lineItems.map((item) => item.stripeProductId)).toEqual(['prod_lit', 'prod_source']);
  });

  test('toFulfilmentInput reads shipping from collected_information for physical orders', () => {
    const input = toFulfilmentInput({
      session: {
        ...baseSession,
        metadata: { order_type: 'physical' },
        collected_information: {
          shipping_details: {
            name: 'Ship To',
            address: { line1: '1 Main St', city: 'LA', postal_code: '90001', country: 'US' },
          },
        },
      },
      lineItems: [],
      clerkId: 'user_1',
      email: 'buyer@example.test',
    });
    expect(input.shipping).toEqual({
      name: 'Ship To',
      line1: '1 Main St',
      line2: undefined,
      city: 'LA',
      state: undefined,
      postalCode: '90001',
      country: 'US',
    });
    expect(input.marketingConsent).toBe(false);
  });

  test('validateCheckoutInput enforces $1 minimum and a real email', () => {
    expect(validateCheckoutInput({ amountCents: 99, email: 'a@b.co' })).toMatch(/Minimum/);
    expect(validateCheckoutInput({ amountCents: 150.5, email: 'a@b.co' })).toMatch(/Minimum/);
    expect(validateCheckoutInput({ amountCents: 100, email: 'nope' })).toMatch(/email/);
    expect(validateCheckoutInput({ amountCents: 100, email: 'a@b.co' })).toBeNull();
  });

  test('buildDigitalLineItems adds the $9 upsell only when chosen', () => {
    const base = { amountCents: 700, litProductId: 'prod_lit', sourceProductId: 'prod_source' };
    expect(buildDigitalLineItems({ ...base, withUpsell: false })).toHaveLength(1);
    const withUpsell = buildDigitalLineItems({ ...base, withUpsell: true });
    expect(withUpsell[1].price_data).toEqual({ currency: 'usd', product: 'prod_source', unit_amount: 900 });
  });

  test('summariseRebuild returns counts only', () => {
    const summary = summariseRebuild(['granted', 'granted', 'already', 'physical', 'error']);
    expect(summary).toEqual({
      sessionsSeen: 5,
      granted: 2,
      early_paid: 0,
      physical: 1,
      already: 1,
      revoked: 0,
      retired: 0,
      taken: 0,
      no_account: 0,
      unmatched: 0,
      unpaid: 0,
      no_email: 0,
      error: 1,
    });
    expect(JSON.stringify(summary)).not.toMatch(/@/);
  });

  test('sessionOutcome gives each refused or unusual session its own code', () => {
    const o = (...outcomes: string[]) => sessionOutcome(outcomes.map((outcome) => ({ outcome })));
    expect(o('created')).toBe('granted');
    expect(o('replayed', 'owned')).toBe('granted');
    expect(o('created', 'early_paid')).toBe('early_paid');
    expect(o('taken')).toBe('taken');
    expect(o('revoked')).toBe('revoked');
    expect(o('retired')).toBe('retired');
    expect(o()).toBe('unmatched');
  });

  test('paymentEventPlan: full refunds and disputes revoke, partial refunds do not, won disputes reinstate', () => {
    expect(paymentEventPlan('charge.refunded', { refunded: true, payment_intent: 'pi_1' })).toEqual({
      action: 'revoke',
      reason: 'refunded',
      paymentIntentId: 'pi_1',
      outcome: 'refund_revoked',
    });
    expect(paymentEventPlan('charge.refunded', { refunded: false, payment_intent: 'pi_1' })).toEqual({
      action: 'ignore',
      outcome: 'partial_refund',
    });
    expect(
      paymentEventPlan(
        'charge.refunded',
        { refunded: false, amount_refunded: 100, payment_intent: 'pi_1' },
        { revokeOnPartialRefund: true, reinstateOnDisputeWon: true },
      ).action,
    ).toBe('revoke');
    expect(paymentEventPlan('charge.dispute.created', { payment_intent: { id: 'pi_2' } })).toMatchObject({
      action: 'revoke',
      reason: 'disputed',
      paymentIntentId: 'pi_2',
    });
    expect(paymentEventPlan('charge.dispute.closed', { status: 'won', payment_intent: 'pi_2' })).toMatchObject({
      action: 'reinstate',
      paymentIntentId: 'pi_2',
    });
    expect(paymentEventPlan('charge.dispute.closed', { status: 'lost', payment_intent: 'pi_2' })).toEqual({
      action: 'ignore',
      outcome: 'dispute_closed',
    });
    expect(
      paymentEventPlan(
        'charge.dispute.closed',
        { status: 'won', payment_intent: 'pi_2' },
        { revokeOnPartialRefund: false, reinstateOnDisputeWon: false },
      ).action,
    ).toBe('ignore');
    expect(paymentEventPlan('charge.refunded', { refunded: true, payment_intent: null }).outcome).toBe('no_payment_intent');
    for (const status of ['warning_needs_response', 'warning_under_review']) {
      expect(paymentEventPlan('charge.dispute.created', { status, payment_intent: 'pi_3' })).toEqual({
        action: 'ignore',
        outcome: 'dispute_inquiry',
      });
    }
    expect(paymentEventPlan('charge.dispute.closed', { status: 'warning_closed', payment_intent: 'pi_3' }).action).toBe(
      'reinstate',
    );
  });
});

describe('ghlLogic', () => {
  test('purchase tags require consent for marketing', () => {
    expect(purchaseTags({ slugs: ['lit'], physical: false, consent: false })).toEqual(['LIT-Purchased']);
    expect(purchaseTags({ slugs: ['lit', 'the-source'], physical: false, consent: true })).toEqual([
      'LIT-Purchased',
      'Source-Purchased',
      'Marketing-OptIn',
    ]);
    expect(purchaseTags({ slugs: [], physical: true, consent: false })).toEqual(['Merch-Purchased']);
  });

  test('lead tags are empty without consent', () => {
    expect(leadTags(false)).toEqual([]);
    expect(leadTags(true)).toContain('LIT-Lead');
  });
});

describe('downloadLogic', () => {
  const created = 1_700_000_000;
  test('24-hour window boundaries', () => {
    expect(withinDownloadWindow(created, created * 1000)).toBe(true);
    expect(withinDownloadWindow(created, created * 1000 + DOWNLOAD_WINDOW_MS)).toBe(true);
    expect(withinDownloadWindow(created, created * 1000 + DOWNLOAD_WINDOW_MS + 1)).toBe(false);
    expect(withinDownloadWindow(created, created * 1000 - 1)).toBe(false);
  });

  test('checkout session id format', () => {
    expect(isCheckoutSessionId('cs_live_a1B2c3')).toBe(true);
    expect(isCheckoutSessionId('cs_test_a1B2c3')).toBe(true);
    expect(isCheckoutSessionId('pi_123')).toBe(false);
    expect(isCheckoutSessionId('cs_live_../../x')).toBe(false);
  });
});

describe('mayIssueCheckoutTicket', () => {
  const fresh = { matches: 1, lastSignInAt: null, createdByCheckout: 'cs_test_mine' };
  const decide = (account: typeof fresh | Record<string, unknown>, isAdminEmail = false) =>
    mayIssueCheckoutTicket({ account: account as typeof fresh, sessionId: 'cs_test_mine', isAdminEmail });

  test('the account this checkout created, never used, gets a ticket', () => {
    expect(decide(fresh)).toBe(true);
  });

  test('an account another checkout created gets no ticket (a checkout opened early can\'t claim a later buyer)', () => {
    expect(decide({ ...fresh, createdByCheckout: 'cs_test_someone_else' })).toBe(false);
  });

  test('an account made any other way (older buyers, migrations, sign-ups) gets no ticket', () => {
    expect(decide({ ...fresh, createdByCheckout: null })).toBe(false);
  });

  test('an account that has been signed into gets no ticket', () => {
    expect(decide({ ...fresh, lastSignInAt: 1_700_000_000_000 })).toBe(false);
  });

  test('a missing sign-in time counts as signed in', () => {
    expect(decide({ ...fresh, lastSignInAt: undefined })).toBe(false);
  });

  test('an ambiguous lookup gets no ticket', () => {
    expect(decide({ ...fresh, matches: 2 })).toBe(false);
  });

  test('an admin address never gets a ticket', () => {
    expect(decide(fresh, true)).toBe(false);
  });
});

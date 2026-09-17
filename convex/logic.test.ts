import { describe, expect, test } from 'vitest';
import { DOWNLOAD_WINDOW_MS, isCheckoutSessionId, withinDownloadWindow } from './downloadLogic';
import { leadTags, purchaseTags } from './ghlLogic';
import {
  buildDigitalLineItems,
  isPaidSession,
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
      physical: 1,
      already: 1,
      unmatched: 0,
      unpaid: 0,
      no_email: 0,
      error: 1,
    });
    expect(JSON.stringify(summary)).not.toMatch(/@/);
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

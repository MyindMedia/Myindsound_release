// Pure helpers for the Stripe integration. No Convex or Stripe runtime imports,
// so they are unit-tested directly.

export const FULFIL_EVENT_TYPES = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'] as const;

export const MIN_AMOUNT_CENTS = 100;
export const MAX_AMOUNT_CENTS = 100_000;
export const SOURCE_UPSELL_CENTS = 900;

export type SessionLike = {
  id: string;
  status?: string | null;
  payment_status?: string | null;
  created: number;
  amount_total?: number | null;
  currency?: string | null;
  customer_email?: string | null;
  customer_details?: { email?: string | null; name?: string | null } | null;
  metadata?: Record<string, string> | null;
  shipping_details?: ShippingDetailsLike | null;
  collected_information?: { shipping_details?: ShippingDetailsLike | null } | null;
};

type ShippingDetailsLike = {
  name?: string | null;
  address?: {
    line1?: string | null;
    line2?: string | null;
    city?: string | null;
    state?: string | null;
    postal_code?: string | null;
    country?: string | null;
  } | null;
};

export type LineItemLike = {
  description?: string | null;
  quantity?: number | null;
  price?: { unit_amount?: number | null; product?: string | { id: string } | null } | null;
};

export function isPaidSession(session: SessionLike): boolean {
  return session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
}

/**
 * Whether paying may sign the buyer straight in. Stripe never proves the buyer owns the email they typed, so a
 * ticket is only safe for the account this very checkout created, before anyone has signed into it. Everyone
 * else (a returning buyer, an account made any other way, someone typing another person's email, or any admin
 * address) signs in the ordinary way, where Clerk checks the inbox.
 */
export function mayIssueCheckoutTicket(args: {
  account: { matches: number; lastSignInAt: number | null | undefined; createdByCheckout: string | null };
  sessionId: string;
  isAdminEmail: boolean;
}): boolean {
  const { account, sessionId, isAdminEmail } = args;
  if (isAdminEmail) return false;
  if (account.matches !== 1) return false;
  if (account.lastSignInAt !== null) return false; // `undefined` (Clerk didn't say) is treated as signed in
  return account.createdByCheckout === sessionId;
}

export function sessionEmail(session: SessionLike): string | null {
  return session.customer_details?.email ?? session.customer_email ?? null;
}

export function lineItemProductId(item: LineItemLike): string | undefined {
  const product = item.price?.product;
  if (!product) return undefined;
  return typeof product === 'string' ? product : product.id;
}

function shippingFrom(session: SessionLike, fallbackName?: string) {
  const details = session.collected_information?.shipping_details ?? session.shipping_details;
  const address = details?.address;
  if (!address?.line1 || !address.city || !address.postal_code || !address.country) return undefined;
  return {
    name: details?.name ?? fallbackName ?? '',
    line1: address.line1,
    line2: address.line2 ?? undefined,
    city: address.city,
    state: address.state ?? undefined,
    postalCode: address.postal_code,
    country: address.country,
  };
}

export function toFulfilmentInput(args: {
  session: SessionLike;
  lineItems: LineItemLike[];
  clerkId: string;
  email: string;
  eventId?: string;
  eventType?: string;
}) {
  const { session, lineItems, clerkId, email, eventId, eventType } = args;
  const name = session.customer_details?.name ?? undefined;
  return {
    eventId,
    eventType,
    sessionId: session.id,
    clerkId,
    email,
    name,
    orderType: session.metadata?.order_type,
    marketingConsent: session.metadata?.marketing_consent === 'true',
    amountTotal: session.amount_total ?? 0,
    currency: session.currency ?? 'usd',
    shipping: session.metadata?.order_type === 'physical' ? shippingFrom(session, name) : undefined,
    lineItems: lineItems.map((item) => ({
      description: item.description ?? 'Unknown product',
      quantity: item.quantity ?? 1,
      unitAmount: item.price?.unit_amount ?? 0,
      stripeProductId: lineItemProductId(item),
    })),
  };
}

export function validateCheckoutInput(input: { amountCents: number; email: string }): string | null {
  if (!Number.isInteger(input.amountCents) || input.amountCents < MIN_AMOUNT_CENTS) {
    return 'Minimum is $1.00.';
  }
  if (input.amountCents > MAX_AMOUNT_CENTS) return 'Maximum is $1,000.00.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) return 'Enter a valid email address.';
  return null;
}

export function buildDigitalLineItems(args: {
  amountCents: number;
  withUpsell: boolean;
  litProductId: string;
  sourceProductId: string;
}) {
  const items = [
    { price_data: { currency: 'usd', product: args.litProductId, unit_amount: args.amountCents }, quantity: 1 },
  ];
  if (args.withUpsell) {
    items.push({
      price_data: { currency: 'usd', product: args.sourceProductId, unit_amount: SOURCE_UPSELL_CENTS },
      quantity: 1,
    });
  }
  return items;
}

export type RebuildOutcome =
  | 'granted'
  | 'early_paid' // granted, but paid before a product's drop (presale, unnumbered)
  | 'physical'
  | 'already'
  | 'revoked' // the session's licence was refunded or charged back: not granted again
  | 'retired' // the session's licence belongs to a deleted account
  | 'taken' // the session's licence is held by a different account
  | 'unmatched'
  | 'unpaid'
  | 'no_email'
  | 'error';

/** Per-product grant outcomes from `fulfilment.record` (see GrantOutcome there). */
export type GrantOutcomeLike = { outcome: string };

/**
 * One log code for a digital session. A granted session is `granted`, or `early_paid` when any product was
 * bought before its drop; a session that granted nothing says why. Each code is distinct so a refused or
 * unusual session is never hidden under `unmatched`.
 */
export function sessionOutcome(grants: GrantOutcomeLike[]): RebuildOutcome {
  const has = (outcome: string) => grants.some((grant) => grant.outcome === outcome);
  if (has('early_paid')) return 'early_paid';
  if (has('created') || has('replayed') || has('owned')) return 'granted';
  if (has('taken')) return 'taken';
  if (has('revoked')) return 'revoked';
  if (has('retired')) return 'retired';
  return 'unmatched';
}

// Counts only. Never include customer identifiers in this summary.
export function summariseRebuild(outcomes: RebuildOutcome[]) {
  const counts: Record<RebuildOutcome, number> = {
    granted: 0,
    early_paid: 0,
    physical: 0,
    already: 0,
    revoked: 0,
    retired: 0,
    taken: 0,
    unmatched: 0,
    unpaid: 0,
    no_email: 0,
    error: 0,
  };
  for (const outcome of outcomes) counts[outcome]++;
  return { sessionsSeen: outcomes.length, ...counts };
}

// Refunds and disputes (PAY-3, ENT-4).

/** Enable these in the Stripe dashboard webhook endpoint, next to FULFIL_EVENT_TYPES. */
export const PAYMENT_EVENT_TYPES = ['charge.refunded', 'charge.dispute.created', 'charge.dispute.closed'] as const;

/** [DECIDE] A partial refund leaves the licence in place (logged as `partial_refund`). */
export const REVOKE_ON_PARTIAL_REFUND = false;

/** [DECIDE] A dispute closed as won gives the licence back. */
export const REINSTATE_ON_DISPUTE_WON = true;

export type PaymentEventOutcome =
  | 'refund_revoked'
  | 'partial_refund'
  | 'dispute_revoked'
  | 'dispute_reinstated'
  | 'dispute_inquiry' // an inquiry (warning_*), not a chargeback: nothing is revoked
  | 'dispute_closed' // closed any other way (lost): the revocation stands
  | 'revoked_before_fulfilment' // refunded or disputed before the licence existed: a tombstone blocks it
  | 'no_payment_intent'
  | 'no_session' // not a Checkout payment (nothing we granted)
  | 'no_match'; // a Checkout payment with no licence behind it (physical order, or never fulfilled)

export type ChargeLike = {
  refunded?: boolean | null;
  amount_refunded?: number | null;
  payment_intent?: string | { id: string } | null;
};

/** Dispute statuses that are inquiries (no funds withdrawn), not chargebacks. */
export const DISPUTE_INQUIRY_STATUSES = ['warning_needs_response', 'warning_under_review'] as const;

/** Dispute outcomes that give the licence back (an inquiry closed without a chargeback counts). */
export const DISPUTE_REINSTATE_STATUSES = ['won', 'warning_closed'] as const;

export type DisputeLike = {
  status?: string | null;
  payment_intent?: string | { id: string } | null;
};

export type PaymentEventPlan =
  | { action: 'revoke'; reason: 'refunded' | 'disputed'; paymentIntentId: string; outcome: PaymentEventOutcome }
  | { action: 'reinstate'; paymentIntentId: string; outcome: PaymentEventOutcome }
  | { action: 'ignore'; outcome: PaymentEventOutcome };

export function paymentIntentId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/** Whether a charge's refund state revokes what it paid for: a full refund, or any refund when configured. */
export function chargeRevokes(charge: ChargeLike, revokeOnPartialRefund = REVOKE_ON_PARTIAL_REFUND): boolean {
  if (charge.refunded) return true;
  return revokeOnPartialRefund && (charge.amount_refunded ?? 0) > 0;
}

/** What a refund or dispute event does to the licence its payment bought. Pure, so it is unit-tested. */
export function paymentEventPlan(
  type: string,
  object: ChargeLike & DisputeLike,
  config = { revokeOnPartialRefund: REVOKE_ON_PARTIAL_REFUND, reinstateOnDisputeWon: REINSTATE_ON_DISPUTE_WON },
): PaymentEventPlan {
  const intent = paymentIntentId(object.payment_intent);
  if (type === 'charge.refunded') {
    // `refunded` is Stripe's own flag for a charge refunded in full.
    if (!chargeRevokes(object, config.revokeOnPartialRefund)) return { action: 'ignore', outcome: 'partial_refund' };
    if (!intent) return { action: 'ignore', outcome: 'no_payment_intent' };
    return { action: 'revoke', reason: 'refunded', paymentIntentId: intent, outcome: 'refund_revoked' };
  }
  if (type === 'charge.dispute.created') {
    if ((DISPUTE_INQUIRY_STATUSES as readonly (string | null | undefined)[]).includes(object.status)) {
      return { action: 'ignore', outcome: 'dispute_inquiry' };
    }
    if (!intent) return { action: 'ignore', outcome: 'no_payment_intent' };
    return { action: 'revoke', reason: 'disputed', paymentIntentId: intent, outcome: 'dispute_revoked' };
  }
  const reinstates = (DISPUTE_REINSTATE_STATUSES as readonly (string | null | undefined)[]).includes(object.status);
  if (type === 'charge.dispute.closed' && reinstates && config.reinstateOnDisputeWon) {
    if (!intent) return { action: 'ignore', outcome: 'no_payment_intent' };
    return { action: 'reinstate', paymentIntentId: intent, outcome: 'dispute_reinstated' };
  }
  return { action: 'ignore', outcome: 'dispute_closed' };
}

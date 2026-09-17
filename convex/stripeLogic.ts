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

export type RebuildOutcome = 'granted' | 'physical' | 'already' | 'unmatched' | 'unpaid' | 'no_email' | 'error';

// Counts only. Never include customer identifiers in this summary.
export function summariseRebuild(outcomes: RebuildOutcome[]) {
  const counts: Record<RebuildOutcome, number> = {
    granted: 0,
    physical: 0,
    already: 0,
    unmatched: 0,
    unpaid: 0,
    no_email: 0,
    error: 0,
  };
  for (const outcome of outcomes) counts[outcome]++;
  return { sessionsSeen: outcomes.length, ...counts };
}

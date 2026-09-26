import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import {
  activeEntitlement,
  isActiveEntitlement,
  isPrelaunch,
  newWearSeed,
  takeEdition,
  WEAR_MODEL_VERSION,
  zeroWearStats,
  type EntitlementSource,
} from './lib/editions';
import { convertBorrowerLend, revokeLendsOfCopy } from './lendLogic';
import { appendRef, ensureOriginRef, entitlementForSession, hasActiveRef, refsFor } from './lib/entitlementRefs';
import { fail } from './lib/errors';
import { entitlementSourceValidator, shippingValidator } from './schema';

export const fulfilmentInput = v.object({
  eventId: v.optional(v.string()),
  eventType: v.optional(v.string()),
  /** The Stripe Checkout session. Required for Stripe grants (the default source) and physical orders. */
  sessionId: v.optional(v.string()),
  /** Omitted means 'stripe', as every caller before the app did. */
  source: v.optional(entitlementSourceValidator),
  /** Idempotency key for non-Stripe grants: originalTransactionId, tag uid or audit id. Stripe uses the session. */
  sourceRef: v.optional(v.string()),
  clerkId: v.string(),
  email: v.string(),
  name: v.optional(v.string()),
  orderType: v.optional(v.string()),
  marketingConsent: v.optional(v.boolean()),
  amountTotal: v.number(),
  currency: v.string(),
  shipping: v.optional(shippingValidator),
  lineItems: v.array(
    v.object({
      description: v.string(),
      quantity: v.number(),
      unitAmount: v.number(),
      stripeProductId: v.optional(v.string()),
      /** StoreKit product id; any of a product's price tiers (PAY-11). */
      appStoreProductId: v.optional(v.string()),
      /** NFC and admin grants name the product directly. */
      productId: v.optional(v.id('products')),
    }),
  ),
});

export const eventSeen = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, { eventId }) => {
    const row = await ctx.db
      .query('stripeEvents')
      .withIndex('by_eventId', (q) => q.eq('eventId', eventId))
      .first();
    return row !== null;
  },
});

// Existing rows for a checkout session, used by the rebuild dry run.
export const sessionState = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    // Includes a session that re-bought something its buyer already owned (a ref, no entitlement of its own).
    const entitlement = await entitlementForSession(ctx, sessionId);
    const order = await ctx.db
      .query('orders')
      .withIndex('by_session', (q) => q.eq('stripeSessionId', sessionId))
      .first();
    return { fulfilled: entitlement !== null || order !== null };
  },
});

export const productsByStripeIds = internalQuery({
  args: { stripeProductIds: v.array(v.string()) },
  handler: async (ctx, { stripeProductIds }) => {
    const wanted = new Set(stripeProductIds);
    const all = await ctx.db.query('products').collect();
    return all
      .filter((product) => product.stripeProductIds.some((id) => wanted.has(id)))
      .map((product) => ({
        _id: product._id,
        slug: product.slug,
        name: product.name,
        kind: product.kind,
        stripeProductIds: product.stripeProductIds,
        downloadFile: product.downloadFile ?? null,
      }));
  },
});

/**
 * The account that holds the licence a checkout session paid for, if any. Fulfilment and the claim link use
 * it so a session already bound to an account is never re-bound to a fresh, empty one (a buyer who changed
 * their email in Clerk would otherwise get a new account from the email lookup). Internal only.
 */
export const sessionHolder = internalQuery({
  args: { sessionId: v.string() },
  handler: async (
    ctx,
    { sessionId },
  ): Promise<{ status: 'unbound' } | { status: 'retired' } | { status: 'held'; clerkId: string }> => {
    const entitlement = await entitlementForSession(ctx, sessionId);
    if (!entitlement) return { status: 'unbound' };
    // The account was deleted (§3A): nothing may recreate it from this session.
    if (!entitlement.userId || entitlement.status === 'retired') return { status: 'retired' };
    const user = await ctx.db.get(entitlement.userId);
    return user ? { status: 'held', clerkId: user.clerkId } : { status: 'retired' };
  },
});

/**
 * Checkout guards (ED-3, ENT-5), answered as booleans only. Before its drop a product sells as a presale
 * unless it is flagged `presaleAllowed: false`. `alreadyOwned` is checked only for a signed-in
 * caller buying for their own verified email: answering it for any typed email would tell a stranger which
 * addresses own a release.
 */
export const checkoutCheck = internalQuery({
  args: {
    stripeProductIds: v.array(v.string()),
    now: v.number(),
    clerkId: v.optional(v.string()),
    ownEmail: v.boolean(),
  },
  handler: async (ctx, { stripeProductIds, now, clerkId, ownEmail }) => {
    const all = await ctx.db.query('products').collect();
    const requested = stripeProductIds.map((id) => all.find((product) => product.stripeProductIds.includes(id)));
    const notYetLive = requested.some(
      (product) => product !== undefined && product.presaleAllowed === false && isPrelaunch(product, now),
    );

    let alreadyOwned = false;
    if (clerkId && ownEmail && requested.length > 0 && requested.every(Boolean)) {
      const user = await ctx.db
        .query('users')
        .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
        .unique();
      if (user) {
        alreadyOwned = true;
        for (const product of requested) {
          if (!(await activeEntitlement(ctx, user._id, product!._id))) alreadyOwned = false;
        }
      }
    }
    return { notYetLive, alreadyOwned };
  },
});

async function upsertUser(
  ctx: MutationCtx,
  clerkId: string,
  email: string,
  name: string | undefined,
  marketingConsent: boolean | undefined,
): Promise<Doc<'users'>> {
  const existing = await ctx.db
    .query('users')
    .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
    .unique();
  const consentPatch = marketingConsent ? { marketingConsentAt: Date.now() } : {};
  if (existing) {
    await ctx.db.patch(existing._id, {
      email: existing.email || email,
      name: existing.name ?? name,
      ...(marketingConsent && !existing.marketingConsentAt ? consentPatch : {}),
    });
    return (await ctx.db.get(existing._id))!;
  }
  const id = await ctx.db.insert('users', { clerkId, email, name, isAdmin: false, ...consentPatch });
  return (await ctx.db.get(id))!;
}

export type GrantOutcome =
  | 'created' // new licence
  | 'early_paid' // new licence, paid before the drop: granted, never numbered (ED-3, presale)
  | 'replayed' // this payment/tag/audit ref already granted it (idempotent replay)
  | 'owned' // the user already holds a live licence (ENT-5): the ref is added to it, no edition used
  | 'revoked' // this ref granted it once and it was refunded or charged back: not granted again
  | 'retired' // this ref granted it to an account that has since been deleted
  | 'taken' // this ref already granted it to a different account
  | 'early'; // an unpaid (NFC, admin) grant before the drop: refused (ED-3)

export type Grant = { slug: string; outcome: GrantOutcome; editionNumber: number | null };

const GRANTED: readonly GrantOutcome[] = ['created', 'early_paid', 'replayed', 'owned'];

/** Money has already moved for these: a grant is never refused for timing. */
const PAID_SOURCES: readonly EntitlementSource[] = ['stripe', 'storekit'];

/**
 * Grants one product to one user. The only code that inserts entitlements (PAY-10); reached only through
 * `record`. Order matters: a known ref is recognised before ownership, and ownership before the drop check,
 * so re-running a past grant never fails or changes it (ENT-3).
 */
async function grantEntitlement(
  ctx: MutationCtx,
  args: { userId: Id<'users'>; product: Doc<'products'>; source: EntitlementSource; sourceRef: string },
): Promise<Grant> {
  const { userId, product, source, sourceRef } = args;
  const grant = (outcome: GrantOutcome, row?: Doc<'entitlements'> | null): Grant => ({
    slug: product.slug,
    outcome,
    editionNumber: row?.editionNumber ?? null,
  });

  const prior = (await refsFor(ctx, source, sourceRef)).find((ref) => ref.productId === product._id);
  const priorRow = prior?.entitlementId ? await ctx.db.get(prior.entitlementId) : null;
  if (priorRow) {
    if (priorRow.status === 'retired') return grant('retired', priorRow);
    // Checked before the account: a refunded licence whose account was deleted is still `revoked`.
    if (!isActiveEntitlement(priorRow)) return grant('revoked', priorRow);
    if (priorRow.userId !== userId) return grant('taken');
    return grant('replayed', priorRow);
  }
  // A tombstone: this payment was refunded or disputed before it was ever fulfilled.
  if (prior && prior.status !== 'active') return grant('revoked');

  const owned = await activeEntitlement(ctx, userId, product._id);
  if (owned) {
    await ensureOriginRef(ctx, owned);
    await appendRef(ctx, owned, source, sourceRef, prior);
    return grant('owned', owned);
  }

  const now = Date.now();
  const early = isPrelaunch(product, now);
  if (early && !PAID_SOURCES.includes(source)) return grant('early');

  const editionNumber = early ? null : await takeEdition(ctx, product);
  // LEND-9: a borrower buying the release ends their lend of it as `converted`, attributed on the new licence.
  const convertedFromLendId = await convertBorrowerLend(ctx, userId, product._id, now);
  const id = await ctx.db.insert('entitlements', {
    userId,
    productId: product._id,
    ...(source === 'stripe' ? { stripeSessionId: sourceRef } : {}),
    grantedAt: now,
    ...(editionNumber === null ? {} : { editionNumber }),
    ...(early ? { presale: true } : {}),
    source,
    sourceRef,
    status: 'active',
    wearSeed: newWearSeed(),
    wearStats: zeroWearStats(),
    wearModelVersion: WEAR_MODEL_VERSION,
    ...(convertedFromLendId ? { convertedFromLendId } : {}),
  });
  const row = (await ctx.db.get(id))!;
  await appendRef(ctx, row, source, sourceRef, prior);
  return grant(early ? 'early_paid' : 'created', row);
}

/**
 * The single grant path (PAY-10) for every channel. Stripe (the default source) is keyed on the checkout
 * session as it always was; StoreKit, NFC and admin callers pass `source` and `sourceRef` and no session.
 */
export const record = internalMutation({
  args: fulfilmentInput,
  handler: async (ctx, input) => {
    const source: EntitlementSource = input.source ?? 'stripe';
    if (source === 'stripe') {
      if (!input.sessionId) fail('INVALID_INPUT', 'A Stripe grant needs its checkout session.');
      if (input.sourceRef !== undefined && input.sourceRef !== input.sessionId) {
        fail('INVALID_INPUT', 'A Stripe grant is keyed on its checkout session.');
      }
    } else {
      if (!input.sourceRef) fail('INVALID_INPUT', `A ${source} grant needs a sourceRef.`);
      if (input.orderType === 'physical') fail('INVALID_INPUT', 'Physical orders come through Stripe only.');
    }
    const sourceRef = (source === 'stripe' ? input.sessionId : input.sourceRef)!;

    if (input.eventId) {
      const seen = await ctx.db
        .query('stripeEvents')
        .withIndex('by_eventId', (q) => q.eq('eventId', input.eventId!))
        .first();
      if (seen) {
        return { alreadyProcessed: true, userId: null, grantedSlugs: [], grants: [], orderId: null, unmatched: 0 };
      }
    }

    const user = await upsertUser(ctx, input.clerkId, input.email, input.name, input.marketingConsent);
    const products = await ctx.db.query('products').collect();
    const productFor = (item: {
      stripeProductId?: string;
      appStoreProductId?: string;
      productId?: Id<'products'>;
    }) => {
      if (item.productId) return products.find((p) => p._id === item.productId);
      if (item.appStoreProductId) return products.find((p) => p.appStoreProductIds?.includes(item.appStoreProductId!));
      if (item.stripeProductId) return products.find((p) => p.stripeProductIds.includes(item.stripeProductId!));
      return undefined;
    };

    const grantedSlugs: string[] = [];
    const grants: Grant[] = [];
    let orderId: Id<'orders'> | null = null;
    let unmatched = 0;

    if (input.orderType === 'physical') {
      const sessionId = input.sessionId!;
      const existingOrder = await ctx.db
        .query('orders')
        .withIndex('by_session', (q) => q.eq('stripeSessionId', sessionId))
        .first();
      if (existingOrder) {
        orderId = existingOrder._id;
      } else {
        orderId = await ctx.db.insert('orders', {
          userId: user._id,
          stripeSessionId: sessionId,
          totalCents: input.amountTotal,
          currency: input.currency,
          shipping: input.shipping,
          status: 'paid',
          createdAt: Date.now(),
        });
        for (const item of input.lineItems) {
          await ctx.db.insert('orderItems', {
            orderId,
            productId: productFor(item)?._id,
            description: item.description,
            quantity: item.quantity,
            unitCents: item.unitAmount,
          });
        }
      }
    } else {
      for (const item of input.lineItems) {
        const product = productFor(item);
        if (!product) {
          unmatched++;
          continue;
        }
        const grant = await grantEntitlement(ctx, { userId: user._id, product, source, sourceRef });
        if (!grants.some((g) => g.slug === grant.slug)) grants.push(grant);
        if (GRANTED.includes(grant.outcome) && !grantedSlugs.includes(product.slug)) grantedSlugs.push(product.slug);
      }
    }

    if (input.eventId) {
      await ctx.db.insert('stripeEvents', {
        eventId: input.eventId,
        type: input.eventType ?? 'unknown',
        processedAt: Date.now(),
      });
    }

    return { alreadyProcessed: false, userId: user._id, grantedSlugs, grants, orderId, unmatched };
  },
});

const paymentEventArgs = {
  source: entitlementSourceValidator,
  sourceRef: v.string(),
  productId: v.optional(v.id('products')),
  /** The Stripe event, recorded in `stripeEvents` in the same transaction so a redelivery is a no-op. */
  eventId: v.optional(v.string()),
  eventType: v.optional(v.string()),
};

async function alreadyProcessed(ctx: MutationCtx, eventId: string | undefined): Promise<boolean> {
  if (!eventId) return false;
  const seen = await ctx.db
    .query('stripeEvents')
    .withIndex('by_eventId', (q) => q.eq('eventId', eventId))
    .first();
  return seen !== null;
}

async function markProcessed(ctx: MutationCtx, eventId: string | undefined, eventType: string | undefined) {
  if (!eventId) return;
  await ctx.db.insert('stripeEvents', { eventId, type: eventType ?? 'unknown', processedAt: Date.now() });
}

/**
 * Refunds and chargebacks (ENT-4, PAY-3, PAY-8). Marks one payment's refs refunded (or disputed); an
 * entitlement is revoked only when none of its payments is still active, so an owner who paid twice and got
 * one refunded keeps it. The edition number and wear seed stay on the row and the counter never moves back,
 * so the number is retired, not reused. Idempotent. Pass `productId` to act on one release of a session.
 */
export const revokeEntitlement = internalMutation({
  args: {
    ...paymentEventArgs,
    reason: v.optional(v.union(v.literal('refunded'), v.literal('disputed'))),
    /**
     * The products the payment bought. Any of them with no ref yet (the refund or dispute arrived before
     * fulfilment) gets a tombstone ref, so a later grant for this payment returns `revoked`.
     */
    productIds: v.optional(v.array(v.id('products'))),
  },
  handler: async (ctx, { source, sourceRef, productId, eventId, eventType, reason = 'refunded', productIds = [] }) => {
    const empty = { matched: 0, refsChanged: 0, alreadyRevoked: 0, entitlementsRevoked: 0, tombstones: 0 };
    if (await alreadyProcessed(ctx, eventId)) return { ...empty, alreadyProcessed: true };
    const refs = (await refsFor(ctx, source, sourceRef)).filter(
      (ref) => productId === undefined || ref.productId === productId,
    );
    const now = Date.now();
    let refsChanged = 0;
    let alreadyRevoked = 0;
    let entitlementsRevoked = 0;
    for (const ref of refs) {
      // A refund overrides an open dispute (so winning it later cannot reinstate a refunded payment).
      const changes = ref.status === 'active' || (reason === 'refunded' && ref.status === 'disputed');
      if (!changes) {
        alreadyRevoked++;
        continue;
      }
      await ctx.db.patch(ref._id, { status: reason, changedAt: now });
      refsChanged++;
      if (!ref.entitlementId) continue;
      const row = await ctx.db.get(ref.entitlementId);
      if (!row || !isActiveEntitlement(row)) continue;
      await ensureOriginRef(ctx, row);
      if (await hasActiveRef(ctx, row._id)) continue;
      await ctx.db.patch(row._id, { status: 'revoked', revokedAt: now });
      // LEND-10: every open lend of the revoked copy ends now.
      await revokeLendsOfCopy(ctx, row._id, now);
      entitlementsRevoked++;
    }
    let tombstones = 0;
    for (const id of productIds) {
      if ((productId !== undefined && id !== productId) || refs.some((ref) => ref.productId === id)) continue;
      await ctx.db.insert('entitlementRefs', { productId: id, source, sourceRef, status: reason, at: now });
      tombstones++;
    }
    await markProcessed(ctx, eventId, eventType);
    return {
      matched: refs.length,
      refsChanged,
      alreadyRevoked,
      entitlementsRevoked,
      tombstones,
      alreadyProcessed: false,
    };
  },
});

/**
 * A dispute closed in the seller's favour (PAY-3). Reactivates that payment's disputed refs and the licence
 * they back. If the buyer has bought the release again meanwhile, the ref moves to that licence instead, so
 * there is still one live licence per user (ENT-5). A retired (deleted account) licence stays retired.
 */
export const reinstateEntitlement = internalMutation({
  args: paymentEventArgs,
  handler: async (ctx, { source, sourceRef, productId, eventId, eventType }) => {
    const empty = { matched: 0, refsReinstated: 0, entitlementsReinstated: 0 };
    if (await alreadyProcessed(ctx, eventId)) return { ...empty, alreadyProcessed: true };
    const refs = (await refsFor(ctx, source, sourceRef)).filter(
      (ref) => productId === undefined || ref.productId === productId,
    );
    const now = Date.now();
    let refsReinstated = 0;
    let entitlementsReinstated = 0;
    for (const ref of refs) {
      if (ref.status !== 'disputed') continue;
      // A tombstone (disputed before fulfilment) just becomes active again; the grant will adopt it.
      const row = ref.entitlementId ? await ctx.db.get(ref.entitlementId) : null;
      let entitlementId = ref.entitlementId;
      if (row?.status === 'revoked' && row.userId) {
        const current = await activeEntitlement(ctx, row.userId, row.productId);
        if (current) {
          entitlementId = current._id;
        } else {
          await ctx.db.patch(row._id, { status: 'active', revokedAt: undefined });
          entitlementsReinstated++;
        }
      }
      await ctx.db.patch(ref._id, { status: 'active', changedAt: now, entitlementId });
      refsReinstated++;
    }
    await markProcessed(ctx, eventId, eventType);
    return { matched: refs.length, refsReinstated, entitlementsReinstated, alreadyProcessed: false };
  },
});

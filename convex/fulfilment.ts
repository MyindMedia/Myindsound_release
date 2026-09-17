import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx } from './_generated/server';
import { shippingValidator } from './schema';

export const fulfilmentInput = v.object({
  eventId: v.optional(v.string()),
  eventType: v.optional(v.string()),
  sessionId: v.string(),
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
    const entitlement = await ctx.db
      .query('entitlements')
      .withIndex('by_session', (q) => q.eq('stripeSessionId', sessionId))
      .first();
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

export const record = internalMutation({
  args: fulfilmentInput,
  handler: async (ctx, input) => {
    if (input.eventId) {
      const seen = await ctx.db
        .query('stripeEvents')
        .withIndex('by_eventId', (q) => q.eq('eventId', input.eventId!))
        .first();
      if (seen) return { alreadyProcessed: true, userId: null, grantedSlugs: [], orderId: null, unmatched: 0 };
    }

    const user = await upsertUser(ctx, input.clerkId, input.email, input.name, input.marketingConsent);
    const products = await ctx.db.query('products').collect();
    const productFor = (stripeProductId?: string) =>
      stripeProductId ? products.find((p) => p.stripeProductIds.includes(stripeProductId)) : undefined;

    const grantedSlugs: string[] = [];
    let orderId: Id<'orders'> | null = null;
    let unmatched = 0;

    if (input.orderType === 'physical') {
      const existingOrder = await ctx.db
        .query('orders')
        .withIndex('by_session', (q) => q.eq('stripeSessionId', input.sessionId))
        .first();
      if (existingOrder) {
        orderId = existingOrder._id;
      } else {
        orderId = await ctx.db.insert('orders', {
          userId: user._id,
          stripeSessionId: input.sessionId,
          totalCents: input.amountTotal,
          currency: input.currency,
          shipping: input.shipping,
          status: 'paid',
          createdAt: Date.now(),
        });
        for (const item of input.lineItems) {
          await ctx.db.insert('orderItems', {
            orderId,
            productId: productFor(item.stripeProductId)?._id,
            description: item.description,
            quantity: item.quantity,
            unitCents: item.unitAmount,
          });
        }
      }
    } else {
      for (const item of input.lineItems) {
        const product = productFor(item.stripeProductId);
        if (!product) {
          unmatched++;
          continue;
        }
        const existing = await ctx.db
          .query('entitlements')
          .withIndex('by_user_product', (q) => q.eq('userId', user._id).eq('productId', product._id))
          .first();
        if (!existing) {
          await ctx.db.insert('entitlements', {
            userId: user._id,
            productId: product._id,
            stripeSessionId: input.sessionId,
            grantedAt: Date.now(),
          });
        }
        if (!grantedSlugs.includes(product.slug)) grantedSlugs.push(product.slug);
      }
    }

    if (input.eventId) {
      await ctx.db.insert('stripeEvents', {
        eventId: input.eventId,
        type: input.eventType ?? 'unknown',
        processedAt: Date.now(),
      });
    }

    return { alreadyProcessed: false, userId: user._id, grantedSlugs, orderId, unmatched };
  },
});

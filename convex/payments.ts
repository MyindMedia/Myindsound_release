import Stripe from 'stripe';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { isCheckoutSessionId, withinDownloadWindow } from './downloadLogic';
import { findOrCreateClerkUser } from './lib/clerkApi';
import { fail } from './lib/errors';
import { DOWNLOAD_URL_TTL_SECONDS, signGetUrl } from './lib/r2';
import {
  buildDigitalLineItems,
  FULFIL_EVENT_TYPES,
  isPaidSession,
  lineItemProductId,
  sessionEmail,
  summariseRebuild,
  toFulfilmentInput,
  validateCheckoutInput,
  type RebuildOutcome,
} from './stripeLogic';

function stripeClient(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) fail('NOT_CONFIGURED', 'Payments are not connected yet.');
  return new Stripe(key, { httpClient: Stripe.createFetchHttpClient() });
}

function siteUrl(): string {
  return (process.env.SITE_URL ?? 'http://localhost:5173').replace(/\/$/, '');
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'unknown error';
}

async function listLineItems(stripe: Stripe, sessionId: string) {
  const items: Stripe.LineItem[] = [];
  for await (const item of stripe.checkout.sessions.listLineItems(sessionId, { limit: 100 })) {
    items.push(item);
  }
  return items;
}

async function fulfilSession(
  ctx: ActionCtx,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  event?: { id: string; type: string },
): Promise<RebuildOutcome> {
  if (!isPaidSession(session)) return 'unpaid';
  const email = sessionEmail(session);
  if (!email) return 'no_email';

  const lineItems = await listLineItems(stripe, session.id);
  const clerkId = await findOrCreateClerkUser(email, session.customer_details?.name ?? undefined);
  const input = toFulfilmentInput({ session, lineItems, clerkId, email, eventId: event?.id, eventType: event?.type });
  const result = await ctx.runMutation(internal.fulfilment.record, input);
  if (result.alreadyProcessed) return 'already';

  const physical = input.orderType === 'physical';
  if (result.userId && (physical || result.grantedSlugs.length > 0)) {
    await ctx.scheduler.runAfter(0, internal.ghl.syncPurchase, {
      userId: result.userId,
      slugs: result.grantedSlugs,
      physical,
      attempt: 0,
    });
  }
  if (physical) return 'physical';
  return result.grantedSlugs.length > 0 ? 'granted' : 'unmatched';
}

export const handleWebhook = internalAction({
  args: { payload: v.string(), signature: v.string() },
  handler: async (ctx, { payload, signature }): Promise<{ status: number }> => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) {
      console.error('stripe webhook: STRIPE_WEBHOOK_SECRET is not set');
      return { status: 500 };
    }
    const stripe = stripeClient();
    let event: Stripe.Event;
    try {
      event = await stripe.webhooks.constructEventAsync(
        payload,
        signature,
        secret,
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch {
      console.warn('stripe webhook: signature verification failed');
      return { status: 400 };
    }

    if (!(FULFIL_EVENT_TYPES as readonly string[]).includes(event.type)) return { status: 200 };
    if (await ctx.runQuery(internal.fulfilment.eventSeen, { eventId: event.id })) return { status: 200 };

    const session = event.data.object as Stripe.Checkout.Session;
    try {
      const outcome = await fulfilSession(ctx, stripe, session, { id: event.id, type: event.type });
      console.log(`stripe webhook: ${event.id} ${session.id} -> ${outcome}`);
      return { status: 200 };
    } catch (err) {
      // 500 makes Stripe retry; nothing was committed if we got here before the mutation.
      console.error(`stripe webhook: ${event.id} ${session.id} failed: ${errorMessage(err)}`);
      return { status: 500 };
    }
  },
});

export const createDigitalSession = action({
  args: {
    amountCents: v.number(),
    withUpsell: v.boolean(),
    email: v.string(),
    marketingConsent: v.boolean(),
  },
  handler: async (_ctx, args): Promise<{ url: string }> => {
    const problem = validateCheckoutInput(args);
    if (problem) fail('INVALID_INPUT', problem);
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: args.email.trim(),
      line_items: buildDigitalLineItems({
        amountCents: args.amountCents,
        withUpsell: args.withUpsell,
        litProductId: process.env.STRIPE_PRODUCT_ID_LIT ?? 'prod_TsqOvYycMrdhnl',
        sourceProductId: process.env.STRIPE_PRODUCT_ID_SOURCE ?? 'prod_TsqUkQtzNQ5Y3z',
      }),
      metadata: {
        products: args.withUpsell ? 'LIT,THE_SOURCE' : 'LIT',
        lit_amount: (args.amountCents / 100).toFixed(2),
        marketing_consent: args.marketingConsent ? 'true' : 'false',
      },
      success_url: `${siteUrl()}/?success=true&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl()}/?cancel=true`,
    });
    if (!session.url) fail('NOT_CONFIGURED', 'Checkout could not start. Try again.');
    return { url: session.url };
  },
});

export const downloadsForCheckoutSession = action({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }) => {
    if (!isCheckoutSessionId(sessionId)) fail('INVALID_INPUT', 'That checkout link is not valid.');
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isPaidSession(session)) fail('SESSION_NOT_PAID', 'This checkout has not been paid.');
    if (!withinDownloadWindow(session.created, Date.now())) {
      fail('DOWNLOAD_WINDOW_CLOSED', 'This link has expired. Sign in to download from your dashboard.');
    }

    const lineItems = await listLineItems(stripe, session.id);
    const stripeProductIds = lineItems.map(lineItemProductId).filter((id): id is string => Boolean(id));
    const products = await ctx.runQuery(internal.fulfilment.productsByStripeIds, { stripeProductIds });

    const downloads: { name: string; url: string; type: 'standard' | 'upsell' }[] = [];
    for (const product of products) {
      if (product.downloadKey) {
        downloads.push({
          name: `${product.name} (Digital EP)`,
          url: await signGetUrl(product.downloadKey, DOWNLOAD_URL_TTL_SECONDS),
          type: 'standard',
        });
      } else if (product.slug === 'the-source' && process.env.SOURCE_PRESALE_URL) {
        downloads.push({ name: product.name, url: process.env.SOURCE_PRESALE_URL, type: 'upsell' });
      }
    }
    const firstName = session.customer_details?.name?.trim().split(/\s+/)[0] ?? null;
    return { firstName, downloads };
  },
});

// Run with: npx convex run payments:rebuildFromStripe '{"dryRun":true}'
// Output is counts only. Never add customer identifiers to the return value or logs.
export const rebuildFromStripe = internalAction({
  args: { dryRun: v.boolean(), createdAfterSec: v.optional(v.number()) },
  handler: async (ctx, { dryRun, createdAfterSec }) => {
    const stripe = stripeClient();
    const outcomes: RebuildOutcome[] = [];
    const params: Stripe.Checkout.SessionListParams = { status: 'complete', limit: 100 };
    if (createdAfterSec) params.created = { gte: createdAfterSec };

    for await (const session of stripe.checkout.sessions.list(params)) {
      try {
        if (!isPaidSession(session)) {
          outcomes.push('unpaid');
          continue;
        }
        if (!sessionEmail(session)) {
          outcomes.push('no_email');
          continue;
        }
        const state = await ctx.runQuery(internal.fulfilment.sessionState, { sessionId: session.id });
        if (state.fulfilled) {
          outcomes.push('already');
          continue;
        }
        if (!dryRun) {
          outcomes.push(await fulfilSession(ctx, stripe, session));
          continue;
        }
        if (session.metadata?.order_type === 'physical') {
          outcomes.push('physical');
          continue;
        }
        const lineItems = await listLineItems(stripe, session.id);
        const stripeProductIds = lineItems.map(lineItemProductId).filter((id): id is string => Boolean(id));
        const products = await ctx.runQuery(internal.fulfilment.productsByStripeIds, { stripeProductIds });
        outcomes.push(products.length > 0 ? 'granted' : 'unmatched');
      } catch {
        outcomes.push('error');
      }
    }
    return { dryRun, ...summariseRebuild(outcomes) };
  },
});

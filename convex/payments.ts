import Stripe from 'stripe';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { isCheckoutSessionId, withinDownloadWindow } from './downloadLogic';
import { isAdminEmail } from './lib/auth';
import {
  createSignInTicket,
  findClerkAccount,
  findOrCreateClerkAccount,
  findOrCreateClerkUser,
  getClerkAccount,
  type ClerkAccount,
} from './lib/clerkApi';
import { fail } from './lib/errors';
import { fileUrl } from './lib/storage';
import { playerTracks, type PlayerTrack } from './tracks';
import {
  buildDigitalLineItems,
  chargeRevokes,
  FULFIL_EVENT_TYPES,
  isPaidSession,
  lineItemProductId,
  mayIssueCheckoutTicket,
  PAYMENT_EVENT_TYPES,
  paymentEventPlan,
  paymentIntentId,
  sessionEmail,
  sessionOutcome,
  summariseRebuild,
  toFulfilmentInput,
  validateCheckoutInput,
  type ChargeLike,
  type DisputeLike,
  type PaymentEventOutcome,
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

/** Our product ids for a session's line items (for refund tombstones). */
async function productIdsFor(ctx: ActionCtx, lineItems: Stripe.LineItem[]) {
  const stripeProductIds = lineItems.map(lineItemProductId).filter((id): id is string => Boolean(id));
  const products = await ctx.runQuery(internal.fulfilment.productsByStripeIds, { stripeProductIds });
  return products.map((product) => product._id);
}

/** Whether the session's payment has since been refunded (per `chargeRevokes`), checked with Stripe. */
async function paymentRevoked(stripe: Stripe, session: Stripe.Checkout.Session): Promise<boolean> {
  const intent = paymentIntentId(session.payment_intent);
  if (!intent) return false;
  const paymentIntent = await stripe.paymentIntents.retrieve(intent, { expand: ['latest_charge'] });
  const charge = paymentIntent.latest_charge;
  return typeof charge === 'object' && charge !== null && chargeRevokes(charge);
}

async function fulfilSession(
  ctx: ActionCtx,
  stripe: Stripe,
  session: Stripe.Checkout.Session,
  event?: { id: string; type: string },
  /** False only for the rebuild: an email with no account is skipped (`no_account`), never given a new one. */
  createAccount = true,
): Promise<RebuildOutcome> {
  if (!isPaidSession(session)) return 'unpaid';
  const email = sessionEmail(session);
  if (!email) return 'no_email';

  // A session already bound to an account stays with it; only an unbound one is matched by email. One whose
  // licence belongs to a deleted account never recreates that account or its profile.
  const holder = await ctx.runQuery(internal.fulfilment.sessionHolder, { sessionId: session.id });
  if (holder.status === 'retired') return 'retired';

  const lineItems = await listLineItems(stripe, session.id);
  // A payment refunded before (or after) it was fulfilled is never granted: record the refund against the
  // session, which also revokes anything it already granted.
  if (session.metadata?.order_type !== 'physical' && (await paymentRevoked(stripe, session))) {
    await ctx.runMutation(internal.fulfilment.revokeEntitlement, {
      source: 'stripe',
      sourceRef: session.id,
      reason: 'refunded',
      productIds: await productIdsFor(ctx, lineItems),
    });
    return 'revoked';
  }

  let clerkId: string;
  if (holder.status === 'held') {
    clerkId = holder.clerkId;
  } else if (createAccount) {
    clerkId = await findOrCreateClerkUser(email, session.customer_details?.name ?? undefined, session.id);
  } else {
    const existing = await findClerkAccount(email);
    if (!existing) return 'no_account';
    clerkId = existing.id;
  }
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
  return sessionOutcome(result.grants);
}

/** The Checkout session behind a payment intent, or null when the payment did not come through Checkout. */
async function sessionForPaymentIntent(stripe: Stripe, paymentIntent: string): Promise<string | null> {
  const page = await stripe.checkout.sessions.list({ payment_intent: paymentIntent, limit: 1 });
  return page.data[0]?.id ?? null;
}

/** Refunds and disputes (PAY-3): revoke or reinstate the licence the payment bought. */
async function applyPaymentEvent(ctx: ActionCtx, stripe: Stripe, event: Stripe.Event): Promise<PaymentEventOutcome> {
  const plan = paymentEventPlan(event.type, event.data.object as ChargeLike & DisputeLike);
  if (plan.action === 'ignore') return plan.outcome;
  const sessionId = await sessionForPaymentIntent(stripe, plan.paymentIntentId);
  if (!sessionId) return 'no_session';
  const common = { source: 'stripe' as const, sourceRef: sessionId, eventId: event.id, eventType: event.type };
  if (plan.action === 'reinstate') {
    const result = await ctx.runMutation(internal.fulfilment.reinstateEntitlement, common);
    return result.matched === 0 ? 'no_match' : plan.outcome;
  }
  // The products are passed so a refund that beats fulfilment leaves a tombstone the grant will respect.
  const productIds = await productIdsFor(ctx, await listLineItems(stripe, sessionId));
  const result = await ctx.runMutation(internal.fulfilment.revokeEntitlement, {
    ...common,
    reason: plan.reason,
    productIds,
  });
  if (result.matched > 0) return plan.outcome;
  return result.tombstones > 0 ? 'revoked_before_fulfilment' : 'no_match';
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

    const isPaymentEvent = (PAYMENT_EVENT_TYPES as readonly string[]).includes(event.type);
    if (!isPaymentEvent && !(FULFIL_EVENT_TYPES as readonly string[]).includes(event.type)) return { status: 200 };
    if (await ctx.runQuery(internal.fulfilment.eventSeen, { eventId: event.id })) return { status: 200 };

    if (isPaymentEvent) {
      try {
        const outcome = await applyPaymentEvent(ctx, stripe, event);
        console.log(`stripe webhook: ${event.id} ${event.type} -> ${outcome}`);
        return { status: 200 };
      } catch (err) {
        console.error(`stripe webhook: ${event.id} ${event.type} failed: ${errorMessage(err)}`);
        return { status: 500 };
      }
    }

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
  handler: async (ctx, args): Promise<{ url: string }> => {
    const problem = validateCheckoutInput(args);
    if (problem) fail('INVALID_INPUT', problem);
    const lineItems = buildDigitalLineItems({
      amountCents: args.amountCents,
      withUpsell: args.withUpsell,
      litProductId: process.env.STRIPE_PRODUCT_ID_LIT ?? 'prod_TsqOvYycMrdhnl',
      sourceProductId: process.env.STRIPE_PRODUCT_ID_SOURCE ?? 'prod_TsqUkQtzNQ5Y3z',
    });

    // ED-3 and ENT-5, before any money moves. Ownership is only checked for a signed-in buyer paying with
    // their own verified email, so the answer never reveals what another address owns.
    const identity = await ctx.auth.getUserIdentity();
    const typedEmail = args.email.trim().toLowerCase();
    const check = await ctx.runQuery(internal.fulfilment.checkoutCheck, {
      stripeProductIds: lineItems.map((item) => item.price_data.product),
      now: Date.now(),
      clerkId: identity?.subject,
      ownEmail: Boolean(identity?.email) && identity!.email!.trim().toLowerCase() === typedEmail,
    });
    if (check.notYetLive) fail('NOT_YET_LIVE', 'This release is not out yet.');
    if (check.alreadyOwned) fail('ALREADY_OWNED', 'You already own this. It is in your dashboard.');

    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      customer_email: args.email.trim(),
      line_items: lineItems,
      payment_intent_data: {
        // What the buyer's receipt and the Stripe dashboard call this payment. The name at the top of the
        // checkout page itself is the account's public business name, which only the Stripe dashboard sets.
        description: 'LIT [Live In Truth] - Myind Sound',
      },
      metadata: {
        products: args.withUpsell ? 'LIT,THE_SOURCE' : 'LIT',
        lit_amount: (args.amountCents / 100).toFixed(2),
        marketing_consent: args.marketingConsent ? 'true' : 'false',
      },
      // Back through the success page: it claims the account and signs them in (`purchase-signin.ts`)
      // before handing them on to the player, so nobody meets a sign-in form for something they bought.
      success_url: `${siteUrl()}/success?session_id={CHECKOUT_SESSION_ID}`,
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
      if (product.downloadFile) {
        downloads.push({
          name: `${product.name} (Digital EP)`,
          url: await fileUrl(ctx, product.downloadFile),
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

/**
 * Full songs straight after paying, without signing in: same 24-hour window as the downloads, checked against
 * the paid Stripe session. Signing in is what makes it permanent.
 */
export const streamForCheckoutSession = action({
  args: { sessionId: v.string(), product: v.string() },
  handler: async (ctx, { sessionId, product }): Promise<{ tracks: PlayerTrack[]; expiresAt: number }> => {
    if (!isCheckoutSessionId(sessionId)) fail('INVALID_INPUT', 'That checkout link is not valid.');
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isPaidSession(session)) fail('SESSION_NOT_PAID', 'This checkout has not been paid.');
    if (!withinDownloadWindow(session.created, Date.now())) {
      fail('DOWNLOAD_WINDOW_CLOSED', 'This link has expired. Sign in to keep listening.');
    }

    const lineItems = await listLineItems(stripe, session.id);
    const stripeProductIds = lineItems.map(lineItemProductId).filter((id): id is string => Boolean(id));
    const products = await ctx.runQuery(internal.fulfilment.productsByStripeIds, { stripeProductIds });
    if (!products.some((candidate) => candidate.slug === product)) {
      fail('NOT_ENTITLED', 'That checkout did not include this release.');
    }
    return playerTracks(ctx, product);
  },
});

/**
 * The account a buyer already paid for, handed to them signed in.
 *
 * Paying and typing an email is the whole sign-up: this checks the checkout with Stripe, makes sure the
 * account and the licence exist (the webhook usually got there first; this is the same idempotent path),
 * and returns a single-use Clerk ticket the site turns into a session. Held to the same 24-hour window as
 * the downloads, because the checkout id is what proves the purchase.
 */
export const claimAccountForCheckoutSession = action({
  args: { sessionId: v.string() },
  handler: async (ctx, { sessionId }): Promise<{ ticket: string | null; email: string }> => {
    if (!isCheckoutSessionId(sessionId)) fail('INVALID_INPUT', 'That checkout link is not valid.');
    const stripe = stripeClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId);
    if (!isPaidSession(session)) fail('SESSION_NOT_PAID', 'This checkout has not been paid.');
    if (!withinDownloadWindow(session.created, Date.now())) {
      fail('DOWNLOAD_WINDOW_CLOSED', 'This link has expired. Sign in to reach your dashboard.');
    }
    const email = sessionEmail(session);
    if (!email) fail('INVALID_INPUT', 'That checkout has no email on it.');

    // Idempotent: if the webhook has already run this is a no-op, and if it hasn't the buyer doesn't wait.
    // A retired (deleted account) or refunded session is not claimed, and nothing is recreated for it.
    const outcome = await fulfilSession(ctx, stripe, session);
    if (outcome === 'retired' || outcome === 'revoked') return { ticket: null, email };

    // The account that holds this session's licence, which is not always the account the email finds today
    // (the buyer may have changed their email since). Unbound sessions fall back to the email.
    const holder = await ctx.runQuery(internal.fulfilment.sessionHolder, { sessionId: session.id });
    if (holder.status === 'retired') return { ticket: null, email };
    let account: ClerkAccount | null;
    if (holder.status === 'held') {
      // Usually the email still finds the holder (and says whether the lookup was unambiguous); if it now finds
      // someone else, read the holder directly. Never creates an account for a session that already has one.
      const byEmail = await findClerkAccount(email);
      account = byEmail?.id === holder.clerkId ? byEmail : await getClerkAccount(holder.clerkId);
    } else {
      account = await findOrCreateClerkAccount(email, session.customer_details?.name ?? undefined, session.id);
    }
    // A paid checkout proves payment, not ownership of the email: only the account this checkout created, never
    // yet signed into and not an admin address, may be signed into from it. Everyone else gets no ticket and
    // goes through the normal email-checked sign-in. The holder account is held to the same rule.
    if (!account || !mayIssueCheckoutTicket({ account, sessionId: session.id, isAdminEmail: isAdminEmail(email) })) {
      return { ticket: null, email };
    }
    return { ticket: await createSignInTicket(account.id), email };
  },
});

// Run with: npx convex run payments:rebuildFromStripe '{"dryRun":true}'
// Output is counts only. Never add customer identifiers to the return value or logs.
// Refunded sessions are never granted (`revoked`). A paid session with no licence or ref of its own (a buyer
// who paid twice before refs existed) is recorded as an extra payment on the licence they own, so ED-0 runs
// this first (docs/app-v1/RUNBOOK-ED0.md).
// It never creates an account unless `createAccounts: true`: before the app, deleting an account deleted its
// licence, so a deleted buyer's paid session looks unfulfilled, and recreating their Clerk account, profile and
// CRM contact would undo the deletion. Those sessions are counted as `no_account` for a person to check.
export const rebuildFromStripe = internalAction({
  args: { dryRun: v.boolean(), createdAfterSec: v.optional(v.number()), createAccounts: v.optional(v.boolean()) },
  handler: async (ctx, { dryRun, createdAfterSec, createAccounts = false }) => {
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
          outcomes.push(await fulfilSession(ctx, stripe, session, undefined, createAccounts));
          continue;
        }
        if (session.metadata?.order_type === 'physical') {
          outcomes.push('physical');
          continue;
        }
        if (await paymentRevoked(stripe, session)) {
          outcomes.push('revoked');
          continue;
        }
        const lineItems = await listLineItems(stripe, session.id);
        const stripeProductIds = lineItems.map(lineItemProductId).filter((id): id is string => Boolean(id));
        const products = await ctx.runQuery(internal.fulfilment.productsByStripeIds, { stripeProductIds });
        if (products.length === 0) {
          outcomes.push('unmatched');
          continue;
        }
        const email = sessionEmail(session)!;
        outcomes.push(createAccounts || (await findClerkAccount(email)) ? 'granted' : 'no_account');
      } catch (err) {
        // Counts only, no customer data: the message says which step failed.
        console.error('rebuildFromStripe: session failed:', errorMessage(err));
        outcomes.push('error');
      }
    }
    return { dryRun, ...summariseRebuild(outcomes) };
  },
});

/**
 * Read-only checks for the things that break quietly: which Stripe account the keys belong to, whether
 * accounts are wired up, and what the last few checkouts did. Internal only, and it never returns a key,
 * an email or a name: booleans, ids and counts, so a session transcript stays free of customer data.
 *
 *   npx convex run diagnostics:config --prod
 *   npx convex run diagnostics:recentCheckouts '{"limit":5}' --prod
 */
import Stripe from 'stripe';
import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalQuery } from './_generated/server';
import { createSignInTicket, deleteClerkUser, findOrCreateClerkUser } from './lib/clerkApi';

function stripe(): Stripe | null {
  const key = process.env.STRIPE_SECRET_KEY;
  return key ? new Stripe(key, { httpClient: Stripe.createFetchHttpClient() }) : null;
}

/** Slugs and the Stripe products they buy. */
export const productIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('products').collect();
    return rows.map((row) => ({ slug: row.slug, name: row.name, stripeProductIds: row.stripeProductIds }));
  },
});

export const config = internalAction({
  args: {},
  handler: async (ctx): Promise<Record<string, unknown>> => {
    const client = stripe();
    const out: Record<string, unknown> = {
      stripeKey: Boolean(process.env.STRIPE_SECRET_KEY),
      stripeWebhookSecret: Boolean(process.env.STRIPE_WEBHOOK_SECRET),
      clerkSecret: Boolean(process.env.CLERK_SECRET_KEY),
      clerkIssuer: process.env.CLERK_JWT_ISSUER_DOMAIN ?? null,
      siteUrl: process.env.SITE_URL ?? null,
      productLit: process.env.STRIPE_PRODUCT_ID_LIT ?? null,
      productSource: process.env.STRIPE_PRODUCT_ID_SOURCE ?? null,
    };
    if (!client) return out;

    // Whose account the money lands in, and what the checkout page says at the top.
    const account = await client.accounts.retrieve();
    out.stripeAccountId = account.id;
    out.stripeDashboardName = account.settings?.dashboard?.display_name ?? null;
    // What the checkout page prints above the product, and what Link shows as the merchant.
    out.stripeBusinessProfileName = account.business_profile?.name ?? null;
    out.stripeStatementDescriptor = account.settings?.payments?.statement_descriptor ?? null;
    out.stripeBrandingIcon = Boolean(account.settings?.branding?.icon);
    out.stripeBrandingLogo = Boolean(account.settings?.branding?.logo);

    // The ids the checkout actually uses live on the products table, not in the environment.
    const products = await ctx.runQuery(internal.diagnostics.productIds, {});
    out.products = await Promise.all(
      products.flatMap((row) =>
        row.stripeProductIds.map(async (id) => {
          try {
            const product = await client.products.retrieve(id);
            return { slug: row.slug, id, name: product.name, images: product.images };
          } catch {
            return { slug: row.slug, id, name: null, images: [] };
          }
        }),
      ),
    );
    return out;
  },
});

/** The last few checkouts: ids, whether they were paid and when. No customer details. */
export const recentCheckouts = internalAction({
  args: { limit: v.optional(v.number()) },
  handler: async (_ctx, { limit }): Promise<{ id: string; paid: boolean; created: number; hasEmail: boolean }[]> => {
    const client = stripe();
    if (!client) return [];
    const sessions = await client.checkout.sessions.list({ limit: Math.min(limit ?? 5, 20) });
    return sessions.data.map((session) => ({
      id: session.id,
      paid: session.payment_status === 'paid',
      created: session.created,
      hasEmail: Boolean(session.customer_details?.email ?? session.customer_email),
    }));
  },
});

/** Points a release's Stripe products at the current cover, so the checkout page stops showing old art. */
export const setProductArt = internalAction({
  args: { slug: v.string(), imageUrl: v.string(), name: v.optional(v.string()) },
  handler: async (ctx, { slug, imageUrl, name }): Promise<{ id: string; name: string; images: string[] }[]> => {
    const client = stripe();
    if (!client) return [];
    const products = await ctx.runQuery(internal.diagnostics.productIds, {});
    const ids = products.filter((row) => row.slug === slug).flatMap((row) => row.stripeProductIds);
    const updated = [];
    for (const id of ids) {
      const product = await client.products.update(id, { images: [imageUrl], ...(name ? { name } : {}) });
      updated.push({ id: product.id, name: product.name, images: product.images });
    }
    return updated;
  },
});

/**
 * Walks the post-purchase account claim for a checkout and says which step worked. Never returns the
 * ticket itself, only whether one could be minted.
 *
 *   npx convex run diagnostics:claimCheck '{"sessionId":"cs_live_..."}' --prod
 */
export const claimCheck = internalAction({
  args: { sessionId: v.string() },
  handler: async (_ctx, { sessionId }): Promise<Record<string, unknown>> => {
    const client = stripe();
    if (!client) return { stripe: false };
    const out: Record<string, unknown> = {};
    try {
      const session = await client.checkout.sessions.retrieve(sessionId);
      out.paid = session.payment_status === 'paid';
      out.hasEmail = Boolean(session.customer_details?.email ?? session.customer_email);
      out.ageHours = Math.round(((Date.now() / 1000 - session.created) / 3600) * 10) / 10;
      const email = session.customer_details?.email ?? session.customer_email;
      if (!email) return { ...out, step: 'no email on the checkout' };
      const clerkId = await findOrCreateClerkUser(email);
      out.clerkUser = Boolean(clerkId);
      const ticket = await createSignInTicket(clerkId);
      out.ticketMinted = ticket.length > 0;
      return out;
    } catch (err) {
      return { ...out, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

/**
 * A throwaway account and a ticket for it, so the browser half of the post-purchase sign-in can be tested
 * without touching a real buyer. Delete it afterwards with `dropTestAccount`.
 */
export const testTicket = internalAction({
  args: {},
  handler: async (): Promise<{ clerkId: string; ticket: string }> => {
    const clerkId = await findOrCreateClerkUser('lit-signin-test@myindsound.com', 'Sign In Test');
    return { clerkId, ticket: await createSignInTicket(clerkId, 900) };
  },
});

export const dropTestAccount = internalAction({
  args: { clerkId: v.string() },
  handler: async (_ctx, { clerkId }): Promise<{ deleted: boolean }> => ({ deleted: await deleteClerkUser(clerkId) }),
});

/**
 * Tries to set the name the checkout page prints above the product. Stripe usually refuses to let an
 * account update itself outside Connect, in which case this reports the refusal and it has to be changed
 * in the Stripe dashboard (Settings > Business > Public details).
 */
export const setBusinessName = internalAction({
  args: { name: v.string(), statementDescriptor: v.optional(v.string()) },
  handler: async (_ctx, { name, statementDescriptor }): Promise<Record<string, unknown>> => {
    const client = stripe();
    if (!client) return { stripe: false };
    const account = await client.accounts.retrieve();
    try {
      const updated = await client.accounts.update(account.id, {
        business_profile: { name },
        ...(statementDescriptor ? { settings: { payments: { statement_descriptor: statementDescriptor } } } : {}),
      });
      return {
        businessProfileName: updated.business_profile?.name ?? null,
        statementDescriptor: updated.settings?.payments?.statement_descriptor ?? null,
      };
    } catch (err) {
      return { refused: err instanceof Error ? err.message : String(err) };
    }
  },
});

/** How many accounts and licences exist. Counts only, so nothing about a customer leaves the database. */
export const counts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const [users, entitlements, orders] = await Promise.all([
      ctx.db.query('users').collect(),
      ctx.db.query('entitlements').collect(),
      ctx.db.query('orders').collect(),
    ]);
    return { users: users.length, entitlements: entitlements.length, orders: orders.length };
  },
});

/**
 * Moving the site onto a production Clerk instance.
 *
 * Accounts do not transfer between Clerk instances, so once the new keys are in place this recreates each
 * one on the new instance from the email already on the `users` row and rewrites `clerkId`, which is what
 * every licence, order and play is keyed on. Buyers keep what they bought and sign in with the same email.
 *
 * Order of work (the first three are Clerk dashboard and hosting steps, not code):
 *   1. Create the production instance in Clerk, add the DNS records it asks for, and add the `convex` JWT
 *      template to it.
 *   2. Convex (production): set CLERK_SECRET_KEY and CLERK_JWT_ISSUER_DOMAIN to the new instance's values.
 *   3. Netlify: set VITE_CLERK_PUBLISHABLE_KEY to the new publishable key and redeploy.
 *   4. npx convex run clerkMigration:rebuild '{"dryRun":true}' --prod   (counts only, nothing written)
 *   5. npx convex run clerkMigration:rebuild '{"dryRun":false}' --prod
 *
 * Returns counts only: no email or name ever leaves the database through this.
 */
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, internalQuery } from './_generated/server';
import { findOrCreateClerkUser } from './lib/clerkApi';

export const accounts = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('users').collect();
    return rows.map((row) => ({ id: row._id, email: row.email, name: row.name, clerkId: row.clerkId }));
  },
});

export const setClerkId = internalMutation({
  args: { id: v.id('users'), clerkId: v.string() },
  handler: async (ctx, { id, clerkId }) => {
    await ctx.db.patch(id, { clerkId });
  },
});

export const rebuild = internalAction({
  args: { dryRun: v.boolean() },
  handler: async (ctx, { dryRun }): Promise<Record<string, number | boolean>> => {
    const rows: { id: Id<'users'>; email: string; name?: string; clerkId: string }[] = await ctx.runQuery(
      internal.clerkMigration.accounts,
      {},
    );
    let moved = 0;
    let unchanged = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        // Finds the account if the new instance already has that email, creates it if not.
        const clerkId = await findOrCreateClerkUser(row.email, row.name);
        if (clerkId === row.clerkId) {
          unchanged++;
          continue;
        }
        if (!dryRun) await ctx.runMutation(internal.clerkMigration.setClerkId, { id: row.id, clerkId });
        moved++;
      } catch {
        failed++;
      }
    }
    return { total: rows.length, moved, unchanged, failed, dryRun };
  },
});

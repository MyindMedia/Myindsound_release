import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalAction, internalQuery } from './_generated/server';
import { GHL_RETRY_DELAYS_MS, purchaseTags } from './ghlLogic';
import { ghlConfigured, upsertGhlContact } from './lib/ghlApi';

export const contactFor = internalQuery({
  args: { userId: v.id('users') },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    if (!user) return null;
    return { email: user.email, consent: user.marketingConsentAt !== undefined };
  },
});

// Runs after fulfilment. Failures retry on a schedule and never block access.
export const syncPurchase = internalAction({
  args: { userId: v.id('users'), slugs: v.array(v.string()), physical: v.boolean(), attempt: v.number() },
  handler: async (ctx, args) => {
    if (!ghlConfigured()) return { skipped: true };
    const contact = await ctx.runQuery(internal.ghl.contactFor, { userId: args.userId });
    if (!contact?.email) return { skipped: true };
    try {
      await upsertGhlContact({
        email: contact.email,
        tags: purchaseTags({ slugs: args.slugs, physical: args.physical, consent: contact.consent }),
        source: args.physical ? 'Physical Store' : 'Stream Automation',
      });
      return { skipped: false };
    } catch (err) {
      const delay = GHL_RETRY_DELAYS_MS[args.attempt];
      const reason = err instanceof Error ? err.message : 'unknown error';
      if (delay === undefined) {
        console.error(`ghl sync gave up for user ${args.userId}: ${reason}`);
      } else {
        console.warn(`ghl sync retry ${args.attempt + 1} for user ${args.userId}: ${reason}`);
        await ctx.scheduler.runAfter(delay, internal.ghl.syncPurchase, { ...args, attempt: args.attempt + 1 });
      }
      return { skipped: false };
    }
  },
});

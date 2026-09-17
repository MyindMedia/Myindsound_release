import { v } from 'convex/values';
import { internal } from './_generated/api';
import { action, internalMutation } from './_generated/server';
import { leadTags } from './ghlLogic';
import { fail } from './lib/errors';
import { ghlConfigured, upsertGhlContact } from './lib/ghlApi';

export const recordConsent = internalMutation({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique();
    if (user && !user.marketingConsentAt) await ctx.db.patch(user._id, { marketingConsentAt: Date.now() });
  },
});

// Email step of the checkout modal. Nothing is sent to the CRM without an explicit opt-in.
export const capture = action({
  args: { email: v.string(), marketingConsent: v.boolean() },
  handler: async (ctx, { email, marketingConsent }) => {
    const trimmed = email.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) fail('INVALID_INPUT', 'Enter a valid email address.');
    if (!marketingConsent) return { stored: false };

    const identity = await ctx.auth.getUserIdentity();
    if (identity) await ctx.runMutation(internal.leads.recordConsent, { clerkId: identity.subject });

    if (!ghlConfigured()) return { stored: false };
    try {
      await upsertGhlContact({ email: trimmed, tags: leadTags(true), source: 'LIT Release Page' });
      return { stored: true };
    } catch (err) {
      console.warn(`lead capture failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      return { stored: false };
    }
  },
});

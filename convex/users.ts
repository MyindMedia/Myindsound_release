import { v } from 'convex/values';
import { internalMutation, mutation, query } from './_generated/server';
import { ensureViewer, getViewer, isAdminUser } from './lib/auth';

export const ensure = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await ensureViewer(ctx);
    return { isAdmin: user.isAdmin };
  },
});

export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await getViewer(ctx);
    if (!user) return null;
    const identity = await ctx.auth.getUserIdentity();
    return {
      clerkId: user.clerkId,
      email: user.email,
      name: user.name ?? null,
      isAdmin: isAdminUser(user, identity?.email),
    };
  },
});

export const setAdmin = internalMutation({
  args: { clerkId: v.string(), isAdmin: v.boolean() },
  handler: async (ctx, { clerkId, isAdmin }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique();
    if (!user) return { updated: false };
    await ctx.db.patch(user._id, { isAdmin });
    return { updated: true };
  },
});

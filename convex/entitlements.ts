import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import { internalQuery, query, type QueryCtx } from './_generated/server';
import { getViewer } from './lib/auth';

export async function hasEntitlement(ctx: QueryCtx, userId: Id<'users'>, productId: Id<'products'>) {
  const row = await ctx.db
    .query('entitlements')
    .withIndex('by_user_product', (q) => q.eq('userId', userId).eq('productId', productId))
    .first();
  return row !== null;
}

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getViewer(ctx);
    if (!user) return [];
    const rows = await ctx.db
      .query('entitlements')
      .withIndex('by_user_product', (q) => q.eq('userId', user._id))
      .collect();
    const slugs = new Set<string>();
    for (const row of rows) {
      const product = await ctx.db.get(row.productId);
      if (product) slugs.add(product.slug);
    }
    return [...slugs];
  },
});

// For actions: resolves the caller and product, or null when not entitled.
export const check = internalQuery({
  args: { clerkId: v.string(), slug: v.string() },
  handler: async (ctx, { clerkId, slug }) => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique();
    const product = await ctx.db
      .query('products')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    if (!user || !product) return null;
    if (!(await hasEntitlement(ctx, user._id, product._id))) return null;
    return { userId: user._id, productId: product._id, downloadFile: product.downloadFile ?? null };
  },
});

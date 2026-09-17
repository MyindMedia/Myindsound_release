import { query } from './_generated/server';
import { getViewer } from './lib/auth';

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query('products').collect();
    return rows
      .filter((row) => row.active)
      .map((row) => ({ slug: row.slug, name: row.name, kind: row.kind, hasDownload: Boolean(row.downloadFile) }));
  },
});

/** Products the signed-in user owns, for the dashboard. */
export const owned = query({
  args: {},
  handler: async (ctx) => {
    const user = await getViewer(ctx);
    if (!user) return [];
    const entitlements = await ctx.db
      .query('entitlements')
      .withIndex('by_user_product', (q) => q.eq('userId', user._id))
      .collect();
    const products = [];
    for (const entitlement of entitlements) {
      const product = await ctx.db.get(entitlement.productId);
      if (product?.active) {
        products.push({
          slug: product.slug,
          name: product.name,
          coverUrl: product.coverUrl ?? null,
          hasDownload: Boolean(product.downloadFile),
          grantedAt: entitlement.grantedAt,
        });
      }
    }
    return products;
  },
});

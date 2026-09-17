import { internalMutation } from './_generated/server';

export const products = internalMutation({
  args: {},
  handler: async (ctx) => {
    const rows = [
      {
        slug: 'lit',
        name: 'LIT',
        kind: 'digital' as const,
        stripeProductIds: [process.env.STRIPE_PRODUCT_ID_LIT ?? 'prod_TsqOvYycMrdhnl'],
        active: true,
      },
      {
        slug: 'the-source',
        name: 'THE SOURCE (Presale)',
        kind: 'digital' as const,
        stripeProductIds: [process.env.STRIPE_PRODUCT_ID_SOURCE ?? 'prod_TsqUkQtzNQ5Y3z'],
        active: true,
      },
    ];
    let created = 0;
    for (const row of rows) {
      const existing = await ctx.db
        .query('products')
        .withIndex('by_slug', (q) => q.eq('slug', row.slug))
        .unique();
      if (existing) {
        // Keeps any uploaded download file (attached separately by the upload script).
        await ctx.db.patch(existing._id, row);
      } else {
        await ctx.db.insert('products', row);
        created++;
      }
    }
    return { created, total: rows.length };
  },
});

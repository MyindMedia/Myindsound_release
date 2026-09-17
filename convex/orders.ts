import { query } from './_generated/server';
import { getViewer } from './lib/auth';

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await getViewer(ctx);
    if (!user) return [];
    const orders = await ctx.db
      .query('orders')
      .withIndex('by_user', (q) => q.eq('userId', user._id))
      .order('desc')
      .collect();
    return await Promise.all(
      orders.map(async (order) => {
        const items = await ctx.db
          .query('orderItems')
          .withIndex('by_order', (q) => q.eq('orderId', order._id))
          .collect();
        return {
          id: order._id,
          createdAt: order.createdAt,
          status: order.status,
          totalCents: order.totalCents,
          currency: order.currency,
          itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
        };
      }),
    );
  },
});

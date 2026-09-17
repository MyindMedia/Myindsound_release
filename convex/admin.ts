import type { Id } from './_generated/dataModel';
import { query } from './_generated/server';
import { requireAdmin } from './lib/auth';

const RECENT = 10;

/** Play and purchase stats. Admin only; identifies listeners by Clerk ID, never by email. */
export const stats = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const [plays, users, entitlements, tracks, products] = await Promise.all([
      ctx.db.query('plays').collect(),
      ctx.db.query('users').collect(),
      ctx.db.query('entitlements').collect(),
      ctx.db.query('tracks').collect(),
      ctx.db.query('products').collect(),
    ]);
    const clerkIdFor = new Map(users.map((user) => [user._id, user.clerkId]));
    const titleFor = new Map(tracks.map((track) => [track._id, track.title]));
    const productFor = new Map(products.map((product) => [product._id, product.name]));

    const playsByTrack = new Map<Id<'tracks'>, number>();
    for (const play of plays) playsByTrack.set(play.trackId, (playsByTrack.get(play.trackId) ?? 0) + 1);

    return {
      totals: { plays: plays.length, users: users.length, purchases: entitlements.length },
      recentPlays: [...plays]
        .sort((a, b) => b.playedAt - a.playedAt)
        .slice(0, RECENT)
        .map((play) => ({
          track: titleFor.get(play.trackId) ?? 'Unknown track',
          listener: clerkIdFor.get(play.userId) ?? 'deleted user',
          playedAt: play.playedAt,
        })),
      recentPurchases: [...entitlements]
        .sort((a, b) => b.grantedAt - a.grantedAt)
        .slice(0, RECENT)
        .map((entitlement) => ({
          product: productFor.get(entitlement.productId) ?? 'Unknown product',
          buyer: clerkIdFor.get(entitlement.userId) ?? 'deleted user',
          grantedAt: entitlement.grantedAt,
        })),
      playsByTrack: [...playsByTrack.entries()]
        .map(([trackId, count]) => ({ track: titleFor.get(trackId) ?? 'Unknown track', count }))
        .sort((a, b) => b.count - a.count),
    };
  },
});

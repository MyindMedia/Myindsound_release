import { v } from 'convex/values';
import { internal } from './_generated/api';
import { internalMutation, mutation } from './_generated/server';
import { hasEntitlement } from './entitlements';
import { ensureViewer } from './lib/auth';
import { fail } from './lib/errors';

export const RETENTION_MS = 365 * 24 * 60 * 60 * 1000;
const PRUNE_BATCH = 500;

export const log = mutation({
  args: { trackId: v.id('tracks') },
  handler: async (ctx, { trackId }) => {
    const user = await ensureViewer(ctx);
    const track = await ctx.db.get(trackId);
    if (!track) fail('NOT_FOUND', 'Track not found.');
    if (!(await hasEntitlement(ctx, user._id, track.productId))) {
      fail('NOT_ENTITLED', 'No license found for this release.');
    }
    await ctx.db.insert('plays', { userId: user._id, trackId, playedAt: Date.now() });
  },
});

export const prune = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RETENTION_MS;
    const old = await ctx.db
      .query('plays')
      .withIndex('by_playedAt', (q) => q.lt('playedAt', cutoff))
      .take(PRUNE_BATCH);
    for (const row of old) await ctx.db.delete(row._id);
    if (old.length === PRUNE_BATCH) {
      await ctx.scheduler.runAfter(0, internal.plays.prune, {});
    }
    return { deleted: old.length };
  },
});

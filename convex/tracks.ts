import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, internalMutation, internalQuery } from './_generated/server';
import { fail } from './lib/errors';
import { signGetUrl, STREAM_URL_TTL_SECONDS } from './lib/r2';

export type PlayerTrack = {
  id: Id<'tracks'>;
  position: number;
  title: string;
  durationSeconds: number;
  format: 'mp3';
  streamUrl: string;
};

const trackInput = v.object({
  position: v.number(),
  title: v.string(),
  durationSeconds: v.number(),
  streamKey: v.string(),
  originalKey: v.string(),
});

export const seed = internalMutation({
  args: { slug: v.string(), tracks: v.array(trackInput) },
  handler: async (ctx, { slug, tracks }) => {
    const product = await ctx.db
      .query('products')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    if (!product) fail('NOT_FOUND', `No product with slug ${slug}. Run seed:products first.`);
    let upserted = 0;
    for (const track of tracks) {
      const existing = await ctx.db
        .query('tracks')
        .withIndex('by_product_position', (q) => q.eq('productId', product._id).eq('position', track.position))
        .unique();
      const row = { ...track, productId: product._id, format: 'mp3' as const };
      if (existing) await ctx.db.patch(existing._id, row);
      else await ctx.db.insert('tracks', row);
      upserted++;
    }
    return { upserted };
  },
});

export const listBySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const product = await ctx.db
      .query('products')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    if (!product) return [];
    return await ctx.db
      .query('tracks')
      .withIndex('by_product_position', (q) => q.eq('productId', product._id))
      .collect();
  },
});

export const listForPlayer = action({
  args: { product: v.string() },
  handler: async (ctx, { product }): Promise<{ tracks: PlayerTrack[]; expiresAt: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) fail('UNAUTHENTICATED', 'Sign in to listen.');
    const access = await ctx.runQuery(internal.entitlements.check, { clerkId: identity.subject, slug: product });
    if (!access) fail('NOT_ENTITLED', 'No license found for this release.');

    const rows = await ctx.runQuery(internal.tracks.listBySlug, { slug: product });
    const expiresAt = Date.now() + STREAM_URL_TTL_SECONDS * 1000;
    const tracks = await Promise.all(
      rows.map(async (row) => ({
        id: row._id,
        position: row.position,
        title: row.title,
        durationSeconds: row.durationSeconds,
        format: row.format,
        streamUrl: await signGetUrl(row.streamKey, STREAM_URL_TTL_SECONDS),
      })),
    );
    return { tracks, expiresAt };
  },
});

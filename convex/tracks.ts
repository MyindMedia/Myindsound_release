import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { fail } from './lib/errors';
import { fileUrl, LINK_REFRESH_MS } from './lib/storage';

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
});

async function productBySlug(ctx: Pick<QueryCtx, 'db'>, slug: string) {
  const product = await ctx.db
    .query('products')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .unique();
  if (!product) fail('NOT_FOUND', `No product with slug ${slug}. Run seed:products first.`);
  return product;
}

export const seed = internalMutation({
  args: { slug: v.string(), tracks: v.array(trackInput) },
  handler: async (ctx, { slug, tracks }) => {
    const product = await productBySlug(ctx, slug);
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

// Upload flow (scripts/upload-lit-audio.ts, run through `npx convex run`): get an upload URL, POST the file,
// then attach the returned storage id. Replaced files are deleted so storage never holds orphans.

export const generateUploadUrl = internalMutation({
  args: {},
  handler: async (ctx) => await ctx.storage.generateUploadUrl(),
});

/** sha256 (base64) of the files attached now, so reruns skip unchanged uploads. */
export const fileHashes = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const product = await productBySlug(ctx, slug);
    const hash = async (id: Id<'_storage'> | undefined) => (id ? ((await ctx.db.system.get(id))?.sha256 ?? null) : null);
    const tracks = await ctx.db
      .query('tracks')
      .withIndex('by_product_position', (q) => q.eq('productId', product._id))
      .collect();
    return {
      download: await hash(product.downloadFile),
      tracks: await Promise.all(
        tracks.map(async (track) => ({
          position: track.position,
          stream: await hash(track.streamFile),
          original: await hash(track.originalFile),
        })),
      ),
    };
  },
});

export const attachTrackFile = internalMutation({
  args: {
    slug: v.string(),
    position: v.number(),
    kind: v.union(v.literal('stream'), v.literal('original')),
    file: v.id('_storage'),
  },
  handler: async (ctx, { slug, position, kind, file }) => {
    const product = await productBySlug(ctx, slug);
    const track = await ctx.db
      .query('tracks')
      .withIndex('by_product_position', (q) => q.eq('productId', product._id).eq('position', position))
      .unique();
    if (!track) fail('NOT_FOUND', `No track ${position} on ${slug}. Seed the tracks first.`);
    const field = kind === 'stream' ? 'streamFile' : 'originalFile';
    const previous = track[field];
    await ctx.db.patch(track._id, { [field]: file });
    if (previous && previous !== file) await ctx.storage.delete(previous);
    return { replaced: Boolean(previous && previous !== file) };
  },
});

export const attachDownload = internalMutation({
  args: { slug: v.string(), file: v.id('_storage') },
  handler: async (ctx, { slug, file }) => {
    const product = await productBySlug(ctx, slug);
    const previous = product.downloadFile;
    await ctx.db.patch(product._id, { downloadFile: file });
    if (previous && previous !== file) await ctx.storage.delete(previous);
    return { replaced: Boolean(previous && previous !== file) };
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
    const tracks = await Promise.all(
      rows.map(async (row) => ({
        id: row._id,
        position: row.position,
        title: row.title,
        durationSeconds: row.durationSeconds,
        format: row.format,
        streamUrl: await fileUrl(ctx, row.streamFile),
      })),
    );
    return { tracks, expiresAt: Date.now() + LINK_REFRESH_MS };
  },
});

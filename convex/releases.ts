import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import {
  action,
  internalAction,
  internalMutation,
  internalQuery,
  mutation,
  query,
  type ActionCtx,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import type { DiscDesign } from '../packages/minidisc/src/design';
import { cleanReason, productBySlug, releaseSnapshot, userByEmail, validateReleasePatch } from './adminActions';
import { isAdminUser, requireAdmin } from './lib/auth';
import { fail } from './lib/errors';
import {
  BUNDLE_VERSION,
  MAX_IMAGE_STICKERS,
  MAX_SHUTTER_IMAGE_STICKERS,
  MAX_TRACK_TITLE,
  MAX_TRACKS,
  SHA256_HEX,
  UPLOAD_RULES,
  base64ToHex,
  buildDesign,
  checkCoverSize,
  checkDraftFacts,
  checkDuration,
  checkRackParts,
  checkSpriteMeta,
  checkStillSize,
  checkUpload,
  designHash,
  imageSize,
  publishProblems,
  refreshDesign,
  type FileKind,
  type PublishState,
  type ReleaseFacts,
  type UploadPurpose,
} from './releasesLogic';
import { spriteMetaValidator } from './schema';

/**
 * The release portal's backend (Grilled.md "Release portal + generated discs", PRD §17 ADM-7): a draft release is
 * created, gets its MP3s, cover, casing (DiscDesign), rack art and bundle, then is published. Admin only
 * (`requireAdmin`), and every change writes one `auditLog` row (ADM-6) against `product:<slug>`.
 *
 * Uploads go to Convex storage from the browser (`generateUploadUrl`), then an `attach*` action re-checks the file
 * on the server: its size from storage, its real format from its first bytes, image sizes from their headers, and
 * the bundle's SHA-256 against the one storage computed. A file that fails is deleted. Cover, rack art and bundle
 * are served from public storage URLs (they are not secret); audio stays gated behind `media.getStreamUrl`.
 *
 * The portal only edits drafts. The design, the rack art and the bundle carry the design hash they were made
 * from, so `publish` refuses art or a bundle rendered from an older design.
 */

/** Draft steps are routine; publishing asks the admin for a reason (ADM-6). */
const PORTAL_REASON = 'Release portal';

type Product = Doc<'products'>;

async function audit(
  ctx: MutationCtx,
  actorUserId: Id<'users'>,
  action: string,
  slug: string,
  before: unknown,
  after: unknown,
  reason = PORTAL_REASON,
): Promise<Id<'auditLog'>> {
  return await ctx.db.insert('auditLog', { actorUserId, action, target: `product:${slug}`, before, after, reason, at: Date.now() });
}

function requireDraft(product: Product): void {
  if (product.status !== 'draft') {
    fail('INVALID_INPUT', `${product.slug} is already published. The portal edits drafts only; use RELEASE settings.`);
  }
}

async function tracksOf(ctx: Pick<QueryCtx, 'db'>, productId: Id<'products'>): Promise<Doc<'tracks'>[]> {
  return await ctx.db
    .query('tracks')
    .withIndex('by_product_position', (q) => q.eq('productId', productId))
    .collect();
}

/** The facts a design must carry, or null while the draft has no cover or no tracks yet. */
async function factsFor(ctx: Pick<QueryCtx, 'db' | 'storage'>, product: Product): Promise<ReleaseFacts | null> {
  const tracks = await tracksOf(ctx, product._id);
  const coverUrl = product.coverFile ? await ctx.storage.getUrl(product.coverFile) : null;
  if (!coverUrl || tracks.length === 0) return null;
  const stickerUrls = await Promise.all((product.stickerFiles ?? []).map((id) => ctx.storage.getUrl(id)));
  const labelUrl = product.labelFile ? await ctx.storage.getUrl(product.labelFile) : null;
  return {
    slug: product.slug,
    title: product.name,
    artist: product.artist ?? '',
    year: product.year ?? new Date().getUTCFullYear(),
    coverUrl,
    stickerUrls: stickerUrls.filter((url): url is string => Boolean(url)),
    labelUrl,
    tracks: tracks.map((track) => ({ n: track.position, title: track.title, durationSec: track.durationSeconds })),
  };
}

/**
 * After the tracks or the cover change, the stored design takes the new facts and a new hash (so the rack art and
 * bundle made from the old one read as out of date). A design that no longer stands (no tracks) keeps its look for
 * the portal to preload but loses its hash, which blocks publishing until it is saved again.
 */
async function syncDesign(ctx: MutationCtx, productId: Id<'products'>): Promise<void> {
  const product = (await ctx.db.get(productId))!;
  if (!product.design) return;
  const facts = await factsFor(ctx, product);
  const rebuilt = facts ? buildDesign(refreshDesign(product.design as DiscDesign, facts), facts) : null;
  const next = rebuilt?.ok ? rebuilt.design : (product.design as DiscDesign);
  const hash = rebuilt?.ok ? await designHash(next) : undefined;
  if (hash === product.designHash) return;
  await ctx.db.patch(productId, { design: next, designHash: hash, designRev: (product.designRev ?? 0) + 1 });
}

/** Every storage id a product or track holds: an upload already in use can't be attached again or deleted. */
async function referencedFiles(ctx: Pick<QueryCtx, 'db'>): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const track of await ctx.db.query('tracks').collect()) {
    if (track.streamFile) ids.add(track.streamFile);
    if (track.originalFile) ids.add(track.originalFile);
  }
  for (const product of await ctx.db.query('products').collect()) {
    for (const id of [
      product.downloadFile,
      product.coverFile,
      product.bundleFile,
      product.rack?.spriteWebp,
      product.rack?.spritePng,
      product.rack?.still,
      product.rack?.stillWebp,
      ...(product.stickerFiles ?? []),
      product.labelFile,
    ]) {
      if (id) ids.add(id);
    }
  }
  return ids;
}

async function requireUnused(ctx: MutationCtx, files: (Id<'_storage'> | undefined)[]): Promise<void> {
  const used = await referencedFiles(ctx);
  if (files.some((id) => id && used.has(id))) fail('INVALID_INPUT', 'That upload is already in use. Upload the file again.');
}

async function deleteFiles(ctx: MutationCtx, files: (Id<'_storage'> | undefined)[]): Promise<void> {
  for (const id of files) if (id) await ctx.storage.delete(id);
}

function portalSnapshot(product: Product, trackCount?: number) {
  return {
    ...releaseSnapshot(product),
    active: product.active,
    title: product.name,
    artist: product.artist ?? null,
    year: product.year ?? null,
    coverFile: product.coverFile ?? null,
    designHash: product.designHash ?? null,
    designRev: product.designRev ?? null,
    rackDesignHash: product.rack?.designHash ?? null,
    bundleDesignHash: product.bundleDesignHash ?? null,
    ...(trackCount === undefined ? {} : { tracks: trackCount }),
  };
}

async function publishStateOf(ctx: Pick<QueryCtx, 'db'>, product: Product): Promise<PublishState> {
  const tracks = await tracksOf(ctx, product._id);
  return {
    status: product.status,
    tracks: tracks.map((track) => ({ position: track.position, hasAudio: Boolean(track.streamFile), durationSeconds: track.durationSeconds })),
    hasCover: Boolean(product.coverFile),
    designHash: product.designHash ?? null,
    rackDesignHash: product.rack?.designHash ?? null,
    rackHasStill: Boolean(product.rack?.still),
    bundleDesignHash: product.bundleDesignHash ?? null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// What the app sees (app.library, app.context)

export type RackInfo = {
  /**
   * The rack image: the release in its printed sleeve, the disc inside, one still render (`renderSleeveStill`),
   * PNG with alpha, square, at least 1024 px. The app's grid shows this, statically.
   */
  stillUrl: string;
  /** The same render as WebP with alpha, or null when the portal's browser couldn't encode WebP. */
  stillWebpUrl: string | null;
  /** Optional, unused by the grid: the older spin loop sheet (WebP when there is one, else PNG), or null. */
  spriteUrl: string | null;
  spriteFormat: 'webp' | 'png' | null;
  spriteMeta: { frames: number; cols: number; rows: number; frameW: number; frameH: number; sheetW: number; sheetH: number; fps: number; format: string } | null;
  /** The PNG sheet (same layout), or null without a loop. */
  pngSpriteUrl: string | null;
};

/** The published design, or null (LIT has none: iOS uses its built-in LIT bundle and sleeve art). Never a draft's. */
export function publishedDesign(product: Product): DiscDesign | null {
  if (product.status === 'draft' || !product.design || !product.designHash) return null;
  return product.design as DiscDesign;
}

/** The rack's still (and the optional spin loop) as serving URLs, or null (LIT, drafts, no still). */
export async function rackOf(ctx: Pick<QueryCtx, 'storage'>, product: Product): Promise<RackInfo | null> {
  const rack = product.rack;
  if (!rack || product.status === 'draft') return null;
  const url = (id: Id<'_storage'> | undefined) => (id ? ctx.storage.getUrl(id) : Promise.resolve(null));
  const [still, stillWebp, webp, png] = await Promise.all([url(rack.still), url(rack.stillWebp), url(rack.spriteWebp), url(rack.spritePng)]);
  if (!still) return null;
  const loop = png && rack.spriteMeta ? { png, webp } : null;
  return {
    stillUrl: still,
    stillWebpUrl: stillWebp,
    spriteUrl: loop ? (loop.webp ?? loop.png) : null,
    spriteFormat: loop ? (loop.webp ? 'webp' : 'png') : null,
    spriteMeta: loop && rack.spriteMeta ? { ...rack.spriteMeta, format: loop.webp ? 'image/webp' : 'image/png' } : null,
    pngSpriteUrl: loop ? loop.png : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Admin checks for actions (auth reaches runQuery from the calling action)

export const adminUserId = internalQuery({
  args: {},
  handler: async (ctx): Promise<Id<'users'>> => (await requireAdmin(ctx))._id,
});

/** The CLI publish script runs with deployment rights; it names the admin the audit row is written for. */
export const adminUserIdByEmail = internalQuery({
  args: { email: v.string() },
  handler: async (ctx, { email }): Promise<Id<'users'>> => {
    const user = await userByEmail(ctx, email);
    if (!user || !isAdminUser(user, email)) fail('FORBIDDEN', 'That email is not an admin account.');
    return user._id;
  },
});

export const fileInfo = internalQuery({
  args: { id: v.id('_storage') },
  handler: async (ctx, { id }) => {
    const row = await ctx.db.system.get(id);
    return row ? { size: row.size, sha256: row.sha256, contentType: row.contentType ?? null } : null;
  },
});

export const isReferenced = internalQuery({
  args: { ids: v.array(v.id('_storage')) },
  handler: async (ctx, { ids }) => {
    const used = await referencedFiles(ctx);
    return ids.map((id) => used.has(id));
  },
});

type Inspected = { id: Id<'_storage'>; kind: FileKind; size: number; sha256Hex: string; head: Uint8Array };

/** Deletes uploads that failed a check (never a file something already uses). */
async function discard(ctx: ActionCtx, ids: Id<'_storage'>[]): Promise<void> {
  if (ids.length === 0) return;
  const used: boolean[] = await ctx.runQuery(internal.releases.isReferenced, { ids });
  for (const [i, id] of ids.entries()) {
    if (!used[i]) await ctx.storage.delete(id).catch(() => undefined);
  }
}

/** One upload, re-checked on the server: stored size, sniffed format, declared type. */
async function inspect(ctx: ActionCtx, id: Id<'_storage'>, purpose: UploadPurpose): Promise<Inspected> {
  const info: { size: number; sha256: string; contentType: string | null } | null = await ctx.runQuery(internal.releases.fileInfo, { id });
  const blob = info ? await ctx.storage.get(id) : null;
  if (!info || !blob) fail('NOT_FOUND', 'The upload was not found. Upload the file again.');
  const head = new Uint8Array(await blob.slice(0, UPLOAD_RULES[purpose].headBytes).arrayBuffer());
  const checked = checkUpload(purpose, info, head);
  if ('error' in checked) fail('INVALID_INPUT', checked.error);
  return { id, kind: checked.kind, size: info.size, sha256Hex: base64ToHex(info.sha256), head };
}

/** Runs the checks and the attach; on any failure the new uploads are deleted, so storage keeps no orphans. */
async function attaching<T>(ctx: ActionCtx, uploads: Id<'_storage'>[], run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    await discard(ctx, uploads);
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Queries

/** Drafts, newest first, with how far each got (the portal's resume list). */
export const drafts = query({
  args: {},
  handler: async (ctx) => {
    await requireAdmin(ctx);
    const products = (await ctx.db.query('products').collect()).filter((p) => p.kind === 'digital' && p.status === 'draft');
    const rows = [];
    for (const product of products.sort((a, b) => b._creationTime - a._creationTime)) {
      const state = await publishStateOf(ctx, product);
      rows.push({
        slug: product.slug,
        title: product.name,
        artist: product.artist ?? null,
        year: product.year ?? null,
        createdAt: product._creationTime,
        tracks: state.tracks.length,
        tracksWithAudio: state.tracks.filter((t) => t.hasAudio).length,
        hasCover: state.hasCover,
        hasDesign: state.designHash !== null,
        rackFresh: state.designHash !== null && state.rackDesignHash === state.designHash,
        bundleFresh: state.designHash !== null && state.bundleDesignHash === state.designHash,
        ready: publishProblems(state).length === 0,
      });
    }
    return rows;
  },
});

/** One release's whole portal state, to resume a draft at any step. */
export const get = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    await requireAdmin(ctx);
    const product = await productBySlug(ctx, slug);
    const tracks = await tracksOf(ctx, product._id);
    const state = await publishStateOf(ctx, product);
    const rack = product.rack;
    const url = (id: Id<'_storage'> | undefined) => (id ? ctx.storage.getUrl(id) : Promise.resolve(null));
    return {
      releaseId: product._id,
      slug: product.slug,
      title: product.name,
      artist: product.artist ?? null,
      year: product.year ?? null,
      status: product.status ?? 'live',
      active: product.active,
      dropAt: product.dropAt ?? null,
      tracks: tracks.map((track) => ({
        id: track._id,
        position: track.position,
        title: track.title,
        durationSeconds: track.durationSeconds,
        hasAudio: Boolean(track.streamFile),
      })),
      coverUrl: await url(product.coverFile),
      // Pairs the portal matches against `design.stickers[].src` (an image sticker's own file, for its REMOVE button).
      stickerFiles: await Promise.all((product.stickerFiles ?? []).map(async (file) => ({ file, url: (await url(file))! }))),
      // The uploaded label image (`design.labelImage.src` when it is in use), or null.
      labelUrl: await url(product.labelFile),
      design: (product.design as DiscDesign | undefined) ?? null,
      designHash: product.designHash ?? null,
      designRev: product.designRev ?? 0,
      rack: rack
        ? {
            stillUrl: await url(rack.still),
            stillWebpUrl: await url(rack.stillWebp),
            spriteUrl: (await url(rack.spriteWebp)) ?? (await url(rack.spritePng)),
            spriteMeta: rack.spriteMeta ?? null,
            fresh: rack.designHash === product.designHash,
          }
        : null,
      bundle:
        product.bundleVersion && product.bundleUrl && product.bundleSha256
          ? {
              version: product.bundleVersion,
              url: product.bundleUrl,
              sha256: product.bundleSha256,
              fresh: Boolean(product.designHash) && product.bundleDesignHash === product.designHash,
            }
          : null,
      problems: publishProblems(state),
    };
  },
});

/** For `scripts/publish-release.ts`: the saved design and what the manifest needs. */
export const designForPublish = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const product = await productBySlug(ctx, slug);
    if (!product.design || !product.designHash) fail('INVALID_INPUT', 'Save the casing in the portal first.');
    return {
      releaseId: product._id,
      design: product.design as DiscDesign,
      designHash: product.designHash,
      designRev: product.designRev ?? 0,
      status: product.status ?? 'live',
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Draft, tracks and design (mutations)

/** Step 1: a new digital product, draft and inactive, so nothing public lists it until it is published. */
export const createDraft = mutation({
  args: { slug: v.string(), title: v.string(), artist: v.string(), year: v.number() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const facts = { slug: args.slug.trim(), title: args.title.trim(), artist: args.artist.trim(), year: args.year };
    const problems = checkDraftFacts(facts);
    if (problems.length > 0) fail('INVALID_INPUT', problems.join(' '));
    const taken = await ctx.db
      .query('products')
      .withIndex('by_slug', (q) => q.eq('slug', facts.slug))
      .first();
    if (taken) fail('INVALID_INPUT', `The slug ${facts.slug} is taken.`);
    const id = await ctx.db.insert('products', {
      slug: facts.slug,
      name: facts.title,
      artist: facts.artist,
      year: facts.year,
      kind: 'digital',
      stripeProductIds: [],
      active: false,
      status: 'draft',
    });
    const product = (await ctx.db.get(id))!;
    const auditId = await audit(ctx, admin._id, 'release.create', facts.slug, null, portalSnapshot(product, 0));
    return { slug: facts.slug, releaseId: id, auditId };
  },
});

/** An upload URL for any portal file (audio, cover, rack art, bundle). Changes nothing, so nothing is audited. */
export const generateUploadUrl = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    await requireAdmin(ctx);
    requireDraft(await productBySlug(ctx, slug));
    return await ctx.storage.generateUploadUrl();
  },
});

/** Step 2: the order and titles. Tracks left out of the list are removed, with their audio. */
export const setTracks = mutation({
  args: { slug: v.string(), tracks: v.array(v.object({ trackId: v.id('tracks'), title: v.string() })) },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const product = await productBySlug(ctx, args.slug);
    requireDraft(product);
    const current = await tracksOf(ctx, product._id);
    const byId = new Map(current.map((track) => [track._id as string, track]));
    const seen = new Set<string>();
    for (const { trackId, title } of args.tracks) {
      if (!byId.has(trackId)) fail('INVALID_INPUT', 'A track in the list is not on this release. Reload and try again.');
      if (seen.has(trackId)) fail('INVALID_INPUT', 'A track is listed twice.');
      seen.add(trackId);
      const clean = title.trim();
      if (!clean) fail('INVALID_INPUT', 'Every track needs a title.');
      if (clean.length > MAX_TRACK_TITLE) fail('INVALID_INPUT', `Track titles must be ${MAX_TRACK_TITLE} characters or fewer.`);
    }
    const before = current.map((track) => ({ id: track._id, position: track.position, title: track.title }));
    const removed = current.filter((track) => !seen.has(track._id));
    for (const track of removed) {
      await ctx.db.delete(track._id);
      await deleteFiles(ctx, [track.streamFile, track.originalFile]);
    }
    for (const [index, { trackId, title }] of args.tracks.entries()) {
      await ctx.db.patch(trackId, { position: index + 1, title: title.trim() });
    }
    await syncDesign(ctx, product._id);
    const after = (await tracksOf(ctx, product._id)).map((track) => ({ id: track._id, position: track.position, title: track.title }));
    const auditId = await audit(ctx, admin._id, 'release.tracks', product.slug, before, after);
    return { tracks: after.length, removed: removed.length, auditId };
  },
});

/**
 * Step 4: the casing. The portal's look over the server's facts (`buildDesign`), checked by `validateDesign`.
 * Needs the tracks and the cover first. Every save bumps `designRev` and changes the hash when the look changed.
 */
export const saveDesign = mutation({
  args: { slug: v.string(), design: v.any() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const product = await productBySlug(ctx, args.slug);
    requireDraft(product);
    const facts = await factsFor(ctx, product);
    if (!facts) fail('INVALID_INPUT', 'Upload the tracks and the cover before the casing.');
    const result = buildDesign(args.design, facts);
    if (!result.ok) fail('INVALID_INPUT', `The design is not valid: ${result.errors.slice(0, 8).join('; ')}`);
    const hash = await designHash(result.design);
    const changed = hash !== product.designHash;
    const designRev = changed ? (product.designRev ?? 0) + 1 : (product.designRev ?? 0);
    if (changed) await ctx.db.patch(product._id, { design: result.design, designHash: hash, designRev });
    const look = (design: unknown) => {
      const d = design as Partial<DiscDesign> | undefined;
      return d
        ? {
            shell: d.shell ?? null,
            shellTint: d.shellTint ?? null,
            slideColor: d.slideColor ?? null,
            labelStyle: d.labelStyle ?? null,
            labelText: d.labelText ?? null,
            labelImage: Boolean(d.labelImage),
          }
        : null;
    };
    const auditId = await audit(
      ctx,
      admin._id,
      'release.design',
      product.slug,
      { designHash: product.designHash ?? null, ...look(product.design) },
      { designHash: hash, designRev, ...look(result.design) },
    );
    return { designHash: hash, designRev, changed, design: result.design, auditId };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Attaching uploads (actions check the bytes, internal mutations record and audit)

/** Step 2: one MP3. A new track goes on the end; with `trackId` it replaces that track's audio. */
export const attachTrackAudio = action({
  args: {
    slug: v.string(),
    file: v.id('_storage'),
    durationSec: v.number(),
    title: v.optional(v.string()),
    trackId: v.optional(v.id('tracks')),
  },
  handler: async (ctx, args): Promise<{ trackId: Id<'tracks'>; position: number; title: string }> => {
    const actorUserId: Id<'users'> = await ctx.runQuery(internal.releases.adminUserId, {});
    return await attaching(ctx, [args.file], async () => {
      const file = await inspect(ctx, args.file, 'audio');
      const problem = checkDuration(file.size, args.durationSec);
      if (problem) fail('INVALID_INPUT', problem);
      return await ctx.runMutation(internal.releases.recordTrackAudio, { ...args, sizeBytes: file.size, actorUserId });
    });
  },
});

export const recordTrackAudio = internalMutation({
  args: {
    actorUserId: v.id('users'),
    slug: v.string(),
    file: v.id('_storage'),
    durationSec: v.number(),
    sizeBytes: v.number(),
    title: v.optional(v.string()),
    trackId: v.optional(v.id('tracks')),
  },
  handler: async (ctx, args) => {
    const product = await productBySlug(ctx, args.slug);
    requireDraft(product);
    await requireUnused(ctx, [args.file]);
    const durationSeconds = Math.round(args.durationSec * 100) / 100;
    const title = (args.title ?? '').trim().slice(0, MAX_TRACK_TITLE);
    let trackId: Id<'tracks'>;
    let before: unknown = null;
    if (args.trackId) {
      const track = await ctx.db.get(args.trackId);
      if (!track || track.productId !== product._id) fail('NOT_FOUND', 'That track is not on this release.');
      before = { id: track._id, position: track.position, title: track.title, durationSeconds: track.durationSeconds };
      await ctx.db.patch(track._id, { streamFile: args.file, durationSeconds, ...(title ? { title } : {}) });
      if (track.streamFile && track.streamFile !== args.file) await ctx.storage.delete(track.streamFile);
      trackId = track._id;
    } else {
      const tracks = await tracksOf(ctx, product._id);
      if (tracks.length >= MAX_TRACKS) fail('INVALID_INPUT', `A release has at most ${MAX_TRACKS} tracks.`);
      const position = tracks.reduce((max, track) => Math.max(max, track.position), 0) + 1;
      trackId = await ctx.db.insert('tracks', {
        productId: product._id,
        position,
        title: title || `Track ${position}`,
        durationSeconds,
        format: 'mp3',
        streamFile: args.file,
      });
    }
    await syncDesign(ctx, product._id);
    const track = (await ctx.db.get(trackId))!;
    const after = { id: track._id, position: track.position, title: track.title, durationSeconds, sizeBytes: args.sizeBytes };
    await audit(ctx, args.actorUserId, 'release.track.audio', product.slug, before, after);
    return { trackId, position: track.position, title: track.title };
  },
});

/** Step 3: the cover. Square, at least 1024 px (read from the file's own header). */
export const attachCover = action({
  args: { slug: v.string(), file: v.id('_storage') },
  handler: async (ctx, args): Promise<{ coverUrl: string; width: number; height: number }> => {
    const actorUserId: Id<'users'> = await ctx.runQuery(internal.releases.adminUserId, {});
    return await attaching(ctx, [args.file], async () => {
      const file = await inspect(ctx, args.file, 'cover');
      const size = imageSize(file.head, file.kind);
      const problem = checkCoverSize(size);
      if (problem || !size) fail('INVALID_INPUT', problem ?? 'Could not read the image size.');
      const coverUrl: string = await ctx.runMutation(internal.releases.recordCover, { ...args, actorUserId, ...size });
      return { coverUrl, ...size };
    });
  },
});

export const recordCover = internalMutation({
  args: { actorUserId: v.id('users'), slug: v.string(), file: v.id('_storage'), width: v.number(), height: v.number() },
  handler: async (ctx, args) => {
    const product = await productBySlug(ctx, args.slug);
    requireDraft(product);
    await requireUnused(ctx, [args.file]);
    const coverUrl = await ctx.storage.getUrl(args.file);
    if (!coverUrl) fail('NOT_FOUND', 'The upload was not found. Upload the file again.');
    await ctx.db.patch(product._id, { coverFile: args.file, coverUrl });
    if (product.coverFile && product.coverFile !== args.file) await ctx.storage.delete(product.coverFile);
    await syncDesign(ctx, product._id);
    await audit(ctx, args.actorUserId, 'release.cover', product.slug, { coverFile: product.coverFile ?? null }, {
      coverFile: args.file,
      width: args.width,
      height: args.height,
    });
    return coverUrl;
  },
});

const stickerArgs = {
  slug: v.string(),
  file: v.id('_storage'),
  /** `shutter`: the slide lid. `shell`: anywhere on the plastic cover. */
  area: v.union(v.literal('shutter'), v.literal('shell')),
};

/**
 * A `design.stickers[]` entry read loosely: `design` is `v.any()` at rest, and `buildDesign` (not this file)
 * is the one place that validates its shape against `packages/minidisc`'s `DiscSticker`.
 */
type StickerRecord = Record<string, unknown>;

/**
 * Adds an image sticker (any shape PNG, alpha kept, or JPEG/WebP): needs the tracks and the cover first, like the
 * casing itself. Appends a `design.stickers` entry (kind `image`) centred at its area's middle, quarter width, no
 * rotation; the admin drags the sliders and saves the casing to place it. At most `MAX_SHUTTER_IMAGE_STICKERS` on
 * the slide cover, `MAX_IMAGE_STICKERS` in all.
 */
export const attachSticker = action({
  args: stickerArgs,
  handler: async (ctx, args): Promise<{ url: string; file: Id<'_storage'> }> => {
    const actorUserId: Id<'users'> = await ctx.runQuery(internal.releases.adminUserId, {});
    return await attaching(ctx, [args.file], async () => {
      await inspect(ctx, args.file, 'sticker');
      return await ctx.runMutation(internal.releases.recordSticker, { ...args, actorUserId });
    });
  },
});

export const recordSticker = internalMutation({
  args: { ...stickerArgs, actorUserId: v.id('users') },
  handler: async (ctx, args) => {
    const product = await productBySlug(ctx, args.slug);
    requireDraft(product);
    await requireUnused(ctx, [args.file]);
    const files = product.stickerFiles ?? [];
    const existing = (((product.design as { stickers?: StickerRecord[] } | undefined)?.stickers ?? []) as StickerRecord[]);
    // Every sticker counts towards the total, the drawn built-ins and emoji (no file) too.
    if (Math.max(files.length, existing.length) >= MAX_IMAGE_STICKERS) fail('INVALID_INPUT', `A release has at most ${MAX_IMAGE_STICKERS} stickers.`);
    const onShutter = existing.filter((s) => s.kind === 'image' && s.area === 'shutter').length;
    if (args.area === 'shutter' && onShutter >= MAX_SHUTTER_IMAGE_STICKERS) {
      fail('INVALID_INPUT', `The slide cover has at most ${MAX_SHUTTER_IMAGE_STICKERS} image stickers.`);
    }
    const url = await ctx.storage.getUrl(args.file);
    if (!url) fail('NOT_FOUND', 'The upload was not found. Upload the file again.');
    const facts = await factsFor(ctx, product);
    if (!facts) fail('INVALID_INPUT', 'Upload the tracks and the cover before stickers.');
    // `factsFor` reads `product.stickerFiles`, which does not carry `args.file` yet (it is patched in below).
    const sticker: StickerRecord = { kind: 'image', src: url, area: args.area, x: 0.5, y: 0.5, size: 0.25, rotation: 0 };
    const result = buildDesign(
      { ...(product.design ?? {}), stickers: [...existing, sticker] },
      { ...facts, stickerUrls: [...facts.stickerUrls, url] },
    );
    if (!result.ok) fail('INVALID_INPUT', `Could not place the sticker: ${result.errors.slice(0, 8).join('; ')}`);
    const hash = await designHash(result.design);
    await ctx.db.patch(product._id, {
      stickerFiles: [...files, args.file],
      design: result.design,
      designHash: hash,
      designRev: (product.designRev ?? 0) + 1,
    });
    await audit(ctx, args.actorUserId, 'release.sticker.add', product.slug, { stickers: existing.length }, { stickers: existing.length + 1, area: args.area });
    return { url, file: args.file };
  },
});

/** Drops one sticker: its `design.stickers` entry and its file, with the casing re-saved and re-hashed. */
export const removeSticker = mutation({
  args: { slug: v.string(), file: v.id('_storage') },
  handler: async (ctx, { slug, file }) => {
    const admin = await requireAdmin(ctx);
    const product = await productBySlug(ctx, slug);
    requireDraft(product);
    const files = product.stickerFiles ?? [];
    if (!files.includes(file)) fail('INVALID_INPUT', 'That sticker is not on this release.');
    const url = await ctx.storage.getUrl(file);
    const design = product.design as (Record<string, unknown> & { stickers?: StickerRecord[] }) | undefined;
    const existing = design?.stickers ?? [];
    const kept = existing.filter((s) => !(s.kind === 'image' && s.src === url));
    const nextDesign: DiscDesign | null = design ? ({ ...design, stickers: kept.length > 0 ? kept : undefined } as DiscDesign) : null;
    await ctx.db.patch(product._id, {
      stickerFiles: files.filter((id) => id !== file),
      ...(nextDesign
        ? { design: nextDesign, designHash: await designHash(nextDesign), designRev: (product.designRev ?? 0) + 1 }
        : {}),
    });
    await ctx.storage.delete(file);
    await audit(ctx, admin._id, 'release.sticker.remove', product.slug, { stickers: existing.length }, { stickers: kept.length });
    return null;
  },
});

const labelArgs = { slug: v.string(), file: v.id('_storage') };

/** Where a new label image goes: filling the label area, centred, square on. A replacement keeps the old placing. */
const LABEL_PLACE = { x: 0.5, y: 0.5, size: 0.9, rotation: 0 };

/**
 * The slide cover's label image (any shape PNG, alpha kept, or JPEG/WebP): its own layer between the slide and the
 * stickers (`design.labelImage`), so the printed label is not drawn while it is set. Needs a saved casing, like the
 * stickers. A second upload replaces the first (same placing) and deletes the old file.
 */
export const attachLabel = action({
  args: labelArgs,
  handler: async (ctx, args): Promise<{ url: string; file: Id<'_storage'> }> => {
    const actorUserId: Id<'users'> = await ctx.runQuery(internal.releases.adminUserId, {});
    return await attaching(ctx, [args.file], async () => {
      await inspect(ctx, args.file, 'label');
      return await ctx.runMutation(internal.releases.recordLabel, { ...args, actorUserId });
    });
  },
});

export const recordLabel = internalMutation({
  args: { ...labelArgs, actorUserId: v.id('users') },
  handler: async (ctx, args) => {
    const product = await productBySlug(ctx, args.slug);
    requireDraft(product);
    await requireUnused(ctx, [args.file]);
    const url = await ctx.storage.getUrl(args.file);
    if (!url) fail('NOT_FOUND', 'The upload was not found. Upload the file again.');
    const facts = await factsFor(ctx, product);
    if (!facts) fail('INVALID_INPUT', 'Upload the tracks and the cover before the label.');
    const design = (product.design ?? {}) as Record<string, unknown> & { labelImage?: Record<string, unknown> };
    const previous = design.labelImage;
    const place = previous
      ? { x: previous.x, y: previous.y, size: previous.size, rotation: previous.rotation ?? 0 }
      : LABEL_PLACE;
    const result = buildDesign({ ...design, labelImage: { src: url, ...place } }, { ...facts, labelUrl: url });
    if (!result.ok) fail('INVALID_INPUT', `Could not place the label: ${result.errors.slice(0, 8).join('; ')}`);
    await ctx.db.patch(product._id, {
      labelFile: args.file,
      design: result.design,
      designHash: await designHash(result.design),
      designRev: (product.designRev ?? 0) + 1,
    });
    if (product.labelFile && product.labelFile !== args.file) await ctx.storage.delete(product.labelFile);
    await audit(ctx, args.actorUserId, 'release.label.set', product.slug, { labelFile: product.labelFile ?? null }, { labelFile: args.file });
    return { url, file: args.file };
  },
});

/** Drops the label image: its file, and `design.labelImage` (the printed label shows again), re-saved and re-hashed. */
export const removeLabel = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const admin = await requireAdmin(ctx);
    const product = await productBySlug(ctx, slug);
    requireDraft(product);
    if (!product.labelFile) fail('INVALID_INPUT', 'This release has no label image.');
    const design = product.design as (Record<string, unknown> & { labelImage?: unknown }) | undefined;
    const { labelImage: _dropped, ...rest } = design ?? {};
    const nextDesign: DiscDesign | null = design ? (rest as unknown as DiscDesign) : null;
    await ctx.db.patch(product._id, {
      labelFile: undefined,
      ...(nextDesign
        ? { design: nextDesign, designHash: await designHash(nextDesign), designRev: (product.designRev ?? 0) + 1 }
        : {}),
    });
    await ctx.storage.delete(product.labelFile);
    await audit(ctx, admin._id, 'release.label.remove', product.slug, { labelFile: product.labelFile }, { labelFile: null });
    return null;
  },
});

const rackArgs = {
  slug: v.string(),
  /** Required: the sleeve still (`renderSleeveStill`), PNG, square, >= 1024 px. The app's grid shows it. */
  still: v.id('_storage'),
  /** Optional: the same still as WebP. */
  stillWebp: v.optional(v.id('_storage')),
  /** Optional: the spin loop (unused by the grid). With any of it, the PNG sheet and its metadata are required. */
  spriteWebp: v.optional(v.id('_storage')),
  spritePng: v.optional(v.id('_storage')),
  spriteMeta: v.optional(spriteMetaValidator),
  /** The design hash the portal rendered from (`get().designHash`): refused when the design has moved on. */
  designHash: v.string(),
};

/** Step 5: the rack still (PNG, and WebP when the browser could encode it); optionally the older spin loop. */
export const attachRackArt = action({
  args: rackArgs,
  handler: async (ctx, args): Promise<{ designHash: string }> => {
    const actorUserId: Id<'users'> = await ctx.runQuery(internal.releases.adminUserId, {});
    const uploads = [args.still, args.stillWebp, args.spriteWebp, args.spritePng].filter((id): id is Id<'_storage'> => Boolean(id));
    return await attaching(ctx, uploads, async () => {
      const parts = checkRackParts({
        still: Boolean(args.still),
        stillWebp: Boolean(args.stillWebp),
        spriteWebp: Boolean(args.spriteWebp),
        spritePng: Boolean(args.spritePng),
        spriteMeta: Boolean(args.spriteMeta),
      });
      if (parts) fail('INVALID_INPUT', parts);
      const still = await inspect(ctx, args.still, 'still');
      const stillWebp = args.stillWebp ? await inspect(ctx, args.stillWebp, 'stillWebp') : null;
      const stillProblem = checkStillSize(imageSize(still.head, 'png'), stillWebp ? imageSize(stillWebp.head, 'webp') : undefined);
      if (stillProblem) fail('INVALID_INPUT', stillProblem);
      if (args.spriteWebp) await inspect(ctx, args.spriteWebp, 'spriteWebp');
      if (args.spritePng && args.spriteMeta) {
        const png = await inspect(ctx, args.spritePng, 'spritePng');
        const problem = checkSpriteMeta(args.spriteMeta, imageSize(png.head, 'png'));
        if (problem) fail('INVALID_INPUT', problem);
      }
      await ctx.runMutation(internal.releases.recordRackArt, { ...args, actorUserId });
      return { designHash: args.designHash };
    });
  },
});

export const recordRackArt = internalMutation({
  args: { ...rackArgs, actorUserId: v.id('users') },
  handler: async (ctx, { actorUserId, slug, designHash: renderedFrom, ...files }) => {
    const product = await productBySlug(ctx, slug);
    requireDraft(product);
    if (!product.designHash || product.designHash !== renderedFrom) {
      fail('INVALID_INPUT', 'The casing changed since this render. Render the rack art again.');
    }
    const ids = [files.still, files.stillWebp, files.spriteWebp, files.spritePng];
    await requireUnused(ctx, ids);
    const previous = product.rack;
    await ctx.db.patch(product._id, { rack: { ...files, designHash: renderedFrom } });
    const kept = new Set<string>(ids.filter((id) => id !== undefined));
    await deleteFiles(
      ctx,
      [previous?.still, previous?.stillWebp, previous?.spriteWebp, previous?.spritePng].filter((id) => id !== undefined && !kept.has(id)),
    );
    await audit(ctx, actorUserId, 'release.rack', slug, previous ? { designHash: previous.designHash } : null, {
      designHash: renderedFrom,
      stillWebp: Boolean(files.stillWebp),
      spriteMeta: files.spriteMeta ?? null,
      webp: Boolean(files.spriteWebp),
    });
    return null;
  },
});

const bundleArgs = {
  slug: v.string(),
  version: v.string(),
  zip: v.id('_storage'),
  sha256: v.string(),
  designHash: v.string(),
};

type BundleArgs = { slug: string; version: string; zip: Id<'_storage'>; sha256: string; designHash: string };
type BundleResult = { version: string; url: string; sha256: string };

async function attachBundleAs(ctx: ActionCtx, actorUserId: Id<'users'>, args: BundleArgs): Promise<BundleResult> {
  return await attaching(ctx, [args.zip], async () => {
    const version = args.version.trim();
    const sha256 = args.sha256.trim().toLowerCase();
    if (!BUNDLE_VERSION.test(version)) fail('INVALID_INPUT', 'The bundle version must look like 1.0.0 (or 1.0.0+r3).');
    if (!SHA256_HEX.test(sha256)) fail('INVALID_INPUT', 'The SHA-256 must be 64 hex characters.');
    const zip = await inspect(ctx, args.zip, 'bundle');
    // BUN-2: the app checks the zip against this, so it must be the stored file's own hash.
    if (zip.sha256Hex !== sha256) fail('INVALID_INPUT', 'The uploaded zip does not match its SHA-256. Build and upload it again.');
    return await ctx.runMutation(internal.releases.recordBundle, { ...args, version, sha256, actorUserId });
  });
}

/** Step 6: the release zip (generic bundle + design.json + art), its version and SHA-256. */
export const attachBundle = action({
  args: bundleArgs,
  handler: async (ctx, args): Promise<BundleResult> => {
    const actorUserId: Id<'users'> = await ctx.runQuery(internal.releases.adminUserId, {});
    return await attachBundleAs(ctx, actorUserId, args);
  },
});

/** `scripts/publish-release.ts` (npx convex run): the same checks, audited as the admin it names. */
export const attachBundleFromCli = internalAction({
  args: { ...bundleArgs, adminEmail: v.string() },
  handler: async (ctx, { adminEmail, ...args }): Promise<BundleResult> => {
    const actorUserId: Id<'users'> = await ctx.runQuery(internal.releases.adminUserIdByEmail, { email: adminEmail });
    return await attachBundleAs(ctx, actorUserId, args);
  },
});

export const recordBundle = internalMutation({
  args: { ...bundleArgs, actorUserId: v.id('users') },
  handler: async (ctx, args): Promise<BundleResult> => {
    const product = await productBySlug(ctx, args.slug);
    requireDraft(product);
    if (!product.designHash || product.designHash !== args.designHash) {
      fail('INVALID_INPUT', 'The casing changed since this bundle was built. Build it again.');
    }
    await requireUnused(ctx, [args.zip]);
    const url = await ctx.storage.getUrl(args.zip);
    if (!url) fail('NOT_FOUND', 'The upload was not found. Upload the file again.');
    const before = portalSnapshot(product);
    await ctx.db.patch(product._id, {
      bundleVersion: args.version,
      bundleUrl: url,
      bundleSha256: args.sha256,
      bundleFile: args.zip,
      bundleDesignHash: args.designHash,
    });
    if (product.bundleFile && product.bundleFile !== args.zip) await ctx.storage.delete(product.bundleFile);
    await audit(ctx, args.actorUserId, 'release.bundle', product.slug, before, portalSnapshot((await ctx.db.get(product._id))!));
    return { version: args.version, url, sha256: args.sha256 };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Publish

/**
 * Step 7: needs every track with audio, the cover, a saved design, and rack art and a bundle made from that same
 * design. `scheduled` needs a future `dropAt`; `live` takes `dropAt` now (or a past one). Flips `active`, so the
 * release appears in `app.library` (upcoming until its drop, via the cron in `app.flipDueDrops`).
 */
export const publish = mutation({
  args: {
    slug: v.string(),
    status: v.union(v.literal('scheduled'), v.literal('live')),
    dropAt: v.optional(v.number()),
    reason: v.string(),
  },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const reason = cleanReason(args.reason);
    const product = await productBySlug(ctx, args.slug);
    const state = await publishStateOf(ctx, product);
    const problems = publishProblems(state);
    if (problems.length > 0) fail('INVALID_INPUT', `Not ready to publish. ${problems.join(' ')}`);
    if (args.status === 'scheduled' && args.dropAt === undefined) fail('INVALID_INPUT', 'Pick a drop date to schedule the release.');
    const now = Date.now();
    const clean = validateReleasePatch(product, { status: args.status, dropAt: args.dropAt ?? now }, now);
    await ctx.db.patch(product._id, { ...clean, active: true });
    const after = (await ctx.db.get(product._id))!;
    const auditId = await audit(
      ctx,
      admin._id,
      'release.publish',
      product.slug,
      portalSnapshot(product, state.tracks.length),
      portalSnapshot(after, state.tracks.length),
      reason,
    );
    return { slug: product.slug, status: after.status!, dropAt: after.dropAt!, auditId };
  },
});

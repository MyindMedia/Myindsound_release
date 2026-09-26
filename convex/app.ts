import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, mutation, query, type QueryCtx } from './_generated/server';
import { ensureViewer, getViewer } from './lib/auth';
import { activeEntitlement, isPrelaunch, newWearSeed } from './lib/editions';
import { fail } from './lib/errors';
import { publicName } from './leaderboard';
import {
  heldCopy,
  ingestPlayEvents,
  lendForBorrower,
  lendOutFor,
  wearDescriptorFor,
  wearInputsFor,
  type LendView,
} from './wear';

/**
 * The iOS app's API (docs/app-v1/API.md). The server decides ownership, editions, wear and timing (ARCH-3); the
 * app displays them. Nothing here returns a storage id or a file URL (ARCH-4): audio goes through
 * `media.getStreamUrl`.
 */

export type Ownership = 'owned' | 'lent' | 'locked' | 'preview';

/** PRD §10.2 / packages/bridge `LendState`. */
export type LendInfo = {
  lendId: string;
  playsAllowed: number;
  playsUsed: number;
  expiresAt: number;
  status: LendView['status'];
  endReason: string | null;
  /** Who holds the copy: the borrower sees the lender's public name, the lender sees "lent". */
  role: 'borrower' | 'lender';
  /** LEND-8: the borrower's native end screen, for an exhausted or expired lend; null otherwise. */
  endScreen: LendView['endScreen'];
};

/**
 * owned = a live licence; lent = an active lend the caller holds; locked = before the drop and not owned;
 * preview otherwise (after the drop, not owned: the 30 second previews).
 */
export function ownershipOf(
  product: Pick<Doc<'products'>, 'dropAt' | 'status'>,
  owned: boolean,
  lent: boolean,
  now: number,
): Ownership {
  if (owned) return 'owned';
  if (lent) return 'lent';
  if (isPrelaunch(product, now)) return 'locked';
  return 'preview';
}

function lendInfo(lend: LendView | null, role: LendInfo['role']): LendInfo | null {
  if (!lend) return null;
  return {
    lendId: lend.lendId,
    playsAllowed: lend.playsAllowed,
    playsUsed: lend.playsUsed,
    expiresAt: lend.expiresAt,
    status: lend.status,
    endReason: lend.endReason ?? null,
    role,
    endScreen: role === 'borrower' ? lend.endScreen : null,
  };
}

function bundleOf(product: Doc<'products'>) {
  if (!product.bundleVersion || !product.bundleUrl || !product.bundleSha256) return null;
  return { version: product.bundleVersion, url: product.bundleUrl, sha256: product.bundleSha256 };
}

async function productBySlug(ctx: QueryCtx, slug: string): Promise<Doc<'products'>> {
  const product = await ctx.db
    .query('products')
    .withIndex('by_slug', (q) => q.eq('slug', slug))
    .unique();
  if (!product || product.kind !== 'digital') fail('NOT_FOUND', `No release with slug ${slug}.`);
  return product;
}

/** The caller's relation to one release: their licence, the lend they hold, and the lend their copy is out on. */
async function relationTo(ctx: QueryCtx, viewer: Doc<'users'> | null, product: Doc<'products'>) {
  const entitlement = viewer ? await activeEntitlement(ctx, viewer._id, product._id) : null;
  const borrowed = viewer && !entitlement ? await lendForBorrower(ctx, viewer._id, product._id) : null;
  const lentOut = entitlement ? await lendOutFor(ctx, entitlement._id) : null;
  return { entitlement, borrowed, lentOut };
}

type LibraryEntry = {
  releaseId: Id<'products'>;
  slug: string;
  title: string;
  ownership: Ownership;
  editionNumber: number | null;
  unwrapped: boolean;
  dropAt: number | null;
  status: 'draft' | 'scheduled' | 'live';
  theme: Doc<'products'>['theme'] | null;
  bundle: { version: string; url: string; sha256: string } | null;
  lend: LendInfo | null;
  grantedAt: number | null;
};

/**
 * RACK-1: the caller's owned and lent releases (newest licence first), then upcoming releases they don't own
 * (locked, soonest drop first). Signed out: upcoming only.
 */
export const library = query({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const viewer = await getViewer(ctx);
    const products = (await ctx.db.query('products').collect()).filter((p) => p.kind === 'digital');
    const held: LibraryEntry[] = [];
    const upcoming: LibraryEntry[] = [];
    for (const product of products) {
      const { entitlement, borrowed, lentOut } = await relationTo(ctx, viewer, product);
      const copy = entitlement ?? borrowed?.entitlement ?? null;
      const ownership = ownershipOf(product, entitlement !== null, borrowed !== null, now);
      const entry: LibraryEntry = {
        releaseId: product._id,
        slug: product.slug,
        title: product.name,
        ownership,
        editionNumber: copy?.editionNumber ?? null,
        unwrapped: copy !== null && copy.unwrappedAt !== undefined,
        dropAt: product.dropAt ?? null,
        status: product.status ?? 'live',
        theme: product.theme ?? null,
        bundle: bundleOf(product),
        lend: borrowed ? lendInfo(borrowed, 'borrower') : lendInfo(lentOut, 'lender'),
        grantedAt: entitlement?.grantedAt ?? null,
      };
      if (ownership === 'owned' || ownership === 'lent') held.push(entry);
      else if (ownership === 'locked' && product.active && product.status !== 'draft') upcoming.push(entry);
    }
    held.sort((a, b) => (b.grantedAt ?? 0) - (a.grantedAt ?? 0));
    upcoming.sort((a, b) => (a.dropAt ?? Infinity) - (b.dropAt ?? Infinity));
    return { serverNow: now, releases: [...held, ...upcoming] };
  },
});

/** The bridge's `getContext` data (PRD §10.2). Native adds `platform`, `layout` and `lifecycle`. */
export const context = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const now = Date.now();
    const viewer = await getViewer(ctx);
    const product = await productBySlug(ctx, slug);
    const { entitlement, borrowed, lentOut } = await relationTo(ctx, viewer, product);
    const copy = entitlement ?? borrowed?.entitlement ?? null;
    const ownership = ownershipOf(product, entitlement !== null, borrowed !== null, now);
    let ownerDisplayName: string | null = null;
    if (entitlement) ownerDisplayName = publicName(viewer);
    else if (borrowed) ownerDisplayName = publicName(await ctx.db.get(borrowed.lenderUserId));
    const inputs = copy ? wearInputsFor(copy) : null;
    return {
      releaseId: product._id,
      slug: product.slug,
      title: product.name,
      ownership,
      editionNumber: copy?.editionNumber ?? null,
      ownerDisplayName,
      wear: copy ? wearDescriptorFor(copy) : null,
      wearInputs: inputs,
      unwrapped: copy !== null && copy.unwrappedAt !== undefined,
      // The bridge wants a number: 0 means the release has no scheduled drop (it is on sale now).
      dropAt: product.dropAt ?? 0,
      status: product.status ?? 'live',
      serverNow: now,
      lend: borrowed ? lendInfo(borrowed, 'borrower') : lendInfo(lentOut, 'lender'),
    };
  },
});

/** The tracklist, public (titles and durations only; no storage ids, no URLs). */
export const tracks = query({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const product = await productBySlug(ctx, slug);
    const rows = await ctx.db
      .query('tracks')
      .withIndex('by_product_position', (q) => q.eq('productId', product._id))
      .collect();
    return rows.map((row) => ({
      id: row._id,
      position: row.position,
      title: row.title,
      durationSeconds: row.durationSeconds,
    }));
  },
});

/** RACK-3: the unwrap plays once per copy. Owners only; setting it again keeps the first time. */
export const markUnwrapped = mutation({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) => {
    const user = await ensureViewer(ctx);
    const product = await productBySlug(ctx, slug);
    const entitlement = await activeEntitlement(ctx, user._id, product._id);
    if (!entitlement) fail('NOT_ENTITLED', 'No license found for this release.');
    if (entitlement.unwrappedAt !== undefined) return { unwrappedAt: entitlement.unwrappedAt, alreadyUnwrapped: true };
    const unwrappedAt = Date.now();
    await ctx.db.patch(entitlement._id, { unwrappedAt });
    return { unwrappedAt, alreadyUnwrapped: false };
  },
});

/**
 * Cartridge load or eject from the open experience (bridge `cartridgeLoaded` / `cartridgeEjected`). Adds a load
 * or eject to the copy's wear, at most one of each kind per 2 seconds and 100 per day. Offline loads and ejects
 * go through `plays.recordPlayEvents` instead, with the same limits.
 */
export const recordCartridgeEvent = mutation({
  args: {
    slug: v.string(),
    kind: v.union(v.literal('load'), v.literal('eject')),
    /** Optional client UUID so a retried call is a no-op. */
    idempotencyKey: v.optional(v.string()),
    lendId: v.optional(v.string()),
  },
  handler: async (ctx, { slug, kind, idempotencyKey, lendId }) => {
    const user = await ensureViewer(ctx);
    const product = await productBySlug(ctx, slug);
    if (!(await heldCopy(ctx, user._id, product._id, lendId))) {
      fail('NOT_ENTITLED', 'No license found for this release.');
    }
    const now = Date.now();
    const key = idempotencyKey ?? `srv-${newWearSeed()}`;
    const [result] = await ingestPlayEvents(ctx, user, [{ idempotencyKey: key, kind, slug, startedAtClient: now, lendId }], now);
    if (result.status === 'rejected') fail('INVALID_INPUT', `Cartridge event rejected (${result.reason}).`);
    return {
      counted: result.counted,
      duplicate: result.status === 'duplicate',
      limitedBy: result.limitedBy as 'rate_limited' | 'daily_cap' | null,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// Drops (DROP-1, DROP-7)

/** Products whose drop time has come: `scheduled` with `dropAt <= now`. Drafts never go live on their own. */
export function dueToGoLive<T extends Pick<Doc<'products'>, 'status' | 'dropAt'>>(products: T[], now: number): T[] {
  return products.filter((p) => p.status === 'scheduled' && p.dropAt !== undefined && p.dropAt <= now);
}

/** Every minute (crons.ts): flips due releases from scheduled to live and queues the drop-live push (stub). */
export const flipDueDrops = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const due = dueToGoLive(await ctx.db.query('products').collect(), now);
    for (const product of due) {
      await ctx.db.patch(product._id, { status: 'live' });
      await ctx.scheduler.runAfter(0, internal.push.sendDropLive, { productId: product._id });
    }
    return { flipped: due.length };
  },
});

import { v } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import { mutation, query, type QueryCtx } from './_generated/server';
import { ensureViewer, getViewer } from './lib/auth';
import { fail } from './lib/errors';

/**
 * Per release leaderboards and early buyer awards (PRD §9, LB-1..6).
 *
 * Awards are computed on read rather than stored in an `awards` table: a revocation (LB-5) or a deleted account
 * then changes every leaderboard and award at once, with nothing to keep in sync. The cost is one index read of
 * the top `leaderboardSize` rows per release, which is small while the catalogue is small. Revisit (a cached
 * `awards` row refreshed by the grant and revoke paths) if releases grow past a few dozen.
 */

/** LB-1 [DECIDE]: the leaderboard size when a product doesn't set `leaderboardSize`. */
export const DEFAULT_LEADERBOARD_SIZE = 100;

export type AwardTier = 'bronze' | 'silver' | 'gold';

/** LB-4 [DECIDE]: releases placed within the leaderboard for each tier, highest first. */
export const AWARD_TIERS: ReadonlyArray<{ tier: AwardTier; minPlacements: number }> = [
  { tier: 'gold', minPlacements: 10 },
  { tier: 'silver', minPlacements: 7 },
  { tier: 'bronze', minPlacements: 3 },
];

export const RETIRED_NAME = 'Retired';
export const ANONYMOUS_NAME = 'Anonymous collector';
/** Shown for a visible collector with no name on their account. */
export const UNNAMED_NAME = 'Collector';

export function tierFor(placements: number): AwardTier | null {
  return AWARD_TIERS.find((t) => placements >= t.minPlacements)?.tier ?? null;
}

export function nextTierFor(placements: number): { tier: AwardTier; needs: number } | null {
  const next = [...AWARD_TIERS].reverse().find((t) => placements < t.minPlacements);
  return next ? { tier: next.tier, needs: next.minPlacements - placements } : null;
}

/**
 * [DECIDE] The public name: first name and last initial ("Lawrence B."), never the email or full surname.
 * Accounts with no name show "Collector".
 */
export function publicName(user: Pick<Doc<'users'>, 'name'> | null): string {
  const parts = (user?.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return UNNAMED_NAME;
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : '';
  return last ? `${first} ${last[0].toUpperCase()}.` : first;
}

export function leaderboardSizeOf(product: Pick<Doc<'products'>, 'leaderboardSize'>): number {
  const size = product.leaderboardSize;
  return size !== undefined && Number.isInteger(size) && size > 0 ? size : DEFAULT_LEADERBOARD_SIZE;
}

/**
 * The first `n` numbered editions of a product in edition order, revoked ones removed (LB-5), so the next
 * edition moves up into the board. Retired editions (deleted accounts) keep their place.
 */
export async function topEditions(ctx: QueryCtx, productId: Id<'products'>, n: number): Promise<Doc<'entitlements'>[]> {
  const rows: Doc<'entitlements'>[] = [];
  if (n <= 0) return rows;
  const ordered = ctx.db
    .query('entitlements')
    .withIndex('by_product_edition', (q) => q.eq('productId', productId).gt('editionNumber', 0))
    .order('asc');
  for await (const row of ordered) {
    if (row.status === 'revoked') continue;
    rows.push(row);
    if (rows.length >= n) break;
  }
  return rows;
}

function isRetired(row: Doc<'entitlements'>): boolean {
  return row.status === 'retired' || row.userId === undefined;
}

/** Each user's releases placed within that release's leaderboard (LB-4), with the rank. Active licences only. */
async function placements(ctx: QueryCtx) {
  const products = (await ctx.db.query('products').collect()).filter((p) => p.kind === 'digital');
  const byUser = new Map<Id<'users'>, Array<{ product: Doc<'products'>; rank: number; editionNumber: number }>>();
  for (const product of products) {
    const top = await topEditions(ctx, product._id, leaderboardSizeOf(product));
    top.forEach((row, index) => {
      if (isRetired(row) || !row.userId) return;
      const list = byUser.get(row.userId) ?? [];
      list.push({ product, rank: index + 1, editionNumber: row.editionNumber! });
      byUser.set(row.userId, list);
    });
  }
  return byUser;
}

export const forRelease = query({
  args: { slug: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { slug, limit }) => {
    const product = await ctx.db
      .query('products')
      .withIndex('by_slug', (q) => q.eq('slug', slug))
      .unique();
    if (!product) fail('NOT_FOUND', `No release with slug ${slug}.`);
    const size = leaderboardSizeOf(product);
    const n = Math.max(1, Math.min(size, Math.floor(limit ?? size)));
    const viewer = await getViewer(ctx);
    const top = await topEditions(ctx, product._id, n);
    const awardCounts = await placements(ctx);
    const rows = [];
    for (const [index, row] of top.entries()) {
      const retired = isRetired(row);
      const user = retired || !row.userId ? null : await ctx.db.get(row.userId);
      const anonymous = user !== null && user.leaderboardVisible === false;
      rows.push({
        rank: index + 1,
        editionNumber: row.editionNumber!,
        displayName: user === null ? RETIRED_NAME : anonymous ? ANONYMOUS_NAME : publicName(user),
        retired: user === null,
        anonymous,
        isYou: viewer !== null && user !== null && user._id === viewer._id,
        awardTier: user === null ? null : tierFor(awardCounts.get(user._id)?.length ?? 0),
      });
    }
    return { slug: product.slug, title: product.name, leaderboardSize: size, rows };
  },
});

export const myAwards = query({
  args: {},
  handler: async (ctx) => {
    const viewer = await getViewer(ctx);
    const mine = viewer ? ((await placements(ctx)).get(viewer._id) ?? []) : [];
    return {
      topPlacements: mine.length,
      tier: tierFor(mine.length),
      nextTier: nextTierFor(mine.length),
      placements: mine.map((p) => ({ slug: p.product.slug, title: p.product.name, rank: p.rank, editionNumber: p.editionNumber })),
      leaderboardVisible: viewer ? viewer.leaderboardVisible !== false : true,
    };
  },
});

/** LB-2 opt out (NFR-2). */
export const setLeaderboardVisible = mutation({
  args: { visible: v.boolean() },
  handler: async (ctx, { visible }) => {
    const user = await ensureViewer(ctx);
    await ctx.db.patch(user._id, { leaderboardVisible: visible });
    return { leaderboardVisible: visible };
  },
});

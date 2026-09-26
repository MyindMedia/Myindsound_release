import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/**
 * Editions, wear stamps and ownership (PRD §5, §6, §8).
 *
 * Only `fulfilment.record` (the single grant path, PAY-10) and the ED-0 migration (`migrations.ts`) call the
 * writers here. Convex mutations are serializable, so reading the counter and patching it in the same
 * mutation gives unique, gapless numbers across every channel (ED-1, ED-2).
 */

export type EntitlementSource = 'stripe' | 'storekit' | 'nfc' | 'admin';

/**
 * [DECIDE] ED-0: the products whose licences from before the app are numbered by the migration, in grantedAt
 * order. Only these products hold new grants back while the migration is pending. Licences for any other
 * product from before the app (THE SOURCE presale) are marked `presale` and never numbered.
 */
export const EDITION_BACKFILL_SLUGS: readonly string[] = ['lit'];

/** The wear formula new licences are stamped with (PRD §11.3). */
export const WEAR_MODEL_VERSION = 1;

const WEAR_SEED_BYTES = 16; // 128 bits

export function zeroWearStats(): NonNullable<Doc<'entitlements'>['wearStats']> {
  return { playSeconds: 0, loads: 0, ejects: 0, lentPlaySeconds: 0 };
}

/**
 * 128-bit hex. In mutations Convex seeds its random number generator per execution on the server (PRD §11:
 * set once at grant, immutable); callers cannot influence it.
 */
export function newWearSeed(): string {
  const bytes = new Uint8Array(WEAR_SEED_BYTES);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Refunded and charged-back (revoked, ENT-4) and deleted-account (retired) licences are not owned. Rows from
 * before the migration have no status and are owned.
 */
export function isActiveEntitlement(row: Pick<Doc<'entitlements'>, 'status'>): boolean {
  return row.status === undefined || row.status === 'active';
}

/** The caller's live licence for a product, or null. The one ownership check every reader uses. */
export async function activeEntitlement(
  ctx: QueryCtx,
  userId: Id<'users'>,
  productId: Id<'products'>,
): Promise<Doc<'entitlements'> | null> {
  const rows = await ctx.db
    .query('entitlements')
    .withIndex('by_user_product', (q) => q.eq('userId', userId).eq('productId', productId))
    .collect();
  return rows.find(isActiveEntitlement) ?? null;
}

export async function counterFor(ctx: QueryCtx, productId: Id<'products'>): Promise<Doc<'releaseCounters'> | null> {
  return await ctx.db
    .query('releaseCounters')
    .withIndex('by_product', (q) => q.eq('productId', productId))
    .unique();
}

/** Licences for a product with no edition that are not presale (pre-migration rows), oldest grant first. */
export function awaitingEdition(ctx: QueryCtx, productId: Id<'products'>) {
  return ctx.db
    .query('entitlements')
    .withIndex('by_product_edition', (q) => q.eq('productId', productId).eq('editionNumber', undefined))
    .filter((q) => q.neq(q.field('presale'), true));
}

/**
 * Before the drop (ED-3): `dropAt` in the future, or, when no `dropAt` is set yet, `status: 'scheduled'`.
 * `dropAt` wins when both are set, because it is the single source of truth for launch.
 */
export function isPrelaunch(product: Pick<Doc<'products'>, 'dropAt' | 'status'>, now: number): boolean {
  return product.dropAt !== undefined ? now < product.dropAt : product.status === 'scheduled';
}

export function isBackfillProduct(product: Pick<Doc<'products'>, 'slug'>): boolean {
  return EDITION_BACKFILL_SLUGS.includes(product.slug);
}

/** The highest edition already assigned for a product, or 0. Only used before a counter exists. */
export async function highestEdition(ctx: QueryCtx, productId: Id<'products'>): Promise<number> {
  const top = await ctx.db
    .query('entitlements')
    .withIndex('by_product_edition', (q) => q.eq('productId', productId))
    .order('desc')
    .first();
  return top?.editionNumber ?? 0;
}

/** Where numbering continues from: the counter, or one past the highest edition when there is none yet. */
export async function nextEditionFrom(ctx: QueryCtx, productId: Id<'products'>): Promise<number> {
  const counter = await counterFor(ctx, productId);
  return counter?.nextEdition ?? (await highestEdition(ctx, productId)) + 1;
}

/** Saves where numbering continues from. Never moves a counter backwards. Returns whether it wrote. */
export async function saveCounter(ctx: MutationCtx, productId: Id<'products'>, nextEdition: number): Promise<boolean> {
  const counter = await counterFor(ctx, productId);
  if (!counter) {
    await ctx.db.insert('releaseCounters', { productId, nextEdition });
    return true;
  }
  if (nextEdition <= counter.nextEdition) return false;
  await ctx.db.patch(counter._id, { nextEdition });
  return true;
}

/**
 * Takes the next edition for a new licence (ED-1), creating the counter on first use.
 *
 * Returns null only for a backfill product (EDITION_BACKFILL_SLUGS) that still has licences from before the
 * ED-0 migration: numbering those is the migration's job, in grantedAt order, and a grant made in that window
 * must not jump the queue. The new row is inserted without a number and the migration numbers it after the
 * older buyers. Every other product numbers straight away; presale rows never hold it back.
 */
export async function takeEdition(ctx: MutationCtx, product: Doc<'products'>): Promise<number | null> {
  if (isBackfillProduct(product) && (await awaitingEdition(ctx, product._id).first()) !== null) return null;
  const edition = await nextEditionFrom(ctx, product._id);
  await saveCounter(ctx, product._id, edition + 1);
  return edition;
}

/**
 * ED-0: edition numbers for the licences granted before the app (PRD §3A, §8).
 *
 * For the backfill products (EDITION_BACKFILL_SLUGS, LIT only) it numbers every licence that has no edition,
 * in grantedAt order (ties by creation order). For every other product, licences from before the app (THE
 * SOURCE presale) are marked `presale` and stay unnumbered for good, so that product's first buyer at the drop
 * is edition 1. Both backfill the wear seed, zeroed wear, active status, Stripe source and payment ref on rows
 * from before this change. Each run touches at most `batchSize` rows and saves the counters, so it is
 * resumable: run it until `done`. Running it again after that changes nothing.
 *
 * LIT grants that land between the deploy and the migration are owned straight away but wait for their
 * number (lib/editions.ts `takeEdition`), so they are numbered here after the older buyers.
 *
 * Run it by docs/app-v1/RUNBOOK-ED0.md, after a non-dry `payments:rebuildFromStripe` (so every paid session
 * has its payment ref first):
 *   npx convex run migrations:assignEditions '{"dryRun":true}' --prod     (counts only, nothing written)
 *   npx convex run migrations:assignEditions '{}' --prod                  (repeat until "done": true)
 *
 * Counts only: no email, name, Clerk id or session id ever leaves the database through this.
 */
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation } from './_generated/server';
import {
  awaitingEdition,
  isBackfillProduct,
  newWearSeed,
  nextEditionFrom,
  saveCounter,
  WEAR_MODEL_VERSION,
  zeroWearStats,
} from './lib/editions';
import { ensureOriginRef } from './lib/entitlementRefs';

/** Rows touched per run. Well inside Convex's per-mutation write limits. */
export const EDITION_BATCH = 200;

/** Fills only what is missing, so a wear seed or source already on the row is never replaced (ENT-3). */
function backfill(row: Doc<'entitlements'>): Partial<Doc<'entitlements'>> {
  return {
    ...(row.wearSeed === undefined ? { wearSeed: newWearSeed() } : {}),
    ...(row.wearStats === undefined ? { wearStats: zeroWearStats() } : {}),
    ...(row.wearModelVersion === undefined ? { wearModelVersion: WEAR_MODEL_VERSION } : {}),
    ...(row.status === undefined ? { status: 'active' as const } : {}),
    // Every licence before the app came from a Stripe checkout.
    ...(row.source === undefined ? { source: 'stripe' as const, sourceRef: row.stripeSessionId } : {}),
  };
}

export const assignEditions = internalMutation({
  args: { batchSize: v.optional(v.number()), dryRun: v.optional(v.boolean()) },
  handler: async (ctx, { batchSize = EDITION_BATCH, dryRun = false }) => {
    const products = await ctx.db.query('products').collect();
    let budget = Math.max(1, Math.floor(batchSize));
    let numbered = 0;
    let presaleMarked = 0;
    let countersSet = 0;
    let pending = 0;

    for (const product of products) {
      if (dryRun) {
        pending += (await awaitingEdition(ctx, product._id).collect()).length;
        continue;
      }
      const numbering = isBackfillProduct(product);
      let next = await nextEditionFrom(ctx, product._id);
      const batch = budget > 0 ? await awaitingEdition(ctx, product._id).take(budget) : [];
      for (const row of batch) {
        if (numbering) {
          await ctx.db.patch(row._id, { editionNumber: next, ...backfill(row) });
          next++;
          numbered++;
        } else {
          await ctx.db.patch(row._id, { presale: true, ...backfill(row) });
          presaleMarked++;
        }
        await ensureOriginRef(ctx, (await ctx.db.get(row._id))!);
        budget--;
      }
      if (await saveCounter(ctx, product._id, next)) countersSet++;
      if ((await awaitingEdition(ctx, product._id).first()) !== null) pending++;
    }

    // `pending`: rows awaiting a number on a dry run; products with rows left over on a real run.
    const result = {
      dryRun,
      products: products.length,
      numbered,
      presaleMarked,
      countersSet,
      pending,
      done: pending === 0,
    };
    console.log(
      `assignEditions: dryRun=${dryRun} products=${result.products} numbered=${numbered} ` +
        `presaleMarked=${presaleMarked} countersSet=${countersSet} pending=${pending} done=${result.done}`,
    );
    return result;
  },
});

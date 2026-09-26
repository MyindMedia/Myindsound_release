import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import type { EntitlementSource } from './editions';

/**
 * Payment references behind each entitlement (ENT-5, PAY-3): one row per payment, tag or audit entry that
 * granted or re-bought it. Grants, refunds and disputes all look payments up here, so each one is idempotent
 * on its own reference.
 *
 * Licences from before this table have no ref row. Their origin (the Stripe session on the entitlement) is
 * adopted into a ref the first time a mutation touches it, and the ED-0 migration adopts the rest.
 */

export type RefStatus = Doc<'entitlementRefs'>['status'];

/** Makes sure the payment that first granted an entitlement has its ref row (pre-refs rows lack one). */
export async function ensureOriginRef(ctx: MutationCtx, entitlement: Doc<'entitlements'>): Promise<void> {
  const source: EntitlementSource = entitlement.source ?? 'stripe';
  const sourceRef = entitlement.sourceRef ?? entitlement.stripeSessionId;
  if (!sourceRef) return;
  const existing = await ctx.db
    .query('entitlementRefs')
    .withIndex('by_ref', (q) => q.eq('source', source).eq('sourceRef', sourceRef).eq('productId', entitlement.productId))
    .first();
  if (existing) return;
  await ctx.db.insert('entitlementRefs', {
    entitlementId: entitlement._id,
    productId: entitlement.productId,
    source,
    sourceRef,
    status: entitlement.status === 'revoked' ? 'refunded' : 'active',
    at: entitlement.grantedAt,
  });
}

/**
 * Records a payment against a licence. A tombstone for the same payment (a dispute won before fulfilment)
 * is adopted instead of adding a second row.
 */
export async function appendRef(
  ctx: MutationCtx,
  entitlement: Doc<'entitlements'>,
  source: EntitlementSource,
  sourceRef: string,
  tombstone?: Doc<'entitlementRefs'> | null,
): Promise<void> {
  if (tombstone && tombstone.entitlementId === undefined) {
    await ctx.db.patch(tombstone._id, { entitlementId: entitlement._id, changedAt: Date.now() });
    return;
  }
  await ctx.db.insert('entitlementRefs', {
    entitlementId: entitlement._id,
    productId: entitlement.productId,
    source,
    sourceRef,
    status: 'active',
    at: Date.now(),
  });
}

/** Every ref for one payment, tag or audit entry, across products. Adopts pre-refs Stripe rows first. */
export async function refsFor(
  ctx: MutationCtx,
  source: EntitlementSource,
  sourceRef: string,
): Promise<Doc<'entitlementRefs'>[]> {
  if (source === 'stripe') {
    const legacy = await ctx.db
      .query('entitlements')
      .withIndex('by_session', (q) => q.eq('stripeSessionId', sourceRef))
      .collect();
    for (const row of legacy) await ensureOriginRef(ctx, row);
  }
  return await ctx.db
    .query('entitlementRefs')
    .withIndex('by_ref', (q) => q.eq('source', source).eq('sourceRef', sourceRef))
    .collect();
}

export async function hasActiveRef(ctx: QueryCtx, entitlementId: Id<'entitlements'>): Promise<boolean> {
  const refs = await ctx.db
    .query('entitlementRefs')
    .withIndex('by_entitlement', (q) => q.eq('entitlementId', entitlementId))
    .collect();
  return refs.some((ref) => ref.status === 'active');
}

/** The entitlement a Stripe checkout session granted or re-bought (read-only; also sees pre-refs rows). */
export async function entitlementForSession(ctx: QueryCtx, sessionId: string): Promise<Doc<'entitlements'> | null> {
  const refs = await ctx.db
    .query('entitlementRefs')
    .withIndex('by_ref', (q) => q.eq('source', 'stripe').eq('sourceRef', sessionId))
    .collect();
  for (const ref of refs) {
    if (ref.entitlementId) return await ctx.db.get(ref.entitlementId);
  }
  return await ctx.db
    .query('entitlements')
    .withIndex('by_session', (q) => q.eq('stripeSessionId', sessionId))
    .first();
}

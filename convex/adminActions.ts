import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { internalMutation, mutation, type MutationCtx, type QueryCtx } from './_generated/server';
import type { Grant, GrantOutcome } from './fulfilment';
import { isTerminal, settleLend, transitionLend } from './lendLogic';
import { emailHash, requireAdmin } from './lib/auth';
import { activeEntitlement, isActiveEntitlement, zeroWearStats } from './lib/editions';
import { ensureOriginRef } from './lib/entitlementRefs';
import { fail } from './lib/errors';
import { releaseThemeValidator } from './schema';

/**
 * Admin actions (PRD §17, ADM-3..7). Every mutation checks `requireAdmin` first and writes one `auditLog` row
 * (ADM-6) with the admin, a before and after snapshot and a required reason. A refused action throws, which rolls
 * the whole transaction back, audit row included, so the log only ever records what happened.
 *
 * Grants go through the single grant path (`fulfilment.record`, PAY-10) with `source: 'admin'` and the audit row's
 * id as `sourceRef`; revokes go through `fulfilment.revokeEntitlement`, so LEND-10 cascades. Snapshots and
 * targets carry ids only: an email never reaches the log (ADM-1).
 */

export const MAX_REASON_LENGTH = 500;
const CLAIM_REASON = 'Claimed at sign in with a matching verified email (ENT-2).';

// ---------------------------------------------------------------------------------------------------------------
// Audit log (ADM-6)

/** ADM-6: every action needs a reason. Trimmed; empty or whitespace only is refused. */
export function cleanReason(reason: string): string {
  const trimmed = reason.trim();
  if (!trimmed) fail('INVALID_INPUT', 'A reason is required.');
  if (trimmed.length > MAX_REASON_LENGTH) fail('INVALID_INPUT', `Keep the reason under ${MAX_REASON_LENGTH} characters.`);
  return trimmed;
}

type AuditEntry = {
  actorUserId: Id<'users'>;
  action: string;
  target: string;
  before: unknown;
  after: unknown;
  reason: string;
};

async function writeAudit(ctx: MutationCtx, entry: AuditEntry): Promise<Id<'auditLog'>> {
  return await ctx.db.insert('auditLog', { ...entry, at: Date.now() });
}

/**
 * Fills in a row this same mutation inserted (a grant needs the row's id as its `sourceRef` before the result
 * exists). Never exported: once the transaction commits, the row is never written again.
 */
async function completeAudit(ctx: MutationCtx, id: Id<'auditLog'>, fields: Pick<AuditEntry, 'target' | 'after'>) {
  await ctx.db.patch(id, fields);
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshots and lookups (ids only)

export function entitlementSnapshot(row: Doc<'entitlements'>) {
  return {
    id: row._id,
    userId: row.userId ?? null,
    productId: row.productId,
    editionNumber: row.editionNumber ?? null,
    status: row.status ?? 'active',
    source: row.source ?? null,
    sourceRef: row.sourceRef ?? row.stripeSessionId ?? null,
    wearSeed: row.wearSeed ?? null,
    wearStats: row.wearStats ?? null,
    wearModelVersion: row.wearModelVersion ?? null,
    unwrappedAt: row.unwrappedAt ?? null,
  };
}

function lendSnapshot(row: Doc<'lends'>) {
  return {
    id: row._id,
    entitlementId: row.entitlementId,
    lenderUserId: row.lenderUserId,
    borrowerUserId: row.borrowerUserId ?? null,
    status: row.status,
    playsUsed: row.playsUsed,
    playsAllowed: row.playsAllowed,
    endReason: row.endReason ?? null,
  };
}

function pendingSnapshot(row: Doc<'pendingGrants'>) {
  return {
    id: row._id,
    productId: row.productId,
    status: row.status,
    grantAuditId: row.auditId,
    entitlementId: row.entitlementId ?? null,
  };
}

export function releaseSnapshot(product: Doc<'products'>) {
  return {
    slug: product.slug,
    dropAt: product.dropAt ?? null,
    status: product.status ?? null,
    bundleVersion: product.bundleVersion ?? null,
    bundleUrl: product.bundleUrl ?? null,
    bundleSha256: product.bundleSha256 ?? null,
    appStoreProductIds: product.appStoreProductIds ?? null,
    leaderboardSize: product.leaderboardSize ?? null,
    theme: product.theme ?? null,
  };
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  const normalized = email.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(normalized) || normalized.length > 254) fail('INVALID_INPUT', 'Enter a valid email address.');
  return normalized;
}

/** The one account an email belongs to, or null. Matches the stored address case-insensitively. */
export async function userByEmail(ctx: QueryCtx, typed: string): Promise<Doc<'users'> | null> {
  const normalized = normalizeEmail(typed);
  const found = new Map<Id<'users'>, Doc<'users'>>();
  for (const candidate of new Set([normalized, typed.trim()])) {
    const rows = await ctx.db
      .query('users')
      .withIndex('by_email', (q) => q.eq('email', candidate))
      .collect();
    for (const row of rows) found.set(row._id, row);
  }
  if (found.size > 1) fail('INVALID_INPUT', 'More than one account uses that email. Resolve it in the Convex dashboard.');
  return [...found.values()][0] ?? null;
}

/** An account by id (as the lookup shows it) or by email. */
async function accountFor(ctx: QueryCtx, who: string): Promise<Doc<'users'>> {
  if (who.includes('@')) {
    const user = await userByEmail(ctx, who);
    if (!user) fail('NOT_FOUND', 'No account uses that email. The new owner must sign in once first.');
    return user;
  }
  const id = ctx.db.normalizeId('users', who.trim());
  const user = id ? await ctx.db.get(id) : null;
  if (!user) fail('NOT_FOUND', 'Account not found.');
  return user;
}

export async function productBySlug(ctx: QueryCtx, slug: string): Promise<Doc<'products'>> {
  const product = await ctx.db
    .query('products')
    .withIndex('by_slug', (q) => q.eq('slug', slug.trim()))
    .unique();
  if (!product || product.kind !== 'digital') fail('NOT_FOUND', `No release with slug ${slug}.`);
  return product;
}

async function entitlementById(ctx: QueryCtx, idText: string): Promise<Doc<'entitlements'>> {
  const id = ctx.db.normalizeId('entitlements', idText.trim());
  const row = id ? await ctx.db.get(id) : null;
  if (!row) fail('NOT_FOUND', 'Entitlement not found.');
  return row;
}

// ---------------------------------------------------------------------------------------------------------------
// ADM-3 grant, and ENT-2 pending claims

type GrantRecord = {
  userId: Id<'users'>;
  product: Doc<'products'>;
  sourceRef: Id<'auditLog'>;
};

/** The shared grant path (PAY-10) for an admin grant. Returns the outcome and, when granted, the licence. */
async function grantThroughRecord(
  ctx: MutationCtx,
  { userId, product, sourceRef }: GrantRecord,
): Promise<{ outcome: GrantOutcome; entitlement: Doc<'entitlements'> | null }> {
  const user = (await ctx.db.get(userId))!;
  // Annotated: the inferred type would run through the generated api, which includes this module.
  const result: { grants: Grant[] } = await ctx.runMutation(internal.fulfilment.record, {
    source: 'admin',
    sourceRef,
    clerkId: user.clerkId,
    email: user.email,
    amountTotal: 0,
    currency: 'usd',
    lineItems: [{ description: `Admin grant: ${product.slug}`, quantity: 1, unitAmount: 0, productId: product._id }],
  });
  const outcome: GrantOutcome = result.grants[0]?.outcome ?? 'early';
  const entitlement = await activeEntitlement(ctx, userId, product._id);
  return { outcome, entitlement };
}

/**
 * ADM-3: grant a release to an account by email (for purchases made with a different email). An email with no
 * account is held as a pending grant (ENT-2) and claimed when that email signs in verified. Idempotent: an owner
 * keeps their one licence and edition (ENT-5), and a second grant to the same pending email reuses the first.
 */
export const grant = mutation({
  args: { email: v.string(), slug: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const reason = cleanReason(args.reason);
    const product = await productBySlug(ctx, args.slug);
    const user = await userByEmail(ctx, args.email);

    if (!user) {
      const hash = await emailHash(normalizeEmail(args.email));
      const waiting = await ctx.db
        .query('pendingGrants')
        .withIndex('by_email_status', (q) => q.eq('emailHash', hash).eq('status', 'pending'))
        .collect();
      const existing = waiting.find((row) => row.productId === product._id);
      if (existing) {
        const auditId = await writeAudit(ctx, {
          actorUserId: admin._id,
          action: 'grant.pending',
          target: `pending:${existing._id}`,
          before: pendingSnapshot(existing),
          after: pendingSnapshot(existing),
          reason,
        });
        return { status: 'pending' as const, alreadyPending: true, pendingId: existing._id, auditId, editionNumber: null };
      }
      const auditId = await writeAudit(ctx, {
        actorUserId: admin._id,
        action: 'grant.pending',
        target: 'pending',
        before: null,
        after: null,
        reason,
      });
      const pendingId = await ctx.db.insert('pendingGrants', {
        emailHash: hash,
        productId: product._id,
        auditId,
        status: 'pending',
        createdAt: Date.now(),
      });
      await completeAudit(ctx, auditId, {
        target: `pending:${pendingId}`,
        after: pendingSnapshot((await ctx.db.get(pendingId))!),
      });
      return { status: 'pending' as const, alreadyPending: false, pendingId, auditId, editionNumber: null };
    }

    const owned = await activeEntitlement(ctx, user._id, product._id);
    if (owned) {
      const auditId = await writeAudit(ctx, {
        actorUserId: admin._id,
        action: 'grant',
        target: `entitlement:${owned._id}`,
        before: entitlementSnapshot(owned),
        after: entitlementSnapshot(owned),
        reason,
      });
      return {
        status: 'already_owned' as const,
        entitlementId: owned._id,
        editionNumber: owned.editionNumber ?? null,
        auditId,
      };
    }

    const auditId = await writeAudit(ctx, {
      actorUserId: admin._id,
      action: 'grant',
      target: `user:${user._id}`,
      before: null,
      after: null,
      reason,
    });
    const { outcome, entitlement } = await grantThroughRecord(ctx, { userId: user._id, product, sourceRef: auditId });
    if (outcome === 'early') fail('NOT_YET_LIVE', 'This release is not out yet; grants open at its drop (ED-3).');
    if (!entitlement) fail('INVALID_INPUT', `The grant was not made (${outcome}).`);
    await completeAudit(ctx, auditId, {
      target: `entitlement:${entitlement._id}`,
      after: { ...entitlementSnapshot(entitlement), outcome },
    });
    return {
      status: 'granted' as const,
      entitlementId: entitlement._id,
      editionNumber: entitlement.editionNumber ?? null,
      auditId,
    };
  },
});

/**
 * ENT-2: claims every pending grant for a verified email, called from `ensureViewer` at sign in only after Clerk
 * says the email is verified. Each claim goes through the grant path with the original grant's audit id as its
 * `sourceRef`, so a repeat is a replay. A grant for a release that has not dropped yet stays pending.
 */
export const claimPendingGrants = internalMutation({
  args: { userId: v.id('users'), emailHash: v.string() },
  handler: async (ctx, { userId, emailHash: hash }) => {
    const rows = await ctx.db
      .query('pendingGrants')
      .withIndex('by_email_status', (q) => q.eq('emailHash', hash).eq('status', 'pending'))
      .collect();
    let claimed = 0;
    for (const row of rows) {
      const product = await ctx.db.get(row.productId);
      if (!product) continue;
      const { outcome, entitlement } = await grantThroughRecord(ctx, { userId, product, sourceRef: row.auditId });
      if (!entitlement) {
        console.log(`pending grant ${row._id} left pending (${outcome})`);
        continue;
      }
      const before = pendingSnapshot(row);
      await ctx.db.patch(row._id, { status: 'claimed', claimedAt: Date.now(), entitlementId: entitlement._id });
      await writeAudit(ctx, {
        actorUserId: userId,
        action: 'grant.claim',
        target: `pending:${row._id}`,
        before,
        after: { ...pendingSnapshot((await ctx.db.get(row._id))!), outcome, editionNumber: entitlement.editionNumber ?? null },
        reason: CLAIM_REASON,
      });
      claimed++;
    }
    return { claimed };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// ADM-4 transfer

/** Ends a copy's open lends as returned (settling any that already ran out first). Returns the lends ended. */
async function returnOpenLends(ctx: MutationCtx, entitlementId: Id<'entitlements'>, now: number) {
  const ended: ReturnType<typeof lendSnapshot>[] = [];
  for (const status of ['offered', 'active'] as const) {
    const rows = await ctx.db
      .query('lends')
      .withIndex('by_entitlement_status', (q) => q.eq('entitlementId', entitlementId).eq('status', status))
      .collect();
    for (const row of rows) {
      const settled = await settleLend(ctx, row, now);
      if (isTerminal(settled.status)) continue;
      const reason = settled.status === 'offered' ? 'cancelled' : 'called_back';
      ended.push(lendSnapshot(await transitionLend(ctx, settled, 'returned', now, reason)));
    }
  }
  return ended;
}

/**
 * ADM-4: moves a licence to another account (an email or an account id). The row itself moves, so the edition
 * number, wear seed and wear stats go with it untouched (ENT-3, WEAR-3). The copy's open lends end as returned.
 * Refused when the target already owns the release (ENT-5).
 */
export const transfer = mutation({
  args: { entitlementId: v.string(), to: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const reason = cleanReason(args.reason);
    const row = await entitlementById(ctx, args.entitlementId);
    if (!isActiveEntitlement(row)) fail('INVALID_INPUT', `Only an active licence can be transferred (this one is ${row.status}).`);
    const target = await accountFor(ctx, args.to);
    if (row.userId === target._id) fail('INVALID_INPUT', 'That account already holds this licence.');
    if (await activeEntitlement(ctx, target._id, row.productId)) {
      fail('ALREADY_OWNED', 'That account already owns this release (ENT-5).');
    }

    const now = Date.now();
    const before = entitlementSnapshot(row);
    const lendsEnded = await returnOpenLends(ctx, row._id, now);
    await ctx.db.patch(row._id, { userId: target._id });
    const after = entitlementSnapshot((await ctx.db.get(row._id))!);
    const auditId = await writeAudit(ctx, {
      actorUserId: admin._id,
      action: 'entitlement.transfer',
      target: `entitlement:${row._id}`,
      before,
      after: { ...after, lendsEnded },
      reason,
    });
    return {
      entitlementId: row._id,
      fromUserId: row.userId ?? null,
      toUserId: target._id,
      editionNumber: row.editionNumber ?? null,
      lendsEnded: lendsEnded.length,
      auditId,
    };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// ADM-5 revoke, reset, disable

/**
 * ADM-5: revokes a licence through the payment revoke path (`fulfilment.revokeEntitlement`), one call per live
 * ref, so its open lends are revoked with it (LEND-10) and a replay of any of its payments stays revoked. The
 * edition is retired, never reused (ENT-4).
 */
export const revokeEntitlement = mutation({
  args: { entitlementId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const reason = cleanReason(args.reason);
    const row = await entitlementById(ctx, args.entitlementId);
    if (!isActiveEntitlement(row)) fail('INVALID_INPUT', `This licence is already ${row.status}.`);
    const before = entitlementSnapshot(row);
    await ensureOriginRef(ctx, row);
    const refs = await ctx.db
      .query('entitlementRefs')
      .withIndex('by_entitlement', (q) => q.eq('entitlementId', row._id))
      .collect();
    const openBefore: Id<'lends'>[] = [];
    for (const status of ['offered', 'active'] as const) {
      const rows = await ctx.db
        .query('lends')
        .withIndex('by_entitlement_status', (q) => q.eq('entitlementId', row._id).eq('status', status))
        .collect();
      openBefore.push(...rows.map((lend) => lend._id));
    }
    for (const ref of refs.filter((r) => r.status === 'active')) {
      await ctx.runMutation(internal.fulfilment.revokeEntitlement, {
        source: ref.source,
        sourceRef: ref.sourceRef,
        productId: row.productId,
      });
    }
    const revoked = (await ctx.db.get(row._id))!;
    if (isActiveEntitlement(revoked)) fail('INVALID_INPUT', 'This licence has no payment reference to revoke.');
    let lendsRevoked = 0;
    for (const id of openBefore) if ((await ctx.db.get(id))?.status === 'revoked') lendsRevoked++;
    const auditId = await writeAudit(ctx, {
      actorUserId: admin._id,
      action: 'entitlement.revoke',
      target: `entitlement:${row._id}`,
      before,
      after: { ...entitlementSnapshot(revoked), lendsRevoked },
      reason,
    });
    return { entitlementId: row._id, editionNumber: row.editionNumber ?? null, lendsRevoked, auditId };
  },
});

/** ADM-5: ends one lend now as revoked (offered or active only). The lender's copy is unlocked at once. */
export const revokeLend = mutation({
  args: { lendId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const reason = cleanReason(args.reason);
    const id = ctx.db.normalizeId('lends', args.lendId.trim());
    const row = id ? await ctx.db.get(id) : null;
    if (!row) fail('NOT_FOUND', 'Lend not found.');
    const now = Date.now();
    const settled = await settleLend(ctx, row, now);
    if (isTerminal(settled.status)) fail('INVALID_INPUT', `This lend has already ended (${settled.status}).`);
    const ended = await transitionLend(ctx, settled, 'revoked', now, 'lender_revoked');
    const auditId = await writeAudit(ctx, {
      actorUserId: admin._id,
      action: 'lend.revoke',
      target: `lend:${row._id}`,
      before: lendSnapshot(row),
      after: lendSnapshot(ended),
      reason,
    });
    return { lendId: row._id, status: ended.status, auditId };
  },
});

/** ADM-5: the unwrap plays again on the owner's next open (RACK-3). */
export const resetUnwrap = mutation({
  args: { entitlementId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const reason = cleanReason(args.reason);
    const row = await entitlementById(ctx, args.entitlementId);
    await ctx.db.patch(row._id, { unwrappedAt: undefined });
    const auditId = await writeAudit(ctx, {
      actorUserId: admin._id,
      action: 'entitlement.resetUnwrap',
      target: `entitlement:${row._id}`,
      before: entitlementSnapshot(row),
      after: entitlementSnapshot((await ctx.db.get(row._id))!),
      reason,
    });
    return { entitlementId: row._id, changed: row.unwrappedAt !== undefined, auditId };
  },
});

/**
 * WEAR-5: the only way wear goes down. Zeroes the cumulative stats; the seed stays (ENT-3), so the same scratches
 * come back in the same places as the copy is played again.
 */
export const resetWear = mutation({
  args: { entitlementId: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    const admin = await requireAdmin(ctx);
    const reason = cleanReason(args.reason);
    const row = await entitlementById(ctx, args.entitlementId);
    await ctx.db.patch(row._id, { wearStats: zeroWearStats() });
    const auditId = await writeAudit(ctx, {
      actorUserId: admin._id,
      action: 'entitlement.resetWear',
      target: `entitlement:${row._id}`,
      before: entitlementSnapshot(row),
      after: entitlementSnapshot((await ctx.db.get(row._id))!),
      reason,
    });
    return { entitlementId: row._id, auditId };
  },
});

/** ADM-5 stub: NFC tags arrive with PRD §16 (`nfcTags` does not exist yet). Nothing is written. */
export const disableNfcTag = mutation({
  args: { uid: v.string(), reason: v.string() },
  handler: async (ctx, args) => {
    await requireAdmin(ctx);
    cleanReason(args.reason);
    fail('NOT_CONFIGURED', 'NFC tags are not built yet (PRD §16).');
  },
});

// ---------------------------------------------------------------------------------------------------------------
// ADM-7 release management

const releaseStatusValidator = v.union(v.literal('draft'), v.literal('scheduled'), v.literal('live'));

const releasePatchValidator = {
  dropAt: v.optional(v.number()),
  status: v.optional(releaseStatusValidator),
  bundleVersion: v.optional(v.string()),
  bundleUrl: v.optional(v.string()),
  bundleSha256: v.optional(v.string()),
  appStoreProductIds: v.optional(v.array(v.string())),
  leaderboardSize: v.optional(v.number()),
  theme: v.optional(releaseThemeValidator),
};

export type ReleasePatch = {
  dropAt?: number;
  status?: 'draft' | 'scheduled' | 'live';
  bundleVersion?: string;
  bundleUrl?: string;
  bundleSha256?: string;
  appStoreProductIds?: string[];
  leaderboardSize?: number;
  theme?: Doc<'products'>['theme'];
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
/** BUN-1 versions look like 1.3.0 (semver, optional pre-release or build suffix). */
const BUNDLE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
const APP_STORE_PRODUCT_ID = /^[A-Za-z0-9._-]{1,100}$/;
/** A theme colour: hex, or a design token name such as `pink` or `ice` (DS-34). */
const THEME_COLOR = /^(?:#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|[a-z][a-z0-9-]{0,31})$/;
/** A backdrop is an https URL or a bundle-relative asset path. */
const RELATIVE_ASSET = /^(?!\/\/)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const MAX_LEADERBOARD = 10_000;
const MAX_PRODUCT_IDS = 10;
/** No release drops after this (epoch ms, 2100-01-01): catches seconds-for-milliseconds and typos. */
const LATEST_DROP_AT = 4_102_444_800_000;

export function isHttpsUrl(value: string): boolean {
  if (value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname !== '' && url.username === '' && url.password === '';
  } catch {
    return false;
  }
}

/**
 * Validates an ADM-7 patch against the current product at `now` and returns it cleaned. Bundle version, URL and
 * checksum move together (BUN-2: the app verifies the zip against the checksum). A release can only be scheduled
 * for a future drop, and a live release cannot carry a future `dropAt` (the drop job flips scheduled to live).
 */
export function validateReleasePatch(
  current: Pick<Doc<'products'>, 'dropAt' | 'status'>,
  patch: ReleasePatch,
  now: number,
): ReleasePatch {
  const clean: ReleasePatch = {};
  if (Object.values(patch).every((value) => value === undefined)) fail('INVALID_INPUT', 'Nothing to change.');

  if (patch.dropAt !== undefined) {
    if (!Number.isInteger(patch.dropAt) || patch.dropAt <= 0 || patch.dropAt > LATEST_DROP_AT) {
      fail('INVALID_INPUT', 'dropAt must be a time in epoch milliseconds.');
    }
    clean.dropAt = patch.dropAt;
  }
  if (patch.status !== undefined) clean.status = patch.status;

  const bundle = [patch.bundleVersion, patch.bundleUrl, patch.bundleSha256];
  if (bundle.some((value) => value !== undefined)) {
    if (bundle.some((value) => value === undefined)) {
      fail('INVALID_INPUT', 'Publish a bundle with its version, URL and SHA-256 together.');
    }
    const version = patch.bundleVersion!.trim();
    const url = patch.bundleUrl!.trim();
    const sha = patch.bundleSha256!.trim().toLowerCase();
    if (!BUNDLE_VERSION.test(version)) fail('INVALID_INPUT', 'bundleVersion must look like 1.3.0.');
    if (!isHttpsUrl(url)) fail('INVALID_INPUT', 'bundleUrl must be an https URL.');
    if (!SHA256_HEX.test(sha)) fail('INVALID_INPUT', 'bundleSha256 must be 64 hex characters.');
    Object.assign(clean, { bundleVersion: version, bundleUrl: url, bundleSha256: sha });
  }

  if (patch.appStoreProductIds !== undefined) {
    const ids = [...new Set(patch.appStoreProductIds.map((id) => id.trim()))];
    if (ids.length > MAX_PRODUCT_IDS) fail('INVALID_INPUT', `At most ${MAX_PRODUCT_IDS} App Store product ids.`);
    if (ids.some((id) => !APP_STORE_PRODUCT_ID.test(id))) {
      fail('INVALID_INPUT', 'App Store product ids use letters, digits, dots, dashes and underscores only.');
    }
    clean.appStoreProductIds = ids;
  }

  if (patch.leaderboardSize !== undefined) {
    const size = patch.leaderboardSize;
    if (!Number.isInteger(size) || size < 1 || size > MAX_LEADERBOARD) {
      fail('INVALID_INPUT', `leaderboardSize must be a whole number from 1 to ${MAX_LEADERBOARD}.`);
    }
    clean.leaderboardSize = size;
  }

  if (patch.theme !== undefined) {
    const { accent, accent2, backdropImage, lcdTint } = patch.theme;
    for (const color of [accent, accent2, ...(lcdTint === undefined ? [] : [lcdTint])]) {
      if (!THEME_COLOR.test(color.trim())) fail('INVALID_INPUT', 'Theme colours are hex (#ff3da8) or a token name (pink).');
    }
    const backdrop = backdropImage.trim();
    if (!isHttpsUrl(backdrop) && !RELATIVE_ASSET.test(backdrop)) {
      fail('INVALID_INPUT', 'backdropImage must be an https URL or a bundle asset path.');
    }
    clean.theme = {
      accent: accent.trim(),
      accent2: accent2.trim(),
      backdropImage: backdrop,
      ...(lcdTint === undefined ? {} : { lcdTint: lcdTint.trim() }),
    };
  }

  const status = clean.status ?? current.status;
  const dropAt = clean.dropAt ?? current.dropAt;
  const timing = clean.status !== undefined || clean.dropAt !== undefined;
  if (timing && status === 'scheduled' && (dropAt === undefined || dropAt <= now)) {
    fail('INVALID_INPUT', 'Scheduling a release needs a dropAt in the future.');
  }
  if (timing && status === 'live' && dropAt !== undefined && dropAt > now) {
    fail('INVALID_INPUT', 'A live release cannot have a future dropAt. Schedule it instead.');
  }
  return clean;
}

/** ADM-7: set a release's drop, status, bundle, App Store product ids, leaderboard size and theme. */
export const updateRelease = mutation({
  args: { slug: v.string(), reason: v.string(), ...releasePatchValidator },
  handler: async (ctx, { slug, reason: rawReason, ...patch }) => {
    const admin = await requireAdmin(ctx);
    const reason = cleanReason(rawReason);
    const product = await productBySlug(ctx, slug);
    const clean = validateReleasePatch(product, patch, Date.now());
    await ctx.db.patch(product._id, clean);
    const after = (await ctx.db.get(product._id))!;
    const auditId = await writeAudit(ctx, {
      actorUserId: admin._id,
      action: 'release.update',
      target: `product:${product.slug}`,
      before: releaseSnapshot(product),
      after: releaseSnapshot(after),
      reason,
    });
    return { slug: product.slug, changed: Object.keys(clean), auditId };
  },
});

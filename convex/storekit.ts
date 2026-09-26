import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, httpAction, internalQuery } from './_generated/server';
import type { GrantOutcome } from './fulfilment';
import { fail } from './lib/errors';
import {
  appleAnchors,
  base64ToBytes,
  checkTransaction,
  VerificationError,
  verifySignedData,
  type StoreKitTransaction,
  type TrustAnchor,
} from './storekitLogic';

/**
 * StoreKit 2, verified server side (PRD §7.2 PAY-4..9, §7.3 PAY-10). No RevenueCat.
 *
 * - `verifyPurchase`: the app sends `transaction.jwsRepresentation` after a purchase, for each
 *   `Transaction.unfinished` on launch (PAY-7) and for each `Transaction.currentEntitlements` on Restore
 *   (PAY-9). We verify Apple's signature chain (storekitLogic.ts), then grant through the single grant path,
 *   `fulfilment.record` with `source: 'storekit'`, keyed on `originalTransactionId`, so every retry is idempotent.
 *   The app calls `transaction.finish()` only when this returns `finish: true` (PAY-6).
 * - `POST /appstore/notifications`: App Store Server Notifications V2. REFUND and REVOKE revoke through the same
 *   per-payment revoke as Stripe refunds (so LEND-10 cascades to the copy's lends); everything else is logged.
 *
 * Config (Convex env):
 * - `STOREKIT_ENVIRONMENTS`: comma list of accepted environments, default `Production,Sandbox` (App Review and
 *   TestFlight purchase in Sandbox against the production app). Set `Production` to refuse Sandbox.
 * - `STOREKIT_ALLOW_XCODE_TEST=true` plus `STOREKIT_XCODE_TEST_CERT` (base64 DER of the certificate Xcode
 *   exports from the .storekit file, Editor > Save Public Certificate): accept Xcode local StoreKit testing
 *   transactions (`environment: 'Xcode'`). Ignored on the production deployment whatever the env says.
 */

const PRODUCTION_DEPLOYMENT = 'loyal-tortoise-999';
const DEFAULT_ENVIRONMENTS = ['Production', 'Sandbox'];

/** Outcomes where the server has a final answer, so the app may finish the transaction. */
const GRANTED: readonly GrantOutcome[] = ['created', 'early_paid', 'replayed', 'owned'];
const FINAL: readonly GrantOutcome[] = [...GRANTED, 'revoked', 'retired', 'taken'];

function isProductionDeployment(): boolean {
  return (process.env.CONVEX_CLOUD_URL ?? '').includes(PRODUCTION_DEPLOYMENT);
}

function xcodeTestingAllowed(): boolean {
  return process.env.STOREKIT_ALLOW_XCODE_TEST === 'true' && !isProductionDeployment();
}

/** Apple's root, plus Xcode's local test certificate when local testing is switched on (never in production). */
function trustAnchors(): TrustAnchor[] {
  const anchors = [...appleAnchors()];
  const cert = process.env.STOREKIT_XCODE_TEST_CERT;
  if (xcodeTestingAllowed() && cert) {
    try {
      anchors.push({ der: base64ToBytes(cert.replace(/\s+/g, '')), kind: 'xcode' });
    } catch {
      console.error('storekit: STOREKIT_XCODE_TEST_CERT is not base64');
    }
  }
  return anchors;
}

function allowedEnvironments(anchor: TrustAnchor): Set<string> {
  // Xcode's certificate only ever vouches for Xcode transactions, and Apple's never does.
  if (anchor.kind === 'xcode') return new Set(['Xcode']);
  const configured = (process.env.STOREKIT_ENVIRONMENTS ?? '')
    .split(',')
    .map((env) => env.trim())
    .filter((env) => env === 'Production' || env === 'Sandbox');
  return new Set(configured.length > 0 ? configured : DEFAULT_ENVIRONMENTS);
}

type Verified = { ok: true; transaction: StoreKitTransaction } | { ok: false; reason: string };

/** Verifies one signed transaction (JWS) end to end. Reasons are codes, safe to log. */
async function verifyTransaction(jws: string, now: number): Promise<Verified> {
  try {
    const { payload, anchor } = await verifySignedData(jws, trustAnchors(), now);
    const checked = checkTransaction(payload, allowedEnvironments(anchor));
    return checked.ok ? { ok: true, transaction: checked.transaction } : { ok: false, reason: checked.problem };
  } catch (error) {
    if (error instanceof VerificationError) return { ok: false, reason: error.reason };
    throw error;
  }
}

export const productForAppStoreId = internalQuery({
  args: { appStoreProductId: v.string() },
  handler: async (ctx, { appStoreProductId }): Promise<{ productId: Id<'products'>; name: string } | null> => {
    const products = await ctx.db.query('products').collect();
    const product = products.find((p) => p.appStoreProductIds?.includes(appStoreProductId));
    return product ? { productId: product._id, name: product.name } : null;
  },
});

/**
 * PAY-5: verify a StoreKit 2 transaction and grant it to the signed-in caller. PAY-6: finish the transaction
 * only when `finish` is true (`granted`, or a final refusal such as a refunded or already-claimed purchase).
 */
export const verifyPurchase = action({
  args: { signedTransaction: v.string() },
  handler: async (
    ctx,
    { signedTransaction },
  ): Promise<{ granted: boolean; editionNumber: number | null; outcome: GrantOutcome; slug: string; finish: boolean }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) fail('UNAUTHENTICATED', 'Sign in to continue.');
    const verified = await verifyTransaction(signedTransaction, Date.now());
    if (!verified.ok) {
      console.warn(`storekit: purchase rejected (${verified.reason})`);
      fail('INVALID_INPUT', 'This purchase could not be verified.');
    }
    const tx = verified.transaction;
    const product = await ctx.runQuery(internal.storekit.productForAppStoreId, { appStoreProductId: tx.productId });
    if (!product) {
      console.warn(`storekit: unknown productId for transaction ${tx.transactionId}`);
      fail('NOT_FOUND', 'Unknown product.');
    }
    if (tx.revocationDate !== undefined) {
      // Refunded or revoked before it reached us; the notification (or a replay of it) revokes any grant.
      return { granted: false, editionNumber: null, outcome: 'revoked', slug: '', finish: true };
    }
    const result = await ctx.runMutation(internal.fulfilment.record, {
      source: 'storekit',
      sourceRef: tx.originalTransactionId,
      clerkId: identity.subject,
      email: identity.email ?? '',
      name: identity.name,
      amountTotal: tx.price !== undefined ? Math.round(tx.price / 10) : 0,
      currency: (tx.currency ?? 'usd').toLowerCase(),
      lineItems: [
        { description: product.name, quantity: 1, unitAmount: tx.price !== undefined ? Math.round(tx.price / 10) : 0, appStoreProductId: tx.productId },
      ],
    });
    const grant = result.grants[0];
    if (!grant) fail('NOT_FOUND', 'Unknown product.');
    console.log(`storekit: transaction ${tx.transactionId} -> ${grant.outcome}`);
    return {
      granted: GRANTED.includes(grant.outcome),
      editionNumber: GRANTED.includes(grant.outcome) ? grant.editionNumber : null,
      outcome: grant.outcome,
      slug: grant.slug,
      finish: FINAL.includes(grant.outcome),
    };
  },
});

/**
 * App Store Server Notifications V2 (PAY-8). Configure in App Store Connect > App > App Information > App Store
 * Server Notifications, Version 2, for Production and Sandbox. Apple retries anything but 2xx, so a verified
 * notification we don't act on is still 200; a payload that fails verification is 400.
 */
export const handleNotification = httpAction(async (ctx, request) => {
  const now = Date.now();
  let signedPayload: unknown;
  try {
    signedPayload = (JSON.parse(await request.text()) as { signedPayload?: unknown }).signedPayload;
  } catch {
    return new Response('Bad request', { status: 400 });
  }
  if (typeof signedPayload !== 'string') return new Response('Bad request', { status: 400 });

  let notification: Record<string, unknown>;
  let anchor: TrustAnchor;
  try {
    ({ payload: notification, anchor } = await verifySignedData(signedPayload, trustAnchors(), now));
  } catch (error) {
    if (!(error instanceof VerificationError)) throw error;
    console.warn(`storekit notification rejected (${error.reason})`);
    return new Response('Invalid signature', { status: 400 });
  }
  const type = typeof notification.notificationType === 'string' ? notification.notificationType : 'UNKNOWN';
  const subtype = typeof notification.subtype === 'string' ? `/${notification.subtype}` : '';
  const uuid = typeof notification.notificationUUID === 'string' ? notification.notificationUUID : '';
  const ok = (note: string) => {
    console.log(`storekit notification ${type}${subtype} ${uuid}: ${note}`);
    return new Response('ok', { status: 200 });
  };

  if (type !== 'REFUND' && type !== 'REVOKE') return ok('logged');
  if (!uuid) return new Response('Bad request', { status: 400 });
  const data = notification.data as { bundleId?: unknown; environment?: unknown; signedTransactionInfo?: unknown } | undefined;
  if (typeof data?.signedTransactionInfo !== 'string') return new Response('Bad request', { status: 400 });
  const verified = await verifyTransaction(data.signedTransactionInfo, now);
  if (!verified.ok) {
    // Validly signed by Apple but not ours to act on (another bundle, an environment we don't accept).
    return verified.reason === 'bundle' || verified.reason === 'environment' || verified.reason === 'type'
      ? ok(`ignored (${verified.reason})`)
      : new Response('Invalid transaction', { status: 400 });
  }
  if (anchor.kind !== 'apple' && verified.transaction.environment !== 'Xcode') return ok('ignored (environment)');
  const tx = verified.transaction;
  const product = await ctx.runQuery(internal.storekit.productForAppStoreId, { appStoreProductId: tx.productId });
  const result = await ctx.runMutation(internal.fulfilment.revokeEntitlement, {
    source: 'storekit',
    sourceRef: tx.originalTransactionId,
    // Idempotent on notificationUUID: recorded with the revoke in one transaction (the processed-events table).
    eventId: `appstore:${uuid}`,
    eventType: `appstore.${type}`,
    reason: 'refunded',
    ...(product ? { productId: product.productId, productIds: [product.productId] } : {}),
  });
  return ok(result.alreadyProcessed ? 'duplicate' : `revoked ${result.entitlementsRevoked}, tombstones ${result.tombstones}`);
});

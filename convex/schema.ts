import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

export const shippingValidator = v.object({
  name: v.string(),
  line1: v.string(),
  line2: v.optional(v.string()),
  city: v.string(),
  state: v.optional(v.string()),
  postalCode: v.string(),
  country: v.string(),
});

/** Where a licence came from (PAY-10): every channel grants through `fulfilment.record`. */
export const entitlementSourceValidator = v.union(
  v.literal('stripe'),
  v.literal('storekit'),
  v.literal('nfc'),
  v.literal('admin'),
);

/** Cumulative wear inputs (PRD §11.2). Never lowered, so pruning `plays` never un-wears a disc. */
export const wearStatsValidator = v.object({
  playSeconds: v.number(),
  loads: v.number(),
  ejects: v.number(),
  lentPlaySeconds: v.number(),
});

/** Per-release theme for the app (PRD §4A.8). */
export const releaseThemeValidator = v.object({
  accent: v.string(),
  accent2: v.string(),
  backdropImage: v.string(),
  lcdTint: v.optional(v.string()),
});

export default defineSchema({
  products: defineTable({
    slug: v.string(),
    name: v.string(),
    kind: v.union(v.literal('digital'), v.literal('physical')),
    stripeProductIds: v.array(v.string()),
    coverUrl: v.optional(v.string()),
    /** Album download (zip) in Convex file storage. */
    downloadFile: v.optional(v.id('_storage')),
    active: v.boolean(),
    // App V1 (PRD §3A). Optional so the existing rows validate; a product without `dropAt` is on sale now.
    /**
     * Server epoch ms, the single source of truth for launch. Paid grants before it are presale (granted,
     * never numbered); editions start at the first paid grant after it (ED-3). Unpaid grants wait for it.
     */
    dropAt: v.optional(v.number()),
    /** False stops web checkout before the drop (NOT_YET_LIVE). Missing means presale is allowed. */
    presaleAllowed: v.optional(v.boolean()),
    status: v.optional(v.union(v.literal('draft'), v.literal('scheduled'), v.literal('live'))),
    bundleVersion: v.optional(v.string()),
    bundleUrl: v.optional(v.string()),
    bundleSha256: v.optional(v.string()),
    /** StoreKit non-consumables that all grant this product (PAY-4, PAY-11 price tiers). */
    appStoreProductIds: v.optional(v.array(v.string())),
    leaderboardSize: v.optional(v.number()),
    theme: v.optional(releaseThemeValidator),
  }).index('by_slug', ['slug']),

  /** The next edition number per product (ED-1). Only `fulfilment.record` and the ED-0 migration write it. */
  releaseCounters: defineTable({
    productId: v.id('products'),
    nextEdition: v.number(),
  }).index('by_product', ['productId']),

  tracks: defineTable({
    productId: v.id('products'),
    position: v.number(),
    title: v.string(),
    durationSeconds: v.number(),
    format: v.literal('mp3'),
    /** The full song in Convex file storage (MP3), and the lossless original when it differs. */
    streamFile: v.optional(v.id('_storage')),
    originalFile: v.optional(v.id('_storage')),
  }).index('by_product_position', ['productId', 'position']),

  users: defineTable({
    clerkId: v.string(),
    email: v.string(),
    name: v.optional(v.string()),
    isAdmin: v.boolean(),
    marketingConsentAt: v.optional(v.number()),
    /** LB-2, NFR-2: false shows "Anonymous collector" on leaderboards. Missing means visible (the default). */
    leaderboardVisible: v.optional(v.boolean()),
  })
    .index('by_clerkId', ['clerkId'])
    .index('by_email', ['email']),

  entitlements: defineTable({
    /** Detached when the owner deletes their account: the row stays as a retired edition (NFR-2, §3A). */
    userId: v.optional(v.id('users')),
    productId: v.id('products'),
    /** Set for Stripe grants only; StoreKit, NFC and admin grants have no checkout session. */
    stripeSessionId: v.optional(v.string()),
    grantedAt: v.number(),
    // App V1 (PRD §5). Optional only because rows granted before the ED-0 migration lack them;
    // `fulfilment.record` always sets them (the edition may wait for the migration, see lib/editions.ts).
    /** Unique per product, never changed or reused (ENT-3, ENT-4). */
    editionNumber: v.optional(v.number()),
    /** Granted before the product's drop (a paid presale): never numbered, never blocks numbering (ED-3). */
    presale: v.optional(v.boolean()),
    /** The payment, tag or audit entry that first granted it. Every later one is in `entitlementRefs`. */
    source: v.optional(entitlementSourceValidator),
    /** Checkout session id, originalTransactionId, tag uid or audit id. */
    sourceRef: v.optional(v.string()),
    /** Missing means active (rows from before the migration). Only `active` (or missing) is owned. */
    status: v.optional(v.union(v.literal('active'), v.literal('revoked'), v.literal('retired'))),
    revokedAt: v.optional(v.number()),
    retiredAt: v.optional(v.number()),
    /** 128-bit hex, set once at grant, immutable (ENT-3). */
    wearSeed: v.optional(v.string()),
    wearStats: v.optional(wearStatsValidator),
    wearModelVersion: v.optional(v.number()),
    unwrappedAt: v.optional(v.number()),
    /** LEND-9: the borrower's lend this purchase converted (analytics; lender rewards are [DECIDE]). */
    convertedFromLendId: v.optional(v.id('lends')),
  })
    .index('by_user_product', ['userId', 'productId'])
    .index('by_session', ['stripeSessionId'])
    // grantedAt last: the rows still awaiting an edition come back in grant order (ED-0).
    .index('by_product_edition', ['productId', 'editionNumber', 'grantedAt'])
    .index('by_source_ref', ['source', 'sourceRef', 'productId']),

  /**
   * Every payment (or tag, or audit entry) that backs an entitlement, append-only (ENT-5, PAY-3). A child
   * table rather than an array on the entitlement because each ref needs an indexed lookup for idempotency
   * and refunds, and Convex cannot index into arrays. Rows are never deleted; only `status` changes. An
   * entitlement is revoked when none of its refs is active. A ref with no entitlement is a tombstone for a
   * payment refunded before fulfilment.
   */
  entitlementRefs: defineTable({
    /** Missing on a tombstone: a payment refunded or disputed before it was fulfilled, so it never grants. */
    entitlementId: v.optional(v.id('entitlements')),
    productId: v.id('products'),
    source: entitlementSourceValidator,
    sourceRef: v.string(),
    status: v.union(v.literal('active'), v.literal('refunded'), v.literal('disputed')),
    at: v.number(),
    changedAt: v.optional(v.number()),
  })
    .index('by_ref', ['source', 'sourceRef', 'productId'])
    .index('by_entitlement', ['entitlementId']),

  orders: defineTable({
    userId: v.id('users'),
    stripeSessionId: v.string(),
    totalCents: v.number(),
    currency: v.string(),
    shipping: v.optional(shippingValidator),
    status: v.union(v.literal('paid'), v.literal('fulfilled'), v.literal('cancelled')),
    createdAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_session', ['stripeSessionId']),

  orderItems: defineTable({
    orderId: v.id('orders'),
    productId: v.optional(v.id('products')),
    description: v.string(),
    variant: v.optional(v.string()),
    quantity: v.number(),
    unitCents: v.number(),
  }).index('by_order', ['orderId']),

  plays: defineTable({
    userId: v.id('users'),
    trackId: v.id('tracks'),
    playedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_playedAt', ['playedAt']),

  /**
   * App play, load and eject events (WEAR-6..8, `plays.recordPlayEvents`). A table of its own rather than new
   * fields on `plays`: `plays` is the website's per-user history (`plays.log`), while these are keyed on the copy
   * and need an idempotency index. Wear reads `entitlements.wearStats`, never these rows, so pruning them (with
   * `plays`, after 12 months) never lowers wear. Idempotency outlives pruning because events older than 60 days
   * are rejected anyway.
   */
  playEvents: defineTable({
    /** Client generated UUID (WEAR-6). */
    idempotencyKey: v.string(),
    /** The copy that wears: the actor's own licence, or the lender's when `lendId` is set. */
    entitlementId: v.id('entitlements'),
    actorUserId: v.id('users'),
    /** Set when a borrower played the lender's copy (LEND-6). */
    lendId: v.optional(v.id('lends')),
    /** Missing for a load or eject reported by release. */
    trackId: v.optional(v.id('tracks')),
    kind: v.union(v.literal('play'), v.literal('load'), v.literal('eject')),
    startedAtClient: v.number(),
    receivedAt: v.number(),
    /** Clamped server side (WEAR-7). 0 for loads and ejects. */
    playedSec: v.number(),
    /** What went into wear after the daily cap (WEAR-8). */
    countedSec: v.number(),
    counted: v.boolean(),
  })
    .index('by_idem', ['idempotencyKey'])
    .index('by_entitlement', ['entitlementId'])
    .index('by_actor', ['actorUserId'])
    .index('by_receivedAt', ['receivedAt']),

  /**
   * Per copy, per UTC day of `startedAtClient`: what wear already counted, so the WEAR-8 cap and the load/eject
   * rate limit cost one read per event. Pruned once a day can no longer receive events (60 days).
   */
  wearDays: defineTable({
    entitlementId: v.id('entitlements'),
    day: v.number(),
    playSec: v.number(),
    handling: v.number(),
    lastLoadAt: v.optional(v.number()),
    lastEjectAt: v.optional(v.number()),
  })
    .index('by_entitlement_day', ['entitlementId', 'day'])
    .index('by_day', ['day']),

  /** APNs (and later FCM) device tokens with alert categories (DROP-6, LEND-11). */
  pushTokens: defineTable({
    userId: v.id('users'),
    token: v.string(),
    platform: v.union(v.literal('ios'), v.literal('android')),
    /** APNs environment the token belongs to (TestFlight and App Store are production). */
    environment: v.optional(v.union(v.literal('sandbox'), v.literal('production'))),
    wantsDropAlerts: v.boolean(),
    /** Missing means on. */
    wantsLendAlerts: v.optional(v.boolean()),
    updatedAt: v.number(),
  })
    .index('by_user', ['userId'])
    .index('by_token', ['token']),

  /**
   * Lends (PRD §12.1, fields exactly as specified). One row per offer of one copy; the state machine is in
   * `lendLogic.ts` and every transition happens in a mutation. The extra indexes serve the lender's history
   * (`lends.mine`) and the 15 minute expiry job (LEND-7).
   */
  lends: defineTable({
    entitlementId: v.id('entitlements'),
    lenderUserId: v.id('users'),
    borrowerUserId: v.optional(v.id('users')),
    claimToken: v.string(),
    channel: v.union(v.literal('link'), v.literal('nfc')),
    status: v.union(
      v.literal('offered'),
      v.literal('active'),
      v.literal('exhausted'),
      v.literal('expired'),
      v.literal('returned'),
      v.literal('revoked'),
      v.literal('converted'),
      v.literal('unclaimed_expired'),
    ),
    playsAllowed: v.number(),
    playsUsed: v.number(),
    offeredAt: v.number(),
    claimedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    endedAt: v.optional(v.number()),
    endReason: v.optional(v.string()),
  })
    .index('by_entitlement_status', ['entitlementId', 'status'])
    .index('by_borrower_status', ['borrowerUserId', 'status'])
    .index('by_token', ['claimToken'])
    .index('by_lender', ['lenderUserId'])
    .index('by_status_expires', ['status', 'expiresAt'])
    .index('by_status_offered', ['status', 'offeredAt']),

  /**
   * LEND-5 play sessions: `lends.startLentPlay` opens one (server time), `commitLentPlay` counts it once the track
   * has passed 30 seconds, idempotent per session. `eventKey` is the play event that reported it, so a play made
   * during the lend still reaches the lender's wear when its event is flushed after the lend ended (LEND-6).
   */
  lentPlays: defineTable({
    lendId: v.id('lends'),
    trackId: v.id('tracks'),
    startedAt: v.number(),
    committedAt: v.optional(v.number()),
    eventKey: v.optional(v.string()),
  }).index('by_lend_track', ['lendId', 'trackId']),

  /**
   * LEND-11 push intents. Sending is a stub (APNs is not set up, see push.ts): each row is one notification the
   * sender will deliver, at most one per lend and kind. `sentAt` is for the future sender.
   */
  lendNotices: defineTable({
    lendId: v.id('lends'),
    userId: v.id('users'),
    kind: v.union(v.literal('claimed'), v.literal('ended'), v.literal('expiring_soon'), v.literal('one_play_left')),
    createdAt: v.number(),
    sentAt: v.optional(v.number()),
  })
    .index('by_lend_kind', ['lendId', 'kind'])
    .index('by_user', ['userId']),

  stripeEvents: defineTable({
    eventId: v.string(),
    type: v.string(),
    processedAt: v.number(),
  }).index('by_eventId', ['eventId']),

  /**
   * ADM-6: one row per admin action (and per ENT-2 claim), append-only. Nothing exports an update or delete;
   * `adminActions.ts` completes a row only inside the mutation that inserted it. Targets are ids, never emails.
   */
  auditLog: defineTable({
    actorUserId: v.id('users'),
    action: v.string(),
    target: v.string(),
    before: v.any(),
    after: v.any(),
    reason: v.string(),
    at: v.number(),
  }).index('by_target', ['target']),

  /**
   * ENT-2: admin grants to an email with no account, claimed at sign in by a matching verified email. Holds a
   * SHA-256 of the normalised email, never the email itself. `auditId` is the grant's `sourceRef`.
   */
  pendingGrants: defineTable({
    emailHash: v.string(),
    productId: v.id('products'),
    auditId: v.id('auditLog'),
    status: v.union(v.literal('pending'), v.literal('claimed')),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    entitlementId: v.optional(v.id('entitlements')),
  }).index('by_email_status', ['emailHash', 'status']),
});

# App V1 API (Convex)

The iOS app codes against this file. Every function below is a public Convex function unless marked
internal. Call them with the Convex Swift client, signed in with the Clerk JWT template `convex`.

- **IDs** (`releaseId`, `trackId`, ...) are opaque strings. Never parse them.
- **Times** are server epoch milliseconds (`number`). Correct countdowns with `serverNow` (DROP-1), never the
  device clock alone.
- **Errors** are `ConvexError` with `data = { code, message }`. `message` is safe to show. Codes:
  `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_ENTITLED`, `NOT_FOUND`, `INVALID_INPUT`, `NOT_CONFIGURED`,
  `NOT_YET_LIVE`, `ALREADY_OWNED` (plus web-only codes the app never sees).
- **Nothing returns a storage id or a file URL** (ARCH-4). Audio only comes from `media.getStreamUrl`.
- **Lends and StoreKit are live** (wave 2): see the `lends` and `storekit` sections at the end.

Source: `convex/app.ts`, `convex/plays.ts`, `convex/media.ts`, `convex/leaderboard.ts`, `convex/push.ts`,
`convex/privacy.ts`, `convex/wear.ts`, `convex/lends.ts` (+ `lendLogic.ts`), `convex/storekit.ts` (+ `storekitLogic.ts`).

## Shared types

```ts
type Ownership = 'owned' | 'lent' | 'locked' | 'preview';
// owned   = the caller holds a live licence (refunded and deleted-account licences are not live)
// lent    = the caller holds an active lend of someone else's copy (wave 2)
// locked  = before the drop (dropAt in the future) and not owned
// preview = otherwise: the 30 second previews

type ReleaseStatus = 'draft' | 'scheduled' | 'live';

type Theme = { accent: string; accent2: string; backdropImage: string; lcdTint?: string }; // PRD 4A.8

type Bundle = { version: string; url: string; sha256: string }; // BUN-2: verify sha256 before unpacking

type LendInfo = {
  lendId: string;
  playsAllowed: number;
  playsUsed: number;
  expiresAt: number;
  // 'offered' only reaches the lender (their link is out, not yet claimed; expiresAt = when the link lapses).
  // The bridge's LendState has no 'offered': native omits `lend` from getContext for it.
  status: 'offered' | 'active' | 'exhausted' | 'expired' | 'returned' | 'revoked' | 'converted';
  endReason: string | null;
  role: 'borrower' | 'lender'; // borrower: a lent copy; lender: the caller's own copy is out on this lend
  endScreen: LendEndScreen | null; // LEND-8, borrower only, when status is 'exhausted' or 'expired'
};

// LEND-8: the native end screen: the owner's disc and a "Get your own copy" StoreKit button.
type LendEndScreen = {
  reason: 'exhausted' | 'expired';
  headline: string;              // "That was the last play on this loan." / "This loan has ended."
  slug: string;
  releaseTitle: string;
  editionNumber: number | null;  // the lender's edition
  ownerDisplayName: string;      // the lender's public name
  appStoreProductIds: string[];  // buy any tier (PAY-11); empty until the products exist
};

// PRD 11.4, produced by computeWear (packages/wear). All numbers are exact multiples of 1e-6.
type WearDescriptor = {
  version: number;
  seed: string;
  level: number; // 0..1
  scratches: Array<{ surface: 'shell' | 'window' | 'label' | 'disc'; x: number; y: number; angle: number; length: number; depth: number }>;
  scuffZones: Array<{ surface: 'shell' | 'window' | 'label' | 'disc'; x: number; y: number; radius: number; intensity: number }>;
  labelFade: number; // 0..0.35
  edgeWear: number; // 0..1
  dustAmount: number; // 0..0.3
};

// The inputs behind the descriptor. WEAR-9: the offline provisional overlay is
// computeWear(seed, stats + locally queued plays, version) with the Swift port. Bundles that declare
// wearSafeZones in manifest.json recompute from these with their zones (the server descriptor has no zones).
type WearInputs = {
  seed: string;
  stats: { playSeconds: number; loads: number; ejects: number; lentPlaySeconds: number };
  version: number;
};
```

## app

### `app.library` (query)

Args: `{}`. Works signed out (upcoming releases only).

Returns:
```ts
{
  serverNow: number;
  releases: Array<{
    releaseId: string;
    slug: string;
    title: string;
    ownership: Ownership;          // only 'owned', 'lent' or 'locked' appear here
    editionNumber: number | null;  // null for presale copies and non-owners
    unwrapped: boolean;
    dropAt: number | null;         // null: no scheduled drop (on sale now)
    status: ReleaseStatus;         // missing on the server reads as 'live'
    theme: Theme | null;
    bundle: Bundle | null;         // null until a bundle is published for the release
    lend: LendInfo | null;
    grantedAt: number | null;      // the caller's licence grant time; null for lent and locked
  }>;
}
```
Order (RACK-1): owned and lent copies, newest licence first; then upcoming locked releases, soonest drop
first. Live releases the caller doesn't own and draft releases are not included.

### `app.context` (query)

The bridge's `getContext` data (PRD 10.2). Native adds `platform`, `layout` and `lifecycle` before handing it
to the bundle, and drops `slug`, `title`, `status` and `wearInputs` if it wants the exact bridge shape.

Args: `{ slug: string }`. Works signed out (`locked` or `preview`). Throws `NOT_FOUND` for an unknown slug.

Returns:
```ts
{
  releaseId: string;
  slug: string;
  title: string;
  ownership: Ownership;
  editionNumber: number | null;
  ownerDisplayName: string | null; // owned: the caller's public name; lent: the lender's; else null
  wear: WearDescriptor | null;     // null unless owned or lent (or a pre-migration copy with no seed)
  wearInputs: WearInputs | null;
  unwrapped: boolean;
  dropAt: number;                  // 0 when the release has no scheduled drop (on sale now)
  status: ReleaseStatus;
  serverNow: number;
  lend: LendInfo | null;           // bridge `lend?`: omit it when null
}
```
Public names are first name plus last initial ("Lawrence B."), or "Collector" with no name. Never an email.
It's a live query: re-render on every update (it changes after `recordPlayEvents`, `markUnwrapped`, a refund,
the drop going live). The bridge's `wear` and `ownership` events (WEAR-10) come from these updates.

### `app.tracks` (query)

Args: `{ slug: string }`. Public. Throws `NOT_FOUND` for an unknown slug.

Returns: `Array<{ id: string; position: number; title: string; durationSeconds: number }>`, in album order.
The preview flag and preview durations are the app's (ownership `preview` or `locked`).

### `app.markUnwrapped` (mutation, RACK-3)

Args: `{ slug: string }`. Owner only (`NOT_ENTITLED` otherwise, including borrowers).

Returns: `{ unwrappedAt: number; alreadyUnwrapped: boolean }`. Sets `unwrappedAt` once; calling it again
returns the first time with `alreadyUnwrapped: true`.

### `app.recordCartridgeEvent` (mutation)

The bridge's `cartridgeLoaded` / `cartridgeEjected` while online.

Args:
```ts
{
  slug: string;
  kind: 'load' | 'eject';
  idempotencyKey?: string; // optional client UUID (8-128 chars of A-Z a-z 0-9 : _ -): a retry is a no-op
  lendId?: string;         // borrower's copy (wave 2)
}
```
Returns: `{ counted: boolean; duplicate: boolean; limitedBy: 'rate_limited' | 'daily_cap' | null }`.
At most one load and one eject per 2 seconds per copy, and 100 loads plus ejects per copy per UTC day, count
towards wear. Anything over is recorded with `counted: false`, not an error. Throws `NOT_ENTITLED` without a
copy. Offline loads and ejects go in the `plays.recordPlayEvents` queue instead.

## plays

### `plays.recordPlayEvents` (mutation, WEAR-6..9)

Flush the durable offline queue. Signed in (`UNAUTHENTICATED` otherwise). At most 500 events per call
(`INVALID_INPUT` otherwise); flush a bigger queue in slices.

Args:
```ts
{
  events: Array<{
    idempotencyKey: string;        // client UUID per event, 8-128 chars of A-Z a-z 0-9 : _ -
    kind?: 'play' | 'load' | 'eject'; // default 'play'
    trackId?: string;              // required for 'play'
    slug?: string;                 // a load or eject names its track or its release
    startedAtClient: number;       // device epoch ms when the session started
    playedSec?: number;            // seconds heard (plays only)
    lendId?: string;               // set when playing a borrowed copy (wave 2)
  }>;
}
```

Returns:
```ts
{
  results: Array<{               // same order as `events`
    idempotencyKey: string;
    status: 'recorded' | 'duplicate' | 'rejected';
    reason: 'invalid' | 'future' | 'too_old' | 'unknown_track' | 'no_access' | null; // set when rejected
    countedSec: number;          // seconds added to wear
    counted: boolean;            // whether it added wear
    limitedBy: 'clamp' | 'daily_cap' | 'rate_limited' | null;
  }>;
  recorded: number;
  duplicates: number;
  rejected: number;
}
```

Rules the server applies (the client never computes authoritative wear):
- **Idempotent (WEAR-6):** a key already stored, or repeated in the same batch, is `duplicate` and changes
  nothing. Remove every event with status `recorded`, `duplicate` or `rejected` from the queue; a thrown
  error (network, auth) means keep the whole batch and retry.
- **Clamp (WEAR-7):** `playedSec` is cut to `durationSeconds × 1.05`, and to the time elapsed since
  `startedAtClient`.
- **Time (WEAR-7):** `startedAtClient` more than 15 minutes ahead of the server is `future`; older than 60
  days is `too_old`. Rejected events are not stored.
- **Daily cap (WEAR-8):** at most 8 hours count per copy per UTC day of `startedAtClient`, owner and borrower
  plays together. The excess is recorded with `limitedBy: 'daily_cap'` and adds no wear.
- Wear is cumulative on the copy. Lent plays add to the lender's `lentPlaySeconds` (LEND-6).
- Needs a live licence (or an active lend) at flush time: plays queued before a refund come back `no_access`.

### `plays.log` (mutation, website only)

Unchanged: `{ trackId }`, the website's play history. The app does not call it.

## media (AUD-1, AUD-2)

### `media.getStreamUrl` (action)

Args: `{ trackId: string; lendId?: string }`.

Returns: `{ url: string; expiresAt: number }`. `url` is
`https://<deployment>.convex.site/media/stream?t=<token>`, valid for 5 minutes (`expiresAt`). Hand it to
`AVURLAsset` as is. Ask for a new one per track, and again when it expires (a range request started before
`expiresAt` completes; a new one after it gets 403).

Throws: `UNAUTHENTICATED`; `NOT_ENTITLED` (no live licence or active lend, or the caller's copy is out on
loan); `NOT_FOUND` (unknown track); `NOT_YET_LIVE` (before the drop, presale owners included);
`NOT_CONFIGURED` (audio not uploaded, or the server's token secret or delivery mode isn't set).

### `GET /media/stream?t=<token>` (HTTP route)

- The token (HMAC-SHA256, key `MEDIA_TOKEN_SECRET`) binds one track, one account and an expiry. It never
  serves another track. Access is checked again on every request, so a refund stops playback within the
  5 minutes too.
- `Range: bytes=a-b`, `bytes=a-` and `bytes=-n` return `206` with `Content-Range: bytes a-b/size`,
  `Content-Length` and `Accept-Ranges: bytes`. One response carries at most 8 MB; an open-ended range gets the
  first 8 MB and the player asks for the rest. No `Range` header gives `200` with the whole file.
- `400` missing token; `403` invalid, expired or no access; `404` file missing; `416` range past the end
  (`Content-Range: bytes */size`); `503` not configured. Every response is `Cache-Control: private, no-store`.
- Streams the MP3 (`streamFile`). Lossless (`originalFile`) is not offered yet.
- Downloads (AUD-3) use the same URL: fetch the whole file with ranges and encrypt it on device.

Server config (Convex env): `MEDIA_TOKEN_SECRET` (required, at least 32 characters; rotating it invalidates
every outstanding URL); `AUDIO_DELIVERY` = `proxy` (default) or `r2` (the switch for AUD-1 option (b), not
built: it returns `NOT_CONFIGURED` until `r2StreamUrl` in `convex/media.ts` is implemented).

## leaderboard (LB-1..6)

### `leaderboard.forRelease` (query)

Args: `{ slug: string; limit?: number }`. Public. `limit` defaults to, and is capped at, the release's
`leaderboardSize` (default 100). Use `limit: 20` for the Top 20 tab. Throws `NOT_FOUND` for an unknown slug.

Returns:
```ts
{
  slug: string;
  title: string;
  leaderboardSize: number;
  rows: Array<{
    rank: number;               // 1-based position on the board
    editionNumber: number;
    displayName: string;        // public name, "Anonymous collector" (opted out) or "Retired" (deleted account)
    retired: boolean;
    anonymous: boolean;
    isYou: boolean;
    awardTier: 'bronze' | 'silver' | 'gold' | null;
  }>;
}
```
Rows are the first `limit` numbered editions in edition order. Refunded (revoked) editions are removed and the
next edition moves up (LB-5). Retired editions keep their place. Presale copies have no edition and never
appear. It's a live query (LB-3).

### `leaderboard.myAwards` (query)

Args: `{}`. Signed out returns the empty result below.

Returns:
```ts
{
  topPlacements: number;        // releases where the caller ranks within that release's leaderboardSize
  tier: 'bronze' | 'silver' | 'gold' | null; // [DECIDE] 3 / 7 / 10 placements
  nextTier: { tier: 'bronze' | 'silver' | 'gold'; needs: number } | null; // null at gold
  placements: Array<{ slug: string; title: string; rank: number; editionNumber: number }>;
  leaderboardVisible: boolean;
}
```
Awards are computed on read, so a refund removes a placement straight away.

### `leaderboard.setLeaderboardVisible` (mutation)

Args: `{ visible: boolean }`. Returns `{ leaderboardVisible: boolean }`. Default is visible.

## push (DROP-6, LEND-11)

Registration and preferences work now. **Sending is a stub**: APNs keys aren't set up, so no notification is
sent yet (`push.sendDropLive` only counts devices).

### `push.registerToken` (mutation)

Args:
```ts
{
  token: string;                // the APNs device token, hex (16-512 chars of A-Z a-z 0-9 : _ - .)
  platform: 'ios' | 'android';
  wantsDropAlerts: boolean;
  wantsLendAlerts?: boolean;    // default: keep the current value, else true
  environment?: 'sandbox' | 'production'; // debug builds are sandbox; TestFlight and App Store production
}
```
Returns: `{ registered: true; created: boolean }`. Upserts by token; a device that signs in to another
account moves to it. Call it on every launch and whenever the token changes. Throws `INVALID_INPUT` for a
malformed token.

### `push.unregisterToken` (mutation)

Args: `{ token: string }`. Returns `{ removed: boolean }`. Call on sign out. Only removes the caller's own token.

### `push.setAlertCategory` (mutation)

Args: `{ category: 'drops' | 'lends'; enabled: boolean }`. Returns `{ updated: number }` (devices changed).
Applies to every device of the caller.

### `push.preferences` (query)

Args: `{}`. Returns `{ devices: number; drops: boolean; lends: boolean }`. With no registered device both
categories read `true` (the default).

## privacy (NFR-2)

- `privacy.exportMyData` (query, `{}`): now also returns `playEvents: Array<{ kind, track: string | null,
  startedAt, receivedAt, playedSec, countedSec, borrowed }>`, `pushTokens: Array<{ platform, token,
  wantsDropAlerts, wantsLendAlerts, updatedAt }>` (ISO dates), and `profile.leaderboardVisible`.
- `privacy.deleteMyData` (action, `{ confirm: 'DELETE' }`): also deletes the caller's play events and push
  tokens. Wear already added to a copy stays on it; the caller's own copies become retired editions.

## Internal (server only, not callable from the app)

- `app.flipDueDrops`: cron every minute (DROP-7). Flips `products.status` from `scheduled` to `live` once
  `dropAt <= now`, and schedules the (stub) drop-live push. Drafts never go live on their own.
- `plays.prune`: daily cron. Deletes website plays and app play events older than 12 months and closed daily
  wear tallies. Wear is never lowered.
- `push.sendDropLive`: stub, see `convex/push.ts` for the APNs steps.
- `media.accessForClerk`, `media.accessForToken`, `push.dropAlertTokenCount`: helpers.

## lends (PRD §12, LEND-1..12)

A fan lends their actual copy: the borrower sees the lender's edition number and wear, and gets a budget of
plays before the lend expires. Every rule runs server side on server time; the app never sends a time.

Config (`convex/lendLogic.ts`, PRD 12.2 [DECIDE] defaults): 10 plays per lend (one play = one track past 30 s),
7 days from claim, an unclaimed link lapses after 72 hours, one open lend per copy, and the lender's copy is
locked while it is out (offered or active). An ended lend stays on the borrower's rack for 7 days.

States: `offered` → `active` (claim) → `exhausted` | `expired` | `returned` (call back) | `revoked` (lender
refunded) | `converted` (borrower bought it). `offered` → `unclaimed_expired` (72 h) | `returned` (cancel) |
`revoked`. Terminal states never change; a call that would change one throws `FORBIDDEN` "This lend has already
ended.". Expiry is enforced on every call; a job every 15 minutes writes the terminal states.

### `lends.create` (action, LEND-1)

Args: `{ slug: string }`. Returns `{ lendId: string; claimUrl: string; offerExpiresAt: number; playsAllowed: number }`.
`claimUrl` is `https://myindsound.com/lend/{token}` (a universal link, 128-bit random single-use token): share it.
Throws `NOT_ENTITLED` (no live licence; "Lent copies can't be lent again." for a borrower), `FORBIDDEN` ("Your copy
is already out on loan."), `NOT_YET_LIVE` (before the drop), `NOT_FOUND` (slug).

### `lends.claim` (mutation, LEND-2..4)

Args: `{ token: string }` (the last path segment of the link). Returns
`{ lendId, slug, status: 'active', playsAllowed, playsUsed, expiresAt }`. The borrower retrying returns the same
lend. Throws `NOT_FOUND` (not a lend link), `FORBIDDEN` "This disc is already on loan to someone else." (claimed
by another account), "This lend link has expired." (lapsed or cancelled), "That's your own disc.", "You're already
borrowing this release.", "This loan has ended."; `ALREADY_OWNED` "You already own this.".

### `lends.callBack` / `lends.cancel` (mutations)

Args: `{ lendId: string }`. Lender only (`NOT_FOUND` for anyone else). Returns `{ lendId, status: 'returned' }`.
`callBack` takes back a claimed lend; `cancel` withdraws an unclaimed link (`INVALID_INPUT` if you call the wrong
one). The lender can play again at once.

### `lends.startLentPlay` / `lends.commitLentPlay` (mutations, LEND-5)

Every borrowed play needs this online check. Borrower only (`NOT_FOUND` otherwise).
1. `startLentPlay({ lendId, trackId })` → `{ playId, playsUsed, playsAllowed, playsLeft, status, expiresAt }`.
   Refused with `NOT_ENTITLED` "This loan has ended." when the lend isn't active or has no plays left.
2. `media.getStreamUrl({ trackId, lendId })` and play it. Lent audio is streamed only: never offer a download or
   keep the file.
3. Once the track passes 30 seconds, `commitLentPlay({ lendId, trackId, playId })` →
   `{ counted, duplicate, playsUsed, playsAllowed, playsLeft, status, expiresAt }`. The server checks that 30 s of
   server time passed since start (`INVALID_INPUT` if early: retry later). Idempotent per `playId`
   (`duplicate: true`, counts nothing). The play that uses the last one sets `status: 'exhausted'`; that track may
   finish streaming, then the stream closes. A commit with no plays left is `NOT_ENTITLED`.

Report the play itself through `plays.recordPlayEvents` with `lendId` as usual: its seconds wear the lender's copy
(`lentPlaySeconds`, LEND-6). A play that was committed while the lend was on still counts if it is flushed after
the lend ended (once per committed play); anything else after the end is `no_access`.

### `lends.mine` (query)

Args: `{}`. Returns `{ serverNow, asLender: LendRow[], asBorrower: LendRow[] }`, newest first. Signed out: empty.
```ts
type LendRow = {
  lendId: string; role: 'lender' | 'borrower'; slug: string; title: string;
  status: 'offered' | 'active' | 'exhausted' | 'expired' | 'returned' | 'revoked' | 'converted' | 'unclaimed_expired';
  channel: 'link' | 'nfc';
  playsAllowed: number; playsUsed: number; playsLeft: number;
  offeredAt: number; claimedAt: number | null;
  expiresAt: number;               // active: expiry; offered: when the link lapses
  endedAt: number | null; endReason: string | null;
  editionNumber: number | null;    // the lender's copy
  ownerDisplayName: string;        // the lender's public name
  borrowerDisplayName: string | null; // lender's view, once claimed
  claimUrl: string | null;         // lender's view while offered (share again)
  wear: WearDescriptor | null;     // the lender's copy
  endScreen: LendEndScreen | null; // borrower's view, exhausted or expired
};
```
`endReason`: `plays_used`, `time_up`, `called_back`, `cancelled`, `lender_revoked`, `bought_own_copy`,
`unclaimed`, `borrower_deleted`.

### `lends.preview` (query, public, LEND-12)

Args: `{ token: string }`. For the landing page and the app's claim sheet. Returns
`{ availability: 'available' | 'on_loan' | 'ended'; slug; releaseTitle; editionNumber; ownerDisplayName;
wear: WearDescriptor without seed | null; playsAllowed; lendDays; offerExpiresAt: number | null }`. No ids,
emails or account data. `NOT_FOUND` for an unknown token.

### Lends elsewhere in the API

- `app.context` / `app.library`: a borrower sees `ownership: 'lent'`, the lender's edition, public name and wear,
  and `lend` with `role: 'borrower'` (and `endScreen` once exhausted or expired, for 7 days). The lender sees
  `ownership: 'owned'` with `lend.role: 'lender'` while the copy is out.
- `media.getStreamUrl`: pass `lendId` for a borrowed track. The lender gets `NOT_ENTITLED` "Your copy is out on
  loan." while it is out; plays and cartridge events they report meanwhile come back `no_access`.
- Buying the release while borrowing it (any channel) ends the lend as `converted` and records
  `convertedFromLendId` on the new licence (LEND-9); a purchase from the end screen of a lend that ended in the
  last 7 days is attributed the same way without changing its status.
- A refund or App Store revoke of the lender's copy revokes its lends at once (LEND-10).
- Push (LEND-11): the server records intents in `lendNotices` (lender: claimed, ended; borrower: 24 hours before
  expiry, one play left), one per lend and kind. Sending is a stub until APNs is set up.
- Privacy: `privacy.exportMyData` adds `lends: Array<{ role, release, status, channel, playsAllowed, playsUsed,
  offeredAt, claimedAt, expiresAt, endedAt, endReason }>` (the other person is never named).
  `privacy.deleteMyData` ends and detaches the caller's borrowed lends and deletes the lends of their copies.
- NFC-7 (later): `createOffer` and `claimOffer` in `convex/lends.ts` take `channel: 'nfc'` for tap to lend.

Internal: `lends.settleDue` (cron every 15 minutes), `lends.createForClerk` (the mutation behind `create`).

## storekit (PRD §7.2, PAY-4..9)

### `storekit.verifyPurchase` (action)

Args: `{ signedTransaction: string }`: `Transaction.jwsRepresentation` (the `VerificationResult`'s JWS).

Returns: `{ granted: boolean; editionNumber: number | null; outcome: string; slug: string; finish: boolean }`.
- Call it after `product.purchase()`, for every `Transaction.unfinished` on launch (PAY-7), and for every
  `Transaction.currentEntitlements` on Restore Purchases (PAY-9).
- **Call `transaction.finish()` only when `finish` is true** (PAY-6). A thrown error (network, auth, a server
  problem) means keep it unfinished and retry later.
- `outcome`: `created` (new licence), `replayed` (already granted to you: idempotent on
  `originalTransactionId`), `owned` (you already owned it), `early_paid` (bought before the drop: a presale copy
  with no edition, ED-3), and final refusals with `granted: false, finish: true`: `revoked` (refunded),
  `taken` (this purchase already belongs to another account: support case), `retired`.
- Server checks: Apple's `x5c` chain to the embedded Apple Root CA - G3 (byte for byte), ES256 signature, Apple's
  certificate OIDs, validity at `signedDate`, `bundleId === 'com.myindsound.app'`, the environment, `type`
  `Non-Consumable`, and `productId` in a release's `appStoreProductIds`.

Throws: `UNAUTHENTICATED`; `INVALID_INPUT` "This purchase could not be verified." (signature, chain, bundle,
environment or type); `NOT_FOUND` "Unknown product.".

### `POST /appstore/notifications` (HTTP route, PAY-8)

App Store Server Notifications V2 (`{ signedPayload }`), verified the same way. `REFUND` and `REVOKE` revoke that
`originalTransactionId` through the per-payment revoke Stripe refunds use (so its lends are revoked too), or leave
a tombstone if the purchase wasn't verified yet. Idempotent on `notificationUUID`. Other types are logged and
answered 200; a payload that fails verification is 400 (Apple retries). `REFUND_REVERSED` is logged only.

Server config (Convex env):
- `STOREKIT_ENVIRONMENTS`: `Production,Sandbox` (default: App Review and TestFlight buy in Sandbox) or `Production`.
- `STOREKIT_ALLOW_XCODE_TEST=true` and `STOREKIT_XCODE_TEST_CERT` (base64 of the certificate Xcode exports from
  the `.storekit` file, Editor > Save Public Certificate): accept Xcode local StoreKit testing transactions
  (`environment: 'Xcode'`) on the dev deployment. Always refused on production (`loyal-tortoise-999`),
  whatever the env says.
- App Store Connect: the product ids go in `products.appStoreProductIds` (all tiers of a release); the notification
  URL is `https://<deployment>.convex.site/appstore/notifications`.

## Not built yet

- APNs sending (push intents for drops and lends are recorded or counted only), R2 delivery, lossless streaming.
- NFC tap to lend (NFC-7): the lend helpers take `channel: 'nfc'`, the tag verification does not exist yet.

## Release portal releases (design, rack, bundle)

New releases are made in the admin release portal (`/admin` → RELEASES, `convex/releases.ts`) and rendered by the
generic release bundle (BUN-4) from a DiscDesign (`packages/minidisc/README.md`). `app.library` entries and
`app.context` now carry three more fields. All three are `null` for LIT (no design: use the built-in LIT bundle and
sleeve art) and for drafts (nothing unreleased leaks through the public queries).

```ts
// Added to every app.library entry and to app.context (app.context also gains `bundle`, the same Bundle type).
design: DiscDesign | null;        // v1, as validated by validateDesign. coverArt is an https URL to the cover.
rack: {
  spriteUrl: string;              // spin loop sprite sheet (sleeved package, disc turning once); WebP when available
  spriteFormat: 'webp' | 'png';
  spriteMeta: { frames: number; cols: number; rows: number; frameW: number; frameH: number;
                sheetW: number; sheetH: number; fps: number; format: 'image/webp' | 'image/png' };
  pngSpriteUrl: string;           // the same layout as PNG (fallback)
  stillUrl: string;               // the sleeved front, PNG with alpha
} | null;
bundle: { version: string; url: string; sha256: string } | null;   // app.context only; library already had it
```

- **Bundle:** download `bundle.url` (a public Convex storage URL; bundles are not secret), verify SHA-256 against
  `bundle.sha256` (BUN-2), unpack, and load `index.html`; the zip carries `design/design.json` and the cover next to
  it, and `manifest.json` has `generator: "minidisc/1"` plus `design: { title, artist, year, shell, labelStyle,
  theme }`. Portal versions look like `1.0.0+r3` (generic bundle version + design revision): a new version or sha
  means re-download.
- **Rack grid:** frame `i` is the cell at column `i % cols`, row `floor(i / cols)`, `frameW × frameH`, played at
  `fps`, looping seamlessly over `frames`. Tap opens the live 3D (the bundle).
- **Cover / player backdrop:** `design.coverArt` (https) is the cover; `design.theme` holds the backdrop blur and
  scrim (defaults: `resolveTheme` in packages/minidisc).
- Audio is unchanged: still only through `media.getStreamUrl`.

### Admin functions (`releases.*`, admin only, every change audited as `product:<slug>`)

| Function | Kind | Args → returns |
|---|---|---|
| `drafts` | query | `{}` → drafts with progress (`tracks`, `tracksWithAudio`, `hasCover`, `hasDesign`, `rackFresh`, `bundleFresh`, `ready`) |
| `get` | query | `{ slug }` → full portal state incl. `design`, `designHash`, `designRev`, `rack`, `bundle`, `problems[]` |
| `createDraft` | mutation | `{ slug, title, artist, year }`: product `kind: digital`, `status: draft`, `active: false` |
| `generateUploadUrl` | mutation | `{ slug }` → upload URL (drafts only; not audited, changes nothing) |
| `attachTrackAudio` | action | `{ slug, file, durationSec, title?, trackId? }`: MP3 sniffed from its bytes, ≤ 80 MB, duration plausible for the size |
| `setTracks` | mutation | `{ slug, tracks: [{ trackId, title }] }`: order and titles; tracks left out are deleted with their audio |
| `attachCover` | action | `{ slug, file }`: PNG/JPEG/WebP, square, ≥ 1024 px (read from the file header) |
| `saveDesign` | mutation | `{ slug, design }`: the look (shell, tint, label, accents, stickers, theme) over the server's facts, `validateDesign` |
| `attachRackArt` | action | `{ slug, spriteWebp?, spritePng, spriteMeta, still, designHash }`: meta checked against the PNG's size |
| `attachBundle` | action | `{ slug, version, zip, sha256, designHash }`: zip ≤ 40 MB, sha256 must equal the stored file's |
| `publish` | mutation | `{ slug, status: 'scheduled' \| 'live', dropAt?, reason }`: needs every track with audio, the cover, a saved design, rack art and bundle made from that design; flips `active` |

Rack art and bundles record the design hash they were made from; changing the tracks, cover or casing makes them
out of date and `publish` refuses until they are redone. Internal: `releases.designForPublish`,
`releases.attachBundleFromCli` (`npm run publish:release -- --slug X --as <admin email>`).

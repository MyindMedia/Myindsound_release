# Convex Backend, Slice 1 — Design

- **Date:** 2026-09-16
- **Status:** Approved in chat, awaiting written-spec review
- **Context:** `Grilled.md` (decisions, constraints, open questions)
- **Follows:** nothing. **Precedes:** `2026-09-16-minidisc-player-3d-design.md`, then Convex slice 2.

## 1. Why

- **Supabase is unreachable:** `luowwakouydxyzfnsyki.supabase.co` has no DNS record, so checkout provisioning, access checks, streaming and downloads are all broken.
- **The album leaks:** `src/stream.ts:28-87` hardcodes signed audio URLs that expire in 2125. They're dead now only because the project is gone.
- **Spoofable identity:** `netlify/functions/get-stream-urls.ts:15` and `get-download-url.ts:14` trust a user ID sent by the browser.
- **PII in logs:** `stripe-webhook.ts:203` logs customer emails.

Slice 1 moves everything the checkout and the player need onto Convex, with paid audio in Cloudflare R2.

## 2. Architecture

```
Browser (Vite multi-page, vanilla TS)
  ├─ Clerk JS ──── session token (JWT template "convex") ─┐
  └─ ConvexClient (convex/browser) ───────────────────────┤
                                                          ▼
Convex deployment (US)
  ├─ queries / mutations / actions (auth via ctx.auth)
  ├─ HTTP action  POST /stripe/webhook  ◀── Stripe
  ├─ "use node" actions: Stripe SDK, Clerk Backend API, GHL API
  ├─ @convex-dev/r2 component ──── signed GET URLs ──▶ Cloudflare R2 (private bucket, audio only)
  └─ crons: prune plays > 12 months
Netlify: static hosting only; build = convex deploy --cmd 'npm run build'
```

## 3. Data model (`convex/schema.ts`)

| Table | Fields | Indexes |
|---|---|---|
| `products` | `slug` (e.g. `lit`), `name`, `kind` (`digital` \| `physical`), `stripeProductIds: string[]`, `coverUrl?`, `downloadKey?` (R2), `active` | `by_slug` |
| `tracks` | `productId`, `position`, `title`, `durationSeconds`, `format` (`mp3`), `streamKey` (R2), `originalKey` (R2) | `by_product_position` |
| `users` | `clerkId`, `email`, `name?`, `isAdmin`, `marketingConsentAt?` | `by_clerkId`, `by_email` |
| `entitlements` | `userId`, `productId`, `stripeSessionId`, `grantedAt` | `by_user_product`, `by_session` |
| `orders` | `userId`, `stripeSessionId`, `totalCents`, `currency`, `shipping` (`{name, line1, line2?, city, state?, postalCode, country}`), `status` (`paid` \| `fulfilled` \| `cancelled`), `createdAt` | `by_user`, `by_session` |
| `orderItems` | `orderId`, `productId?`, `description`, `variant?`, `quantity`, `unitCents` | `by_order` |
| `plays` | `userId`, `trackId`, `playedAt` | `by_user`, `by_playedAt` |
| `stripeEvents` | `eventId`, `type`, `processedAt` | `by_eventId` |

**Rules:**
- `entitlements` is unique per `(userId, productId)`. The fulfilment mutation checks `by_user_product` before inserting.
- An `orders` row is unique per `stripeSessionId`.
- The LIT UUID `f67a66b8-59a0-413f-b943-8fbb9cdee876` is retired; code refers to the product by slug `lit`.
- Seed data: product `lit` with Stripe IDs from Convex env `STRIPE_PRODUCT_ID_LIT` (`prod_TsqOvYycMrdhnl` today). THE SOURCE (`prod_TsqUkQtzNQ5Y3z`) is a separate product row with `kind: digital` and no tracks.

## 4. Auth

- `convex/auth.config.ts`: provider `domain: process.env.CLERK_JWT_ISSUER_DOMAIN`, `applicationID: "convex"`.
- **Clerk:** a JWT template named `convex` with `aud: "convex"` and an `email` claim must exist on **both** the dev and prod Clerk instances. Verify through Clerk's Backend API `GET /v1/jwt_templates` before wiring the client (known trap, see memory `gotcha_clerk_convex_jwt_template_missing_on_dev`).
- **Browser:** `src/convex.ts` exports a singleton `ConvexClient(import.meta.env.VITE_CONVEX_URL)` with `client.setAuth(() => Clerk.session?.getToken({ template: "convex" }) ?? null)`, called after `initClerk()` resolves.
- **Server helper:** `requireUser(ctx)` returns the `users` row for `ctx.auth.getUserIdentity().subject`, or throws `ConvexError({ code: "UNAUTHENTICATED" })`. If the identity is valid but no row exists, it upserts the row from token claims (`subject`, `email`).
- User-facing errors are `ConvexError({ code, message })`. Production redacts plain `Error`.

## 5. Functions

### Public (browser)

| Function | Type | Does |
|---|---|---|
| `entitlements.mine` | query | Slugs of products the signed-in user owns (replaces `hasProductAccess`) |
| `tracks.listForPlayer({ product })` | action | `requireUser` + entitlement check, then returns tracklist with `streamUrl` signed for 7200 s and `expiresAt` |
| `plays.log({ trackId })` | mutation | `requireUser` + entitlement, inserts a `plays` row |
| `checkout.createDigitalSession({ amountCents, withUpsell, email })` | action | Same behaviour as today's `create-checkout.ts`; returns `{ url }` |
| `leads.capture({ email, marketingConsent })` | action | Upserts the GHL contact. Tag `LIT-Lead` only when `marketingConsent === true`, and stores the consent time |
| `downloads.forCheckoutSession({ sessionId })` | action | Retrieves the Stripe session. It must be `paid`, created within 24 h, and contain a product with a `downloadKey`. Returns zip URLs signed for 3600 s, plus the THE SOURCE link from env `SOURCE_PRESALE_URL` if purchased |
| `downloads.mine({ product })` | action | Signed-in variant for the dashboard (UI wiring happens in slice 2) |
| `privacy.exportMyData` | query | The user's `users`, `entitlements`, `orders` + `orderItems` and `plays` as JSON |
| `privacy.deleteMyData` | action | Deletes `plays`, `entitlements` and the `users` row. Anonymises `orders.shipping` and name, keeping amounts for tax. Deletes the Clerk user and GHL contact. Stripe records are retained (legal obligation) |

### Internal

- `stripe.fulfillCheckoutSession(session)`: the single fulfilment path, shared by the webhook and the rebuild.
  1. Lists line items.
  2. Maps Stripe product IDs to `products`.
  3. Finds the Clerk user by email or creates one (`skip_password_requirement`).
  4. Upserts `users` and inserts `entitlements`.
  5. For `metadata.order_type === "physical"`, writes `orders` + `orderItems` from `shipping_details`.
  6. Schedules `ghl.syncPurchase`.
- `ghl.syncPurchase({ userId, tags })`: upserts the GHL contact with `LIT-Purchased` (+ `Source-Purchased`), plus `Marketing-OptIn` only if `users.marketingConsentAt` is set. On failure it retries 3× with backoff and never blocks access.
- `migrations.rebuildFromStripe({ dryRun })`: paginates `checkout.sessions.list({ status: "complete", limit: 100 })`, keeps `payment_status === "paid"`, and calls `fulfillCheckoutSession`. **Prints counts only** (sessions seen, digital granted, physical orders, unmatched, already present). Never prints email, name or address.
- `users.setAdmin({ clerkId })`: run once from the CLI for Lawrence.
- `crons.ts`: daily `plays.prune`, which deletes `plays` with `playedAt < now − 365 d` in batches of 500.

### HTTP

`POST /stripe/webhook` (`convex/http.ts`):
1. Read the raw body and `stripe-signature`, then call internal node action `stripe.handleWebhook`.
2. `constructEvent` with `STRIPE_WEBHOOK_SECRET`. Return 400 on a bad signature.
3. If `stripeEvents.by_eventId` already has the event, return 200.
4. Handle `checkout.session.completed` when `payment_status === "paid"`, and `checkout.session.async_payment_succeeded`. Record the event after a successful fulfilment.
5. Return 500 on a transient failure before the entitlement commits, so Stripe retries. Otherwise 200.
6. Log Stripe session ID and Convex user ID only.

## 6. Audio and downloads (R2)

- **Bucket:** `myind-audio`, private, no public dev URL.
- **CORS:** `GET` / `HEAD` with `Range` from the production origin(s) (open question 2 in `Grilled.md`), `http://localhost:5173` and `http://localhost:8888`.
- **Object keys:**

| Key | Source |
|---|---|
| `lit/stream/01-lit-living-in-truth.mp3` | `L.I.T. ( Living In Truth).mp3` |
| `lit/stream/02-god.mp3` | `G. O. D.mp3` |
| `lit/stream/03-victory-in-the-valley.mp3` | encoded from WAV: `ffmpeg -i … -codec:a libmp3lame -b:a 320k` |
| `lit/stream/04-tired.mp3` | `Tired.mp3` |
| `lit/stream/05-let-him-cook.mp3` | `Let Him Cook.mp3` |
| `lit/stream/06-faith.mp3` | `Faith.mp3` |
| `lit/originals/03-victory-in-the-valley.wav` | WAV master |
| `lit/download/ThaMyind - LIT EP.zip` | zip of the 5 MP3s + the WAV, stored with `Content-Disposition: attachment` |

  The track 1 key and title follow open question 1 (album name). `originalKey` equals `streamKey` for the MP3 tracks.
- **Upload:** `scripts/upload-lit-audio.ts` (run locally).
  1. Reads R2 S3 credentials from gitignored `.env.local`.
  2. Probes durations with `ffprobe`, encodes and zips.
  3. Uploads with `@aws-sdk/client-s3`, skipping objects whose ETag already matches.
  4. Calls internal mutation `tracks.seed` through `npx convex run` with keys, titles, positions and durations.

  Idempotent.
- **Measured durations (s):** 191.84, 224.96, 157.89, 141.64, 139.24, 182.53.
- **Stream links** expire after 7200 s. The player refreshes when `expiresAt − now < 600 s` or when a request fails with 403.

## 7. Environment

- **Convex (entered by Lawrence in Dashboard → Settings → Environment Variables; values never pasted into chat):**
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`
  - `STRIPE_PRODUCT_ID_LIT`, `STRIPE_PRODUCT_ID_SOURCE`
  - `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN`
  - `GHL_API_KEY`, `GHL_LOCATION_ID`
  - `R2_BUCKET`, `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_TOKEN`
  - `SITE_URL`, `SOURCE_PRESALE_URL`
- **Netlify:** `CONVEX_DEPLOY_KEY` (prod), `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`. Supabase, Stripe-secret and GHL variables are removed from Netlify at the end of slice 2.
- **`package.json`:** `"prebuild": "convex codegen --typecheck=disable"`. `--cmd` runs the build before codegen, and `_generated/` is gitignored.
- **Local CLI:** prefix `PATH="/opt/homebrew/opt/node@22/bin:$PATH"`. Node 25 breaks codegen.

## 8. Frontend changes

| File:line (today) | Change |
|---|---|
| new `src/convex.ts` | ConvexClient singleton with Clerk auth |
| `src/checkout.ts:90` | `ghl-lead` → `leads.capture`. Adds an unticked "Send me new releases" checkbox to the email step |
| `src/checkout.ts:120` | `create-checkout` → `checkout.createDigitalSession` |
| `success.html:178` | `verify-session` → `downloads.forCheckoutSession` |
| `src/main.ts:95` | `hasProductAccess` → `entitlements.mine` |
| `src/stream.ts:28-87` | Delete hardcoded `TRACKS` |
| `src/stream.ts:501` | `get-stream-urls` → `tracks.listForPlayer` |
| `src/stream.ts:780` | `logTrackPlay` → `plays.log` |
| `netlify/functions/` | Delete `create-checkout`, `ghl-lead`, `stripe-webhook`, `verify-session`, `get-stream-urls` once replacements pass. `get-download-url` and `create-physical-checkout` stay until slice 2 |

The Stream page UI is otherwise untouched in slice 1. The 3D player spec replaces it next.

## 9. Compliance items (from the Compliance Ops check)

1. No command or script run in the Claude session outputs customer PII. The rebuild prints counts, and debugging uses IDs.
2. `privacy.exportMyData` and `privacy.deleteMyData` exist and cascade to Clerk and GHL.
3. Plays are pruned at 12 months.
4. Marketing consent is an explicit, unticked opt-in with a timestamp.
5. No emails or names in logs.
6. R2 holds audio only, with no user identifiers in keys.
7. Vendor agreements to accept (Lawrence): Convex DPA, Clerk DPA, GHL DPA, PostHog DPA, Stripe DPA.

## 10. Cutover

1. Create the Convex project (dev + prod). Create the R2 bucket and CORS rules. Verify Clerk `convex` JWT templates on both instances.
2. Deploy Convex prod alongside the live site; nothing points at it yet.
3. Run `upload-lit-audio.ts` against prod R2, then `tracks.seed`.
4. Run `migrations.rebuildFromStripe({ dryRun: true })`. Lawrence sanity-checks the counts in chat, then runs it with `dryRun: false`.
5. Test locally end to end in Stripe test mode with `stripe listen --forward-to <dev>.convex.site/stripe/webhook`.
6. Deploy the frontend. Add the Convex prod webhook endpoint in the Stripe dashboard and paste its secret into Convex env.
7. Make a live $1 PWYW purchase: entitlement appears, stream plays, download works. Refund it.
8. Delete the replaced Netlify functions and disable the old Stripe endpoint.
9. Run `/pentest` on the deployed site (SCAN → FIX → RE-SCAN → REPORT).

## 11. Testing

- **Unit (vitest + convex-test, node@22):**
  - Unauthenticated calls are rejected.
  - A non-owner gets `NOT_ENTITLED` from `tracks.listForPlayer`.
  - Fulfilling the same session twice creates one entitlement and one order.
  - A duplicate `eventId` is ignored.
  - `downloads.forCheckoutSession` rejects an unpaid session and one older than 24 h.
  - `plays.prune` removes only rows older than 365 d.
  - `leads.capture` sets the `LIT-Lead` tag only with consent.
  - `deleteMyData` anonymises orders and deletes plays and entitlements.
- **Integration:** Stripe CLI test-mode purchase for digital and physical, then check Convex rows by ID only.
- **Manual (live):** step 7 of the cutover.

## 12. Acceptance criteria

- [ ] No file in `src/` or `netlify/functions/` touched by slice 1 imports `@supabase/supabase-js`.
- [ ] A signed-in LIT owner gets 6 working stream URLs that expire in about 2 h. A signed-in non-owner and a signed-out visitor both get a coded `ConvexError`.
- [ ] A new live purchase grants access within 10 s of Stripe's webhook. Replaying the same event changes nothing.
- [ ] The success page shows a working zip download within 24 h of payment, and refuses after.
- [ ] The Stripe rebuild recreates entitlements for past paid LIT checkouts, and the dry run prints counts only.
- [ ] No customer email, name or address appears in Convex logs or in this repo's scripts' stdout.
- [ ] The Netlify production build passes from a clean checkout (codegen in prebuild).
- [ ] `/pentest` report has no open criticals.

## 13. Out of scope (slice 2)

- Dashboard purchases, orders and download UI, plus privacy buttons.
- Admin play stats.
- The nav admin link (`src/nav-auth.ts:49`).
- The physical store checkout caller.
- The `stream/` React app.
- Deleting `src/supabase.ts`, `get-download-url` and `create-physical-checkout`.
- Removing `@supabase/supabase-js` from both `package.json` files.

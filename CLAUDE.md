# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Myind Sound Releases is a music release platform with pay-what-you-want (PWYW) digital sales and physical merchandise.
- **Site:** a multi-page vanilla TypeScript site on Netlify (stream.myindsound.com, Netlify site `myindreleases`, builds branch `master`).
- **Backend:** Convex, with the paid audio in Convex file storage (dev `decisive-iguana-954`, production `loyal-tortoise-999`).
- **Stream page:** a Three.js MiniDisc deck.
- **Legacy:** a separate React app under `stream/`, still on Supabase and not the primary player.

Read `Grilled.md` first: it records goals, decisions, constraints and open questions. Specs and the plan are in `docs/superpowers/`.

## Commands

```bash
# Use Node 22 for the Convex CLI (Node 25 breaks codegen on this machine)
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

npm run dev          # Vite dev server (reads VITE_* from .env.local)
npx convex dev       # Push Convex functions to the dev deployment on save
npm run build        # prebuild (convex codegen) + tsc + vite build
npm test             # vitest: convex/ (edge-runtime, convex-test) + src/ (node)
npm run textures     # Rebuild player textures + geometry from the Canva export
npm run upload:audio -- --dry-run   # Plan the audio upload to Convex storage; add --prod for production
```

The 3D player runs without auth or backend at `http://localhost:5173/stream.html?mock=1` (dev only).

## Architecture

### Multi-page Vite build

Not an SPA. The entry points are listed in `vite.config.ts`:

`index.html`, `login.html`, `dashboard.html`, `physical.html`, `stream.html`, `success.html`, `cancel.html`, `admin.html`

Each page loads its own module(s). Clean URLs come from redirects in `netlify.toml`.

### Convex backend (`convex/`)

Auth is Clerk, via the JWT template `convex` (`auth.config.ts`, issuer from `CLERK_JWT_ISSUER_DOMAIN`). Functions read the caller from `ctx.auth` and never trust client-sent user IDs. User-facing errors are `ConvexError({ code, message })` (`lib/errors.ts`).

- `schema.ts`: tables `products`, `tracks`, `users`, `entitlements`, `orders`, `orderItems`, `plays`, `stripeEvents`.
- `lib/auth.ts`: `getViewer`, `requireViewer`, `ensureViewer`, `requireAdmin`. Admin means `users.isAdmin` or a verified email in `ADMIN_EMAILS`.
- `tracks.ts`: `listForPlayer` action. Checks the purchase, then returns the tracklist with Convex storage links to the full songs. Also the upload flow (`generateUploadUrl`, `fileHashes`, `attachTrackFile`, `attachDownload`) used by `npm run upload:audio`.
- `payments.ts`: Stripe (fetch client, default runtime).
  - `createDigitalSession`
  - `downloadsForCheckoutSession`: 24 h window after payment.
  - `handleWebhook`
  - `rebuildFromStripe`: internal. Prints counts only.
- `fulfilment.ts`: the single, idempotent path that grants entitlements and creates orders.
- `http.ts`: `POST /stripe/webhook`.
- `ghl.ts` / `leads.ts`: Go High Level sync. Marketing tags only with recorded consent.
- `downloads.ts`, `orders.ts`, `products.ts`, `admin.ts`, `users.ts`: dashboard, admin and nav queries.
- `privacy.ts`: `exportMyData` and `deleteMyData` (cascades to Clerk and GHL; orders are anonymised, amounts kept).
- `plays.ts` + `crons.ts`: play logging, deleted after 12 months.
- `lib/storage.ts`: `fileUrl()` for storage links (songs and the album zip), returned only after a purchase check.

### Main site source (`src/`)

- `convex.ts`: `ConvexClient` singleton, `connectConvexAuth()` (Clerk token → Convex), error helpers.
- `clerk.ts`: Clerk singleton and helpers (`getClerk`, `requireAuth`, `mountSignIn`, …).
- `main.ts` / `checkout.ts`: home page and PWYW checkout modal (upsell → email + marketing-consent checkbox → Stripe redirect via Convex).
- `success.ts`: success page downloads (Convex) and sign-in prompt.
- `dashboard.ts`: purchases, downloads, orders, export/delete my data.
- `admin.ts`: stats from `api.admin.stats`, with access enforced server-side.
- `nav-auth.ts`: nav auth state; ADMIN link from `api.users.me`.
- `stream.ts`: mounts the 3D player (`src/player3d`).
- `purchase-animation.ts`, `disk-player.ts`, `sticker-peel.ts`: home page post-purchase reveal, which hands off to `stream.html?state=animate_dock`.
- `physical.ts` / `cart.ts` / `shopify.ts`: physical store (Shopify Storefront).
- `analytics.ts`: PostHog.

### 3D MiniDisc player (`src/player3d/`)

See `docs/superpowers/specs/2026-09-16-minidisc-player-3d-design.md` and the build updates in `Grilled.md`.

- `state.ts`: pure deck state machine and key latches (unit-tested). Selecting a track while running enters `seeking` (laser calibration of at least 2 s) before `playing`.
- `audio-engine.ts`: one `<audio>` element through Web Audio when CORS allows; otherwise direct playback with a simulated spectrum. `unlock()` must run inside the user gesture. Also exposes `waveform()` and `playCalibration()`.
- `disc-sounds.ts`: drive mechanics from a real recording (`npm run disc-sounds` → `public/assets/audio/disc/`, `disc-sounds.json`): spin-up, seamless spinning loop, spin-down. The deck's `playRpmCurve` follows the same curves so sound and motion line up.
- `calibration-sound.ts`: synthesised laser calibration sound (servo, seek clicks, focus chirps), about 2.2 s.
- `track-source.ts`: `ConvexTrackSource` (full songs from Convex storage, purchase-checked). `lit-stream-source.ts`: `LitStreamSource`, what the public page uses: buyers get the full songs, everyone else (or anyone when the service fails) gets the previews, and the HUD shows a SIGN IN / GET LIT note. `preview-track-source.ts`: `PreviewTrackSource`, 30-second LIT previews for the public demo (`npm run previews` cuts them from the local LIT files into `public/assets/audio/lit-previews/` and writes `lit-previews.json`).
- `scene.ts`: renderer, framing to the HUD's `.p3d-frame`, tilt spring, bloom + CRT pass, visibility pause.
- `deck.ts`: extruded body/cartridge/keys from `geometry.json` + WebP textures. The disc face is the LIT cover; the cartridge label is "Do Not Duplicate".
- `cartridge-detail.ts`: realism layer over the Canva art. Lathe-turned steel Phillips screws (occlusion-mapped recess) in counterbored wells cut into the shell, a disc with real thickness and a separate machined hub in its centre opening, a steel hub ring on the back, an additive clearcoat pass with normals baked from the artwork, iridescent disc sheen, paper-grain label, and a studio environment map tinted with the city's neon. Coarse pointers get standard materials instead of clearcoat/iridescence.
- `spindle.ts`: the deck's spindle motor under the seated hub. It rises through the cartridge's back opening once seated, turns with the disc, and drops clear before eject (`Deck.setSpindleEngaged`, called from the insert and eject timelines).
- `halo.ts`: 3D start-up halo hovering in front of the disc while inserting or calibrating; dissipates when playback starts.
- `backdrop.ts` / `backdrop-shaders.ts`: comic-book 90s-anime city (`city-comic.webp`, 21:9), depth-map parallax (`city-depth.webp`), pulsing neon and beam shimmer (`city-mask.webp`), flying craft, embers, rain.
- `insert-sequence.ts`: GSAP timelines for the page-open float-in, insert (from wherever the cartridge floats) and eject. GSAP comes from the CDN, `window.gsap`.
- `inspect.ts`: eject inspector. The page always opens ejected: once tracks load, the cartridge floats in front of the empty deck (`runFloatInSequence`). The red key ejects the cartridge to the foreground (`ejecting` → `ejected`). The cartridge rotates 360° in camera space (drag with inertia, arrows) and zooms toward the pointer (wheel, pinch, + and −). Double-click/tap or 0 resets; INSERT DISC, Enter/Esc, Play or a track pick push it back in. It is fitted into the HUD's invisible `.p3d-stage` box.
- `keys.ts`: raycast, keyboard (Space, ←, →, S, E = eject, R = repeat) and hidden real buttons. The red key is Eject; Repeat is the toggle under the tracklist.
- `hud.ts` / `hud.css` / `hud-fx.ts`: HTML HUD with desktop, tablet (sheet) and phone (strip + sheet) layouts.
  - `hud-fx.ts` holds ports of React Bits Pro blocks: glitch text, boot terminal, oscilloscope, sparkline, radial gauge.
  - The originals are kept locally for reference in `src/vendor/reactbits/`: excluded from tsc and gitignored, because Pro source is licensed and this repo is public.
- `player-app.ts`: composition root.

**Asset pipelines:**
- **Deck:**
  - Source: Canva design `DAHAUDNdp9k`, exported as transparent PNGs via the Canva MCP to `~/Downloads/CD PLYAER MYINDSOUND/transparent/`.
  - Disc art source: `~/Downloads/CD PLYAER MYINDSOUND/lit-cover-clean.png`.
  - Cartridge back face: Canva page 6, mirrored (`shell-back.webp`). The build also writes `shell-normal.webp` / `shell-back-normal.webp` and the screw and hub positions (`geometry.json`) for `cartridge-detail.ts`. The cartridge edge samples the shell texture just inside its outline. The red key face gets an eject glyph drawn in the build script.
  - Build: `npm run textures` (`scripts/build-player-assets.py`) writes `public/assets/images/minidisc/*.webp` and `src/player3d/geometry.json`.
- **City:**
  - Source: `~/Downloads/Covers Albums.png` (the LIT street reference).
  - Restyle: Nano Banana Pro, fed the reference padded to 16:9 and cropped back to 16:10 so every pixel stays aligned.
  - Width: outpainted to 21:9 with the original centre composited back in.
  - Depth map: generated by Gemini and blurred.
  - Raw sources are kept in `~/Downloads/CD PLYAER MYINDSOUND/backdrops/`.

### Data flow

1. **Checkout:** the buyer enters an amount, email and consent. `payments.createDigitalSession` creates the Stripe Checkout session.
2. **Webhook:** Stripe calls `https://<deployment>.convex.site/stripe/webhook`, which runs `payments.handleWebhook` → `fulfilment.record`:
   - Clerk user found or created by email
   - `users` and `entitlements` saved
   - `orders` saved for physical items
   - GHL sync scheduled
3. **Return:** the buyer lands on `/?success=true` and the reveal animation hands off to the stream page. `success.html` can show downloads within 24 h.
4. **Streaming:** the stream page is open to everyone. For a signed-in visitor it calls `tracks.listForPlayer`; buyers get the full songs from Convex storage, and everyone else hears the 30-second previews.

## Environment variables

- **Netlify (build):**
  - `CONVEX_DEPLOY_KEY`: build command `npx convex deploy --cmd 'npm run build'`, which sets `VITE_CONVEX_URL`.
  - `VITE_CLERK_PUBLISHABLE_KEY`, `VITE_POSTHOG_KEY`, `VITE_POSTHOG_HOST`.
  - `VITE_SHOPIFY_STOREFRONT_TOKEN`, `VITE_SHOPIFY_STORE_DOMAIN`.
- **Convex dashboard** (never in the repo or chat):
  - `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRODUCT_ID_LIT`, `STRIPE_PRODUCT_ID_SOURCE`
  - `CLERK_SECRET_KEY`, `CLERK_JWT_ISSUER_DOMAIN`, `ADMIN_EMAILS`
  - `GHL_API_KEY`, `GHL_LOCATION_ID`
  - `SITE_URL`, `SOURCE_PRESALE_URL`
- **`.env.local`** (gitignored): `CONVEX_DEPLOYMENT`, `VITE_CONVEX_URL`, `VITE_CLERK_PUBLISHABLE_KEY`. The audio upload uses your Convex CLI login, no keys.

## Key integration points

- Products are referenced by **slug** (`lit`, `the-source`). Stripe product IDs live on `products.stripeProductIds`.
- Clerk user IDs (`users.clerkId`) are the identity across Convex. The live site currently uses the Clerk **dev** instance `main-grouper-12`.
- Paid audio is in Convex file storage: each track's `streamFile` (MP3) and `originalFile` (the WAV for track 3), plus the product's `downloadFile` (album zip). Storage links allow this site's origin and byte ranges. They don't expire, so only purchase-checked functions return them.
- **Compliance rules:**
  - Never print customer PII in the Claude session. Migrations and debugging use counts and IDs.
  - Marketing consent is opt-in.
  - Plays are pruned after 12 months.

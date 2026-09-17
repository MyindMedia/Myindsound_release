# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Myind Sound Releases is a music release platform with pay-what-you-want (PWYW) digital sales and physical merchandise.
- **Site:** a multi-page vanilla TypeScript site on Netlify (stream.myindsound.com, Netlify site `myindreleases`, builds branch `master`).
- **Backend:** Convex, with the paid audio in Convex file storage (dev `decisive-iguana-954`, production `loyal-tortoise-999`).
- **Home page:** opens on the MiniDisc in its packaging (a printed sleeve inside shrink film), alone on black. Unwrap it and the disc slides out; the Three.js deck, tracklist and city then fade in. `/stream` redirects here.
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

The player runs without auth or backend at `http://localhost:5173/?mock=1` (dev only).

## Architecture

### Multi-page Vite build

Not an SPA. The entry points are listed in `vite.config.ts`:

`index.html`, `login.html`, `dashboard.html`, `physical.html`, `success.html`, `cancel.html`, `admin.html`

Each page loads its own module(s). Clean URLs come from redirects in `netlify.toml`.

### Convex backend (`convex/`)

Auth is Clerk, via the JWT template `convex` (`auth.config.ts`, issuer from `CLERK_JWT_ISSUER_DOMAIN`). Functions read the caller from `ctx.auth` and never trust client-sent user IDs. User-facing errors are `ConvexError({ code, message })` (`lib/errors.ts`).

- `schema.ts`: tables `products`, `tracks`, `users`, `entitlements`, `orders`, `orderItems`, `plays`, `stripeEvents`.
- `lib/auth.ts`: `getViewer`, `requireViewer`, `ensureViewer`, `requireAdmin`. Admin means `users.isAdmin` or a verified email in `ADMIN_EMAILS`.
- `tracks.ts`: `listForPlayer` action (and `playerTracks`, the shared tracklist-with-links helper). Checks the purchase, then returns the tracklist with Convex storage links to the full songs. Also the upload flow (`generateUploadUrl`, `fileHashes`, `attachTrackFile`, `attachDownload`) used by `npm run upload:audio`.
- `payments.ts`: Stripe (fetch client, default runtime).
  - `createDigitalSession`
  - `downloadsForCheckoutSession`: 24 h window after payment.
  - `streamForCheckoutSession`: the full songs in the same 24 h window, from the paid session, without an account.
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
- `home.ts`: the home page. Mounts the player in its wrapping, picks the track source, and opens the checkout from GET LIT. Coming back from Stripe it remembers the checkout session (`purchase-session.ts`), so the buyer hears the full album for 24 hours without signing in.
- `checkout.ts`: the PWYW modal (amount → upsell → email + marketing-consent checkbox → Stripe redirect via Convex).
- `success.ts`: success page downloads (Convex) and sign-in prompt.
- `dashboard.ts`: purchases, downloads, orders, export/delete my data.
- `admin.ts`: stats from `api.admin.stats`, with access enforced server-side.
- `nav-auth.ts`: nav auth state; ADMIN link from `api.users.me`.
- `sticker-peel.ts`: React Bits sticker port, used by the coming-soon cards.
- `physical.ts` / `cart.ts` / `shopify.ts`: physical store (Shopify Storefront).
- `analytics.ts`: PostHog.

### 3D MiniDisc player (`src/player3d/`)

See `docs/superpowers/specs/2026-09-16-minidisc-player-3d-design.md` and the build updates in `Grilled.md`.

- `state.ts`: pure deck state machine and key latches (unit-tested). Selecting a track while running enters `seeking` (laser calibration of at least 2 s) before `playing`. Play after a pause or stop enters `resuming`: the disc spins back up and `ready` starts the music at full speed.
- `audio-engine.ts`: one `<audio>` element through Web Audio when CORS allows; otherwise direct playback with a simulated spectrum. `unlock()` must run inside the user gesture. Also exposes `waveform()`.
- `disc-sounds.ts`: drive mechanics from a real recording (`npm run disc-sounds   # and npm run wrap-sounds for the unwrap` → `public/assets/audio/disc/`, `disc-sounds.json`): spin-up (the disc starts turning `SPIN_LEAD_SECONDS` before its motor is heard), seamless spinning loop, spin-down, and unload (the load sound played before the eject, with `unclampAt`/`releaseAt` markers the eject timeline follows). The deck's `playRpmCurve` follows the same curves so sound and motion line up.
- `track-source.ts`: `ConvexTrackSource` (full songs from Convex storage, purchase-checked). `lit-stream-source.ts`: `LitStreamSource`, what the public page uses: buyers get the full songs, everyone else (or anyone when the service fails) gets the previews, and the HUD shows a SIGN IN / GET LIT note. `preview-track-source.ts`: `PreviewTrackSource`, 30-second LIT previews for the public demo (`npm run previews` cuts them from the local LIT files into `public/assets/audio/lit-previews/` and writes `lit-previews.json`).
- `scene.ts`: renderer, framing to the HUD's `.p3d-frame`, tilt spring, bloom + CRT pass, visibility pause.
- `deck.ts`: extruded body/cartridge/keys from `geometry.json` + WebP textures. The disc face is the LIT cover; the cartridge label is "Do Not Duplicate".
- `cartridge-detail.ts`: realism layer over the Canva art. Lathe-turned steel Phillips screws (occlusion-mapped recess) in counterbored wells cut into the shell, a disc with real thickness and a separate machined hub in its centre opening, a steel hub ring on the back, an additive clearcoat pass with normals baked from the artwork, iridescent disc sheen, paper-grain label, and a studio environment map tinted with the city's neon. Coarse pointers get standard materials instead of clearcoat/iridescence.
- `lcd-text.ts` / `lcd.ts`: the calculator-style status display in the cover's lower-left corner (a recess cut through the body). 11 amber 14-segment characters behind glass, with play / pause / stop / repeat flags above. Shows LOADING, READING, CALIBRATING, SPIN UP, EJECTING, NO DISC, or PLAY/PAUSE/STOP with the track number; ◀ ▶ and repeat flash their button (NEXT 03, REPEAT ON) for 0.9 s. `lcd-text.ts` (content and font) is unit-tested; `lcd.ts` redraws its canvas only on change.
- `spindle.ts`: the deck's spindle motor under the seated hub. It rises through the cartridge's back opening once seated, turns with the disc, and drops clear before eject (`Deck.setSpindleEngaged`, called from the insert and eject timelines).
- `backdrop.ts` / `backdrop-shaders.ts`: comic-book 90s-anime city (`city-comic.webp`, 21:9), depth-map parallax (`city-depth.webp`), pulsing neon and beam shimmer (`city-mask.webp`), flying craft, embers, rain.
- `wrap.ts` / `wrap-math.ts` / `wrap-sound.ts`: the packaging the page opens on. A printed card sleeve wrapped round the cartridge in 3D (extruded board walls, closed foot, open mouth with the cartridge standing a little proud of it, the cover full bleed on the front and the print carried over the spine and foot) inside clear shrink film on every face (one layer each, front-side only, so the far side never shows through the near one), all in 3D and parented to the cartridge. A double-click (double-tap, Enter, or the UNWRAP button) runs the unwrap in two beats over about 5.4 s: the plastic curls slowly off (a fold travelling across the face in the vertex shader; the rolled part is dragged off the package and towards the viewer, drawn over everything so it never clips against the sleeve) and is carried out of shot, then the sleeve slides down off the screen, leaving the disc facing the viewer. Nothing fades out on screen: the packaging leaves the frame. The film is one layer, from Lawrence's own shrink-wrap sheet (`wrap-film.webp` + `wrap-film-normal.webp`, built from `~/Downloads/Untitled Design (1).png`), and the sleeve cover is the clean LIT art (`lit-sleeve.webp`, from `~/Downloads/¡ (1).png`). The back of the packaging is weathered (faded print, stains, creases, scuffs, cloudy film) so it reads as a relic. The sound is Lawrence's own: a plastic wrap peel and a hand pulling card (`npm run wrap-sounds` → `public/assets/audio/wrap/`, `wrap-sounds.json`), played once each: the peel slowed to the length of its phase, the hand as the sleeve comes off (`wrap-math.ts`, unit-tested). The page opens sealed from the first paint: black, no nav, no HUD, no scrolling, nothing but the package and its instruction until the unwrap has finished. The package is framed in the same box as the floating disc (`.p3d-stage`), so nothing moves when the packaging comes off. The package squares up to the camera before it starts, however the visitor has turned it. Until then the inspector is in its intro pose: the package centred on black, deck, city and HUD hidden, which fade in slowly (about 3 s) as the black goes. The sealed package turns: drag, arrows, pinch and wheel work on it, so the cover, the printed back (tracklist, imprint, barcode) and the spine can all be seen before it's opened.
- `insert-sequence.ts`: GSAP timelines for the page-open float-in, insert (from wherever the cartridge floats) and eject (spin-down, unload, spindle drop, pop). GSAP comes from the CDN, `window.gsap`.
- `inspect.ts`: eject inspector. Untouched, the cartridge sways around square-on rather than turning right round, so its printed face stays toward the viewer; dragging still turns it through 360°. The page always opens ejected: once tracks load, the cartridge floats in front of the empty deck (`runFloatInSequence`). The red key ejects the cartridge to the foreground (`ejecting` → `ejected`). The cartridge rotates 360° in camera space (drag with inertia, arrows) and zooms toward the pointer (wheel, pinch, + and −). Double-click/tap or 0 resets; INSERT DISC, Enter/Esc, Play or a track pick push it back in. It is fitted into the HUD's invisible `.p3d-stage` box.
- `keys.ts`: raycast, keyboard (Space, ←, →, S, E = eject, R = repeat) and hidden real buttons. The red key is Eject; Repeat is the toggle under the tracklist.
- `hud.ts` / `hud.css` / `hud-fx.ts`: HTML HUD with desktop, tablet (sheet) and phone (strip + sheet) layouts. The deck status is on the deck's own LCD and in the phone strip; the HUD keeps a screen-reader-only live region.
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
3. **Return:** the buyer lands on `/?success=true&session_id=…`. `home.ts` takes the session out of the URL (before analytics sees it), remembers it for 24 h, and the packaging opens itself. `success.html` can show downloads in the same window.
4. **Streaming:** the home page is open to everyone. A signed-in buyer gets the full songs through `tracks.listForPlayer`; someone who has just paid gets them through `payments.streamForCheckoutSession` (their paid Stripe session, 24 hours, no sign-in); everyone else hears the 30-second previews.

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

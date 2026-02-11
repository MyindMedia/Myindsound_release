# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Myind Sound Releases is a music release platform with pay-what-you-want (PWYW) digital sales and physical merchandise. It is a multi-page vanilla TypeScript site deployed on Netlify. There is also a separate React app under `stream/` for authenticated streaming (not currently the primary player).

## Commands

```bash
# Main site (root)
npm run dev      # Start Vite dev server
npm run build    # TypeScript check + Vite build

# Stream app (separate project with its own node_modules)
cd stream
npm run dev      # Start React dev server
npm run build    # TypeScript check + Vite build
```

For local testing with Netlify Functions: `netlify dev` (requires Netlify CLI). The main site `npm run dev` won't serve `/.netlify/functions/*` endpoints.

## Architecture

### Multi-Page Vite Build

The main site is **not** an SPA. Vite is configured with multiple HTML entry points in `vite.config.ts`:

`index.html`, `login.html`, `dashboard.html`, `physical.html`, `stream.html`, `success.html`, `cancel.html`

Each page loads its own TypeScript module(s) via `<script type="module">`. Clean URLs (`/physical` → `physical.html`) are handled by redirects in `netlify.toml`.

### Main Site Source (`src/`)

- `main.ts` - Index page: tracklist rendering, purchase flow init, post-purchase animation sequence, checks existing purchase status via Clerk+Supabase
- `checkout.ts` - `CheckoutFlow` class: modal-based 3-step flow (upsell → email capture → Stripe redirect via `create-checkout` function)
- `stream.ts` - `StreamPlayer` class on `stream.html`: Y2K-inspired CD player with full audio playback, GSAP animations, calibration spin sequence, docking animation from purchase flow
- `disk-player.ts` - `DiskPlayerAnimator` / `EnhancedDiskPlayerAnimator`: controls disc spinning with CSS fallback and GSAP-enhanced smooth rotation (100 RPM = 0.6s/rotation)
- `purchase-animation.ts` - `PurchaseAnimationController`: post-purchase overlay animation (lift-off → sticker peel → disc reveal → redirect to `stream.html?state=animate_dock`)
- `sticker-peel.ts` - `StickerPeel` class for interactive album art peel effects using GSAP
- `clerk.ts` - Singleton Clerk initialization, auth utilities (`getUserId`, `isSignedIn`, `mountSignIn`, `mountSignUp`, `requireAuth`)
- `supabase.ts` - Supabase client, DB type definitions, query helpers (`hasProductAccess`, `getUserPurchases`, `getUserOrders`, `logTrackPlay`)
- `physical.ts` / `cart.ts` / `shopify.ts` - Physical merchandise store
- `nav-auth.ts` - Navigation auth state (shows user button when signed in)
- `login.ts` - Mounts Clerk sign-in/sign-up components
- `dashboard.ts` - User dashboard showing purchases and orders
- `admin.ts` - Admin panel with play stats

### Post-Purchase Animation Flow

This is a key multi-page animation sequence:
1. After Stripe checkout, user returns to `/?success=true`
2. `main.ts` detects `success` param → starts `PurchaseAnimationController`
3. Animation: album art lifts to center → sticker peels off → CD player revealed → spinning disc
4. User clicks play button → redirects to `stream.html?state=animate_dock`
5. `stream.ts` detects `animate_dock` → runs docking sequence (floating disc → shrinks into CD player position)
6. After docking → UI reveals → calibration spin → auto-play first track

### CDN Dependencies

GSAP (`gsap.min.js`, `Draggable.min.js`) and Unicorn Studio are loaded via CDN `<script>` tags in HTML files, not npm. Access them as `(window as any).gsap`. The `EnhancedDiskPlayerAnimator` checks for GSAP availability and falls back to CSS animation.

### Stream App (`stream/`) - Separate React Project

- Uses Clerk (`@clerk/clerk-react`) + Supabase + Framer Motion
- `stream/src/App.tsx` - `SignedIn`/`SignedOut` guards
- `stream/src/components/Library.tsx` - Fetches purchased products
- Has its own `package.json`, `node_modules`, and Vite config

### Netlify Functions (`netlify/functions/`)

- `create-checkout.ts` - Creates Stripe Checkout sessions with dynamic PWYW line items
- `create-physical-checkout.ts` - Creates Stripe sessions for physical merchandise with shipping
- `stripe-webhook.ts` - Handles `checkout.session.completed`: creates Clerk user, grants `user_access`, handles physical orders, syncs to Go High Level CRM
- `get-stream-urls.ts` - Generates time-limited Supabase Storage signed URLs for audio tracks (2hr expiry). Verifies `user_access` before serving
- `get-download-url.ts` - Download URL for verified purchases
- `verify-session.ts` - Validates Stripe sessions for success page
- `ghl-lead.ts` - Captures email leads to Go High Level

### Data Flow

1. User enters email and amount on main site
2. `create-checkout` creates Stripe session
3. After payment, `stripe-webhook` provisions access:
   - Matches Stripe products to Supabase `products.stripe_product_id`
   - Creates Clerk user if needed (with `skipPasswordRequirement`)
   - Inserts into `user_access` (Clerk user_id + product_id)
   - Upserts `profiles` record
4. User returns to site → post-purchase animation → stream player
5. `stream.ts` calls `get-stream-urls` with Clerk user ID to get signed audio URLs

## Environment Variables

**Main site (root `.env`):**
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` - Stripe server-side
- `VITE_STRIPE_PUBLISHABLE_KEY` - Stripe client-side
- `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` - Supabase (service role for functions)
- `VITE_SUPABASE_ANON_KEY` - Supabase client-side (used by `src/supabase.ts`)
- `VITE_CLERK_PUBLISHABLE_KEY` - Clerk frontend (used by `src/clerk.ts`)
- `CLERK_SECRET_KEY` - Clerk backend API (functions)
- `GHL_API_KEY`, `GHL_LOCATION_ID` - Go High Level CRM
- `LIT_DOWNLOAD_URL` - Download URL for verified purchases

**Stream app (`stream/.env`):**
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` - Supabase client
- `VITE_CLERK_PUBLISHABLE_KEY` - Clerk frontend

## Database Schema (Supabase)

- `products` - id, name, description, cover_url, audio_url, stripe_product_id
- `user_access` - user_id (Clerk ID), product_id (FK to products), unique constraint on pair
- `profiles` - id (Clerk ID), email, full_name, is_admin
- `physical_orders` - id, user_id, stripe_payment_id, total_amount, shipping_address (jsonb), order_status
- `order_items` - id, order_id (FK), product_id, product_name, variant, quantity, unit_price
- `track_plays` - id, user_id, product_id, track_name, played_at

Audio files are stored in Supabase Storage bucket `LIT`, served via signed URLs.

## Key Integration Points

- **Stripe product IDs** must match `products.stripe_product_id` in Supabase for webhook provisioning
- **Clerk user IDs** are the primary identifier across all Supabase tables (not Supabase auth)
- **LIT Product ID**: `f67a66b8-59a0-413f-b943-8fbb9cdee876` is hardcoded in `main.ts`, `stream.ts`, and `get-stream-urls.ts`
- GSAP and Draggable are loaded via CDN in HTML files, accessed as window globals
- Unicorn Studio handles the WebGL animated background (project ID `SrJiFKz8avO1GlImykxO`)
- The CD player uses a 5-layer PNG stack (`/assets/images/CD Casset/layer1-5.png`) where layer-3 is the spinning disc

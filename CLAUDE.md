# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Myind Sound Releases is a music release platform with pay-what-you-want (PWYW) digital sales. It consists of two applications:

1. **Main Site** (root `/`) - Landing page for album releases with Stripe checkout
2. **Stream App** (`/stream/`) - React-based authenticated music streaming library

## Commands

```bash
# Main site (root)
npm run dev      # Start Vite dev server
npm run build    # TypeScript check + Vite build

# Stream app (separate project)
cd stream
npm run dev      # Start React dev server
npm run build    # TypeScript check + Vite build
```

For local testing with Netlify Functions: `netlify dev` (requires Netlify CLI)

## Architecture

### Main Site (Vanilla TypeScript + Vite)
- `index.html` - Entry point with PWYW purchase UI
- `src/main.ts` - App initialization, tracklist rendering, sticker effects
- `src/checkout.ts` - `CheckoutFlow` class handles modal-based purchase flow (upsell → email capture → Stripe redirect)
- `src/sticker-peel.ts` - `StickerPeel` class for interactive album art peel effects using GSAP

### Stream App (React + Vite)
- Uses Clerk for authentication (`@clerk/clerk-react`)
- Uses Supabase for user data and product access
- `stream/src/App.tsx` - Protected routes with `SignedIn`/`SignedOut` guards
- `stream/src/components/Library.tsx` - Fetches user's purchased products from `user_access` table

### Netlify Functions (`netlify/functions/`)
- `create-checkout.ts` - Creates Stripe Checkout sessions with dynamic line items
- `stripe-webhook.ts` - Handles `checkout.session.completed`:
  - Creates/finds Clerk user
  - Grants product access in Supabase `user_access` table
  - Syncs to Go High Level CRM
- `verify-session.ts` - Validates Stripe sessions for success page download links
- `ghl-lead.ts` - Captures email leads to Go High Level

### Data Flow
1. User enters email and amount on main site
2. `create-checkout` creates Stripe session
3. After payment, `stripe-webhook` provisions access:
   - Matches Stripe products to Supabase `products.stripe_product_id`
   - Creates Clerk user if needed
   - Inserts into `user_access` (Clerk user_id + product_id)
4. User accesses Stream app, Clerk authenticates, Library fetches accessible products

## Environment Variables

**Main site (root `.env`):**
- `STRIPE_SECRET_KEY` - Stripe API key (server-side)
- `STRIPE_WEBHOOK_SECRET` - Webhook signature verification
- `VITE_STRIPE_PUBLISHABLE_KEY` - Stripe publishable key (client-side)
- `VITE_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` - Supabase config
- `CLERK_SECRET_KEY` - Clerk backend API
- `GHL_API_KEY`, `GHL_LOCATION_ID` - Go High Level CRM
- `LIT_DOWNLOAD_URL` - Download URL for verified purchases

**Stream app (`stream/.env`):**
- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY` - Supabase client
- `VITE_CLERK_PUBLISHABLE_KEY` - Clerk frontend

## Database Schema (Supabase)

- `products` - id, name, description, cover_url, audio_url, stripe_product_id
- `user_access` - user_id (Clerk ID), product_id (FK to products), unique constraint on pair
- `profiles` - id (Clerk ID), email, full_name

## Key Integration Points

- **Stripe product IDs** must match `products.stripe_product_id` in Supabase for webhook provisioning
- **Clerk user IDs** are used as the primary identifier across Supabase tables (not Supabase auth)
- GSAP and Draggable are loaded via CDN in `index.html` for sticker effects

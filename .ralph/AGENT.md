# Ralph Agent Configuration

## Build Instructions

```bash
# Main site - TypeScript check + Vite build
npm run build

# Stream app (separate project)
cd stream && npm run build
```

## Dev Server

```bash
# Main site dev server (no Netlify Functions)
npm run dev

# Full stack with Netlify Functions
netlify dev

# Stream app dev server
cd stream && npm run dev
```

## Test Instructions

No test framework configured yet. Validate via:
```bash
# TypeScript type checking
npx tsc --noEmit

# Stream app type checking
cd stream && npx tsc --noEmit
```

## Environment

- Vanilla TypeScript + Vite (multi-page, NOT SPA)
- 7 HTML entry points configured in vite.config.ts
- GSAP + Draggable loaded via CDN (window globals)
- Netlify Functions for serverless backend
- Clerk for auth, Supabase for DB, Stripe for payments

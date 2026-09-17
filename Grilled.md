# Grilled.md — Myind Sound Releases

Alignment record from the 2026-09-16 grilling session. Treat this as authoritative context before planning or building. Append new decisions at the bottom; don't rewrite history.

## Goal

1. Replace the stream page player with a Three.js MiniDisc deck: cyberpunk scene, floating HUD, a cartridge-insert animation, and physical keys that latch.
2. Move the whole backend off Supabase (unreachable since at least 2026-09-16) onto Convex, with paid audio in Cloudflare R2 behind short-lived signed links.

## Scope

Three sub-projects, built in this order:

| # | Sub-project | Spec |
|---|---|---|
| 1 | Convex backend, slice 1: products, tracks, users, entitlements, orders, plays, Stripe webhook, checkout, leads, R2 audio + downloads, buyer rebuild from Stripe | `docs/superpowers/specs/2026-09-16-convex-backend-slice1-design.md` |
| 2 | 3D MiniDisc player on `stream.html` | `docs/superpowers/specs/2026-09-16-minidisc-player-3d-design.md` |
| 3 | Convex backend, slice 2: dashboard, admin, nav admin flag, physical store wiring, retire `stream/` React app, delete remaining Netlify functions and `@supabase/supabase-js` | not written yet |

## Target users

- **LIT buyers:** fans who paid PWYW, often on a phone, often straight from Stripe checkout.
- **Lawrence (admin):** checks plays and orders, and manages products.

## Stack

- **Site:** multi-page Vite + vanilla TypeScript (no React on the main site), hosted on Netlify.
- **Backend:** Convex (database, queries/mutations/actions, HTTP actions, crons), US region.
- **Auth:** Clerk. Convex verifies Clerk JWTs; nothing trusts a client-supplied user ID.
- **Payments:** Stripe Checkout (hosted redirect, SAQ A).
- **Audio files:** Cloudflare R2 through the `@convex-dev/r2` component, with signed URLs (2 h stream, 1 h download).
- **CRM:** Go High Level.
- **Analytics:** PostHog (`src/analytics.ts`, new, uncommitted).
- **3D:** `three` from npm, GSAP (already loaded from CDN) for timelines, HTML HUD layer.
- **Design assets:** Canva design `DAHAUDNdp9k` ("CD PLYAER MYINDSOUND", 18 pages), exported as transparent PNGs through the Canva MCP.

## Constraints

- **Netlify only, never Vercel.** Netlify serves the static site; its build runs `npx convex deploy --cmd 'npm run build'`.
- **Compliance (Compliance Ops check, 2026-09-16):**
  - Claude never reads customer PII. Migration and debug output print counts and IDs only; real records are browsed in the Convex dashboard by Lawrence.
  - Export + delete-my-data must cascade to Clerk and GHL (Stripe keeps payment records for tax).
  - Plays are pruned after 12 months.
  - Marketing consent is an explicit, unticked opt-in with a stored timestamp.
  - No emails in logs.
  - R2 holds audio only, never PII, and no user IDs in object keys.
  - Card data never touches our code (Stripe Checkout redirect).
- **Brand:** `#1A1A1A` base, gold `#FDB913`, orange `#FF8C00`, Inter. The player adds LIT pink `#FF3DA8` and ice `#9FD8FF` for the scene only. Monospace (JetBrains Mono) for HUD numerals only.
- **Accessibility:** real `<button>`s behind the 3D keys, keyboard operable, and a reduced-motion variant (no fly-in, rain or sway).
- **Performance:** 60 fps target on a 2021 iPhone, DPR capped (2 desktop / 1.5 phone), textures WebP ≤ 2048 px, no rendering while the tab is hidden, static fallback when WebGL is unavailable.
- **Security gate:** `/pentest` before calling either backend slice done.
- **Known Convex/Clerk traps on this machine** (from memory):
  - A Clerk JWT template named `convex` must exist on each Clerk instance (dev and prod).
  - A `prebuild` runs `convex codegen` because `--cmd` builds before codegen.
  - Run Convex CLI under Homebrew `node@22` (Node 25 breaks codegen).
  - User-facing errors use `ConvexError`, because production redacts plain `Error`.

## Non-goals

- A full 360° model of the player; it's front-on with visible thickness only.
- A seek bar or a dedicated now-playing panel (time lives in the readouts, the current track glows in the tracklist).
- Gyroscope tilt on phones.
- Rebuilding the home-page post-purchase reveal in Three.js (it keeps handing off to `stream.html?state=animate_dock`).
- Key-click sound effects.
- Restoring Supabase play history or admin flags (lost with the project).
- A cookie-consent banner (see open questions).

## Decisions log (2026-09-16)

| Question | Decision |
|---|---|
| Transparent assets | Connect Canva MCP, export all 18 pages as transparent PNGs → `~/Downloads/CD PLYAER MYINDSOUND/transparent/` |
| Player scope | Stream page only; insert animation replaces the dock animation |
| 3D depth | Solid front-on: art on front faces, dark `#1A1A1A` edges, tilt ≤ ~30° |
| Insert trigger | Tap to insert (one gesture unlocks audio) |
| Keys | Pause, Stop, ◀ prev track, ▶ next track, Play, Red = repeat. Play/Pause/Red latch down; Stop pops all |
| HUD | Live spectrum, tracklist panel, volume + readouts; time folded into readouts |
| Background | Built in the same Three.js scene; Unicorn Studio removed from the stream page |
| Palette | Brand gold/orange HUD, LIT pink/ice scene |
| Build approach | Vanilla Three.js + HTML HUD, ThreeUI effects ported without React (`crt`, `condensation`, `uplink-loader`, `dot-matrix`) |
| Backend | Supabase → Convex, all of it, two slices |
| Paid audio storage | Cloudflare R2 via `@convex-dev/r2`, signed links |
| Existing buyers | Rebuild from Stripe paid checkout sessions |
| Audio masters | `~/Downloads/LIT  [Live In Truth]-2026-09-17/` (5 MP3 ~190 kbps VBR, 1 WAV 16-bit/48 kHz) |
| Compliance fixes | Accepted (see Constraints) |

## Asset map (Canva page → role)

| Page | Role |
|---|---|
| 13 | Player body (window cut through) |
| 7 | Inner back wall behind the window |
| 10 | Glare layer over the window |
| 8 | "WAY UP" slot door |
| 9 | Key strip → cut into 6 keys |
| 16 | Cartridge shell (disc area masked out) |
| 5 | LIT disc (spins) |
| 3 | Clear disc layer (spins) |
| 2 | Myind Sound label (fixed) |
| 11 | Composite reference for placement only |
| 1, 4, 6, 12, 14, 15, 17, 18 | Unused for now |

## Open questions

1. **Album title:** "Live In Truth" (masters folder) or "Living In Truth" (track 1 filename and current code)? Asked twice, unanswered.
2. **Production domain(s)** for the R2 CORS allow-list and Clerk. Not in `netlify.toml`, and memory says the apex is a different Netlify site.
3. **Cloudflare account:** does Lawrence have one with R2 enabled?
4. **Clerk:** do the dev and prod instances already have a `convex` JWT template?
5. **PostHog:** cookieless mode, or add a consent banner for EU visitors?
6. **`create-physical-checkout`** has no frontend caller in `src/` or the HTML. Is the physical store on Shopify (`src/shopify.ts`) instead? Resolve in slice 2.
7. **THE SOURCE presale:** Stripe product `prod_TsqUkQtzNQ5Y3z` links to an untitled.stream placeholder URL. Is the real link known?
8. **Security follow-up:** once Convex replaces them, delete `get-stream-urls` and `get-download-url` promptly. Both trust a client-sent user ID today.

## Build session updates (2026-09-16, later)

| Topic | Decision / finding |
|---|---|
| Backdrop | Lawrence: "the city backdrop needs to be a real 90s anime render of a cyberpunk city". Replaced the procedural city/haze/grid with a painted backdrop: Midjourney Niji 6, round 2 option 3 (`public/assets/images/minidisc/city-backdrop.webp`). All 8 generations are kept in `~/Downloads/CD PLYAER MYINDSOUND/backdrops/`. The procedural city stays as the fallback if the image fails to load |
| Production domain | `stream.myindsound.com` (Netlify site `myindreleases`, builds branch **`master`**). Answers open question 2 |
| Physical store | Runs on Shopify Storefront (`VITE_SHOPIFY_*`). `create-physical-checkout` was dead code and is deleted. Answers open question 6 |
| Clerk | The live site uses the Clerk **dev** instance `main-grouper-12` (`pk_test_…`). Dev instances cap users and show dev banners; moving to a production instance is a follow-up |
| Netlify env today | Only the Stripe live keys, Clerk publishable key, Supabase and Shopify vars. No webhook secret, Clerk secret or GHL keys, so the old webhook could never have provisioned access |
| Convex | Team `myindmedia`, project `myind-releases`, dev deployment `decisive-iguana-954` (products and 6 tracks seeded) |
| Admin | Enforced server-side: `users.isAdmin` or `ADMIN_EMAILS` (replaces the client-side hardcoded email check). `admin.html` was missing from the Vite build and is now included |
| Key feel | Latched keys sink 60% and darken 25%; a momentary press goes full depth for 140 ms |

### Still open
1. Album title: "Live In Truth" vs "Living In Truth" (track 1 title currently "L.I.T. (Living In Truth)").
2. Cloudflare account with R2 enabled, plus an R2 API token.
3. Clerk `convex` JWT template on `main-grouper-12`, and `CLERK_SECRET_KEY` entered in Convex.
4. A Stripe **test** key for the Convex dev deployment (Netlify only has live keys).
5. GHL API key and location ID (never set on Netlify).
6. PostHog: cookieless mode or a consent banner.
7. `stream/` legacy React app: delete it or keep it?
8. `/pentest` needs Docker (not installed here) or a Strix Cloud account.
| Disc art | Lawrence: "this should be the disk image" (clean LIT cover, samurai in the neon street). Saved as `~/Downloads/CD PLYAER MYINDSOUND/lit-cover-clean.png`; `build_disc_face()` in `scripts/build-player-assets.py` prints it on the disc (84% inset, blurred bleed, real Canva hub, grooves, rim). The clear disc overlay dropped to 22% so the art reads |
| Cartridge label | Lawrence: "for the disk label it should be the do not duplicate label". It's cut from Canva page 14 (`DND_LABEL` in `scripts/build-player-assets.py`) and replaces the Myind Sound label (page 2). It sits 0.045 world units lower than in the Canva comp so the window frame doesn't clip the handwriting |
| City backdrop v2 | Lawrence: "pixel perfect match the uploaded image … comic book 90s anime texture … slightly 3d", plus earlier "glowing pulsating neon lights in the distance, flying vehicles in the distant sky". Built:<br>• Nano Banana Pro restyle of `Covers Albums.png`, fed padded to 16:9 and cropped back so edges line up (edge correlation 0.68 vs 0.27 unpadded)<br>• Outpainted to 21:9 with the original centre composited back in<br>• Gemini depth map giving slight parallax<br>• Neon and beam mask, flying craft only in the far sky, embers and rain<br>The procedural 3D city and the Niji painting were both rejected |
| Halo | Lawrence: "the hud circular halo should be over the disk area and only appears before the disk starts to play … like a halo". It's a 3D ring (`halo.ts`) at z +0.34 in front of the disc. It boots on insert and on calibration, and its ticks fill clockwise (with RPM on insert, over time on calibration). It dissipates on playback. The HTML disc ring is gone |
| Track selection | Lawrence: "load delay in song selection for at least 2 seconds with a loading laser calibration sound". Selecting a track while running (tracklist click, ◀ ▶ while playing) enters `seeking`: music paused, synthesised calibration sound, halo, disc dip to 35%, then play after ≥ 2.2 s. ◀ ▶ while paused or stopped just move the cursor. Auto-advance at the end of a track stays gapless |
| React Bits Pro | Lawrence: "use some of the reactbits pro assets for the hud and 3d elements and effects". Pro is 599 app-UI blocks, not the WebGL effects library. Ported to vanilla TS in `hud-fx.ts`:<br>• `404-6` glitch → status text<br>• `404-8` + `cta-12` typing → boot terminal<br>• `bento-41` → oscilloscope<br>• `monitoring-2` → signal sparkline<br>• `analytics-10` → RPM gauge<br>• `404-7` radar → halo sweep<br>Originals are in `src/vendor/reactbits/`. The licence key was read from `~/Dev/MTTE/.env.local`, because the 1Password service account can't see the Employee vault |
| Eject inspector | Lawrence: "an eject button on the red player button that should eject the minidisk and show it in 3d … in the foreground … 360 rotation … zoom into details … from all angles. The insert disk tab pushes it back in", then "the side profile … should have the same texture all the way around". Decisions:<br>• Red key = Eject, with an eject glyph printed on it. Repeat moved to a REPEAT toggle under the tracklist; R still toggles it and E ejects<br>• Eject works from playing, paused, stopped or calibrating. Audio fades, the disc spins down, the spring pops the cartridge out of the slot, and it flies forward with one turn (`ejecting` → `ejected`)<br>• The inspector rotates the cartridge, not the camera, so the backdrop and HUD stay put. Deck and city dim behind it, and the CRT pass softens<br>• Push back in (INSERT DISC, Play, Enter/Esc, or a track pick) flies it home from wherever it is and plays that track from the start<br>• All sides are real: back cap from Canva page 6 (metal hub), solid rim-textured edges, shell texture raised to 2048 px so zoom stays sharp |
| Opens ejected | Lawrence: "the site should start with the disk floating in ejected mode always". The deck boots straight to `ejected` (the `empty` state is gone): the cartridge drifts in and floats in front of the empty deck, with INSERT DISC and the inspect hint below. Insert, Play, Space or a track pick loads it |
| Stream page live (demo) | Lawrence: "publish to https://stream.myindsound.com/stream" (2026-09-16). Published a manual Netlify deploy `6aab8522e43d1d6b88d7fa2f`: the live site's files and functions from commit `1e5c3df`, byte-for-byte, with only `/stream` swapped for the 3D player in demo mode (`VITE_PLAYER_DEMO=1`, demo clip, no sign-in). Rollback: restore deploy `698eeb90a077b40008274af6`. The next push to `master` replaces it. Local `master` (e61ad0f) has diverged from `origin/master` (1e5c3df); reconcile before merging the branch |

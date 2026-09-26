# App V1 build rules (replaces GAUNTLET.md)

Repo: `~/Dev/myind-app`, branch `feat/app-v1`. Spec: `docs/app-v1/PRD.md`. Also read the root `CLAUDE.md`.

## How we build
- **One pass per piece.** Build it, write the tests the PRD lists, and run them. There's no critic loop, so get it right the first time: read the PRD section in full before writing code.
- **Node 22 first:** `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`.
- **Nothing ships from an agent.** No `convex dev`/`deploy`, `netlify`, `git commit` or `git push`. The lead deploys to the Convex DEV deployment when an end-to-end run needs it.
- **The live website must keep working unchanged.** `npm test`, `npx tsc --noEmit`, `npx tsc -p convex --noEmit` and `npx vite build` stay green.
- **Stay in your file boundary.** Other agents are editing in parallel. Before editing a shared file such as `convex/schema.ts`, re-read it immediately beforehand and make the smallest possible edit.
- **Compliance:** never print customer PII. Counts and IDs only.
- **[DECIDE] items** are config constants with the PRD default.
- **Match existing code style.** Extend what exists (PRD §3A).
- **Report** in under 40 lines: files, commands with pass counts, PRD IDs done, what's left and why.

## App API contract (Convex), owned by the backend agent
The iOS app codes against these names. The backend agent documents the exact args and returns in `docs/app-v1/API.md`.
- `app.library()` query: the caller's owned and lent releases, plus upcoming ones, each with slug, title, edition number, unwrapped, dropAt, status, theme, bundle info and lend info.
- `app.context({ slug })` query: bridge `getContext` data (ownership owned|lent|locked|preview, editionNumber, ownerDisplayName, wear descriptor, unwrapped, dropAt, serverNow, lend?).
- `app.tracks({ slug })` query: the tracklist (ids, titles, durations, positions), with no storage ids.
- `media.getStreamUrl({ trackId, lendId? })` action: `{ url, expiresAt }`, gated on the entitlement or lend (AUD-2), valid for 5 minutes.
- `plays.recordPlayEvents({ events })` mutation (WEAR-6..8).
- `app.markUnwrapped({ slug })` and `app.recordCartridgeEvent({ slug, kind: 'load'|'eject' })`.
- `leaderboard.forRelease({ slug, limit })` query; `leaderboard.myAwards()` query.
- `push.registerToken({ token, platform, wantsDropAlerts })` mutation.
- `lends.*` (wave 2), `storekit.verifyPurchase` (wave 2).

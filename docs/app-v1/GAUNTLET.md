# App V1 gauntlet: rules for every builder and critic

Repo: `~/Dev/myind-app` (git worktree of `MyindMedia/Myindsound_release`, branch `feat/app-v1`).
Spec: `docs/app-v1/PRD.md` (requirement IDs like `WEAR-7`). Also read `CLAUDE.md` and `Grilled.md` at the repo root.
Bar screenshots (live LIT player, iPhone 393x852): `docs/app-v1/bar/*.png`.

## Hard rules
1. Node 22: `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` before any npm/npx.
2. Never deploy. No `npx convex dev`, `convex deploy`, `netlify deploy`, `git push`. Convex work is proven with `convex-test` in vitest only.
3. Never commit. The lead commits after the critic passes a piece.
4. The live website must keep working unchanged. Additive changes only to existing site code; `npm test` and `npm run build` (tsc) must stay green.
5. Stay inside your piece's file boundary (below). If you need to touch another piece's files, say so in your report instead.
6. Compliance: never print customer PII. No emails in logs. Counts and IDs only.
7. `[DECIDE]` items are config constants with the PRD default, never hardcoded inline.
8. Extend existing code (PRD §3A): `products` not `releases`, `productId` not `releaseId`, `fulfilment.record` is the single grant path.
9. Match the surrounding code style (single quotes, 2 spaces, comment density, `ConvexError({ code, message })`).

## File boundaries
- P1 wear (TS): `packages/wear/**`
- P2 tokens: `packages/tokens/**` (+ a `tokens` npm script)
- P3 grant path: `convex/schema.ts`, `convex/fulfilment.ts`, `convex/lib/**`, new `convex/editions*.ts`, `convex/migrations*.ts`, `convex/payments.ts`, `convex/stripeLogic.ts`, `convex/privacy.ts`, `convex/admin.ts`, `convex/products.ts`, `convex/entitlements.ts`, `convex/_generated/api.d.ts` (hand-edited, no deployment for codegen), `src/purchase-signin.ts`, `docs/app-v1/RUNBOOK-ED0.md`, tests beside them
- P4 bridge: `packages/bridge/**`
- P5 play events: `convex/plays.ts`, new `convex/wear*.ts`, tests (after P3 lands)
- P6 lending: new `convex/lends*.ts`, `convex/crons.ts` (after P3 lands)
- P7 wear (Swift): `packages/wear-swift/**` (SwiftPM, `swift test` on macOS)
- P8+ iOS: `apps/ios/**`

## Report format (builder)
Files changed, commands run with pass/fail counts pasted, PRD IDs covered, anything not done and why.

## Critic contract
Fresh context. You did not build this. Run the tests yourself; don't trust the report. Check every PRD ID the piece claims against the actual code. Hunt for the one way it breaks (race, idempotency, invariant, drift from PRD). For visual pieces, compare blind against `docs/app-v1/bar/` with labels stripped. Verdict: PASS or FAIL, plus the single biggest remaining gap. No praise.

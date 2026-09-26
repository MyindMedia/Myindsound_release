# ED-0 runbook: edition numbers for existing buyers

Run these in this exact order, once, right after the P3 deploy to production. Every command prints counts
only (no emails, names or ids). Stop and investigate if any step reports `error` above 0.

## Before the deploy

1. **Stripe dashboard → Developers → Webhooks → the Convex endpoint (`https://<prod>.convex.site/stripe/webhook`).**
   Make sure these events are enabled:
   - `checkout.session.completed` (already on)
   - `checkout.session.async_payment_succeeded` (already on)
   - `charge.refunded` (new)
   - `charge.dispute.created` (new)
   - `charge.dispute.closed` (new)

## Deploy

2. The lead deploys the branch (Convex and Netlify). The schema change is additive; existing rows validate.

## Straight after the deploy

3. **Mark THE SOURCE as not out yet.** Until it is, THE SOURCE is treated as live and every SOURCE upsell
   sold after the deploy gets an edition number. In the Convex dashboard (production → Data → `products`, the
   `the-source` row), set either `dropAt` (epoch ms, once Lawrence confirms the date) or, with no date yet,
   `status: "scheduled"`. The upsell keeps selling: before the drop those purchases are presale (granted,
   unnumbered). Leave `presaleAllowed` unset.

4. **Rebuild from Stripe, dry run.** Counts what the real run would do; writes nothing.

   ```bash
   export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
   npx convex run payments:rebuildFromStripe '{"dryRun":true}' --prod
   ```

   Expect mostly `already`. `granted` is paid sessions with no record of their own whose email still has an
   account: a buyer's second payment for something they already owned, or a session that was never fulfilled.
   `revoked` is refunded sessions, which are never granted. `no_account` is a paid session whose email has no
   account: before this deploy, deleting an account deleted its licence, so these can be people who deleted
   their data. The rebuild never recreates them (that would undo the deletion in Convex, Clerk and GHL). Check
   each one in the Stripe dashboard; only if it was genuinely never fulfilled, run it with accounts on, scoped
   to its time: `npx convex run payments:rebuildFromStripe '{"dryRun":false,"createAccounts":true,"createdAfterSec":<created>}' --prod`.

5. **Rebuild from Stripe, for real.** This must run before the migration: it records every paid session as a
   payment ref, including a legacy second payment (added to the licence the buyer already owns), so a later
   refund of either payment leaves the other one holding the licence.

   ```bash
   npx convex run payments:rebuildFromStripe '{"dryRun":false}' --prod
   ```

6. **Migration, dry run.** `pending` is how many licences will be numbered (LIT) or marked presale (every
   other product).

   ```bash
   npx convex run migrations:assignEditions '{"dryRun":true}' --prod
   ```

7. **Migration, for real.** Numbers LIT licences in `grantedAt` order (1, 2, 3, ...), marks the others
   presale, backfills wear seeds, status, source and payment refs, and saves each counter. Repeat until it
   prints `"done": true`.

   ```bash
   npx convex run migrations:assignEditions '{}' --prod
   ```

8. **Check.** The dry run should now report `pending: 0`, and a second real run should report `numbered: 0`,
   `presaleMarked: 0`, `countersSet: 0`.

   ```bash
   npx convex run migrations:assignEditions '{"dryRun":true}' --prod
   npx convex run diagnostics:counts --prod
   ```

## Notes

- Between steps 2 and 7, new LIT buyers own their licence at once but get their edition number from the
  migration, after every older buyer. New buyers of any other product are numbered at once.
- Licences granted by step 5 for sessions that were never fulfilled are numbered after the existing buyers
  (their `grantedAt` is the rebuild time).
- `EDITION_BACKFILL_SLUGS` (`convex/lib/editions.ts`) is the [DECIDE] list of products numbered here: `lit`.

/**
 * Paying is signing up.
 *
 * The checkout already takes an email, so a buyer coming back from Stripe shouldn't be asked to make an
 * account: Convex checks the checkout, creates the account and the licence if the webhook hasn't yet, and
 * hands back a single-use Clerk ticket. This turns that ticket into a session, so the dashboard, the
 * downloads and the full album are simply there.
 *
 * The session itself is capped at 24 hours (`clerk.ts`), after which they sign in again.
 */
import { api, getConvex, isConvexConfigured } from './convex';
import { getClerk, isClerkConfigured } from './clerk';
import { purchaseSessionId } from './purchase-session';

/** What has been tried in this tab: the checkout, and how many goes it has had. */
const TRIES_KEY = 'myind.claimTries';
/** A few goes across the pages a buyer passes through, then stop pestering Clerk. */
const MAX_TRIES = 4;

function tries(sessionId: string): number {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(TRIES_KEY) ?? 'null') as { id?: string; n?: number } | null;
    return saved?.id === sessionId ? (saved.n ?? 0) : 0;
  } catch {
    return 0;
  }
}

function countTry(sessionId: string, n: number): void {
  try {
    window.sessionStorage.setItem(TRIES_KEY, JSON.stringify({ id: sessionId, n }));
  } catch {
    /* Storage is blocked: it will simply try again on the next page. */
  }
}

function done(sessionId: string): void {
  countTry(sessionId, MAX_TRIES);
}

/**
 * Signs the buyer into the account their purchase created. Resolves true when they end up signed in,
 * false when anything is missing (not configured, the link has expired, Clerk refused the ticket) —
 * in which case the page falls back to the ordinary sign-in.
 */
export async function claimAccountFromCheckout(sessionId: string): Promise<boolean> {
  if (!sessionId || !isClerkConfigured() || !isConvexConfigured()) return false;
  try {
    const clerk = await getClerk();
    if (clerk.user) return true; // Already signed in: nothing to claim.
    const attempts = tries(sessionId);
    if (attempts >= MAX_TRIES) return false;
    countTry(sessionId, attempts + 1);

    const { ticket } = await getConvex().action(api.payments.claimAccountForCheckoutSession, { sessionId });
    const attempt = await clerk.client!.signIn.create({ strategy: 'ticket', ticket });
    if (attempt.status !== 'complete' || !attempt.createdSessionId) return false;
    await clerk.setActive({ session: attempt.createdSessionId });
    // It took: no more goes needed in this tab.
    done(sessionId);
    return true;
  } catch (err) {
    // A buyer who can't be signed in automatically still has their 24-hour link and the sign-in page.
    console.error('Account claim failed:', err);
    return false;
  }
}

/**
 * The same thing for a page that wasn't the landing page: if this browser paid in the last 24 hours and
 * isn't signed in, the account that purchase made is claimed here instead. The dashboard and the sign-in
 * page both try this before asking anyone to sign in.
 */
export async function claimIfPurchased(): Promise<boolean> {
  const sessionId = purchaseSessionId();
  return sessionId ? claimAccountFromCheckout(sessionId) : false;
}

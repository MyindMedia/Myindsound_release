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

/** Only ever claim a given checkout once per tab, however many pages it passes through. */
const CLAIMED_KEY = 'myind.claimed';

function alreadyClaimed(sessionId: string): boolean {
  try {
    return window.sessionStorage.getItem(CLAIMED_KEY) === sessionId;
  } catch {
    return false;
  }
}

function markClaimed(sessionId: string): void {
  try {
    window.sessionStorage.setItem(CLAIMED_KEY, sessionId);
  } catch {
    /* Storage is blocked: the worst case is claiming it twice, which the ticket itself prevents. */
  }
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
    if (alreadyClaimed(sessionId)) return false;
    markClaimed(sessionId);

    const { ticket } = await getConvex().action(api.payments.claimAccountForCheckoutSession, { sessionId });
    const attempt = await clerk.client!.signIn.create({ strategy: 'ticket', ticket });
    if (attempt.status !== 'complete' || !attempt.createdSessionId) return false;
    await clerk.setActive({ session: attempt.createdSessionId });
    return true;
  } catch (err) {
    // A buyer who can't be signed in automatically still has their 24-hour link and the sign-in page.
    console.error('Account claim failed:', err);
    return false;
  }
}

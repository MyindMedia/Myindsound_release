/**
 * The Stripe checkout session of a purchase made in this browser, kept for 24 hours so a buyer hears the full
 * album straight away without signing in (the same window as the downloads). Convex re-checks the session on
 * every call: this is only a reminder of which one to send, never proof of anything.
 */

const KEY = 'myind:purchase';
/** Matches DOWNLOAD_WINDOW_MS in convex/downloadLogic.ts. */
export const PURCHASE_WINDOW_MS = 24 * 60 * 60 * 1000;

const isCheckoutSessionId = (value: string): boolean => /^cs_(test|live)_[A-Za-z0-9]+$/.test(value);

function store(storage?: Storage): Storage | null {
  try {
    return storage ?? window.localStorage;
  } catch {
    return null;
  }
}

export function rememberPurchase(sessionId: string, now = Date.now(), storage?: Storage): void {
  if (!isCheckoutSessionId(sessionId)) return;
  try {
    store(storage)?.setItem(KEY, JSON.stringify({ sessionId, at: now }));
  } catch {
    /* Private mode: the unlock just doesn't survive a reload. */
  }
}

/** The remembered session while it's still inside the window; expired or damaged entries are dropped. */
export function purchaseSessionId(now = Date.now(), storage?: Storage): string | null {
  try {
    const raw = store(storage)?.getItem(KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as { sessionId?: unknown; at?: unknown };
    const fresh =
      typeof saved.sessionId === 'string' &&
      isCheckoutSessionId(saved.sessionId) &&
      typeof saved.at === 'number' &&
      now - saved.at < PURCHASE_WINDOW_MS;
    if (!fresh) {
      forgetPurchase(storage);
      return null;
    }
    return saved.sessionId as string;
  } catch {
    return null;
  }
}

export function forgetPurchase(storage?: Storage): void {
  try {
    store(storage)?.removeItem(KEY);
  } catch {
    /* Nothing to clear. */
  }
}

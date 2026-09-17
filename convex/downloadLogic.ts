export const DOWNLOAD_WINDOW_MS = 24 * 60 * 60 * 1000;

// Stripe `created` is in seconds.
export function withinDownloadWindow(createdSec: number, nowMs: number): boolean {
  const createdMs = createdSec * 1000;
  return nowMs >= createdMs && nowMs - createdMs <= DOWNLOAD_WINDOW_MS;
}

export function isCheckoutSessionId(value: string): boolean {
  return /^cs_(test|live)_[A-Za-z0-9]+$/.test(value);
}

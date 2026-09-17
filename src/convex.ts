/**
 * Convex browser client, authenticated with the signed-in Clerk session.
 * Clerk must have a JWT template named "convex" (aud: "convex") on its instance.
 */
import { ConvexClient } from 'convex/browser';
import { ConvexError } from 'convex/values';
import { api } from '../convex/_generated/api';
import { getClerk, isClerkConfigured } from './clerk';

export { api };

const CONVEX_URL = import.meta.env.VITE_CONVEX_URL as string | undefined;
const AUTH_TIMEOUT_MS = 10_000;

let client: ConvexClient | null = null;
let authReady: Promise<boolean> | null = null;

export function isConvexConfigured(): boolean {
  return Boolean(CONVEX_URL);
}

export function getConvex(): ConvexClient {
  if (!CONVEX_URL) throw new Error('VITE_CONVEX_URL is not configured.');
  client ??= new ConvexClient(CONVEX_URL);
  return client;
}

/** Resolves true once Convex accepts the Clerk token; false when signed out or misconfigured. */
export function connectConvexAuth(): Promise<boolean> {
  authReady ??= (async () => {
    if (!isClerkConfigured() || !isConvexConfigured()) return false;
    const clerk = await getClerk();
    if (!clerk.session) return false;
    const convex = getConvex();

    const authenticated = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), AUTH_TIMEOUT_MS);
      convex.setAuth(
        async ({ forceRefreshToken }) => {
          try {
            return (await clerk.session?.getToken({ template: 'convex', skipCache: forceRefreshToken })) ?? null;
          } catch (err) {
            console.error('Clerk could not issue a Convex token. Check the "convex" JWT template exists.', err);
            return null;
          }
        },
        (isAuthenticated) => {
          clearTimeout(timer);
          resolve(isAuthenticated);
        },
      );
    });

    if (authenticated) await convex.mutation(api.users.ensure, {});
    return authenticated;
  })();
  return authReady;
}

export function convexErrorCode(err: unknown): string | null {
  if (err instanceof ConvexError && typeof err.data === 'object' && err.data && 'code' in err.data) {
    return String((err.data as { code: unknown }).code);
  }
  return null;
}

export function convexErrorMessage(err: unknown, fallback: string): string {
  if (err instanceof ConvexError) {
    const data = err.data as unknown;
    if (typeof data === 'string') return data;
    if (data && typeof data === 'object' && 'message' in data) return String((data as { message: unknown }).message);
  }
  return fallback;
}

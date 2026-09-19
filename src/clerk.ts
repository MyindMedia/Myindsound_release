/**
 * Clerk Authentication Module
 * Handles Clerk initialization and provides auth utilities for vanilla HTML pages
 */

import { Clerk } from '@clerk/clerk-js';

const CLERK_PUBLISHABLE_KEY = (import.meta as any).env.VITE_CLERK_PUBLISHABLE_KEY;

/**
 * How long a sign-in lasts. After a day the session is dropped and they sign in again, whether they got
 * here through the sign-in page or straight from a purchase (`purchase-signin.ts`).
 */
const SESSION_MAX_MS = 24 * 60 * 60 * 1000;

/**
 * LIT, wherever Clerk draws: the sign-in, the sign-up, the account button and its profile all take the
 * site's own palette and type rather than Clerk's defaults. Passed to `load()`, so every surface inherits
 * it, and the mounted components only add what is particular to them.
 */
const LIT_APPEARANCE = {
  variables: {
    colorPrimary: '#FDB913',
    colorBackground: '#0B0A12',
    colorText: '#F5F1E6',
    colorTextSecondary: 'rgba(245, 241, 230, 0.66)',
    colorInputBackground: 'rgba(7, 7, 12, 0.78)',
    colorInputText: '#F5F1E6',
    colorDanger: '#FF5F6D',
    colorSuccess: '#FDB913',
    colorWarning: '#FF8C00',
    fontFamily: "'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif",
    fontFamilyButtons: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace",
    fontSize: '15px',
    borderRadius: '3px',
  },
  layout: {
    socialButtonsPlacement: 'top' as const,
    socialButtonsVariant: 'blockButton' as const,
    showOptionalFields: false,
  },
  elements: {
    card: 'clerk-card',
    rootBox: 'clerk-root',
    headerTitle: 'clerk-title',
    headerSubtitle: 'clerk-subtitle',
    formButtonPrimary: 'clerk-btn-primary',
    formFieldInput: 'clerk-input',
    formFieldLabel: 'clerk-label',
    footerActionLink: 'clerk-link',
    dividerLine: 'clerk-divider',
    dividerText: 'clerk-divider-text',
    socialButtonsBlockButton: 'clerk-social-btn',
    userButtonPopoverCard: 'clerk-card',
    userButtonPopoverActionButton: 'clerk-popover-action',
    modalContent: 'clerk-modal',
    profileSectionPrimaryButton: 'clerk-btn-primary',
  },
};

// Singleton Clerk instance
let clerkInstance: Clerk | null = null;
let clerkPromise: Promise<Clerk> | null = null;
let clerkError: Error | null = null;

/**
 * Check if Clerk key is configured
 */
export function isClerkConfigured(): boolean {
  return !!CLERK_PUBLISHABLE_KEY && CLERK_PUBLISHABLE_KEY !== 'pk_test_your_clerk_key_here';
}

/**
 * Get any initialization error
 */
export function getClerkError(): Error | null {
  return clerkError;
}

/**
 * Initialize and return the Clerk instance
 * Returns a promise that resolves when Clerk is fully loaded
 */
export async function getClerk(): Promise<Clerk> {
  if (!isClerkConfigured()) {
    const error = new Error('VITE_CLERK_PUBLISHABLE_KEY is not configured. Add it to Netlify environment variables and redeploy.');
    clerkError = error;
    // Don't throw, just return a mock object or handle gracefully to prevent page crash
    console.warn("Clerk is not configured. Authentication features will be disabled.");
    return {} as any; 
  }

  if (clerkInstance) {
    return clerkInstance;
  }

  if (clerkPromise) {
    return clerkPromise;
  }

  clerkPromise = (async () => {
    try {
      const clerk = new Clerk(CLERK_PUBLISHABLE_KEY);
      // Our own pages handle sign-in and sign-up. Without these Clerk falls back to its hosted account
      // portal (`<instance>.accounts.dev/sign-up?redirect_url=...`), which is a different site to a buyer.
      await clerk.load({
        signInUrl: '/login',
        signUpUrl: '/login?tab=sign-up',
        signInFallbackRedirectUrl: '/dashboard',
        signUpFallbackRedirectUrl: '/dashboard',
        appearance: LIT_APPEARANCE,
      });
      await endStaleSession(clerk);
      clerkInstance = clerk;
      return clerk;
    } catch (error: any) {
      clerkError = error;
      console.error('Clerk initialization failed:', error);
      throw error;
    }
  })();

  return clerkPromise;
}

/** A day after signing in, the session goes and they sign in again. */
async function endStaleSession(clerk: Clerk): Promise<void> {
  const session = clerk.session;
  const startedAt = session?.createdAt ? new Date(session.createdAt).getTime() : 0;
  if (!session || !startedAt || Date.now() - startedAt < SESSION_MAX_MS) return;
  try {
    await clerk.signOut();
  } catch (error) {
    console.warn('Could not end the expired session:', error);
  }
}

/**
 * Check if user is signed in
 */
export async function isSignedIn(): Promise<boolean> {
  const clerk = await getClerk();
  return !!clerk.user;
}

/**
 * Get current user data
 */
export async function getCurrentUser() {
  const clerk = await getClerk();
  return clerk.user;
}

/**
 * Get current user's primary email
 */
export async function getUserEmail(): Promise<string | null> {
  const clerk = await getClerk();
  return clerk.user?.primaryEmailAddress?.emailAddress || null;
}

/**
 * Get current user's Clerk ID
 */
export async function getUserId(): Promise<string | null> {
  const clerk = await getClerk();
  return clerk.user?.id || null;
}

/**
 * Get current user's display name
 */
export async function getUserName(): Promise<string | null> {
  const clerk = await getClerk();
  if (!clerk.user) return null;
  return clerk.user.fullName || clerk.user.firstName || clerk.user.username || null;
}

/**
 * Sign out the current user
 */
export async function signOut(): Promise<void> {
  const clerk = await getClerk();
  await clerk.signOut();
  window.location.href = '/';
}

/**
 * Mount Sign-In component to an element
 */
export async function mountSignIn(elementId: string, options?: {
  redirectUrl?: string;
  signUpUrl?: string;
}): Promise<void> {
  const clerk = await getClerk();
  const element = document.getElementById(elementId);

  if (!element) {
    console.error(`Element with id "${elementId}" not found`);
    return;
  }

  clerk.mountSignIn(element as HTMLDivElement, {
    fallbackRedirectUrl: options?.redirectUrl || '/dashboard',
    signUpUrl: options?.signUpUrl || '/login?tab=sign-up',
  });
}

/**
 * Mount Sign-Up component to an element
 */
export async function mountSignUp(elementId: string, options?: {
  redirectUrl?: string;
  signInUrl?: string;
}): Promise<void> {
  const clerk = await getClerk();
  const element = document.getElementById(elementId);

  if (!element) {
    console.error(`Element with id "${elementId}" not found`);
    return;
  }

  clerk.mountSignUp(element as HTMLDivElement, {
    fallbackRedirectUrl: options?.redirectUrl || '/dashboard',
    signInUrl: options?.signInUrl || '/login',
  });
}

/**
 * Mount UserButton component to an element
 */
export async function mountUserButton(elementId: string): Promise<void> {
  const clerk = await getClerk();
  const element = document.getElementById(elementId);

  if (!element) {
    console.error(`Element with id "${elementId}" not found`);
    return;
  }

  clerk.mountUserButton(element as HTMLDivElement, { afterSignOutUrl: '/' });
}

/**
 * Redirect to sign-in if not authenticated
 * Returns true if user is signed in, false if redirecting
 */
export async function requireAuth(): Promise<boolean> {
  const signedIn = await isSignedIn();
  if (!signedIn) {
    window.location.href = '/login.html?redirect=' + encodeURIComponent(window.location.pathname);
    return false;
  }
  return true;
}

/**
 * Listen for auth state changes
 */
export async function onAuthChange(callback: (user: any) => void): Promise<void> {
  const clerk = await getClerk();
  clerk.addListener(() => {
    callback(clerk.user);
  });
}

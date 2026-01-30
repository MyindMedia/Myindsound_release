/**
 * Clerk Authentication Module
 * Handles Clerk initialization and provides auth utilities for vanilla HTML pages
 */

import { Clerk } from '@clerk/clerk-js';

const CLERK_PUBLISHABLE_KEY = (import.meta as any).env.VITE_CLERK_PUBLISHABLE_KEY;

// Singleton Clerk instance
let clerkInstance: Clerk | null = null;
let clerkPromise: Promise<Clerk> | null = null;
let clerkError: Error | null = null;

/**
 * Check if Clerk key is configured
 */
export function isClerkConfigured(): boolean {
  return !!CLERK_PUBLISHABLE_KEY && CLERK_PUBLISHABLE_KEY !== 'pk_test_...';
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
    throw error;
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
      await clerk.load();
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
    afterSignInUrl: options?.redirectUrl || '/dashboard.html',
    signUpUrl: options?.signUpUrl || '/login.html#sign-up',
    appearance: {
      baseTheme: undefined,
      variables: {
        colorPrimary: '#FFD700',
        colorBackground: '#0a0a0a',
        colorText: '#ffffff',
        colorTextSecondary: '#888888',
        colorInputBackground: '#1a1a1a',
        colorInputText: '#ffffff',
        borderRadius: '8px',
      },
      elements: {
        rootBox: 'clerk-root',
        card: 'clerk-card',
        headerTitle: 'clerk-title',
        headerSubtitle: 'clerk-subtitle',
        formButtonPrimary: 'clerk-btn-primary',
        formFieldInput: 'clerk-input',
        footerActionLink: 'clerk-link',
        dividerLine: 'clerk-divider',
        dividerText: 'clerk-divider-text',
        socialButtonsBlockButton: 'clerk-social-btn',
      }
    }
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
    afterSignUpUrl: options?.redirectUrl || '/dashboard.html',
    signInUrl: options?.signInUrl || '/login.html',
    appearance: {
      variables: {
        colorPrimary: '#FFD700',
        colorBackground: '#0a0a0a',
        colorText: '#ffffff',
        colorTextSecondary: '#888888',
        colorInputBackground: '#1a1a1a',
        colorInputText: '#ffffff',
        borderRadius: '8px',
      },
      elements: {
        rootBox: 'clerk-root',
        card: 'clerk-card',
        formButtonPrimary: 'clerk-btn-primary',
        formFieldInput: 'clerk-input',
        socialButtonsBlockButton: 'clerk-social-btn',
      }
    }
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

  clerk.mountUserButton(element as HTMLDivElement, {
    afterSignOutUrl: '/',
    appearance: {
      elements: {
        userButtonAvatarBox: 'w-10 h-10',
        userButtonTrigger: 'clerk-user-btn',
      }
    }
  });
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

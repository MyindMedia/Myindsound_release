/**
 * Navigation Authentication State
 * Provides auth-aware navigation updates across all pages
 */

import { isSignedIn, mountUserButton, onAuthChange } from './clerk';

/**
 * Initialize navigation with auth state
 * Call this on every page to update nav based on sign-in status
 */
export async function initNavAuth(): Promise<void> {
  try {
    await updateNavigation();

    // Listen for auth changes
    await onAuthChange(() => {
      updateNavigation();
    });
  } catch (error) {
    console.error('Failed to initialize nav auth:', error);
  }
}

/**
 * Update navigation based on current auth state
 */
async function updateNavigation(): Promise<void> {
  const signedIn = await isSignedIn();
  const navLinks = document.querySelector('.nav-links');
  const navUser = document.getElementById('nav-user');

  if (!navLinks) return;

  // Find or create the GET ACCESS / DASHBOARD link
  let authLink = navLinks.querySelector('.nav-link[href="/login"], .nav-link[href="/dashboard"], .nav-link[href="/login.html"], .nav-link[href="/dashboard.html"]') as HTMLAnchorElement;

  if (signedIn) {
    // Update link to DASHBOARD
    if (authLink) {
      authLink.href = '/dashboard';
      authLink.textContent = 'DASHBOARD';
    }

    // Mount user button if container exists
    if (navUser) {
      navUser.innerHTML = ''; // Clear previous content
      await mountUserButton('nav-user');
    }
  } else {
    // Update link to GET ACCESS
    if (authLink) {
      authLink.href = '/login';
      authLink.textContent = 'GET ACCESS';
    }

    // Clear user button
    if (navUser) {
      navUser.innerHTML = '';
    }
  }
}

/**
 * Create cart icon for navigation (used on physical page)
 */
export function createCartIcon(itemCount: number = 0): HTMLElement {
  const cartContainer = document.createElement('div');
  cartContainer.className = 'nav-cart';
  cartContainer.id = 'nav-cart';
  cartContainer.innerHTML = `
    <button class="cart-btn" aria-label="Shopping cart">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="9" cy="21" r="1"></circle>
        <circle cx="20" cy="21" r="1"></circle>
        <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"></path>
      </svg>
      <span class="cart-count" style="display: ${itemCount > 0 ? 'flex' : 'none'};">${itemCount}</span>
    </button>
  `;
  return cartContainer;
}

/**
 * Update cart count in navigation
 */
export function updateCartCount(count: number): void {
  const cartCount = document.querySelector('.cart-count') as HTMLElement;
  if (cartCount) {
    cartCount.textContent = count.toString();
    cartCount.style.display = count > 0 ? 'flex' : 'none';
  }
}

// Auto-initialize on DOM ready if this script is loaded
if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      // Only init if not on login page (login page handles its own auth)
      if (!window.location.pathname.includes('login')) {
        initNavAuth();
      }
    });
  } else {
    if (!window.location.pathname.includes('login')) {
      initNavAuth();
    }
  }
}

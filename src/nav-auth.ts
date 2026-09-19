/**
 * Navigation Authentication State
 * Provides auth-aware navigation updates across all pages
 */

import { isSignedIn, mountUserButton, onAuthChange } from './clerk';
import { api, connectConvexAuth, getConvex, isConvexConfigured } from './convex';

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

  // DASHBOARD and GET ACCESS are the same doorway: only ever show the one that applies. Some pages carry
  // both links, some carry one, and the home page's nav has no `.nav-link` class at all, so go by the path.
  const links = [...navLinks.querySelectorAll('a')] as HTMLAnchorElement[];
  const pathOf = (link: HTMLAnchorElement) => new URL(link.href, window.location.href).pathname.replace(/\.html$/, '');
  const dashboardLink = links.find((link) => pathOf(link) === '/dashboard');
  const loginLink = links.find((link) => pathOf(link) === '/login');

  if (signedIn) {
    // Bought and signed in: the doorway is the dashboard.
    if (dashboardLink) {
      dashboardLink.hidden = false;
      dashboardLink.textContent = 'DASHBOARD';
      if (loginLink) loginLink.hidden = true;
    } else if (loginLink) {
      loginLink.href = '/dashboard';
      loginLink.textContent = 'DASHBOARD';
      loginLink.hidden = false;
    }

    // Add ADMIN link if Convex says this user is an admin (checked server-side)
    if (isConvexConfigured() && (await connectConvexAuth())) {
      const me = await getConvex().query(api.users.me, {});
      const hasAdminLink = navLinks.querySelector('.nav-link[href="/admin"]');
      if (me?.isAdmin && !hasAdminLink) {
        const adminLink = document.createElement('a');
        adminLink.href = '/admin';
        adminLink.className = 'nav-link';
        adminLink.textContent = 'ADMIN';
        navLinks.appendChild(adminLink);
      }
    }

    // Mount user button if container exists
    if (navUser) {
      navUser.innerHTML = ''; // Clear previous content
      await mountUserButton('nav-user');
    }
  } else {
    // Signed out: GET ACCESS, and no dashboard link to bounce them off.
    if (loginLink) {
      loginLink.href = '/login';
      loginLink.textContent = 'GET ACCESS';
      loginLink.hidden = false;
      if (dashboardLink) dashboardLink.hidden = true;
    } else if (dashboardLink) {
      dashboardLink.href = '/login';
      dashboardLink.textContent = 'GET ACCESS';
      dashboardLink.hidden = false;
    }

    // Remove admin link if it exists
    const adminLink = navLinks.querySelector('.nav-link[href="/admin"]');
    if (adminLink) adminLink.remove();

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

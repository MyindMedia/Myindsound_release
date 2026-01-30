/**
 * Login Page Controller
 * Handles Clerk authentication UI and tab switching
 */

import { mountSignIn, mountSignUp, isSignedIn, mountUserButton, isClerkConfigured, getClerkError } from './clerk';

class LoginController {
  private currentTab: 'signin' | 'signup' = 'signin';

  constructor() {
    this.init();
  }

  private async init() {
    const loading = document.getElementById('auth-loading');

    // Check if Clerk is configured
    if (!isClerkConfigured()) {
      if (loading) {
        loading.innerHTML = `
          <p style="color: #ff4444; font-weight: bold;">Authentication Not Configured</p>
          <p style="margin-top: 1rem; color: #888;">VITE_CLERK_PUBLISHABLE_KEY is missing.</p>
          <p style="margin-top: 0.5rem; color: #888; font-size: 0.9rem;">Add it to Netlify environment variables and redeploy.</p>
          <a href="/" class="secondary-btn" style="margin-top: 2rem; display: inline-block;">Back to Home</a>
        `;
      }
      return;
    }

    try {
      // Check if user is already signed in
      const signedIn = await isSignedIn();
      if (signedIn) {
        // Get redirect URL from query params or default to dashboard
        const params = new URLSearchParams(window.location.search);
        const redirect = params.get('redirect') || '/dashboard';
        window.location.href = redirect;
        return;
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      // Continue to show login form even if initial check fails
    }

    // Check URL hash for initial tab
    if (window.location.hash === '#sign-up') {
      this.currentTab = 'signup';
    }

    // Setup tab switching
    this.setupTabs();

    // Mount Clerk components
    await this.mountAuthComponents();

    // Hide loading state
    if (loading) {
      loading.style.display = 'none';
    }

    // Setup nav auth state
    await this.setupNavAuth();
  }

  private setupTabs() {
    const signinTab = document.getElementById('tab-signin');
    const signupTab = document.getElementById('tab-signup');
    const signinMount = document.getElementById('clerk-signin');
    const signupMount = document.getElementById('clerk-signup');

    if (!signinTab || !signupTab || !signinMount || !signupMount) return;

    // Set initial state based on currentTab
    if (this.currentTab === 'signup') {
      signinTab.classList.remove('active');
      signupTab.classList.add('active');
      signinMount.style.display = 'none';
      signupMount.style.display = 'block';
    }

    signinTab.addEventListener('click', () => {
      if (this.currentTab === 'signin') return;
      this.currentTab = 'signin';

      signinTab.classList.add('active');
      signupTab.classList.remove('active');
      signinMount.style.display = 'block';
      signupMount.style.display = 'none';
      window.location.hash = '';
    });

    signupTab.addEventListener('click', () => {
      if (this.currentTab === 'signup') return;
      this.currentTab = 'signup';

      signupTab.classList.add('active');
      signinTab.classList.remove('active');
      signupMount.style.display = 'block';
      signinMount.style.display = 'none';
      window.location.hash = 'sign-up';
    });
  }

  private async mountAuthComponents() {
    const params = new URLSearchParams(window.location.search);
    const redirect = params.get('redirect') || '/dashboard.html';

    try {
      // Mount Sign-In
      await mountSignIn('clerk-signin', {
        redirectUrl: redirect,
        signUpUrl: '/login#sign-up'
      });

      // Mount Sign-Up
      await mountSignUp('clerk-signup', {
        redirectUrl: redirect,
        signInUrl: '/login'
      });
    } catch (error: any) {
      console.error('Failed to mount auth components:', error);
      const loading = document.getElementById('auth-loading');
      const clerkError = getClerkError();
      const errorMessage = clerkError?.message || error?.message || 'Unknown error';

      if (loading) {
        loading.innerHTML = `
          <p style="color: #ff4444; font-weight: bold;">Failed to Load Authentication</p>
          <p style="margin-top: 1rem; color: #888;">${errorMessage}</p>
          <p style="margin-top: 1rem; color: #666; font-size: 0.85rem;">
            Make sure VITE_CLERK_PUBLISHABLE_KEY is set in Netlify<br/>
            and the domain is allowed in your Clerk Dashboard.
          </p>
          <a href="/" class="secondary-btn" style="margin-top: 2rem; display: inline-block;">Back to Home</a>
        `;
        loading.style.display = 'flex';
      }
    }
  }

  private async setupNavAuth() {
    const signedIn = await isSignedIn();
    const navUser = document.getElementById('nav-user');

    if (signedIn && navUser) {
      await mountUserButton('nav-user');
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new LoginController();
  });
} else {
  new LoginController();
}

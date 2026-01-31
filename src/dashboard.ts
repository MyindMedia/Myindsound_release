/**
 * Dashboard Controller
 * Handles user dashboard: downloads, orders, and account management
 */

import { getClerk, isSignedIn, getUserId, getUserName, getUserEmail, signOut, mountUserButton, isClerkConfigured } from './clerk';
import { getUserPurchases, getUserOrders, isSupabaseConfigured, getSupabaseConfigError } from './supabase';
import type { Product, PhysicalOrder } from './supabase';

class DashboardController {
  constructor() {
    this.init();
  }

  private async init() {
    try {
      // Check if services are configured
      if (!isClerkConfigured()) {
        this.showError('Authentication not configured. Add VITE_CLERK_PUBLISHABLE_KEY to Netlify environment variables.');
        return;
      }

      if (!isSupabaseConfigured()) {
        const error = getSupabaseConfigError();
        this.showError(`Database not configured. ${error || 'Add VITE_SUPABASE_ANON_KEY to Netlify environment variables.'}`);
        return;
      }

      // Check authentication
      const signedIn = await isSignedIn();

      if (!signedIn) {
        this.showSignInRequired();
        return;
      }

      // Load user data
      const userId = await getUserId();
      const userName = await getUserName();
      const userEmail = await getUserEmail();

      if (!userId) {
        this.showSignInRequired();
        return;
      }

      // Update UI with user info
      this.updateUserInfo(userName, userEmail, userId);

      // Fetch and render data
      await Promise.all([
        this.loadDownloads(userId),
        this.loadOrders(userId),
      ]);

      // Setup account actions
      this.setupAccountActions();

      // Setup navigation
      await this.setupNavAuth();

      // Show content
      this.showContent();
    } catch (error: any) {
      console.error('Dashboard initialization error:', error);
      this.showError(error?.message || 'Failed to load dashboard. Please try again.');
    }
  }

  private showError(message: string) {
    const loading = document.getElementById('dashboard-loading');
    const content = document.getElementById('dashboard-content');
    const signin = document.getElementById('dashboard-signin');

    if (loading) {
      loading.innerHTML = `
        <p style="color: #ff4444; font-weight: bold;">Dashboard Error</p>
        <p style="margin-top: 1rem; color: #888;">${message}</p>
        <a href="/" class="secondary-btn" style="margin-top: 2rem; display: inline-block;">Back to Home</a>
      `;
    }
    if (content) content.style.display = 'none';
    if (signin) signin.style.display = 'none';
  }

  private showSignInRequired() {
    const loading = document.getElementById('dashboard-loading');
    const content = document.getElementById('dashboard-content');
    const signin = document.getElementById('dashboard-signin');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'none';
    if (signin) signin.style.display = 'flex';
  }

  private showContent() {
    const loading = document.getElementById('dashboard-loading');
    const content = document.getElementById('dashboard-content');
    const signin = document.getElementById('dashboard-signin');

    if (loading) loading.style.display = 'none';
    if (content) content.style.display = 'block';
    if (signin) signin.style.display = 'none';
  }

  private updateUserInfo(name: string | null, email: string | null, id: string | null) {
    const nameEl = document.getElementById('user-name');
    const emailEl = document.getElementById('account-email');
    const avatarEl = document.getElementById('account-avatar');
    const memberSinceEl = document.getElementById('member-since');
    const idEl = document.getElementById('clerk-id-display');
    const copyIdBtn = document.getElementById('copy-clerk-id');

    if (nameEl) {
      nameEl.textContent = name || 'User';
    }

    if (emailEl) {
      emailEl.textContent = email || '';
    }

    if (idEl) {
      idEl.textContent = id || 'N/A';
    }

    if (copyIdBtn && id) {
      copyIdBtn.addEventListener('click', () => {
        navigator.clipboard.writeText(id).then(() => {
          const originalText = copyIdBtn.innerHTML;
          copyIdBtn.innerHTML = 'ID COPIED!';
          setTimeout(() => {
            copyIdBtn.innerHTML = originalText;
          }, 2000);
        });
      });
    }

    if (avatarEl && name) {
      avatarEl.textContent = name.charAt(0).toUpperCase();
    }

    if (memberSinceEl) {
      memberSinceEl.textContent = new Date().getFullYear().toString();
    }
  }

  private async loadDownloads(userId: string) {
    const container = document.getElementById('downloads-container');
    const empty = document.getElementById('downloads-empty');

    if (!container || !empty) return;

    try {
      const products = await getUserPurchases(userId);

      if (products.length === 0) {
        container.style.display = 'none';
        empty.style.display = 'block';
        return;
      }

      container.innerHTML = products.map(product => this.renderDownloadCard(product)).join('');
      container.style.display = 'grid';
      empty.style.display = 'none';

      // Setup download handlers
      container.querySelectorAll('.download-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
          const url = (e.target as HTMLElement).dataset.url;
          const name = (e.target as HTMLElement).dataset.name;
          if (url) {
            this.downloadFile(url, name || 'download');
          }
        });
      });
    } catch (error) {
      console.error('Error loading downloads:', error);
      container.style.display = 'none';
      empty.style.display = 'block';
    }
  }

  private renderDownloadCard(product: Product): string {
    const coverUrl = product.cover_url || 'https://images.unsplash.com/photo-1614613535308-eb5fbd3d2c17?auto=format&fit=crop&q=80&w=400';

    return `
      <div class="download-card">
        <img src="${coverUrl}" alt="${product.name}" loading="lazy" />
        <div class="download-card-info">
          <h4 class="download-card-title">${product.name}</h4>
          <p class="download-card-desc">${product.description || 'Digital Release'}</p>
          <button class="download-btn" data-url="${product.audio_url}" data-name="${product.name}">
            DOWNLOAD
          </button>
        </div>
      </div>
    `;
  }

  private downloadFile(url: string, name: string) {
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    link.target = '_blank';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  private async loadOrders(userId: string) {
    const container = document.getElementById('orders-container');
    const empty = document.getElementById('orders-empty');

    if (!container || !empty) return;

    try {
      const orders = await getUserOrders(userId);

      if (orders.length === 0) {
        container.style.display = 'none';
        empty.style.display = 'block';
        return;
      }

      container.innerHTML = orders.map(order => this.renderOrderCard(order)).join('');
      container.style.display = 'flex';
      empty.style.display = 'none';
    } catch (error) {
      console.error('Error loading orders:', error);
      container.style.display = 'none';
      empty.style.display = 'block';
    }
  }

  private renderOrderCard(order: PhysicalOrder): string {
    const date = new Date(order.created_at).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });

    const itemCount = order.order_items?.length || 0;
    const itemText = itemCount === 1 ? '1 item' : `${itemCount} items`;
    const total = (order.total_amount / 100).toFixed(2);

    return `
      <div class="order-card">
        <div class="order-info">
          <h4>Order #${order.id.slice(0, 8).toUpperCase()}</h4>
          <p>${date} · ${itemText} · $${total}</p>
          ${order.tracking_number ? `<p>Tracking: ${order.tracking_number}</p>` : ''}
        </div>
        <span class="order-status ${order.order_status}">${order.order_status}</span>
      </div>
    `;
  }

  private setupAccountActions() {
    const manageBtn = document.getElementById('manage-account-btn');
    const signOutBtn = document.getElementById('sign-out-btn');

    if (manageBtn) {
      manageBtn.addEventListener('click', async () => {
        const clerk = await getClerk();
        clerk.openUserProfile();
      });
    }

    if (signOutBtn) {
      signOutBtn.addEventListener('click', async () => {
        await signOut();
      });
    }
  }

  private async setupNavAuth() {
    const navUser = document.getElementById('nav-user');
    if (navUser) {
      await mountUserButton('nav-user');
    }
  }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    new DashboardController();
  });
} else {
  new DashboardController();
}

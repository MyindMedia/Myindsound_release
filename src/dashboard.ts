/**
 * Dashboard Controller
 * Handles user dashboard: downloads, orders, and account management
 */

import { getClerk, isSignedIn, getUserId, getUserName, getUserEmail, signOut, mountUserButton, isClerkConfigured } from './clerk';
import { saveFromUrl } from './download';
import { initAnalytics, identifyUser, track } from './analytics';
import type { FunctionReturnType } from 'convex/server';
import { api, connectConvexAuth, convexErrorMessage, getConvex, isConvexConfigured } from './convex';

type OwnedProduct = FunctionReturnType<typeof api.products.owned>[number];
type Order = FunctionReturnType<typeof api.orders.mine>[number];

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

const COVER_FOR: Record<string, string> = {
  lit: '/assets/images/lit-poster.png',
  'the-source': '/assets/images/thesource-poster.png',
};

class DashboardController {
  constructor() {
    this.init();
  }

  private async init() {
    initAnalytics();
    try {
      // Check if services are configured
      if (!isClerkConfigured()) {
        this.showError('Authentication not configured. Add VITE_CLERK_PUBLISHABLE_KEY to Netlify environment variables.');
        return;
      }

      if (!isConvexConfigured()) {
        this.showError('Database not configured. VITE_CONVEX_URL is missing from the build.');
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

      // Identify user in PostHog
      identifyUser(userId, { email: userEmail || undefined, name: userName || undefined });
      track('dashboard_viewed');

      // Update UI with user info
      this.updateUserInfo(userName, userEmail, userId);

      if (!(await connectConvexAuth())) {
        this.showError('We could not connect your account. Refresh the page and try again.');
        return;
      }

      // Fetch and render data
      await Promise.all([
        this.loadDownloads(),
        this.loadOrders(),
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

  private async loadDownloads() {
    const container = document.getElementById('downloads-container');
    const empty = document.getElementById('downloads-empty');

    if (!container || !empty) return;

    try {
      const products = await getConvex().query(api.products.owned, {});

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
        btn.addEventListener('click', async (e) => {
          const btnEl = e.currentTarget as HTMLButtonElement;
          const slug = btnEl.dataset.slug;
          const name = btnEl.dataset.name;

          if (slug) {
            track('download_initiated', { product_id: slug, product_name: name });
            await this.downloadFile(slug, name || 'download');
          }
        });
      });
    } catch (error) {
      console.error('Error loading downloads:', error);
      container.style.display = 'none';
      empty.style.display = 'block';
    }
  }

  private renderDownloadCard(product: OwnedProduct): string {
    const coverUrl = product.coverUrl || COVER_FOR[product.slug] || '/assets/images/lit-poster.png';
    const name = escapeHtml(product.name);
    const action = product.hasDownload
      ? `<button class="download-btn" data-slug="${escapeHtml(product.slug)}" data-name="${name}">DOWNLOAD</button>`
      : `<a class="download-btn" href="/">STREAM</a>`;

    return `
      <div class="download-card">
        <img src="${escapeHtml(coverUrl)}" alt="${name}" loading="lazy" />
        <div class="download-card-info">
          <h4 class="download-card-title">${name}</h4>
          <p class="download-card-desc">Digital Release</p>
          ${action}
        </div>
      </div>
    `;
  }

  private async downloadFile(slug: string, name: string) {
    const btn = document.querySelector(`.download-btn[data-slug="${slug}"]`) as HTMLButtonElement;
    const originalText = btn?.textContent;

    try {
      if (btn) {
        btn.textContent = 'PREPARING...';
        btn.disabled = true;
      }

      const { url } = await getConvex().action(api.downloads.mine, { product: slug });
      if (btn) btn.textContent = 'DOWNLOADING...';
      await saveFromUrl(url, `${name}.zip`);
    } catch (error) {
      console.error('Download error:', error);
      alert(convexErrorMessage(error, 'Failed to prepare download. Please try again.'));
    } finally {
      if (btn) {
        btn.textContent = originalText || 'DOWNLOAD';
        btn.disabled = false;
      }
    }
  }

  private async loadOrders() {
    const container = document.getElementById('orders-container');
    const empty = document.getElementById('orders-empty');

    if (!container || !empty) return;

    try {
      const orders = await getConvex().query(api.orders.mine, {});

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

  private renderOrderCard(order: Order): string {
    const date = new Date(order.createdAt).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric'
    });

    const itemText = order.itemCount === 1 ? '1 item' : `${order.itemCount} items`;
    const total = (order.totalCents / 100).toFixed(2);

    return `
      <div class="order-card">
        <div class="order-info">
          <h4>Order #${escapeHtml(order.id.slice(-8).toUpperCase())}</h4>
          <p>${date} · ${itemText} · $${total}</p>
        </div>
        <span class="order-status ${escapeHtml(order.status)}">${escapeHtml(order.status)}</span>
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

    this.setupPrivacyActions(signOutBtn?.parentElement ?? null);
  }

  /** GDPR: export and delete personal data (Convex cascades the delete to Clerk and the CRM). */
  private setupPrivacyActions(host: HTMLElement | null) {
    if (!host || host.querySelector('#export-data-btn')) return;

    const exportBtn = document.createElement('button');
    exportBtn.id = 'export-data-btn';
    exportBtn.className = 'text-btn';
    exportBtn.textContent = 'DOWNLOAD MY DATA';
    exportBtn.addEventListener('click', async () => {
      try {
        const data = await getConvex().query(api.privacy.exportMyData, {});
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'myind-sound-my-data.json';
        link.click();
        URL.revokeObjectURL(link.href);
      } catch (error) {
        alert(convexErrorMessage(error, 'Could not export your data. Please try again.'));
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.id = 'delete-account-btn';
    deleteBtn.className = 'text-btn';
    deleteBtn.style.color = '#ff6b6b';
    deleteBtn.textContent = 'DELETE ACCOUNT';
    deleteBtn.addEventListener('click', async () => {
      const typed = window.prompt(
        'This permanently deletes your account, purchases, play history and marketing record. Payment receipts stay with Stripe for tax records.\n\nType DELETE to confirm.',
      );
      if (typed !== 'DELETE') return;
      try {
        deleteBtn.disabled = true;
        deleteBtn.textContent = 'DELETING...';
        await getConvex().action(api.privacy.deleteMyData, { confirm: 'DELETE' });
        await signOut();
      } catch (error) {
        deleteBtn.disabled = false;
        deleteBtn.textContent = 'DELETE ACCOUNT';
        alert(convexErrorMessage(error, 'Could not delete your account. Please contact info@myindsound.com.'));
      }
    });

    host.append(exportBtn, deleteBtn);
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

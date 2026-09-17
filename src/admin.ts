/**
 * Admin dashboard: play and purchase stats from Convex. Access is enforced server-side
 * (users.isAdmin or ADMIN_EMAILS); the page only reflects the answer.
 */
import { getClerk, isClerkConfigured } from './clerk';
import { api, connectConvexAuth, convexErrorCode, getConvex } from './convex';

const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);

function show(id: string, display: string) {
  const element = document.getElementById(id);
  if (element) element.style.display = display;
}

async function loadStats() {
  try {
    const stats = await getConvex().query(api.admin.stats, {});
    show('admin-content', 'block');
    show('unauthorized', 'none');

    document.getElementById('total-plays')!.textContent = String(stats.totals.plays);
    document.getElementById('total-users')!.textContent = String(stats.totals.users);
    document.getElementById('total-purchases')!.textContent = String(stats.totals.purchases);

    document.querySelector('#recent-plays-table tbody')!.innerHTML = stats.recentPlays
      .map(
        (play) => `
          <tr>
            <td>${escapeHtml(play.track)}</td>
            <td>${escapeHtml(play.listener)}</td>
            <td>${new Date(play.playedAt).toLocaleString()}</td>
          </tr>`,
      )
      .join('');

    document.querySelector('#recent-purchases-table tbody')!.innerHTML = stats.recentPurchases
      .map(
        (purchase) => `
          <tr>
            <td>${escapeHtml(purchase.product)}</td>
            <td>${escapeHtml(purchase.buyer)}</td>
            <td>${new Date(purchase.grantedAt).toLocaleDateString()}</td>
          </tr>`,
      )
      .join('');
  } catch (error) {
    if (convexErrorCode(error) === 'FORBIDDEN') {
      show('admin-content', 'none');
      show('unauthorized', 'flex');
      return;
    }
    console.error('Admin stats failed:', error);
  }
}

async function init() {
  show('unauthorized', 'none');
  document.getElementById('refresh-stats')?.addEventListener('click', () => void loadStats());
  if (!isClerkConfigured()) return;
  const clerk = await getClerk();
  if (!clerk.user) {
    window.location.href = '/login?redirect=/admin';
    return;
  }
  if (!(await connectConvexAuth())) {
    show('unauthorized', 'flex');
    return;
  }
  await loadStats();
}

void init();

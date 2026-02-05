import './style.css';
import { UnicornSceneManager } from './unicorn-scene';
import { CheckoutFlow } from './checkout';
import { initNavAuth } from './nav-auth';
import { initLitHover } from './lit-hover';

const tracks = [
  { id: 1, title: 'L.I.T. (Living In Truth)' },
  { id: 2, title: 'G. O. D.' },
  { id: 3, title: 'Victory In the Valley' },
  { id: 4, title: 'Tired' },
  { id: 5, title: 'Let Him Cook' },
  { id: 6, title: 'Faith' }
];

const checkoutFlow = new CheckoutFlow();

function renderTracklist(unlocked: boolean = false) {
  const tracklistContainer = document.getElementById('tracklist');
  if (!tracklistContainer) return;

  if (unlocked) {
    tracklistContainer.classList.add('unlocked');
  }

  tracklistContainer.innerHTML = tracks.map(track => {
    let icon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>`;

    if (unlocked) {
      // Play button icon
      icon = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;
    }

    return `
    <div class="track-item">
      <div class="track-info">
        <span class="track-number">${track.id.toString().padStart(2, '0')}</span>
        <span class="track-name">${track.title}</span>
      </div>
      <div class="track-status ${unlocked ? 'unlocked' : ''}">
        ${icon}
      </div>
    </div>
  `}).join('');
}

function initStickers() {
  // LIT Album Art Hover Effect is now handled by lit-hover.ts
  initLitHover();


}

function initPurchaseFlow() {
  const checkoutBtn = document.getElementById('checkout-btn');
  const amountInput = document.getElementById('pwyw-amount') as HTMLInputElement;

  checkoutBtn?.addEventListener('click', () => {
    const amount = parseFloat(amountInput.value);
    if (isNaN(amount) || amount < 1) {
      alert('Please enter a minimum amount of $1.00');
      return;
    }
    checkoutFlow.start(amount);
  });
}

import { PurchaseAnimationController } from './purchase-animation';

document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const success = urlParams.get('success');

  if (success === 'true') {
    // Clean URL
    window.history.replaceState({}, '', window.location.pathname);

    // Start Animation Mode
    document.body.classList.add('animation-active'); // Hide dashboard elements
    document.body.classList.add('dashboard-mode'); // Hide purchase UI immediately

    // Pre-load Dashboard Elements but Keep Transparent/Hidden
    const tracklist = document.querySelector('.tracklist-side') as HTMLElement;
    const controls = document.querySelector('.player-controls') as HTMLElement;

    // Ensure they are present in DOM (via dashboard-mode css) but opacity 0 for animation entrance
    if (tracklist) tracklist.style.opacity = '0';
    if (controls) {
      controls.style.display = 'block';
      controls.style.opacity = '0';
      controls.classList.remove('dashboard-hidden');
    }

    // Ensure tracklist is rendered
    renderTracklist(true);

    const anim = new PurchaseAnimationController();

    // Slight delay to ensure DOM is ready and styles applied
    setTimeout(() => {
      anim.start();
    }, 100);

  } else {
    renderTracklist(false);
  }

  initStickers();
  initPurchaseFlow();
  initNavAuth();
  UnicornSceneManager.init('unicorn-background');

});

function revealDashboard() {
  const tracklistSide = document.querySelector('.tracklist-side') as HTMLElement;
  const playerControls = document.querySelector('.player-controls') as HTMLElement;

  // Hide the peel overlay on the dashboard
  const stickerContainer = document.getElementById('lit-sticker-container');
  if (stickerContainer) stickerContainer.style.display = 'none';

  if (tracklistSide) {
    tracklistSide.classList.add('slide-in-right');
    // Remove inline opacity so animation takes over (though animation priority usually handles it)
    // But safely we can leave it if animation overrides, but we MUST ensure it's 1 at the end.
    // Let's clear it now to be safe, relying on the class to set start opacity 0.
    tracklistSide.style.opacity = '';
  }

  // Controls slide in from bottom
  setTimeout(() => {
    if (playerControls) {
      playerControls.classList.add('slide-in-bottom');
      playerControls.style.opacity = '';
    }
  }, 200);

  document.body.classList.remove('animation-active');

  // Clean up classes after animation
  setTimeout(() => {
    if (tracklistSide) {
      tracklistSide.classList.remove('slide-in-right');
      tracklistSide.style.opacity = '1';
    }
    if (playerControls) {
      playerControls.classList.remove('slide-in-bottom');
      playerControls.style.opacity = '1';
    }
  }, 1500);
}

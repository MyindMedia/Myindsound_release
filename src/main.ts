import './style.css';
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

  console.log('Stickers initialized (LIT handled separately)');
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

    // Start Animation
    const anim = new PurchaseAnimationController(() => {
      renderTracklist(true); // Render unlocked
    });
    anim.start();
  } else {
    renderTracklist(false);
  }

  initStickers();
  initPurchaseFlow();
  initNavAuth();
  console.log('Myind Sound Release Site Initialized');
});

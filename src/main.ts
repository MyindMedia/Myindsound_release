import './style.css';
import { StickerPeel } from './sticker-peel';
import { CheckoutFlow } from './checkout';

const tracks = [
  { id: 1, title: 'L.I.T. (Living In Truth)' },
  { id: 2, title: 'G. O. D.' },
  { id: 3, title: 'Victory In the Valley' },
  { id: 4, title: 'Tired' },
  { id: 5, title: 'Let Him Cook' },
  { id: 6, title: 'Faith' }
];

const checkoutFlow = new CheckoutFlow();

function renderTracklist() {
  const tracklistContainer = document.getElementById('tracklist');
  if (!tracklistContainer) return;

  tracklistContainer.innerHTML = tracks.map(track => `
    <div class="track-item">
      <div class="track-info">
        <span class="track-number">${track.id.toString().padStart(2, '0')}</span>
        <span class="track-name">${track.title}</span>
      </div>
      <div class="track-status">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path></svg>
      </div>
    </div>
  `).join('');
}

function initStickers() {
  const cards = document.querySelectorAll('.coming-soon-card');

  cards.forEach(card => {
    const stickerContainer = card.querySelector('.sticker-container') as HTMLElement;

    if (stickerContainer) {
      new StickerPeel({
        imageSrc: '/assets/images/peeloverlay.png',
        container: stickerContainer,
        peelDirection: 269,
        peelBackHoverPct: 20,
        peelBackActivePct: 70,
        lightingIntensity: 0.09,
        shadowIntensity: 0.05
      });
    }

    // Hover Video Playback
    const video = card.querySelector('video') as HTMLVideoElement;
    if (video) {
      card.addEventListener('mouseenter', () => {
        video.play().catch(() => { });
      });
      card.addEventListener('mouseleave', () => {
        video.pause();
        video.currentTime = 0;
      });
    }
  });
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

document.addEventListener('DOMContentLoaded', () => {
  renderTracklist();
  initStickers();
  initPurchaseFlow();
  console.log('Myind Sound Release Site Initialized');
});

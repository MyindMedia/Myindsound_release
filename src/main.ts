import './style.css';
import { StickerPeel } from './sticker-peel';
import { CheckoutFlow } from './checkout';

const tracks = [
  { id: 1, title: 'LIT (Intro)', duration: '1:45' },
  { id: 2, title: 'Higher Ground', duration: '3:12' },
  { id: 3, title: 'Peace & Power', duration: '2:56' },
  { id: 4, title: 'The Source', duration: '4:20' }
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
      <span class="track-duration">${track.duration}</span>
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

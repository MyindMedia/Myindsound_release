/**
 * Coming Soon Animation Script
 * Based on Pray project's animations.js
 */

console.log('coming-soon.js: File loaded');

class ComingSoonController {
    constructor() {
        this.init();
    }

    init() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => this.setupCards());
        } else {
            this.setupCards();
        }
    }

    setupCards() {
        console.log('setupCards: Starting...');
        const cards = document.querySelectorAll('.coming-soon-card');
        console.log(`Found ${cards.length} coming soon cards`);

        cards.forEach((card, index) => {
            console.log(`Processing card ${index}`);
            const video = card.querySelector('.card-video');
            const posterLayer = card.querySelector('.poster-layer');
            const posterSrc = card.getAttribute('data-poster');
            const posterGroup = card.querySelector('.poster-group');
            const cardMedia = card.querySelector('.card-media');

            // Set poster background image
            if (posterLayer && posterSrc) {
                const testImg = new Image();
                testImg.onload = () => {
                    posterLayer.style.backgroundImage = `url('${posterSrc}')`;
                    posterLayer.style.backgroundSize = '100% 100%';
                    posterLayer.style.backgroundPosition = 'center';
                    posterLayer.style.backgroundRepeat = 'no-repeat';
                    posterLayer.style.opacity = '1';
                    posterLayer.style.display = 'block';
                };
                testImg.onerror = () => {
                    console.error(`Failed to load poster: ${posterSrc}`);
                };
                testImg.src = posterSrc;
            }

            // Create sticker peel overlay
            if (posterGroup && cardMedia && posterLayer && video) {
                console.log(`Creating overlay for card ${index}`);

                const overlayContainer = document.createElement('div');
                overlayContainer.className = 'peel-overlay-container';
                card.appendChild(overlayContainer);
                overlayContainer.style.background = 'transparent';

                requestAnimationFrame(() => {
                    console.log(`Setting up dimensions for card ${index}`);

                    const cardRect = card.getBoundingClientRect();
                    const mediaRect = cardMedia.getBoundingClientRect();
                    const targetWidth = mediaRect.width;
                    const targetHeight = mediaRect.height;
                    const hoverRevealPx = 4;
                    const hoverPct = Math.max(0.5, Math.min(25, (hoverRevealPx / targetHeight) * 100));
                    const hoverPctReduced = hoverPct * 0.3;

                    // Ensure base container is positioned for absolute children
                    cardMedia.style.position = 'relative';
                    cardMedia.style.willChange = 'transform';

                    // Force poster-layer and poster-group to match card-media dimensions exactly
                    posterLayer.style.width = targetWidth + 'px';
                    posterLayer.style.height = targetHeight + 'px';
                    posterLayer.style.position = 'absolute';
                    posterLayer.style.inset = '0';
                    posterGroup.style.width = targetWidth + 'px';
                    posterGroup.style.height = targetHeight + 'px';
                    posterGroup.style.position = 'absolute';
                    posterGroup.style.inset = '0';

                    const overlapPx = 0;
                    overlayContainer.style.width = (targetWidth + overlapPx * 2) + 'px';
                    overlayContainer.style.height = (targetHeight + overlapPx * 2) + 'px';
                    overlayContainer.style.position = 'absolute';
                    overlayContainer.style.left = (mediaRect.left - cardRect.left - overlapPx) + 'px';
                    overlayContainer.style.top = (mediaRect.top - cardRect.top - overlapPx) + 'px';
                    overlayContainer.style.zIndex = '1000';
                    overlayContainer.style.pointerEvents = 'none';
                    overlayContainer.style.willChange = 'transform';
                    overlayContainer.style.transform = 'none';
                    overlayContainer.style.overflow = 'visible';
                    overlayContainer.style.transformStyle = 'preserve-3d';

                    video.style.position = 'absolute';
                    video.style.inset = '0';
                    video.style.width = '100%';
                    video.style.height = '100%';
                    video.style.objectFit = 'cover';
                    video.style.opacity = '0';
                    video.style.transition = 'none';
                    video.style.transform = 'none';
                    video.style.backgroundColor = 'transparent';
                    video.style.boxShadow = 'none';
                    video.style.zIndex = '1';

                    posterGroup.style.zIndex = '1001';

                    // Create StickerPeel instance
                    const stickerPeel = new StickerPeel({
                        container: overlayContainer,
                        imageSrc: '/assets/images/peeloverlay.png',
                        width: Math.round(targetWidth),
                        rotate: 0,
                        peelBackHoverPct: hoverPctReduced,
                        peelBackActivePct: 70,
                        peelDirection: 269,
                        shadowIntensity: 0.05,
                        lightingIntensity: 0.09,
                        initialPosition: 'center',
                        className: 'coming-soon-sticker'
                    });

                    card._stickerPeel = stickerPeel;
                    card._overlayContainer = overlayContainer;
                    console.log(`Overlay created for card ${index}`);
                });
            }

            // Hover handlers for video playback
            if (video) {
                video.muted = true;
                video.playsInline = true;
                video.loop = true;
                const mediaEl = card.querySelector('.card-media') || card;
                mediaEl.addEventListener('mouseenter', () => {
                    const playPromise = video.play();
                    if (playPromise !== undefined) {
                        playPromise.catch(() => { });
                    }
                });
                mediaEl.addEventListener('mouseleave', () => {
                    try {
                        video.pause();
                    } catch (e) { }
                });
            }
        });
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    window.comingSoonController = new ComingSoonController();
});

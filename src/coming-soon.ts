/**
 * Coming Soon Cards Controller
 * Matches Pray project implementation exactly
 */

import { StickerPeel } from './sticker-peel';

declare global {
    interface HTMLElement {
        _stickerPeel?: any;
        _overlayContainer?: HTMLElement;
        _overlayResizeObserver?: ResizeObserver;
    }
}

class ComingSoonController {
    constructor() {
        this.init();
    }

    private init() {
        console.log('Initializing Coming Soon cards');
        const cards = document.querySelectorAll('.coming-soon-card');
        console.log(`Found ${cards.length} coming soon cards`);

        cards.forEach((card, index) => {
            this.setupCard(card as HTMLElement, index);
        });
    }

    private setupCard(card: HTMLElement, index: number) {
        const posterGroup = card.querySelector('.poster-group') as HTMLElement;
        const cardMedia = card.querySelector('.card-media') as HTMLElement;
        const posterLayer = card.querySelector('.poster-layer') as HTMLElement;
        const video = card.querySelector('.card-video') as HTMLVideoElement;
        const plasticTop = card.querySelector('.plastic-top') as HTMLElement;
        const plasticBottom = card.querySelector('.plastic-bottom') as HTMLElement;

        // Set poster image
        const posterSrc = card.getAttribute('data-poster');
        if (posterSrc && posterLayer) {
            posterLayer.style.backgroundImage = `url('${posterSrc}')`;
            posterLayer.style.backgroundSize = 'cover';
            posterLayer.style.backgroundPosition = 'center';
            posterLayer.style.backgroundRepeat = 'no-repeat';
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

                // Get peel configuration from data attributes
                const hoverPct = parseFloat(posterGroup.getAttribute('data-peel-hover') || '20');
                const activePct = parseFloat(posterGroup.getAttribute('data-peel-active') || '70');
                const peelDirection = parseFloat(posterGroup.getAttribute('data-peel-direction') || '269');
                const lighting = parseFloat(posterGroup.getAttribute('data-lighting') || '0.09');
                const shadow = parseFloat(posterGroup.getAttribute('data-shadow') || '0.05');
                const rotate = parseFloat(posterGroup.getAttribute('data-rotate') || '0');

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

                // Match Pray project's overlay positioning
                const overlapPx = 1;
                overlayContainer.style.width = (targetWidth + overlapPx * 2) + 'px';
                overlayContainer.style.height = (targetHeight + overlapPx * 2) + 'px';
                overlayContainer.style.position = 'absolute';
                overlayContainer.style.left = (Math.round(mediaRect.left - cardRect.left - 2 - overlapPx) + 1.5) + 'px';
                overlayContainer.style.top = (mediaRect.top - cardRect.top - 26.4 - overlapPx) + 'px';
                overlayContainer.style.zIndex = '1000';
                overlayContainer.style.pointerEvents = 'none';
                overlayContainer.style.willChange = 'transform';
                overlayContainer.style.transform = 'none';
                overlayContainer.style.overflow = 'visible';
                overlayContainer.style.transformStyle = 'preserve-3d';

                // Style plastic layers
                if (plasticTop) {
                    plasticTop.style.width = targetWidth + 'px';
                    plasticTop.style.height = targetHeight + 'px';
                    plasticTop.style.position = 'absolute';
                    plasticTop.style.inset = '0';
                }
                if (plasticBottom) {
                    plasticBottom.style.width = targetWidth + 'px';
                    plasticBottom.style.height = targetHeight + 'px';
                    plasticBottom.style.position = 'absolute';
                    plasticBottom.style.inset = '0';
                }

                // Style video
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

                // Set z-index layers
                if (plasticTop) plasticTop.style.zIndex = '2';
                if (plasticBottom) plasticBottom.style.zIndex = '2';
                posterGroup.style.zIndex = '1001';

                // Create StickerPeel instance with exact dimensions
                const stickerPeel = new StickerPeel({
                    container: overlayContainer,
                    imageSrc: '/assets/images/peeloverlay.png',
                    width: Math.round(targetWidth * 0.9),
                    rotate: rotate,
                    peelBackHoverPct: hoverPct,
                    peelBackActivePct: activePct,
                    peelDirection: peelDirection,
                    shadowIntensity: shadow,
                    lightingIntensity: lighting,
                    className: 'coming-soon-sticker'
                });

                card._stickerPeel = stickerPeel;
                card._overlayContainer = overlayContainer;
                console.log(`Overlay created for card ${index}`);

                // Update layout on resize
                const updateLayout = () => {
                    const cr = card.getBoundingClientRect();
                    const mr = cardMedia.getBoundingClientRect();
                    const w = mr.width;
                    const h = mr.height;
                    posterLayer.style.width = w + 'px';
                    posterLayer.style.height = h + 'px';
                    posterGroup.style.width = w + 'px';
                    posterGroup.style.height = h + 'px';
                    overlayContainer.style.width = (w + overlapPx * 2) + 'px';
                    overlayContainer.style.height = (h + overlapPx * 2) + 'px';
                    overlayContainer.style.left = (Math.round(mr.left - cr.left - 2 - overlapPx) + 1.5) + 'px';
                    overlayContainer.style.top = (mr.top - cr.top - 26.4 - overlapPx) + 'px';
                    if (plasticTop) {
                        plasticTop.style.width = w + 'px';
                        plasticTop.style.height = w + 'px';
                    }
                    if (plasticBottom) {
                        plasticBottom.style.width = w + 'px';
                        plasticBottom.style.height = h + 'px';
                    }
                };

                if ('ResizeObserver' in window) {
                    const ro = new ResizeObserver(() => updateLayout());
                    ro.observe(cardMedia);
                    card._overlayResizeObserver = ro;
                } else {
                    window.addEventListener('resize', updateLayout);
                }
            });
        }

        // Click handler for unwrapping
        card.addEventListener('click', () => {
            if (card.classList.contains('unwrapped')) return;

            card.classList.add('unwrapped');
            const overlay = card._overlayContainer;
            const sticker = card._stickerPeel;
            const main = overlay ? overlay.querySelector('.sticker-peel-main') as HTMLElement : null;
            const flap = overlay ? overlay.querySelector('.sticker-peel-flap') as HTMLElement : null;
            const dragEl = overlay ? overlay.querySelector('.sticker-peel-draggable') as HTMLElement : null;

            if (overlay) overlay.style.pointerEvents = 'none';
            if (dragEl) dragEl.style.pointerEvents = 'none';

            // Animate the peel
            if (main) {
                main.style.transition = 'clip-path 1.8s cubic-bezier(0.2, 0.7, 0, 1)';
                main.style.setProperty('clip-path', 'polygon(0 3%, 100% 3%, 100% 100%, 0 100%)', 'important');
                void main.getBoundingClientRect();
                main.style.setProperty('clip-path', 'polygon(0 100%, 100% 100%, 100% 100%, 0 100%)', 'important');
            }
            if (flap) {
                flap.style.transition = 'clip-path 1.8s cubic-bezier(0.2, 0.7, 0, 1), top 1.8s cubic-bezier(0.2, 0.7, 0, 1)';
                flap.style.setProperty('clip-path', 'polygon(0 0, 100% 0, 100% 3%, 0 3%)', 'important');
                flap.style.setProperty('top', 'calc(-100% + 2 * 3% - 1px)', 'important');
                void flap.getBoundingClientRect();
                flap.style.setProperty('clip-path', 'polygon(0 0, 100% 0, 100% 100%, 0 100%)', 'important');
                flap.style.setProperty('top', 'calc(100% - 1px)', 'important');
            }

            // Reveal video
            if (video) {
                video.style.transition = 'opacity 0.6s ease-out, transform 0.25s ease-out';
                video.style.opacity = '1';
                video.style.transform = 'none';
                const playPromise = video.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => { });
                }

                // Show play button
                const playBtn = card.querySelector('.card-play-btn') as HTMLElement;
                if (playBtn) {
                    playBtn.style.display = 'inline-flex';
                    void playBtn.offsetWidth;
                    playBtn.classList.add('visible');
                }
            }

            // Cleanup overlay after animation
            setTimeout(() => {
                if (sticker && typeof sticker.destroy === 'function') sticker.destroy();
                if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
            }, 2000);

            // Play audio demo if available
            const audioSrc = card.getAttribute('data-audio-src');
            const audioStart = parseFloat(card.getAttribute('data-audio-start') || '0');
            const audioDuration = parseFloat(card.getAttribute('data-audio-duration') || '20');

            if (audioSrc) {
                setTimeout(() => {
                    const audio = new Audio(audioSrc);
                    audio.currentTime = audioStart;
                    audio.volume = 0.7;

                    const playAudioPromise = audio.play();
                    if (playAudioPromise) {
                        playAudioPromise.catch(() => {
                            console.log('Audio playback failed');
                        });
                    }

                    // Stop after duration
                    setTimeout(() => {
                        audio.pause();
                        audio.currentTime = 0;
                    }, audioDuration * 1000);
                }, 800);
            }
        });

        // Hover handlers for video playback preview
        card.addEventListener('mouseenter', () => {
            if (!card.classList.contains('unwrapped') && video) {
                video.play().catch(() => { });
            }
        });

        card.addEventListener('mouseleave', () => {
            if (!card.classList.contains('unwrapped') && video) {
                video.pause();
                video.currentTime = 0;
            }
        });
    }
}

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        new ComingSoonController();
    });
} else {
    new ComingSoonController();
}

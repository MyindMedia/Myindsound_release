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
    private static currentAudio: HTMLAudioElement | null = null;
    private static fadeInterval: any | null = null;

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
            cardMedia.appendChild(overlayContainer); // Append to cardMedia for perfect alignment
            overlayContainer.style.background = 'transparent';

            requestAnimationFrame(() => {
                console.log(`Setting up dimensions for card ${index}`);

                const mediaRect = cardMedia.getBoundingClientRect();
                const targetWidth = mediaRect.width;
                const targetHeight = mediaRect.height;
                console.log('Target Height:', targetHeight); // Prevent TS error

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
                cardMedia.style.overflow = 'visible'; // Allow peel flap to go outside

                // Force poster-layer and poster-group to match card-media dimensions exactly
                posterLayer.style.width = '100%';
                posterLayer.style.height = '100%';
                posterLayer.style.position = 'absolute';
                posterLayer.style.inset = '0';
                posterGroup.style.width = '100%';
                posterGroup.style.height = '100%';
                posterGroup.style.position = 'absolute';
                posterGroup.style.inset = '0';

                // Perfect alignment: overlay matches card-media exactly
                overlayContainer.style.width = '100%';
                overlayContainer.style.height = '100%';
                overlayContainer.style.position = 'absolute';
                overlayContainer.style.inset = '0';
                overlayContainer.style.left = '0';
                overlayContainer.style.top = '0';
                overlayContainer.style.zIndex = '1002'; // Ensure it's on top of poster-group (1001)
                overlayContainer.style.pointerEvents = 'none';
                overlayContainer.style.willChange = 'transform';
                overlayContainer.style.transform = 'none';
                overlayContainer.style.overflow = 'visible';
                overlayContainer.style.transformStyle = 'preserve-3d';

                // Style plastic layers - use percentage sizing for perfect alignment
                if (plasticTop) {
                    plasticTop.style.width = '100%';
                    plasticTop.style.height = '100%';
                    plasticTop.style.position = 'absolute';
                    plasticTop.style.inset = '0';
                }
                if (plasticBottom) {
                    plasticBottom.style.width = '100%';
                    plasticBottom.style.height = '100%';
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
                    width: targetWidth, // Use full width for perfect alignment
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
                    if (!cardMedia) return;

                    const mr = cardMedia.getBoundingClientRect();
                    const w = mr.width;
                    const h = mr.height;

                    // Force overlay container to match exactly
                    overlayContainer.style.width = '100%';
                    overlayContainer.style.height = '100%';

                    // Update sticker peel instance dimensions
                    if (stickerPeel) {
                        stickerPeel.resize(w, h);
                    }

                    // console.log('Updated dimensions:', w, h);
                };

                // Initial layout update to ensure correct size immediately after creation
                // This catches cases where the initial size calculation happened before layout stabilized
                requestAnimationFrame(() => updateLayout());

                if ('ResizeObserver' in window) {
                    const ro = new ResizeObserver(() => {
                        requestAnimationFrame(updateLayout);
                    });
                    ro.observe(cardMedia!);
                    card._overlayResizeObserver = ro;
                } else {
                    (window as any).addEventListener('resize', updateLayout);
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

            // Reveal video with smooth cross-dissolve
            if (video) {
                // Start video playback immediately but keep it invisible
                const playPromise = video.play();
                if (playPromise && typeof playPromise.catch === 'function') {
                    playPromise.catch(() => { });
                }

                // Fade out poster and fade in video simultaneously
                posterLayer.style.transition = 'opacity 0.6s ease-out';
                video.style.transition = 'opacity 0.6s ease-out';

                setTimeout(() => {
                    posterLayer.style.opacity = '0';
                    video.style.opacity = '1';
                }, 100);

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
                    const audio = ComingSoonController.playAudioWithFadeout(audioSrc, audioStart, audioDuration);
                    this.setupPlayButton(card, audio);
                }, 800);
            }
        });

        // Hover handlers for video playback preview
        if (video) {
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

    private static stopCurrentAudio() {
        if (ComingSoonController.currentAudio) {
            ComingSoonController.currentAudio.pause();
            ComingSoonController.currentAudio.currentTime = 0;
            ComingSoonController.currentAudio = null;
        }
        if (ComingSoonController.fadeInterval) {
            clearInterval(ComingSoonController.fadeInterval);
            ComingSoonController.fadeInterval = null;
        }
    }

    private static fadeOutAudio(audio: HTMLAudioElement, duration: number = 2000) {
        const startVolume = audio.volume;
        const startTime = Date.now();

        ComingSoonController.fadeInterval = setInterval(() => {
            const elapsed = Date.now() - startTime;
            const progress = Math.min(elapsed / duration, 1);
            audio.volume = startVolume * (1 - progress);

            if (progress >= 1) {
                audio.pause();
                audio.currentTime = 0;
                ComingSoonController.currentAudio = null;
                if (ComingSoonController.fadeInterval) {
                    clearInterval(ComingSoonController.fadeInterval);
                    ComingSoonController.fadeInterval = null;
                }
            }
        }, 50);
    }

    private static playAudioWithFadeout(audioSrc: string, startTime: number, duration: number) {
        // Stop any currently playing audio
        ComingSoonController.stopCurrentAudio();

        const audio = new Audio(audioSrc);
        audio.currentTime = startTime;
        audio.volume = 0.7;

        const playPromise = audio.play();
        if (playPromise) {
            playPromise.catch(() => {
                console.log('Audio playback failed');
            });
        }

        ComingSoonController.currentAudio = audio;

        // Schedule fade-out before the duration ends
        const fadeStartTime = Math.max((duration - 2) * 1000, 1000); // Start fade 2 seconds before end
        setTimeout(() => {
            if (ComingSoonController.currentAudio === audio) {
                ComingSoonController.fadeOutAudio(audio, 2000);
            }
        }, fadeStartTime);

        // Stop at exact duration
        setTimeout(() => {
            if (ComingSoonController.currentAudio === audio) {
                ComingSoonController.stopCurrentAudio();
            }
        }, duration * 1000);

        return audio;
    }

    private setupPlayButton(card: HTMLElement, audio: HTMLAudioElement) {
        const playBtn = card.querySelector('.card-play-btn') as HTMLElement;
        if (!playBtn) return;

        let isPlaying = true;

        playBtn.addEventListener('click', (e) => {
            e.stopPropagation();

            if (isPlaying) {
                audio.pause();
                playBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>';
            } else {
                const playPromise = audio.play();
                if (playPromise) {
                    playPromise.catch(() => {
                        console.log('Audio playback failed');
                    });
                }
                playBtn.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>';
            }
            isPlaying = !isPlaying;
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

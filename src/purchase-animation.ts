// import { gsap } from 'gsap';
const gsap = (window as any).gsap;
import { StickerPeel } from './sticker-peel';

export class PurchaseAnimationController {
    private overlay: HTMLElement | null = null;
    private diskContainer: HTMLElement | null = null;
    private originalRect: DOMRect | null = null;
    private albumContainer: HTMLElement | null = null;
    private stickerPeel: StickerPeel | null = null;

    constructor() {
    }

    public start() {
        this.captureState();
        this.createOverlay();
        // Give a moment for StickerPeel to init and DOM to settle
        requestAnimationFrame(() => {
            this.animateSequence();
        });
    }

    private captureState() {
        // Capture the position of the main album art before we build the overlay
        const originalArt = document.querySelector('.main-album-art');
        if (originalArt) {
            this.originalRect = originalArt.getBoundingClientRect();
        }
    }

    private createOverlay() {
        // 1. Create Layout
        this.overlay = document.createElement('div');
        this.overlay.id = 'purchase-overlay';
        this.overlay.style.position = 'fixed';
        this.overlay.style.inset = '0';
        this.overlay.style.zIndex = '9999';
        this.overlay.style.display = 'flex';
        this.overlay.style.alignItems = 'center';
        this.overlay.style.justifyContent = 'center';
        this.overlay.style.perspective = '1500px'; // Deep perspective for flip
        this.overlay.style.pointerEvents = 'none';

        // Backdrops
        // A. Transparent initial (to capture position) -> then Blackout
        const backdrop = document.createElement('div');
        backdrop.style.position = 'absolute';
        backdrop.style.inset = '0';
        backdrop.style.background = '#000';
        backdrop.style.opacity = '0'; // Start invisible
        backdrop.id = 'anim-backdrop';
        this.overlay.appendChild(backdrop);

        // 2. 3D Flipper Container
        // This will contain the "Card" with proper 3D preservation
        const flipperContainer = document.createElement('div');
        flipperContainer.style.position = 'absolute';
        flipperContainer.style.transformStyle = 'preserve-3d';
        flipperContainer.id = 'anim-flipper';

        // Initial position to match original
        if (this.originalRect) {
            flipperContainer.style.top = `${this.originalRect.top}px`;
            flipperContainer.style.left = `${this.originalRect.left}px`;
            flipperContainer.style.width = `${this.originalRect.width}px`;
            flipperContainer.style.height = `${this.originalRect.height}px`;
        }

        // --- FRONT SIDE: Album Art + Sticker Peel ---
        this.albumContainer = document.createElement('div');
        this.albumContainer.id = 'anim-album-front';
        this.albumContainer.style.position = 'absolute';
        this.albumContainer.style.inset = '0';
        this.albumContainer.style.width = '100%';
        this.albumContainer.style.height = '100%';
        this.albumContainer.style.backfaceVisibility = 'hidden'; // Hide when flipped
        // this.albumContainer.style.zIndex = '2';

        // Background of Front Face (The Album Art)
        const albumArtImg = document.createElement('img');
        albumArtImg.src = '/assets/images/lit-poster.png';
        albumArtImg.style.position = 'absolute';
        albumArtImg.style.inset = '0';
        albumArtImg.style.width = '100%';
        albumArtImg.style.height = '100%';
        albumArtImg.style.objectFit = 'cover';
        albumArtImg.style.borderRadius = '4px';
        albumArtImg.style.boxShadow = '0 30px 60px rgba(0,0,0,0.8)';
        this.albumContainer.appendChild(albumArtImg);

        // Container for StickerPeel (On top of Album Art)
        const peelContainer = document.createElement('div');
        peelContainer.style.position = 'absolute';
        peelContainer.style.inset = '0';
        peelContainer.style.width = '100%';
        peelContainer.style.height = '100%';
        peelContainer.style.zIndex = '10'; // Top
        this.albumContainer.appendChild(peelContainer);

        // Init StickerPeel
        // We pass the Peel Overlay Image as the 'image' for the sticker.
        this.stickerPeel = new StickerPeel({
            container: peelContainer,
            imageSrc: '/assets/images/buypeeloverlay.png',
            width: this.originalRect?.width || 500, // Should match container
            rotate: 0,
            peelBackHoverPct: 0, // No initial peel
            peelBackActivePct: 100,
            peelDirection: 45, // Diagonal peel from top right
            shadowIntensity: 0.1,
            lightingIntensity: 0.1,
            className: 'purchase-peel'
        });

        // --- BACK SIDE: CD Player ---
        this.diskContainer = document.createElement('div');
        this.diskContainer.id = 'anim-disk-player';
        this.diskContainer.className = 'animated-disk-player';
        this.diskContainer.style.position = 'absolute';
        this.diskContainer.style.inset = '0';
        this.diskContainer.style.width = '100%';
        this.diskContainer.style.height = '100%';
        this.diskContainer.style.backfaceVisibility = 'hidden';
        this.diskContainer.style.transform = 'rotateY(180deg)'; // Start flipped away
        // this.diskContainer.style.zIndex = '1';

        this.buildDiskPlayer();

        // Assemble
        flipperContainer.appendChild(this.albumContainer);
        flipperContainer.appendChild(this.diskContainer);
        this.overlay.appendChild(flipperContainer);
        document.body.appendChild(this.overlay);

        // Hide original immediately
        const originalContainer = document.getElementById('lit-album-container');
        if (originalContainer) originalContainer.style.opacity = '0';
    }

    private buildDiskPlayer() {
        if (!this.diskContainer) return;

        // Layers
        const layers = document.createElement('div');
        layers.className = 'disk-layers';
        layers.style.width = '100%';
        layers.style.height = '100%';

        // Create layers L1 (top) to L5 (bottom)
        ['l5', 'l4', 'l3', 'l2', 'l1'].forEach((name) => {
            const layerImg = document.createElement('img');
            layerImg.src = `/assets/CD-Assets/${name}.png`;
            layerImg.className = `disk-layer layer-${name.replace('l', '')}`;

            // Fix styles for absolute positioning inside the container
            layerImg.style.position = 'absolute';
            layerImg.style.top = '0';
            layerImg.style.left = '0';
            layerImg.style.width = '100%';
            layerImg.style.height = '100%';

            layers.appendChild(layerImg);
        });

        // Play Button Overlay
        const playBtn = document.createElement('div');
        playBtn.className = 'disk-play-btn';
        playBtn.style.position = 'absolute';
        playBtn.style.bottom = '-80px';
        playBtn.style.left = '50%';
        playBtn.style.transform = 'translate(-50%, 0)';
        playBtn.style.width = '60px';
        playBtn.style.height = '60px';
        playBtn.style.borderRadius = '50%';
        playBtn.style.background = 'rgba(255, 215, 0, 0.8)';
        playBtn.style.display = 'flex';
        playBtn.style.alignItems = 'center';
        playBtn.style.justifyContent = 'center';
        playBtn.style.cursor = 'pointer';
        playBtn.style.boxShadow = '0 0 20px rgba(255,215,0, 0.6)';
        playBtn.style.zIndex = '10';
        playBtn.style.pointerEvents = 'auto'; // Enable clicks
        playBtn.style.opacity = '0'; // Start hidden
        playBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="black"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg>`;

        this.diskContainer.appendChild(layers);
        this.diskContainer.appendChild(playBtn);

        // Glitch Text Instruction
        const glitchText = document.createElement('div');
        glitchText.className = 'glitch-instruction';
        glitchText.innerText = 'CLICK PLAYER TO START';
        glitchText.setAttribute('data-text', 'CLICK PLAYER TO START');
        glitchText.style.position = 'absolute';
        glitchText.style.top = '100%'; // Below the player
        glitchText.style.left = '50%';
        glitchText.style.transform = 'translateX(-50%)';
        glitchText.style.marginTop = '120px'; // Space below button (which is at -80px)
        glitchText.style.fontFamily = '"Courier New", monospace';
        glitchText.style.fontWeight = 'bold';
        glitchText.style.fontSize = '18px';
        glitchText.style.color = '#fff';
        glitchText.style.letterSpacing = '2px';
        glitchText.style.opacity = '0';
        glitchText.style.textShadow = '2px 0 red, -2px 0 blue';
        glitchText.style.whiteSpace = 'nowrap';
        glitchText.style.pointerEvents = 'none';

        // CSS Animation for Glitch
        const style = document.createElement('style');
        style.innerHTML = `
            @keyframes glitch-skew {
                0% { transform: translateX(-50%) skew(0deg); }
                20% { transform: translateX(-50%) skew(-2deg); }
                40% { transform: translateX(-50%) skew(2deg); }
                60% { transform: translateX(-50%) skew(-1deg); }
                80% { transform: translateX(-50%) skew(1deg); }
                100% { transform: translateX(-50%) skew(0deg); }
            }
            @keyframes glitch-anim {
                0% { clip-path: inset(40% 0 61% 0); }
                20% { clip-path: inset(92% 0 1% 0); }
                40% { clip-path: inset(43% 0 1% 0); }
                60% { clip-path: inset(25% 0 58% 0); }
                80% { clip-path: inset(54% 0 7% 0); }
                100% { clip-path: inset(58% 0 43% 0); }
            }
            .glitch-instruction::before,
            .glitch-instruction::after {
                content: attr(data-text);
                position: absolute;
                top: 0;
                left: 0;
                width: 100%;
                height: 100%;
            }
            .glitch-instruction::before {
                left: 2px;
                text-shadow: -1px 0 red;
                clip-path: inset(0 0 0 0); 
                animation: glitch-anim 2s infinite linear alternate-reverse;
            }
            .glitch-instruction::after {
                left: -2px;
                text-shadow: -1px 0 blue;
                clip-path: inset(0 0 0 0);
                animation: glitch-anim 2s infinite linear alternate-reverse;
            }
        `;
        document.head.appendChild(style);
        this.diskContainer.appendChild(glitchText);
    }

    private animateSequence() {
        if (!this.overlay) return;

        const backdrop = this.overlay.querySelector('#anim-backdrop');
        const flipper = this.overlay.querySelector('#anim-flipper') as HTMLElement;
        const playBtn = this.diskContainer?.querySelector('.disk-play-btn');

        // Center Calculation
        const windowWidth = window.innerWidth;
        const windowHeight = window.innerHeight;
        const centerX = (windowWidth - (this.originalRect?.width || 300)) / 2;
        const centerY = (windowHeight - (this.originalRect?.height || 300)) / 2;
        const deltaX = centerX - (this.originalRect?.left || 0);
        const deltaY = centerY - (this.originalRect?.top || 0);

        const tl = gsap.timeline();

        // 1. LIFT OFF (Move Flipper to Center)
        // Instant Black Background
        tl.to(backdrop, { opacity: 1, duration: 0.1, ease: 'power2.inOut' }, 0);
        tl.to(flipper, {
            x: deltaX,
            y: deltaY,
            scale: 1.2,
            duration: 1.2,
            ease: 'power3.inOut'
        }, 0);

        // 2. PEEL ANIMATION
        // Manually trigger StickerPeel clip-path transition
        tl.call(() => {
            const overlay = this.albumContainer;
            if (overlay) {
                // Access internal elements we know exist in StickerPeel
                const main = overlay.querySelector('.sticker-peel-main') as HTMLElement;
                const flap = overlay.querySelector('.sticker-peel-flap') as HTMLElement;

                if (main) {
                    main.style.transition = 'clip-path 1.2s cubic-bezier(0.6, 0.1, 0.3, 1)';
                    // Wipe away to left
                    main.style.clipPath = 'polygon(0% 0%, 0% 0%, 0% 100%, 0% 100%)';
                }
                if (flap) {
                    // Flap follows the peel
                    flap.style.transition = 'all 1.2s cubic-bezier(0.6, 0.1, 0.3, 1)';
                    flap.style.clipPath = 'polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%)';
                    flap.style.top = '100%'; // Fly off bottom
                    flap.style.opacity = '0'; // Fade out eventually
                }
            }
        }, [], '+=0.2');

        // Wait for peel to finish
        tl.to({}, { duration: 1.0 });

        // 2.5 SHAKE ANIMATION
        // Brief wobble before flip
        tl.to(flipper, {
            x: `+=${Math.random() * 10 - 5}`,
            rotation: 2,
            duration: 0.1,
            yoyo: true,
            repeat: 5,
            ease: 'rough'
        });
        tl.to(flipper, { rotation: 0, x: deltaX, duration: 0.1 }); // Reset

        // 3. FLIP (Album -> Disk Player)
        // Horizontal Flip (Rotate Y)
        tl.to(flipper, {
            rotationY: 180,
            duration: 0.8,
            ease: 'back.inOut(1.2)'
        });

        // 4. SPIN & PLAY BUTTON
        if (this.diskContainer) {
            tl.call(() => {
                // Start spinning L3
                const l3 = this.diskContainer!.querySelector('.layer-3');
                if (l3) {
                    gsap.to(l3, { rotation: 360, duration: 4, repeat: -1, ease: 'none' });
                }
            }, [], '-=0.4'); // Start spin just before flip ends

            // Show Play Button
            // Ensure playBtn is found - we selected it earlier
            if (playBtn) {
                tl.to(playBtn, {
                    opacity: 1,
                    scale: 1,
                    duration: 0.4,
                    ease: 'back.out(1.7)'
                }, '+=0.1');
            }

            // Show Glitch Text
            const glitchText = this.diskContainer?.querySelector('.glitch-instruction');
            if (glitchText) {
                tl.to(glitchText, {
                    opacity: 1,
                    duration: 0.2,
                    ease: 'power2.in'
                }, '<'); // Reveal with button
            }
        }

        // Setup Interaction
        if (playBtn) {
            playBtn.addEventListener('click', () => {
                // Pulse Animation on Click
                gsap.to(playBtn, { scale: 0.9, duration: 0.1, yoyo: true, repeat: 1 });
                // Hide Play Button
                gsap.to(playBtn, { opacity: 0, duration: 0.2, delay: 0.1 });

                // Fade to Black (Seamless transition)
                if (backdrop) {
                    // Ensure backdrop is fully opaque black before redirect
                    // The backdrop currently has opacity 1 from step 1.
                    // We make sure it STAYS there.
                    gsap.to(backdrop, { opacity: 1, duration: 0.2 });
                }

                // Redirect to Stream Page for Final Docking
                // Small delay to ensure click feedback is seen
                setTimeout(() => {

                    window.location.assign('/stream.html?state=animate_dock');
                }, 500);
            });
            // Pulse effect to invite click
            gsap.to(playBtn, { scale: 1.1, repeat: -1, yoyo: true, duration: 1 });
        }
    }




}

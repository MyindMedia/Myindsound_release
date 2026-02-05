/**
 * Success Page Animation Controller
 * Handles the post-purchase animation sequence from success.html to stream.html
 *
 * Flow:
 * 1. Album art lifts to center, screen fades to black
 * 2. Peel animation reveals cdinsert.png (disc image) - NO spinning
 * 3. "Tap to Play" overlay
 * 4. On tap: dock animation starts, sound plays 1 second after click
 * 5. Navigate to stream.html seamlessly (disc appears to dock into player)
 */

const gsap = (window as any).gsap;

export class SuccessAnimationController {
  private overlay: HTMLElement | null = null;
  private discContainer: HTMLElement | null = null;
  private discElement: HTMLElement | null = null;
  private tapOverlay: HTMLElement | null = null;
  private preventScroll: (e: Event) => void;

  constructor() {
    this.preventScroll = (e: Event) => {
      e.preventDefault();
    };
  }

  /**
   * Start the full animation sequence
   * @param albumImageSrc - Source of the album artwork (for the peel overlay)
   */
  public start(albumImageSrc: string = '/assets/images/lit-poster.png') {
    // Lock input
    this.lockInput();

    // Create overlay
    this.createOverlay(albumImageSrc);

    // Run animation sequence
    this.animateSequence();
  }

  private lockInput() {
    document.body.style.overflow = 'hidden';
    document.addEventListener('wheel', this.preventScroll, { passive: false });
    document.addEventListener('touchmove', this.preventScroll, { passive: false });
  }

  private unlockInput() {
    document.body.style.overflow = '';
    document.removeEventListener('wheel', this.preventScroll);
    document.removeEventListener('touchmove', this.preventScroll);
  }

  private createOverlay(albumImageSrc: string) {
    // Main overlay container
    this.overlay = document.createElement('div');
    this.overlay.id = 'success-animation-overlay';
    this.overlay.style.cssText = `
      position: fixed;
      inset: 0;
      z-index: 10000;
      display: flex;
      align-items: center;
      justify-content: center;
      pointer-events: none;
      perspective: 1500px;
    `;

    // Backdrop (starts transparent, fades to black)
    const backdrop = document.createElement('div');
    backdrop.id = 'anim-backdrop';
    backdrop.style.cssText = `
      position: absolute;
      inset: 0;
      background: #000;
      opacity: 0;
      z-index: -1;
    `;
    this.overlay.appendChild(backdrop);

    // Disc container (holds the cdinsert.png and peel overlay) - matches player size
    this.discContainer = document.createElement('div');
    this.discContainer.id = 'anim-disc-container';
    this.discContainer.style.cssText = `
      position: relative;
      width: 550px;
      height: 550px;
    `;

    // CD Insert image (the reveal - underneath the peel)
    this.discElement = document.createElement('div');
    this.discElement.id = 'anim-disc';
    this.discElement.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    `;

    const discImg = document.createElement('img');
    discImg.id = 'anim-disc-img';
    discImg.src = '/assets/images/CD Casset/cdinsert.png';
    discImg.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: contain;
      filter: drop-shadow(0 20px 40px rgba(0,0,0,0.8));
    `;
    this.discElement.appendChild(discImg);
    this.discContainer.appendChild(this.discElement);

    // Album art with peel overlay (on top - will be peeled back)
    const peelContainer = document.createElement('div');
    peelContainer.id = 'anim-peel-container';
    peelContainer.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      border-radius: 4px;
      clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
      transition: clip-path 1.5s cubic-bezier(0.4, 0, 0.2, 1);
    `;

    // Album art image
    const albumImg = document.createElement('img');
    albumImg.src = albumImageSrc;
    albumImg.style.cssText = `
      position: absolute;
      width: 100%;
      height: 100%;
      object-fit: cover;
    `;
    peelContainer.appendChild(albumImg);

    // Peel overlay on top of album art
    const peelOverlay = document.createElement('div');
    peelOverlay.id = 'anim-peel-overlay';
    peelOverlay.style.cssText = `
      position: absolute;
      inset: -2%;
      width: 104%;
      height: 104%;
      background: url('/assets/images/buypeeloverlay.png') no-repeat center center;
      background-size: cover;
    `;
    peelContainer.appendChild(peelOverlay);

    this.discContainer.appendChild(peelContainer);
    this.overlay.appendChild(this.discContainer);

    // Tap to Play text (positioned below the disc)
    this.tapOverlay = document.createElement('div');
    this.tapOverlay.id = 'tap-to-play-text';
    this.tapOverlay.style.cssText = `
      position: absolute;
      bottom: 25%;
      left: 50%;
      transform: translateX(-50%);
      opacity: 0;
      pointer-events: none;
    `;

    // Glitch text
    const glitchText = document.createElement('div');
    glitchText.className = 'glitch-text';
    glitchText.textContent = 'TAP TO PLAY';
    glitchText.setAttribute('data-text', 'TAP TO PLAY');
    glitchText.style.cssText = `
      font-family: 'Courier New', monospace;
      font-size: 1.2rem;
      font-weight: bold;
      color: #fff;
      letter-spacing: 4px;
      text-shadow: 2px 0 #ff0000, -2px 0 #00ffff;
      white-space: nowrap;
    `;

    // Add glitch CSS animation
    this.addGlitchStyles();

    this.tapOverlay.appendChild(glitchText);
    this.overlay.appendChild(this.tapOverlay);

    document.body.appendChild(this.overlay);
  }

  private addGlitchStyles() {
    const style = document.createElement('style');
    style.id = 'success-anim-glitch-styles';
    style.innerHTML = `
      @keyframes glitch-skew {
        0% { transform: skew(0deg); }
        20% { transform: skew(-2deg); }
        40% { transform: skew(2deg); }
        60% { transform: skew(-1deg); }
        80% { transform: skew(1deg); }
        100% { transform: skew(0deg); }
      }
      @keyframes glitch-anim {
        0% { clip-path: inset(40% 0 61% 0); }
        20% { clip-path: inset(92% 0 1% 0); }
        40% { clip-path: inset(43% 0 1% 0); }
        60% { clip-path: inset(25% 0 58% 0); }
        80% { clip-path: inset(54% 0 7% 0); }
        100% { clip-path: inset(58% 0 43% 0); }
      }
      .glitch-text {
        animation: glitch-skew 1s infinite linear alternate-reverse;
      }
      .glitch-text::before,
      .glitch-text::after {
        content: attr(data-text);
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
      }
      .glitch-text::before {
        left: 2px;
        text-shadow: -1px 0 #ff0000;
        animation: glitch-anim 2s infinite linear alternate-reverse;
      }
      .glitch-text::after {
        left: -2px;
        text-shadow: -1px 0 #00ffff;
        animation: glitch-anim 2s infinite linear alternate-reverse;
        animation-delay: 0.1s;
      }
    `;
    document.head.appendChild(style);
  }

  private animateSequence() {
    if (!this.overlay || !gsap) return;

    const backdrop = this.overlay.querySelector('#anim-backdrop');
    const peelContainer = this.overlay.querySelector('#anim-peel-container') as HTMLElement;

    const tl = gsap.timeline();

    // Phase A: Fade to black backdrop
    tl.to(backdrop, {
      opacity: 1,
      duration: 0.6,
      ease: 'power2.inOut'
    });

    // Phase B: Lift animation (slight scale up and float)
    tl.to(this.discContainer, {
      y: -10,
      scale: 1.02,
      duration: 0.4,
      ease: 'power2.out'
    }, '+=0.2');

    // Brief shake before peel
    tl.to(this.discContainer, {
      x: 3,
      rotation: 1,
      duration: 0.05,
      repeat: 3,
      yoyo: true,
      ease: 'none'
    });

    tl.to(this.discContainer, {
      x: 0,
      rotation: 0,
      y: 0,
      scale: 1,
      duration: 0.1
    });

    // Phase C: Peel animation - reveals cdinsert.png underneath (NO spinning)
    tl.call(() => {
      if (peelContainer) {
        // Peel from right to left (like unwrapping plastic)
        peelContainer.style.clipPath = 'polygon(0 0, 0 0, 0 100%, 0 100%)';
      }
    }, [], '+=0.2');

    // Wait for peel animation to complete
    tl.to({}, { duration: 1.5 });

    // Phase D: Show "Tap To Play" (disc is static, no spinning)
    tl.to(this.tapOverlay, {
      opacity: 1,
      duration: 0.4
    }, '+=0.2');

    // Enable tap interaction
    tl.call(() => {
      this.enableTapInteraction();
    });
  }

  private enableTapInteraction() {
    if (!this.overlay || !this.discContainer) return;

    // Make disc clickable
    this.discContainer.style.pointerEvents = 'auto';
    this.discContainer.style.cursor = 'pointer';
    this.overlay.style.pointerEvents = 'auto';

    // Pulsate effect (no spinning)
    gsap.to(this.discContainer, {
      scale: 1.05,
      duration: 1,
      repeat: -1,
      yoyo: true,
      ease: 'power1.inOut'
    });

    // Click handler
    const handleTap = () => {
      this.discContainer?.removeEventListener('click', handleTap);
      this.onTapToPlay();
    };

    this.discContainer.addEventListener('click', handleTap);
  }

  private onTapToPlay() {
    if (!gsap || !this.discContainer) return;

    const discImg = this.overlay?.querySelector('#anim-disc-img') as HTMLElement;

    // Kill pulsate animation
    gsap.killTweensOf(this.discContainer);

    // Click feedback
    gsap.to(this.discContainer, {
      scale: 0.95,
      duration: 0.1,
      yoyo: true,
      repeat: 1
    });

    // Hide tap text immediately
    gsap.to(this.tapOverlay, {
      opacity: 0,
      duration: 0.3
    });

    // Audio plays on stream.html reveal, not here

    // Dock animation - disc slides down into player (NO spinning)
    const tl = gsap.timeline();

    // Add glow effect as it starts docking
    tl.to(discImg, {
      filter: 'drop-shadow(0 0 30px rgba(255, 215, 0, 0.6))',
      duration: 0.3
    }, '+=0.3');

    // Scale down and slide down - disc slides into player position
    tl.to(this.discContainer, {
      y: 200,
      scale: 0.5,
      duration: 1.5,
      ease: 'power2.inOut'
    }, '-=0.1');

    // Fade out at the end
    tl.to(this.discContainer, {
      opacity: 0,
      duration: 0.4
    }, '-=0.3');

    // Navigate after dock animation completes
    tl.call(() => {
      this.navigateToStream();
    });
  }

  private navigateToStream() {
    // Clean up
    this.unlockInput();

    // Remove glitch styles
    const glitchStyles = document.getElementById('success-anim-glitch-styles');
    if (glitchStyles) glitchStyles.remove();

    // Navigate with state flag for seamless UI reveal
    window.location.href = '/stream.html?state=reveal_ui';
  }

  /**
   * Clean up and destroy the animation controller
   */
  public destroy() {
    this.unlockInput();

    if (this.overlay) {
      this.overlay.remove();
    }

    const glitchStyles = document.getElementById('success-anim-glitch-styles');
    if (glitchStyles) glitchStyles.remove();
  }
}

// Export for module use
export default SuccessAnimationController;

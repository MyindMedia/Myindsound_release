/**
 * Success Page Animation Controller
 * Handles the post-purchase animation sequence from success.html to stream.html
 */

const gsap = (window as any).gsap;

export class SuccessAnimationController {
  private overlay: HTMLElement | null = null;
  private albumElement: HTMLElement | null = null;
  private cdCassetElement: HTMLElement | null = null;
  private tapOverlay: HTMLElement | null = null;
  private dockAudio: HTMLAudioElement | null = null;
  private preventScroll: (e: Event) => void;

  constructor() {
    this.preventScroll = (e: Event) => {
      e.preventDefault();
    };
  }

  /**
   * Start the full animation sequence
   * @param albumImageSrc - Source of the album artwork
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

    // 3D flip container
    const flipContainer = document.createElement('div');
    flipContainer.id = 'anim-flip-container';
    flipContainer.style.cssText = `
      position: relative;
      width: 300px;
      height: 300px;
      transform-style: preserve-3d;
    `;

    // Front face - Album Art
    this.albumElement = document.createElement('div');
    this.albumElement.id = 'anim-album-front';
    this.albumElement.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      backface-visibility: hidden;
      border-radius: 4px;
      overflow: hidden;
    `;

    const albumImg = document.createElement('img');
    albumImg.src = albumImageSrc;
    albumImg.style.cssText = `
      width: 100%;
      height: 100%;
      object-fit: cover;
      box-shadow: 0 30px 60px rgba(0,0,0,0.8);
    `;
    this.albumElement.appendChild(albumImg);

    // Peel overlay on front
    const peelOverlay = document.createElement('div');
    peelOverlay.id = 'anim-peel-overlay';
    peelOverlay.style.cssText = `
      position: absolute;
      inset: 0;
      background: url('/assets/images/buypeeloverlay.png') no-repeat center center;
      background-size: cover;
      clip-path: polygon(0 0, 100% 0, 100% 100%, 0 100%);
      transition: clip-path 1.2s cubic-bezier(0.6, 0.1, 0.3, 1);
    `;
    this.albumElement.appendChild(peelOverlay);

    // Back face - CD Cassette
    this.cdCassetElement = document.createElement('div');
    this.cdCassetElement.id = 'anim-cd-back';
    this.cdCassetElement.className = 'animated-disk-player';
    this.cdCassetElement.style.cssText = `
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      backface-visibility: hidden;
      transform: rotateY(180deg);
    `;

    // Build CD layers
    const diskLayers = document.createElement('div');
    diskLayers.className = 'disk-layers';
    diskLayers.style.cssText = `
      position: relative;
      width: 100%;
      height: 100%;
    `;

    ['layer5', 'layer4', 'layer3', 'layer2', 'layer1'].forEach((name) => {
      const layerImg = document.createElement('img');
      layerImg.src = `/assets/images/CD Casset/${name}.png`;
      layerImg.className = `disk-layer layer-${name.replace('layer', '')}`;
      layerImg.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        object-fit: contain;
      `;
      diskLayers.appendChild(layerImg);
    });

    this.cdCassetElement.appendChild(diskLayers);

    // Assemble flip container
    flipContainer.appendChild(this.albumElement);
    flipContainer.appendChild(this.cdCassetElement);
    this.overlay.appendChild(flipContainer);

    // Tap to Play overlay (hidden initially)
    this.tapOverlay = document.createElement('div');
    this.tapOverlay.id = 'tap-to-play-overlay';
    this.tapOverlay.style.cssText = `
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 2rem;
      opacity: 0;
      pointer-events: none;
    `;

    // Glitch text
    const glitchText = document.createElement('div');
    glitchText.className = 'glitch-text';
    glitchText.textContent = 'TAP TO PLAY';
    glitchText.setAttribute('data-text', 'TAP TO PLAY');
    glitchText.style.cssText = `
      position: absolute;
      bottom: -80px;
      left: 50%;
      transform: translateX(-50%);
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

    // Preload dock audio
    this.dockAudio = new Audio('/assets/audio/dockload10sec.wav');
    this.dockAudio.preload = 'auto';
  }

  private addGlitchStyles() {
    const style = document.createElement('style');
    style.id = 'success-anim-glitch-styles';
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
    const flipContainer = this.overlay.querySelector('#anim-flip-container') as HTMLElement;
    const peelOverlay = this.overlay.querySelector('#anim-peel-overlay') as HTMLElement;
    const layer3 = this.cdCassetElement?.querySelector('.layer-3');

    const tl = gsap.timeline();

    // Phase A: Fade to black backdrop
    tl.to(backdrop, {
      opacity: 1,
      duration: 0.6,
      ease: 'power2.inOut'
    });

    // Phase B: Peel animation
    tl.call(() => {
      if (peelOverlay) {
        peelOverlay.style.clipPath = 'polygon(0 0, 0 0, 0 100%, 0 100%)';
      }
    }, [], '+=0.3');

    // Wait for peel
    tl.to({}, { duration: 1.2 });

    // Phase C: Hover wobble before flip
    tl.to(flipContainer, {
      y: -5,
      scale: 1.02,
      duration: 0.3,
      ease: 'power2.out'
    });

    // Brief shake
    tl.to(flipContainer, {
      x: 3,
      rotation: 1,
      duration: 0.05,
      repeat: 5,
      yoyo: true,
      ease: 'none'
    });

    tl.to(flipContainer, {
      x: 0,
      rotation: 0,
      duration: 0.1
    });

    // Phase C: 180 degree flip
    tl.to(flipContainer, {
      rotationY: 180,
      duration: 0.8,
      ease: 'back.inOut(1.2)'
    });

    // Start spinning layer 3
    tl.call(() => {
      if (layer3) {
        gsap.to(layer3, {
          rotation: 360,
          duration: 4,
          repeat: -1,
          ease: 'none'
        });
      }
    }, [], '-=0.4');

    // Phase D: Show "Tap To Play"
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
    if (!this.overlay || !this.cdCassetElement) return;

    // Make CD clickable
    this.cdCassetElement.style.pointerEvents = 'auto';
    this.cdCassetElement.style.cursor = 'pointer';
    this.overlay.style.pointerEvents = 'auto';

    // Pulsate effect on CD
    gsap.to(this.cdCassetElement, {
      scale: 1.05,
      duration: 1,
      repeat: -1,
      yoyo: true,
      ease: 'power1.inOut'
    });

    // Click handler
    const handleTap = () => {
      this.cdCassetElement?.removeEventListener('click', handleTap);
      this.onTapToPlay();
    };

    this.cdCassetElement.addEventListener('click', handleTap);
  }

  private onTapToPlay() {
    if (!this.dockAudio || !gsap) return;

    // Kill pulsate animation
    gsap.killTweensOf(this.cdCassetElement);

    // Click feedback
    gsap.to(this.cdCassetElement, {
      scale: 0.95,
      duration: 0.1,
      yoyo: true,
      repeat: 1
    });

    // Hide tap text
    gsap.to(this.tapOverlay, {
      opacity: 0,
      duration: 0.3
    });

    // Phase F: Play dock audio (10 seconds)
    this.dockAudio.volume = 0.8;
    this.dockAudio.play().catch(e => console.error('Audio play failed:', e));

    // Dock animation - scale down slightly and add dramatic glow
    const flipContainer = this.overlay?.querySelector('#anim-flip-container') as HTMLElement;
    if (flipContainer) {
      gsap.to(flipContainer, {
        scale: 0.9,
        y: -20,
        duration: 2,
        ease: 'power2.out'
      });

      // Add dramatic glow pulse during dock
      gsap.to(flipContainer, {
        filter: 'drop-shadow(0 0 30px rgba(255, 215, 0, 0.6))',
        duration: 0.5,
        repeat: -1,
        yoyo: true
      });
    }

    // Phase G: Navigate after 10 seconds
    setTimeout(() => {
      this.navigateToStream();
    }, 10000);
  }

  private navigateToStream() {
    // Clean up
    this.unlockInput();

    // Remove glitch styles
    const glitchStyles = document.getElementById('success-anim-glitch-styles');
    if (glitchStyles) glitchStyles.remove();

    // Navigate with state flag for UI reveal
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

    if (this.dockAudio) {
      this.dockAudio.pause();
      this.dockAudio = null;
    }

    const glitchStyles = document.getElementById('success-anim-glitch-styles');
    if (glitchStyles) glitchStyles.remove();
  }
}

// Export for module use
export default SuccessAnimationController;

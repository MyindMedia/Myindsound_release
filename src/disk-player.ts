// Animated Disk Player Controller
class DiskPlayerAnimator {
  protected diskPlayer: HTMLElement | null;
  protected diskLayers: HTMLElement | null;
  protected isPlaying: boolean = false;
  protected mousePosition: { x: number; y: number } = { x: 0, y: 0 };
  protected animationFrame: number | null = null;
  protected gsap: any; // Add gsap property to base class or cast in child

  constructor() {
    this.diskPlayer = document.querySelector('.animated-disk-player');
    this.diskLayers = document.querySelector('.disk-layers');
    this.init();
  }

  private init(): void {
    if (!this.diskPlayer || !this.diskLayers) return;

    // Add event listeners for hover and mouse movement
    this.diskPlayer.addEventListener('mouseenter', this.handleMouseEnter.bind(this));
    this.diskPlayer.addEventListener('mouseleave', this.handleMouseLeave.bind(this));
    this.diskPlayer.addEventListener('mousemove', this.handleMouseMove.bind(this));
    this.diskPlayer.addEventListener('click', this.handleClick.bind(this));

    // Add intersection observer for scroll animations
    this.setupIntersectionObserver();
  }

  private handleMouseEnter(): void {
    if (this.diskPlayer) {
      this.diskPlayer.classList.add('hovered');
    }
  }

  private handleMouseLeave(): void {
    if (this.diskPlayer) {
      this.diskPlayer.classList.remove('hovered');
      // Reset parallax transform
      this.updateParallax(0, 0);
    }
  }

  private handleMouseMove(event: MouseEvent): void {
    if (!this.diskPlayer) return;

    const rect = this.diskPlayer.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;

    // Calculate mouse position relative to center (normalized -1 to 1)
    const mouseX = (event.clientX - centerX) / (rect.width / 2);
    const mouseY = (event.clientY - centerY) / (rect.height / 2);

    this.updateParallax(mouseX, mouseY);
  }

  private updateParallax(mouseX: number, mouseY: number): void {
    if (!this.diskLayers) return;

    // Apply parallax effect with different intensities for each layer
    const parallaxIntensity = 8; // Maximum pixel movement
    const transformX = mouseX * parallaxIntensity;
    const transformY = mouseY * parallaxIntensity;

    this.diskLayers.style.transform = `translate(${transformX}px, ${transformY}px)`;
  }

  private handleClick(): void {
    this.togglePlayState();
  }

  private togglePlayState(): void {
    if (!this.diskPlayer) return;

    this.isPlaying = !this.isPlaying;
    
    if (this.isPlaying) {
      this.diskPlayer.classList.add('playing');
      this.startSpinningAnimation();
    } else {
      this.diskPlayer.classList.remove('playing');
      this.stopSpinningAnimation();
    }
  }

  protected startSpinningAnimation(): void {
    // Add additional spinning effects when playing
    const layers = this.diskPlayer?.querySelectorAll('.disk-layer');
    if (layers) {
      layers.forEach((layer, index) => {
        // Layer 3 corresponds to index 2 (0-indexed)
        if (index === 2) { // Layer 3 (l3.png) is the spinning disk
          (layer as HTMLElement).style.animation = 'disk-spin 4s linear infinite';
          (layer as HTMLElement).style.animationPlayState = 'running';
        }
      });
    }
  }

  protected stopSpinningAnimation(): void {
    const layers = this.diskPlayer?.querySelectorAll('.disk-layer');
    if (layers) {
      layers.forEach((layer, index) => {
        if (index === 2) { // Layer 3 (l3.png)
          (layer as HTMLElement).style.animationPlayState = 'paused';
        }
      });
    }
  }

  private setupIntersectionObserver(): void {
    if (!this.diskPlayer) return;

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            this.diskPlayer?.classList.add('visible');
          } else {
            this.diskPlayer?.classList.remove('visible');
          }
        });
      },
      {
        threshold: 0.3, // Trigger when 30% visible
        rootMargin: '0px 0px -100px 0px'
      }
    );

    observer.observe(this.diskPlayer);
  }

  // Public method to control play state from external components
  public setPlaying(playing: boolean): void {
    this.isPlaying = playing;
    if (this.diskPlayer) {
      if (playing) {
        this.diskPlayer.classList.add('playing');
        this.startSpinningAnimation();
      } else {
        this.diskPlayer.classList.remove('playing');
        this.stopSpinningAnimation();
      }
    }
  }

  // Public method to get current play state
  public getPlaying(): boolean {
    return this.isPlaying;
  }
}

// Enhanced animation controller with GSAP integration
class EnhancedDiskPlayerAnimator extends DiskPlayerAnimator {
  constructor(gsapInstance: any) {
    super();
    this.gsap = gsapInstance;
    this.setupEnhancedAnimations();
  }

  private setupEnhancedAnimations(): void {
    if (!this.diskPlayer || !this.gsap) return;

    // Enhanced hover animation - entire player moves as cohesive unit
    this.diskPlayer.addEventListener('mouseenter', () => {
      this.gsap.to(this.diskPlayer, {
        scale: 1.05,
        y: -10,
        rotation: 2,
        duration: 0.4,
        ease: 'power2.out'
      });
    });

    this.diskPlayer.addEventListener('mouseleave', () => {
      this.gsap.to(this.diskPlayer, {
        scale: 1,
        y: 0,
        rotation: 0,
        duration: 0.4,
        ease: 'power2.out'
      });
    });

    // Keep the spinning disk animation separate - only layer 3 spins
    this.diskPlayer.addEventListener('mouseenter', () => {
      if (this.isPlaying) return; // Don't interfere if playing
      
      const layer3 = this.diskPlayer?.querySelector('.layer-3');
      if (layer3) {
        this.gsap.to(layer3, {
          rotation: "+=720", // Double rotation for dramatic effect (relative)
          duration: 1.2,
          ease: 'power2.out'
        });
      }
    });

    // Enhanced click animation - entire player responds
    this.diskPlayer.addEventListener('click', () => {
      this.gsap.to(this.diskPlayer, {
        scale: 0.95,
        duration: 0.1,
        ease: 'power2.out',
        onComplete: () => {
          this.gsap.to(this.diskPlayer, {
            scale: this.diskPlayer?.classList.contains('playing') ? 1.05 : 1,
            y: this.diskPlayer?.classList.contains('playing') ? -5 : 0,
            rotation: this.diskPlayer?.classList.contains('playing') ? 1 : 0,
            duration: 0.3,
            ease: 'elastic.out(1, 0.5)'
          });
        }
      });
    });
  }
  // Override to use GSAP for smooth spinning
  protected startSpinningAnimation(): void {
    const layer3 = this.diskPlayer?.querySelector('.layer-3');
    if (layer3 && this.gsap) {
      // Clear CSS animation if present
      (layer3 as HTMLElement).style.animation = 'none';
      
      // Kill any existing tweens
      this.gsap.killTweensOf(layer3);
      
      // Get current rotation to ensure smooth start
      const currentRotation = this.gsap.getProperty(layer3, "rotation") || 0;
      
      // Start infinite rotation
      this.gsap.to(layer3, {
        rotation: currentRotation + 360,
        duration: 4,
        repeat: -1,
        ease: "none"
      });
    } else {
      super.startSpinningAnimation();
    }
  }

  protected stopSpinningAnimation(): void {
    const layer3 = this.diskPlayer?.querySelector('.layer-3');
    if (layer3 && this.gsap) {
      // Get current rotation
      const currentRotation = this.gsap.getProperty(layer3, "rotation") as number;
      
      // Kill the infinite spin
      this.gsap.killTweensOf(layer3);
      
      // Animate to a stop smoothly (spin 180-360 degrees more while decelerating)
      this.gsap.to(layer3, {
        rotation: currentRotation + 180 + Math.random() * 180,
        duration: 2,
        ease: "power2.out"
      });
    } else {
      super.stopSpinningAnimation();
    }
  }
}

// Initialize the disk player when DOM is loaded
// document.addEventListener('DOMContentLoaded', () => {
//   // Check if GSAP is available (it's loaded in the HTML)
//   if (typeof (window as any).gsap !== 'undefined') {
//     new EnhancedDiskPlayerAnimator((window as any).gsap);
//   } else {
//     new DiskPlayerAnimator();
//   }
// });

// Export for use in other modules
export { DiskPlayerAnimator, EnhancedDiskPlayerAnimator };
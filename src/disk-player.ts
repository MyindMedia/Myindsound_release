// Animated Disk Player Controller
// Static player - only layer-3 (disc) spins when playing

class DiskPlayerAnimator {
  protected diskPlayer: HTMLElement | null;
  protected isPlaying: boolean = false;
  protected gsap: any;

  constructor() {
    this.diskPlayer = document.querySelector('.animated-disk-player');
  }

  protected startSpinningAnimation(): void {
    const layer3 = this.diskPlayer?.querySelector('.layer-3') as HTMLElement;
    if (layer3) {
      // 100 RPM = 0.6s per rotation
      layer3.style.animation = 'disk-spin 0.6s linear infinite';
      layer3.style.animationPlayState = 'running';
    }
  }

  protected stopSpinningAnimation(): void {
    const layer3 = this.diskPlayer?.querySelector('.layer-3') as HTMLElement;
    if (layer3) {
      layer3.style.animationPlayState = 'paused';
    }
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

// Enhanced animation controller with GSAP for smooth spinning
class EnhancedDiskPlayerAnimator extends DiskPlayerAnimator {
  constructor(gsapInstance: any) {
    super();
    this.gsap = gsapInstance;
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

      // Start infinite rotation (100 RPM = 0.6s per rotation)
      this.gsap.to(layer3, {
        rotation: currentRotation + 360,
        duration: 0.6,
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

// Export for use in other modules
export { DiskPlayerAnimator, EnhancedDiskPlayerAnimator };

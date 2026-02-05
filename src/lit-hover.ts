// Lit album hover effects - Tilt + Spotlight combined
// Vanilla TypeScript implementation of TiltedCard + SpotlightCard

const gsap = (window as any).gsap;

export function initLitHover() {
  const container = document.getElementById('lit-album-container');

  if (!container) return;

  // Configuration (matching TiltedCard props)
  const rotateAmplitude = 12; // max tilt degrees
  const scaleOnHover = 1.05;
  const spotlightColor = 'rgba(0, 229, 255, 0.2)';

  // Ensure container has perspective for 3D transforms
  container.style.perspective = '800px';
  container.style.transformStyle = 'preserve-3d';

  // Get the album art image
  const albumArt = container.querySelector('.dynamic-album-art') as HTMLElement;
  if (albumArt) {
    albumArt.style.transformStyle = 'preserve-3d';
    albumArt.style.willChange = 'transform';
  }

  // Create spotlight overlay
  const spotlight = document.createElement('div');
  spotlight.id = 'lit-spotlight';
  spotlight.style.cssText = `
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: none;
    border-radius: 4px;
    opacity: 0;
    transition: opacity 0.5s ease-in-out;
  `;
  container.appendChild(spotlight);

  // Track state
  let position = { x: 0, y: 0 };

  const updateSpotlight = (opacity: number) => {
    spotlight.style.opacity = String(opacity);
    spotlight.style.background = `radial-gradient(circle at ${position.x}px ${position.y}px, ${spotlightColor}, transparent 80%)`;
  };

  container.addEventListener('mouseenter', () => {
    updateSpotlight(0.6);

    // Scale up on hover
    if (albumArt && gsap) {
      gsap.to(albumArt, {
        scale: scaleOnHover,
        duration: 0.4,
        ease: 'power2.out'
      });
    }
  });

  container.addEventListener('mousemove', (e) => {
    const rect = container.getBoundingClientRect();

    // Update spotlight position
    position = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
    updateSpotlight(0.6);

    // Calculate tilt based on mouse position
    const offsetX = e.clientX - rect.left - rect.width / 2;
    const offsetY = e.clientY - rect.top - rect.height / 2;

    const rotationX = (offsetY / (rect.height / 2)) * -rotateAmplitude;
    const rotationY = (offsetX / (rect.width / 2)) * rotateAmplitude;

    // Apply tilt with spring-like easing
    if (albumArt && gsap) {
      gsap.to(albumArt, {
        rotationX: rotationX,
        rotationY: rotationY,
        duration: 0.4,
        ease: 'power2.out'
      });
    }
  });

  container.addEventListener('mouseleave', () => {
    updateSpotlight(0);

    // Reset tilt and scale
    if (albumArt && gsap) {
      gsap.to(albumArt, {
        rotationX: 0,
        rotationY: 0,
        scale: 1,
        duration: 0.4,
        ease: 'power2.out'
      });
    }
  });
}

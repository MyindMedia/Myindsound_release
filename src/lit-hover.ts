
// import { gsap } from 'gsap';
const gsap = (window as any).gsap;

export function initLitHover() {
  const container = document.getElementById('lit-album-container');
  const glow = document.getElementById('lit-glow');
  const image = container?.querySelector('.main-album-art') as HTMLElement;

  if (!container || !glow || !image) return;

  // Ensure container has perspective
  container.style.perspective = '1000px';
  container.style.transformStyle = 'preserve-3d';

  // Make sure image is transformed
  // Make sure images are transformed
  const targets = container.querySelectorAll('.dynamic-album-art') as NodeListOf<HTMLElement>;
  targets.forEach(target => {
    target.style.transition = 'transform 0.1s ease-out';
  });

  // Glow transition
  glow.style.transition = 'opacity 0.3s ease';

  container.addEventListener('mousemove', (e) => {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    // Calculate percentage (-1 to 1)
    const xPct = (x / rect.width - 0.5) * 2;
    const yPct = (y / rect.height - 0.5) * 2;

    // Tilt calculation (max 15 deg)
    const tiltX = -yPct * 15;
    const tiltY = xPct * 15;

    // Apply tilt to image (not container, to avoid messing up layout flow if possible, 
    // but applying to container is usually better for 3D children)
    // Actually, applying to the image is safer if the container is part of a grid.
    // But let's apply to the image wrapper or the image itself.
    // The image has class .main-album-art

    // Apply tilt to all dynamic layers (album art + plastic)
    const targets = container.querySelectorAll('.dynamic-album-art');

    gsap.to(targets, {
      rotationX: tiltX,
      rotationY: tiltY,
      duration: 0.5,
      ease: 'power2.out'
    });

    // Update glow position
    // Move glow opposite to light source or follow mouse?
    // "yellow glow in the background should dynamically move and react to the tilt"
    // Usually glow follows the mouse (light source).
    const glowX = 50 + (xPct * 20); // Move slightly
    const glowY = 50 + (yPct * 20);

    glow.style.background = `radial-gradient(circle at ${glowX}% ${glowY}%, rgba(255, 215, 0, 0.6), transparent 60%)`;
    glow.style.opacity = '1';
  });

  container.addEventListener('mouseleave', () => {
    // Reset
    const targets = container.querySelectorAll('.dynamic-album-art');
    gsap.to(targets, {
      rotationX: 0,
      rotationY: 0,
      duration: 0.5,
      ease: 'power2.out'
    });

    glow.style.opacity = '0';
  });
}

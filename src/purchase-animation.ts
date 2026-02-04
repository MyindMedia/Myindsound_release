
// import { gsap } from 'gsap';
const gsap = (window as any).gsap;

export class PurchaseAnimationController {
    private overlay: HTMLElement | null = null;
    private onComplete: () => void;

    constructor(onComplete: () => void) {
        this.onComplete = onComplete;
    }

    public start() {
        this.createOverlay();
        this.animate();
    }

    private createOverlay() {
        // Create overlay container
        this.overlay = document.createElement('div');
        this.overlay.id = 'purchase-overlay';
        this.overlay.style.position = 'fixed';
        this.overlay.style.top = '0';
        this.overlay.style.left = '0';
        this.overlay.style.width = '100%';
        this.overlay.style.height = '100%';
        this.overlay.style.backgroundColor = 'rgba(0, 0, 0, 0.9)';
        this.overlay.style.zIndex = '9999';
        this.overlay.style.display = 'flex';
        this.overlay.style.alignItems = 'center';
        this.overlay.style.justifyContent = 'center';
        this.overlay.style.opacity = '0'; // Start hidden for fade in
        this.overlay.style.perspective = '1000px';

        // Clone the Lit album art
        // We construct it manually to ensure we have the right elements for animation
        const container = document.createElement('div');
        container.style.position = 'relative';
        container.style.width = '300px'; // Initial size, will scale up
        container.style.height = '300px';
        container.style.transformStyle = 'preserve-3d';

        // Album Art
        const img = document.createElement('img');
        img.src = '/assets/images/lit-poster.png';
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.borderRadius = '4px';
        img.style.position = 'absolute';
        img.style.top = '0';
        img.style.left = '0';

        // Plastic Wrapper
        const wrapper = document.createElement('div');
        wrapper.id = 'anim-wrapper';
        wrapper.style.position = 'absolute';
        wrapper.style.top = '0';
        wrapper.style.left = '0';
        wrapper.style.width = '100%';
        wrapper.style.height = '100%';
        wrapper.style.pointerEvents = 'none';

        const wrapperImg = document.createElement('img');
        wrapperImg.src = '/assets/images/buypeeloverlay.png';
        wrapperImg.style.width = '100%';
        wrapperImg.style.height = '100%';
        wrapperImg.style.objectFit = 'cover';

        wrapper.appendChild(wrapperImg);
        container.appendChild(img);
        container.appendChild(wrapper);
        this.overlay.appendChild(container);

        document.body.appendChild(this.overlay);
    }

    private animate() {
        if (!this.overlay) return;

        const container = this.overlay.querySelector('div') as HTMLElement;
        const wrapper = this.overlay.querySelector('#anim-wrapper') as HTMLElement;

        const tl = gsap.timeline({
            onComplete: () => {
                this.cleanup();
                this.onComplete();
            }
        });

        // 1. Fade in overlay and Scale Up Album
        tl.to(this.overlay, { opacity: 1, duration: 0.5 })
            .fromTo(container,
                { scale: 0.5, rotationY: -180 },
                { scale: 1.5, rotationY: 0, duration: 1.5, ease: 'back.out(1.2)' }
            );

        // 2. Shake "Unwrap" Effect
        tl.to(container, {
            x: '+=10',
            rotation: '+=2',
            duration: 0.1,
            yoyo: true,
            repeat: 10,
            ease: 'sine.inOut'
        }, '-=0.2');

        // 3. Unwrap (Fade out plastic + slight expansion of wrapper)
        tl.to(wrapper, {
            opacity: 0,
            scale: 1.2, // Fly off/expand
            duration: 0.8,
            ease: 'power2.in'
        }, '-=0.5'); // Overlap with shake

        // 4. Pause to admire artwork
        tl.to({}, { duration: 1 });

        // 5. Phase out to Dashboard
        tl.to(container, {
            scale: 0.8,
            opacity: 0,
            y: 50,
            duration: 0.8,
            ease: 'power2.in'
        });

        tl.to(this.overlay, {
            opacity: 0,
            duration: 0.5
        }, '-=0.4');
    }

    private cleanup() {
        if (this.overlay && this.overlay.parentNode) {
            this.overlay.parentNode.removeChild(this.overlay);
        }
    }
}

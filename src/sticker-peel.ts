/**
 * StickerPeel - Vanilla TypeScript Port
 * Ported from reactbits.dev StickerPeel-TS-TW
 */

declare const gsap: any;
declare const Draggable: any;

interface StickerPeelOptions {
  container: HTMLElement | string | null;
  imageSrc: string;
  rotate?: number;
  peelBackHoverPct?: number;
  peelBackActivePct?: number;
  peelEasing?: string;
  peelHoverEasing?: string;
  width?: number;
  shadowIntensity?: number;
  lightingIntensity?: number;
  peelDirection?: number;
  className?: string;
  draggable?: boolean;
}

export class StickerPeel {
  private options: Required<Omit<StickerPeelOptions, 'container'>> & { container: HTMLElement | string | null };
  private container: HTMLElement | null = null;
  private dragTarget: HTMLDivElement | null = null;
  private stickerContainer: HTMLDivElement | null = null;
  private stickerMain: HTMLDivElement | null = null;
  private flap: HTMLDivElement | null = null;
  private shadowFlap: HTMLDivElement | null = null;
  private pointLight: SVGFEPointLightElement | null = null;
  private pointLightFlipped: SVGFEPointLightElement | null = null;
  private draggableInstance: any = null;
  private styleEl: HTMLStyleElement | null = null;
  private filterId: string;
  private defaultPadding = 12;

  constructor(options: StickerPeelOptions) {
    this.filterId = 'sp-' + Math.random().toString(36).slice(2, 8);
    this.options = {
      rotate: 30,
      peelBackHoverPct: 30,
      peelBackActivePct: 40,
      peelEasing: 'power3.out',
      peelHoverEasing: 'power2.out',
      width: 200,
      shadowIntensity: 0.6,
      lightingIntensity: 0.1,
      peelDirection: 0,
      className: '',
      draggable: true,
      ...options
    };

    this.init();
  }

  private init() {
    if (!this.options.container) {
      console.error('StickerPeel: container element is required');
      return;
    }

    this.container = typeof this.options.container === 'string'
      ? document.querySelector(this.options.container)
      : this.options.container;

    if (!this.container) {
      console.error('StickerPeel: container element not found');
      return;
    }

    this.createElements();
    this.setupStyles();
    this.setupLighting();
    this.setupTouch();
    if (this.options.draggable) {
      this.setupDraggable();
    }
  }

  private createElements() {
    const p = this.defaultPadding;
    const { peelDirection, rotate, imageSrc, lightingIntensity, shadowIntensity, className } = this.options;
    const fid = this.filterId;

    // Drag target (outermost wrapper)
    this.dragTarget = document.createElement('div');
    this.dragTarget.className = `sticker-peel-draggable ${className}`;
    this.dragTarget.style.position = 'absolute';
    this.dragTarget.style.cursor = 'grab';
    this.dragTarget.style.top = '0';
    this.dragTarget.style.left = '0';
    this.dragTarget.style.width = '100%';
    this.dragTarget.style.height = '100%';
    this.dragTarget.style.zIndex = '100';

    // CSS custom properties
    this.dragTarget.style.setProperty('--sticker-rotate', `${rotate}deg`);
    this.dragTarget.style.setProperty('--sticker-p', `${p}px`);
    this.dragTarget.style.setProperty('--sticker-peelback-hover', `${this.options.peelBackHoverPct}%`);
    this.dragTarget.style.setProperty('--sticker-peelback-active', `${this.options.peelBackActivePct}%`);
    this.dragTarget.style.setProperty('--sticker-width', `${this.options.width}px`);
    this.dragTarget.style.setProperty('--peel-direction', `${peelDirection}deg`);
    this.dragTarget.style.setProperty('--sticker-start', `calc(-1 * ${p}px)`);
    this.dragTarget.style.setProperty('--sticker-end', `calc(100% + ${p}px)`);

    // SVG filters (unique IDs to avoid collisions)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.pointerEvents = 'none';

    svg.innerHTML = `
      <defs>
        <filter id="${fid}-pointLight">
          <feGaussianBlur stdDeviation="1" result="blur"/>
          <feSpecularLighting result="spec" in="blur" specularExponent="100" specularConstant="${lightingIntensity}" lightingColor="white">
            <fePointLight x="100" y="100" z="300"/>
          </feSpecularLighting>
          <feComposite in="spec" in2="SourceGraphic" result="lit"/>
          <feComposite in="lit" in2="SourceAlpha" operator="in"/>
        </filter>
        <filter id="${fid}-pointLightFlipped">
          <feGaussianBlur stdDeviation="10" result="blur"/>
          <feSpecularLighting result="spec" in="blur" specularExponent="100" specularConstant="${lightingIntensity * 7}" lightingColor="white">
            <fePointLight x="100" y="100" z="300"/>
          </feSpecularLighting>
          <feComposite in="spec" in2="SourceGraphic" result="lit"/>
          <feComposite in="lit" in2="SourceAlpha" operator="in"/>
        </filter>
        <filter id="${fid}-dropShadow">
          <feDropShadow dx="2" dy="4" stdDeviation="${3 * shadowIntensity}" floodColor="black" floodOpacity="${shadowIntensity}"/>
        </filter>
        <filter id="${fid}-expandAndFill">
          <feOffset dx="0" dy="0" in="SourceAlpha" result="shape"/>
          <feFlood floodColor="rgb(179,179,179)" result="flood"/>
          <feComposite operator="in" in="flood" in2="shape"/>
        </filter>
      </defs>
    `;

    this.pointLight = svg.querySelector(`#${fid}-pointLight fePointLight`);
    this.pointLightFlipped = svg.querySelector(`#${fid}-pointLightFlipped fePointLight`);

    // Sticker container (rotated by peelDirection)
    this.stickerContainer = document.createElement('div');
    this.stickerContainer.className = 'sticker-peel-container';
    this.stickerContainer.style.position = 'relative';
    this.stickerContainer.style.transform = `rotate(${peelDirection}deg)`;
    this.stickerContainer.style.transformOrigin = 'center';
    this.stickerContainer.style.width = '100%';
    this.stickerContainer.style.height = '100%';
    this.stickerContainer.style.userSelect = 'none';
    this.stickerContainer.style.touchAction = 'none';

    const imageRotation = `rotate(${rotate - peelDirection}deg)`;

    // --- MAIN layer (visible sticker face) ---
    this.stickerMain = document.createElement('div');
    this.stickerMain.className = 'sticker-peel-main';
    this.stickerMain.style.clipPath = 'polygon(var(--sticker-start) var(--sticker-start), var(--sticker-end) var(--sticker-start), var(--sticker-end) var(--sticker-end), var(--sticker-start) var(--sticker-end))';
    this.stickerMain.style.transition = 'clip-path 0.6s ease-out';
    this.stickerMain.style.filter = `url(#${fid}-dropShadow)`;
    this.stickerMain.style.willChange = 'clip-path, transform';

    const mainLighting = document.createElement('div');
    mainLighting.style.filter = `url(#${fid}-pointLight)`;

    const mainImg = document.createElement('img');
    mainImg.src = imageSrc;
    mainImg.className = 'sticker-peel-image';
    mainImg.draggable = false;
    mainImg.style.display = 'block';
    mainImg.style.width = '100%';
    mainImg.style.height = '100%';
    mainImg.style.objectFit = 'cover';
    mainImg.style.transform = imageRotation;
    mainImg.oncontextmenu = (e) => e.preventDefault();

    mainLighting.appendChild(mainImg);
    this.stickerMain.appendChild(mainLighting);

    // --- SHADOW layer (blurred dark copy of flap) ---
    const shadowWrapper = document.createElement('div');
    shadowWrapper.className = 'sticker-peel-shadow';
    shadowWrapper.style.position = 'absolute';
    shadowWrapper.style.top = '4px';
    shadowWrapper.style.left = '2px';
    shadowWrapper.style.width = '100%';
    shadowWrapper.style.height = '100%';
    shadowWrapper.style.opacity = '0.4';
    shadowWrapper.style.filter = 'brightness(0) blur(8px)';
    shadowWrapper.style.pointerEvents = 'none';

    this.shadowFlap = document.createElement('div');
    this.shadowFlap.className = 'sticker-peel-flap sticker-peel-shadow-flap';
    this.shadowFlap.style.position = 'absolute';
    this.shadowFlap.style.width = '100%';
    this.shadowFlap.style.height = '100%';
    this.shadowFlap.style.left = '0';
    this.shadowFlap.style.top = `calc(-100% - ${p}px - ${p}px)`;
    this.shadowFlap.style.clipPath = 'polygon(var(--sticker-start) var(--sticker-start), var(--sticker-end) var(--sticker-start), var(--sticker-end) var(--sticker-start), var(--sticker-start) var(--sticker-start))';
    this.shadowFlap.style.transform = 'scaleY(-1)';
    this.shadowFlap.style.transition = 'all 0.6s ease-out';
    this.shadowFlap.style.willChange = 'clip-path, transform';

    const shadowImg = document.createElement('img');
    shadowImg.src = imageSrc;
    shadowImg.draggable = false;
    shadowImg.style.display = 'block';
    shadowImg.style.width = '100%';
    shadowImg.style.height = '100%';
    shadowImg.style.objectFit = 'cover';
    shadowImg.style.transform = imageRotation;
    shadowImg.style.filter = `url(#${fid}-expandAndFill)`;
    shadowImg.oncontextmenu = (e) => e.preventDefault();

    this.shadowFlap.appendChild(shadowImg);
    shadowWrapper.appendChild(this.shadowFlap);

    // --- FLAP layer (peeled-back underside) ---
    this.flap = document.createElement('div');
    this.flap.className = 'sticker-peel-flap';
    this.flap.style.position = 'absolute';
    this.flap.style.width = '100%';
    this.flap.style.height = '100%';
    this.flap.style.left = '0';
    this.flap.style.top = `calc(-100% - ${p}px - ${p}px)`;
    this.flap.style.clipPath = 'polygon(var(--sticker-start) var(--sticker-start), var(--sticker-end) var(--sticker-start), var(--sticker-end) var(--sticker-start), var(--sticker-start) var(--sticker-start))';
    this.flap.style.transform = 'scaleY(-1)';
    this.flap.style.transition = 'all 0.6s ease-out';
    this.flap.style.willChange = 'clip-path, transform';

    const flapLighting = document.createElement('div');
    flapLighting.style.filter = `url(#${fid}-pointLightFlipped)`;

    const flapImg = document.createElement('img');
    flapImg.src = imageSrc;
    flapImg.draggable = false;
    flapImg.style.display = 'block';
    flapImg.style.width = '100%';
    flapImg.style.height = '100%';
    flapImg.style.objectFit = 'cover';
    flapImg.style.transform = imageRotation;
    flapImg.style.filter = `url(#${fid}-expandAndFill)`;
    flapImg.oncontextmenu = (e) => e.preventDefault();

    flapLighting.appendChild(flapImg);
    this.flap.appendChild(flapLighting);

    // Assemble
    this.stickerContainer.appendChild(this.stickerMain);
    this.stickerContainer.appendChild(shadowWrapper);
    this.stickerContainer.appendChild(this.flap);

    this.dragTarget.appendChild(svg);
    this.dragTarget.appendChild(this.stickerContainer);
    this.container!.appendChild(this.dragTarget);
  }

  private setupStyles() {
    this.styleEl = document.createElement('style');
    this.styleEl.textContent = `
      /* Hover state */
      .sticker-peel-container:hover .sticker-peel-main,
      .sticker-peel-container.touch-active .sticker-peel-main {
        clip-path: polygon(
          var(--sticker-start) var(--sticker-peelback-hover),
          var(--sticker-end) var(--sticker-peelback-hover),
          var(--sticker-end) var(--sticker-end),
          var(--sticker-start) var(--sticker-end)
        ) !important;
      }
      .sticker-peel-container:hover .sticker-peel-flap,
      .sticker-peel-container.touch-active .sticker-peel-flap {
        clip-path: polygon(
          var(--sticker-start) var(--sticker-start),
          var(--sticker-end) var(--sticker-start),
          var(--sticker-end) var(--sticker-peelback-hover),
          var(--sticker-start) var(--sticker-peelback-hover)
        ) !important;
        top: calc(-100% + 2 * var(--sticker-peelback-hover) - 1px) !important;
      }

      /* Active/pressed state */
      .sticker-peel-container:active .sticker-peel-main {
        clip-path: polygon(
          var(--sticker-start) var(--sticker-peelback-active),
          var(--sticker-end) var(--sticker-peelback-active),
          var(--sticker-end) var(--sticker-end),
          var(--sticker-start) var(--sticker-end)
        ) !important;
      }
      .sticker-peel-container:active .sticker-peel-flap {
        clip-path: polygon(
          var(--sticker-start) var(--sticker-start),
          var(--sticker-end) var(--sticker-start),
          var(--sticker-end) var(--sticker-peelback-active),
          var(--sticker-start) var(--sticker-peelback-active)
        ) !important;
        top: calc(-100% + 2 * var(--sticker-peelback-active) - 1px) !important;
      }
    `;
    document.head.appendChild(this.styleEl);
  }

  private setupLighting() {
    if (!this.container) return;

    this.container.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.container!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this.pointLight) {
        this.pointLight.setAttribute('x', String(x));
        this.pointLight.setAttribute('y', String(y));
      }

      const normalizedAngle = Math.abs(this.options.peelDirection % 360);
      if (this.pointLightFlipped) {
        if (normalizedAngle !== 180) {
          this.pointLightFlipped.setAttribute('x', String(x));
          this.pointLightFlipped.setAttribute('y', String(rect.height - y));
        } else {
          this.pointLightFlipped.setAttribute('x', '-1000');
          this.pointLightFlipped.setAttribute('y', '-1000');
        }
      }
    });
  }

  private setupTouch() {
    if (!this.stickerContainer) return;

    this.stickerContainer.addEventListener('touchstart', () => {
      this.stickerContainer!.classList.add('touch-active');
    });

    const removeTouchActive = () => {
      this.stickerContainer!.classList.remove('touch-active');
    };

    this.stickerContainer.addEventListener('touchend', removeTouchActive);
    this.stickerContainer.addEventListener('touchcancel', removeTouchActive);
  }

  private setupDraggable() {
    if (typeof Draggable === 'undefined' || !this.dragTarget) return;

    this.draggableInstance = Draggable.create(this.dragTarget, {
      type: 'x,y',
      bounds: this.container,
      inertia: true,
      onDrag: () => {
        const rot = gsap.utils.clamp(-24, 24, this.draggableInstance.deltaX * 0.4);
        gsap.to(this.dragTarget, { rotation: rot, duration: 0.15, ease: 'power1.out' });
      },
      onDragEnd: () => {
        gsap.to(this.dragTarget, { rotation: 0, duration: 0.8, ease: 'power2.out' });
      }
    })[0];
  }

  public resize(width: number, height: number) {
    if (this.dragTarget) {
      this.dragTarget.style.width = width + 'px';
      this.dragTarget.style.height = height + 'px';
    }
  }

  public getMain(): HTMLElement | null {
    return this.stickerMain;
  }

  public getFlap(): HTMLElement | null {
    return this.flap;
  }

  public getShadowFlap(): HTMLElement | null {
    return this.shadowFlap;
  }

  public getDragTarget(): HTMLElement | null {
    return this.dragTarget;
  }

  public getStickerContainer(): HTMLElement | null {
    return this.stickerContainer;
  }

  public destroy() {
    if (this.draggableInstance) {
      this.draggableInstance.kill();
    }
    if (this.styleEl && this.styleEl.parentNode) {
      this.styleEl.parentNode.removeChild(this.styleEl);
    }
    if (this.dragTarget && this.dragTarget.parentNode) {
      this.dragTarget.parentNode.removeChild(this.dragTarget);
    }
  }
}

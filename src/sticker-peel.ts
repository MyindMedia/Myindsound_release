/**
 * StickerPeel - TypeScript Version
 * Ported from StickerPeel.js (Pray project)
 */

declare const gsap: any;
declare const Draggable: any;

interface StickerPeelOptions {
  imageSrc: string;
  rotate?: number;
  peelBackHoverPct?: number;
  peelBackActivePct?: number;
  width?: number;
  shadowIntensity?: number;
  lightingIntensity?: number;
  peelDirection?: number;
  className?: string;
  container: HTMLElement | string | null;
}

export class StickerPeel {
  private options: StickerPeelOptions;
  private container: HTMLElement | null = null;
  private dragTarget: HTMLDivElement | null = null;
  private stickerContainer: HTMLDivElement | null = null;
  private stickerMain: HTMLDivElement | null = null;
  private flap: HTMLDivElement | null = null;
  private pointLight: any = null;
  private draggableInstance: any = null;

  constructor(options: StickerPeelOptions) {
    this.options = {
      rotate: 30,
      peelBackHoverPct: 30,
      peelBackActivePct: 40,
      width: 200,
      shadowIntensity: 0.6,
      lightingIntensity: 0.1,
      peelDirection: 0,
      className: '',
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
    this.setupEventListeners();
    this.setupDraggable();
  }

  private createElements() {
    const containerRect = this.container!.getBoundingClientRect();
    const stickerWidth = containerRect.width;
    const stickerHeight = containerRect.height;

    this.dragTarget = document.createElement('div');
    this.dragTarget.className = `sticker-peel-draggable ${this.options.className}`;
    this.dragTarget.style.width = stickerWidth + 'px';
    this.dragTarget.style.height = stickerHeight + 'px';

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('width', '0');
    svg.setAttribute('height', '0');
    svg.style.position = 'absolute';
    svg.style.top = '0';
    svg.style.left = '0';
    svg.style.pointerEvents = 'none'; // Ensure it doesn't block clicks

    const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    const pointLightFilter = this.createFilter('pointLight', `
      <feGaussianBlur stdDeviation="1" result="blur" />
      <feSpecularLighting result="spec" in="blur" specularExponent="100" specularConstant="${this.options.lightingIntensity}" lightingColor="white">
        <fePointLight x="100" y="100" z="300" />
      </feSpecularLighting>
      <feComposite in="spec" in2="SourceGraphic" result="lit" />
      <feComposite in="lit" in2="SourceAlpha" operator="in" />
    `);

    const pointLightFlippedFilter = this.createFilter('pointLightFlipped', `
      <feGaussianBlur stdDeviation="10" result="blur" />
      <feSpecularLighting result="spec" in="blur" specularExponent="100" specularConstant="${(this.options.lightingIntensity || 0.1) * 7}" lightingColor="white">
        <fePointLight x="100" y="100" z="300" />
      </feSpecularLighting>
      <feComposite in="spec" in2="SourceGraphic" result="lit" />
      <feComposite in="lit" in2="SourceAlpha" operator="in" />
    `);

    const dropShadowFilter = this.createFilter('dropShadow', `
      <feDropShadow dx="2" dy="4" stdDeviation="${3 * (this.options.shadowIntensity || 0.6)}" floodColor="black" floodOpacity="${this.options.shadowIntensity}" />
    `);

    const expandAndFillFilter = this.createFilter('expandAndFill', `
      <feOffset dx="0" dy="0" in="SourceAlpha" result="shape" />
      <feFlood floodColor="rgb(179,179,179)" result="flood" />
      <feComposite operator="in" in="flood" in2="shape" />
    `);

    defs.appendChild(pointLightFilter);
    defs.appendChild(pointLightFlippedFilter);
    defs.appendChild(dropShadowFilter);
    defs.appendChild(expandAndFillFilter);
    svg.appendChild(defs);

    this.stickerContainer = document.createElement('div');
    this.stickerContainer.className = 'sticker-peel-container';

    this.stickerMain = document.createElement('div');
    this.stickerMain.className = 'sticker-peel-main';
    const stickerLighting = document.createElement('div');
    stickerLighting.className = 'sticker-peel-lighting';
    const stickerImage = document.createElement('img');
    stickerImage.src = this.options.imageSrc;
    stickerImage.className = 'sticker-peel-image';
    stickerImage.draggable = false;
    stickerLighting.appendChild(stickerImage);
    this.stickerMain.appendChild(stickerLighting);

    this.flap = document.createElement('div');
    this.flap.className = 'sticker-peel-flap';
    const flapLighting = document.createElement('div');
    flapLighting.className = 'sticker-peel-flap-lighting';
    const flapImage = document.createElement('img');
    flapImage.src = this.options.imageSrc;
    flapImage.className = 'sticker-peel-flap-image';
    flapImage.draggable = false;
    flapLighting.appendChild(flapImage);
    this.flap.appendChild(flapLighting);

    this.stickerContainer.appendChild(this.stickerMain);
    this.stickerContainer.appendChild(this.flap);
    this.dragTarget.appendChild(svg);
    this.dragTarget.appendChild(this.stickerContainer);
    this.container!.appendChild(this.dragTarget);

    this.pointLight = svg.querySelector('fePointLight');
  }

  private createFilter(id: string, innerHTML: string) {
    const filter = document.createElementNS('http://www.w3.org/2000/svg', 'filter');
    filter.setAttribute('id', id);
    filter.innerHTML = innerHTML;
    return filter;
  }

  private setupStyles() {
    const style = document.createElement('style');
    style.textContent = `
      .sticker-peel-draggable {
        position: absolute;
        cursor: grab;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        z-index: 100;
      }
      .sticker-peel-container {
        position: relative;
        transform: rotate(${this.options.peelDirection}deg);
        transform-origin: center;
        width: 100%;
        height: 100%;
      }
      .sticker-peel-main {
        clip-path: polygon(0% 0%, 100% 0%, 100% 100%, 0% 100%);
        transition: clip-path 0.6s ease-out;
        filter: url(#dropShadow);
      }
      .sticker-peel-main > * {
          transform: rotate(calc(-1 * ${this.options.peelDirection}deg));
      }
      .sticker-peel-lighting { filter: url(#pointLight); }
      .sticker-peel-image { width: 100%; height: 100%; display: block; object-fit: cover; }
      
      .sticker-peel-flap {
        position: absolute;
        width: 100%;
        height: 100%;
        left: 0;
        top: -100%;
        clip-path: polygon(0% 0%, 100% 0%, 100% 0%, 0% 0%);
        transform: scaleY(-1);
        transition: all 0.6s ease-out;
      }
      .sticker-peel-flap > * {
          transform: rotate(calc(-1 * ${this.options.peelDirection}deg));
      }
      .sticker-peel-flap-lighting { filter: url(#pointLightFlipped); }
      .sticker-peel-flap-image { width: 100%; height: 100%; display: block; object-fit: cover; filter: url(#expandAndFill); }

      .sticker-peel-container:hover .sticker-peel-main {
        clip-path: polygon(0% ${this.options.peelBackHoverPct}%, 100% ${this.options.peelBackHoverPct}%, 100% 100%, 0% 100%) !important;
      }
      .sticker-peel-container:hover .sticker-peel-flap {
        clip-path: polygon(0% 0%, 100% 0%, 100% ${this.options.peelBackHoverPct}%, 0% ${this.options.peelBackHoverPct}%) !important;
        top: calc(-100% + 2 * ${this.options.peelBackHoverPct}% - 1px) !important;
      }
    `;
    document.head.appendChild(style);
  }

  private setupEventListeners() {
    this.container!.addEventListener('mousemove', (e: MouseEvent) => {
      const rect = this.container!.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      if (this.pointLight) {
        this.pointLight.setAttribute('x', x.toString());
        this.pointLight.setAttribute('y', y.toString());
      }
    });
  }

  private setupDraggable() {
    if (typeof Draggable === 'undefined') return;
    this.draggableInstance = Draggable.create(this.dragTarget, {
      type: 'x,y',
      bounds: this.container,
      inertia: true,
      onDrag: () => {
        const rot = gsap.utils.clamp(-24, 24, this.draggableInstance.deltaX * 0.4);
        gsap.to(this.dragTarget, { rotation: rot, duration: 0.15 });
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

  public destroy() {
    if (this.draggableInstance) {
      this.draggableInstance.kill();
    }
    // Remove event listeners if we added any global ones (current ones are on container)
  }
}

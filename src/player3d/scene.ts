import {
  Color,
  NeutralToneMapping,
  Clock,
  Group,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { CRT_PASS } from './shaders';

export type FrameCallback = (dt: number, elapsed: number) => void;

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

const FOV = 32;
const MAX_YAW = (25 * Math.PI) / 180;
const MAX_PITCH = (15 * Math.PI) / 180;
const REST_PITCH = 0.07;
const IDLE_FPS_INTERVAL = 1 / 30;

export class PlayerScene {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(FOV, 1, 0.05, 240);
  readonly deckRoot = new Group();
  readonly reducedMotion: boolean;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private crt: ShaderPass;
  private clock = new Clock();
  private callbacks = new Set<FrameCallback>();
  private resizeCallbacks = new Set<() => void>();
  private running = false;
  private frameHandle = 0;
  private tiltTarget = new Vector2();
  private tilt = new Vector2();
  private tiltVelocity = new Vector2();
  private dragging = false;
  private tiltEnabled = true;
  private lowPower = false;
  private idleThrottle = false;
  private sinceRender = 0;
  private slowFrames = 0;
  private deckBounds: Bounds = { minX: -0.5, maxX: 0.5, minY: -0.85, maxY: 0.62 };
  private frameElement: HTMLElement;
  private baseDistance = 4;
  private dolly = 1;
  private lookOffsetY = 0;
  readonly coarsePointer: boolean;

  constructor(canvas: HTMLCanvasElement, frameElement: HTMLElement, reducedMotion: boolean) {
    this.reducedMotion = reducedMotion;
    this.frameElement = frameElement;
    this.coarsePointer = window.matchMedia('(pointer: coarse)').matches;
    this.renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, this.coarsePointer ? 1.5 : 2));
    this.scene.background = new Color('#04060B');
    this.scene.add(this.deckRoot);
    this.scene.add(this.camera);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new Vector2(256, 256), 0.5, 0.55, 0.86);
    this.composer.addPass(this.bloom);
    this.crt = new ShaderPass(CRT_PASS);
    this.crt.uniforms.uMotion.value = reducedMotion ? 0 : 1;
    this.composer.addPass(this.crt);
    this.composer.addPass(new OutputPass());

    this.resize = this.resize.bind(this);
    window.addEventListener('resize', this.resize);
    document.addEventListener('visibilitychange', () => (document.hidden ? this.stop() : this.start()));
    this.bindTilt(canvas);
    this.resize();
  }

  onFrame(callback: FrameCallback): () => void {
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }

  onResize(callback: () => void): void {
    this.resizeCallbacks.add(callback);
    callback();
  }

  setDeckBounds(bounds: Bounds): void {
    this.deckBounds = bounds;
    this.resize();
  }

  /** 1 = framed; below 1 moves the camera closer. */
  setDolly(value: number): void {
    this.dolly = value;
    this.updateCamera();
  }

  getDolly(): number {
    return this.dolly;
  }

  /** Raises the camera and its target (world units), e.g. to watch the cartridge above the deck. */
  setLookOffset(value: number): void {
    this.lookOffsetY = value;
    this.updateCamera();
  }

  getLookOffset(): number {
    return this.lookOffsetY;
  }

  /** Off while the cartridge is out for inspection: the deck settles to rest and drags go to the inspector. */
  setTiltEnabled(enabled: boolean): void {
    this.tiltEnabled = enabled;
    if (!enabled) {
      this.dragging = false;
      this.tiltTarget.set(0, 0);
    }
  }

  /** Bloom strength; the opening scene turns it down so the wrapped package doesn't blow out. */
  setBloomStrength(value: number): void {
    this.bloom.strength = value;
  }

  /** CRT pass strength, 0..1 (scanlines and fringe). */
  setCrtIntensity(value: number): void {
    this.crt.uniforms.uIntensity.value = value;
  }

  /** Distance from the camera to the deck face (z = 0). */
  getDeckDistance(): number {
    return this.baseDistance * this.dolly;
  }

  /** The HUD frame the deck is framed into, in CSS px. */
  getFrameRect(): DOMRect {
    return this.frameElement.getBoundingClientRect();
  }

  setIdleThrottle(enabled: boolean): void {
    this.idleThrottle = enabled;
  }

  resize(): void {
    const width = window.innerWidth;
    const height = window.innerHeight;
    this.renderer.setSize(width, height, false);
    this.composer.setSize(width, height);
    this.bloom.resolution.set(width / 2, height / 2);
    this.crt.uniforms.uResolution.value = [width, height];
    this.camera.aspect = width / height;

    const rect = this.frameElement.getBoundingClientRect();
    const frameW = Math.max(40, rect.width);
    const frameH = Math.max(40, rect.height);
    const tanHalf = Math.tan((FOV * Math.PI) / 360);
    const deckW = this.deckBounds.maxX - this.deckBounds.minX;
    const deckH = this.deckBounds.maxY - this.deckBounds.minY;
    // How much of the HUD's frame the deck fills. On a phone it stays inside it, with room for the tilt;
    // on a desktop it is deliberately bigger than the box, because the deck is what people came for and
    // the frame is only a layout hint (there is nothing to collide with above or below it).
    const fill = width <= 900 ? 0.94 : 1.22;
    const byHeight = (deckH * height) / (2 * tanHalf * frameH * fill);
    const byWidth = (deckW * height) / (2 * tanHalf * frameW * fill);
    // ...but never so close that the deck runs off the top and bottom of a tall window.
    const byWindow = deckH / (2 * tanHalf * 0.86);
    this.baseDistance = Math.max(byHeight, byWidth, byWindow);

    const frameCenterX = rect.left + rect.width / 2;
    const frameCenterY = rect.top + rect.height / 2;
    this.camera.setViewOffset(width, height, width / 2 - frameCenterX, height / 2 - frameCenterY, width, height);
    this.updateCamera();
    for (const callback of this.resizeCallbacks) callback();
  }

  private updateCamera(): void {
    const centerY = (this.deckBounds.minY + this.deckBounds.maxY) / 2 + this.lookOffsetY;
    const centerX = (this.deckBounds.minX + this.deckBounds.maxX) / 2;
    this.camera.position.set(centerX, centerY, this.baseDistance * this.dolly);
    this.camera.lookAt(new Vector3(centerX, centerY, 0));
    this.camera.updateProjectionMatrix();
  }

  /** World → CSS pixels, for anchoring HUD elements to the deck. */
  project(point: Vector3): { x: number; y: number } {
    const world = point.clone();
    this.deckRoot.localToWorld(world);
    world.project(this.camera);
    return { x: ((world.x + 1) / 2) * window.innerWidth, y: ((1 - world.y) / 2) * window.innerHeight };
  }

  private bindTilt(canvas: HTMLCanvasElement): void {
    if (this.reducedMotion) return;
    if (!this.coarsePointer) {
      window.addEventListener('pointermove', (event) => {
        if (!this.tiltEnabled) return;
        this.tiltTarget.set((event.clientX / window.innerWidth) * 2 - 1, (event.clientY / window.innerHeight) * 2 - 1);
      });
      return;
    }
    let startX = 0;
    let startY = 0;
    canvas.addEventListener('pointerdown', (event) => {
      if (!this.tiltEnabled) return;
      this.dragging = true;
      startX = event.clientX;
      startY = event.clientY;
    });
    window.addEventListener('pointermove', (event) => {
      if (!this.dragging) return;
      this.tiltTarget.set(
        Math.max(-1, Math.min(1, ((event.clientX - startX) / window.innerWidth) * 3)),
        Math.max(-1, Math.min(1, ((event.clientY - startY) / window.innerHeight) * 3)),
      );
    });
    const release = () => {
      this.dragging = false;
    };
    window.addEventListener('pointerup', release);
    window.addEventListener('pointercancel', release);
  }

  private updateTilt(dt: number, elapsed: number): void {
    if (this.reducedMotion) {
      this.deckRoot.rotation.set(REST_PITCH, 0, 0);
      return;
    }
    const target = this.tiltTarget.clone();
    if (this.coarsePointer && !this.dragging && this.tiltEnabled) {
      target.set(Math.sin(elapsed * 0.31) * 0.35, Math.sin(elapsed * 0.23 + 1.2) * 0.25);
    }
    // Critically damped spring toward the pointer target.
    const stiffness = 38;
    const damping = 2 * Math.sqrt(stiffness);
    const step = Math.min(dt, 1 / 30);
    this.tiltVelocity.x += (stiffness * (target.x - this.tilt.x) - damping * this.tiltVelocity.x) * step;
    this.tiltVelocity.y += (stiffness * (target.y - this.tilt.y) - damping * this.tiltVelocity.y) * step;
    this.tilt.x += this.tiltVelocity.x * step;
    this.tilt.y += this.tiltVelocity.y * step;
    // Leans towards the pointer: the near edge is the one the cursor is on.
    this.deckRoot.rotation.set(REST_PITCH - this.tilt.y * MAX_PITCH, -this.tilt.x * MAX_YAW, 0);
  }

  start(): void {
    if (this.running || document.hidden) return;
    this.running = true;
    this.clock.getDelta();
    const loop = () => {
      if (!this.running) return;
      this.frameHandle = requestAnimationFrame(loop);
      const dt = this.clock.getDelta();
      const elapsed = this.clock.elapsedTime;
      this.sinceRender += dt;
      if (this.idleThrottle && this.sinceRender < IDLE_FPS_INTERVAL) return;
      const frameDt = this.sinceRender;
      this.sinceRender = 0;
      this.updateTilt(frameDt, elapsed);
      for (const callback of this.callbacks) callback(frameDt, elapsed);
      this.crt.uniforms.uTime.value = elapsed;
      this.watchPerformance(frameDt);
      if (this.lowPower) this.renderer.render(this.scene, this.camera);
      else this.composer.render(frameDt);
    };
    this.frameHandle = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.frameHandle);
  }

  isLowPower(): boolean {
    return this.lowPower;
  }

  /** Coarse-pointer devices drop post-processing if frames average over 24 ms for 3 s. */
  private watchPerformance(dt: number): void {
    if (this.lowPower || !this.coarsePointer || this.idleThrottle) return;
    this.slowFrames = dt > 0.024 ? this.slowFrames + dt : Math.max(0, this.slowFrames - dt);
    if (this.slowFrames > 3) {
      this.lowPower = true;
      this.renderer.setPixelRatio(1);
      this.resize();
    }
  }
}

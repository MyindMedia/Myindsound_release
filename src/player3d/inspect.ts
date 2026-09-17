import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, Vector2, Vector3 } from 'three';
import type { Deck } from './deck';
import type { PlayerScene } from './scene';

/**
 * Eject inspector: holds the cartridge in front of the camera so visitors can turn it through 360°
 * and zoom into the details. The cartridge rotates, not the camera, so the city backdrop and the
 * HUD framing stay put. Checked first: ThreeUI has no object inspector, and three's Orbit/Trackball
 * controls move the camera.
 */

const FILL_HEIGHT = 0.86;
const FILL_WIDTH = 0.9;
const MAX_ZOOM = 4;
/** Radians per stage height of drag: two stage heights turn the cartridge right round. */
const DRAG_RADIANS = Math.PI;
const INERTIA_DAMPING = 4;
/** Caps a fast fling (rad/s), so one flick is a few turns, not dozens. */
const MAX_SPIN = 9;
const KEY_IMPULSE = 2.4;
const IDLE_TURN = 0.35;
// Blended in linear light, so 0.8 reads as roughly half brightness on screen.
const DIM_OPACITY = 0.8;
const TAP_MS = 260;
const DOUBLE_TAP_MS = 320;

const AXIS_X = new Vector3(1, 0, 0);
const AXIS_Y = new Vector3(0, 1, 0);
const IDENTITY = new Quaternion();

interface PointerTrack {
  x: number;
  y: number;
  downX: number;
  downY: number;
  downAt: number;
}

export class CartridgeInspector {
  private readonly scene: PlayerScene;
  private readonly deck: Deck;
  private readonly canvas: HTMLCanvasElement;
  private readonly stageElement: HTMLElement;
  private readonly reducedMotion: boolean;
  private readonly onInsert: () => void;
  /** Camera space: +x right, +y up, looking down -z. */
  private readonly stage = new Group();
  private readonly pivot = new Group();
  private readonly dim: Mesh;
  private readonly dimMaterial: MeshBasicMaterial;
  private holding = false;
  private interactive = false;
  private touched = false;
  private resetting = false;
  private presence = 0;
  private presenceTarget = 0;
  private baseDistance = 2.5;
  private restRay = new Vector3(0, 0, -1);
  private zoom = 1;
  private zoomTarget = 1;
  private zoomRay = new Vector3(0, 0, -1);
  private pan = new Vector2();
  private bob = 0;
  private velocity = new Vector2();
  private pointers = new Map<number, PointerTrack>();
  private lastMoveAt = 0;
  private pinchDistance = 0;
  private lastTap = { at: 0, x: 0, y: 0 };
  private readonly spin = new Quaternion();

  constructor(options: {
    scene: PlayerScene;
    deck: Deck;
    canvas: HTMLCanvasElement;
    stageElement: HTMLElement;
    reducedMotion: boolean;
    onInsert: () => void;
  }) {
    this.scene = options.scene;
    this.deck = options.deck;
    this.canvas = options.canvas;
    this.stageElement = options.stageElement;
    this.reducedMotion = options.reducedMotion;
    this.onInsert = options.onInsert;

    this.dimMaterial = new MeshBasicMaterial({
      color: '#04060B',
      transparent: true,
      opacity: 0,
      depthWrite: false,
      toneMapped: false,
    });
    this.dim = new Mesh(new PlaneGeometry(1, 1), this.dimMaterial);
    // Drawn after the deck and city, depth-tested so the cartridge in front stays bright.
    this.dim.renderOrder = 50;
    this.dim.visible = false;
    this.stage.add(this.dim, this.pivot);
    this.scene.camera.add(this.stage);

    this.bindPointer();
    this.bindKeyboard();
    this.scene.onResize(() => this.measure());
  }

  /** Moves the cartridge into the inspector without changing where it is on screen. */
  takeCartridge(): void {
    this.holding = true;
    this.zoom = this.zoomTarget = 1;
    this.pan.set(0, 0);
    this.velocity.set(0, 0);
    this.resetting = false;
    this.measure();
    this.pivot.quaternion.identity();
    this.placePivot();
    this.pivot.attach(this.deck.cartridge);
  }

  /** Dims the deck and city behind the cartridge and softens the CRT pass. */
  setPresent(present: boolean): void {
    this.presenceTarget = present ? 1 : 0;
    if (this.reducedMotion) this.applyPresence(this.presenceTarget);
  }

  activate(): void {
    this.interactive = true;
    this.touched = false;
    this.canvas.style.cursor = 'grab';
  }

  /** Hands the cartridge back to the deck, keeping its current world pose for the insert timeline. */
  release(): void {
    this.interactive = false;
    this.pointers.clear();
    this.velocity.set(0, 0);
    this.canvas.style.cursor = '';
    this.setPresent(false);
    if (!this.holding) return;
    this.holding = false;
    this.bob = 0;
    this.placePivot();
    this.deck.group.attach(this.deck.cartridge);
  }

  reset(): void {
    this.touched = true;
    this.resetting = !this.reducedMotion;
    if (this.reducedMotion) this.pivot.quaternion.identity();
    this.velocity.set(0, 0);
    this.zoomTarget = 1;
    this.zoomRay.copy(this.restRay);
  }

  update(dt: number, elapsed: number): void {
    if (this.presence !== this.presenceTarget) {
      const next = this.presence + (this.presenceTarget - this.presence) * (1 - Math.exp(-dt * 5));
      this.applyPresence(Math.abs(next - this.presenceTarget) < 0.01 ? this.presenceTarget : next);
    }
    if (!this.holding) return;

    // Rotation: drag inertia, the idle showcase turn, or easing back to the front after a reset.
    if (this.resetting) {
      this.pivot.quaternion.slerp(IDENTITY, 1 - Math.exp(-dt * 6));
      if (this.pivot.quaternion.angleTo(IDENTITY) < 0.002) {
        this.pivot.quaternion.identity();
        this.resetting = false;
      }
    } else if (this.pointers.size === 0 && this.velocity.lengthSq() > 1e-6) {
      this.rotateBy(this.velocity.x * dt, this.velocity.y * dt);
      this.velocity.multiplyScalar(Math.exp(-dt * INERTIA_DAMPING));
    } else if (this.interactive && !this.touched && !this.reducedMotion) {
      this.rotateBy(IDLE_TURN * dt, 0);
    }

    // Zoom toward the point under the pointer: moving along its ray keeps that point where it is.
    const before = this.distance();
    this.zoom = this.reducedMotion
      ? this.zoomTarget
      : this.zoom + (this.zoomTarget - this.zoom) * (1 - Math.exp(-dt * 12));
    const after = this.distance();
    this.pan.x += (this.zoomRay.x - this.restRay.x) * (after - before);
    this.pan.y += (this.zoomRay.y - this.restRay.y) * (after - before);
    // Gentle float on the pivot, so tweens on the cartridge itself stay untouched.
    this.bob = this.interactive && !this.reducedMotion ? Math.sin(elapsed * 1.3) * 0.01 : 0;
    this.placePivot();
  }

  private distance(): number {
    return this.baseDistance / this.zoom;
  }

  private placePivot(): void {
    const distance = this.distance();
    const tanHalf = Math.tan((this.scene.camera.fov * Math.PI) / 360);
    const aspect = window.innerWidth / Math.max(1, window.innerHeight);
    // No pan at zoom 1; up to about the cartridge's half size when zoomed in.
    const room = this.baseDistance - distance;
    const limitX = Math.min(this.deck.cartridgeWidth * 0.55, room * tanHalf * aspect);
    const limitY = Math.min(this.deck.cartridgeHeight * 0.55, room * tanHalf);
    this.pan.set(Math.max(-limitX, Math.min(limitX, this.pan.x)), Math.max(-limitY, Math.min(limitY, this.pan.y)));
    this.pivot.position.copy(this.restRay).multiplyScalar(distance);
    this.pivot.position.x += this.pan.x;
    this.pivot.position.y += this.pan.y + this.bob;
  }

  private rotateBy(yaw: number, pitch: number): void {
    this.pivot.quaternion.premultiply(this.spin.setFromAxisAngle(AXIS_Y, yaw));
    this.pivot.quaternion.premultiply(this.spin.setFromAxisAngle(AXIS_X, pitch));
  }

  private applyPresence(value: number): void {
    this.presence = value;
    this.dimMaterial.opacity = DIM_OPACITY * value;
    this.dim.visible = value > 0.001;
    this.scene.setCrtIntensity(1 - 0.65 * value);
    if (this.dim.visible) this.placeDim();
  }

  private placeDim(): void {
    const distance = Math.max(this.baseDistance + 0.3, this.scene.getDeckDistance() - 0.25);
    const tanHalf = Math.tan((this.scene.camera.fov * Math.PI) / 360);
    const height = 2 * distance * tanHalf * 3;
    this.dim.position.set(0, 0, -distance);
    this.dim.scale.set((height * window.innerWidth) / Math.max(1, window.innerHeight), height, 1);
  }

  /** Fits the cartridge into the HUD's inspect stage and aims at the stage centre. */
  private measure(): void {
    const viewportHeight = Math.max(1, window.innerHeight);
    const stage = this.stageElement.getBoundingClientRect();
    const frame = this.scene.getFrameRect();
    const tanHalf = Math.tan((this.scene.camera.fov * Math.PI) / 360);
    const worldPerPixel = (2 * tanHalf) / viewportHeight; // at distance 1
    const byHeight = this.deck.cartridgeHeight / (FILL_HEIGHT * Math.max(40, stage.height) * worldPerPixel);
    const byWidth = this.deck.cartridgeWidth / (FILL_WIDTH * Math.max(40, stage.width) * worldPerPixel);
    const fit = Math.min(Math.max(byHeight, byWidth), this.scene.getDeckDistance() - 0.5);
    this.baseDistance = Math.max(this.minDistance() * 1.2, fit);
    // The camera axis passes through the frame centre (scene view offset).
    this.restRay.set(
      (stage.left + stage.width / 2 - (frame.left + frame.width / 2)) * worldPerPixel,
      -(stage.top + stage.height / 2 - (frame.top + frame.height / 2)) * worldPerPixel,
      -1,
    );
    if (this.holding) this.placePivot();
    if (this.dim.visible) this.placeDim();
  }

  private rayAt(clientX: number, clientY: number, target: Vector3): Vector3 {
    const frame = this.scene.getFrameRect();
    const worldPerPixel = (2 * Math.tan((this.scene.camera.fov * Math.PI) / 360)) / Math.max(1, window.innerHeight);
    return target.set(
      (clientX - (frame.left + frame.width / 2)) * worldPerPixel,
      -(clientY - (frame.top + frame.height / 2)) * worldPerPixel,
      -1,
    );
  }

  private setZoomTarget(value: number, clientX?: number, clientY?: number): void {
    this.touched = true;
    this.resetting = false;
    const maxZoom = Math.min(MAX_ZOOM, this.baseDistance / this.minDistance());
    this.zoomTarget = Math.max(1, Math.min(maxZoom, value));
    if (clientX === undefined || clientY === undefined) this.zoomRay.copy(this.restRay);
    else this.rayAt(clientX, clientY, this.zoomRay);
  }

  /** Close enough to read the label, never so close a turned corner crosses the near plane. */
  private minDistance(): number {
    return Math.hypot(this.deck.cartridgeWidth, this.deck.cartridgeHeight) / 2 + 0.12;
  }

  private bindPointer(): void {
    const canvas = this.canvas;
    canvas.addEventListener('pointerdown', (event) => {
      if (!this.interactive) return;
      canvas.setPointerCapture(event.pointerId);
      const now = performance.now();
      this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, downX: event.clientX, downY: event.clientY, downAt: now });
      this.velocity.set(0, 0);
      this.lastMoveAt = now;
      this.resetting = false;
      this.pinchDistance = this.currentPinchDistance();
      canvas.style.cursor = 'grabbing';
    });

    canvas.addEventListener('pointermove', (event) => {
      const pointer = this.pointers.get(event.pointerId);
      if (!this.interactive || !pointer) return;
      const dx = event.clientX - pointer.x;
      const dy = event.clientY - pointer.y;
      pointer.x = event.clientX;
      pointer.y = event.clientY;

      if (this.pointers.size >= 2) {
        const distance = this.currentPinchDistance();
        if (this.pinchDistance > 0 && distance > 0) {
          const [a, b] = [...this.pointers.values()];
          this.setZoomTarget(this.zoomTarget * (distance / this.pinchDistance), (a.x + b.x) / 2, (a.y + b.y) / 2);
        }
        this.pinchDistance = distance;
        return;
      }

      if (Math.hypot(pointer.x - pointer.downX, pointer.y - pointer.downY) > 4) this.touched = true;
      const stageHeight = Math.max(120, this.stageElement.getBoundingClientRect().height);
      const yaw = (dx / stageHeight) * DRAG_RADIANS;
      const pitch = (dy / stageHeight) * DRAG_RADIANS;
      this.rotateBy(yaw, pitch);
      const now = performance.now();
      const seconds = Math.max(0.008, (now - this.lastMoveAt) / 1000);
      this.lastMoveAt = now;
      this.velocity.lerp(new Vector2(yaw / seconds, pitch / seconds), 0.5).clampLength(0, MAX_SPIN);
    });

    const end = (event: PointerEvent) => {
      const pointer = this.pointers.get(event.pointerId);
      if (!pointer) return;
      this.pointers.delete(event.pointerId);
      this.pinchDistance = this.currentPinchDistance();
      if (!this.interactive) return;
      canvas.style.cursor = 'grab';
      const now = performance.now();
      if (now - this.lastMoveAt > 80) this.velocity.set(0, 0);
      const moved = Math.hypot(event.clientX - pointer.downX, event.clientY - pointer.downY);
      if (event.type !== 'pointerup' || moved > 10 || now - pointer.downAt > TAP_MS) return;
      const near = Math.hypot(event.clientX - this.lastTap.x, event.clientY - this.lastTap.y) < 40;
      if (near && now - this.lastTap.at < DOUBLE_TAP_MS) {
        this.lastTap.at = 0;
        this.reset();
      } else {
        this.lastTap = { at: now, x: event.clientX, y: event.clientY };
      }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);

    canvas.addEventListener(
      'wheel',
      (event) => {
        if (!this.interactive) return;
        event.preventDefault();
        const pixels = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
        // Trackpad pinch arrives as a ctrl+wheel with small deltas.
        const rate = event.ctrlKey ? 0.012 : 0.0018;
        this.setZoomTarget(this.zoomTarget * Math.exp(-pixels * rate), event.clientX, event.clientY);
      },
      { passive: false },
    );
  }

  private currentPinchDistance(): number {
    if (this.pointers.size < 2) return 0;
    const [a, b] = [...this.pointers.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  private bindKeyboard(): void {
    document.addEventListener('keydown', (event) => {
      if (!this.interactive || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, button, a, [contenteditable]')) return;
      const impulse: Record<string, [number, number]> = {
        ArrowLeft: [-KEY_IMPULSE, 0],
        ArrowRight: [KEY_IMPULSE, 0],
        ArrowUp: [0, -KEY_IMPULSE],
        ArrowDown: [0, KEY_IMPULSE],
      };
      if (impulse[event.key]) {
        this.touched = true;
        this.resetting = false;
        this.velocity.x += impulse[event.key][0];
        this.velocity.y += impulse[event.key][1];
        this.velocity.clampLength(0, MAX_SPIN);
      } else if (event.key === '+' || event.key === '=') {
        this.setZoomTarget(this.zoomTarget * 1.35);
      } else if (event.key === '-' || event.key === '_') {
        this.setZoomTarget(this.zoomTarget / 1.35);
      } else if (event.key === '0') {
        this.reset();
      } else if (event.key === 'Escape' || event.key === 'Enter') {
        this.onInsert();
      } else {
        return;
      }
      event.preventDefault();
    });
  }
}

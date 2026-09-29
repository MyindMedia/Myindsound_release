/**
 * The release portal's three.js side, loaded only when the admin reaches the casing step (three.js and
 * packages/minidisc never touch the public pages or the rest of admin). A live preview of the cartridge on the
 * chosen shell, spinning and draggable, with a PLACE mode that drags the label image and the stickers across their
 * areas, plus the minidisc calls the portal makes: `suggestShell`, `renderSleeveStill` (the rack image), the optional
 * `renderSpinLoop`, and `drawnSticker` for the built-in and emoji thumbnails.
 */
import {
  ACESFilmicToneMapping,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  PerspectiveCamera,
  Plane,
  PlaneGeometry,
  PointLight,
  Raycaster,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { ensureFonts, createMiniDisc, type DiscDesign, type LoadedArt, type MiniDisc } from '../packages/minidisc/src/index';
import { createStudioEnvironment } from './player3d/cartridge-detail';

export { SHELL_PRESET_LIST, ensureFonts, loadDesignArt, renderSleeveStill, renderSpinLoop, resolvePreset, suggestShell, validateDesign } from '../packages/minidisc/src/index';
export type { DiscDesign, DiscSticker, LoadedArt, ShellPreset, ShellSuggestion, SleeveStill, SpinLoopResult } from '../packages/minidisc/src/index';
export { drawnSticker } from '../packages/minidisc/src/prints';

/** What a drag in PLACE mode moves: the label image, or `design.stickers[index]`, on its area. */
export interface PlaceTarget {
  layer: 'label' | 'sticker';
  /** Index into `design.stickers` (stickers only). */
  index?: number;
  area: 'shutter' | 'shell';
}

export interface PlaceHooks {
  /** The target's new centre, as fractions of its area (0..1, origin top left); `done` on release. */
  onPlace?(target: PlaceTarget, x: number, y: number, done: boolean): void;
  /** A wheel turn or a two-finger pinch on the last picked target: multiply its size by `factor`. */
  onScale?(target: PlaceTarget, factor: number): void;
}

type AreaRect = { x0: number; y0: number; x1: number; y1: number };
type PlacementAreas = Record<'shutter' | 'shell', { rect: AreaRect; z: number }>;

export interface CasingPreview {
  /** Rebuilds the cartridge for this design (disposing the last one). */
  show(design: DiscDesign, art: LoadedArt): void;
  /** Sleeve on (pulled part way down, so the cartridge shows) or off (the bare cartridge). */
  setSleeve(on: boolean): void;
  /** Turns the cartridge to face front again. */
  reset(): void;
  /**
   * PLACE mode: the preview holds square on (no turning, no sway, no sleeve), and a drag on the label image or a
   * sticker moves it across its area (`PlaceHooks.onPlace`). The canvas takes every touch while it is on.
   */
  setPlacing(on: boolean): void;
  dispose(): void;
}

const SLEEVE_DROP = 0.55;
const SPIN_RPS = 1.4;

/** A spinning, draggable MiniDisc in `canvas`, sized to the canvas's CSS box. */
export function createCasingPreview(canvas: HTMLCanvasElement, hooks: PlaceHooks = {}): CasingPreview {
  const coarse = matchMedia('(pointer: coarse)').matches;
  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const renderer = new WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, coarse ? 1.5 : 2));
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  const environment = createStudioEnvironment(renderer);
  const scene = new Scene();
  const camera = new PerspectiveCamera(28, 1, 0.05, 40);
  const key = new DirectionalLight('#ffffff', 1.6);
  key.position.set(1.5, 2.5, 4);
  const pink = new PointLight('#FF3DA8', 2.5, 14, 1.6);
  pink.position.set(-3.6, 0.8, 2.6);
  const ice = new PointLight('#9FD8FF', 2, 14, 1.6);
  ice.position.set(3.6, -0.6, 2.6);
  scene.add(new HemisphereLight('#9FD8FF', '#1a0a14', 0.9), key, pink, ice);

  let disc: MiniDisc | null = null;
  let sleeve = false;
  // Drag turns the cartridge; letting go, it eases back into a gentle sway.
  let yaw = 0;
  let pitch = -0.05;
  let velocity = 0;
  let dragging = false;
  let lastX = 0;
  let lastY = 0;
  let idle = 0;
  // PLACE mode: what is being dragged (the mesh, its target, and the grab point's offset from its centre).
  let placing = false;
  let grabbed: { mesh: Mesh; target: PlaceTarget; offset: Vector3 } | null = null;
  let picked: PlaceTarget | null = null;
  const pointers = new Map<number, { x: number; y: number }>();
  let pinch = 0;
  const raycaster = new Raycaster();
  const ndc = new Vector2();

  const frame = () => {
    if (!disc) return;
    const drop = sleeve && !placing ? SLEEVE_DROP : 0;
    const height = disc.height * (1 + drop) + 0.04;
    const fit = Math.max(height, disc.width * 1.1) * 1.18;
    const distance = fit / 2 / Math.tan((camera.fov * Math.PI) / 360);
    const centre = -disc.height * drop * 0.5;
    camera.position.set(0, centre, distance);
    camera.lookAt(0, centre, 0);
  };

  const resize = () => {
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();

  // ── PLACE mode: ray → the target area's plane, in the cartridge's own space ───────────────────────────────
  const placementAreas = (): PlacementAreas | null => (disc?.cartridge.userData.placementAreas as PlacementAreas | undefined) ?? null;
  const placeables = (): Mesh[] => {
    const found: Mesh[] = [];
    disc?.cartridge.traverse((object: Object3D) => {
      if (object instanceof Mesh && object.userData.placeable && object.visible) found.push(object);
    });
    return found;
  };
  const aim = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    ndc.set(((event.clientX - box.left) / Math.max(1, box.width)) * 2 - 1, -((event.clientY - box.top) / Math.max(1, box.height)) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  };
  /** Where the pointer's ray meets the area's plane, in cartridge space, or null (parallel, or behind). */
  const onArea = (area: PlaceTarget['area']): Vector3 | null => {
    const areas = placementAreas();
    if (!disc || !areas) return null;
    disc.cartridge.updateWorldMatrix(true, false);
    const ray = raycaster.ray.clone().applyMatrix4(disc.cartridge.matrixWorld.clone().invert());
    return ray.intersectPlane(new Plane(new Vector3(0, 0, 1), -areas[area].z), new Vector3());
  };
  const targetOf = (mesh: Mesh): PlaceTarget => {
    const tag = mesh.userData.placeable as PlaceTarget;
    return { layer: tag.layer, area: tag.area, ...(tag.layer === 'sticker' ? { index: tag.index } : {}) };
  };
  /** The mesh's centre in cartridge space (the shutter's meshes ride in its group). */
  const centreOf = (mesh: Mesh) => disc!.cartridge.worldToLocal(mesh.getWorldPosition(new Vector3()));
  /** Moves the mesh's centre to `point` (cartridge space), kept inside its area by its rotated bounds. */
  const moveTo = (mesh: Mesh, area: AreaRect, point: Vector3) => {
    const size = (mesh.geometry as PlaneGeometry).parameters;
    const cos = Math.abs(Math.cos(mesh.rotation.z));
    const sin = Math.abs(Math.sin(mesh.rotation.z));
    const halfW = Math.min((cos * size.width + sin * size.height) / 2, (area.x1 - area.x0) / 2);
    const halfH = Math.min((sin * size.width + cos * size.height) / 2, (area.y1 - area.y0) / 2);
    const x = Math.max(area.x0 + halfW, Math.min(area.x1 - halfW, point.x));
    const y = Math.max(area.y0 + halfH, Math.min(area.y1 - halfH, point.y));
    const local = mesh.parent!.worldToLocal(disc!.cartridge.localToWorld(new Vector3(x, y, 0)));
    mesh.position.x = local.x;
    mesh.position.y = local.y;
  };
  const placeDown = (event: PointerEvent) => {
    aim(event);
    const hit = raycaster.intersectObjects(placeables(), false)[0];
    if (!hit) return;
    const mesh = hit.object as Mesh;
    const target = targetOf(mesh);
    const point = onArea(target.area);
    if (!point) return;
    grabbed = { mesh, target, offset: centreOf(mesh).sub(point) };
    picked = target;
    canvas.style.cursor = 'grabbing';
  };
  const placeMove = (event: PointerEvent) => {
    aim(event);
    if (!grabbed) {
      canvas.style.cursor = raycaster.intersectObjects(placeables(), false).length > 0 ? 'grab' : 'default';
      return;
    }
    const areas = placementAreas();
    const point = onArea(grabbed.target.area);
    if (!areas || !point) return;
    const rect = areas[grabbed.target.area].rect;
    const centre = point.add(grabbed.offset);
    moveTo(grabbed.mesh, rect, centre);
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    hooks.onPlace?.(grabbed.target, clamp((centre.x - rect.x0) / (rect.x1 - rect.x0)), clamp((rect.y1 - centre.y) / (rect.y1 - rect.y0)), false);
  };
  const placeUp = (event: PointerEvent) => {
    if (!grabbed) return;
    const areas = placementAreas();
    aim(event);
    const point = onArea(grabbed.target.area);
    const target = grabbed.target;
    const offset = grabbed.offset;
    grabbed = null;
    canvas.style.cursor = 'grab';
    if (!areas || !point) return;
    const rect = areas[target.area].rect;
    const centre = point.add(offset);
    const clamp = (v: number) => Math.max(0, Math.min(1, v));
    hooks.onPlace?.(target, clamp((centre.x - rect.x0) / (rect.x1 - rect.x0)), clamp((rect.y1 - centre.y) / (rect.y1 - rect.y0)), true);
  };
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!placing || !picked) return;
      event.preventDefault();
      hooks.onScale?.(picked, Math.exp(-event.deltaY * 0.0015));
    },
    { passive: false },
  );

  canvas.addEventListener('pointerdown', (event) => {
    if (placing) {
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      canvas.setPointerCapture(event.pointerId);
      if (pointers.size === 1) placeDown(event);
      else if (pointers.size === 2) {
        // Two fingers: a pinch resizes what was picked, and the one-finger drag stops where it is.
        if (grabbed) placeUp(event);
        const [a, b] = [...pointers.values()];
        pinch = Math.hypot(a.x - b.x, a.y - b.y);
      }
      return;
    }
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
    if (placing) {
      if (pointers.has(event.pointerId)) pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
      if (pointers.size === 2 && picked && pinch > 0) {
        const [a, b] = [...pointers.values()];
        const distance = Math.hypot(a.x - b.x, a.y - b.y);
        if (distance > 0) hooks.onScale?.(picked, distance / pinch);
        pinch = distance;
        return;
      }
      placeMove(event);
      return;
    }
    if (!dragging) return;
    const dx = (event.clientX - lastX) / Math.max(1, canvas.clientWidth);
    const dy = (event.clientY - lastY) / Math.max(1, canvas.clientHeight);
    lastX = event.clientX;
    lastY = event.clientY;
    velocity = dx * Math.PI * 2.4;
    yaw += velocity;
    pitch = Math.max(-0.7, Math.min(0.7, pitch + dy * Math.PI));
    idle = 0;
  });
  const release = (event: PointerEvent) => {
    dragging = false;
    if (!placing) return;
    pointers.delete(event.pointerId);
    if (pointers.size < 2) pinch = 0;
    placeUp(event);
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dblclick', () => {
    if (!placing) api.reset();
  });
  canvas.addEventListener('keydown', (event) => {
    if (placing) return;
    if (event.key === 'ArrowLeft') yaw -= 0.25;
    else if (event.key === 'ArrowRight') yaw += 0.25;
    else if (event.key === '0') api.reset();
    else return;
    idle = 0;
    event.preventDefault();
  });

  let last = performance.now();
  let visible = true;
  const visibility = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
  });
  visibility.observe(canvas);
  renderer.setAnimationLoop((now) => {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!visible || document.hidden || !disc) return;
    idle += dt;
    if (placing) {
      // Held square on, so the drag maps straight onto the face.
      yaw += (Math.round(yaw / (Math.PI * 2)) * Math.PI * 2 - yaw) * Math.min(1, dt * 10);
      pitch += (0 - pitch) * Math.min(1, dt * 10);
      velocity = 0;
    } else if (!dragging) {
      yaw += velocity;
      velocity *= Math.pow(0.04, dt);
      if (idle > 1.2 && !reduceMotion) {
        // Back towards square-on with a slow sway, so the print stays towards the viewer.
        const turns = Math.round(yaw / (Math.PI * 2)) * Math.PI * 2;
        const target = turns + Math.sin(idle * 0.5) * 0.4;
        yaw += (target - yaw) * Math.min(1, dt * 1.5);
        pitch += (-0.05 - pitch) * Math.min(1, dt * 1.5);
      }
    }
    disc.group.rotation.set(pitch, yaw, 0);
    disc.update(dt);
    renderer.render(scene, camera);
  });

  const api: CasingPreview = {
    show(design, art) {
      if (disc) {
        scene.remove(disc.group);
        disc.dispose();
      }
      grabbed = null;
      disc = createMiniDisc(design, art, {
        environment,
        quality: coarse ? 'low' : 'high',
        sleeve: sleeve && !placing,
        sleeveDrop: SLEEVE_DROP,
        anisotropy: renderer.capabilities.getMaxAnisotropy(),
      });
      disc.spin(reduceMotion ? 0.3 : SPIN_RPS);
      scene.add(disc.group);
      frame();
    },
    setSleeve(on) {
      sleeve = on;
      disc?.setSleeve(on && !placing, SLEEVE_DROP);
      frame();
    },
    setPlacing(on) {
      placing = on;
      grabbed = null;
      picked = null;
      pointers.clear();
      pinch = 0;
      // Every touch drags a sticker while placing; otherwise an up or down swipe still scrolls the page.
      canvas.style.touchAction = on ? 'none' : '';
      canvas.style.cursor = on ? 'default' : '';
      disc?.setSleeve(sleeve && !on, SLEEVE_DROP);
      frame();
      idle = 0;
    },
    reset() {
      yaw = 0;
      pitch = -0.05;
      velocity = 0;
      idle = 0;
    },
    dispose() {
      renderer.setAnimationLoop(null);
      observer.disconnect();
      visibility.disconnect();
      if (disc) {
        scene.remove(disc.group);
        disc.dispose();
      }
      environment.dispose();
      renderer.dispose();
    },
  };
  return api;
}

/** Fonts first: the label and sleeve prints are typeset in Inter and JetBrains Mono (admin.html loads both). */
export async function ready(): Promise<void> {
  await ensureFonts();
}

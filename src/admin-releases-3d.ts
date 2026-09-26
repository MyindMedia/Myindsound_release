/**
 * The release portal's three.js side, loaded only when the admin reaches the casing step (three.js and
 * packages/minidisc never touch the public pages or the rest of admin). A live preview of the cartridge on the
 * chosen shell, spinning and draggable, plus the minidisc calls the portal makes: `suggestShell`, `renderSpinLoop`.
 */
import { ACESFilmicToneMapping, DirectionalLight, HemisphereLight, PerspectiveCamera, PointLight, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import { ensureFonts, createMiniDisc, type DiscDesign, type LoadedArt, type MiniDisc } from '../packages/minidisc/src/index';
import { createStudioEnvironment } from './player3d/cartridge-detail';

export { SHELL_PRESET_LIST, ensureFonts, loadDesignArt, renderSpinLoop, suggestShell, validateDesign } from '../packages/minidisc/src/index';
export type { DiscDesign, LoadedArt, ShellPreset, ShellSuggestion, SpinLoopResult } from '../packages/minidisc/src/index';

export interface CasingPreview {
  /** Rebuilds the cartridge for this design (disposing the last one). */
  show(design: DiscDesign, art: LoadedArt): void;
  /** Sleeve on (pulled part way down, as on the rack) or off (the bare cartridge). */
  setSleeve(on: boolean): void;
  /** Turns the cartridge to face front again. */
  reset(): void;
  dispose(): void;
}

const SLEEVE_DROP = 0.55;
const SPIN_RPS = 1.4;

/** A spinning, draggable MiniDisc in `canvas`, sized to the canvas's CSS box. */
export function createCasingPreview(canvas: HTMLCanvasElement): CasingPreview {
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

  const frame = () => {
    if (!disc) return;
    const drop = sleeve ? SLEEVE_DROP : 0;
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

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true;
    lastX = event.clientX;
    lastY = event.clientY;
    canvas.setPointerCapture(event.pointerId);
  });
  canvas.addEventListener('pointermove', (event) => {
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
  const release = () => {
    dragging = false;
  };
  canvas.addEventListener('pointerup', release);
  canvas.addEventListener('pointercancel', release);
  canvas.addEventListener('dblclick', () => api.reset());
  canvas.addEventListener('keydown', (event) => {
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
    if (!dragging) {
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
      disc = createMiniDisc(design, art, {
        environment,
        quality: coarse ? 'low' : 'high',
        sleeve,
        sleeveDrop: SLEEVE_DROP,
        anisotropy: renderer.capabilities.getMaxAnisotropy(),
      });
      disc.spin(reduceMotion ? 0.3 : SPIN_RPS);
      scene.add(disc.group);
      frame();
    },
    setSleeve(on) {
      sleeve = on;
      disc?.setSleeve(on, SLEEVE_DROP);
      frame();
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

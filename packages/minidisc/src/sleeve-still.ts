/**
 * `renderSleeveStill`: the rack (gallery) image, rendered as the live 3D sleeve's opening frame: the release in its
 * printed card sleeve, square to the camera, the cartridge standing out of the mouth at the sleeve's rest, under
 * the player's own lights and lens, over a transparent background. A tap on the tile zooms this image into the
 * live sleeve (RackFocusView), so the two match and only the resolution changes. The same sleeve, prints and
 * cartridge as the live bundle (`createMiniDisc` → wrap.ts `DiscWrap`). The pose, the light and the framing are
 * fixed, so every release comes out the same way and the face lands in the same place (`face`): clients lay
 * stickers and states over it. Browser only (WebGL).
 */
import {
  DirectionalLight,
  HemisphereLight,
  NeutralToneMapping,
  PerspectiveCamera,
  PointLight,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  Mesh,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { createStudioEnvironment } from '../../../src/player3d/cartridge-detail';
import { ensureFonts } from './canvas';
import type { DiscDesign } from './design';
import { createMiniDisc, loadDesignArt, type DesignArt } from './minidisc';

export interface SleeveStillOptions {
  /** Output size in px (square). At least 1024. Default 1024. */
  size?: number;
  /** Render at this multiple and downscale, for clean edges and grain. Default 2. */
  supersample?: number;
  /** Already loaded art (else loaded relative to `base`). */
  art?: DesignArt;
  /** Where relative art paths resolve from (the design.json URL). */
  base?: string;
  /** Edition stamp on the cartridge's plate (hidden in the sleeve; kept for parity). */
  edition?: number | null;
  /** WebP quality 0..1. Default 0.92. */
  webpQuality?: number;
  /**
   * The cartridge on its own, no sleeve: the disc as the deck shows it (the app's now playing thumbnail). Same
   * light, lens and pose; `face` is then the cartridge's bounds.
   */
  cartridge?: boolean;
}

/** A rectangle as fractions of the image, origin top left. */
export interface NormalizedRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SleeveStill {
  /** The render, PNG with alpha. */
  png: Blob;
  /** The same render as WebP with alpha, or null when the browser cannot encode WebP. */
  webp: Blob | null;
  /** Width and height in px (square). */
  size: number;
  /** Where the sleeve's printed front sits in the image (its projected bounds). The same for every release. */
  face: NormalizedRect;
}

/**
 * The fixed pose: the live 3D sleeve's opening frame, so a tap zooms the gallery tile straight into the live view
 * with nothing changing but the resolution. Square to the camera (the inspector's HOME), the cartridge standing
 * at the sleeve's rest (wrap.ts `sleeveRest`, SLEEVE_PROUD out of the mouth), through the player's lens.
 */
export const SLEEVE_STILL_POSE = {
  /** Yaw of the package, radians: none, as the live sleeve opens. */
  yaw: 0,
  /** Camera elevation above the package's centre, radians: none. */
  elevation: 0,
  /** Vertical field of view, degrees: the player's (scene.ts FOV). */
  fov: 32,
  /** Empty border round the fitted package, as a fraction of the image. */
  margin: 0.05,
} as const;

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality));
}

/** Projected 2D bounds (NDC) of points. */
function ndcBounds(points: Vector3[], camera: PerspectiveCamera): { min: Vector2; max: Vector2 } {
  const min = new Vector2(Infinity, Infinity);
  const max = new Vector2(-Infinity, -Infinity);
  const p = new Vector3();
  for (const point of points) {
    p.copy(point).project(camera);
    min.min(new Vector2(p.x, p.y));
    max.max(new Vector2(p.x, p.y));
  }
  return { min, max };
}

/** Every vertex of the meshes under `root` whose names pass `keep`, in world space. */
function worldVertices(root: Object3D, keep: (mesh: Mesh) => boolean): Vector3[] {
  const points: Vector3[] = [];
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    if (!(node instanceof Mesh) || !keep(node)) return;
    const position = node.geometry.getAttribute('position');
    for (let i = 0; i < position.count; i++) points.push(new Vector3().fromBufferAttribute(position, i).applyMatrix4(node.matrixWorld));
  });
  return points;
}

export async function renderSleeveStill(design: DiscDesign, options: SleeveStillOptions = {}): Promise<SleeveStill> {
  const size = Math.max(1024, Math.round(options.size ?? 1024));
  const supersample = Math.max(1, Math.min(3, options.supersample ?? 2));
  const renderSize = Math.min(4096, size * supersample);
  await ensureFonts();
  const art = options.art ?? (await loadDesignArt(design, options.base));

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = renderSize;
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(renderSize, renderSize, false);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  // The live bundle's tone mapping and studio environment (player-app.ts, scene.ts).
  renderer.toneMapping = NeutralToneMapping;
  const environment = createStudioEnvironment(renderer);

  const scene = new Scene();
  // The live rig (player-app.ts): the sky, the white key, and the pink and ice accents at the strength they drop
  // to while the inspector holds a cartridge (1 - 0.75 × presence). The inspector's own camera-fixed key light
  // (inspect.ts, at its intro strength) is added once the camera is placed.
  const key = new DirectionalLight('#ffffff', 1.6);
  key.position.set(1.5, 2.5, 4);
  const pink = new PointLight('#FF3DA8', 6 * 0.25, 9, 1.6);
  pink.position.set(-2.2, 0.4, 1.6);
  const ice = new PointLight('#9FD8FF', 4 * 0.25, 9, 1.6);
  ice.position.set(2.2, -0.6, 1.4);
  const inspectorKey = new DirectionalLight('#fff6e8', 0.5);
  scene.add(new HemisphereLight('#9FD8FF', '#1a0a14', 0.9), key, pink, ice, inspectorKey, inspectorKey.target);

  const disc = createMiniDisc(design, art, {
    environment,
    quality: 'high',
    transmission: false,
    anisotropy: renderer.capabilities.getMaxAnisotropy(),
    sleeve: !options.cartridge,
    // At the live sleeve's rest: the cartridge's top SLEEVE_PROUD out of the mouth, screws showing.
    sleeveDrop: 0,
  });
  disc.setEdition(options.edition ?? null);
  const sleeve = disc.sleeve;
  if (!sleeve && !options.cartridge) throw new Error('renderSleeveStill: the sleeve did not build');
  scene.add(disc.group);

  // Pose, then stand the package on the floor at y = 0, centred on x and z.
  disc.group.rotation.set(0, SLEEVE_STILL_POSE.yaw, 0);
  const sleevePoints = sleeve
    ? worldVertices(sleeve, (mesh) => mesh.name.startsWith('sleeve-'))
    : worldVertices(disc.group, (mesh) => mesh.visible);
  const low = new Vector3(Infinity, Infinity, Infinity);
  const high = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of sleevePoints) {
    low.min(p);
    high.max(p);
  }
  disc.group.position.set(-(low.x + high.x) / 2, -low.y, -(low.z + high.z) / 2);
  const height = high.y - low.y;

  // Fit the camera: aim at the package, then walk the distance and the aim until the sleeve and the shadow's
  // core fill the frame less the margin, centred.
  const camera = new PerspectiveCamera(SLEEVE_STILL_POSE.fov, 1, 0.01, 50);
  const target = new Vector3(0, height * 0.46, 0);
  let distance = height * 4;
  const place = () => {
    camera.position.set(
      target.x,
      target.y + Math.sin(SLEEVE_STILL_POSE.elevation) * distance,
      target.z + Math.cos(SLEEVE_STILL_POSE.elevation) * distance,
    );
    camera.lookAt(target);
    camera.updateMatrixWorld(true);
  };
  // The sleeve and the cartridge standing out of it.
  const fitPoints = worldVertices(disc.group, (mesh) => mesh.visible);
  const room = 2 * (1 - 2 * SLEEVE_STILL_POSE.margin);
  for (let i = 0; i < 8; i++) {
    place();
    const { min, max } = ndcBounds(fitPoints, camera);
    const extent = Math.max(max.x - min.x, max.y - min.y);
    distance *= extent / room;
    // Shift the aim by the off-centre amount, in world units at the target's depth.
    const halfHeight = Math.tan((SLEEVE_STILL_POSE.fov * Math.PI) / 360) * distance;
    const right = new Vector3().setFromMatrixColumn(camera.matrixWorld, 0);
    const up = new Vector3().setFromMatrixColumn(camera.matrixWorld, 1);
    target.addScaledVector(right, ((min.x + max.x) / 2) * halfHeight).addScaledVector(up, ((min.y + max.y) / 2) * halfHeight);
  }
  place();
  // The inspector's key rides with the camera: (-1.2, 1.4, 0.6) in camera space, aimed at the package.
  camera.updateMatrixWorld(true);
  inspectorKey.position.copy(camera.localToWorld(new Vector3(-1.2, 1.4, 0.6)));
  inspectorKey.target.position.copy(target);

  // Where the printed front lands.
  const coverMesh = sleeve?.getObjectByName('sleeve-cover');
  const faceNdc = ndcBounds(coverMesh ? worldVertices(coverMesh, () => true) : sleevePoints, camera);
  const face: NormalizedRect = {
    x: (faceNdc.min.x + 1) / 2,
    y: (1 - faceNdc.max.y) / 2,
    w: (faceNdc.max.x - faceNdc.min.x) / 2,
    h: (faceNdc.max.y - faceNdc.min.y) / 2,
  };

  renderer.render(scene, camera);
  const out = document.createElement('canvas');
  out.width = out.height = size;
  const ctx = out.getContext('2d')!;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(canvas, 0, 0, renderSize, renderSize, 0, 0, size, size);
  const probe = ctx.getImageData(0, 0, size, size).data;
  let drawn = 0;
  for (let i = 3; i < probe.length && drawn === 0; i += 64) if (probe[i] > 0) drawn++;

  disc.dispose();
  environment.dispose();
  renderer.dispose();
  if (drawn === 0) throw new Error('renderSleeveStill: the render came out blank (no pixel with alpha > 0)');

  const png = await toBlob(out, 'image/png');
  if (!png) throw new Error('renderSleeveStill: PNG encoding failed');
  const webp = await toBlob(out, 'image/webp', options.webpQuality ?? 0.92);
  return { png, webp, size, face };
}

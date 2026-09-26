/**
 * `renderSleeveStill`: the rack image. One detailed, completely still render of the release in its printed card
 * sleeve, the cartridge all the way inside (its top edge sits a hairline below the mouth, as in a real sleeved
 * MiniDisc), at a slight three-quarter angle with the left spine showing, soft studio light with a sheen and an
 * edge highlight, and a soft contact shadow, over a transparent background. The same sleeve, prints and cartridge
 * as the live bundle (`createMiniDisc` → wrap.ts `DiscWrap`), the card dressed with paper grain and a light
 * laminate. The pose, the light and the framing are fixed, so every release comes out the same way and the face
 * lands in the same place (`face`): clients lay stickers and states over it. Browser only (WebGL).
 */
import {
  CanvasTexture,
  DirectionalLight,
  HemisphereLight,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NeutralToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  Scene,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
  type Texture,
} from 'three';
import { createStudioEnvironment } from '../../../src/player3d/cartridge-detail';
import { ensureFonts, prng } from './canvas';
import type { DiscDesign } from './design';
import { createMiniDisc, loadDesignArt, SLEEVE_CARD, SLEEVE_GAP, SLEEVE_PROUD, type DesignArt } from './minidisc';

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

/** The fixed pose: the left spine turned a little towards the camera, which looks down on it slightly. */
export const SLEEVE_STILL_POSE = {
  /** Yaw of the package, radians (positive brings the left spine round). */
  yaw: 0.32,
  /** Camera elevation above the package's centre, radians. */
  elevation: 0.28,
  /** Vertical field of view, degrees. */
  fov: 24,
  /** Empty border round the fitted package (and its shadow), as a fraction of the image. */
  margin: 0.05,
  /** How far the cartridge's top edge sits below the sleeve's mouth, as a fraction of its height. */
  inset: 0.012,
} as const;

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality));
}

/** Paper grain: fine fibres and speckle over mid grey, used as a bump map (and a touch of roughness). */
function paperGrain(seed: number): CanvasTexture {
  const size = 512;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, size, size);
  const random = prng(seed);
  // Fibres: short pale and dark strokes, mostly along the grain.
  for (let i = 0; i < 2600; i++) {
    const x = random() * size;
    const y = random() * size;
    const length = 3 + random() * 14;
    const angle = (random() - 0.5) * 0.9;
    ctx.strokeStyle = random() < 0.5 ? `rgba(255,255,255,${0.05 + random() * 0.12})` : `rgba(0,0,0,${0.05 + random() * 0.12})`;
    ctx.lineWidth = 0.6 + random() * 0.9;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }
  // Speckle.
  const image = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const noise = (random() - 0.5) * 22;
    image.data[i] += noise;
    image.data[i + 1] += noise;
    image.data[i + 2] += noise;
  }
  ctx.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  return texture;
}

/** A soft contact shadow: dark under the foot, feathering out, as an alpha texture. */
function contactShadow(): CanvasTexture {
  const w = 512;
  const h = 256;
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  // A wide soft pool, then a tight dark core where the card meets the floor.
  const layer = (rx: number, ry: number, alpha: number) => {
    ctx.save();
    ctx.translate(w / 2, h / 2);
    ctx.scale(rx, ry);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    g.addColorStop(0, `rgba(0,0,0,${alpha})`);
    g.addColorStop(0.55, `rgba(0,0,0,${alpha * 0.45})`);
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  };
  layer(w * 0.5, h * 0.5, 0.55);
  layer(w * 0.42, h * 0.2, 0.7);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/**
 * The card as it would be printed: the live sleeve's material with paper grain in the bump, and a light laminate
 * (clearcoat) that catches the studio's panels as a sheen. The board inside the mouth and on the cut edges is
 * bare grey card, as real sleeves are.
 */
function dressSleeve(sleeve: Object3D, grain: Texture, environment: Texture): MeshPhysicalMaterial[] {
  const made: MeshPhysicalMaterial[] = [];
  const card = (options: { map: Texture | null; color: string; bare: boolean; side: MeshStandardMaterial['side'] }) => {
    const material = new MeshPhysicalMaterial({
      map: options.map,
      color: options.color,
      roughness: options.bare ? 0.9 : 0.55,
      metalness: 0,
      clearcoat: options.bare ? 0 : 0.35,
      clearcoatRoughness: 0.42,
      bumpMap: grain,
      bumpScale: options.bare ? 1.2 : 0.35,
      roughnessMap: grain,
      envMap: environment,
      envMapIntensity: options.bare ? 0.2 : 0.55,
      side: options.side,
    });
    made.push(material);
    return material;
  };
  sleeve.traverse((node) => {
    if (!(node instanceof Mesh) || !node.name.startsWith('sleeve-')) return;
    const old = node.material as MeshStandardMaterial;
    if (node.name === 'sleeve-body') {
      // ExtrudeGeometry's groups: 0 the caps (the cut edge of the board round the mouth), 1 the walls. The
      // outside of the walls is under the prints; their inside is what you see down the mouth, in the shade.
      node.material = [
        card({ map: null, color: '#c4beb4', bare: true, side: old.side }),
        card({ map: null, color: '#26222a', bare: true, side: old.side }),
      ];
    } else {
      const bare = node.name === 'sleeve-foot';
      node.material = card({ map: bare ? null : old.map, color: bare ? '#c4beb4' : '#ffffff', bare, side: old.side });
    }
    old.dispose();
  });
  return made;
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
  // The live rig's light (player-app.ts: white key, pink and ice accents, a cool sky over a plum floor), set as a
  // soft studio: a broad key from high left, the accents low so the print keeps its colours, and a rim from behind
  // that draws the edge highlight along the mouth and the spine.
  const key = new DirectionalLight('#fff8ee', 1.35);
  key.position.set(-1.6, 2.4, 3.2);
  const fill = new DirectionalLight('#dfe8ff', 0.35);
  fill.position.set(2.6, 0.6, 2.2);
  const rim = new DirectionalLight('#ffffff', 1.6);
  rim.position.set(1.2, 2.2, -2.6);
  // The sheen: a soft light from the right, near the face's mirror angle, so the laminate glows across it.
  const sheen = new DirectionalLight('#ffffff', 0.9);
  sheen.position.set(2.2, 0.2, 2.6);
  const pink = new PointLight('#FF3DA8', 0.9, 9, 1.6);
  pink.position.set(-2.2, 0.4, 1.6);
  const ice = new PointLight('#9FD8FF', 0.7, 9, 1.6);
  ice.position.set(2.2, -0.6, 1.4);
  scene.add(new HemisphereLight('#e8eef6', '#1a0a14', 0.75), key, fill, rim, sheen, pink, ice);

  const disc = createMiniDisc(design, art, {
    environment,
    quality: 'high',
    transmission: false,
    anisotropy: renderer.capabilities.getMaxAnisotropy(),
    sleeve: true,
    // All the way in, the cartridge's top a hairline below the mouth.
    sleeveDrop: -(SLEEVE_PROUD + SLEEVE_STILL_POSE.inset),
  });
  disc.setEdition(options.edition ?? null);
  const sleeve = disc.sleeve;
  if (!sleeve) throw new Error('renderSleeveStill: the sleeve did not build');
  const grain = paperGrain(0x5eed);
  grain.repeat.set(4, 4);
  const dressed = dressSleeve(sleeve, grain, environment);
  scene.add(disc.group);

  // Inside the mouth the cartridge sits in the sleeve's shade: a dark veil just over its top edge, so the mouth
  // reads as an opening with the disc down in it, not as a lid. (No shadow maps: this is the occlusion.)
  const inner = sleeve.getObjectByName('sleeve');
  const mouthVeil = new Mesh(
    new PlaneGeometry(disc.width + (SLEEVE_GAP - SLEEVE_CARD) * 2, disc.depth + SLEEVE_GAP * 2),
    new MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.62, depthWrite: false }),
  );
  mouthVeil.name = 'mouth-veil';
  mouthVeil.rotation.x = -Math.PI / 2;
  if (inner) {
    disc.group.updateMatrixWorld(true);
    const top = disc.cartridge.localToWorld(new Vector3(0, disc.height / 2, 0));
    mouthVeil.position.copy(inner.worldToLocal(top)).setX(0).setZ(0);
    mouthVeil.position.y += 0.0015;
    inner.add(mouthVeil);
  }

  // Pose, then stand the package on the floor at y = 0, centred on x and z.
  disc.group.rotation.set(0, SLEEVE_STILL_POSE.yaw, 0);
  const sleevePoints = worldVertices(sleeve, (mesh) => mesh.name.startsWith('sleeve-'));
  const low = new Vector3(Infinity, Infinity, Infinity);
  const high = new Vector3(-Infinity, -Infinity, -Infinity);
  for (const p of sleevePoints) {
    low.min(p);
    high.max(p);
  }
  disc.group.position.set(-(low.x + high.x) / 2, -low.y, -(low.z + high.z) / 2);
  const height = high.y - low.y;
  const width = high.x - low.x;

  // The contact shadow, on the floor under the foot.
  const shadowTexture = contactShadow();
  const shadow = new Mesh(
    new PlaneGeometry(width * 1.5, width * 0.62),
    new MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, toneMapped: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, 0.0005, 0);
  shadow.renderOrder = -1;
  scene.add(shadow);

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
  const shadowCore = [-1, 1].flatMap((sx) => [-1, 1].map((sz) => new Vector3(sx * width * 0.55, 0, sz * width * 0.12)));
  const fitPoints = [...worldVertices(disc.group, (mesh) => mesh.name.startsWith('sleeve-')), ...shadowCore];
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

  // Where the printed front lands.
  const coverMesh = sleeve.getObjectByName('sleeve-cover');
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

  for (const material of dressed) material.dispose();
  mouthVeil.geometry.dispose();
  (mouthVeil.material as MeshBasicMaterial).dispose();
  grain.dispose();
  shadowTexture.dispose();
  shadow.geometry.dispose();
  (shadow.material as MeshBasicMaterial).dispose();
  disc.dispose();
  environment.dispose();
  renderer.dispose();
  if (drawn === 0) throw new Error('renderSleeveStill: the render came out blank (no pixel with alpha > 0)');

  const png = await toBlob(out, 'image/png');
  if (!png) throw new Error('renderSleeveStill: PNG encoding failed');
  const webp = await toBlob(out, 'image/webp', options.webpQuality ?? 0.92);
  return { png, webp, size, face };
}

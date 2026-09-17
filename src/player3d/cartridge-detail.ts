import {
  AdditiveBlending,
  BackSide,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  Group,
  LatheGeometry,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  PMREMGenerator,
  RepeatWrapping,
  RingGeometry,
  SRGBColorSpace,
  Vector2,
  Vector3,
  type BufferGeometry,
  type Material,
  type Object3D,
  type MeshStandardMaterialParameters,
  type ShaderMaterial,
  type Texture,
  type WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/**
 * Realism layer for the MiniDisc cartridge, on top of the Canva artwork:
 * - real Phillips screws (lathe heads, brushed steel, recessed cross) seated in counterbored wells: the shell
 *   is cut open at each screw and a plastic well (wall + floor) sinks below the surface,
 * - a disc with real thickness (top face, outer edge, inner wall, silver data side) and a separate machined
 *   metal hub sitting in its centre opening (plate, steel ring, spindle hole, dimples) that spins with it,
 * - an opening in the back of the shell at the hub (steel bezel, plastic wall), where the deck's spindle
 *   (spindle.ts) rises in to drive the disc,
 * - clear-plastic gloss: an additive clearcoat pass over the shell, with normals from the artwork,
 * - a rainbow sheen on the disc that shows at an angle,
 * - paper grain for the label.
 * The artwork stays exactly as drawn; these layers only add depth, reflections and highlights.
 */

export type DetailQuality = 'high' | 'low';

/** Screw well radius as a multiple of the head radius (matches the printed dark ring), and its depth. */
const WELL_RATIO = 1.38;
const WELL_DEPTH = 0.008;

type Rect = { x0: number; y0: number; x1: number; y1: number };

/** Studio reflections tinted with the city's neon (pink left, ice right, gold above). */
export function createStudioEnvironment(renderer: WebGLRenderer): Texture {
  const room = new RoomEnvironment();
  const panel = (color: string, strength: number, position: [number, number, number], size: [number, number, number]) => {
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial({ color: new Color(color).multiplyScalar(strength) }));
    mesh.position.set(...position);
    mesh.scale.set(...size);
    room.add(mesh);
  };
  panel('#FF3DA8', 5, [-6.5, 2, 1], [0.2, 5, 7]);
  panel('#9FD8FF', 4, [6.5, 1, 1], [0.2, 5, 7]);
  panel('#FDB913', 2.5, [0, 9, -2], [7, 0.2, 2]);
  const pmrem = new PMREMGenerator(renderer);
  const texture = pmrem.fromScene(room, 0.04).texture;
  pmrem.dispose();
  room.dispose();
  return texture;
}

function canvas(size: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas');
  element.width = element.height = size;
  return [element, element.getContext('2d')!];
}

/** Tangent-space normals from a grayscale height canvas (+x right, +y up). */
function heightToNormal(source: HTMLCanvasElement, strength: number): CanvasTexture {
  const size = source.width;
  const height = source.getContext('2d')!.getImageData(0, 0, size, size).data;
  const [target, ctx] = canvas(size);
  const out = ctx.createImageData(size, size);
  const at = (x: number, y: number) => height[(((y + size) % size) * size + ((x + size) % size)) * 4] / 255;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const length = Math.hypot(dx, dy, 1);
      const i = (y * size + x) * 4;
      out.data[i] = (-dx / length) * 127.5 + 127.5;
      out.data[i + 1] = (dy / length) * 127.5 + 127.5;
      out.data[i + 2] = (1 / length) * 127.5 + 127.5;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const texture = new CanvasTexture(target);
  texture.colorSpace = NoColorSpace;
  return texture;
}

function drawCross(ctx: CanvasRenderingContext2D, size: number, style: string): void {
  const arm = size * 0.62;
  const width = size * 0.15;
  ctx.fillStyle = style;
  for (const rotation of [0, Math.PI / 2]) {
    ctx.save();
    ctx.translate(size / 2, size / 2);
    ctx.rotate(rotation + Math.PI / 4);
    ctx.beginPath();
    ctx.roundRect(-arm / 2, -width / 2, arm, width, width / 2);
    ctx.fill();
    ctx.restore();
  }
}

/** Brushed steel head with a Phillips cross, as colour, occlusion and normal maps. */
function screwMaps(): { map: CanvasTexture; aoMap: CanvasTexture; normalMap: CanvasTexture } {
  const size = 256;
  const [colour, ctx] = canvas(size);
  const gradient = ctx.createRadialGradient(size * 0.42, size * 0.4, size * 0.05, size / 2, size / 2, size * 0.5);
  gradient.addColorStop(0, '#f2efe8');
  gradient.addColorStop(0.7, '#c9c6bf');
  gradient.addColorStop(1, '#8d8b86');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  // Concentric machining marks.
  for (let r = 6; r < size / 2; r += 2) {
    ctx.strokeStyle = `rgba(${Math.random() < 0.5 ? '255,255,255' : '0,0,0'}, ${0.04 + Math.random() * 0.05})`;
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  drawCross(ctx, size, '#16161a');

  // Occlusion keeps reflected light out of the recess, so it reads as a hole rather than a raised cross.
  const [shade, sctx] = canvas(size);
  sctx.fillStyle = '#fff';
  sctx.fillRect(0, 0, size, size);
  sctx.filter = 'blur(2px)';
  drawCross(sctx, size, '#101010');

  const [height, hctx] = canvas(size);
  hctx.fillStyle = '#fff';
  hctx.fillRect(0, 0, size, size);
  hctx.filter = 'blur(3px)';
  drawCross(hctx, size, '#000');
  const map = new CanvasTexture(colour);
  map.colorSpace = SRGBColorSpace;
  const aoMap = new CanvasTexture(shade);
  aoMap.colorSpace = NoColorSpace;
  return { map, aoMap, normalMap: heightToNormal(height, 6) };
}

/** Concentric machining rings for the hub plate, as a normal map. */
function machinedNormal(): CanvasTexture {
  const size = 256;
  const [height, ctx] = canvas(size);
  const image = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x - size / 2, y - size / 2);
      const value = 128 + Math.sin(r * 1.9) * 40 + (Math.random() - 0.5) * 20;
      const i = (y * size + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
      image.data[i + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return heightToNormal(height, 0.8);
}

/** Fine paper fibre for the label, tiling. */
export function paperGrainNormal(): CanvasTexture {
  const size = 256;
  const [height, ctx] = canvas(size);
  const image = ctx.createImageData(size, size);
  for (let i = 0; i < image.data.length; i += 4) {
    const value = 128 + (Math.random() - 0.5) * 70;
    image.data[i] = image.data[i + 1] = image.data[i + 2] = value;
    image.data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
  ctx.filter = 'blur(0.6px)';
  ctx.drawImage(height, 0, 0);
  const texture = heightToNormal(height, 1.2);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(3, 2);
  return texture;
}

/**
 * Revolves a [radius, height] profile around the z axis (height toward +z, or -z for the back face).
 * Profiles run with the solid on their left, so lathe normals face out. Planar UVs land a flat map face-on.
 */
function lathe(profile: [number, number][], radius: number, facing: 1 | -1): LatheGeometry {
  const geometry = new LatheGeometry(
    profile.map(([r, h]) => new Vector2(r, h)),
    48,
  );
  geometry.rotateX((facing * Math.PI) / 2);
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < position.count; i++) {
    uv.setXY(i, position.getX(i) / (2 * radius) + 0.5, position.getY(i) / (2 * radius) + 0.5);
  }
  return geometry;
}

function screwHead(radius: number, facing: 1 | -1): LatheGeometry {
  const h = radius * 0.32;
  return lathe(
    [
      [radius, 0],
      [radius, h * 0.22],
      [radius * 0.93, h * 0.5],
      [radius * 0.72, h * 0.8],
      [radius * 0.4, h * 0.96],
      [0, h],
    ],
    radius,
    facing,
  );
}

/** Open counterbore: wall from the surface down to a flat floor (height measured up from the floor). */
function wellCup(radius: number, depth: number, facing: 1 | -1): LatheGeometry {
  return lathe(
    [
      [radius, depth],
      [radius, depth * 0.18],
      [radius * 0.9, 0],
      [0, 0],
    ],
    radius,
    facing,
  );
}

/** White with black ellipses at the openings (u, v, radius in u units), in shell UV space, for alphaMap cut-outs. */
function openingMask(openings: { u: number; v: number; radiusU: number }[], aspect: number): CanvasTexture {
  const size = 512;
  const [element, ctx] = canvas(size);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  for (const { u, v, radiusU } of openings) {
    ctx.beginPath();
    ctx.ellipse(u * size, (1 - v) * size, radiusU * size, radiusU * aspect * size, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new CanvasTexture(element);
  texture.colorSpace = NoColorSpace;
  return texture;
}

function ring(inner: number, outer: number, height: number, facing: 1 | -1): LatheGeometry {
  const lip = (outer - inner) * 0.25;
  return lathe(
    [
      [outer, 0],
      [outer, height * 0.7],
      [outer - lip, height],
      [inner + lip, height],
      [inner, height * 0.7],
      [inner, 0],
    ],
    outer,
    facing,
  );
}

export interface CartridgeDetailInput {
  cartridge: Group;
  /** The shell slab (caps: group 0 front, group 2 back; sides: group 1) and its z offset. */
  slabGeometry: BufferGeometry;
  /** Front cap (SHELL shader, `uWells`) and back cap materials; the screw openings are cut into both. */
  shellMaterial: ShaderMaterial;
  backMaterial: MeshBasicMaterial;
  slabZ: number;
  /** Outer faces of the shell, in cartridge space. */
  frontZ: number;
  backZ: number;
  /** Shell rectangle in cartridge space; screw and hub UVs map onto it. */
  rect: Rect;
  screws: { front: number[][]; back: number[][]; radius: number };
  backHub: { u: number; v: number; outer: number; inner: number; cap: number };
  /** Disc centre, top face z (the art plane), thickness and radius; hub sizes are fractions of the radius. */
  disc: {
    x: number;
    y: number;
    topZ: number;
    thickness: number;
    radius: number;
    hub: { hole: number; plate: number; ring: number[]; spindle: number };
    /** Hub plate bottom and top, in cartridge space. */
    hubBaseZ: number;
    hubTopZ: number;
  };
  normals: { front: Texture; back: Texture };
  environment: Texture | null;
  quality: DetailQuality;
}

/** Builds the realism layer into the cartridge. Returns the parts that spin with the disc. */
export function addCartridgeDetail(input: CartridgeDetailInput): { spinning: Object3D[] } {
  const { rect, environment: envMap, quality } = input;
  const width = rect.x1 - rect.x0;
  const height = rect.y1 - rect.y0;
  const toLocal = ([u, v]: number[]) => [rect.x0 + u * width, rect.y0 + v * height];
  const disc = input.disc;
  const R = disc.radius;

  // Back opening at the hub, centred on the disc. The back art prints its hub ring off-centre by `offset`,
  // so the opening and its steel bezel are sized to cover that print.
  const backHub = input.backHub;
  const [artX, artY] = toLocal([backHub.u, backHub.v]);
  const offset = Math.hypot(disc.x - artX, disc.y - artY);
  const openingR = backHub.inner * width - offset;
  const bezelR = backHub.outer * width + offset + 0.002;

  const steel = (overrides: MeshStandardMaterialParameters = {}) =>
    new MeshStandardMaterial({ color: '#c4c7cd', metalness: 1, roughness: 0.38, envMap, envMapIntensity: 0.35, ...overrides });

  // Screw wells: openings cut in both caps, a plastic counterbore below each, the screw head on its floor.
  const aspect = width / height;
  const wellRadiusU = input.screws.radius * WELL_RATIO;
  const wells = (points: number[][]) => points.map(([u, v]) => ({ u, v, radiusU: wellRadiusU }));
  const frontMask = openingMask(wells(input.screws.front), aspect);
  const backMask = openingMask(
    [...wells(input.screws.back), { u: (disc.x - rect.x0) / width, v: (disc.y - rect.y0) / height, radiusU: openingR / width }],
    aspect,
  );
  input.shellMaterial.uniforms.uWells.value = input.screws.front.map(([u, v]) => new Vector3(u, v, wellRadiusU));
  input.shellMaterial.uniforms.uWellAspect.value = aspect;
  input.backMaterial.alphaMap = backMask;
  input.backMaterial.alphaTest = 0.5;
  input.backMaterial.needsUpdate = true;
  const wellMaterial = new MeshStandardMaterial({ color: '#1b1f29', roughness: 0.42, envMap, envMapIntensity: 0.4 });

  const { map, aoMap, normalMap } = screwMaps();
  const screwMaterial = steel({
    color: '#ffffff',
    map,
    aoMap,
    normalMap,
    normalScale: new Vector2(0.7, 0.7),
    envMapIntensity: 0.28,
  });
  const radius = input.screws.radius * width;
  for (const [side, facing, floorZ] of [
    ['front', 1, input.frontZ - WELL_DEPTH],
    ['back', -1, input.backZ + WELL_DEPTH],
  ] as const) {
    const head = screwHead(radius, facing);
    const cup = wellCup(radius * WELL_RATIO, WELL_DEPTH, facing);
    for (const point of input.screws[side]) {
      const [x, y] = toLocal(point);
      const well = new Mesh(cup, wellMaterial);
      const screw = new Mesh(head, screwMaterial);
      well.position.set(x, y, floorZ);
      screw.position.set(x, y, floorZ);
      input.cartridge.add(well, screw);
    }
  }

  // Back opening: a steel bezel and a plastic wall up to the disc, so the hub shows through from behind.
  const bezel = new Mesh(ring(openingR, bezelR, 0.0022, -1), steel({ roughness: 0.22 }));
  bezel.position.set(disc.x, disc.y, input.backZ);
  const wallHeight = disc.topZ - disc.thickness - 0.0005 - input.backZ;
  const wall = new Mesh(
    new CylinderGeometry(openingR, openingR, wallHeight, 64, 1, true).rotateX(Math.PI / 2),
    new MeshStandardMaterial({ color: '#1b1f29', roughness: 0.42, envMap, envMapIntensity: 0.4, side: BackSide }),
  );
  wall.position.set(disc.x, disc.y, input.backZ + wallHeight / 2);
  input.cartridge.add(bezel, wall);

  // Disc body: the art is the top face (deck.ts); here its outer edge, inner wall and silver data side.
  const bottomZ = disc.topZ - disc.thickness;
  const holeR = disc.hub.hole * R;
  const edgeMaterial = new MeshStandardMaterial({ color: '#8d95a3', metalness: 0.55, roughness: 0.28, envMap, envMapIntensity: 0.45 });
  const tube = (radius: number, openInward: boolean) => {
    const geometry = new CylinderGeometry(radius, radius, disc.thickness, 96, 1, true);
    geometry.rotateX(Math.PI / 2);
    const mesh = new Mesh(geometry, openInward ? edgeMaterial.clone() : edgeMaterial);
    if (openInward) (mesh.material as MeshStandardMaterial).side = BackSide; // the wall faces into the hole
    mesh.position.set(disc.x, disc.y, disc.topZ - disc.thickness / 2);
    return mesh;
  };
  const dataSide: Material =
    quality === 'high'
      ? new MeshPhysicalMaterial({
          color: '#c3c8d1',
          metalness: 1,
          roughness: 0.22,
          iridescence: 0.8,
          iridescenceIOR: 1.6,
          envMap,
          envMapIntensity: 0.5,
        })
      : steel({ color: '#c3c8d1', roughness: 0.25, envMapIntensity: 0.45 });
  const underside = new Mesh(new RingGeometry(holeR, R, 96), dataSide);
  underside.rotation.x = Math.PI; // faces -z
  underside.position.set(disc.x, disc.y, bottomZ);
  input.cartridge.add(tube(R, false), tube(holeR, true), underside);

  // Metal hub: a separate machined part sitting in the disc's opening, standing proud of the art, with a
  // real centre hole for the spindle.
  const discHub = new Group();
  discHub.position.set(disc.x, disc.y, disc.hubBaseZ);
  const plateR = disc.hub.plate * R;
  const plateHeight = disc.hubTopZ - disc.hubBaseZ;
  const bevel = 0.0014;
  const spindleR = disc.hub.spindle * R;
  const plate = new Mesh(
    lathe(
      [
        [spindleR, 0],
        [plateR, 0],
        [plateR, plateHeight - bevel],
        [plateR - bevel, plateHeight],
        [spindleR, plateHeight],
        [spindleR, 0],
      ],
      plateR,
      1,
    ),
    steel({ color: '#6f747d', roughness: 0.42, normalMap: machinedNormal(), normalScale: new Vector2(0.35, 0.35) }),
  );
  const [ringInner, ringOuter] = disc.hub.ring.map((fraction) => fraction * R);
  const clamp = new Mesh(ring(ringInner, ringOuter, 0.0016, 1), steel({ color: '#d2d5da', roughness: 0.26, envMapIntensity: 0.4 }));
  clamp.position.z = plateHeight;
  const hole = new MeshBasicMaterial({ color: '#050507' });
  const lip = new Mesh(ring(spindleR, spindleR * 1.35, 0.0007, 1), steel({ roughness: 0.3 }));
  lip.position.z = plateHeight;
  discHub.add(plate, clamp, lip);
  for (const side of [-1, 1]) {
    const dimple = new Mesh(new CircleGeometry(0.02 * R, 20), hole);
    dimple.position.set(side * 0.2 * R, 0, plateHeight + 0.0001);
    discHub.add(dimple);
  }

  const additive = { transparent: true, blending: AdditiveBlending, depthWrite: false } as const;
  const sheenMaterial: Material =
    quality === 'high'
      ? new MeshPhysicalMaterial({
          color: 0x000000,
          roughness: 0.16,
          iridescence: 1,
          iridescenceIOR: 1.7,
          iridescenceThicknessRange: [260, 820],
          envMap,
          envMapIntensity: 0.25,
          ...additive,
        })
      : new MeshStandardMaterial({ color: 0x000000, roughness: 0.3, envMap, envMapIntensity: 0.35, ...additive });
  const sheen = new Mesh(new RingGeometry(plateR, R * 0.985, 96), sheenMaterial);
  sheen.position.set(disc.x, disc.y, disc.topZ + 0.0004);
  sheen.renderOrder = 1;
  input.cartridge.add(discHub, sheen);

  // Clear-plastic gloss over the whole shell: reflections and highlights only, the artwork untouched.
  const gloss = (normals: Texture | null, openings: Texture | null) => {
    const shared = {
      color: 0x000000,
      normalMap: normals,
      alphaMap: openings,
      normalScale: new Vector2(0.8, 0.8),
      envMap,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      ...additive,
    };
    return quality === 'high'
      ? new MeshPhysicalMaterial({ ...shared, roughness: 0.14, clearcoat: 0.5, clearcoatRoughness: 0.05, envMapIntensity: 0.15 })
      : new MeshStandardMaterial({ ...shared, roughness: 0.14, envMapIntensity: 0.15 });
  };
  const coat = new Mesh(input.slabGeometry, [
    gloss(input.normals.front, frontMask),
    gloss(null, null),
    gloss(input.normals.back, backMask),
  ]);
  coat.position.z = input.slabZ;
  coat.renderOrder = 6;
  input.cartridge.add(coat);

  return { spinning: [discHub] };
}

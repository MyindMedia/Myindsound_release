import {
  AdditiveBlending,
  BoxGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  RepeatWrapping,
  RingGeometry,
  Shape,
  SRGBColorSpace,
  Vector2,
  type Texture,
} from 'three';

/**
 * The laser pod: the optical drive mechanism under the seated disc, built after the reference photo
 * (docs/design-catalogue/laser-pod-reference.png, internal look-dev only). A stamped steel top plate with the
 * sled slot, riding on a galvanised base frame that sits on three rubber-grommet mounts; the optical pickup runs
 * along the slot on two guide rails, trailing its amber flex cable, and the spindle's turntable (spindle.ts)
 * turns in the plate's round opening. The pickup tracks the playback position across the disc (inner edge at
 * the start of the disc, outer edge at its end), and its lens glows faintly while the disc is running.
 *
 * Built in deck space around the disc centre; `floorZ` is the tray the pod stands on. Photo pixels map to deck
 * units with PX, centred on the photo's turntable, so the outline keeps the reference's proportions. Like a real
 * drive it is bigger than the window: its outer corners run on under the bezel.
 */

export interface LaserPodOptions {
  x: number;
  y: number;
  /** The tray the pod stands on (deck-space z). */
  floorZ: number;
  /** The turntable's radius (the spindle chuck's): the plate's opening clears it. */
  turntableRadius: number;
  environment: Texture | null;
}

/** Deck units per reference-photo pixel: the photo's turntable (72 px radius) at the spindle chuck's size. */
const PX = 0.00105;
/** The turntable's centre in the reference photo. */
const ORIGIN = { x: 785, y: 675 };
const p = (x: number, y: number) => new Vector2((x - ORIGIN.x) * PX, (ORIGIN.y - y) * PX);
const shape = (points: [number, number][]) => new Shape(points.map(([x, y]) => p(x, y)));

/** The stamped top plate's outline, clockwise from the left edge. */
const PLATE_OUTLINE: [number, number][] = [
  [340, 565], [452, 512], [600, 472], [690, 470], [790, 468], [872, 515], [915, 598], [915, 772],
  [862, 858], [600, 890], [482, 852], [340, 735],
];
/** The galvanised base frame under it, turned about 40° like the reference. */
const BASE_OUTLINE: [number, number][] = [
  [336, 600], [470, 500], [640, 452], [852, 372], [880, 392], [1040, 572], [1072, 616], [1062, 650],
  [642, 996], [598, 990], [470, 862], [336, 722],
];
/** The sled slot through the top plate, from the outer edge to just short of the turntable. */
const SLOT = { x0: 405, x1: 688, y0: 632, y1: 752 };
const MOUNTS: [number, number][] = [[560, 455], [1055, 625], [625, 985]];
const PLATE_SCREWS: [number, number][] = [[705, 490], [885, 605], [415, 545], [412, 745], [476, 820], [632, 860], [715, 860], [830, 776]];

const BASE_Z = 0.0025;
const PLATE_Z = 0.017;
const PLATE_THICKNESS = 0.0014;

/** A brushed-steel map: fine horizontal streaks over a soft diagonal falloff. Seeded so it never shimmers. */
function brushedSteel(size: number, tone: [string, string, string]): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const base = ctx.createLinearGradient(0, 0, size, size);
  base.addColorStop(0, tone[0]);
  base.addColorStop(0.5, tone[1]);
  base.addColorStop(1, tone[2]);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < size * 1.4; i++) {
    const y = random() * size;
    ctx.strokeStyle = `rgba(${random() < 0.5 ? '255,255,255' : '0,0,0'},${0.03 + random() * 0.07})`;
    ctx.lineWidth = 0.5 + random();
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(size, y + (random() - 0.5) * 2);
    ctx.stroke();
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  return texture;
}

/** A soft round glow for the lens (additive, so it only ever brightens). */
function glowTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const glow = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  glow.addColorStop(0, 'rgba(255,255,255,1)');
  glow.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 64, 64);
  return new CanvasTexture(canvas);
}

/** UVs across a flat extruded outline: its x/y over the given span, so a square texture lays on unstretched. */
function planarUv(geometry: ExtrudeGeometry, span: number): ExtrudeGeometry {
  const position = geometry.attributes.position;
  const uv = geometry.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, position.getX(i) / span + 0.5, position.getY(i) / span + 0.5);
  uv.needsUpdate = true;
  return geometry;
}

export class LaserPod {
  readonly group = new Group();
  private readonly sled = new Group();
  private readonly glow: MeshBasicMaterial;
  private readonly innerX: number;
  private readonly outerX: number;
  private progress = 0;
  private target = 0;
  private running = 0;

  constructor(options: LaserPodOptions) {
    const envMap = options.environment;
    this.group.position.set(options.x, options.y, options.floorZ);

    // ── Base frame: galvanised steel, embossed ribs, standing on the three mounts ──────────────────────
    const galvanised = new MeshStandardMaterial({
      color: '#c3ccd6',
      map: brushedSteel(256, ['#d6dbe0', '#c4cad1', '#b3bac3']),
      metalness: 0.55,
      roughness: 0.48,
      envMap,
      envMapIntensity: 0.45,
    });
    const base = new Mesh(planarUv(new ExtrudeGeometry(shape(BASE_OUTLINE), { depth: 0.0012, bevelEnabled: false }), 0.7), galvanised);
    base.position.z = BASE_Z;
    // Two pressed ribs on the frame's exposed upper right, as in the reference.
    for (const [x0, y0, x1, y1] of [
      [838, 420, 1005, 585],
      [930, 560, 985, 700],
    ]) {
      const a = p(x0, y0);
      const b = p(x1, y1);
      const length = a.distanceTo(b);
      const rib = new Mesh(new CylinderGeometry(7 * PX, 7 * PX, length, 12, 1, false, 0, Math.PI).rotateY(-Math.PI / 2), galvanised);
      rib.position.set((a.x + b.x) / 2, (a.y + b.y) / 2, BASE_Z + 0.0012);
      rib.rotation.z = Math.atan2(b.y - a.y, b.x - a.x) - Math.PI / 2;
      rib.scale.z = 0.35;
      this.group.add(rib);
    }
    this.group.add(base);

    // Rubber grommet mounts with a Torx head in each.
    const rubber = new MeshStandardMaterial({ color: '#141518', roughness: 0.85, envMap, envMapIntensity: 0.15 });
    const torx = new MeshStandardMaterial({ color: '#2b2e34', metalness: 0.8, roughness: 0.4, envMap, envMapIntensity: 0.4 });
    const star = new Shape();
    for (let i = 0; i < 12; i++) {
      const angle = (i / 12) * Math.PI * 2;
      const radius = (i % 2 === 0 ? 6.5 : 3.8) * PX;
      const point = new Vector2(Math.cos(angle) * radius, Math.sin(angle) * radius);
      if (i === 0) star.moveTo(point.x, point.y);
      else star.lineTo(point.x, point.y);
    }
    for (const [x, y] of MOUNTS) {
      const at = p(x, y);
      const grommet = new Mesh(new CylinderGeometry(19 * PX, 20 * PX, 0.006, 32).rotateX(Math.PI / 2), rubber);
      grommet.position.set(at.x, at.y, BASE_Z + 0.003);
      const head = new Mesh(new CylinderGeometry(10 * PX, 10 * PX, 0.0016, 24).rotateX(Math.PI / 2), torx);
      head.position.set(at.x, at.y, BASE_Z + 0.0068);
      const recess = new Mesh(new ExtrudeGeometry(star, { depth: 0.0004, bevelEnabled: false }), rubber);
      recess.position.set(at.x, at.y, BASE_Z + 0.0076);
      this.group.add(grommet, head, recess);
    }

    // ── Under the slot: the drive's dark interior and the sled's two guide rails ───────────────────────
    const slotA = p(SLOT.x0, SLOT.y1);
    const slotB = p(SLOT.x1, SLOT.y0);
    const slotW = slotB.x - slotA.x;
    const slotH = slotB.y - slotA.y;
    const slotCentre = new Vector2((slotA.x + slotB.x) / 2, (slotA.y + slotB.y) / 2);
    const interior = new Mesh(
      new PlaneGeometry(slotW + 0.02, slotH + 0.02),
      new MeshStandardMaterial({ color: '#0c0d11', roughness: 0.8 }),
    );
    interior.position.set(slotCentre.x, slotCentre.y, BASE_Z + 0.0014);
    const rail = new MeshStandardMaterial({ color: '#c9ccd2', metalness: 1, roughness: 0.3, envMap, envMapIntensity: 0.4 });
    for (const side of [-1, 1]) {
      const rod = new Mesh(new CylinderGeometry(2.5 * PX, 2.5 * PX, slotW + 0.03, 12).rotateZ(Math.PI / 2), rail);
      rod.position.set(slotCentre.x, slotCentre.y + side * slotH * 0.38, PLATE_Z - 0.006);
      this.group.add(rod);
    }
    this.group.add(interior);

    // ── The top plate: stamped stainless, the slot and the turntable's opening cut through ─────────────
    const outline = shape(PLATE_OUTLINE);
    const slotPath = new Path();
    slotPath.moveTo(slotA.x, slotA.y);
    slotPath.lineTo(slotB.x, slotA.y);
    slotPath.lineTo(slotB.x, slotB.y);
    slotPath.lineTo(slotA.x, slotB.y);
    slotPath.closePath();
    const opening = new Path();
    opening.absarc(0, 0, options.turntableRadius * 1.08, 0, Math.PI * 2, true);
    outline.holes.push(slotPath, opening);
    const steel = new MeshStandardMaterial({
      color: '#b6b9bf',
      map: brushedSteel(512, ['#d9dbdf', '#9ea2a9', '#c4c7cc']),
      metalness: 1,
      roughness: 0.34,
      envMap,
      envMapIntensity: 0.9,
    });
    const plate = new Mesh(
      planarUv(new ExtrudeGeometry(outline, { depth: PLATE_THICKNESS, bevelEnabled: true, bevelThickness: 0.0005, bevelSize: 0.0006, bevelSegments: 1 }), 0.62),
      steel,
    );
    plate.position.z = PLATE_Z;
    // Standoffs from the frame up to the plate, hidden at the plate's corners.
    for (const [x, y] of [[420, 560], [880, 600], [620, 870]] as [number, number][]) {
      const at = p(x, y);
      const post = new Mesh(new CylinderGeometry(7 * PX, 7 * PX, PLATE_Z - BASE_Z, 12).rotateX(Math.PI / 2), galvanised);
      post.position.set(at.x, at.y, (PLATE_Z + BASE_Z) / 2);
      this.group.add(post);
    }
    this.group.add(plate);

    const plateTop = PLATE_Z + PLATE_THICKNESS + 0.0005;
    const screwHead = new MeshStandardMaterial({ color: '#d0d3d8', metalness: 1, roughness: 0.28, envMap, envMapIntensity: 0.8 });
    for (const [x, y] of PLATE_SCREWS) {
      const at = p(x, y);
      const screw = new Mesh(new CylinderGeometry(4.5 * PX, 5 * PX, 0.0012, 16).rotateX(Math.PI / 2), screwHead);
      screw.position.set(at.x, at.y, plateTop + 0.0006);
      this.group.add(screw);
    }

    // Latches (black blocks, bent steel clips) and the silver leaf switch, as on the reference.
    const plastic = new MeshStandardMaterial({ color: '#17181c', roughness: 0.55, envMap, envMapIntensity: 0.2 });
    const clip = new MeshStandardMaterial({ color: '#d4d7dc', metalness: 1, roughness: 0.3, envMap, envMapIntensity: 0.7 });
    const block = (x: number, y: number, w: number, h: number, d: number, material: MeshStandardMaterial) => {
      const at = p(x, y);
      const mesh = new Mesh(new BoxGeometry(w * PX, h * PX, d), material);
      mesh.position.set(at.x, at.y, plateTop + d / 2);
      this.group.add(mesh);
      return mesh;
    };
    block(740, 522, 26, 58, 0.005, plastic);
    block(733, 505, 14, 36, 0.0068, clip);
    block(768, 778, 28, 24, 0.0045, plastic);
    block(784, 778, 12, 14, 0.0056, clip);
    block(500, 532, 30, 22, 0.004, plastic);
    block(470, 780, 22, 30, 0.004, plastic);
    block(776, 823, 82, 44, 0.0035, clip);
    block(776, 823, 60, 8, 0.0042, plastic);

    // ── The sled: pickup body, lens, its board and the flex cable back to the frame ────────────────────
    this.innerX = slotB.x - 42 * PX;
    this.outerX = slotA.x + 44 * PX;
    const body = new Mesh(
      new BoxGeometry(76 * PX, slotH * 0.86, 0.011),
      new MeshStandardMaterial({ color: '#c9ccd1', metalness: 1, roughness: 0.26, map: brushedSteel(128, ['#e4e6e9', '#b2b6bc', '#d3d6da']), envMap, envMapIntensity: 0.85 }),
    );
    body.position.z = PLATE_Z + 0.0045;
    const cover = new Mesh(new BoxGeometry(54 * PX, slotH * 0.46, 0.0016), clip);
    cover.position.set(-2 * PX, slotH * 0.14, PLATE_Z + 0.0108);
    const board = new Mesh(new BoxGeometry(22 * PX, slotH * 0.7, 0.0024), new MeshStandardMaterial({ color: '#1f5a3c', roughness: 0.6 }));
    board.position.set(46 * PX, -slotH * 0.02, PLATE_Z + 0.001);
    const lensHousing = new Mesh(new CylinderGeometry(13 * PX, 13 * PX, 0.0022, 32).rotateX(Math.PI / 2), plastic);
    lensHousing.position.set(-5 * PX, slotH * 0.14, PLATE_Z + 0.0127);
    const lens = new Mesh(
      new CircleGeometry(9 * PX, 32),
      new MeshStandardMaterial({ color: '#0d1024', metalness: 0.3, roughness: 0.04, envMap, envMapIntensity: 1.4 }),
    );
    lens.position.set(-5 * PX, slotH * 0.14, PLATE_Z + 0.0139);
    // The coating's violet cast, a thin ring round the lens.
    const coating = new Mesh(
      new RingGeometry(6.5 * PX, 9 * PX, 32),
      new MeshBasicMaterial({ color: new Color('#6a5cff'), transparent: true, opacity: 0.35, depthWrite: false }),
    );
    coating.position.set(-5 * PX, slotH * 0.14, PLATE_Z + 0.014);
    this.glow = new MeshBasicMaterial({
      map: glowTexture(),
      color: new Color('#ff3348'),
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const glow = new Mesh(new PlaneGeometry(40 * PX, 40 * PX), this.glow);
    glow.position.set(-5 * PX, slotH * 0.14, PLATE_Z + 0.0142);
    glow.renderOrder = 5;
    this.sled.add(body, cover, board, lensHousing, lens, coating, glow);
    this.sled.position.y = slotCentre.y;
    this.group.add(this.sled);

    // The flex cable: amber polyimide from the slot's outer end into the sled, re-laid as the sled moves.
    this.cable = new Mesh(
      new PlaneGeometry(1, slotH * 0.28),
      new MeshStandardMaterial({ color: '#b8641c', roughness: 0.42, metalness: 0.1, envMap, envMapIntensity: 0.5 }),
    );
    this.cable.position.set(0, slotCentre.y + slotH * 0.1, PLATE_Z - 0.001);
    this.cableFrom = slotA.x + 0.004;
    this.group.add(this.cable);
    this.apply();
  }

  private readonly cable: Mesh;
  private readonly cableFrom: number;

  /** Where the pickup reads: 0 at the disc's inner edge (the start), 1 at its outer edge (the end). */
  setProgress(progress: number, immediate = false): void {
    this.target = Math.max(0, Math.min(1, progress));
    if (immediate) {
      this.progress = this.target;
      this.apply();
    }
  }

  /** `running`: the disc's speed as a share of play speed (0 stopped, 1 playing), which lights the lens. */
  update(dt: number, running: number): void {
    if (this.progress !== this.target) {
      // The sled seeks fast and settles; tracking during play is too slow to see the ease.
      const next = this.progress + (this.target - this.progress) * (1 - Math.exp(-dt * 6));
      this.progress = Math.abs(next - this.target) < 1e-4 ? this.target : next;
      this.apply();
    }
    this.running += (Math.max(0, Math.min(1, running)) - this.running) * (1 - Math.exp(-dt * 5));
    this.glow.opacity = this.running * 0.55;
  }

  private apply(): void {
    const x = this.innerX + (this.outerX - this.innerX) * this.progress;
    this.sled.position.x = x;
    const end = x - 30 * PX;
    this.cable.scale.x = Math.max(0.001, end - this.cableFrom);
    this.cable.position.x = (this.cableFrom + end) / 2;
  }
}

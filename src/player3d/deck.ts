import {
  AdditiveBlending,
  Color,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  Shape,
  ShaderMaterial,
  Vector2,
  Vector3,
  type Material,
  type Object3D,
  type Texture,
  type UVGenerator,
} from 'three';
import { addCartridgeDetail, paperGrainNormal, type DetailQuality } from './cartridge-detail';
import geometry from './geometry.json';
import type { Bounds } from './scene';
import { SHELL } from './shaders';
import type { KeyId } from './state';
import type { DeckTextures } from './textures';

type Rect = { x0: number; y0: number; x1: number; y1: number };

export const BODY_DEPTH = 0.16;
export const CART_DEPTH = 0.036;
export const CART_SEATED_Z = -BODY_DEPTH / 2;
/** Rounded shell edges that catch highlights. */
const CART_BEVEL = 0.004;
const KEY_DEPTH = 0.09;
const KEY_TRAVEL = 0.05;
const KEY_FRONT_Z = -0.006;
const RPM_RESPONSE = 3;

const width = (r: Rect) => r.x1 - r.x0;
const height = (r: Rect) => r.y1 - r.y0;
const centre = (r: Rect) => new Vector2((r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2);

/** Maps extrusion caps onto a texture covering `rect`; side walls get a plain 0..1 quad. */
function rectUv(rect: Rect): UVGenerator {
  return {
    generateTopUV: (_geometry, vertices, a, b, c) =>
      [a, b, c].map((i) => new Vector2((vertices[i * 3] - rect.x0) / width(rect), (vertices[i * 3 + 1] - rect.y0) / height(rect))),
    generateSideWallUV: () => [new Vector2(0, 0), new Vector2(1, 0), new Vector2(1, 1), new Vector2(0, 1)],
  };
}

/**
 * Caps as `rectUv`; side walls sample the cap texture just inside the outline, so the edge carries the
 * shell's own rim colour all the way round instead of a flat or see-through strip.
 */
function rimUv(rect: Rect, inset: number): UVGenerator {
  const cx = (rect.x0 + rect.x1) / 2;
  const cy = (rect.y0 + rect.y1) / 2;
  const toUv = (vertices: number[], i: number, pull: number) => {
    const x = vertices[i * 3] + (cx - vertices[i * 3]) * pull;
    const y = vertices[i * 3 + 1] + (cy - vertices[i * 3 + 1]) * pull;
    return new Vector2((x - rect.x0) / width(rect), (y - rect.y0) / height(rect));
  };
  return {
    generateTopUV: (_geometry, vertices, a, b, c) => [a, b, c].map((i) => toUv(vertices, i, 0)),
    generateSideWallUV: (_geometry, vertices, a, b, c, d) => [a, b, c, d].map((i) => toUv(vertices, i, inset)),
  };
}

function roundedRect(rect: Rect, radius: number): Shape {
  const shape = new Shape();
  const { x0, y0, x1, y1 } = rect;
  const r = Math.min(radius, width(rect) / 2, height(rect) / 2);
  shape.moveTo(x0 + r, y0);
  shape.lineTo(x1 - r, y0);
  shape.quadraticCurveTo(x1, y0, x1, y0 + r);
  shape.lineTo(x1, y1 - r);
  shape.quadraticCurveTo(x1, y1, x1 - r, y1);
  shape.lineTo(x0 + r, y1);
  shape.quadraticCurveTo(x0, y1, x0, y1 - r);
  shape.lineTo(x0, y0 + r);
  shape.quadraticCurveTo(x0, y0, x0 + r, y0);
  return shape;
}

/**
 * ExtrudeGeometry puts both caps in group 0: the back cap (z = 0) first, then the front cap.
 * Gives the back cap its own material index.
 */
function splitCaps(geometry: ExtrudeGeometry, backMaterialIndex: number): void {
  const [caps, sides] = geometry.groups;
  const half = caps.count / 2;
  geometry.clearGroups();
  geometry.addGroup(caps.start, half, backMaterialIndex);
  geometry.addGroup(caps.start + half, half, 0);
  geometry.addGroup(sides.start, sides.count, 1);
}

function plane(rect: Rect, material: Material, z: number): Mesh {
  const mesh = new Mesh(new PlaneGeometry(width(rect), height(rect)), material);
  const c = centre(rect);
  mesh.position.set(c.x, c.y, z);
  return mesh;
}

export interface KeyMesh {
  id: KeyId;
  mesh: Mesh;
  cap: MeshBasicMaterial;
  restY: number;
  depth: number;
  target: number;
}

export class Deck {
  readonly group = new Group();
  readonly cartridge = new Group();
  readonly doorPivot = new Group();
  readonly keys = new Map<KeyId, KeyMesh>();
  readonly hitTargets: Object3D[] = [];
  readonly bounds: Bounds;
  readonly bodyTop: number;
  readonly cartridgeWidth: number;
  readonly cartridgeHeight: number;
  readonly glare: MeshBasicMaterial;
  private discs: Mesh[] = [];
  private rpm = 0;
  private rpmTarget = 0;
  private readonly spinScale: number;
  private readonly environment: Texture | null;
  private readonly quality: DetailQuality;

  constructor(
    textures: DeckTextures,
    options: { reducedMotion: boolean; environment?: Texture | null; quality?: DetailQuality },
  ) {
    this.spinScale = options.reducedMotion ? 0.2 : 1;
    this.environment = options.environment ?? null;
    this.quality = options.quality ?? 'high';
    const bodyRect = geometry.body.rect as Rect;
    this.bodyTop = bodyRect.y1;
    const plastic = new MeshStandardMaterial({ color: '#1A1A1A', roughness: 0.55, metalness: 0.15 });

    // Body: extruded outline with the window cut through, art on the front cap.
    const outline = new Shape(geometry.body.outline.map(([x, y]) => new Vector2(x, y)));
    outline.holes.push(new Path(geometry.body.hole.map(([x, y]) => new Vector2(x, y))));
    const bodyGeometry = new ExtrudeGeometry(outline, {
      depth: BODY_DEPTH,
      bevelEnabled: false,
      UVGenerator: rectUv(bodyRect),
    });
    const bodyCap = new MeshBasicMaterial({ map: textures.body, alphaTest: 0.35 });
    const body = new Mesh(bodyGeometry, [bodyCap, plastic]);
    body.position.z = -BODY_DEPTH;
    this.group.add(body);
    this.hitTargets.push(body);

    // Cavity: back plate and the empty "WAY UP" tray, visible through the window.
    const backplate = plane(
      geometry.backplate.rect,
      new MeshBasicMaterial({ map: textures.backplate, color: new Color(0.45, 0.45, 0.5), transparent: true }),
      -BODY_DEPTH + 0.003,
    );
    const tray = plane(
      geometry.tray.rect,
      new MeshBasicMaterial({ map: textures.tray, transparent: true, color: new Color(0.82, 0.84, 0.86) }),
      -BODY_DEPTH + 0.008,
    );
    this.group.add(backplate, tray);
    this.hitTargets.push(tray);

    // Glass glare over the window.
    this.glare = new MeshBasicMaterial({
      map: textures.glare,
      transparent: true,
      opacity: 0.14,
      blending: AdditiveBlending,
      depthWrite: false,
      toneMapped: false,
    });
    const glare = plane(geometry.tray.rect, this.glare, -0.004);
    glare.renderOrder = 10;
    this.group.add(glare);

    // Slot and hinged door on the top face.
    const cartRect = geometry.cartridge.rect as Rect;
    this.cartridgeWidth = width(cartRect);
    this.cartridgeHeight = height(cartRect);
    const slotWidth = width(cartRect) + 0.03;
    const slot = new Mesh(new PlaneGeometry(slotWidth, 0.03), new MeshBasicMaterial({ color: '#020203' }));
    slot.rotation.x = -Math.PI / 2;
    slot.position.set(centre(cartRect).x, this.bodyTop + 0.0008, CART_SEATED_Z);
    const door = new Mesh(
      new PlaneGeometry(slotWidth, 0.03),
      new MeshStandardMaterial({ color: '#26262b', roughness: 0.4, metalness: 0.3, side: DoubleSide }),
    );
    door.rotation.x = -Math.PI / 2;
    door.position.set(0, 0, -0.015);
    this.doorPivot.position.set(centre(cartRect).x, this.bodyTop + 0.0012, CART_SEATED_Z + 0.015);
    this.doorPivot.add(door);
    this.group.add(slot, this.doorPivot);

    this.buildCartridge(textures, cartRect);
    this.buildKeys(textures);

    const lowestKey = Math.min(...geometry.keys.map((key) => key.rect.y0));
    this.bounds = { minX: bodyRect.x0, maxX: bodyRect.x1, minY: lowestKey, maxY: this.bodyTop + 0.04 };
  }

  private buildCartridge(textures: DeckTextures, cartRect: Rect): void {
    const c = centre(cartRect);
    const local: Rect = {
      x0: cartRect.x0 - c.x,
      y0: cartRect.y0 - c.y,
      x1: cartRect.x1 - c.x,
      y1: cartRect.y1 - c.y,
    };
    const disc = geometry.cartridge.discUv;
    const shellMaterial = new ShaderMaterial({
      vertexShader: SHELL.vertexShader,
      fragmentShader: SHELL.fragmentShader,
      uniforms: {
        uMap: { value: textures.shell },
        uDisc: { value: [disc.cx, disc.cy, disc.rx, disc.ry] },
        uDim: { value: 1 },
      },
      transparent: true,
    });
    // Solid edge in the shell's own rim texture; emissive keeps it matching the unlit caps. Double-sided with the
    // back cap, so looking past the disc through the window shows the inside of the shell, never the scene.
    const edge = new MeshStandardMaterial({
      map: textures.shell,
      emissiveMap: textures.shell,
      emissive: new Color(0.6, 0.6, 0.6),
      roughness: 0.3,
      metalness: 0.15,
      side: DoubleSide,
    });
    // Seen from behind in the eject inspector: the back cap is its own face (metal hub), fully opaque (the build
    // lays the art over dark plastic), so it hides the disc and has no see-through edges.
    const back = new MeshBasicMaterial({ map: textures.shellBack, side: DoubleSide });
    // The bevel grows the outline and depth, so the shape is inset to keep the cartridge's size.
    const inset: Rect = { x0: local.x0 + CART_BEVEL, y0: local.y0 + CART_BEVEL, x1: local.x1 - CART_BEVEL, y1: local.y1 - CART_BEVEL };
    const slabGeometry = new ExtrudeGeometry(roundedRect(inset, 0.035 - CART_BEVEL), {
      depth: CART_DEPTH - 2 * CART_BEVEL,
      bevelEnabled: true,
      bevelThickness: CART_BEVEL,
      bevelSize: CART_BEVEL,
      bevelSegments: 3,
      UVGenerator: rimUv(local, 0.035),
    });
    splitCaps(slabGeometry, 2);
    const slab = new Mesh(slabGeometry, [shellMaterial, edge, back]);
    slab.position.z = -CART_DEPTH / 2 + CART_BEVEL;
    slab.renderOrder = 3;

    const discCentre = new Vector2(geometry.disc.center[0] - c.x, geometry.disc.center[1] - c.y);
    const radius = geometry.disc.radius;
    const litDisc = new Mesh(
      new PlaneGeometry(radius * 2, radius * 2),
      new MeshBasicMaterial({ map: textures.disc, transparent: true, alphaTest: 0.05 }),
    );
    litDisc.position.set(discCentre.x, discCentre.y, -0.008);
    litDisc.renderOrder = 1;
    const clearRadius = radius * geometry.clearDisc.radiusRatio;
    const clearDisc = new Mesh(
      new PlaneGeometry(clearRadius * 2, clearRadius * 2),
      new MeshBasicMaterial({ map: textures.discClear, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    clearDisc.position.set(discCentre.x, discCentre.y, -0.003);
    clearDisc.renderOrder = 2;
    this.discs.push(litDisc, clearDisc);

    const labelRect = geometry.label.rect as Rect;
    // Sits a touch lower than in the Canva comp so the window frame doesn't clip the handwriting.
    const labelDrop = 0.045;
    const labelLocal: Rect = {
      x0: labelRect.x0 - c.x,
      y0: labelRect.y0 - c.y - labelDrop,
      x1: labelRect.x1 - c.x,
      y1: labelRect.y1 - c.y - labelDrop,
    };
    // Paper sticker: lit so it shades as it turns, with fibre grain; emissive keeps the handwriting legible.
    const label = plane(
      labelLocal,
      new MeshStandardMaterial({
        map: textures.label,
        emissiveMap: textures.label,
        emissive: new Color(0.62, 0.62, 0.62),
        normalMap: paperGrainNormal(),
        normalScale: new Vector2(0.5, 0.5),
        roughness: 0.92,
        transparent: true,
        envMap: this.environment,
        envMapIntensity: 0.1,
      }),
      CART_DEPTH / 2 + 0.0015,
    );
    label.renderOrder = 4;
    // Its thickness, seen when the cartridge is edge-on.
    const paperEdge = 0.0045;
    const stock = new Mesh(
      new ExtrudeGeometry(
        roundedRect(
          { x0: labelLocal.x0 + paperEdge, y0: labelLocal.y0 + paperEdge, x1: labelLocal.x1 - paperEdge, y1: labelLocal.y1 - paperEdge },
          0.01,
        ),
        { depth: 0.0013, bevelEnabled: false },
      ),
      new MeshStandardMaterial({ color: '#b9b3a8', roughness: 0.95 }),
    );
    stock.position.z = CART_DEPTH / 2 + 0.0001;

    this.cartridge.add(litDisc, clearDisc, slab, stock, label);
    addCartridgeDetail({
      cartridge: this.cartridge,
      slabGeometry,
      slabZ: slab.position.z,
      frontZ: CART_DEPTH / 2,
      backZ: -CART_DEPTH / 2,
      rect: local,
      screws: geometry.cartridge.screws,
      backHub: geometry.cartridge.backHub,
      disc: { x: discCentre.x, y: discCentre.y, z: litDisc.position.z, radius, hubRing: geometry.disc.hubRing },
      normals: { front: textures.shellNormal, back: textures.shellBackNormal },
      environment: this.environment,
      quality: this.quality,
    });
    this.cartridge.position.set(c.x, c.y, CART_SEATED_Z);
    this.cartridge.userData.seated = new Vector3(c.x, c.y, CART_SEATED_Z);
    this.group.add(this.cartridge);
    this.hitTargets.push(slab);
  }

  private buildKeys(textures: DeckTextures): void {
    const keyRects = geometry.keys as { id: KeyId; rect: Rect }[];
    const top = Math.max(...keyRects.map((key) => key.rect.y1));
    const bottom = Math.min(...keyRects.map((key) => key.rect.y0));
    const well = plane(
      { x0: -0.5, y0: bottom - 0.01, x1: 0.5, y1: top },
      new MeshBasicMaterial({ color: '#050507' }),
      -KEY_DEPTH - 0.02,
    );
    this.group.add(well);

    for (const { id, rect } of keyRects) {
      const c = centre(rect);
      const gap = 0.002;
      const local: Rect = {
        x0: rect.x0 - c.x + gap,
        y0: rect.y0 - c.y,
        x1: rect.x1 - c.x - gap,
        y1: rect.y1 - c.y,
      };
      const cap = new MeshBasicMaterial({ map: textures[`key-${id}`], alphaTest: 0.3 });
      const side =
        id === 'red'
          ? new MeshStandardMaterial({ color: '#b3231b', roughness: 0.45 })
          : new MeshStandardMaterial({ color: '#b9b9bd', roughness: 0.5 });
      const mesh = new Mesh(
        new ExtrudeGeometry(roundedRect(local, 0.012), { depth: KEY_DEPTH, bevelEnabled: false, UVGenerator: rectUv(local) }),
        [cap, side],
      );
      mesh.position.set(c.x, c.y, KEY_FRONT_Z - KEY_DEPTH);
      mesh.userData.keyId = id;
      this.group.add(mesh);
      this.hitTargets.push(mesh);
      this.keys.set(id, { id, mesh, cap, restY: c.y, depth: 0, target: 0 });
    }
  }

  setDiscRpm(rpm: number): void {
    this.rpmTarget = rpm;
  }

  /** Immediate RPM, used by the insert timeline tween. */
  forceDiscRpm(rpm: number): void {
    this.rpm = rpm;
    this.rpmTarget = rpm;
  }

  getDiscRpm(): number {
    return this.rpm;
  }

  setKeyTarget(id: KeyId, depth: number): void {
    const key = this.keys.get(id);
    if (key) key.target = depth;
  }

  update(dt: number): void {
    this.rpm += (this.rpmTarget - this.rpm) * (1 - Math.exp(-dt * RPM_RESPONSE));
    const angle = ((this.rpm * Math.PI * 2) / 60) * dt * this.spinScale;
    for (const disc of this.discs) disc.rotation.z -= angle;

    for (const key of this.keys.values()) {
      // Fast in (80 ms feel), slightly slower out.
      const rate = key.target > key.depth ? 38 : 22;
      key.depth += (key.target - key.depth) * (1 - Math.exp(-dt * rate));
      key.mesh.position.z = KEY_FRONT_Z - KEY_DEPTH - key.depth * KEY_TRAVEL;
      key.mesh.position.y = key.restY + key.depth * 0.022;
      key.cap.color.setScalar(1 - key.depth * 0.42);
    }
  }

  setCartridgeVisible(visible: boolean): void {
    this.cartridge.visible = visible;
  }

  seatCartridge(): void {
    const seated = this.cartridge.userData.seated as Vector3;
    this.cartridge.position.copy(seated);
    this.cartridge.rotation.set(0, 0, 0);
    this.cartridge.visible = true;
  }

  windowAnchor(): Vector3 {
    const c = centre(geometry.tray.rect);
    return new Vector3(c.x, c.y, 0);
  }

  discAnchor(): { centre: Vector3; edge: Vector3 } {
    const [x, y] = geometry.disc.center;
    return { centre: new Vector3(x, y, 0), edge: new Vector3(x + geometry.disc.radius, y, 0) };
  }

  slotAnchor(): Vector3 {
    return new Vector3(0, this.bodyTop, 0);
  }
}

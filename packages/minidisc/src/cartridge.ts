/**
 * The generated cartridge, built in LIT's space (`CartridgeBuilderInput`, deck.ts) so the deck's spindle,
 * window, inspector and insert timelines fit it unchanged:
 * - the shell slab with the preset's plastic: `MeshPhysicalMaterial` transmission, thickness, tint and IOR on
 *   the high tier (the disc and the moulded internals show through, more or less, per preset), a translucent
 *   standard material on the coarse-pointer tier (BUN-0a), and the moulding as a normal map;
 * - the inner chassis and the disc cavity wall, seen through clear shells;
 * - the disc with the art printed on it (or a gold/silver pressing);
 * - LIT's realism layer (`addCartridgeDetail`): screws in counterbored wells, the machined hub, the disc's
 *   edge and silver underside, the iridescent sheen, the clear-plastic coat, the back opening for the spindle;
 * - the label plate (brushed metal or paper sticker) with the release's text, the stickers, and the edition
 *   stamp; plus the copy's wear (`wear-render.ts`) through the same detail hook LIT uses.
 */
import {
  BackSide,
  CanvasTexture,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  PlaneGeometry,
  ShaderChunk,
  Vector2,
  Vector3,
  type BufferGeometry,
  type IUniform,
  type Material,
  type Object3D,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import {
  addCartridgeDetail,
  paperGrainNormal,
  setCartridgeDetailHook,
  type ShellMaterial,
} from '../../../src/player3d/cartridge-detail';
import { rimUv, roundedRect, splitCaps, type CartridgeBuild, type CartridgeBuilderInput, type Rect } from '../../../src/player3d/deck';
import { CartridgeWear, type WearInput, type WearZone } from '../../../src/player3d/wear-render';
import { canvas, hashString, heightToNormal, srgbTexture, type ArtSource } from './canvas';
import { imageStickers, placeImageSticker, printedStickers, resolveShellWindow, type DiscDesign } from './design';
import { resolvePreset, type ShellPreset } from './presets';
import { BACK_HUB, LASER_WINDOW, SCREW_BORE, TONGUE_BOTTOM_T, backHeight, backSkin, buildMoulding, plasticSpeckle } from './moulding';
import { PLATE_ASPECT, STAMP_UV, chassisPrint, discPrint, platePrint, shellNormal, stampPrint, stickerPrint } from './prints';

/** The art the cartridge prints: the cover (sleeve) and the disc face (defaults to the cover). */
export interface DesignArt {
  cover: ArtSource;
  disc: ArtSource;
  /** Image stickers' art, by their `src` (`ImageSticker`). */
  stickers?: Record<string, ArtSource>;
  /** The uploaded label image (`labelArt`): printed on the shutter's label in place of the title. */
  label?: ArtSource;
}

export interface BuildOptions {
  /**
   * High tier only: whether the shell uses real transmission (default true). Off when rendering over a
   * transparent background (`renderSpinLoop`): the transmission buffer clears to black, so glass goes dark.
   */
  transmission?: boolean;
  /** The bundle manifest's `wearSafeZones`, kept clear of dust and scratches. */
  wearSafeZones?: readonly WearZone[];
  anisotropy?: number;
}

export interface BuiltCartridge extends CartridgeBuild {
  /** The label plate's rectangle in cartridge space (null with `labelStyle: 'none'`). */
  plateRect: Rect | null;
  /** The copy's wear (PRD §11.4); `null` shows it pristine. */
  setWear(descriptor: WearInput | null): void;
  /** The edition stamp; `null` takes it off. */
  setEdition(edition: number | null): void;
  /** The metal shutter: 0 closed over the disc's left side, 1 slid down onto the tongue's track. */
  setShutter(open: number): void;
  dispose(): void;
}

/**
 * Corner screws, in shell UV (v up; the same four on the back), where refs 19 and 33 have them: tight in the
 * corners, the left pair just clear of the side rail. Always exposed, recessed in their wells as on LIT's disc:
 * the moulded frame is counterbored round each (moulding.ts), and nothing on the face covers them.
 */
const SCREWS = {
  front: [
    [0.088, 0.958],
    [0.91, 0.958],
    [0.084, 0.042],
    [0.889, 0.042],
  ],
  back: [
    [0.088, 0.958],
    [0.91, 0.958],
    [0.084, 0.042],
    [0.889, 0.042],
  ],
  radius: 0.021,
};
/** LIT's well is the screw's radius times this (cartridge-detail.ts WELL_RATIO). */
const SCREW_WELL_RATIO = 1.38;
/**
 * The shutter plate: from the left edge (it wraps round it) over the disc's left half, level with the hub, as
 * refs 19 and 33 have it (255 of 658 px wide).
 */
const PLATE = { left: 0, width: 0.388, centreY: 0.0 };
export { STAMP_UV } from './prints';
/** With no plate: the stamp on the shell's lower right corner. */
const SHELL_STAMP_UV = { x: 0.66, y: 0.855, w: 0.3, h: 0.1 } as const;
const SHELL_RADIUS = 0.035;

type ShellUniforms = {
  uWells: IUniform<Vector3[]>;
  uWellAspect: IUniform<number>;
  /** The disc window: centre (u, v) and u-radius, in shell UV; v radius = u-radius * uWellAspect. */
  uWindow: IUniform<Vector3>;
  /** How clear the shell goes inside the window, 0..1. */
  uWindowClear: IUniform<number>;
};

/** Where the disc is, in the front cap's UV space. */
interface WindowSpec {
  u: number;
  v: number;
  radiusU: number;
  /** 0 keeps the preset's plastic over the disc; 1 makes the window clear (SHELL_WINDOWS). */
  clear: number;
}

/**
 * Cuts the screw wells through a physical material the way the SHELL shader does (sharing its `uWells`
 * uniforms, so `addCartridgeDetail` and `CartridgeWear` bind them as they do to LIT's), and opens the disc
 * window: inside it the body goes white, the tint's attenuation falls away and the transmission goes to 1
 * (transmission tier) or the alpha drops (gel tiers), so the disc reads plainly through a clear pane.
 */
function withShellShader<T extends Material>(material: T, window: WindowSpec): T & ShellMaterial {
  const uniforms: ShellUniforms = {
    uWells: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3()] },
    uWellAspect: { value: 1 },
    uWindow: { value: new Vector3(window.u, window.v, window.radiusU) },
    uWindowClear: { value: window.clear },
  };
  const transmission = ShaderChunk.transmission_fragment
    .replace('material.transmission = transmission;', 'material.transmission = mix(transmission, 0.995, minidiscWindow);')
    .replace('material.attenuationDistance = attenuationDistance;', 'material.attenuationDistance = mix(attenuationDistance, 20.0, minidiscWindow);')
    .replace('material.attenuationColor = attenuationColor;', 'material.attenuationColor = mix(attenuationColor, vec3(1.0), minidiscWindow);');
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uWells = uniforms.uWells;
    shader.uniforms.uWellAspect = uniforms.uWellAspect;
    shader.uniforms.uWindow = uniforms.uWindow;
    shader.uniforms.uWindowClear = uniforms.uWindowClear;
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <clipping_planes_pars_fragment>',
        `#include <clipping_planes_pars_fragment>
         uniform vec3 uWells[4];
         uniform float uWellAspect;
         uniform vec3 uWindow;
         uniform float uWindowClear;`,
      )
      .replace(
        '#include <clipping_planes_fragment>',
        `#include <clipping_planes_fragment>
         float minidiscWindow = 0.0;
         #ifdef USE_UV
         for (int i = 0; i < 4; i++) {
           vec3 well = uWells[i];
           if (well.z > 0.0 && length((vUv - well.xy) / vec2(well.z, well.z * uWellAspect)) < 1.0) discard;
         }
         minidiscWindow = uWindowClear * (1.0 - smoothstep(uWindow.z * 0.96, uWindow.z, length((vUv - uWindow.xy) / vec2(uWindow.z, uWindow.z * uWellAspect)) * uWindow.z));
         #endif`,
      )
      .replace('#include <color_fragment>', `#include <color_fragment>\n diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0), minidiscWindow);`)
      .replace('#include <alphamap_fragment>', `#include <alphamap_fragment>\n diffuseColor.a = mix(diffuseColor.a, 0.12, minidiscWindow);`)
      .replace('#include <transmission_fragment>', transmission);
  };
  // The wells and the window are computed in the shell's own UV (`vUv`), which three.js (r15x+) only declares for a
  // built-in material that asks for it. Without this the screw wells were never cut: the clear face covered them.
  material.defines = { ...material.defines, USE_UV: '' };
  material.customProgramCacheKey = () => 'minidisc-shell';
  return Object.assign(material, { uniforms });
}

type ShellTier = 'transmission' | 'translucent' | 'low' | 'opaque';


/** The chassis behind the disc, cut where the back is open (the hub, the laser window, the screw bores). */
function throughMask(rect: Rect, bevel: number, disc: { x: number; y: number }): CanvasTexture {
  const size = 512;
  const [element, ctx] = canvas(size);
  const w = rect.x1 - rect.x0 - 2 * bevel;
  const h = rect.y1 - rect.y0 - 2 * bevel;
  const X = (x: number) => ((x - rect.x0 - bevel) / w) * size;
  const Yp = (y: number) => (1 - (y - rect.y0 - bevel) / h) * size;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';
  ctx.beginPath();
  const hubR = BACK_HUB.inner * (rect.x1 - rect.x0);
  ctx.ellipse(X(disc.x), Yp(disc.y), (hubR / w) * size, (hubR / h) * size, 0, 0, Math.PI * 2);
  ctx.fill();
  const W = rect.x1 - rect.x0;
  const H = rect.y1 - rect.y0;
  const lx = (u: number) => X(rect.x0 + u * W);
  const ly = (t: number) => Yp(rect.y1 - t * H);
  ctx.fillRect(lx(LASER_WINDOW.u0), ly(LASER_WINDOW.t0), lx(LASER_WINDOW.u1) - lx(LASER_WINDOW.u0), ly(LASER_WINDOW.t1) - ly(LASER_WINDOW.t0));
  for (const [u, v] of SCREWS.front) {
    ctx.beginPath();
    ctx.ellipse(lx(u), ly(1 - v), (SCREW_BORE * SCREWS.radius * W / w) * size * 1.1, (SCREW_BORE * SCREWS.radius * W / h) * size * 1.1, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  const texture = new CanvasTexture(element);
  texture.colorSpace = NoColorSpace;
  return texture;
}

/**
 * The clear top shell over a moulded frame, as plain see-through glass: no transmission. Transmission refracts a
 * screen capture of the scene, and that capture holds the label and stickers sitting on this face, so at grazing
 * angles they showed twice (a ghost copy offset by the refraction). Nothing behind it needs refracting: it is
 * water-clear, the frame carries the colour.
 */
function clearGlass(envMap: Texture | null, normalMap: Texture): MeshPhysicalMaterial {
  return new MeshPhysicalMaterial({
    color: '#ffffff',
    transparent: true,
    // Water clear: at 0.1 the white veil lifted the disc's blacks by half and the face read as a glossy sheet.
    opacity: 0.045,
    depthWrite: false,
    roughness: 0.1,
    metalness: 0,
    specularIntensity: 0.3,
    clearcoat: 0.06,
    clearcoatRoughness: 0.1,
    normalMap,
    normalScale: new Vector2(0.4, 0.4),
    envMap,
    envMapIntensity: 0.05,
  });
}


/** The preset's plastic, per tier. */
function plastic(preset: ShellPreset, tier: ShellTier, envMap: Texture | null, normalMap: Texture | null): MeshStandardMaterial {
  const shared = {
    roughness: preset.roughness,
    metalness: 0,
    envMap,
    normalMap,
    normalScale: new Vector2(0.4, 0.4),
  };
  if (tier === 'opaque') {
    // A solid shell (a blank disc, ref 10): the gel colour as plastic, nothing showing through.
    return new MeshPhysicalMaterial({ ...shared, color: preset.gel, roughness: Math.max(preset.roughness, 0.28), clearcoat: preset.clearcoat, clearcoatRoughness: 0.1, envMapIntensity: 0.4 });
  }
  if (tier === 'transmission') {
    // The body is near clear; the attenuation (per thickness) carries the tint, so the disc, hub and ribs show
    // through it coloured, as in the references, rather than under a coloured slab.
    return new MeshPhysicalMaterial({
      ...shared,
      color: preset.colour,
      transmission: preset.transmission,
      thickness: preset.thickness,
      ior: preset.ior,
      attenuationColor: new Color(preset.attenuationColor),
      attenuationDistance: preset.attenuationDistance,
      clearcoat: preset.clearcoat,
      clearcoatRoughness: 0.08,
      envMapIntensity: 0.35,
    });
  }
  // No transmission: a saturated gel at about half opacity over the disc tints what's behind without hiding it.
  if (tier === 'translucent') {
    // Over a transparent background there is nothing behind the plastic to soften a mirror highlight, so the
    // coat is a touch rougher and the reflections quieter than on the transmission tier.
    return new MeshPhysicalMaterial({
      ...shared,
      color: preset.gel,
      roughness: Math.max(preset.roughness, 0.2),
      transparent: true,
      opacity: preset.opacity,
      clearcoat: preset.clearcoat * 0.5,
      clearcoatRoughness: 0.32,
      envMapIntensity: 0.22,
    });
  }
  return new MeshStandardMaterial({ ...shared, color: preset.gel, transparent: true, opacity: preset.opacity, envMapIntensity: 0.4 });
}

export function buildCartridge(design: DiscDesign, art: DesignArt, input: CartridgeBuilderInput, options: BuildOptions = {}): BuiltCartridge {
  const { cartridge, rect, disc, depth, bevel, environment: envMap, quality } = input;
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const R = disc.radius;
  const anisotropy = options.anisotropy ?? 4;
  const seed = hashString(design.slug);
  const preset = resolvePreset(design.shell, design.shellTint, design.discFinish);
  const window = resolveShellWindow(design);
  const tier: ShellTier = window === 'opaque' ? 'opaque' : quality === 'low' ? 'low' : options.transmission === false ? 'translucent' : 'transmission';
  const px = quality === 'low' ? 1024 : 2048;
  const frontZ = depth / 2;
  const backZ = -depth / 2;

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const textures: Texture[] = [];
  const keep = <T extends Material>(m: T): T => {
    materials.push(m);
    return m;
  };
  const geo = <T extends BufferGeometry>(g: T): T => {
    geometries.push(g);
    return g;
  };
  const tex = <T extends Texture>(t: T): T => {
    textures.push(t);
    return t;
  };

  // ── The label plate's place, needed by the shell's moulding ──────────────────────────────────────────
  // The shutter is always there; `labelStyle: 'none'` leaves it bare brushed steel.
  const hasPlate = true;
  const plateW = PLATE.width * w;
  const plateH = plateW / PLATE_ASPECT;
  const plateRect: Rect | null = hasPlate
    ? {
        x0: rect.x0 + PLATE.left * w,
        x1: rect.x0 + PLATE.left * w + plateW,
        y0: disc.y + PLATE.centreY * h - plateH / 2,
        y1: disc.y + PLATE.centreY * h + plateH / 2,
      }
    : null;
  // The shutter: the steel plate and everything that rides on it (its print, the edition stamp, the label wear,
  // the spine and the steel round the edge). A top-loading deck slides it down, by the plate's height, onto the
  // clear tongue's track once the hub is clamped, so the laser sees the disc (insert-sequence.ts).
  const shutter = new Group();
  shutter.name = 'shutter';
  cartridge.add(shutter);
  const shutterTravel = plateH * 0.95;
  const plateUv = plateRect
    ? { x: (plateRect.x0 - rect.x0) / w, y: (rect.y1 - plateRect.y1) / h, w: plateW / w, h: plateH / h }
    : null;

  // ── Shell slab: LIT's geometry, the preset's plastic ────────────────────────────────────────────────
  const inset: Rect = { x0: rect.x0 + bevel, y0: rect.y0 + bevel, x1: rect.x1 - bevel, y1: rect.y1 - bevel };
  const slabGeometry = geo(
    new ExtrudeGeometry(roundedRect(inset, SHELL_RADIUS - bevel), {
      depth: depth - 2 * bevel,
      bevelEnabled: true,
      bevelThickness: bevel,
      bevelSize: bevel,
      bevelSegments: 3,
      UVGenerator: rimUv(rect, SHELL_RADIUS),
    }),
  );
  splitCaps(slabGeometry, 2);
  const moulded = tier !== 'opaque';
  const mouldNormal = tex(
    // A moulded shell's face is recessed for the shutter's whole run (the plate and its travel), so the track
    // still reads once the plate has slid down.
    shellNormal(
      design,
      moulded && plateUv ? { ...plateUv, h: plateUv.h + shutterTravel / h } : plateUv,
      quality === 'low' ? 512 : 1024,
      { u: (disc.x - rect.x0) / w, v: (disc.y - rect.y0) / h, ru: (R / w) * 1.02 },
      !moulded,
    ),
  );
  mouldNormal.anisotropy = anisotropy;
  const discU = (disc.x - rect.x0) / w;
  const discV = (disc.y - rect.y0) / h;
  const front = keep(
    // With the moulded frame under it, the top shell is the clear half of the references: clear over the whole
    // face, the colour coming from the frame. `tinted` keeps the preset's plastic over the disc.
    withShellShader(
      moulded && window !== 'tinted'
        ? clearGlass(envMap, mouldNormal)
        : plastic(preset, tier, envMap, mouldNormal),
      moulded && window !== 'tinted'
        ? { u: discU, v: discV, radiusU: 3, clear: 1 }
        : { u: discU, v: discV, radiusU: (R / w) * 1.02, clear: window === 'clear' ? 1 : 0 },
    ),
  );
  // A moulded shell's sides and back half are the coloured plastic itself, opaque like the references' backs;
  // only the top half is clear. Other shells keep the preset's plastic all round.
  const solidPlastic = () =>
    keep(
      new MeshPhysicalMaterial({
        map: speckleMap!,
        emissiveMap: speckleMap!,
        color: new Color(0.62, 0.62, 0.62),
        emissive: new Color(0.08, 0.08, 0.08),
        roughness: 0.55,
        specularIntensity: 0.5,
        clearcoat: 0.1,
        clearcoatRoughness: 0.4,
        envMap,
        envMapIntensity: 0.16,
      }),
    );
  const speckleMap = moulded ? tex(srgbTexture(plasticSpeckle(preset.frame, quality === 'low' ? 256 : 512, seed), anisotropy)) : null;
  const edge = moulded ? solidPlastic() : keep(plastic(preset, tier, envMap, null));
  // The side walls' UVs run round the rim, not through the depth: a speckle map would smear into streaks there.
  if (moulded) {
    edge.map = null;
    edge.emissiveMap = null;
    edge.color = new Color(preset.frame).multiplyScalar(0.62);
    edge.emissive = new Color(preset.frame).multiplyScalar(0.08);
  }
  edge.side = DoubleSide;
  const back = moulded ? solidPlastic() : keep(plastic(preset, tier, envMap, null));
  // The back's own moulding, and a calmer coat: seen square on, a full clearcoat flares white across it.
  const backNormal = moulded
    ? tex(
        heightToNormal(
          backHeight(
            quality === 'low' ? 512 : 1024,
            w / h,
            [(disc.x - rect.x0) / w, (rect.y1 - disc.y) / h],
            BACK_HUB.inner,
            SCREWS.front.map(([u, v]) => [u, 1 - v] as [number, number]),
          ),
          3,
        ),
      )
    : null;
  // The back's skin carries its slide track and the track's wear; `setWear` repaints it as the copy ages.
  const backTrack = plateRect
    ? { u0: 0, t0: (rect.y1 - plateRect.y1) / h, u1: Math.min((plateRect.x1 - rect.x0) / w, (disc.x - rect.x0) / w - BACK_HUB.outer - 0.008), t1: TONGUE_BOTTOM_T }
    : null;
  const backSkinSize = quality === 'low' ? 512 : 1024;
  const backSkinTexture = moulded && backTrack ? tex(srgbTexture(backSkin(null, backSkinSize, w / h, preset.frame, seed, backTrack, 0), anisotropy)) : null;
  const paintBackWear = (level: number) => {
    if (!backSkinTexture || !backTrack) return;
    backSkin(backSkinTexture.image as HTMLCanvasElement, backSkinSize, w / h, preset.frame, seed, backTrack, level);
    backSkinTexture.needsUpdate = true;
  };
  if (moulded && back instanceof MeshPhysicalMaterial) {
    if (backSkinTexture) {
      back.map = backSkinTexture;
      back.emissiveMap = backSkinTexture;
    }
    back.normalMap = backNormal;
    back.normalScale = new Vector2(1.2, 1.2);
    back.clearcoat = 0.08;
    back.envMapIntensity = 0.14;
  }
  const slab = new Mesh(slabGeometry, [front, edge, back]);
  slab.position.z = backZ + bevel;
  slab.renderOrder = 3;
  cartridge.add(slab);

  // ── Internals: the moulded chassis and the disc cavity, seen through the plastic ─────────────────────
  const chassisMap = tex(srgbTexture(chassisPrint(quality === 'low' ? 512 : 1024, { u: discU, v: discV, ru: R / w }, seed, moulded ? new Color(preset.frame).multiplyScalar(0.55).getStyle() : undefined), anisotropy));
  const chassis = new Mesh(
    geo(new PlaneGeometry(w - 2 * bevel, h - 2 * bevel)),
    keep(
      new MeshStandardMaterial({
        map: chassisMap,
        // Cut where the back is open: the hub, the laser window and the screw bores go right through.
        alphaMap: moulded ? tex(throughMask(rect, bevel, disc)) : null,
        alphaTest: 0.5,
        roughness: 0.62,
        metalness: 0.05,
        envMap,
        envMapIntensity: 0.25,
      }),
    ),
  );
  chassis.position.set((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, backZ + 0.003);
  const cavityH = disc.topZ + 0.004 - (backZ + 0.003);
  const cavity = new Mesh(
    geo(new CylinderGeometry(R * 1.035, R * 1.035, cavityH, 96, 1, true).rotateX(Math.PI / 2)),
    keep(new MeshStandardMaterial({ color: '#1b1d25', roughness: 0.5, envMap, envMapIntensity: 0.3, side: BackSide })),
  );
  cavity.position.set(disc.x, disc.y, backZ + 0.003 + cavityH / 2);
  cartridge.add(chassis, cavity);

  // ── The disc: the art, or a metal pressing with the art in its tint ─────────────────────────────────
  const discMap = tex(srgbTexture(discPrint(art.disc, preset.disc, disc.hub.hole, px, seed), anisotropy));
  const discMaterial = keep(
    preset.disc === 'print'
      ? new MeshStandardMaterial({
          map: discMap,
          emissiveMap: discMap,
          // Enough self light to hold the art's colour in the dark scene, not so much that its whites cross the
          // player's bloom threshold (0.86) and glow like neon.
          // Printed whites held at 0.7 albedo: under the inspector's key light full white crosses the bloom
          // threshold and blows out.
          color: new Color(0.7, 0.7, 0.7),
          emissive: new Color(0.08, 0.08, 0.08),
          roughness: 0.6,
          metalness: 0.08,
          envMap,
          // A printed disc under clear plastic: reflections held low so the art, not the room, carries it.
          envMapIntensity: 0.14,
          alphaTest: 0.5,
        })
      : preset.disc === 'vinyl'
        ? // Glossy black lacquer: the grooves' sheen is in the print, the gloss comes from the environment.
          new MeshStandardMaterial({ map: discMap, metalness: 0.2, roughness: 0.3, envMap, envMapIntensity: 0.7, alphaTest: 0.5 })
        : new MeshStandardMaterial({ map: discMap, metalness: 1, roughness: preset.disc === 'rainbow' ? 0.2 : 0.26, envMap, envMapIntensity: 1.1, alphaTest: 0.5 }),
  );
  const discMesh = new Mesh(geo(new PlaneGeometry(R * 2, R * 2)), discMaterial);
  discMesh.position.set(disc.x, disc.y, disc.topZ);
  discMesh.renderOrder = 1;
  cartridge.add(discMesh);

  // ── Write-protect tab, lower right (refs 19, 33): a dark well under the face and its slider standing proud ─
  const tabW = 0.075 * w;
  const tabH = 0.04 * h;
  const tabX = rect.x0 + 0.848 * w + tabW / 2;
  const tabY = rect.y0 + (1 - 0.977) * h + tabH / 2;
  const tabWell = new Mesh(
    geo(new PlaneGeometry(tabW, tabH)),
    keep(new MeshStandardMaterial({ color: '#07080c', roughness: 0.7, envMap, envMapIntensity: 0.1 })),
  );
  tabWell.position.set(tabX, tabY, frontZ - 0.0015);
  const slider = new Mesh(
    geo(new ExtrudeGeometry(roundedRect({ x0: -tabW * 0.28, y0: -tabH * 0.36, x1: tabW * 0.28, y1: tabH * 0.36 }, 0.002), { depth: 0.0022, bevelEnabled: false })),
    keep(new MeshStandardMaterial({ color: '#d8dae0', roughness: 0.5, metalness: 0.1, envMap, envMapIntensity: 0.3 })),
  );
  slider.position.set(tabX - tabW * 0.18, tabY, frontZ - 0.0012);
  // A moulded shell has the pocket and slider in its frame (moulding.ts).
  if (!moulded) cartridge.add(tabWell, slider);

  // ── The label plate ──────────────────────────────────────────────────────────────────────────────────
  const plateZ = frontZ + 0.0021;
  let stampInk = '#a8102c';
  if (plateRect) {
    const print = platePrint(design, quality === 'low' ? 768 : 1280, art.label);
    const map = tex(srgbTexture(print.map, anisotropy));
    if (print.normal) tex(print.normal);
    stampInk = print.stampInk;
    const metal = design.labelStyle === 'metal' || design.labelStyle === 'metal-dark' || design.labelStyle === 'none';
    const dark = design.labelStyle === 'metal-dark';
    const tintedPlate = design.labelStyle === 'tinted';
    const lip = 0.004;
    // A sticker sits on the steel shutter with the metal showing round it (refs 20, 23).
    const faceInset = design.labelStyle === 'sticker' ? plateH * 0.09 : lip;
    const stock = new Mesh(
      geo(
        new ExtrudeGeometry(
          roundedRect({ x0: plateRect.x0 + lip, y0: plateRect.y0 + lip, x1: plateRect.x1 - lip, y1: plateRect.y1 - lip }, 0.009),
          { depth: 0.0018, bevelEnabled: false },
        ),
      ),
      keep(
        !tintedPlate
          ? new MeshStandardMaterial({ color: dark ? '#2b2d33' : '#b9bcc3', metalness: 1, roughness: 0.4, envMap, envMapIntensity: 0.5 })
          : tintedPlate
            ? new MeshStandardMaterial({ color: resolvePreset(design.shell, design.shellTint).gel, roughness: 0.55, envMap, envMapIntensity: 0.3 })
            : new MeshStandardMaterial({ color: '#d9d3c7', roughness: 0.95 }),
      ),
    );
    stock.position.z = frontZ + 0.0002;
    const face = new Mesh(
      geo(new PlaneGeometry(plateW - faceInset * 2, plateH - faceInset * 2)),
      keep(
        metal
          ? new MeshStandardMaterial({
              map,
              // Steel, not chrome: refs 19 and 33 read mid grey. Brushed, not mirror: the grain scatters the
              // highlight so the print stays legible under the key light.
              color: new Color(0.66, 0.68, 0.71),
              metalness: 0.8,
              roughness: 0.56,
              normalMap: print.normal,
              normalScale: new Vector2(0.6, 0.6),
              envMap,
              envMapIntensity: 0.22,
            })
          : tintedPlate
            ? // Frosted plastic: satin, a little self light so the colour holds in the dark scene.
              new MeshStandardMaterial({
                map,
                emissiveMap: map,
                color: new Color(0.75, 0.75, 0.75),
                emissive: new Color(0.14, 0.14, 0.14),
                roughness: 0.5,
                normalMap: tex(paperGrainNormal()),
                normalScale: new Vector2(0.2, 0.2),
                envMap,
                envMapIntensity: 0.35,
              })
            : new MeshStandardMaterial({
              map,
              emissiveMap: map,
              color: new Color(0.72, 0.72, 0.72),
              emissive: new Color(0.12, 0.12, 0.12),
              roughness: 0.9,
              normalMap: tex(paperGrainNormal()),
              normalScale: new Vector2(0.45, 0.45),
              envMap,
              envMapIntensity: 0.12,
            }),
      ),
    );
    face.position.set((plateRect.x0 + plateRect.x1) / 2, (plateRect.y0 + plateRect.y1) / 2, plateZ);
    face.renderOrder = 4;
    // A moulded shell's steel is the one-piece folded shutter (moulding.ts); only the print sits on it here.
    // (`moulded` here is the shell's: this block's own plate flag is `tintedPlate`.)
    if (moulded) shutter.add(face);
    else shutter.add(stock, face);
  }

  // ── The moulded frame, side rail and the shutter's other parts (moulding.ts) ───────────────────────────
  if (moulded && plateRect) {
    buildMoulding({
      cartridge,
      rect,
      disc: { x: disc.x, y: disc.y, radius: R, topZ: disc.topZ },
      frontZ,
      backZ,
      bevel,
      shellRadius: SHELL_RADIUS,
      frame: preset.frame,
      rail: preset.rail,
      plateRect,
      shutter,
      screws: SCREWS.front.map(([u, v]) => [u, 1 - v, SCREWS.radius * SCREW_WELL_RATIO] as [number, number, number]),
      year: design.year,
      quality: quality === 'low' ? 'low' : 'high',
      envMap,
      anisotropy,
      keep,
      geo,
      tex,
    });
  }

  // ── Stickers ─────────────────────────────────────────────────────────────────────────────────────────
  printedStickers(design).forEach((sticker, index) => {
    const print = stickerPrint(sticker, design, quality === 'low' ? 384 : 640);
    const map = tex(srgbTexture(print, anisotropy));
    const sw = sticker.w * w;
    const sh = (sw * print.height) / print.width;
    const mesh = new Mesh(
      geo(new PlaneGeometry(sw, sh)),
      keep(
        new MeshStandardMaterial({
          map,
          emissiveMap: map,
          color: new Color(0.72, 0.72, 0.72),
          emissive: new Color(0.12, 0.12, 0.12),
          roughness: 0.85,
          normalMap: tex(paperGrainNormal()),
          normalScale: new Vector2(0.35, 0.35),
          envMap,
          envMapIntensity: 0.15,
          alphaTest: 0.5,
          polygonOffset: true,
          polygonOffsetFactor: -1,
        }),
      ),
    );
    mesh.position.set(rect.x0 + (sticker.x + sticker.w / 2) * w, rect.y1 - sticker.y * h - sh / 2, frontZ + 0.0012 + index * 0.00005);
    mesh.rotation.z = (-(sticker.rotation ?? 0) * Math.PI) / 180;
    mesh.renderOrder = 4;
    cartridge.add(mesh);
  });

  // ── Image stickers: uploaded art of any shape (a PNG keeps its alpha), on the slide cover (riding with it) or
  // anywhere on the plastic shell, always kept inside their area ─────────────────────────────────────────────
  imageStickers(design).forEach((sticker, index) => {
    const image = art.stickers?.[sticker.src];
    if (!image) return;
    const onShutter = sticker.area === 'shutter' && plateRect !== null;
    const area = onShutter ? plateRect! : { x0: rect.x0 + bevel, y0: rect.y0 + bevel, x1: rect.x1 - bevel, y1: rect.y1 - bevel };
    const place = placeImageSticker(sticker, area, imageSize(image));
    const map = tex(srgbTexture(stickerCanvas(image, quality === 'low' ? 512 : 1024), anisotropy));
    const mesh = new Mesh(
      geo(new PlaneGeometry(place.width, place.height)),
      keep(
        new MeshStandardMaterial({
          map,
          emissiveMap: map,
          color: new Color(0.72, 0.72, 0.72),
          emissive: new Color(0.12, 0.12, 0.12),
          roughness: 0.8,
          normalMap: tex(paperGrainNormal()),
          normalScale: new Vector2(0.3, 0.3),
          envMap,
          envMapIntensity: 0.15,
          // Soft cut-out edges blend; the stack order keeps overlapping stickers in upload order.
          transparent: true,
          alphaTest: 0.02,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: -2,
        }),
      ),
    );
    mesh.position.set(place.x, place.y, (onShutter ? plateZ + 0.0004 : frontZ + 0.0013) + index * 0.00005);
    mesh.rotation.z = (-(sticker.rotation ?? 0) * Math.PI) / 180;
    mesh.renderOrder = 6 + index * 0.01;
    (onShutter ? shutter : cartridge).add(mesh);
  });

  // ── LIT's realism layer, and the copy's wear through its hook ────────────────────────────────────────
  let wear: CartridgeWear | null = null;
  const wearLabel = plateRect ?? {
    x0: rect.x0 + SHELL_STAMP_UV.x * w,
    x1: rect.x0 + (SHELL_STAMP_UV.x + SHELL_STAMP_UV.w) * w,
    y0: rect.y1 - (SHELL_STAMP_UV.y + SHELL_STAMP_UV.h) * h,
    y1: rect.y1 - SHELL_STAMP_UV.y * h,
  };
  setCartridgeDetailHook((detailInput, { coat }) => {
    if (moulded) {
      // Over a moulded frame the face is water-clear: LIT's gloss pass at full strength veils the disc white
      // when seen square on. Quieter, it still carries the highlights and the wear's matte scuffs.
      // Front and back caps both: the back is now satin plastic, and the full gloss flared across its top.
      const caps = Array.isArray(coat.material) ? [coat.material[0], coat.material[2]] : [coat.material];
      for (const cap of caps as MeshPhysicalMaterial[]) {
        cap.envMapIntensity *= 0.1;
        if (cap.clearcoat !== undefined) cap.clearcoat *= 0.1;
        cap.roughness = Math.max(cap.roughness, 0.45);
        // Its direct highlight too: the pass is additive, and on a flat face turned to the key light the whole
        // face sits at the mirror angle at once, so the highlight flooded the cartridge white.
        if (cap instanceof MeshPhysicalMaterial) cap.specularIntensity = 0.15;
      }
    }
    wear = new CartridgeWear(detailInput, coat, {
      label: { rect: wearLabel, z: (plateRect ? plateZ : frontZ + 0.0012) + 0.00015 },
      safeZones: options.wearSafeZones,
      quality,
      anisotropy,
      // The shutter's run on the face: its plate drags vertical wear the whole way down.
      slideTracks:
        moulded && plateRect
          ? [{ u0: (plateRect.x0 - rect.x0) / w, v0: (rect.y1 - plateRect.y1) / h, u1: (plateRect.x1 - rect.x0) / w, v1: TONGUE_BOTTOM_T }]
          : undefined,
    });
    return wear.spinning;
  });
  let detail: { spinning: Object3D[] };
  try {
    detail = addCartridgeDetail({
      cartridge,
      slabGeometry,
      shellMaterial: front,
      backMaterial: back,
      slabZ: slab.position.z,
      frontZ,
      backZ,
      rect,
      // Screwed from the front: the heads sit exposed in their recessed wells on the front face only. The back
      // has just the small openings where the screw ends show (moulding.ts).
      screws: moulded ? { ...SCREWS, back: [] } : SCREWS,
      // A moulded shell's hub opening is smaller, so the shutter's back leaf clears its bezel.
      backHub: moulded ? { u: discU, v: discV, ...BACK_HUB, cap: 0.03 } : { u: discU, v: discV, outer: 0.174, inner: 0.151, cap: 0.03 },
      disc: {
        x: disc.x,
        y: disc.y,
        topZ: disc.topZ,
        thickness: disc.thickness,
        radius: R,
        hub: disc.hub,
        hubBaseZ: disc.hubBaseZ,
        hubTopZ: disc.hubTopZ,
      },
      normals: { front: mouldNormal, back: backNormal ?? mouldNormal },
      environment: envMap,
      quality,
    });
  } finally {
    setCartridgeDetailHook(null);
  }
  // LIT's detail layer finishes its hub bezel and screws near mirror; on a generated shell turned in the 360 view
  // that flares white. Satin them, on this cartridge only.
  if (moulded) {
    cartridge.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      for (const material of [object.material].flat()) {
        // Every near-mirror metal (hub, bezel, screws): satin, a shade darker. The flat hub facing the key light
        // otherwise flashed white across its whole face.
        if (material instanceof MeshStandardMaterial && material.metalness >= 0.9 && !material.userData.satin) {
          material.userData.satin = true;
          material.roughness = Math.max(material.roughness, 0.5);
          material.color.multiplyScalar(0.82);
          material.envMapIntensity *= 0.55;
        }
        // The disc's data side, seen through the laser window: keep its rainbow, lose the pink blow-out.
        // LIT's additive iridescent sheen ring over the disc's face: under the player's pink accent light its
        // thin-film colour washed half the disc pink, even softened (specular 0.15, iridescence 0.3). The printed
        // disc carries the look on its own, so on a generated cartridge the ring is off.
        if (material instanceof MeshPhysicalMaterial && material.iridescence > 0 && material.transparent) {
          object.visible = false;
        }
        // (Only the opaque data side below.)
        if (material instanceof MeshPhysicalMaterial && material.iridescence > 0 && !material.transparent) {
          material.color.set('#a3a8b1');
          material.iridescence = 0.35;
          material.roughness = Math.max(material.roughness, 0.3);
          material.envMapIntensity *= 0.5;
        }
      }
    });
  }
  // The label's wear is on the plate, so it slides with it.
  // (`wear` is assigned inside the hook, which TypeScript's narrowing can't see.)
  const built = wear as CartridgeWear | null;
  if (built && plateRect) shutter.add(built.labelObject);
  // The back's openings beyond LIT's (hub, screws): the laser window under the shutter, and the screw bores.
  if (moulded && back.alphaMap) {
    const mask = back.alphaMap.image as HTMLCanvasElement;
    const ctx = mask.getContext('2d')!;
    const size = mask.width;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect(LASER_WINDOW.u0 * size, LASER_WINDOW.t0 * size, (LASER_WINDOW.u1 - LASER_WINDOW.u0) * size, (LASER_WINDOW.t1 - LASER_WINDOW.t0) * size, size * 0.008);
    ctx.fill();
    for (const [u, v] of SCREWS.front) {
      ctx.beginPath();
      ctx.ellipse(u * size, (1 - v) * size, SCREW_BORE * SCREWS.radius * size, SCREW_BORE * SCREWS.radius * (w / h) * size, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    back.alphaMap.needsUpdate = true;
  }

  // ── The edition stamp ────────────────────────────────────────────────────────────────────────────────
  const stampHost = plateRect ?? wearLabel;
  const stampUv = plateRect ? STAMP_UV : { x: 0, y: 0, w: 1, h: 1 };
  const hostW = stampHost.x1 - stampHost.x0;
  const hostH = stampHost.y1 - stampHost.y0;
  const stampW = stampUv.w * hostW;
  const stampH = stampUv.h * hostH;
  const stampGeometry = geo(new PlaneGeometry(stampW, stampH));
  let stamp: { mesh: Mesh; material: Material; texture: Texture } | null = null;
  const removeStamp = () => {
    if (!stamp) return;
    stamp.mesh.removeFromParent();
    stamp.material.dispose();
    stamp.texture.dispose();
    stamp = null;
  };
  const setEdition = (edition: number | null) => {
    removeStamp();
    if (edition === null) return;
    const texture = srgbTexture(stampPrint(edition, stampInk, 512, Math.round((512 * stampH) / stampW)), anisotropy);
    const material = new MeshStandardMaterial({
      map: texture,
      emissiveMap: texture,
      color: new Color(0.75, 0.75, 0.75),
      emissive: new Color(0.14, 0.14, 0.14),
      roughness: 0.92,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
    });
    const mesh = new Mesh(stampGeometry, material);
    mesh.name = 'edition-stamp';
    mesh.position.set(
      stampHost.x0 + (stampUv.x + stampUv.w / 2) * hostW,
      stampHost.y1 - (stampUv.y + stampUv.h / 2) * hostH,
      (plateRect ? plateZ : frontZ + 0.0012) + 0.0003,
    );
    mesh.renderOrder = 5;
    (plateRect ? shutter : cartridge).add(mesh);
    stamp = { mesh, material, texture };
    document.fonts?.load(`700 32px 'JetBrains Mono'`).then(() => {
      if (stamp?.mesh !== mesh) return;
      texture.image = stampPrint(edition, stampInk, 512, Math.round((512 * stampH) / stampW));
      texture.needsUpdate = true;
    }, () => {});
  };

  return {
    spinning: [discMesh, ...detail.spinning],
    hitTarget: slab,
    plateRect,
    setWear: (descriptor) => {
      wear?.set(descriptor);
      paintBackWear(descriptor?.level ?? 0);
    },
    setEdition,
    setShutter(open: number) {
      shutter.position.y = -Math.max(0, Math.min(1, open)) * shutterTravel;
    },
    dispose() {
      removeStamp();
      wear?.dispose();
      for (const child of [...cartridge.children]) cartridge.remove(child);
      for (const g of geometries) g.dispose();
      for (const m of materials) m.dispose();
      for (const t of textures) t.dispose();
    },
  };
}

/** `Group` re-export so callers building a standalone cartridge need only this module. */
export { Group };

/** An image's pixel size, whichever kind of source it is. */
function imageSize(image: ArtSource): { width: number; height: number } {
  const natural = image as { naturalWidth?: number; naturalHeight?: number };
  return { width: natural.naturalWidth || image.width || 1, height: natural.naturalHeight || image.height || 1 };
}

/** The sticker's art on a canvas no bigger than `max` px, its alpha kept. */
function stickerCanvas(image: ArtSource, max: number): HTMLCanvasElement {
  const { width, height } = imageSize(image);
  const scale = Math.min(1, max / Math.max(width, height));
  const [element, ctx] = canvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image as CanvasImageSource, 0, 0, element.width, element.height);
  return element;
}

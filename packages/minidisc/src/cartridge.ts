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
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
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
import { hashString, srgbTexture, type ArtSource } from './canvas';
import { resolveShellWindow, type DiscDesign } from './design';
import { resolvePreset, type ShellPreset } from './presets';
import { PLATE_ASPECT, chassisPrint, discPrint, platePrint, shellNormal, stampPrint, stickerPrint } from './prints';

/** The art the cartridge prints: the cover (sleeve) and the disc face (defaults to the cover). */
export interface DesignArt {
  cover: ArtSource;
  disc: ArtSource;
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
  dispose(): void;
}

/** Corner screws, in shell UV (the same four on the back). */
const SCREWS = {
  front: [
    [0.072, 0.928],
    [0.928, 0.928],
    [0.072, 0.072],
    [0.928, 0.072],
  ],
  back: [
    [0.072, 0.928],
    [0.928, 0.928],
    [0.072, 0.072],
    [0.928, 0.072],
  ],
  radius: 0.026,
};
/** The plate sits against the left edge, over the disc's left half, as the references' shutter plates do. */
const PLATE = { left: 0.03, width: 0.4, centreY: 0.0 };
/** Where the stamp sits on the plate (fractions, origin top left); the manifest's safe zone matches it. */
export const STAMP_UV = { x: 0.6, y: 0.68, w: 0.37, h: 0.26 } as const;
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
    .replace('material.attenuationColor = attenuationColor;', 'material.attenuationColor = mix(attenuationColor, vec3(1.0), minidiscWindow);\n\tmaterial.roughness = mix(material.roughness, 0.02, minidiscWindow);');
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
  material.customProgramCacheKey = () => 'minidisc-shell';
  return Object.assign(material, { uniforms });
}

type ShellTier = 'transmission' | 'translucent' | 'low' | 'opaque';

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
  const hasPlate = design.labelStyle !== 'none';
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
  const mouldNormal = tex(shellNormal(design, plateUv, quality === 'low' ? 512 : 1024, { u: (disc.x - rect.x0) / w, v: (disc.y - rect.y0) / h, ru: (R / w) * 1.02 }));
  mouldNormal.anisotropy = anisotropy;
  const discU = (disc.x - rect.x0) / w;
  const discV = (disc.y - rect.y0) / h;
  const front = keep(
    withShellShader(plastic(preset, tier, envMap, mouldNormal), { u: discU, v: discV, radiusU: (R / w) * 1.02, clear: window === 'clear' ? 1 : 0 }),
  );
  const edge = keep(plastic(preset, tier, envMap, null));
  edge.side = DoubleSide;
  const back = keep(plastic(preset, tier, envMap, null));
  const slab = new Mesh(slabGeometry, [front, edge, back]);
  slab.position.z = backZ + bevel;
  slab.renderOrder = 3;
  cartridge.add(slab);

  // ── Internals: the moulded chassis and the disc cavity, seen through the plastic ─────────────────────
  const chassisMap = tex(srgbTexture(chassisPrint(quality === 'low' ? 512 : 1024, { u: discU, v: discV, ru: R / w }, seed), anisotropy));
  const chassis = new Mesh(
    geo(new PlaneGeometry(w - 2 * bevel, h - 2 * bevel)),
    keep(new MeshStandardMaterial({ map: chassisMap, roughness: 0.62, metalness: 0.05, envMap, envMapIntensity: 0.25 })),
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
          emissive: new Color(0.62, 0.62, 0.62),
          roughness: 0.5,
          metalness: 0.08,
          envMap,
          envMapIntensity: 0.25,
          alphaTest: 0.5,
        })
      : new MeshStandardMaterial({ map: discMap, metalness: 1, roughness: 0.26, envMap, envMapIntensity: 1.1, alphaTest: 0.5 }),
  );
  const discMesh = new Mesh(geo(new PlaneGeometry(R * 2, R * 2)), discMaterial);
  discMesh.position.set(disc.x, disc.y, disc.topZ);
  discMesh.renderOrder = 1;
  cartridge.add(discMesh);

  // ── Write-protect tab, lower left: a dark well under the face and its slider standing proud ─────────
  const tabW = 0.075 * w;
  const tabH = 0.05 * h;
  const tabX = rect.x0 + 0.075 * w + tabW / 2;
  const tabY = rect.y0 + 0.055 * h + tabH / 2;
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
  cartridge.add(tabWell, slider);

  // ── The label plate ──────────────────────────────────────────────────────────────────────────────────
  const plateZ = frontZ + 0.0021;
  let stampInk = '#a8102c';
  if (plateRect) {
    const print = platePrint(design, quality === 'low' ? 768 : 1280);
    const map = tex(srgbTexture(print.map, anisotropy));
    if (print.normal) tex(print.normal);
    stampInk = print.stampInk;
    const metal = design.labelStyle === 'metal';
    const lip = 0.004;
    const stock = new Mesh(
      geo(
        new ExtrudeGeometry(
          roundedRect({ x0: plateRect.x0 + lip, y0: plateRect.y0 + lip, x1: plateRect.x1 - lip, y1: plateRect.y1 - lip }, 0.009),
          { depth: 0.0018, bevelEnabled: false },
        ),
      ),
      keep(
        metal
          ? new MeshStandardMaterial({ color: '#b9bcc3', metalness: 1, roughness: 0.4, envMap, envMapIntensity: 0.5 })
          : new MeshStandardMaterial({ color: '#d9d3c7', roughness: 0.95 }),
      ),
    );
    stock.position.z = frontZ + 0.0002;
    const face = new Mesh(
      geo(new PlaneGeometry(plateW - lip * 2, plateH - lip * 2)),
      keep(
        metal
          ? new MeshStandardMaterial({
              map,
              // Brushed, not mirror: the grain scatters the highlight so the print stays legible under the key light.
              metalness: 0.85,
              roughness: 0.46,
              normalMap: print.normal,
              normalScale: new Vector2(0.6, 0.6),
              envMap,
              envMapIntensity: 0.45,
            })
          : new MeshStandardMaterial({
              map,
              emissiveMap: map,
              emissive: new Color(0.55, 0.55, 0.55),
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
    cartridge.add(stock, face);
  }

  // ── Stickers ─────────────────────────────────────────────────────────────────────────────────────────
  (design.stickers ?? []).forEach((sticker, index) => {
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
          emissive: new Color(0.5, 0.5, 0.5),
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

  // ── LIT's realism layer, and the copy's wear through its hook ────────────────────────────────────────
  let wear: CartridgeWear | null = null;
  const wearLabel = plateRect ?? {
    x0: rect.x0 + SHELL_STAMP_UV.x * w,
    x1: rect.x0 + (SHELL_STAMP_UV.x + SHELL_STAMP_UV.w) * w,
    y0: rect.y1 - (SHELL_STAMP_UV.y + SHELL_STAMP_UV.h) * h,
    y1: rect.y1 - SHELL_STAMP_UV.y * h,
  };
  setCartridgeDetailHook((detailInput, { coat }) => {
    wear = new CartridgeWear(detailInput, coat, {
      label: { rect: wearLabel, z: (plateRect ? plateZ : frontZ + 0.0012) + 0.00015 },
      safeZones: options.wearSafeZones,
      quality,
      anisotropy,
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
      screws: SCREWS,
      backHub: { u: discU, v: discV, outer: 0.174, inner: 0.151, cap: 0.03 },
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
      normals: { front: mouldNormal, back: mouldNormal },
      environment: envMap,
      quality,
    });
  } finally {
    setCartridgeDetailHook(null);
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
    cartridge.remove(stamp.mesh);
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
      emissive: new Color(0.62, 0.62, 0.62),
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
    cartridge.add(mesh);
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
    setWear: (descriptor) => wear?.set(descriptor),
    setEdition,
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

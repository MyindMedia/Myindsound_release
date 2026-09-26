import {
  AddEquation,
  CanvasTexture,
  Color,
  CustomBlending,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  NoColorSpace,
  OneFactor,
  OneMinusSrcAlphaFactor,
  PlaneGeometry,
  ShaderMaterial,
  Vector2,
  Vector3,
  ZeroFactor,
  type Material,
  type Object3D,
} from 'three';
import type { CartridgeDetailInput } from './cartridge-detail';
import geometry from './geometry.json';

/**
 * Renders a copy's wear (PRD §11.4, WEAR-4) on the cartridge: patina, never damage. The descriptor
 * (`packages/wear`, `computeWear`) is the contract; this file is one bundle's look for it.
 *
 * - Scratches: fine hairlines, faintly lighter at rest, that glint when the light meets them across the groove,
 *   so different ones catch the light as the cartridge turns (an anisotropic highlight per scratch direction).
 * - Scuffs: soft hazy patches, and the clear-plastic coat goes matte there (its roughness rises).
 * - labelFade dulls the paper label toward a worn paper tone; edgeWear whitens the shell's rim and bevels;
 *   dust is a faint deterministic speckle.
 *
 * The descriptor is baked, only when it changes, into two small canvases per layer (marks and scratch
 * directions) and drawn by overlay meshes with one shader, so it works the same on the coarse-pointer tier
 * (BUN-0a) and never rebuilds a material. At level 0 nothing is drawn and nothing is touched.
 *
 * Surfaces, each a 0..1 UV square with the origin top left (image space, as the safe zones are):
 * - `shell`: the whole front cap of the shell, as its art is mapped.
 * - `window`: the clear window over the disc: the bounding box of the window ellipse (`cartridge.discUv`),
 *   clipped to the ellipse.
 * - `label`: the paper label's art (same space as the edition stamp's `STAMP_UV`).
 * - `disc`: the disc art's square texture, clipped to the visible disc minus the hub; it spins with the disc.
 */

export type WearSurface = 'shell' | 'window' | 'label' | 'disc';
export type WearLayerName = 'shell' | 'label' | 'disc';

/** The descriptor fields the renderer reads (PRD §11.4; the bridge's and `@myind/wear`'s type both fit). */
export interface WearInput {
  seed: string;
  level: number;
  scratches: ReadonlyArray<{ surface: string; x: number; y: number; angle: number; length: number; depth: number }>;
  scuffZones: ReadonlyArray<{ surface: string; x: number; y: number; radius: number; intensity: number }>;
  labelFade: number;
  edgeWear: number;
  dustAmount: number;
}

/** A manifest `wearSafeZones` entry: surface UV, top left corner. */
export interface WearZone {
  surface: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A layer's canvas size and the world width it covers (for hairline widths in world units). */
export interface LayerSpec {
  width: number;
  height: number;
  worldWidth: number;
}

/** Where the window and the visible disc sit, as fractions (image space, y down). */
export interface WearLayout {
  /** The window ellipse on the shell: centre and radii as fractions of the shell. */
  window: { cx: number; cy: number; rx: number; ry: number };
  /** The visible disc in its square art: outer radius and hub radius as fractions of the square's side. */
  disc: { outer: number; inner: number };
}

export const DEFAULT_LAYOUT: WearLayout = {
  window: {
    cx: geometry.cartridge.discUv.cx,
    cy: 1 - geometry.cartridge.discUv.cy,
    rx: geometry.cartridge.discUv.rx,
    ry: geometry.cartridge.discUv.ry,
  },
  // Inside the art's rim (the sheen stops at 0.985 R), and clear of the metal hub plate.
  disc: { outer: 0.5 * 0.975, inner: 0.5 * geometry.disc.hub.plate },
};

/** The window is clipped a little inside its ellipse, where the shell turns clear (SHELL shader, 0.93..1). */
const WINDOW_CLIP = 0.96;
/** Hairline width in world units: shallow to deep. */
const HAIRLINE_MIN = 0.00035;
const HAIRLINE_DEPTH = 0.0009;
/** Dust specks per world unit² at the ceiling (`dustAmount` 0.3), and speck radius in world units. */
const DUST_DENSITY = 2200;
const DUST_MAX = 0.3;
const SPECK_MIN = 0.00025;
const SPECK_RANGE = 0.0006;
/** Soft blobs per scuff, so a patch is organic rather than a disc. */
const SCUFF_BLOBS = 9;

export type Clip =
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | { kind: 'annulus'; cx: number; cy: number; outer: number; inner: number };

/** A hairline, in layer pixels. `angle` is its direction in pixel space (radians, y down). */
export interface ScratchOp {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  width: number;
  strength: number;
  angle: number;
}
export interface Blob {
  x: number;
  y: number;
  r: number;
  strength: number;
}
/** A scuff: its circle (for reference) and the soft blobs painted inside it, in layer pixels. */
export interface ScuffOp {
  x: number;
  y: number;
  rx: number;
  ry: number;
  strength: number;
  blobs: Blob[];
}
export interface OpGroup {
  surface: WearSurface;
  clip: Clip | null;
  scratches: ScratchOp[];
  scuffs: ScuffOp[];
  dust: Blob[];
}
export interface LayerPlan {
  name: WearLayerName;
  width: number;
  height: number;
  groups: OpGroup[];
}
export interface WearPlan {
  level: number;
  labelFade: number;
  edgeWear: number;
  layers: Record<WearLayerName, LayerPlan>;
}

/** mulberry32 over a hash of the seed: the renderer's own speckle, the same on every device (WEAR-1). */
function prng(seed: string, salt: string): () => number {
  let h = 2166136261;
  for (const ch of `${seed.toLowerCase()}:${salt}`) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  let s = h >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Parameter intervals of p0→p1 (t in 0..1) inside a unit circle, after mapping into the circle's frame. */
function insideCircle(ax: number, ay: number, bx: number, by: number): [number, number] | null {
  const dx = bx - ax;
  const dy = by - ay;
  const a = dx * dx + dy * dy;
  const b = 2 * (ax * dx + ay * dy);
  const c = ax * ax + ay * ay - 1;
  if (a === 0) return c <= 0 ? [0, 1] : null;
  const disc = b * b - 4 * a * c;
  if (disc <= 0) return null;
  const root = Math.sqrt(disc);
  const t0 = Math.max(0, (-b - root) / (2 * a));
  const t1 = Math.min(1, (-b + root) / (2 * a));
  return t0 < t1 ? [t0, t1] : null;
}

/** Clips a segment to a clip shape; returns the kept pieces as [t0, t1] parameter intervals. */
export function clipSegment(x0: number, y0: number, x1: number, y1: number, clip: Clip | null): [number, number][] {
  if (!clip) return [[0, 1]];
  if (clip.kind === 'ellipse') {
    const kept = insideCircle((x0 - clip.cx) / clip.rx, (y0 - clip.cy) / clip.ry, (x1 - clip.cx) / clip.rx, (y1 - clip.cy) / clip.ry);
    return kept ? [kept] : [];
  }
  const outer = insideCircle((x0 - clip.cx) / clip.outer, (y0 - clip.cy) / clip.outer, (x1 - clip.cx) / clip.outer, (y1 - clip.cy) / clip.outer);
  if (!outer) return [];
  const hub = insideCircle((x0 - clip.cx) / clip.inner, (y0 - clip.cy) / clip.inner, (x1 - clip.cx) / clip.inner, (y1 - clip.cy) / clip.inner);
  if (!hub || hub[1] <= outer[0] || hub[0] >= outer[1]) return [outer];
  const pieces: [number, number][] = [];
  if (hub[0] > outer[0]) pieces.push([outer[0], hub[0]]);
  if (hub[1] < outer[1]) pieces.push([hub[1], outer[1]]);
  return pieces;
}

function insideClip(x: number, y: number, clip: Clip | null): boolean {
  if (!clip) return true;
  if (clip.kind === 'ellipse') return ((x - clip.cx) / clip.rx) ** 2 + ((y - clip.cy) / clip.ry) ** 2 <= 1;
  const r = Math.hypot(x - clip.cx, y - clip.cy);
  return r <= clip.outer && r >= clip.inner;
}

/**
 * The descriptor as canvas draw operations per layer (pure; `CartridgeWear` paints them). Only descriptor
 * geometry is drawn, mapped affinely onto each layer, so the descriptor's safe-zone clearance carries over;
 * the renderer's own dust keeps out of the same zones.
 */
export function planWear(
  d: WearInput,
  specs: Record<WearLayerName, LayerSpec>,
  layout: WearLayout = DEFAULT_LAYOUT,
  zones: readonly WearZone[] = [],
): WearPlan {
  const shell = specs.shell;
  const w = layout.window;
  const wx0 = w.cx - w.rx;
  const wy0 = w.cy - w.ry;
  /** Surface UV to its layer's pixels, and the pixel extent of one surface unit on each axis. */
  const mapping: Record<WearSurface, { layer: WearLayerName; map(u: number, v: number): [number, number]; sx: number; sy: number }> = {
    shell: { layer: 'shell', map: (u, v) => [u * shell.width, v * shell.height], sx: shell.width, sy: shell.height },
    window: {
      layer: 'shell',
      map: (u, v) => [(wx0 + u * 2 * w.rx) * shell.width, (wy0 + v * 2 * w.ry) * shell.height],
      sx: 2 * w.rx * shell.width,
      sy: 2 * w.ry * shell.height,
    },
    label: { layer: 'label', map: (u, v) => [u * specs.label.width, v * specs.label.height], sx: specs.label.width, sy: specs.label.height },
    disc: { layer: 'disc', map: (u, v) => [u * specs.disc.width, v * specs.disc.height], sx: specs.disc.width, sy: specs.disc.height },
  };
  const clips: Record<WearSurface, Clip | null> = {
    shell: null,
    window: {
      kind: 'ellipse',
      cx: w.cx * shell.width,
      cy: w.cy * shell.height,
      rx: w.rx * WINDOW_CLIP * shell.width,
      ry: w.ry * WINDOW_CLIP * shell.height,
    },
    label: null,
    disc: {
      kind: 'annulus',
      cx: specs.disc.width / 2,
      cy: specs.disc.height / 2,
      outer: layout.disc.outer * specs.disc.width,
      inner: layout.disc.inner * specs.disc.width,
    },
  };
  const groups = new Map<WearSurface, OpGroup>();
  const group = (surface: WearSurface) => {
    let g = groups.get(surface);
    if (!g) {
      g = { surface, clip: clips[surface], scratches: [], scuffs: [], dust: [] };
      groups.set(surface, g);
    }
    return g;
  };
  const pxPerWorld = (layer: WearLayerName) => specs[layer].width / specs[layer].worldWidth;
  const isSurface = (s: string): s is WearSurface => s in mapping;

  for (const s of d.scratches) {
    if (!isSurface(s.surface)) continue;
    const m = mapping[s.surface];
    const a = (s.angle * Math.PI) / 180;
    const hx = (s.length / 2) * Math.cos(a);
    const hy = (s.length / 2) * Math.sin(a);
    const [x0, y0] = m.map(s.x - hx, s.y - hy);
    const [x1, y1] = m.map(s.x + hx, s.y + hy);
    const g = group(s.surface);
    const width = (HAIRLINE_MIN + HAIRLINE_DEPTH * s.depth) * pxPerWorld(m.layer);
    const angle = Math.atan2(y1 - y0, x1 - x0);
    for (const [t0, t1] of clipSegment(x0, y0, x1, y1, g.clip)) {
      g.scratches.push({
        x0: x0 + (x1 - x0) * t0,
        y0: y0 + (y1 - y0) * t0,
        x1: x0 + (x1 - x0) * t1,
        y1: y0 + (y1 - y0) * t1,
        width,
        strength: s.depth,
        angle,
      });
    }
  }

  d.scuffZones.forEach((s, index) => {
    if (!isSurface(s.surface)) return;
    const m = mapping[s.surface];
    const [x, y] = m.map(s.x, s.y);
    const rx = s.radius * m.sx;
    const ry = s.radius * m.sy;
    const random = prng(d.seed, `scuff${index}`);
    const blobs: Blob[] = [];
    for (let i = 0; i < SCUFF_BLOBS; i++) {
      // Blob centres within 0.55 of the radius and blob radii up to 0.45: every blob stays inside the scuff's
      // circle, which the descriptor already keeps clear of the safe zones.
      const angle = random() * Math.PI * 2;
      const dist = Math.sqrt(random()) * 0.55;
      const r = 0.25 + random() * 0.2;
      blobs.push({
        x: x + Math.cos(angle) * dist * rx,
        y: y + Math.sin(angle) * dist * ry,
        r: r * Math.min(rx, ry),
        strength: s.intensity * (0.45 + random() * 0.55),
      });
    }
    group(s.surface).scuffs.push({ x, y, rx, ry, strength: s.intensity, blobs });
  });

  // Every safe zone, in its layer's pixels (window zones land on the shell layer).
  const keepOut: Record<WearLayerName, { x0: number; y0: number; x1: number; y1: number }[]> = { shell: [], label: [], disc: [] };
  for (const z of zones) {
    if (!isSurface(z.surface)) continue;
    const m = mapping[z.surface];
    const [x0, y0] = m.map(z.x, z.y);
    const [x1, y1] = m.map(z.x + z.w, z.y + z.h);
    keepOut[m.layer].push({ x0, y0, x1, y1 });
  }

  // Dust: a fixed sequence per layer, of which `dustAmount` reveals a prefix (more dust never re-rolls).
  const dustFraction = Math.max(0, Math.min(1, d.dustAmount / DUST_MAX));
  for (const surface of ['shell', 'label', 'disc'] as const) {
    const spec = specs[surface];
    const worldArea = spec.worldWidth * ((spec.worldWidth * spec.height) / spec.width);
    const total = Math.round(DUST_DENSITY * worldArea);
    const count = Math.floor(total * dustFraction);
    if (count === 0) continue;
    const random = prng(d.seed, `dust:${surface}`);
    const scale = pxPerWorld(surface);
    const g = group(surface);
    for (let i = 0; i < count; i++) {
      const u = random();
      const v = random();
      const r = (SPECK_MIN + random() * SPECK_RANGE) * scale;
      const strength = 0.3 + random() * 0.7;
      const [x, y] = mapping[surface].map(u, v);
      if (!insideClip(x, y, g.clip)) continue;
      // Keep out of the safe zones, with the speck's own radius as margin.
      if (keepOut[surface].some((z) => Math.hypot(Math.max(z.x0 - x, 0, x - z.x1), Math.max(z.y0 - y, 0, y - z.y1)) <= r)) continue;
      g.dust.push({ x, y, r, strength });
    }
  }

  const layers = {} as Record<WearLayerName, LayerPlan>;
  for (const name of ['shell', 'label', 'disc'] as const) {
    layers[name] = { name, width: specs[name].width, height: specs[name].height, groups: [] };
  }
  // Shell first, then the window (drawn over it, with its own clip).
  for (const surface of ['shell', 'window', 'label', 'disc'] as const) {
    const g = groups.get(surface);
    if (g) layers[mapping[surface].layer].groups.push(g);
  }
  return { level: d.level, labelFade: d.labelFade, edgeWear: d.edgeWear, layers };
}

// ---------------------------------------------------------------------------------------------------------------
// Painting (browser only)

function applyClip(ctx: CanvasRenderingContext2D, clip: Clip | null): void {
  if (!clip) return;
  ctx.beginPath();
  if (clip.kind === 'ellipse') {
    ctx.ellipse(clip.cx, clip.cy, clip.rx, clip.ry, 0, 0, Math.PI * 2);
    ctx.clip();
  } else {
    ctx.arc(clip.cx, clip.cy, clip.outer, 0, Math.PI * 2);
    ctx.arc(clip.cx, clip.cy, clip.inner, 0, Math.PI * 2);
    ctx.clip('evenodd');
  }
}

function softBlob(ctx: CanvasRenderingContext2D, blob: Blob, rgb: string, gain: number): void {
  const a = Math.min(1, blob.strength * gain);
  const gradient = ctx.createRadialGradient(blob.x, blob.y, 0, blob.x, blob.y, blob.r);
  gradient.addColorStop(0, `rgba(${rgb},${a})`);
  gradient.addColorStop(0.45, `rgba(${rgb},${a * 0.6})`);
  gradient.addColorStop(1, `rgba(${rgb},0)`);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(blob.x, blob.y, blob.r, 0, Math.PI * 2);
  ctx.fill();
}

/** Scratches taper at the ends: drawn in pieces, brightest in the middle. */
const TAPER = [0.35, 0.75, 1, 1, 0.75, 0.35];

/**
 * Marks canvas (opaque): R scuff, G dust, B scratch coverage. Directions canvas: RG = (cos 2θ, sin 2θ) of each
 * scratch in pixel space, drawn wider than the hairline so its filtered edge always reads a clean direction.
 */
export function paintLayer(plan: LayerPlan, marks: CanvasRenderingContext2D, dirs: CanvasRenderingContext2D): void {
  const { width, height } = plan;
  marks.globalCompositeOperation = 'source-over';
  marks.fillStyle = '#000';
  marks.fillRect(0, 0, width, height);
  dirs.globalCompositeOperation = 'source-over';
  dirs.fillStyle = 'rgb(128,128,0)';
  dirs.fillRect(0, 0, width, height);
  for (const g of plan.groups) {
    marks.save();
    dirs.save();
    applyClip(marks, g.clip);
    applyClip(dirs, g.clip);
    marks.globalCompositeOperation = 'lighter';
    for (const scuff of g.scuffs) for (const blob of scuff.blobs) softBlob(marks, blob, '255,0,0', 0.9);
    for (const speck of g.dust) {
      marks.fillStyle = `rgba(0,255,0,${speck.strength})`;
      marks.beginPath();
      marks.arc(speck.x, speck.y, speck.r, 0, Math.PI * 2);
      marks.fill();
    }
    marks.lineCap = 'butt';
    dirs.lineCap = 'round';
    for (const s of g.scratches) {
      const alpha = 0.35 + 0.65 * s.strength;
      marks.lineWidth = s.width;
      for (let k = 0; k < TAPER.length; k++) {
        const t0 = k / TAPER.length;
        const t1 = (k + 1) / TAPER.length;
        marks.strokeStyle = `rgba(0,0,255,${alpha * TAPER[k]})`;
        marks.beginPath();
        marks.moveTo(s.x0 + (s.x1 - s.x0) * t0, s.y0 + (s.y1 - s.y0) * t0);
        marks.lineTo(s.x0 + (s.x1 - s.x0) * t1, s.y0 + (s.y1 - s.y0) * t1);
        marks.stroke();
      }
      const r = Math.round((Math.cos(2 * s.angle) * 0.5 + 0.5) * 255);
      const gr = Math.round((Math.sin(2 * s.angle) * 0.5 + 0.5) * 255);
      dirs.strokeStyle = `rgb(${r},${gr},255)`;
      dirs.lineWidth = s.width * 3 + 2;
      dirs.beginPath();
      dirs.moveTo(s.x0, s.y0);
      dirs.lineTo(s.x1, s.y1);
      dirs.stroke();
    }
    marks.restore();
    dirs.restore();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Three.js

type Rect = { x0: number; y0: number; x1: number; y1: number };

/**
 * The lights the glints answer to, in world space: the player's key light and its pink and ice accents
 * (`player-app.ts` initScene). A glint is a highlight, so these only steer where it shows.
 */
const LIGHTS = {
  keyDir: new Vector3(1.5, 2.5, 4).normalize(),
  keyColor: new Color(1, 1, 1),
  pinkPos: new Vector3(-2.2, 0.4, 1.6),
  pinkColor: new Color('#FF3DA8').multiplyScalar(0.7),
  icePos: new Vector3(2.2, -0.6, 1.4),
  iceColor: new Color('#9FD8FF').multiplyScalar(0.7),
};

const VERTEX = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vTx;
  varying vec3 vTy;
  varying vec3 vN;
  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    vWorld = world.xyz;
    mat3 m = mat3(modelMatrix);
    vTx = normalize(m * vec3(1.0, 0.0, 0.0));
    vTy = normalize(m * vec3(0.0, 1.0, 0.0));
    vN = normalize(m * vec3(0.0, 0.0, 1.0));
    gl_Position = projectionMatrix * viewMatrix * world;
  }
`;

// Output is premultiplied and in display space (no colour-space or tone-mapping step), blended as
// ONE, ONE_MINUS_SRC_ALPHA: layers that dull (fade, haze, dust, rim) go "over", scratches add light.
const FRAGMENT = /* glsl */ `
  uniform sampler2D uMarks;
  uniform sampler2D uDirs;
  uniform float uScratchBase;
  uniform float uScratchGlint;
  uniform float uScuff;
  uniform float uDust;
  uniform float uEdge;
  uniform float uFade;
  uniform vec3 uHaze;
  uniform vec3 uDustTint;
  uniform vec3 uEdgeTint;
  uniform vec3 uPaper;
  uniform vec2 uSize;
  uniform float uRadius;
  uniform float uInset;
  uniform vec3 uWells[4];
  uniform float uWellAspect;
  uniform vec3 uKeyDir;
  uniform vec3 uKeyColor;
  uniform vec3 uPinkPos;
  uniform vec3 uPinkColor;
  uniform vec3 uIcePos;
  uniform vec3 uIceColor;
  varying vec2 vUv;
  varying vec3 vWorld;
  varying vec3 vTx;
  varying vec3 vTy;
  varying vec3 vN;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  // Signed distance to a rounded rectangle of size uSize (world units) inset by uInset, in this face's UV.
  float roundedRect() {
    vec2 halfSize = uSize * 0.5 - uInset;
    vec2 q = abs((vUv - 0.5) * uSize) - (halfSize - uRadius);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - uRadius;
  }
  // A groove along T reflects L into V when the half vector lies across it.
  float glint(vec3 T, vec3 N, vec3 V, vec3 L) {
    vec3 H = normalize(L + V);
    float along = dot(T, H);
    return exp(-along * along * 260.0) * smoothstep(0.45, 0.85, dot(N, H)) * step(0.0, dot(N, L));
  }
  void over(inout vec4 acc, vec3 colour, float a) {
    acc = vec4(colour * a + acc.rgb * (1.0 - a), a + acc.a * (1.0 - a));
  }

  void main() {
    vec4 acc = vec4(0.0);
    #ifdef WEAR_SIDE
      // Shell rim and bevels: rubbed lighter, unevenly.
      over(acc, uEdgeTint, uEdge * 0.22 * mix(0.3, 1.0, smoothstep(0.3, 0.8, noise(vUv * 70.0))));
      gl_FragColor = acc;
      return;
    #endif
    #ifdef WEAR_SHELL
      for (int i = 0; i < 4; i++) {
        vec3 well = uWells[i];
        if (well.z > 0.0 && length((vUv - well.xy) / vec2(well.z, well.z * uWellAspect)) < 1.0) discard;
      }
    #endif
    vec3 m = texture2D(uMarks, vUv).rgb;
    #ifdef WEAR_LABEL
      float paper = 1.0 - smoothstep(-0.0008, 0.0, roundedRect());
      if (paper <= 0.0) discard;
      over(acc, uPaper, uFade * paper);
    #endif
    #ifdef WEAR_SHELL
      float rim = 1.0 - smoothstep(0.0, 0.02, -roundedRect());
      over(acc, uEdgeTint, uEdge * 0.16 * rim * mix(0.35, 1.0, smoothstep(0.3, 0.85, noise(vUv * 55.0))));
    #endif
    over(acc, uHaze, clamp(m.r, 0.0, 1.0) * uScuff);
    over(acc, uDustTint, m.g * uDust);
    if (m.b > 0.004) {
      vec2 d = texture2D(uDirs, vUv).rg * 2.0 - 1.0;
      float th = 0.5 * atan(d.y, d.x);
      // Pixel space is y down; the face's local +y is up.
      vec3 T = normalize(cos(th) * vTx - sin(th) * vTy);
      vec3 N = normalize(vN);
      vec3 V = normalize(cameraPosition - vWorld);
      vec3 light = uKeyColor * glint(T, N, V, uKeyDir)
        + uPinkColor * glint(T, N, V, normalize(uPinkPos - vWorld))
        + uIceColor * glint(T, N, V, normalize(uIcePos - vWorld));
      acc.rgb += m.b * (vec3(uScratchBase) + uScratchGlint * light);
      #ifdef WEAR_LABEL
        acc.rgb *= paper;
      #endif
    }
    gl_FragColor = acc;
  }
`;

type Mode = 'shell' | 'side' | 'label' | 'disc';

interface ModeLook {
  scratchBase: number;
  scratchGlint: number;
  scuff: number;
  dust: number;
  haze: string;
}

/** Per surface: how much a scratch shows at rest and in the light, and how dull a scuff or dust gets. */
const LOOK: Record<Exclude<Mode, 'side'>, ModeLook> = {
  // Clear plastic over dark art: hairlines glint, scuffs haze.
  shell: { scratchBase: 0.07, scratchGlint: 0.9, scuff: 0.32, dust: 0.3, haze: '#9da2ab' },
  // Paper: matte, so scratches barely shine; a rub lifts the paper tone.
  label: { scratchBase: 0.06, scratchGlint: 0.18, scuff: 0.22, dust: 0.22, haze: '#e7e0d0' },
  // The disc under its own lacquer: the brightest glints.
  disc: { scratchBase: 0.06, scratchGlint: 1.0, scuff: 0.26, dust: 0.26, haze: '#a3a8b2' },
};

function wearMaterial(mode: Mode, extra: Record<string, { value: unknown }> = {}): ShaderMaterial {
  const look = mode === 'side' ? LOOK.shell : LOOK[mode];
  return new ShaderMaterial({
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    defines: { [`WEAR_${mode.toUpperCase()}`]: '' },
    uniforms: {
      uMarks: { value: null },
      uDirs: { value: null },
      uScratchBase: { value: look.scratchBase },
      uScratchGlint: { value: look.scratchGlint },
      uScuff: { value: look.scuff },
      uDust: { value: look.dust },
      uEdge: { value: 0 },
      uFade: { value: 0 },
      uHaze: { value: new Color(look.haze) },
      uDustTint: { value: new Color('#c9c4b8') },
      uEdgeTint: { value: new Color('#d9dbe0') },
      uPaper: { value: new Color('#ddd6c6') },
      uSize: { value: new Vector2(1, 1) },
      uRadius: { value: 0 },
      uInset: { value: 0 },
      uWells: { value: [new Vector3(), new Vector3(), new Vector3(), new Vector3()] },
      uWellAspect: { value: 1 },
      uKeyDir: { value: LIGHTS.keyDir },
      uKeyColor: { value: LIGHTS.keyColor },
      uPinkPos: { value: LIGHTS.pinkPos },
      uPinkColor: { value: LIGHTS.pinkColor },
      uIcePos: { value: LIGHTS.icePos },
      uIceColor: { value: LIGHTS.iceColor },
      ...extra,
    },
    transparent: true,
    depthWrite: false,
    blending: CustomBlending,
    blendEquation: AddEquation,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
}

class Layer {
  readonly marks: HTMLCanvasElement;
  readonly dirs: HTMLCanvasElement;
  readonly marksTexture: CanvasTexture;
  readonly dirsTexture: CanvasTexture;

  constructor(spec: LayerSpec, anisotropy: number) {
    const canvas = () => {
      const element = document.createElement('canvas');
      element.width = spec.width;
      element.height = spec.height;
      return element;
    };
    this.marks = canvas();
    this.dirs = canvas();
    const texture = (element: HTMLCanvasElement) => {
      const t = new CanvasTexture(element);
      t.colorSpace = NoColorSpace;
      t.anisotropy = anisotropy;
      return t;
    };
    this.marksTexture = texture(this.marks);
    this.dirsTexture = texture(this.dirs);
  }

  paint(plan: LayerPlan): void {
    paintLayer(plan, this.marks.getContext('2d')!, this.dirs.getContext('2d')!);
    this.marksTexture.needsUpdate = true;
    this.dirsTexture.needsUpdate = true;
  }

  dispose(): void {
    this.marksTexture.dispose();
    this.dirsTexture.dispose();
  }
}

export interface CartridgeWearOptions {
  /** The paper label: its rectangle in cartridge space and the z of its face. */
  label: { rect: Rect; z: number };
  /** The manifest's `wearSafeZones`; the renderer's own dust keeps out of them. */
  safeZones?: readonly WearZone[];
  /** The deck's quality tier: 'low' (coarse pointer, BUN-0a) keeps every layer at or under 1024 px. */
  quality: 'high' | 'low';
  anisotropy?: number;
}

/** Roughness map baseline (the coat's own roughness) and how far a full-strength scuff raises it, in 0..255. */
const ROUGH_BASE = 36;
const ROUGH_SCUFF = 120;
const ROUGH_SIZE = 512;

/**
 * The wear overlay on one cartridge. Built by the `setCartridgeDetailHook` hook (it needs the build input);
 * `set` bakes a descriptor, and does nothing when it hasn't changed.
 */
export class CartridgeWear {
  /** Objects that spin with the disc (return these from the hook). */
  readonly spinning: Object3D[];
  private readonly shellMesh: Mesh;
  private readonly labelMesh: Mesh;
  private readonly discMesh: Mesh;
  private readonly materials: Record<Mode, ShaderMaterial>;
  private readonly specs: Record<WearLayerName, LayerSpec>;
  private readonly zones: readonly WearZone[];
  private readonly anisotropy: number;
  private readonly coat: MeshStandardMaterial | null;
  private readonly coatRoughness: number;
  private readonly coatClearcoatRoughness: number;
  private layers: Record<WearLayerName, Layer> | null = null;
  private rough: { canvas: HTMLCanvasElement; texture: CanvasTexture } | null = null;
  private key = '';
  private readonly hidden = new MeshBasicMaterial({ visible: false });

  constructor(input: CartridgeDetailInput, coat: Mesh, options: CartridgeWearOptions) {
    const { rect, disc } = input;
    const shellW = rect.x1 - rect.x0;
    const shellH = rect.y1 - rect.y0;
    const label = options.label.rect;
    const labelW = label.x1 - label.x0;
    const labelH = label.y1 - label.y0;
    const max = options.quality === 'low' ? 1024 : 2048;
    const spec = (worldW: number, worldH: number, size: number): LayerSpec => ({
      width: size,
      height: Math.round((size * worldH) / worldW),
      worldWidth: worldW,
    });
    this.specs = {
      shell: spec(shellW, shellH, max),
      label: spec(labelW, labelH, max / 2),
      disc: spec(disc.radius * 2, disc.radius * 2, max),
    };
    this.zones = options.safeZones ?? [];
    this.anisotropy = options.anisotropy ?? 4;

    const shellUniforms = input.shellMaterial.uniforms;
    this.materials = {
      // The screw wells are cut through the cap: share the shell's own well uniforms.
      shell: wearMaterial('shell', {
        uWells: shellUniforms.uWells,
        uWellAspect: shellUniforms.uWellAspect,
        uSize: { value: new Vector2(shellW, shellH) },
        uRadius: { value: 0.035 },
      }),
      side: wearMaterial('side'),
      // The paper sticker is inset from the label art (deck.ts `paperEdge`) with softly rounded corners.
      label: wearMaterial('label', {
        uSize: { value: new Vector2(labelW, labelH) },
        uRadius: { value: 0.01 },
        uInset: { value: 0.0045 },
      }),
      disc: wearMaterial('disc'),
    };
    this.materials.label.polygonOffsetFactor = this.materials.label.polygonOffsetUnits = -1;

    // The back cap (group 2) stays bare.
    this.shellMesh = new Mesh(input.slabGeometry, [this.materials.shell, this.materials.side, this.hidden]);
    this.shellMesh.position.z = input.slabZ;
    // After the shell (3), under the label (4), stamp (5) and gloss coat (6).
    this.shellMesh.renderOrder = 3.5;

    this.labelMesh = new Mesh(new PlaneGeometry(labelW, labelH), this.materials.label);
    this.labelMesh.position.set((label.x0 + label.x1) / 2, (label.y0 + label.y1) / 2, options.label.z);
    this.labelMesh.renderOrder = 4.5;

    // Spins with the disc (the deck turns everything the hook returns), on the art and under its clear layer.
    this.discMesh = new Mesh(new PlaneGeometry(disc.radius * 2, disc.radius * 2), this.materials.disc);
    this.discMesh.position.set(disc.x, disc.y, disc.topZ + 0.0002);
    this.discMesh.renderOrder = 1.5;
    this.spinning = [this.discMesh];

    for (const mesh of [this.shellMesh, this.labelMesh, this.discMesh]) {
      mesh.visible = false;
      mesh.name = 'wear';
      input.cartridge.add(mesh);
    }

    const front = Array.isArray(coat.material) ? coat.material[0] : coat.material;
    this.coat = front instanceof MeshStandardMaterial ? front : null;
    this.coatRoughness = this.coat?.roughness ?? 0;
    this.coatClearcoatRoughness = this.coat instanceof MeshPhysicalMaterial ? this.coat.clearcoatRoughness : 0;
  }

  /** Shows a copy's wear; `null` or level 0 shows the pristine cartridge. Cheap when nothing changed. */
  set(d: WearInput | null): void {
    const key = d ? JSON.stringify([d.seed, d.level, d.scratches, d.scuffZones, d.labelFade, d.edgeWear, d.dustAmount]) : '';
    if (key === this.key) return;
    this.key = key;
    const worn = d !== null && d.level > 0;
    for (const mesh of [this.shellMesh, this.labelMesh, this.discMesh]) mesh.visible = worn;
    if (!worn) {
      this.setCoatRoughness(null);
      return;
    }
    const plan = planWear(d, this.specs, DEFAULT_LAYOUT, this.zones);
    const layers = (this.layers ??= {
      shell: new Layer(this.specs.shell, this.anisotropy),
      label: new Layer(this.specs.label, this.anisotropy),
      disc: new Layer(this.specs.disc, this.anisotropy),
    });
    for (const name of ['shell', 'label', 'disc'] as const) layers[name].paint(plan.layers[name]);
    const bind = (material: ShaderMaterial, layer: Layer) => {
      material.uniforms.uMarks.value = layer.marksTexture;
      material.uniforms.uDirs.value = layer.dirsTexture;
    };
    bind(this.materials.shell, layers.shell);
    bind(this.materials.side, layers.shell);
    bind(this.materials.label, layers.label);
    bind(this.materials.disc, layers.disc);
    this.materials.shell.uniforms.uEdge.value = plan.edgeWear;
    this.materials.side.uniforms.uEdge.value = plan.edgeWear;
    // labelFade tops out at 0.35; half of it as a wash keeps the handwriting and track text clearly legible.
    this.materials.label.uniforms.uFade.value = plan.labelFade * 0.5;
    this.setCoatRoughness(plan.layers.shell);
  }

  /** Scuffs take the shine off the clear coat. Attached on the first worn bake only (one shader rebuild). */
  private setCoatRoughness(shell: LayerPlan | null): void {
    const coat = this.coat;
    if (!coat) return;
    if (!shell) {
      if (!this.rough) return;
      coat.roughnessMap = null;
      coat.roughness = this.coatRoughness;
      if (coat instanceof MeshPhysicalMaterial) {
        coat.clearcoatRoughnessMap = null;
        coat.clearcoatRoughness = this.coatClearcoatRoughness;
      }
      coat.needsUpdate = true;
      this.rough.texture.dispose();
      this.rough = null;
      return;
    }
    if (!this.rough) {
      const canvas = document.createElement('canvas');
      canvas.width = ROUGH_SIZE;
      canvas.height = Math.round((ROUGH_SIZE * shell.height) / shell.width);
      const texture = new CanvasTexture(canvas);
      texture.colorSpace = NoColorSpace;
      this.rough = { canvas, texture };
      // map.g * roughness: the baseline texel gives back the coat's own roughness.
      coat.roughnessMap = texture;
      coat.roughness = (this.coatRoughness * 255) / ROUGH_BASE;
      if (coat instanceof MeshPhysicalMaterial) {
        coat.clearcoatRoughnessMap = texture;
        coat.clearcoatRoughness = (this.coatClearcoatRoughness * 255) / ROUGH_BASE;
      }
      coat.needsUpdate = true;
    }
    const { canvas, texture } = this.rough;
    const ctx = canvas.getContext('2d')!;
    const scale = canvas.width / shell.width;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgb(${ROUGH_BASE},${ROUGH_BASE},${ROUGH_BASE})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.scale(scale, scale);
    ctx.globalCompositeOperation = 'lighter';
    const gain = ROUGH_SCUFF / 255;
    for (const g of shell.groups) {
      ctx.save();
      applyClip(ctx, g.clip);
      for (const scuff of g.scuffs) for (const blob of scuff.blobs) softBlob(ctx, blob, '255,255,255', gain);
      ctx.restore();
    }
    ctx.restore();
    texture.needsUpdate = true;
  }

  dispose(): void {
    for (const mesh of [this.shellMesh, this.labelMesh, this.discMesh]) mesh.removeFromParent();
    this.labelMesh.geometry.dispose();
    this.discMesh.geometry.dispose();
    for (const material of [...Object.values(this.materials), this.hidden] as Material[]) material.dispose();
    if (this.layers) for (const layer of Object.values(this.layers)) layer.dispose();
    this.setCoatRoughness(null);
  }
}

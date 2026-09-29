/**
 * The moulded plastic under the clear top shell, and the parts of the shutter that sit on it, measured off the
 * design catalogue's straight-on references (19 green, 33 ice blue, 24 jet black; internal look-dev only).
 * Every feature is placed in shell fractions, `u` from the left edge and `t` from the TOP edge, as read off the
 * photos at 3× (shell 658 × 624 px in ref 19), so the build can be diffed against them region by region.
 *
 * Two layers, as the references have them:
 * - INNER, the coloured moulding: a raised, glitter-flecked top surface over recessed pockets; a thick cavity
 *   wall round the disc (bright lip, dark shadow band, black gap); screws sunk in raised collars; a collared
 *   oval through-hole and a round one; solid cylinder bosses; faint embossed ghost rings along the top; the
 *   write-protect pocket with its slider and stepped channel; the maker's badge up the right edge; and
 *   INSERT THIS END ▼ on the bottom edge (the deck loads from the top, so the bottom goes in first).
 * - OUTER, the parts on and beside the clear top shell: the lilac side rail with its capsule cavities and
 *   detent ticks, the notch cap, the frosted top cover with its concave lens, the steel spine (two slots) and
 *   the steel wrapped round the left edge, and the clear tongue under the plate. The plate is cartridge.ts's.
 * The parting line between the clear top half and the coloured bottom half runs round the sides.
 */
import {
  BackSide,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  DoubleSide,
  ExtrudeGeometry,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Path,
  PlaneGeometry,
  RepeatWrapping,
  Shape,
  TorusGeometry,
  Vector2,
  type Group,
  type Material,
  type Texture,
} from 'three';
import type { Rect } from '../../../src/player3d/deck';
import { MONO, canvas, heightToNormal, prng, srgbTexture } from './canvas';

/** Shell fractions: u from the left edge, t from the top edge. */
type UT = [number, number];

/** The left rail's width, and so where the frame starts. */
export const RAIL_U = 0.046;
/**
 * The disc opening in the frame, as a fraction of the shell width: just wider than the disc (0.440 of the width),
 * so the whole disc shows and the frosted frame sits round and under it, never over its edge.
 */
export const OPENING_U = 0.444;
/** The cavity wall's raised lip, outside the opening (ref 19: the bright band 6 px out). */
const LIP_U = 0.022;

/** Faint embossed ghost rings in the frame's surface: [u, t, radius (u)]. */
const GHOSTS: [number, number, number][] = [
  [0.235, 0.034, 0.018],
  [0.304, 0.033, 0.021],
  [0.745, 0.032, 0.021],
  [0.955, 0.055, 0.013],
  [0.309, 0.966, 0.018],
  [0.472, 0.97, 0.014],
  [0.088, 0.785, 0.02],
  [0.122, 0.878, 0.02],
  [0.19, 0.87, 0.018],
  [0.099, 0.71, 0.016],
  [0.14, 0.38, 0.022],
  [0.955, 0.62, 0.016],
];
/** Solid cylinder bosses standing proud of the frame, flat topped: [u, t, radius (u)]. */
const BOSSES: [number, number, number][] = [
  [0.912, 0.117, 0.026],
  [0.942, 0.886, 0.02],
  [0.953, 0.957, 0.017],
  [0.24, 0.95, 0.026],
];
/** Raised rib slots along the top edge: [u0, t0, u1, t1]. */
const SLOTS: [number, number, number, number][] = [
  [0.372, 0.014, 0.448, 0.034],
  [0.631, 0.01, 0.684, 0.029],
];
/** Through-holes: the oval top left ([u, t, half-width u, half-height t]) and the round one bottom left. */
const OVAL: [number, number, number, number] = [0.164, 0.056, 0.0165, 0.03];
const ROUND: [number, number, number] = [0.164, 0.958, 0.024];
/** The write-protect pocket (u0, t0, u1, t1), its slider, and the stepped channel beside it (ref 19 at 3×). */
const POCKET = { u0: 0.839, t0: 0.923, u1: 0.93, t1: 0.978 };
const SLIDER = { u0: 0.848, t0: 0.93, u1: 0.894, t1: 0.972 };
const CHANNEL: [number, number][] = [
  [0.74, 0.975],
  [0.77, 0.975],
  [0.77, 0.945],
  [0.839, 0.945],
];
/** The maker's badge up the right edge. */
const BADGE = { u0: 0.962, t0: 0.205, u1: 0.993, t1: 0.341 };
/** The rail cap in the notch at the top right. */
const NOTCH = { u0: 0.952, t0: 0.074, u1: 1, t1: 0.157 };
/** The shutter's frosted top cover (chamfered top right) and the reference-hole lens on it. */
// Its top edge clears the top-left screw's well (t 0.012..0.072): nothing ever sits over a screw.
const COVER = { u0: RAIL_U, t0: 0.082, u1: 0.149, t1: 0.253, chamfer: 0.022 };
const LENS: [number, number, number] = [0.094, 0.098, 0.027];
/** The metal spine up the left edge, from the plate to here, with its two slots. */
export const SPINE_TOP_T = 0.224;
const SPINE_SLOTS = [0.269, 0.314];
/** The shutter's clear track: from the plate's top down to here, with its rounded corner. */
// Stops above the bottom-left screw's well (t 0.928..0.988), so the track never covers a screw.
export const TONGUE_BOTTOM_T = 0.915;
/**
 * The laser window through the back, under the shutter's back leaf: from near the edge to just short of the hub,
 * across the plate's height (shell fractions, t from the top). Open, it shows the disc's reflective data side.
 */
export const LASER_WINDOW = { u0: 0.075, t0: 0.39, u1: 0.355, t1: 0.61 };
/**
 * The back's hub opening, as fractions of the shell width: small enough that the shutter's back leaf clears its
 * bezel (the leaf ends at u 0.388; the bezel starts at 0.516 − 0.125), large enough for the deck's spindle chuck
 * (0.095 of the width) to rise through it.
 */
export const BACK_HUB = { inner: 0.105, outer: 0.125 };

/** The screw bore's radius, as a multiple of the screw head's: the hole the screw runs down, open at the back. */
export const SCREW_BORE = 0.62;
/** Front well depth (cartridge-detail.ts WELL_DEPTH): the screw head's seat. */
const WELL_DEPTH = 0.008;
/** Detent ticks on the rail: [t0, t1] runs. */
const TICKS: [number, number][] = [
  [0.66, 0.9],
];
/** Capsule cavities moulded inside the rail, seen through it: [t0, t1]. */
const CAPSULES: [number, number][] = [
  [0.075, 0.13],
  [0.145, 0.215],
  [0.36, 0.43],
  [0.45, 0.6],
];

export interface MouldingInput {
  cartridge: Group;
  rect: Rect;
  disc: { x: number; y: number; radius: number; topZ: number };
  frontZ: number;
  backZ: number;
  bevel: number;
  shellRadius: number;
  /** The frame's plastic and the rail's. */
  frame: string;
  /** The whole slide cover's colour (design.ts `resolveSlideColor`): the one-piece shutter's steel, tinted. */
  slideColor?: string;
  rail: string;
  /** The metal plate's rectangle (cartridge space); the spine, the wrap and the tongue attach to it. */
  plateRect: Rect;
  /** The shutter group (cartridge.ts): the spine, the wrap and the plate's shadow slide with the plate. */
  shutter: Group;
  /** The screw wells, [u, t, radius (u)]: the frame is counterbored round each so the screws stay exposed. */
  screws: [number, number, number][];
  year: number;
  quality: 'high' | 'low';
  envMap: Texture | null;
  anisotropy: number;
  keep: <T extends Material>(m: T) => T;
  geo: <T extends BufferGeometry>(g: T) => T;
  tex: <T extends Texture>(t: T) => T;
}

function roundedRectShape(x0: number, y0: number, x1: number, y1: number, r: number): Shape {
  const shape = new Shape();
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

/** Planar UVs over the whole shell rect (u right, v up), so one canvas maps onto every frame face. */
function shellUv(geometry: BufferGeometry, rect: Rect): BufferGeometry {
  const position = geometry.attributes.position;
  const uv = new Float32Array(position.count * 2);
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  for (let i = 0; i < position.count; i++) {
    uv[i * 2] = (position.getX(i) - rect.x0) / w;
    uv[i * 2 + 1] = (position.getY(i) - rect.y0) / h;
  }
  geometry.setAttribute('uv', new BufferAttribute(uv, 2));
  return geometry;
}

/** Draws in shell fractions on a canvas the shell's shape. */
function shellCanvas(size: number, aspect: number) {
  const w = size;
  const h = Math.round(size / aspect);
  const [element, ctx] = canvas(w, h);
  return { element, ctx, w, h, X: (u: number) => u * w, Y: (t: number) => t * h };
}

/** Where the frame's top surface stands proud; everything else is a recessed pocket. */
function plateaus(ctx: CanvasRenderingContext2D, X: (u: number) => number, Y: (t: number) => number, discUT: UT, screws: [number, number, number][]) {
  const [cu, ct] = discUT;
  // The outer border band, the cavity wall, the collars round the screws and holes, the badge strip.
  ctx.beginPath();
  ctx.rect(X(RAIL_U), Y(0), X(1 - RAIL_U), Y(0.06));
  ctx.rect(X(RAIL_U), Y(0.935), X(1 - RAIL_U), Y(0.065));
  ctx.rect(X(0.94), Y(0), X(0.06), Y(1));
  ctx.rect(X(RAIL_U), Y(0), X(0.03), Y(1));
  ctx.fill();
  ctx.beginPath();
  ctx.arc(X(cu), Y(ct), X(OPENING_U + LIP_U + 0.012), 0, Math.PI * 2);
  ctx.arc(X(cu), Y(ct), X(OPENING_U), 0, Math.PI * 2, true);
  ctx.fill();
  for (const [u, t, r] of screws) {
    ctx.beginPath();
    ctx.arc(X(u), Y(t), X(r * 1.55), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.beginPath();
  ctx.ellipse(X(OVAL[0]), Y(OVAL[1]), X(OVAL[2] * 1.7), Y(OVAL[3] * 1.45), 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(X(ROUND[0]), Y(ROUND[1]), X(ROUND[2] * 1.5), 0, Math.PI * 2);
  ctx.fill();
  // Diagonal webs from the corners to the cavity wall, as the references' pockets are divided.
  ctx.lineWidth = X(0.014);
  ctx.strokeStyle = ctx.fillStyle;
  for (const [u, t] of [
    [0.2, 0.06],
    [0.83, 0.06],
    [0.18, 0.94],
    [0.85, 0.94],
  ] as UT[]) {
    const angle = Math.atan2(t - ct, u - cu);
    ctx.beginPath();
    ctx.moveTo(X(u), Y(t));
    ctx.lineTo(X(cu + Math.cos(angle) * (OPENING_U + LIP_U)), Y(ct + Math.sin(angle) * (OPENING_U + LIP_U)));
    ctx.stroke();
  }
}

/** The frame's colour: moulded plastic, pockets a shade deeper, glitter flecks in the top surface. */
function frameColour(size: number, aspect: number, colour: string, seed: number, discUT: UT, screws: [number, number, number][]): HTMLCanvasElement {
  const { element, ctx, w, h, X, Y } = shellCanvas(size, aspect);
  const base = new Color(colour);
  ctx.fillStyle = `#${base.clone().multiplyScalar(0.72).getHexString()}`;
  ctx.fillRect(0, 0, w, h);
  // Contact shadows: the plateaus' walls throw a soft shadow into the pockets below them, down and to the left
  // of the key light (upper right), as the references' recesses read.
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = X(0.012);
  ctx.shadowOffsetX = -X(0.004);
  ctx.shadowOffsetY = Y(0.006);
  ctx.fillStyle = colour;
  plateaus(ctx, X, Y, discUT, screws);
  ctx.restore();
  // Each boss and collar sits in its own small shadow.
  for (const [u, t, radius] of [...BOSSES, ...screws.map(([su, st, sr]) => [su, st, sr * 1.2] as [number, number, number])]) {
    const shadow = ctx.createRadialGradient(X(u - 0.004), Y(t + 0.006), X(radius * 0.8), X(u - 0.004), Y(t + 0.006), X(radius * 1.45));
    shadow.addColorStop(0, 'rgba(0,0,0,0.45)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = shadow;
    ctx.beginPath();
    ctx.arc(X(u - 0.004), Y(t + 0.006), X(radius * 1.45), 0, Math.PI * 2);
    ctx.fill();
  }
  // The cavity wall's inner face, in its own shadow: the dark band between the lip and the disc (ref 19).
  const [cu, ct] = discUT;
  const shade = ctx.createRadialGradient(X(cu), Y(ct), X(OPENING_U), X(cu), Y(ct), X(OPENING_U + LIP_U));
  shade.addColorStop(0, `#${base.clone().multiplyScalar(0.28).getHexString()}`);
  shade.addColorStop(0.8, `#${base.clone().multiplyScalar(0.55).getHexString()}`);
  shade.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(X(cu), Y(ct), X(OPENING_U + LIP_U), 0, Math.PI * 2);
  ctx.fill();
  const lift = ctx.createLinearGradient(0, 0, w * 0.3, h);
  lift.addColorStop(0, 'rgba(255,255,255,0.03)');
  lift.addColorStop(1, 'rgba(0,0,0,0.1)');
  ctx.fillStyle = lift;
  ctx.fillRect(0, 0, w, h);
  // Glitter: the references' moulding is flecked with bright specks, denser than plain ABS speckle.
  const random = prng(seed);
  const flecks = Math.round(w * h * 0.06);
  for (let i = 0; i < flecks; i++) {
    const bright = random();
    ctx.fillStyle = bright < 0.7 ? `rgba(255,255,160,${0.08 + random() * 0.32})` : `rgba(0,0,0,${0.08 + random() * 0.14})`;
    const size = bright > 0.97 ? 2 : 1 + random() * 0.8;
    ctx.fillRect(random() * w, random() * h, size, size);
  }
  return element;
}

/** The frame's relief as a height map (128 = the pocket floor): plateaus, lips, rings, ribs and lettering. */
function frameHeight(size: number, aspect: number, discUT: UT, screws: [number, number, number][], year: number): HTMLCanvasElement {
  const { element, ctx, w, h, X, Y } = shellCanvas(size, aspect);
  const [cu, ct] = discUT;
  ctx.fillStyle = '#707070';
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = '#a4a4a4';
  plateaus(ctx, X, Y, discUT, screws);
  // Soften the plateau walls so the normals show a chamfer, not a cliff.
  ctx.filter = 'blur(3px)';
  ctx.drawImage(element, 0, 0);
  ctx.filter = 'none';
  // The cavity wall's lip, bright and narrow.
  ctx.strokeStyle = '#d6d6d6';
  ctx.lineWidth = X(0.006);
  ctx.beginPath();
  ctx.arc(X(cu), Y(ct), X(OPENING_U + LIP_U), 0, Math.PI * 2);
  ctx.stroke();
  // The rim ridge just inside the outer edge.
  ctx.strokeStyle = '#c0c0c0';
  ctx.lineWidth = X(0.005);
  ctx.strokeRect(X(RAIL_U + 0.012), Y(0.014), X(1 - RAIL_U - 0.026), Y(0.972));
  // Ghost rings: a faint raised ring round a shallow dish.
  for (const [u, t, r] of GHOSTS) {
    ctx.strokeStyle = '#b8b8b8';
    ctx.lineWidth = X(0.0035);
    ctx.beginPath();
    ctx.arc(X(u), Y(t), X(r), 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(80,80,80,0.5)';
    ctx.beginPath();
    ctx.arc(X(u), Y(t), X(r * 0.75), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.fillStyle = '#c6c6c6';
  for (const [u0, t0, u1, t1] of SLOTS) {
    ctx.beginPath();
    ctx.roundRect(X(u0), Y(t0), X(u1 - u0), Y(t1 - t0), X(0.004));
    ctx.fill();
  }
  // The stepped channel beside the write-protect pocket, cut into the plateau.
  ctx.strokeStyle = '#5a5a5a';
  ctx.lineWidth = X(0.008);
  ctx.beginPath();
  CHANNEL.forEach(([u, t], i) => (i ? ctx.lineTo(X(u), Y(t)) : ctx.moveTo(X(u), Y(t))));
  ctx.stroke();
  // The maker's badge: a raised frame with the lettering running up it.
  ctx.strokeStyle = '#cacaca';
  ctx.lineWidth = X(0.003);
  ctx.strokeRect(X(BADGE.u0), Y(BADGE.t0), X(BADGE.u1 - BADGE.u0), Y(BADGE.t1 - BADGE.t0));
  ctx.save();
  ctx.translate(X((BADGE.u0 + BADGE.u1) / 2), Y((BADGE.t0 + BADGE.t1) / 2));
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = '#d0d0d0';
  ctx.font = `700 ${Math.round(X(BADGE.u1 - BADGE.u0) * 0.62)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('MYIND', 0, 0);
  ctx.restore();
  // INSERT THIS END ▼ along the bottom edge: a top-loading deck takes the bottom edge first.
  ctx.fillStyle = '#d0d0d0';
  ctx.font = `700 ${Math.round(h * 0.019)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('INSERT THIS END', X(0.56), Y(0.953));
  ctx.beginPath();
  ctx.moveTo(X(0.56), Y(0.99));
  ctx.lineTo(X(0.548), Y(0.972));
  ctx.lineTo(X(0.572), Y(0.972));
  ctx.closePath();
  ctx.fill();
  ctx.font = `600 ${Math.round(h * 0.013)}px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(`MD · ${year}`, X(0.36), Y(0.918));
  ctx.filter = 'blur(1px)';
  ctx.drawImage(element, 0, 0);
  ctx.filter = 'none';
  return element;
}

/** Plain moulded plastic in a colour, with the references' glitter flecks: the back half and the sides. */
export function plasticSpeckle(colour: string, size: number, seed: number): HTMLCanvasElement {
  const [element, ctx] = canvas(size);
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, size, size);
  const random = prng(seed ^ 0x5eed);
  for (let i = 0; i < size * size * 0.05; i++) {
    const bright = random();
    ctx.fillStyle = bright < 0.7 ? `rgba(255,255,160,${0.06 + random() * 0.28})` : `rgba(0,0,0,${0.06 + random() * 0.12})`;
    ctx.fillRect(random() * size, random() * size, 1 + random() * 0.8, 1 + random() * 0.8);
  }
  return element;
}

/**
 * The back half's relief (grey 128 flat), in cap UV (u right, t down as seen from the FRONT): the rim ridge, the
 * label recess, the ring round the hub, the laser window's frame and the bores' collars, and INSERT THIS END ▼
 * along the bottom, mirrored so it reads from behind.
 */
export function backHeight(size: number, aspect: number, discUT: [number, number], hubU: number, screws: [number, number][]): HTMLCanvasElement {
  const w = size;
  const h = Math.round(size / aspect);
  const [element, ctx] = canvas(w, h);
  const X = (u: number) => u * w;
  const Y = (t: number) => t * h;
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = '#b0b0b0';
  ctx.lineWidth = X(0.006);
  ctx.strokeRect(X(0.022), Y(0.022), X(0.956), Y(0.956));
  // The label recess, clear of the shutter's track (left as seen from behind = right in cap UV).
  ctx.fillStyle = '#6c6c6c';
  ctx.beginPath();
  ctx.roundRect(X(0.6), Y(0.66), X(0.34), Y(0.26), X(0.012));
  ctx.fill();
  ctx.strokeStyle = '#a8a8a8';
  ctx.lineWidth = X(0.004);
  ctx.beginPath();
  ctx.arc(X(discUT[0]), Y(discUT[1]), X(hubU * 1.25), 0, Math.PI * 2);
  ctx.stroke();
  const lw = LASER_WINDOW;
  ctx.strokeStyle = '#5c5c5c';
  ctx.lineWidth = X(0.008);
  ctx.strokeRect(X(lw.u0 - 0.01), Y(lw.t0 - 0.012), X(lw.u1 - lw.u0 + 0.02), Y(lw.t1 - lw.t0 + 0.024));
  for (const [u, t] of screws) {
    ctx.strokeStyle = '#b4b4b4';
    ctx.beginPath();
    ctx.arc(X(u), Y(t), X(0.03), 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(X(0.44), Y(0.955));
  ctx.scale(-1, 1);
  ctx.fillStyle = '#c4c4c4';
  ctx.font = `700 ${Math.round(h * 0.022)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('INSERT THIS END ▼', 0, 0);
  ctx.restore();
  ctx.filter = 'blur(1px)';
  ctx.drawImage(element, 0, 0);
  ctx.filter = 'none';
  return element;
}

/**
 * The back half's skin (cap UV, t from the top as seen from the front): the plastic with its glitter, the shutter's
 * slide track as a darker recessed band with lit edges, and the track's wear: vertical lines where the leaf has
 * slid up and down, a fixed seeded sequence that `level` (0 new .. 1 worn out) reveals a prefix of.
 */
export function backSkin(
  target: HTMLCanvasElement | null,
  size: number,
  aspect: number,
  colour: string,
  seed: number,
  track: { u0: number; t0: number; u1: number; t1: number },
  level: number,
): HTMLCanvasElement {
  const w = size;
  const h = Math.round(size / aspect);
  const element = target ?? canvas(w, h)[0];
  const ctx = element.getContext('2d')!;
  ctx.drawImage(plasticSpeckle(colour, Math.max(w, h), seed), 0, 0, w, h);
  const X = (u: number) => u * w;
  const Y = (t: number) => t * h;
  // The track: recessed a shade, with the light catching its upper edge and its right wall in shadow.
  ctx.fillStyle = 'rgba(0,0,0,0.16)';
  ctx.fillRect(X(track.u0), Y(track.t0), X(track.u1 - track.u0), Y(track.t1 - track.t0));
  ctx.fillStyle = 'rgba(255,255,255,0.18)';
  ctx.fillRect(X(track.u0), Y(track.t0), X(track.u1 - track.u0), Math.max(1, Y(0.003)));
  ctx.fillStyle = 'rgba(0,0,0,0.3)';
  ctx.fillRect(X(track.u1) - Math.max(1, X(0.003)), Y(track.t0), Math.max(1, X(0.003)), Y(track.t1 - track.t0));
  // Wear: the leaf's slide, top to bottom.
  const random = prng(seed ^ 0x7a11);
  const LINES = 160;
  const shown = Math.floor(LINES * Math.pow(Math.max(0, Math.min(1, level)), 0.7));
  for (let i = 0; i < LINES; i++) {
    const u = track.u0 + 0.004 + random() * (track.u1 - track.u0 - 0.008);
    const span = track.t1 - track.t0;
    const length = span * (0.15 + random() * 0.7);
    const t0 = track.t0 + random() * (span - length);
    const alpha = 0.08 + random() * 0.22;
    const width = 0.6 + random() * 0.8;
    if (i >= shown) continue;
    ctx.strokeStyle = `rgba(255,255,255,${alpha})`;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(X(u), Y(t0));
    ctx.lineTo(X(u), Y(t0 + length));
    ctx.stroke();
  }
  return element;
}

/**
 * Brushed steel for the shutter, as refs 19 and 33 show it up close: dense hairline scratches all running one
 * way (across the plate), broken into lengths so they never form stripes, over a faint low-frequency cloud.
 * Mean about 0.85, so it textures the steel's colour without darkening it. Tiled on the shell-wide UVs.
 */
function brushedSteelMap(): HTMLCanvasElement {
  const size = 1024;
  const [element, ctx] = canvas(size);
  ctx.fillStyle = '#d6d9dd';
  ctx.fillRect(0, 0, size, size);
  const random = prng(0x57ee1);
  // The cloud: long soft bands of slightly different grey, as the brushing pressure varies.
  for (let i = 0; i < 40; i++) {
    const y = random() * size;
    const band = ctx.createLinearGradient(0, y - 20, 0, y + 20);
    const tone = random() < 0.5 ? '255,255,255' : '0,0,0';
    band.addColorStop(0, `rgba(${tone},0)`);
    band.addColorStop(0.5, `rgba(${tone},${0.02 + random() * 0.03})`);
    band.addColorStop(1, `rgba(${tone},0)`);
    ctx.fillStyle = band;
    ctx.fillRect(0, y - 20, size, 40);
  }
  // The hairlines: thousands of short, straight, one-direction scratches.
  for (let i = 0; i < 9000; i++) {
    const y = random() * size;
    const x = random() * size;
    const length = 40 + random() * 380;
    ctx.strokeStyle = `rgba(${random() < 0.55 ? '255,255,255' : '0,0,0'},${0.03 + random() * 0.09})`;
    ctx.lineWidth = 0.35 + random() * 0.6;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + length, y + (random() - 0.5) * 0.8);
    ctx.stroke();
  }
  return element;
}

/** Screw threads for the shank seen down the bore: dark and light rings, repeated along it. */
function threadMap(): HTMLCanvasElement {
  const [element, ctx] = canvas(8, 64);
  for (let y = 0; y < 64; y += 8) {
    const g = ctx.createLinearGradient(0, y, 0, y + 8);
    g.addColorStop(0, '#4a4d54');
    g.addColorStop(0.5, '#d6d9de');
    g.addColorStop(1, '#4a4d54');
    ctx.fillStyle = g;
    ctx.fillRect(0, y, 8, 8);
  }
  return element;
}

/** The rail: clear lilac, the capsule cavities inside it reading darker with a lit edge. */
function railColour(size: number, aspect: number, colour: string): HTMLCanvasElement {
  const { element, ctx, w, h, X, Y } = shellCanvas(size, aspect);
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, w, h);
  const across = ctx.createLinearGradient(0, 0, X(RAIL_U), 0);
  across.addColorStop(0, 'rgba(0,0,0,0.35)');
  across.addColorStop(0.35, 'rgba(255,255,255,0.12)');
  across.addColorStop(1, 'rgba(0,0,0,0.2)');
  ctx.fillStyle = across;
  ctx.fillRect(0, 0, X(RAIL_U), h);
  for (const [t0, t1] of CAPSULES) {
    ctx.fillStyle = 'rgba(20,10,30,0.42)';
    ctx.beginPath();
    ctx.roundRect(X(0.008), Y(t0), X(RAIL_U - 0.018), Y(t1 - t0), X(0.012));
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = X(0.0025);
    ctx.stroke();
  }
  return element;
}

/** The lens: a concave lilac dish with the mould's concentric rings. */
function lensMap(colour: string): HTMLCanvasElement {
  const [element, ctx] = canvas(128);
  const dish = ctx.createRadialGradient(56, 54, 4, 64, 64, 64);
  dish.addColorStop(0, `#${new Color(colour).lerp(new Color('#ffffff'), 0.45).getHexString()}`);
  dish.addColorStop(0.35, colour);
  dish.addColorStop(0.85, `#${new Color(colour).multiplyScalar(0.6).getHexString()}`);
  dish.addColorStop(1, '#ffffff');
  ctx.fillStyle = dish;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)';
  for (const r of [14, 24, 34, 44]) {
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(64, 64, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  return element;
}

export function buildMoulding(input: MouldingInput): void {
  const { cartridge, rect, disc, frontZ, bevel, keep, geo, tex, envMap } = input;
  const w = rect.x1 - rect.x0;
  const h = rect.y1 - rect.y0;
  const aspect = w / h;
  const X = (u: number) => rect.x0 + u * w;
  const Y = (t: number) => rect.y1 - t * h;
  const discUT: UT = [(disc.x - rect.x0) / w, (rect.y1 - disc.y) / h];
  const size = input.quality === 'low' ? 512 : 1024;
  const seed = 0x51ab;
  const frameCol = new Color(input.frame);

  // ── INNER: the frame, from the rail to the right edge, under the clear top shell ──────────────────────
  const frameBack = disc.topZ + 0.0015;
  const frameFront = frontZ - bevel - 0.0016;
  const outline = new Shape();
  const r = input.shellRadius - bevel;
  const x0 = X(RAIL_U);
  const x1 = rect.x1 - bevel;
  const y0 = rect.y0 + bevel;
  const y1 = rect.y1 - bevel;
  outline.moveTo(x0, y0);
  outline.lineTo(x1 - r, y0);
  outline.quadraticCurveTo(x1, y0, x1, y0 + r);
  outline.lineTo(x1, y1 - r);
  outline.quadraticCurveTo(x1, y1, x1 - r, y1);
  outline.lineTo(x0, y1);
  outline.closePath();
  const opening = new Path();
  opening.absarc(disc.x, disc.y, OPENING_U * w, 0, Math.PI * 2, true);
  const oval = new Path();
  oval.absellipse(X(OVAL[0]), Y(OVAL[1]), OVAL[2] * w, OVAL[3] * h, 0, Math.PI * 2, true, 0);
  const round = new Path();
  round.absarc(X(ROUND[0]), Y(ROUND[1]), ROUND[2] * w, 0, Math.PI * 2, true);
  const pocketBox = { x0: X(POCKET.u0), y0: Y(POCKET.t1), x1: X(POCKET.u1), y1: Y(POCKET.t0) };
  // Counterbores: each screw sits exposed at the bottom of its well, never under plastic (LIT's disc). Holes must
  // never overlap (the triangulation fails and fills a wedge of plastic across the disc), so a well that runs into
  // the write-protect pocket (the bottom right screw) is cut as one hole with it.
  const wells: Path[] = [];
  let pocket: Path | null = null;
  for (const [u, t, radius] of input.screws) {
    const cx = X(u);
    const cy = Y(t);
    const wellR = radius * w * 1.04;
    const centreInPocket = cx > pocketBox.x0 && cx < pocketBox.x1 && cy > pocketBox.y0 && cy < pocketBox.y1;
    if (!pocket && centreInPocket) {
      pocket = boxAndCircle(pocketBox, cx, cy, wellR);
      continue;
    }
    const well = new Path();
    well.absarc(cx, cy, wellR, 0, Math.PI * 2, true);
    wells.push(well);
  }
  if (!pocket) {
    pocket = new Path();
    pocket.moveTo(pocketBox.x0, pocketBox.y0);
    pocket.lineTo(pocketBox.x0, pocketBox.y1);
    pocket.lineTo(pocketBox.x1, pocketBox.y1);
    pocket.lineTo(pocketBox.x1, pocketBox.y0);
    pocket.closePath();
  }
  outline.holes.push(opening, oval, round, pocket, ...wells);
  const frameGeometry = geo(new ExtrudeGeometry(outline, { depth: frameFront - frameBack, bevelEnabled: false, curveSegments: 48 }));
  shellUv(frameGeometry, rect);
  const colourMap = tex(srgbTexture(frameColour(size, aspect, input.frame, seed, discUT, input.screws), input.anisotropy));
  const normalMap = tex(heightToNormal(frameHeight(size, aspect, discUT, input.screws, input.year), 4.5));
  const plastic = keep(
    new MeshPhysicalMaterial({
      map: colourMap,
      emissiveMap: colourMap,
      // A little self light: the references are lit through the plastic, so the colour never goes muddy.
      // The map carries the plastic's colour; the base colour holds it at the references' depth under the key
      // light, and a little self light keeps it from going muddy in the dark scene.
      color: new Color(0.62, 0.62, 0.62),
      emissive: new Color(0.06, 0.06, 0.06),
      roughness: 0.55,
      normalMap,
      normalScale: new Vector2(1.6, 1.6),
      envMap,
      envMapIntensity: 0.14,
    }),
  );
  // The walls (outer edge, holes, counterbores, pocket): the plastic's own colour, in shadow.
  const wall = keep(new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.45), roughness: 0.5, envMap, envMapIntensity: 0.3 }));
  const frame = new Mesh(frameGeometry, [plastic, wall]);
  frame.position.z = frameBack;
  frame.renderOrder = 2;
  cartridge.add(frame);

  // The cavity wall round the disc: a raised annulus with a lit lip, the shadow band inside it, the black gap.
  const lipShape = new Shape();
  lipShape.absarc(disc.x, disc.y, (OPENING_U + LIP_U) * w, 0, Math.PI * 2, false);
  const lipHole = new Path();
  lipHole.absarc(disc.x, disc.y, OPENING_U * w, 0, Math.PI * 2, true);
  lipShape.holes.push(lipHole);
  const lipGeometry = geo(new ExtrudeGeometry(lipShape, { depth: 0.0016, bevelEnabled: true, bevelThickness: 0.0004, bevelSize: 0.0012, bevelSegments: 2, curveSegments: 96 }));
  shellUv(lipGeometry, rect);
  const lip = new Mesh(lipGeometry, [plastic, keep(new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.3), roughness: 0.45, envMap, envMapIntensity: 0.35 }))]);
  lip.position.z = frameFront;
  cartridge.add(lip);
  const band = new Mesh(
    geo(new CylinderGeometry(OPENING_U * w - 0.0004, OPENING_U * w - 0.0004, frameFront + 0.0016 - frameBack, 96, 1, true).rotateX(Math.PI / 2)),
    keep(new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.14), roughness: 0.6, side: BackSide })),
  );
  band.position.set(disc.x, disc.y, (frameFront + 0.0016 + frameBack) / 2);
  cartridge.add(band);

  // The black gap between the disc's edge and the cavity wall.
  const gap = new Mesh(
    geo(new CylinderGeometry(OPENING_U * w, OPENING_U * w, 0.0004, 96, 1, true).rotateX(Math.PI / 2)),
    keep(new MeshStandardMaterial({ color: '#000000', roughness: 1, side: DoubleSide })),
  );
  gap.position.set(disc.x, disc.y, disc.topZ + 0.0006);
  const gapRing = new Mesh(
    geo(new TorusGeometry((OPENING_U * w + disc.radius) / 2, Math.max(0.0008, (OPENING_U * w - disc.radius) / 2), 4, 96)),
    keep(new MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.85 })),
  );
  gapRing.scale.z = 0.05;
  gapRing.position.set(disc.x, disc.y, disc.topZ + 0.0008);
  cartridge.add(gap, gapRing);

  // Black behind the through-holes and the pocket: they go right through the shell.
  const hole = keep(new MeshStandardMaterial({ color: '#030304', roughness: 0.9 }));
  const ovalBack = new Mesh(geo(new CylinderGeometry(1, 1, 0.001, 32).rotateX(Math.PI / 2)), hole);
  ovalBack.scale.set(OVAL[2] * w * 1.1, OVAL[3] * h * 1.1, 1);
  ovalBack.position.set(X(OVAL[0]), Y(OVAL[1]), frameBack - 0.001);
  const roundBack = new Mesh(geo(new CylinderGeometry(ROUND[2] * w * 1.1, ROUND[2] * w * 1.1, 0.001, 32).rotateX(Math.PI / 2)), hole);
  roundBack.position.set(X(ROUND[0]), Y(ROUND[1]), frameBack - 0.001);
  // The write-protect pocket: a dark floor, and the slider block in its left half.
  const pocketFloor = new Mesh(geo(new BoxGeometry((POCKET.u1 - POCKET.u0) * w, (POCKET.t1 - POCKET.t0) * h, 0.001)), wall);
  pocketFloor.position.set(X((POCKET.u0 + POCKET.u1) / 2), Y((POCKET.t0 + POCKET.t1) / 2), frameBack + 0.0005);
  const slider = new Mesh(
    geo(new BoxGeometry((SLIDER.u1 - SLIDER.u0) * w, (SLIDER.t1 - SLIDER.t0) * h, frameFront - frameBack - 0.0012)),
    keep(new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.7), roughness: 0.5, envMap, envMapIntensity: 0.18 })),
  );
  slider.position.set(X((SLIDER.u0 + SLIDER.u1) / 2), Y((SLIDER.t0 + SLIDER.t1) / 2), (frameFront + frameBack) / 2 - 0.0004);
  cartridge.add(ovalBack, roundBack, pocketFloor, slider);

  // Collars: raised rings round the screw wells and the oval hole, catching the light as the shell turns.
  const collar = keep(
    new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.72), roughness: 0.48, envMap, envMapIntensity: 0.18 }),
  );
  for (const [u, t, radius] of input.screws) {
    const ring = new Mesh(geo(new TorusGeometry(radius * w * 1.18, radius * w * 0.16, 10, 40)), collar);
    ring.scale.z = 0.6;
    ring.position.set(X(u), Y(t), frameFront + 0.0003);
    cartridge.add(ring);
  }
  const ovalCollar = new Mesh(geo(new TorusGeometry(1, 0.14, 10, 40)), collar);
  ovalCollar.scale.set(OVAL[2] * w * 1.25, OVAL[3] * h * 1.18, OVAL[2] * w * 0.6);
  ovalCollar.position.set(X(OVAL[0]), Y(OVAL[1]), frameFront + 0.0003);
  cartridge.add(ovalCollar);

  // Solid bosses: flat-topped cylinders with a chamfered rim.
  for (const [u, t, radius] of BOSSES) {
    const post = new Mesh(geo(new CylinderGeometry(radius * w, radius * w * 1.08, 0.0022, 40).rotateX(Math.PI / 2)), collar);
    post.position.set(X(u), Y(t), frameFront + 0.0011);
    const rim = new Mesh(geo(new TorusGeometry(radius * w * 0.98, 0.0005, 6, 40)), collar);
    rim.position.set(X(u), Y(t), frameFront + 0.0022);
    cartridge.add(post, rim);
  }

  // ── OUTER: the side rail and the notch cap, clear lilac ────────────────────────────────────────────────
  const railMap = tex(srgbTexture(railColour(size, aspect, input.rail)));
  const railMaterial = keep(
    new MeshPhysicalMaterial({
      map: railMap,
      emissiveMap: railMap,
      color: new Color(0.7, 0.7, 0.7),
      emissive: new Color(0.1, 0.1, 0.1),
      roughness: 0.3,
      clearcoat: 0.2,
      clearcoatRoughness: 0.2,
      envMap,
      envMapIntensity: 0.18,
    }),
  );
  const railShape = new Shape();
  const rr = input.shellRadius;
  const rx0 = rect.x0 + bevel * 0.5;
  const rx1 = X(RAIL_U);
  const ry0 = rect.y0 + bevel * 0.5;
  const ry1 = rect.y1 - bevel * 0.5;
  railShape.moveTo(rx0 + rr, ry0);
  railShape.lineTo(rx1, ry0);
  railShape.lineTo(rx1, ry1);
  railShape.lineTo(rx0 + rr, ry1);
  railShape.quadraticCurveTo(rx0, ry1, rx0, ry1 - rr);
  railShape.lineTo(rx0, ry0 + rr);
  railShape.quadraticCurveTo(rx0, ry0, rx0 + rr, ry0);
  const railGeometry = geo(new ExtrudeGeometry(railShape, { depth: frameFront - frameBack + 0.002, bevelEnabled: false }));
  shellUv(railGeometry, rect);
  const rail = new Mesh(railGeometry, railMaterial);
  rail.position.z = frameBack;
  const notchGeometry = geo(new BoxGeometry((NOTCH.u1 - NOTCH.u0) * w - bevel, (NOTCH.t1 - NOTCH.t0) * h, frameFront - frameBack));
  const notch = new Mesh(notchGeometry, keep(new MeshPhysicalMaterial({ color: new Color(input.rail).multiplyScalar(0.6), emissive: new Color(input.rail).multiplyScalar(0.04), roughness: 0.4, clearcoat: 0.15, envMap, envMapIntensity: 0.15 })));
  notch.position.set(X((NOTCH.u0 + NOTCH.u1) / 2) - bevel / 2, Y((NOTCH.t0 + NOTCH.t1) / 2), (frameFront + frameBack) / 2 + 0.0005);
  cartridge.add(rail, notch);
  const tick = keep(new MeshStandardMaterial({ color: new Color(input.rail).multiplyScalar(0.35), roughness: 0.5 }));
  for (const [t0, t1] of TICKS) {
    for (let t = t0; t <= t1; t += 0.0185) {
      const mark = new Mesh(geo(new BoxGeometry(RAIL_U * w * 0.42, 0.0022, 0.001)), tick);
      mark.position.set(X(RAIL_U * 0.55), Y(t), frameFront + 0.0021);
      cartridge.add(mark);
    }
  }

  // The parting line where the clear top half meets the coloured bottom half: a hairline round the sides, so
  // the shell reads as two layers when it turns.
  const perimeter = (grow: number, hole: boolean): Shape | Path => {
    const p = hole ? new Path() : new Shape();
    const ex0 = rect.x0 - grow;
    const ex1 = rect.x1 + grow;
    const ey0 = rect.y0 - grow;
    const ey1 = rect.y1 + grow;
    const er = input.shellRadius;
    p.moveTo(ex0 + er, ey0);
    p.lineTo(ex1 - er, ey0);
    p.quadraticCurveTo(ex1, ey0, ex1, ey0 + er);
    p.lineTo(ex1, ey1 - er);
    p.quadraticCurveTo(ex1, ey1, ex1 - er, ey1);
    p.lineTo(ex0 + er, ey1);
    p.quadraticCurveTo(ex0, ey1, ex0, ey1 - er);
    p.lineTo(ex0, ey0 + er);
    p.quadraticCurveTo(ex0, ey0, ex0 + er, ey0);
    return p;
  };
  const seamShape = perimeter(0.0006, false) as Shape;
  seamShape.holes.push(perimeter(-0.003, true) as Path);
  // The halves meet mid-depth: a dark parting groove (about 6% of the shell's thickness, as on a real cartridge)
  // with a lit lip on the upper half's edge above it.
  const midZ = (input.frontZ + input.backZ) / 2;
  const seamDepth = (input.frontZ - input.backZ) * 0.06;
  const seam = new Mesh(
    geo(new ExtrudeGeometry(seamShape, { depth: seamDepth, bevelEnabled: false, curveSegments: 8 })),
    keep(new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.12), roughness: 0.7 })),
  );
  seam.position.z = midZ - seamDepth / 2;
  const seamLipShape = perimeter(0.0005, false) as Shape;
  seamLipShape.holes.push(perimeter(-0.003, true) as Path);
  const seamLip = new Mesh(
    geo(new ExtrudeGeometry(seamLipShape, { depth: seamDepth * 0.35, bevelEnabled: false, curveSegments: 8 })),
    keep(new MeshStandardMaterial({ color: frameCol.clone().lerp(new Color('#ffffff'), 0.25), roughness: 0.35, envMap, envMapIntensity: 0.5 })),
  );
  seamLip.position.z = midZ + seamDepth / 2;
  cartridge.add(seam, seamLip);

  // ── Through the shell: screw bores open at the back, the shank's thread visible down each ──────────────
  const boreWall = keep(new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.35), roughness: 0.6, side: BackSide }));
  const threads = tex(srgbTexture(threadMap()));
  threads.wrapS = threads.wrapT = RepeatWrapping;
  threads.repeat.set(1, 6);
  const shank = keep(new MeshStandardMaterial({ map: threads, metalness: 0.85, roughness: 0.45, envMap, envMapIntensity: 0.3 }));
  const tipSteel = keep(new MeshStandardMaterial({ color: '#9a9fa6', metalness: 0.85, roughness: 0.5, envMap, envMapIntensity: 0.3 }));
  const seatZ = input.frontZ - WELL_DEPTH;
  for (const [u, t, wellR] of input.screws) {
    const headR = (wellR / 1.38) * w;
    const boreR = headR * SCREW_BORE;
    const bore = new Mesh(geo(new CylinderGeometry(boreR, boreR, seatZ - input.backZ, 24, 1, true).rotateX(Math.PI / 2)), boreWall);
    bore.position.set(X(u), Y(t), (seatZ + input.backZ) / 2);
    // The screw runs from its head on the front almost through: its threaded end sits just inside the small
    // opening on the back, close enough to catch the light.
    const tipZ = input.backZ + 0.0018;
    const shankLength = seatZ - tipZ;
    const screwShank = new Mesh(geo(new CylinderGeometry(boreR * 0.78, boreR * 0.72, shankLength, 20).rotateX(Math.PI / 2)), shank);
    screwShank.position.set(X(u), Y(t), seatZ - shankLength / 2);
    // Its end: a shallow cone, the point the thread was rolled down to.
    // Wide end toward the head (+z), point toward the back.
    const tip = new Mesh(geo(new CylinderGeometry(boreR * 0.72, boreR * 0.2, 0.0012, 20).rotateX(Math.PI / 2)), tipSteel);
    tip.position.set(X(u), Y(t), tipZ - 0.0006);
    cartridge.add(bore, screwShank, tip);
  }

  // ── The back: the laser window's walls, and the shutter's back leaf sealing it ────────────────────────
  const lw = LASER_WINDOW;
  const windowW = (lw.u1 - lw.u0) * w;
  const windowH = (lw.t1 - lw.t0) * h;
  const wallDepth = disc.topZ - 0.008 - input.backZ;
  const windowWall = keep(new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.25), roughness: 0.6, side: BackSide }));
  const windowBox = new Mesh(geo(new BoxGeometry(windowW, windowH, wallDepth)), [windowWall, windowWall, windowWall, windowWall, keep(new MeshBasicMaterial({ visible: false })), keep(new MeshBasicMaterial({ visible: false }))]);
  windowBox.position.set(X((lw.u0 + lw.u1) / 2), Y((lw.t0 + lw.t1) / 2), input.backZ + wallDepth / 2);
  cartridge.add(windowBox);

  // ── OUTER: the shutter's parts on the outside of the shell ─────────────────────────────────────────────
  const outside = frontZ + 0.0008;
  // Their contact shadow on the shell: soft, tight, down and left of the key light. Baked once, one plane.
  const shade = shellCanvas(input.quality === 'low' ? 512 : 1024, aspect);
  const U = (x: number) => (x - rect.x0) / w;
  const T = (y: number) => (rect.y1 - y) / h;
  const cast = (draw: () => void, alpha: number) => {
    const c = shade.ctx;
    c.save();
    // Draw the shape far off canvas and keep only its shadow, offset back into place.
    c.translate(-shade.w * 4, 0);
    c.shadowColor = `rgba(0,0,0,${alpha})`;
    c.shadowBlur = shade.X(0.01);
    c.shadowOffsetX = shade.w * 4 - shade.X(0.004);
    c.shadowOffsetY = shade.Y(0.006);
    c.fillStyle = '#000';
    c.beginPath();
    draw();
    c.fill();
    c.restore();
  };
  const pr = input.plateRect;
  cast(() => shade.ctx.rect(shade.X(COVER.u0), shade.Y(COVER.t0), shade.X(COVER.u1 - COVER.u0), shade.Y(COVER.t1 - COVER.t0)), 0.35);
  const shadowPlane = (texture: Texture) => {
    const plane = new Mesh(geo(new PlaneGeometry(w, h)), keep(new MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, toneMapped: false })));
    plane.position.set((rect.x0 + rect.x1) / 2, (rect.y0 + rect.y1) / 2, frontZ + 0.0003);
    plane.renderOrder = 5;
    return plane;
  };
  cartridge.add(shadowPlane(tex(srgbTexture(shade.element))));
  // The plate's and spine's own shadow rides with the shutter.
  shade.ctx.clearRect(0, 0, shade.w, shade.h);
  const moving = shellCanvas(input.quality === 'low' ? 512 : 1024, aspect);
  const castMoving = (draw: () => void, alpha: number) => {
    const c = moving.ctx;
    c.save();
    c.translate(-moving.w * 4, 0);
    c.shadowColor = `rgba(0,0,0,${alpha})`;
    c.shadowBlur = moving.X(0.01);
    c.shadowOffsetX = moving.w * 4 - moving.X(0.004);
    c.shadowOffsetY = moving.Y(0.006);
    c.fillStyle = '#000';
    c.beginPath();
    draw();
    c.fill();
    c.restore();
  };
  castMoving(() => moving.ctx.rect(moving.X(U(pr.x0)), moving.Y(T(pr.y1)), moving.X(U(pr.x1) - U(pr.x0)), moving.Y(T(pr.y0) - T(pr.y1))), 0.7);
  castMoving(() => moving.ctx.rect(moving.X(0), moving.Y(SPINE_TOP_T), moving.X(RAIL_U * 0.9), moving.Y(T(pr.y1) - SPINE_TOP_T)), 0.6);
  input.shutter.add(shadowPlane(tex(srgbTexture(moving.element))));
  const plate = input.plateRect;
  // ── The shutter's steel: ONE piece, as a real shutter is one folded sheet. An L on the front (the plate and
  // the spine up the left edge), the fold round the left edge through the full depth, and the same L on the back
  // as the leaf over the laser window. The flanges meet the fold with no gap, so no plastic shows between them.
  // Brushed: the grain in the colour and the roughness (the scratches catch the light a little more), and an
  // anisotropic highlight that streaks across the plate the way brushed steel's does. Tiled 3× on the
  // shell-wide UVs, so each hairline is a fraction of a millimetre wide on the cartridge.
  const steelGrain = tex(srgbTexture(brushedSteelMap(), input.anisotropy));
  steelGrain.wrapS = steelGrain.wrapT = RepeatWrapping;
  steelGrain.repeat.set(3, 3);
  // Mid-grey satin, as refs 19 and 33 read: brighter or glossier and the inspector's key light turns it into a
  // white frame round the label (measured: 229 → 164 mean on the label's border).
  const steel = keep(
    new MeshPhysicalMaterial({
      color: input.slideColor ?? '#8b9097',
      map: steelGrain,
      roughnessMap: steelGrain,
      metalness: 0.75,
      roughness: 0.78,
      anisotropy: 0.65,
      anisotropyRotation: 0,
      envMap,
      envMapIntensity: 0.18,
    }),
  );
  const spineTop = Y(SPINE_TOP_T);
  const spineW = RAIL_U * w * 0.9;
  // Thin enough that the front flange's top (with its bevel) stays under the label print at frontZ + 0.0021.
  const sheet = 0.0012;
  const hubLeft = disc.x - BACK_HUB.outer * w - 0.008 * w;
  const flange = (x1: number) => {
    const s = new Shape();
    const x0 = rect.x0;
    const r = 0.004;
    s.moveTo(x0, plate.y0);
    s.lineTo(x1 - r, plate.y0);
    s.quadraticCurveTo(x1, plate.y0, x1, plate.y0 + r);
    s.lineTo(x1, plate.y1 - r);
    s.quadraticCurveTo(x1, plate.y1, x1 - r, plate.y1);
    s.lineTo(x0 + spineW + r, plate.y1);
    s.quadraticCurveTo(x0 + spineW, plate.y1, x0 + spineW, plate.y1 + r);
    s.lineTo(x0 + spineW, spineTop - r);
    s.quadraticCurveTo(x0 + spineW, spineTop, x0 + spineW - r, spineTop);
    s.lineTo(x0, spineTop);
    s.closePath();
    const g = geo(new ExtrudeGeometry(s, { depth: sheet, bevelEnabled: true, bevelThickness: 0.0002, bevelSize: 0.0004, bevelSegments: 2 }));
    shellUv(g, rect);
    return g;
  };
  const frontFlange = new Mesh(flange(plate.x1), steel);
  frontFlange.position.z = input.frontZ + 0.0002;
  // (top: frontZ + 0.0002 + sheet + bevel = frontZ + 0.0016, under the print at + 0.0021)
  // The back leaf stops short of the hub's bezel, so the two never meet as the shutter slides.
  const backFlange = new Mesh(flange(Math.min(plate.x1, hubLeft)), steel);
  backFlange.position.z = input.backZ - 0.0002 - sheet;
  // The fold: a U round the left edge through the full depth, rounded where it turns onto each face.
  const foldDepth = input.frontZ - input.backZ + 0.0004 + 2 * sheet;
  const foldGeometry = geo(new ExtrudeGeometry(roundedRectShape(-sheet, -foldDepth / 2, 0.0002, foldDepth / 2, sheet * 0.9), { depth: spineTop - plate.y0, bevelEnabled: false }));
  const fold = new Mesh(foldGeometry, steel);
  // The profile is drawn in x/z and extruded along y.
  fold.rotation.x = -Math.PI / 2;
  fold.position.set(rect.x0, plate.y0, (input.frontZ + input.backZ) / 2);
  input.shutter.add(frontFlange, backFlange, fold);
  // Two slots punched in the spine.
  const punched = keep(new MeshStandardMaterial({ color: '#15161a', roughness: 0.6 }));
  for (const t of SPINE_SLOTS) {
    const slot = new Mesh(geo(new BoxGeometry(spineW * 0.42, 0.0032, 0.0004)), punched);
    slot.position.set(rect.x0 + spineW * 0.58, Y(t), input.frontZ + 0.0002 + sheet + 0.0004);
    input.shutter.add(slot);
  }

  // ── The shell's slide tracks, front and back: moulded guide rails along the shutter's run (its right edge and
  // the stop at the bottom), so the track reads whether the shutter is up or down. They don't move.
  const trackTop = plate.y1;
  const trackBottom = Y(TONGUE_BOTTOM_T);
  const rails = (right: number, z: number, material: Material) => {
    const side = new Mesh(geo(new BoxGeometry(0.0028, trackTop - trackBottom, 0.0009)), material);
    side.position.set(right + 0.003, (trackTop + trackBottom) / 2, z);
    const stop = new Mesh(geo(new BoxGeometry(right + 0.0044 - (rect.x0 + RAIL_U * w), 0.0028, 0.0009)), material);
    stop.position.set((right + 0.0044 + rect.x0 + RAIL_U * w) / 2, trackBottom - 0.0014, z);
    cartridge.add(side, stop);
  };
  rails(plate.x1, input.frontZ + 0.00045, keep(new MeshPhysicalMaterial({ color: '#ffffff', roughness: 0.2, transparent: true, opacity: 0.16, clearcoat: 0.5, specularIntensity: 0.6, envMap, envMapIntensity: 0.3 })));
  rails(Math.min(plate.x1, hubLeft), input.backZ - 0.00045, keep(new MeshStandardMaterial({ color: frameCol.clone().multiplyScalar(0.55), roughness: 0.45, envMap, envMapIntensity: 0.3 })));

  // The frosted top cover, chamfered at its top right, with the reference-hole lens on it.
  const cover = new Shape();
  cover.moveTo(X(COVER.u0), Y(COVER.t1));
  cover.lineTo(X(COVER.u1), Y(COVER.t1));
  cover.lineTo(X(COVER.u1), Y(COVER.t0 + COVER.chamfer));
  cover.lineTo(X(COVER.u1 - COVER.chamfer), Y(COVER.t0));
  cover.lineTo(X(COVER.u0), Y(COVER.t0));
  cover.closePath();
  const coverTone = frameCol.clone().lerp(new Color('#7f9696'), 0.55).multiplyScalar(0.75);
  const frosted = keep(
    new MeshPhysicalMaterial({
      color: coverTone,
      emissive: coverTone.clone().multiplyScalar(0.1),
      roughness: 0.62,
      transparent: true,
      opacity: 0.72,
      envMap,
      envMapIntensity: 0.25,
    }),
  );
  const coverMesh = new Mesh(geo(new ExtrudeGeometry(cover, { depth: 0.0012, bevelEnabled: false })), frosted);
  coverMesh.position.z = outside;
  coverMesh.renderOrder = 6;
  const coverEdge = new LineLoop(geo(new BufferGeometry().setFromPoints(cover.getPoints())), keep(new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55 })));
  coverEdge.position.z = outside + 0.0013;
  const lensMaterial = keep(new MeshStandardMaterial({ map: tex(srgbTexture(lensMap(input.rail))), roughness: 0.2, envMap, envMapIntensity: 0.6 }));
  const lens = new Mesh(geo(new CylinderGeometry(LENS[2] * w, LENS[2] * w, 0.0016, 48).rotateX(Math.PI / 2)), [
    keep(new MeshStandardMaterial({ color: new Color(input.rail).multiplyScalar(0.7), roughness: 0.3 })),
    lensMaterial,
    lensMaterial,
  ]);
  lens.position.set(X(LENS[0]), Y(LENS[1]), outside + 0.0014);
  const lensRing = new Mesh(geo(new TorusGeometry(LENS[2] * w * 1.02, 0.0009, 8, 48)), keep(new MeshStandardMaterial({ color: '#ffffff', roughness: 0.3, transparent: true, opacity: 0.7 })));
  lensRing.position.set(X(LENS[0]), Y(LENS[1]), outside + 0.0022);
  cartridge.add(coverMesh, coverEdge, lens, lensRing);

  // The clear tongue below the plate: near-invisible film with bright edges, the rounded corner bottom right.
  const tongue = new Shape();
  const tx0 = X(RAIL_U);
  const tx1 = plate.x1;
  // The whole run the plate slides on, so once the plate is down the vacated part reads as the same track.
  const ty1 = plate.y1 - 0.001;
  const ty0 = Y(TONGUE_BOTTOM_T);
  const tr = 0.022 * w;
  tongue.moveTo(tx0, ty1);
  tongue.lineTo(tx1, ty1);
  tongue.lineTo(tx1, ty0 + tr);
  tongue.quadraticCurveTo(tx1, ty0, tx1 - tr, ty0);
  tongue.lineTo(tx0, ty0);
  tongue.closePath();
  const film = keep(
    new MeshPhysicalMaterial({
      color: '#ffffff',
      roughness: 0.12,
      transparent: true,
      // Near invisible, as the references' clear track is: only its edges catch the light. Any more and it
      // reads as a milky panel over the disc.
      opacity: 0.02,
      clearcoat: 0.1,
      envMap,
      envMapIntensity: 0.08,
      side: DoubleSide,
      depthWrite: false,
    }),
  );
  const tongueMesh = new Mesh(geo(new ExtrudeGeometry(tongue, { depth: 0.0008, bevelEnabled: false, curveSegments: 12 })), film);
  tongueMesh.position.z = outside;
  tongueMesh.renderOrder = 7;
  const tongueEdge = new LineLoop(geo(new BufferGeometry().setFromPoints(tongue.getPoints(12))), keep(new LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.28 })));
  tongueEdge.position.z = outside + 0.0009;
  tongueEdge.renderOrder = 8;
  cartridge.add(tongueMesh, tongueEdge);
}

/**
 * The outline of a box and a circle whose centre is inside it, as one closed path: from the centre every ray leaves
 * the union at the farther of the two boundaries (the union is star shaped about that centre). The box's corners
 * are kept exact.
 */
function boxAndCircle(box: { x0: number; y0: number; x1: number; y1: number }, cx: number, cy: number, r: number): Path {
  const toBox = (angle: number) => {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);
    const tx = dx > 0 ? (box.x1 - cx) / dx : dx < 0 ? (box.x0 - cx) / dx : Infinity;
    const ty = dy > 0 ? (box.y1 - cy) / dy : dy < 0 ? (box.y0 - cy) / dy : Infinity;
    return Math.min(tx, ty);
  };
  const angles: number[] = [];
  for (let i = 0; i < 96; i++) angles.push((i / 96) * Math.PI * 2);
  for (const [x, y] of [[box.x0, box.y0], [box.x1, box.y0], [box.x1, box.y1], [box.x0, box.y1]]) {
    const angle = Math.atan2(y - cy, x - cx);
    angles.push(angle < 0 ? angle + Math.PI * 2 : angle);
  }
  angles.sort((a, b) => a - b);
  const points = angles.map((angle) => {
    const d = Math.max(r, toBox(angle));
    return new Vector2(cx + Math.cos(angle) * d, cy + Math.sin(angle) * d);
  });
  const path = new Path();
  path.setFromPoints(points);
  path.closePath();
  return path;
}

import {
  AdditiveBlending,
  CanvasTexture,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  SRGBColorSpace,
  type Texture,
} from 'three';
import { GLYPHS, LCD_CHARS, SEGMENT, type LcdContent } from './lcd-text';

/**
 * The deck's calculator-style display: amber 14-segment characters behind glass, set into a recess in the front
 * cover. Unlit segments stay faintly visible, like a real LED display. Drawn to a canvas only when the content
 * changes.
 */

export interface LcdRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const LIT = '#ffb21f';
const GHOST = 'rgba(255, 170, 40, 0.1)';
const CANVAS_WIDTH = 1024;
/** Italic lean of the characters, as on calculator displays. */
const SLANT = 0.12;

type Point = [number, number];

export class DeckLcd {
  readonly group = new Group();
  private readonly canvas = document.createElement('canvas');
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: CanvasTexture;
  private shown = '';

  constructor(rect: LcdRect, options: { z: number; environment: Texture | null }) {
    const width = rect.x1 - rect.x0;
    const height = rect.y1 - rect.y0;
    this.canvas.width = CANVAS_WIDTH;
    this.canvas.height = Math.round((CANVAS_WIDTH * height) / width);
    this.ctx = this.canvas.getContext('2d')!;
    this.texture = new CanvasTexture(this.canvas);
    this.texture.colorSpace = SRGBColorSpace;
    this.texture.anisotropy = 4;

    const cx = (rect.x0 + rect.x1) / 2;
    const cy = (rect.y0 + rect.y1) / 2;
    const screen = new Mesh(new PlaneGeometry(width, height), new MeshBasicMaterial({ map: this.texture, toneMapped: false }));
    screen.position.set(cx, cy, options.z);
    // Glass over the recess: adds only the environment's reflection, so the segments stay crisp.
    const glass = new Mesh(
      new PlaneGeometry(width, height),
      new MeshStandardMaterial({
        color: '#000000',
        roughness: 0.08,
        metalness: 0,
        envMap: options.environment,
        envMapIntensity: 1.2,
        transparent: true,
        blending: AdditiveBlending,
        depthWrite: false,
      }),
    );
    glass.position.set(cx, cy, options.z + 0.004);
    glass.renderOrder = 5;
    this.group.add(screen, glass);
    this.set({ text: '', play: false, pause: false, stop: false, repeat: false });
  }

  set(content: LcdContent): void {
    const key = `${content.text}|${+content.play}${+content.pause}${+content.stop}${+content.repeat}`;
    if (key === this.shown) return;
    this.shown = key;
    this.draw(content);
    this.texture.needsUpdate = true;
  }

  private draw(content: LcdContent): void {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;

    // Bezel, then the dark window with a faint warm wash.
    ctx.fillStyle = '#060607';
    ctx.fillRect(0, 0, W, H);
    const inset = H * 0.07;
    const wash = ctx.createLinearGradient(0, inset, 0, H - inset);
    wash.addColorStop(0, '#120c07');
    wash.addColorStop(1, '#070504');
    ctx.fillStyle = wash;
    roundRect(ctx, inset, inset, W - inset * 2, H - inset * 2, H * 0.06);
    ctx.fill();

    const padX = W * 0.055;
    const advance = (W - padX * 2) / LCD_CHARS;
    const cw = advance * 0.74;
    const ch = cw / 0.56;
    const baseline = H - inset - H * 0.14;
    const top = baseline - ch;

    // Mode flags above the characters: play, pause, stop, repeat.
    const flagSize = Math.min(H * 0.16, top - inset - H * 0.08);
    const flagY = inset + H * 0.08;
    const flags: [boolean, (x: number) => Point[][]][] = [
      [content.play, (x) => [[[x, flagY], [x + flagSize * 0.9, flagY + flagSize / 2], [x, flagY + flagSize]]]],
      [
        content.pause,
        (x) => [
          box(x, flagY, flagSize * 0.3, flagSize),
          box(x + flagSize * 0.55, flagY, flagSize * 0.3, flagSize),
        ],
      ],
      [content.stop, (x) => [box(x, flagY, flagSize * 0.9, flagSize)]],
      [content.repeat, (x) => repeatIcon(x, flagY, flagSize)],
    ];
    flags.forEach(([lit, shape], index) => {
      const polygons = shape(padX + index * flagSize * 1.9);
      for (const polygon of polygons) fillPolygon(ctx, polygon, lit);
    });

    const text = content.text.toUpperCase().padEnd(LCD_CHARS).slice(0, LCD_CHARS);
    for (let index = 0; index < LCD_CHARS; index++) {
      const bits = GLYPHS[text[index]] ?? 0;
      const x = padX + index * advance + (advance - cw) / 2;
      for (const [name, polygon] of segmentPolygons(x, top, cw, ch)) {
        fillPolygon(ctx, polygon, Boolean(bits & SEGMENT[name]));
      }
    }
  }
}

function fillPolygon(ctx: CanvasRenderingContext2D, points: Point[], lit: boolean): void {
  ctx.beginPath();
  points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  if (lit) {
    ctx.save();
    ctx.shadowColor = 'rgba(255, 160, 20, 0.9)';
    ctx.shadowBlur = ctx.canvas.height * 0.045;
    ctx.fillStyle = LIT;
    ctx.fill();
    ctx.restore();
  } else {
    ctx.fillStyle = GHOST;
    ctx.fill();
  }
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

const box = (x: number, y: number, w: number, h: number): Point[] => [
  [x, y],
  [x + w, y],
  [x + w, y + h],
  [x, y + h],
];

function repeatIcon(x: number, y: number, size: number): Point[][] {
  // A ring with a gap and an arrowhead.
  const cx = x + size / 2;
  const cy = y + size / 2;
  const outer = size / 2;
  const inner = outer * 0.62;
  const ring: Point[] = [];
  const from = -Math.PI * 0.35;
  const to = Math.PI * 1.35;
  for (let i = 0; i <= 18; i++) {
    const a = from + ((to - from) * i) / 18;
    ring.push([cx + Math.cos(a) * outer, cy + Math.sin(a) * outer]);
  }
  for (let i = 18; i >= 0; i--) {
    const a = from + ((to - from) * i) / 18;
    ring.push([cx + Math.cos(a) * inner, cy + Math.sin(a) * inner]);
  }
  const tipAngle = from;
  const mid = (outer + inner) / 2;
  const base: Point = [cx + Math.cos(tipAngle) * mid, cy + Math.sin(tipAngle) * mid];
  const arrow: Point[] = [
    [base[0] - size * 0.26, base[1] - size * 0.04],
    [base[0] + size * 0.2, base[1] - size * 0.2],
    [base[0] + size * 0.02, base[1] + size * 0.26],
  ];
  return [ring, arrow];
}

/** One character's 14 segments as slanted polygons, in canvas pixels. */
function segmentPolygons(x: number, y: number, cw: number, ch: number): [keyof typeof SEGMENT, Point[]][] {
  const t = cw * 0.15;
  const g = t * 0.32;
  const left = t / 2;
  const right = cw - t / 2;
  const centre = cw / 2;
  const topY = t / 2;
  const mid = ch / 2;
  const bottom = ch - t / 2;

  const horizontal = (x1: number, x2: number, yy: number): Point[] => [
    [x1, yy],
    [x1 + t / 2, yy - t / 2],
    [x2 - t / 2, yy - t / 2],
    [x2, yy],
    [x2 - t / 2, yy + t / 2],
    [x1 + t / 2, yy + t / 2],
  ];
  const vertical = (xx: number, y1: number, y2: number): Point[] => [
    [xx, y1],
    [xx + t / 2, y1 + t / 2],
    [xx + t / 2, y2 - t / 2],
    [xx, y2],
    [xx - t / 2, y2 - t / 2],
    [xx - t / 2, y1 + t / 2],
  ];
  const diagonal = (x1: number, y1: number, x2: number, y2: number): Point[] => {
    const length = Math.hypot(x2 - x1, y2 - y1);
    const nx = (-(y2 - y1) / length) * t * 0.42;
    const ny = ((x2 - x1) / length) * t * 0.42;
    return [
      [x1 + nx, y1 + ny],
      [x2 + nx, y2 + ny],
      [x2 - nx, y2 - ny],
      [x1 - nx, y1 - ny],
    ];
  };
  const d = t * 0.72;
  const segments: [keyof typeof SEGMENT, Point[]][] = [
    ['a', horizontal(left + g, right - g, topY)],
    ['d', horizontal(left + g, right - g, bottom)],
    ['g1', horizontal(left + g, centre - g, mid)],
    ['g2', horizontal(centre + g, right - g, mid)],
    ['f', vertical(left, topY + g, mid - g)],
    ['e', vertical(left, mid + g, bottom - g)],
    ['b', vertical(right, topY + g, mid - g)],
    ['c', vertical(right, mid + g, bottom - g)],
    ['i', vertical(centre, topY + g, mid - g)],
    ['l', vertical(centre, mid + g, bottom - g)],
    ['h', diagonal(left + d, topY + d, centre - d * 0.5, mid - d * 0.5)],
    ['j', diagonal(right - d, topY + d, centre + d * 0.5, mid - d * 0.5)],
    ['k', diagonal(centre - d * 0.5, mid + d * 0.5, left + d, bottom - d)],
    ['m', diagonal(centre + d * 0.5, mid + d * 0.5, right - d, bottom - d)],
  ];
  // Into place, leaning right.
  return segments.map(([name, points]) => [name, points.map(([px, py]) => [x + px + (ch - py) * SLANT, y + py] as Point)]);
}

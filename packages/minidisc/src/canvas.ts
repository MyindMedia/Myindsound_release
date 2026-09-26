/**
 * Canvas helpers shared by the prints: brand font stacks, cover-fit drawing, height → normal conversion,
 * brushed metal, barcodes and a seeded PRNG so a design always renders the same.
 */
import { CanvasTexture, NoColorSpace, RepeatWrapping, SRGBColorSpace } from 'three';

export const INTER = "'Inter', -apple-system, 'Helvetica Neue', Arial, sans-serif";
export const MONO = "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace";

export type ArtSource = HTMLImageElement | HTMLCanvasElement | ImageBitmap | OffscreenCanvas;

export function canvas(width: number, height = width): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas');
  element.width = Math.max(1, Math.round(width));
  element.height = Math.max(1, Math.round(height));
  const ctx = element.getContext('2d');
  if (!ctx) throw new Error('2D canvas unavailable');
  return [element, ctx];
}

/** Waits for the brand fonts, when the page declares them (the bundles' fonts.css). Resolves at once otherwise. */
export async function ensureFonts(): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return;
  await Promise.all(
    [`800 32px 'Inter'`, `600 32px 'Inter'`, `500 32px 'Inter'`, `700 32px 'JetBrains Mono'`, `600 32px 'JetBrains Mono'`, `500 32px 'JetBrains Mono'`].map((f) =>
      fonts.load(f).catch(() => []),
    ),
  );
}

export function sourceSize(source: ArtSource): { width: number; height: number } {
  if (source instanceof HTMLImageElement) return { width: source.naturalWidth || source.width, height: source.naturalHeight || source.height };
  return { width: source.width, height: source.height };
}

/** Draws `source` to fill the rectangle without stretching (CSS `cover`). */
export function drawCover(ctx: CanvasRenderingContext2D, source: ArtSource, x: number, y: number, w: number, h: number): void {
  const { width, height } = sourceSize(source);
  if (!width || !height) return;
  const scale = Math.max(w / width, h / height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(source, (width - sw) / 2, (height - sh) / 2, sw, sh, x, y, w, h);
}

/** A tiny seeded PRNG (xorshift32): the same design always draws the same grain, specks and bars. */
export function prng(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

export function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function srgbTexture(source: HTMLCanvasElement, anisotropy = 4): CanvasTexture {
  const texture = new CanvasTexture(source);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

export function dataTexture(source: HTMLCanvasElement, anisotropy = 4): CanvasTexture {
  const texture = new CanvasTexture(source);
  texture.colorSpace = NoColorSpace;
  texture.anisotropy = anisotropy;
  return texture;
}

/** Tangent-space normals from a grayscale height canvas (+x right, +y up), as cartridge-detail.ts does it. */
export function heightToNormal(source: HTMLCanvasElement, strength: number, wrap = false): CanvasTexture {
  const w = source.width;
  const h = source.height;
  const height = source.getContext('2d')!.getImageData(0, 0, w, h).data;
  const [target, ctx] = canvas(w, h);
  const out = ctx.createImageData(w, h);
  const at = (x: number, y: number) => height[(((y + h) % h) * w + ((x + w) % w)) * 4] / 255;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
      const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
      const length = Math.hypot(dx, dy, 1);
      const i = (y * w + x) * 4;
      out.data[i] = (-dx / length) * 127.5 + 127.5;
      out.data[i + 1] = (dy / length) * 127.5 + 127.5;
      out.data[i + 2] = (1 / length) * 127.5 + 127.5;
      out.data[i + 3] = 255;
    }
  }
  ctx.putImageData(out, 0, 0);
  const texture = dataTexture(target);
  if (wrap) texture.wrapS = texture.wrapT = RepeatWrapping;
  return texture;
}

/** Brushed steel: the colour (long horizontal streaks) and the height the streaks make, for a normal map. */
export function brushedMetal(width: number, height: number, seed: number, tone = '#c9ccd2'): { map: HTMLCanvasElement; normal: CanvasTexture } {
  const random = prng(seed);
  const [map, ctx] = canvas(width, height);
  const base = ctx.createLinearGradient(0, 0, width, height);
  base.addColorStop(0, '#f1f2f4');
  base.addColorStop(0.35, tone);
  base.addColorStop(0.62, '#e7e9ec');
  base.addColorStop(1, '#9ea3ab');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, width, height);
  const [heightMap, hctx] = canvas(width, height);
  hctx.fillStyle = '#808080';
  hctx.fillRect(0, 0, width, height);
  const streaks = Math.round(height * 1.6);
  for (let i = 0; i < streaks; i++) {
    const y = random() * height;
    const alpha = 0.03 + random() * 0.08;
    const light = random() < 0.5;
    ctx.strokeStyle = light ? `rgba(255,255,255,${alpha})` : `rgba(0,0,0,${alpha})`;
    ctx.lineWidth = 0.5 + random() * 1.2;
    ctx.beginPath();
    ctx.moveTo(-4, y);
    ctx.lineTo(width + 4, y + (random() - 0.5) * 2);
    ctx.stroke();
    hctx.strokeStyle = light ? `rgba(255,255,255,${alpha * 2})` : `rgba(0,0,0,${alpha * 2})`;
    hctx.lineWidth = ctx.lineWidth;
    hctx.beginPath();
    hctx.moveTo(-4, y);
    hctx.lineTo(width + 4, y);
    hctx.stroke();
  }
  return { map, normal: heightToNormal(heightMap, 1.4) };
}

/** A barcode-style strip (not a real symbology) with its digits under it. */
export function barcode(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, seed: number, ink = '#111116', paper = '#f4f0e6'): void {
  const random = prng(seed);
  ctx.fillStyle = paper;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = ink;
  const pad = w * 0.05;
  const barsTop = y + h * 0.1;
  const barsH = h * 0.62;
  let cursor = x + pad;
  const unit = (w - pad * 2) / 95;
  while (cursor < x + w - pad - unit) {
    const width = unit * (1 + Math.floor(random() * 3));
    ctx.fillRect(cursor, barsTop, width, barsH);
    cursor += width + unit * (1 + Math.floor(random() * 2));
  }
  const digits = Array.from({ length: 12 }, () => Math.floor(random() * 10)).join('');
  ctx.font = `500 ${Math.round(h * 0.2)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText(`${digits.slice(0, 1)} ${digits.slice(1, 6)} ${digits.slice(6, 11)} ${digits.slice(11)}`, x + w / 2, y + h * 0.93);
  ctx.textAlign = 'left';
}

/** Film grain over a canvas, in place. */
export function grain(ctx: CanvasRenderingContext2D, amount: number, seed: number): void {
  const { width, height } = ctx.canvas;
  const image = ctx.getImageData(0, 0, width, height);
  const random = prng(seed);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const noise = (random() - 0.5) * amount;
    data[i] += noise;
    data[i + 1] += noise;
    data[i + 2] += noise;
  }
  ctx.putImageData(image, 0, 0);
}

/** `#RRGGBB` → `rgba(r, g, b, a)`. */
export function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1, 7), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Relative luminance of `#RRGGBB`, for picking ink that reads on a fill. */
export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1, 7), 16);
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

/** Fits `text` in `maxWidth` by shrinking the font size from `size`, never below `min`. */
export function fitFont(ctx: CanvasRenderingContext2D, text: string, weight: number, family: string, size: number, maxWidth: number, min = 8): number {
  let px = size;
  while (px > min) {
    ctx.font = `${weight} ${px}px ${family}`;
    if (ctx.measureText(text).width <= maxWidth) break;
    px = Math.floor(px * 0.92);
  }
  ctx.font = `${weight} ${px}px ${family}`;
  return px;
}

/**
 * Cover art → shell preset. `dominantColours` is a median cut over the art's pixels (downscaled first, in the
 * browser); `suggestShellFromPixels` maps the result to the closest catalogue shell. Pure, so `npm test`
 * exercises the mapping with synthetic swatches; `suggestShell` is the browser wrapper.
 */
import type { ShellPresetId } from './design';

export interface Swatch {
  r: number;
  g: number;
  b: number;
  /** Fraction of the sampled pixels in this bucket, 0..1. */
  weight: number;
}

export interface ShellSuggestion {
  shell: ShellPresetId;
  /** For hues the presets don't cover (greens, cyans, oranges): the clear shell, tinted this colour. */
  tint?: string;
  /** The key colour the choice was made on. */
  key: Swatch;
  swatches: Swatch[];
}

type Pixel = [number, number, number];
type Channel = 0 | 1 | 2;

/** Median cut: split the pixel cloud on its widest channel until there are `count` buckets. */
export function dominantColours(data: ArrayLike<number>, count = 5, step = 1): Swatch[] {
  const pixels: Pixel[] = [];
  const stride = 4 * Math.max(1, Math.floor(step));
  for (let i = 0; i + 3 < data.length; i += stride) {
    if (data[i + 3] < 128) continue; // transparent pixels are not colour
    pixels.push([data[i], data[i + 1], data[i + 2]]);
  }
  if (pixels.length === 0) return [];
  const buckets: Pixel[][] = [pixels];
  while (buckets.length < count) {
    let widest = -1;
    let widestRange = -1;
    let widestChannel: Channel = 0;
    buckets.forEach((bucket, index) => {
      if (bucket.length < 2) return;
      for (const channel of [0, 1, 2] as const) {
        let min = 255;
        let max = 0;
        for (const p of bucket) {
          if (p[channel] < min) min = p[channel];
          if (p[channel] > max) max = p[channel];
        }
        const range = max - min;
        if (range > widestRange) {
          widestRange = range;
          widest = index;
          widestChannel = channel;
        }
      }
    });
    if (widest < 0 || widestRange < 8) break;
    const bucket = buckets[widest];
    bucket.sort((a, b) => a[widestChannel] - b[widestChannel]);
    const half = bucket.length >> 1;
    buckets.splice(widest, 1, bucket.slice(0, half), bucket.slice(half));
  }
  const total = pixels.length;
  const swatches = buckets
    .map((bucket) => {
      let r = 0;
      let g = 0;
      let b = 0;
      for (const p of bucket) {
        r += p[0];
        g += p[1];
        b += p[2];
      }
      const n = bucket.length || 1;
      return { r: Math.round(r / n), g: Math.round(g / n), b: Math.round(b / n), weight: bucket.length / total };
    })
    .sort((a, b) => b.weight - a.weight);
  return mergeAlike(swatches);
}

/** Median cut splits by count, so a flat colour can land in two buckets: fold near-identical swatches together. */
function mergeAlike(swatches: Swatch[], tolerance = 24): Swatch[] {
  const merged: Swatch[] = [];
  for (const swatch of swatches) {
    const near = merged.find((m) => Math.hypot(m.r - swatch.r, m.g - swatch.g, m.b - swatch.b) < tolerance);
    if (!near) {
      merged.push({ ...swatch });
      continue;
    }
    const total = near.weight + swatch.weight;
    near.r = Math.round((near.r * near.weight + swatch.r * swatch.weight) / total);
    near.g = Math.round((near.g * near.weight + swatch.g * swatch.weight) / total);
    near.b = Math.round((near.b * near.weight + swatch.b * swatch.weight) / total);
    near.weight = total;
  }
  return merged.sort((a, b) => b.weight - a.weight);
}

/** HSV saturation (chroma over the brightest channel): honest near white, where HSL saturation blows up. */
export function chroma(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

/** Below this the art reads as monochrome and the shell goes by lightness alone. */
const GREY_SATURATION = 0.2;
/** Below this spread (0..255) a colour is grey however the ratios fall (near black, every ratio is noise). */
const GREY_SPREAD = 28;

/** Whether a colour has a hue worth answering. */
export function isSaturated(r: number, g: number, b: number, minChroma = GREY_SATURATION): boolean {
  return chroma(r, g, b) >= minChroma && Math.max(r, g, b) - Math.min(r, g, b) >= GREY_SPREAD;
}

/** Hue 0..360, saturation and lightness 0..1 (HSL). */
export function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-6) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h = (h * 60 + 360) % 360;
  return { h, s, l };
}

export function toHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`.toUpperCase();
}

/** A saturated swatch this big (fraction of pixels) outranks a bigger grey one. */
const KEY_MIN_WEIGHT = 0.08;
const KEY_MIN_SATURATION = 0.25;

/** The colour the shell should answer: the biggest saturated swatch, or the biggest swatch when the art is grey. */
export function keyColour(swatches: Swatch[]): Swatch {
  let best: { swatch: Swatch; score: number } | null = null;
  for (const swatch of swatches) {
    if (swatch.weight < KEY_MIN_WEIGHT) continue;
    const { l } = rgbToHsl(swatch.r, swatch.g, swatch.b);
    const s = chroma(swatch.r, swatch.g, swatch.b);
    if (!isSaturated(swatch.r, swatch.g, swatch.b, KEY_MIN_SATURATION)) continue;
    // Chroma weighted by coverage; very dark or very light swatches read as grey however saturated.
    const usable = 1 - Math.abs(2 * l - 1);
    const score = swatch.weight * s * (0.35 + 0.65 * usable);
    if (!best || score > best.score) best = { swatch, score };
  }
  return best?.swatch ?? swatches[0];
}

/** Maps a key colour to the nearest catalogue shell. */
export function shellForColour(r: number, g: number, b: number): { shell: ShellPresetId; tint?: string } {
  const { h, l } = rgbToHsl(r, g, b);
  const s = chroma(r, g, b);
  if (!isSaturated(r, g, b)) return l > 0.7 ? { shell: 'clear' } : { shell: 'smoke-black' };
  if (h >= 345 || h < 20) return { shell: 'red' };
  if (h < 50) return l > 0.4 && s > 0.45 ? { shell: 'smoke-gold' } : { shell: 'red' };
  if (h < 72) return { shell: 'smoke-gold' };
  if (h < 195) return { shell: 'clear', tint: toHex(r, g, b) };
  if (h < 262) return { shell: 'blue' };
  if (h < 300) return { shell: 'purple' };
  return { shell: 'clear-pink' };
}

/** RGBA pixels (as from `ImageData.data`) → shell suggestion. */
export function suggestShellFromPixels(data: ArrayLike<number>, step = 1): ShellSuggestion {
  const swatches = dominantColours(data, 6, step);
  if (swatches.length === 0) {
    const key = { r: 20, g: 20, b: 24, weight: 1 };
    return { shell: 'smoke-black', key, swatches: [key] };
  }
  const key = keyColour(swatches);
  return { ...shellForColour(key.r, key.g, key.b), key, swatches };
}

/** Browser: downscales the art to a small canvas and suggests a shell for it. */
export function suggestShell(image: CanvasImageSource & { width?: number; height?: number }, sample = 64): ShellSuggestion {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = sample;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');
  ctx.drawImage(image, 0, 0, sample, sample);
  return suggestShellFromPixels(ctx.getImageData(0, 0, sample, sample).data);
}

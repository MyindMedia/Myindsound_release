/**
 * Everything printed, embossed or stuck on a generated release: the disc face, the label plate, the stickers,
 * the shell's moulding (as a normal map), the inner chassis seen through clear shells, the sleeve's back and
 * spines, and the edition stamp. All canvases, all seeded from the design, so a release always looks the same.
 */
import type { CanvasTexture } from 'three';
import {
  INTER,
  MONO,
  barcode,
  brushedMetal,
  canvas,
  drawCover,
  fitFont,
  grain,
  hashString,
  heightToNormal,
  luminance,
  prng,
  rgba,
  type ArtSource,
} from './canvas';
import { catalogueNumber, formatDuration, resolveTheme, type DiscDesign, type DiscFinish, type DiscSticker } from './design';

const INK = '#07070C';
const CREAM = '#F5F1E6';

/** The shell's own size ratio (LIT geometry: 0.839 wide, 0.820 high). */
export const SHELL_ASPECT = 0.83919 / 0.8202;

/**
 * The disc's face: the art in a circle, the hub opening cut out, a faint pressed rim. `gold` and `silver`
 * lay the art over a metallic base so the metal disc material (cartridge.ts) reads it as its own tint.
 */
export function discPrint(art: ArtSource, finish: DiscFinish, holeRatio: number, size: number, seed: number): HTMLCanvasElement {
  const [element, ctx] = canvas(size);
  const c = size / 2;
  const r = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(c, c, r, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (finish === 'print') {
    drawCover(ctx, art, 0, 0, size, size);
  } else {
    const metal = ctx.createLinearGradient(0, 0, size, size);
    if (finish === 'gold') {
      metal.addColorStop(0, '#f6dc8a');
      metal.addColorStop(0.45, '#c9962a');
      metal.addColorStop(0.55, '#f1cf6a');
      metal.addColorStop(1, '#7d5a12');
    } else {
      metal.addColorStop(0, '#f2f3f5');
      metal.addColorStop(0.45, '#a9adb5');
      metal.addColorStop(0.55, '#e4e6ea');
      metal.addColorStop(1, '#6f747d');
    }
    ctx.fillStyle = metal;
    ctx.fillRect(0, 0, size, size);
    ctx.globalAlpha = 0.72;
    ctx.globalCompositeOperation = 'multiply';
    drawCover(ctx, art, 0, 0, size, size);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    // Pressed rings.
    const random = prng(seed);
    for (let radius = r * 0.3; radius < r; radius += 1.5) {
      ctx.strokeStyle = `rgba(${random() < 0.5 ? '255,255,255' : '0,0,0'}, ${0.02 + random() * 0.05})`;
      ctx.beginPath();
      ctx.arc(c, c, radius, 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  // Soft rim: the art fades a touch where the disc's edge is pressed.
  const rim = ctx.createRadialGradient(c, c, r * 0.9, c, c, r);
  rim.addColorStop(0, 'rgba(0,0,0,0)');
  rim.addColorStop(1, 'rgba(0,0,0,0.35)');
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();
  // The hub opening.
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(c, c, r * holeRatio, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
  return element;
}

/** The plate's proportions (label plate: about 2.6:1, like the references' shutter plates). */
export const PLATE_ASPECT = 2.4;

export interface PlatePrint {
  map: HTMLCanvasElement;
  normal: CanvasTexture | null;
  /** The plate's ink for the edition stamp. */
  stampInk: string;
}

/** The metal shutter plate (02, 03) or the paper sticker plate (04, 06, 09, 10), with the label text. */
export function platePrint(design: DiscDesign, width: number): PlatePrint {
  const height = Math.round(width / PLATE_ASPECT);
  const theme = resolveTheme(design);
  const seed = hashString(`${design.slug}:plate`);
  const lines = (design.labelText ?? `${design.title}\n${design.artist}`).split('\n').map((l) => l.trim()).filter(Boolean);
  const metal = design.labelStyle === 'metal';

  let map: HTMLCanvasElement;
  let normal: CanvasTexture | null = null;
  let ink: string;
  if (metal) {
    const brushed = brushedMetal(width, height, seed);
    map = brushed.map;
    normal = brushed.normal;
    ink = '#14141a';
  } else {
    const [element, ctx] = canvas(width, height);
    const fill = theme.accent;
    ctx.fillStyle = fill;
    ctx.fillRect(0, 0, width, height);
    // Paper sticker: a lighter band along the top, print misregistration at the edge.
    const sheen = ctx.createLinearGradient(0, 0, 0, height);
    sheen.addColorStop(0, 'rgba(255,255,255,0.14)');
    sheen.addColorStop(0.5, 'rgba(255,255,255,0)');
    sheen.addColorStop(1, 'rgba(0,0,0,0.12)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, width, height);
    ink = luminance(fill) > 0.35 ? INK : CREAM;
    map = element;
    grain(ctx, 14, seed);
  }
  const ctx = map.getContext('2d')!;
  const pad = width * 0.06;
  ctx.fillStyle = ink;
  ctx.textBaseline = 'alphabetic';
  // Line 1: the title, heavy. Line 2: the artist, mono. Extra lines: small mono.
  const title = lines[0] ?? design.title;
  const titleSize = fitFont(ctx, title.toUpperCase(), 800, INTER, height * 0.34, width - pad * 2);
  ctx.fillText(title.toUpperCase(), pad, height * 0.46);
  ctx.font = `600 ${Math.round(height * 0.13)}px ${MONO}`;
  ctx.fillStyle = rgba(ink, 0.85);
  const second = (lines[1] ?? design.artist).toUpperCase();
  ctx.fillText(second, pad, height * 0.46 + titleSize * 0.62);
  ctx.font = `500 ${Math.round(height * 0.095)}px ${MONO}`;
  ctx.fillStyle = rgba(ink, 0.6);
  const foot = lines.slice(2).join('  ·  ') || `MD ${String(design.tracks.length).padStart(2, '0')} · DIGITAL AUDIO · ${design.year}`;
  ctx.fillText(foot.toUpperCase(), pad, height * 0.87);
  // A hairline frame, as a printed plate has.
  ctx.strokeStyle = rgba(ink, metal ? 0.35 : 0.28);
  ctx.lineWidth = Math.max(1, width * 0.004);
  ctx.strokeRect(pad * 0.45, pad * 0.45, width - pad * 0.9, height - pad * 0.9);
  return { map, normal, stampInk: metal ? ink : '#a8102c' };
}

/** Wording is descriptive, not a trademark: the black-and-white parental-style box. */
const ADVISORY_LINES = ['ADVISORY', 'EXPLICIT CONTENT'];

/** A sticker, drawn at `width` px; the height follows the kind. */
export function stickerPrint(sticker: DiscSticker, design: DiscDesign, width: number): HTMLCanvasElement {
  const theme = resolveTheme(design);
  if (sticker.kind === 'badge') {
    const [element, ctx] = canvas(width, width);
    const c = width / 2;
    const ring = ctx.createConicGradient(0, c, c);
    for (let i = 0; i <= 6; i++) {
      ring.addColorStop(i / 6, ['#ff7ad9', '#ffe36e', '#7dffb0', '#7dd8ff', '#b78bff', '#ff8d7a', '#ff7ad9'][i]);
    }
    ctx.fillStyle = ring;
    ctx.beginPath();
    ctx.arc(c, c, c, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = sticker.fill ?? INK;
    ctx.beginPath();
    ctx.arc(c, c, c * 0.8, 0, Math.PI * 2);
    ctx.fill();
    const text = (sticker.text ?? design.artist).toUpperCase();
    ctx.fillStyle = sticker.ink ?? theme.accent;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    fitFont(ctx, text, 800, INTER, width * 0.2, width * 1.3);
    ctx.fillText(text, c, c);
    return element;
  }
  const lines = sticker.kind === 'advisory' ? ADVISORY_LINES : (sticker.text ?? design.title).toUpperCase().split('\n');
  const height = Math.round(width * (sticker.kind === 'advisory' ? 0.5 : 0.36));
  const [element, ctx] = canvas(width, height);
  const fill = sticker.fill ?? (sticker.kind === 'advisory' ? '#0b0b0d' : theme.accent2);
  const ink = sticker.ink ?? (luminance(fill) > 0.35 ? INK : CREAM);
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.roundRect(0, 0, width, height, width * 0.03);
  ctx.fill();
  ctx.strokeStyle = rgba(ink, 0.9);
  ctx.lineWidth = Math.max(1.5, width * 0.02);
  ctx.strokeRect(width * 0.04, height * 0.08, width * 0.92, height * 0.84);
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (sticker.kind === 'advisory') {
    fitFont(ctx, lines[0], 800, INTER, height * 0.36, width * 0.8);
    ctx.fillText(lines[0], width / 2, height * 0.36);
    fitFont(ctx, lines[1], 600, MONO, height * 0.17, width * 0.8);
    ctx.fillText(lines[1], width / 2, height * 0.72);
  } else {
    const size = fitFont(ctx, lines[0], 800, INTER, height * 0.42, width * 0.84);
    lines.forEach((line, i) => ctx.fillText(line, width / 2, height / 2 + (i - (lines.length - 1) / 2) * size * 1.1));
  }
  return element;
}

/**
 * The shell's moulding as a height map → normal map: the mould's edge ridge, the shutter's slide groove on the
 * left, the recess the label plate sits in, an embossed "INSERT THIS END" arrow along the top, the vent
 * slots. Screw wells are cut by the detail layer, not drawn here.
 */
export function shellNormal(
  design: DiscDesign,
  plate: { x: number; y: number; w: number; h: number } | null,
  size: number,
  window: { u: number; v: number; ru: number } | null = null,
): CanvasTexture {
  const w = size;
  const h = Math.round(size / SHELL_ASPECT);
  const [height, ctx] = canvas(w, h);
  ctx.fillStyle = '#808080';
  ctx.fillRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  // Edge ridge just inside the rim.
  ctx.strokeStyle = '#8c8c8c';
  ctx.lineWidth = w * 0.006;
  ctx.strokeRect(w * 0.028, h * 0.028, w * 0.944, h * 0.944);
  ctx.strokeStyle = '#747474';
  ctx.lineWidth = w * 0.003;
  ctx.strokeRect(w * 0.036, h * 0.036, w * 0.928, h * 0.928);
  // Shutter slide groove down the left side.
  ctx.fillStyle = '#6e6e6e';
  ctx.fillRect(w * 0.035, h * 0.2, w * 0.012, h * 0.6);
  // The disc window's rim: a fine lip where the clear pane meets the shell.
  if (window) {
    ctx.strokeStyle = '#8e8e8e';
    ctx.lineWidth = w * 0.005;
    ctx.beginPath();
    ctx.ellipse(window.u * w, (1 - window.v) * h, window.ru * w, window.ru * w, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // The plate's recess.
  if (plate) {
    ctx.fillStyle = '#727272';
    ctx.beginPath();
    ctx.roundRect(plate.x * w - w * 0.006, plate.y * h - w * 0.006, plate.w * w + w * 0.012, plate.h * h + w * 0.012, w * 0.014);
    ctx.fill();
  }
  // Embossed arrow and text along the top edge.
  ctx.fillStyle = '#9a9a9a';
  ctx.font = `600 ${Math.round(h * 0.026)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('INSERT THIS END', w * 0.5, h * 0.062);
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.028);
  ctx.lineTo(w * 0.515, h * 0.046);
  ctx.lineTo(w * 0.485, h * 0.046);
  ctx.closePath();
  ctx.fill();
  // The write-protect tab's opening, lower left (cartridge.ts places the tab there).
  ctx.fillStyle = '#666666';
  ctx.fillRect(w * 0.075, h * (1 - 0.105), w * 0.075, h * 0.05);
  // Vent slots bottom right, a mould number bottom left.
  for (let i = 0; i < 4; i++) ctx.fillRect(w * (0.82 + i * 0.03), h * 0.925, w * 0.014, h * 0.04);
  ctx.font = `500 ${Math.round(h * 0.02)}px ${MONO}`;
  ctx.textAlign = 'left';
  ctx.fillText(`MYIND · ${design.year}`, w * 0.17, h * 0.945);
  ctx.filter = 'blur(1px)';
  ctx.drawImage(height, 0, 0);
  ctx.filter = 'none';
  return heightToNormal(height, 2.2);
}

/** The inside of the shell, seen through clear plastic: dark moulded plastic with ribs, bosses and the cavity. */
export function chassisPrint(size: number, discCentre: { u: number; v: number; ru: number }, seed: number): HTMLCanvasElement {
  const w = size;
  const h = Math.round(size / SHELL_ASPECT);
  const [element, ctx] = canvas(w, h);
  ctx.fillStyle = '#14151b';
  ctx.fillRect(0, 0, w, h);
  const random = prng(seed);
  // Ribs radiating from the corners, and a lattice.
  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = w * 0.004;
  for (let i = 1; i < 12; i++) {
    const x = (i / 12) * w;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
    ctx.stroke();
  }
  for (let i = 1; i < 12; i++) {
    const y = (i / 12) * h;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.5)';
  ctx.lineWidth = w * 0.01;
  for (let i = 0; i < 4; i++) {
    const x = i % 2 ? w * 0.9 : w * 0.1;
    const y = i < 2 ? h * 0.1 : h * 0.9;
    ctx.beginPath();
    ctx.arc(x, y, w * 0.05, 0, Math.PI * 2);
    ctx.stroke();
  }
  // The disc cavity: a darker well with a lip.
  const cx = discCentre.u * w;
  const cy = (1 - discCentre.v) * h;
  const r = discCentre.ru * w * 1.03;
  const well = ctx.createRadialGradient(cx, cy, r * 0.9, cx, cy, r);
  well.addColorStop(0, '#0b0c10');
  well.addColorStop(1, '#22242c');
  ctx.fillStyle = well;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  // Speckle, as moulded ABS has.
  for (let i = 0; i < 1400; i++) {
    ctx.fillStyle = `rgba(255,255,255,${0.02 + random() * 0.05})`;
    ctx.fillRect(random() * w, random() * h, 1.5, 1.5);
  }
  return element;
}

/** The sleeve's back: title, artist, tracklist, imprint and a barcode strip, in the brand type. */
export function backCoverPrint(design: DiscDesign, size: number): HTMLCanvasElement {
  const theme = resolveTheme(design);
  const [element, ctx] = canvas(size);
  const seed = hashString(`${design.slug}:back`);
  ctx.fillStyle = '#100d14';
  ctx.fillRect(0, 0, size, size);
  const wash = ctx.createLinearGradient(0, 0, size, size);
  wash.addColorStop(0, rgba(theme.accent, 0.16));
  wash.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, size, size);

  const left = size * 0.1;
  const right = size * 0.9;
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = theme.accent;
  fitFont(ctx, design.title.toUpperCase(), 800, INTER, size * 0.075, right - left);
  ctx.fillText(design.title.toUpperCase(), left, size * 0.15);
  ctx.fillStyle = rgba(CREAM, 0.78);
  ctx.font = `500 ${Math.round(size * 0.024)}px ${MONO}`;
  ctx.fillText(`${design.artist.toUpperCase()}  ·  ${design.year}  ·  MYIND SOUND`, left, size * 0.19);
  ctx.fillStyle = rgba(theme.accent, 0.5);
  ctx.fillRect(left, size * 0.218, right - left, 2);

  const tracks = [...design.tracks].sort((a, b) => a.n - b.n);
  const rows = tracks.length;
  const top = size * 0.27;
  const bottom = size * 0.73;
  const step = Math.min(size * 0.052, (bottom - top) / Math.max(1, rows));
  const rowFont = Math.min(size * 0.026, step * 0.58);
  tracks.forEach((track, index) => {
    const y = top + index * step;
    ctx.fillStyle = theme.accent;
    ctx.font = `700 ${Math.round(rowFont * 0.92)}px ${MONO}`;
    ctx.fillText(String(track.n).padStart(2, '0'), left, y);
    ctx.fillStyle = rgba(CREAM, 0.88);
    const length = formatDuration(track.durationSec);
    ctx.font = `500 ${Math.round(rowFont * 0.85)}px ${MONO}`;
    const lengthWidth = ctx.measureText(length).width;
    ctx.fillStyle = rgba(CREAM, 0.55);
    ctx.fillText(length, right - lengthWidth, y);
    ctx.fillStyle = rgba(CREAM, 0.88);
    fitFont(ctx, track.title.toUpperCase(), 500, INTER, rowFont, right - left - size * 0.07 - lengthWidth - size * 0.03);
    ctx.fillText(track.title.toUpperCase(), left + size * 0.07, y);
    ctx.fillStyle = rgba(CREAM, 0.1);
    ctx.fillRect(left, y + step * 0.28, right - left, 1);
  });

  ctx.fillStyle = rgba(CREAM, 0.48);
  ctx.font = `500 ${Math.round(size * 0.019)}px ${MONO}`;
  ctx.fillText(`MINIDISC · ${rows} TRACK${rows === 1 ? '' : 'S'} · ${catalogueNumber(design)}`, left, size * 0.8);
  ctx.fillText(`© ${design.year} MYIND SOUND. ALL RIGHTS RESERVED.`, left, size * 0.835);
  ctx.fillText('MYINDSOUND.COM', left, size * 0.87);
  barcode(ctx, right - size * 0.24, size * 0.79, size * 0.24, size * 0.1, seed);
  grain(ctx, 10, seed);
  return element;
}

/**
 * A spine: a strip as wide as the sleeve is deep and as tall as the sleeve, reading top to bottom like a book
 * spine. The plane it maps to is `depth` × `height` in world units; the canvas keeps that ratio.
 */
export function spinePrint(design: DiscDesign, depth: number, height: number, side: 'left' | 'right'): HTMLCanvasElement {
  const theme = resolveTheme(design);
  const h = 1024;
  const w = Math.max(48, Math.round((h * depth) / height));
  const [element, ctx] = canvas(w, h);
  ctx.fillStyle = side === 'left' ? theme.accent : '#100d14';
  ctx.fillRect(0, 0, w, h);
  const ink = luminance(side === 'left' ? theme.accent : '#100d14') > 0.35 ? INK : CREAM;
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(Math.PI / 2);
  ctx.fillStyle = ink;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const text = `${design.artist.toUpperCase()}   ·   ${design.title.toUpperCase()}`;
  fitFont(ctx, text, 800, INTER, w * 0.42, h * 0.72);
  ctx.fillText(text, 0, 0);
  ctx.font = `600 ${Math.round(w * 0.22)}px ${MONO}`;
  ctx.fillStyle = rgba(ink, 0.7);
  ctx.textAlign = 'left';
  ctx.fillText(catalogueNumber(design), h * 0.38, 0);
  ctx.textAlign = 'right';
  ctx.fillText(String(design.year), -h * 0.38, 0);
  ctx.restore();
  return element;
}

/** The edition stamp: `No. 0007`, rubber-stamped, with ink specks that are the same for the same edition. */
export function stampPrint(edition: number, ink: string, width = 512, height = 224): HTMLCanvasElement {
  const [element, ctx] = canvas(width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((-2.5 * Math.PI) / 180);
  ctx.globalAlpha = 0.88;
  ctx.strokeStyle = ink;
  ctx.fillStyle = ink;
  const boxW = width * 0.92;
  const boxH = height * 0.78;
  ctx.lineWidth = height * 0.06;
  ctx.beginPath();
  ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, height * 0.12);
  ctx.stroke();
  ctx.font = `700 ${Math.round(height * 0.5)}px ${MONO}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`No. ${String(Math.max(0, Math.trunc(edition))).padStart(4, '0')}`, 0, height * 0.03, boxW * 0.9);
  ctx.restore();
  const random = prng(edition * 2654435761);
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = 0.25 + random() * 0.6;
    ctx.beginPath();
    ctx.arc(random() * width, random() * height, 0.6 + random() * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  return element;
}

/**
 * Sprite sheet packing for the pre-rendered spin loops (Grilled.md: "pre-rendered spin loops made at publish
 * time"). Pure maths, unit-tested; `spin-loop.ts` draws into the layout this returns.
 */

export interface SpriteLayout {
  frames: number;
  cols: number;
  rows: number;
  frameW: number;
  frameH: number;
  sheetW: number;
  sheetH: number;
}

/** Metadata stored next to the sheet, so any client can play it back. */
export interface SpriteSheetMeta extends SpriteLayout {
  fps: number;
  /** `image/webp` or `image/png`. */
  format: string;
}

/** The largest texture a phone GPU or UIImage is happy with. */
export const MAX_SHEET_SIDE = 4096;

/**
 * Lays `frames` cells of `frameW` × `frameH` out row by row, as close to square as the frame shape allows, and
 * never wider or taller than `maxSide`. Throws when they cannot fit: the caller renders smaller frames.
 */
export function packSprites(frames: number, frameW: number, frameH: number, maxSide = MAX_SHEET_SIDE): SpriteLayout {
  if (!Number.isInteger(frames) || frames < 1) throw new Error(`packSprites: frames must be a positive integer, got ${frames}`);
  for (const [name, value] of [
    ['frameW', frameW],
    ['frameH', frameH],
  ] as const) {
    if (!Number.isInteger(value) || value < 1) throw new Error(`packSprites: ${name} must be a positive integer, got ${value}`);
  }
  if (frameW > maxSide || frameH > maxSide) throw new Error(`packSprites: a ${frameW}×${frameH} frame is over the ${maxSide} px side limit`);
  // Square-ish in pixels, not in cells: tall frames pack into more columns.
  const ideal = Math.sqrt((frames * frameH) / frameW);
  let cols = Math.max(1, Math.min(frames, Math.round(ideal)));
  cols = Math.min(cols, Math.floor(maxSide / frameW));
  let rows = Math.ceil(frames / cols);
  // Widen while the sheet is too tall and there is room to.
  while (rows * frameH > maxSide && (cols + 1) * frameW <= maxSide) {
    cols++;
    rows = Math.ceil(frames / cols);
  }
  if (rows * frameH > maxSide) {
    throw new Error(`packSprites: ${frames} frames of ${frameW}×${frameH} do not fit in ${maxSide}×${maxSide}`);
  }
  return { frames, cols, rows, frameW, frameH, sheetW: cols * frameW, sheetH: rows * frameH };
}

/** Where frame `index` sits on the sheet. */
export function spriteCell(layout: SpriteLayout, index: number): { x: number; y: number } {
  if (!Number.isInteger(index) || index < 0 || index >= layout.frames) throw new Error(`spriteCell: no frame ${index}`);
  return { x: (index % layout.cols) * layout.frameW, y: Math.floor(index / layout.cols) * layout.frameH };
}

/** The largest square frame size (a multiple of 8) at which `frames` fit the sheet, at most `preferred`. */
export function largestFrameSize(frames: number, preferred: number, maxSide = MAX_SHEET_SIDE): number {
  let size = Math.max(8, Math.floor(preferred / 8) * 8);
  while (size >= 8) {
    try {
      packSprites(frames, size, size, maxSide);
      return size;
    } catch {
      size -= 8;
    }
  }
  throw new Error(`largestFrameSize: ${frames} frames never fit in ${maxSide}×${maxSide}`);
}

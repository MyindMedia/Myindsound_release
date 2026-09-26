import { describe, expect, it } from 'vitest';
import { MAX_SHEET_SIDE, largestFrameSize, packSprites, spriteCell } from '../src/sprite';

describe('packSprites', () => {
  it('packs 36 square frames as a 6×6 sheet', () => {
    expect(packSprites(36, 256, 256)).toEqual({ frames: 36, cols: 6, rows: 6, frameW: 256, frameH: 256, sheetW: 1536, sheetH: 1536 });
    expect(packSprites(36, 512, 512).sheetW).toBe(3072);
  });

  it('packs tall frames into more columns than rows, square-ish in pixels', () => {
    const layout = packSprites(24, 200, 400);
    expect(layout.cols).toBe(7);
    expect(layout.rows).toBe(4);
    expect(layout.cols * layout.rows).toBeGreaterThanOrEqual(24);
  });

  it('never exceeds the side limit, widening the sheet when it can', () => {
    const layout = packSprites(36, 640, 640);
    expect(layout.sheetW).toBeLessThanOrEqual(MAX_SHEET_SIDE);
    expect(layout.sheetH).toBeLessThanOrEqual(MAX_SHEET_SIDE);
    expect(layout.cols * layout.rows).toBeGreaterThanOrEqual(36);
  });

  it('throws when the frames cannot fit', () => {
    expect(() => packSprites(36, 1024, 1024)).toThrow(/do not fit/);
    expect(() => packSprites(1, 8192, 8192)).toThrow(/side limit/);
    expect(() => packSprites(0, 64, 64)).toThrow(/frames/);
    expect(() => packSprites(3, 0, 64)).toThrow(/frameW/);
  });

  it('one frame is a one-cell sheet', () => {
    expect(packSprites(1, 300, 300)).toEqual(expect.objectContaining({ cols: 1, rows: 1, sheetW: 300, sheetH: 300 }));
  });
});

describe('spriteCell', () => {
  it('walks the sheet row by row', () => {
    const layout = packSprites(36, 256, 256);
    expect(spriteCell(layout, 0)).toEqual({ x: 0, y: 0 });
    expect(spriteCell(layout, 5)).toEqual({ x: 1280, y: 0 });
    expect(spriteCell(layout, 6)).toEqual({ x: 0, y: 256 });
    expect(spriteCell(layout, 35)).toEqual({ x: 1280, y: 1280 });
    expect(() => spriteCell(layout, 36)).toThrow(/no frame 36/);
  });
});

describe('largestFrameSize', () => {
  it('keeps the preferred size when it fits, else the largest multiple of 8 that does', () => {
    expect(largestFrameSize(36, 512)).toBe(512);
    const size = largestFrameSize(36, 1024);
    expect(size).toBeLessThan(1024);
    expect(size % 8).toBe(0);
    expect(() => packSprites(36, size, size)).not.toThrow();
    expect(() => packSprites(36, size + 8, size + 8)).toThrow();
  });
});

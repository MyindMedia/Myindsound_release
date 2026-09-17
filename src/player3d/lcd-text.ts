import type { KeyCommand } from './keys';
import { keyLatches, type DeckState, type DeckStatus } from './state';

/**
 * What the deck's calculator-style display shows: one 11-character line of 14-segment characters (deck status,
 * or a button flash) and the mode flags above it. Pure, so it's unit-tested; `lcd.ts` draws it.
 */

export const LCD_CHARS = 11;

export interface LcdContent {
  text: string;
  play: boolean;
  pause: boolean;
  stop: boolean;
  repeat: boolean;
}

/**
 * Segments of one character. Outer ring: a (top), b, c (right, top to bottom), d (bottom), e, f (left, bottom to
 * top). Middle bar: g1 (left half), g2 (right half). Inner strokes from the centre: h (to top-left), i (up),
 * j (to top-right), k (to bottom-left), l (down), m (to bottom-right).
 */
export const SEGMENT = {
  a: 1 << 0,
  b: 1 << 1,
  c: 1 << 2,
  d: 1 << 3,
  e: 1 << 4,
  f: 1 << 5,
  g1: 1 << 6,
  g2: 1 << 7,
  h: 1 << 8,
  i: 1 << 9,
  j: 1 << 10,
  k: 1 << 11,
  l: 1 << 12,
  m: 1 << 13,
} as const;

type SegmentName = keyof typeof SEGMENT;

const glyph = (names: string): number =>
  names
    .split(' ')
    .filter(Boolean)
    .reduce((bits, name) => bits | SEGMENT[name as SegmentName], 0);

/** The usual 14-segment alphanumeric font (as on LED backpack displays). */
export const GLYPHS: Record<string, number> = {
  ' ': 0,
  '-': glyph('g1 g2'),
  '0': glyph('a b c d e f'),
  '1': glyph('b c'),
  '2': glyph('a b d e g1 g2'),
  '3': glyph('a b c d g2'),
  '4': glyph('b c f g1 g2'),
  '5': glyph('a c d f g1 g2'),
  '6': glyph('a c d e f g1 g2'),
  '7': glyph('a b c'),
  '8': glyph('a b c d e f g1 g2'),
  '9': glyph('a b c d f g1 g2'),
  A: glyph('a b c e f g1 g2'),
  B: glyph('a b c d g2 i l'),
  C: glyph('a d e f'),
  D: glyph('a b c d i l'),
  E: glyph('a d e f g1'),
  F: glyph('a e f g1'),
  G: glyph('a c d e f g2'),
  H: glyph('b c e f g1 g2'),
  I: glyph('a d i l'),
  J: glyph('b c d e'),
  K: glyph('e f g1 j m'),
  L: glyph('d e f'),
  M: glyph('b c e f h j'),
  N: glyph('b c e f h m'),
  O: glyph('a b c d e f'),
  P: glyph('a b e f g1 g2'),
  Q: glyph('a b c d e f m'),
  R: glyph('a b e f g1 g2 m'),
  S: glyph('a c d f g1 g2'),
  T: glyph('a i l'),
  U: glyph('b c d e f'),
  V: glyph('e f j k'),
  W: glyph('b c e f k m'),
  X: glyph('h j k m'),
  Y: glyph('h j l'),
  Z: glyph('a d j k'),
};

/** `left` from the first character, `right` against the last, clipped to the display. */
export function lcdLine(left: string, right = ''): string {
  const room = Math.max(0, LCD_CHARS - right.length);
  return (left.slice(0, room).padEnd(room) + right).slice(0, LCD_CHARS);
}

const trackNumber = (state: DeckState) => String(state.trackIndex + 1).padStart(2, '0');

const STATUS_LINE: Record<DeckStatus, (state: DeckState) => string> = {
  booting: () => '',
  ejected: () => 'NO DISC',
  inserting: () => 'LOADING',
  reading: () => 'READING',
  seeking: () => 'CALIBRATING',
  ejecting: () => 'EJECTING',
  playing: (state) => lcdLine('PLAY', trackNumber(state)),
  paused: (state) => lcdLine('PAUSE', trackNumber(state)),
  stopped: (state) => lcdLine('STOP', trackNumber(state)),
  resuming: (state) => lcdLine('SPIN UP', trackNumber(state)),
};

export function lcdContent(state: DeckState, flash: string | null): LcdContent {
  const latches = keyLatches(state);
  return {
    text: flash ?? STATUS_LINE[state.status](state),
    play: latches.play,
    pause: latches.pause,
    stop: state.status === 'stopped',
    repeat: state.repeat,
  };
}

/** The button's own readout for a moment after it's pressed (`state` is after the press), or null. */
export function buttonFlash(command: KeyCommand, state: DeckState): string | null {
  switch (command) {
    case 'next':
      return lcdLine('NEXT', trackNumber(state));
    case 'prev':
      return lcdLine('PREV', trackNumber(state));
    case 'repeat':
      return state.repeat ? 'REPEAT ON' : 'REPEAT OFF';
    default:
      return null;
  }
}

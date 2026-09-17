import { describe, expect, test } from 'vitest';
import { buttonFlash, GLYPHS, LCD_CHARS, lcdContent, lcdLine, SEGMENT } from './lcd-text';
import { initialState, reduce, type DeckEvent, type DeckState, type DeckStatus } from './state';

const run = (events: DeckEvent[], start: DeckState = initialState()) => events.reduce(reduce, start);
const playing = () => run([{ type: 'loaded', trackCount: 6 }, { type: 'insert' }, { type: 'inserted' }, { type: 'ready' }]);
const withStatus = (status: DeckStatus, trackIndex = 2): DeckState => ({ ...playing(), status, trackIndex });

describe('LCD text', () => {
  test('shows the deck status, with the track number while a disc is loaded', () => {
    expect(lcdContent(withStatus('playing'), null).text).toBe('PLAY     03');
    expect(lcdContent(withStatus('paused'), null).text).toBe('PAUSE    03');
    expect(lcdContent(withStatus('stopped'), null).text).toBe('STOP     03');
    expect(lcdContent(withStatus('resuming'), null).text).toBe('SPIN UP  03');
    expect(lcdContent(withStatus('seeking'), null).text).toBe('CALIBRATING');
    expect(lcdContent(withStatus('inserting'), null).text).toBe('LOADING');
    expect(lcdContent(withStatus('reading'), null).text).toBe('READING');
    expect(lcdContent(withStatus('ejecting'), null).text).toBe('EJECTING');
    expect(lcdContent(withStatus('ejected'), null).text).toBe('NO DISC');
    expect(lcdContent(initialState(), null).text).toBe('');
  });

  test('a button flash replaces the status while it lasts', () => {
    expect(lcdContent(withStatus('seeking'), 'NEXT     03').text).toBe('NEXT     03');
  });

  test('mode flags follow the transport and repeat', () => {
    expect(lcdContent(withStatus('playing'), null)).toMatchObject({ play: true, pause: false, stop: false, repeat: false });
    expect(lcdContent(withStatus('resuming'), null)).toMatchObject({ play: true, pause: false });
    expect(lcdContent(withStatus('paused'), null)).toMatchObject({ play: false, pause: true });
    expect(lcdContent(withStatus('stopped'), null)).toMatchObject({ play: false, stop: true });
    expect(lcdContent({ ...withStatus('ejected'), repeat: true }, null)).toMatchObject({ play: false, repeat: true });
  });

  test('prev, next and repeat flash their button; other buttons show through the status', () => {
    const third = withStatus('seeking');
    expect(buttonFlash('next', third)).toBe('NEXT     03');
    expect(buttonFlash('prev', third)).toBe('PREV     03');
    expect(buttonFlash('repeat', { ...third, repeat: true })).toBe('REPEAT ON');
    expect(buttonFlash('repeat', third)).toBe('REPEAT OFF');
    expect(buttonFlash('play', third)).toBeNull();
  });

  test('lines pad to the display width and never overflow it', () => {
    expect(lcdLine('PLAY', '01')).toHaveLength(LCD_CHARS);
    expect(lcdLine('CALIBRATING NOW', '01')).toHaveLength(LCD_CHARS);
  });

  test('every character the deck can show has a glyph', () => {
    const texts = [
      ...(['booting', 'inserting', 'reading', 'playing', 'paused', 'stopped', 'resuming', 'seeking', 'ejecting', 'ejected'] as DeckStatus[]).map(
        (status) => lcdContent(withStatus(status, 9), null).text,
      ),
      buttonFlash('next', withStatus('playing', 9))!,
      buttonFlash('prev', withStatus('playing'))!,
      buttonFlash('repeat', { ...playing(), repeat: true })!,
      buttonFlash('repeat', playing())!,
    ];
    for (const char of texts.join('')) expect(GLYPHS[char], `glyph for "${char}"`).toBeDefined();
    for (let digit = 0; digit <= 9; digit++) expect(GLYPHS[String(digit)]).toBeDefined();
  });
});

describe('14-segment font', () => {
  const lit = (char: string) =>
    Object.entries(SEGMENT)
      .filter(([, bit]) => GLYPHS[char] & bit)
      .map(([name]) => name)
      .sort();

  test('letters use the standard segments', () => {
    expect(lit('A')).toEqual(['a', 'b', 'c', 'e', 'f', 'g1', 'g2']);
    expect(lit('N')).toEqual(['b', 'c', 'e', 'f', 'h', 'm']);
    expect(lit('T')).toEqual(['a', 'i', 'l']);
    expect(lit('X')).toEqual(['h', 'j', 'k', 'm']);
    expect(GLYPHS[' ']).toBe(0);
  });

  test('digits are drawn like a calculator (plain zero)', () => {
    expect(lit('0')).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(lit('7')).toEqual(['a', 'b', 'c']);
  });
});

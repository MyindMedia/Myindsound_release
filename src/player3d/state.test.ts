import { describe, expect, test } from 'vitest';
import { initialState, keyLatches, reduce, type DeckEvent, type DeckState } from './state';

function run(events: DeckEvent[], start: DeckState = initialState()): DeckState {
  return events.reduce(reduce, start);
}

const loaded = (count = 6): DeckEvent => ({ type: 'loaded', trackCount: count });
const playing = () => run([loaded(), { type: 'insert' }, { type: 'inserted' }, { type: 'ready' }]);

describe('deck state', () => {
  test('boots, then shows the disc floating out of the deck', () => {
    expect(initialState().status).toBe('booting');
    expect(run([loaded()]).status).toBe('ejected');
    expect(run([loaded(), loaded(3)])).toMatchObject({ status: 'ejected', trackCount: 3 });
  });

  test('insert → inserting → reading → playing', () => {
    const s1 = run([loaded(), { type: 'insert' }]);
    expect(s1.status).toBe('inserting');
    const s2 = reduce(s1, { type: 'inserted' });
    expect(s2.status).toBe('reading');
    expect(reduce(s2, { type: 'ready' }).status).toBe('playing');
  });

  test('play while the disc is out starts the insert; transport keys are ignored while inserting', () => {
    const s = run([loaded(), { type: 'play' }]);
    expect(s.status).toBe('inserting');
    expect(reduce(s, { type: 'pause' }).status).toBe('inserting');
    expect(reduce(s, { type: 'next' }).trackIndex).toBe(0);
  });

  test('insert is ignored while booting', () => {
    expect(run([{ type: 'insert' }]).status).toBe('booting');
  });

  test('pause toggles, stop rewinds, play resumes once the disc is back up to speed', () => {
    const paused = reduce(playing(), { type: 'pause' });
    expect(paused.status).toBe('paused');
    expect(reduce(paused, { type: 'pause' }).status).toBe('resuming');
    const stopped = run([{ type: 'tick', positionSec: 42 }, { type: 'stop' }], playing());
    expect(stopped).toMatchObject({ status: 'stopped', positionSec: 0 });
    expect(reduce(stopped, { type: 'play' }).status).toBe('resuming');
    expect(run([{ type: 'play' }, { type: 'ready' }], stopped).status).toBe('playing');
    expect(reduce(stopped, { type: 'pause' }).status).toBe('stopped');
  });

  test('next while playing calibrates first; while paused it just moves; last track only wraps with repeat', () => {
    const second = reduce(playing(), { type: 'next' });
    expect(second).toMatchObject({ trackIndex: 1, status: 'seeking', positionSec: 0 });
    expect(reduce(second, { type: 'seeked' }).status).toBe('playing');
    const pausedNext = reduce(reduce(playing(), { type: 'pause' }), { type: 'next' });
    expect(pausedNext).toMatchObject({ trackIndex: 1, status: 'paused' });
    const last = run([{ type: 'select', index: 5 }, { type: 'seeked' }], playing());
    expect(reduce(last, { type: 'next' }).trackIndex).toBe(5);
    const repeating = reduce(last, { type: 'toggleRepeat' });
    expect(reduce(repeating, { type: 'next' }).trackIndex).toBe(0);
  });

  test('prev restarts after 3 seconds, otherwise goes back', () => {
    const third = run([{ type: 'select', index: 2 }, { type: 'seeked' }, { type: 'tick', positionSec: 12 }], playing());
    expect(reduce(third, { type: 'prev' })).toMatchObject({ trackIndex: 2, positionSec: 0 });
    const early = reduce(third, { type: 'tick', positionSec: 2 });
    expect(reduce(early, { type: 'prev' }).trackIndex).toBe(1);
    expect(reduce(playing(), { type: 'prev' }).trackIndex).toBe(0);
    const firstRepeat = reduce(playing(), { type: 'toggleRepeat' });
    expect(reduce(firstRepeat, { type: 'prev' }).trackIndex).toBe(5);
  });

  test('track end advances, wraps with repeat, stops after the last track without it', () => {
    expect(reduce(playing(), { type: 'trackEnded' }).trackIndex).toBe(1);
    const last = run([{ type: 'select', index: 5 }, { type: 'seeked' }], playing());
    expect(reduce(last, { type: 'trackEnded' })).toMatchObject({ status: 'stopped', trackIndex: 0 });
    const repeatLast = reduce(last, { type: 'toggleRepeat' });
    expect(reduce(repeatLast, { type: 'trackEnded' })).toMatchObject({ status: 'playing', trackIndex: 0 });
  });

  test('select calibrates then plays; with the disc out it inserts first', () => {
    const paused = reduce(playing(), { type: 'pause' });
    const seeking = reduce(paused, { type: 'select', index: 3 });
    expect(seeking).toMatchObject({ trackIndex: 3, status: 'seeking' });
    expect(reduce(seeking, { type: 'seeked' })).toMatchObject({ trackIndex: 3, status: 'playing' });
    expect(run([loaded(), { type: 'select', index: 4 }])).toMatchObject({ trackIndex: 4, status: 'inserting' });
    expect(reduce(playing(), { type: 'select', index: 99 }).trackIndex).toBe(0);
  });
});

describe('calibration (seeking)', () => {
  const seeking = () => reduce(playing(), { type: 'select', index: 2 });

  test('re-selecting while calibrating restarts on the new track', () => {
    expect(reduce(seeking(), { type: 'next' })).toMatchObject({ trackIndex: 3, status: 'seeking' });
    expect(reduce(seeking(), { type: 'select', index: 5 })).toMatchObject({ trackIndex: 5, status: 'seeking' });
  });

  test('stop and pause cancel calibration; play and ticks are ignored', () => {
    expect(reduce(seeking(), { type: 'stop' }).status).toBe('stopped');
    expect(reduce(seeking(), { type: 'pause' })).toMatchObject({ status: 'paused', trackIndex: 2 });
    expect(reduce(seeking(), { type: 'play' }).status).toBe('seeking');
    expect(reduce(seeking(), { type: 'tick', positionSec: 9 }).positionSec).toBe(0);
  });

  test('seeked only applies while seeking', () => {
    expect(reduce(playing(), { type: 'seeked' }).status).toBe('playing');
    expect(keyLatches(seeking())).toMatchObject({ play: true, pause: false });
  });
});

describe('resume (spin-up before playback)', () => {
  const resuming = () => run([{ type: 'tick', positionSec: 30 }, { type: 'pause' }, { type: 'play' }], playing());

  test('play from paused spins the disc up first, keeping the position; ready starts playback', () => {
    expect(resuming()).toMatchObject({ status: 'resuming', positionSec: 30 });
    expect(reduce(resuming(), { type: 'ready' }).status).toBe('playing');
  });

  test('pause, stop and eject still work while spinning up; play, ticks and track end are ignored', () => {
    expect(reduce(resuming(), { type: 'pause' }).status).toBe('paused');
    expect(reduce(resuming(), { type: 'stop' })).toMatchObject({ status: 'stopped', positionSec: 0 });
    expect(reduce(resuming(), { type: 'eject' }).status).toBe('ejecting');
    expect(reduce(resuming(), { type: 'play' }).status).toBe('resuming');
    expect(reduce(resuming(), { type: 'tick', positionSec: 31 }).positionSec).toBe(30);
    expect(reduce(resuming(), { type: 'trackEnded' }).status).toBe('resuming');
  });

  test('next keeps spinning up on the new track; picking a track calibrates instead', () => {
    expect(reduce(resuming(), { type: 'next' })).toMatchObject({ status: 'resuming', trackIndex: 1, positionSec: 0 });
    expect(reduce(resuming(), { type: 'select', index: 4 })).toMatchObject({ status: 'seeking', trackIndex: 4 });
  });

  test('play key latches while spinning up', () => {
    expect(keyLatches(resuming())).toMatchObject({ play: true, pause: false });
  });
});

describe('eject', () => {
  const ejected = (from: DeckState = playing()) => run([{ type: 'eject' }, { type: 'ejected' }], from);

  test('ejects from playing, paused, stopped and calibrating, rewinding the track', () => {
    const third = run([{ type: 'select', index: 2 }, { type: 'seeked' }, { type: 'tick', positionSec: 40 }], playing());
    expect(reduce(third, { type: 'eject' })).toMatchObject({ status: 'ejecting', trackIndex: 2, positionSec: 0 });
    expect(reduce(reduce(playing(), { type: 'pause' }), { type: 'eject' }).status).toBe('ejecting');
    expect(reduce(reduce(playing(), { type: 'stop' }), { type: 'eject' }).status).toBe('ejecting');
    expect(reduce(reduce(playing(), { type: 'next' }), { type: 'eject' }).status).toBe('ejecting');
    expect(ejected().status).toBe('ejected');
  });

  test('is ignored with no disc in or while the disc is moving', () => {
    expect(run([{ type: 'eject' }]).status).toBe('booting');
    expect(run([loaded(), { type: 'eject' }]).status).toBe('ejected');
    expect(run([loaded(), { type: 'insert' }, { type: 'eject' }]).status).toBe('inserting');
    expect(run([loaded(), { type: 'insert' }, { type: 'inserted' }, { type: 'eject' }]).status).toBe('reading');
    expect(reduce(ejected(), { type: 'eject' }).status).toBe('ejected');
  });

  test('transport keys, ticks and track end do nothing while ejecting or ejected', () => {
    const ejecting = reduce(playing(), { type: 'eject' });
    for (const state of [ejecting, ejected()]) {
      for (const event of [{ type: 'pause' }, { type: 'stop' }, { type: 'next' }, { type: 'prev' }, { type: 'trackEnded' }] as DeckEvent[]) {
        expect(reduce(state, event)).toBe(state);
      }
      expect(reduce(state, { type: 'tick', positionSec: 9 }).positionSec).toBe(0);
    }
    expect(reduce(ejecting, { type: 'insert' }).status).toBe('ejecting');
  });

  test('insert, play or picking a track pushes the disc back in', () => {
    const third = run([{ type: 'select', index: 2 }, { type: 'seeked' }], playing());
    expect(reduce(ejected(third), { type: 'insert' })).toMatchObject({ status: 'inserting', trackIndex: 2 });
    expect(reduce(ejected(third), { type: 'play' })).toMatchObject({ status: 'inserting', trackIndex: 2 });
    expect(reduce(ejected(third), { type: 'select', index: 4 })).toMatchObject({ status: 'inserting', trackIndex: 4 });
    const back = run([{ type: 'insert' }, { type: 'inserted' }, { type: 'ready' }], ejected(third));
    expect(back).toMatchObject({ status: 'playing', trackIndex: 2 });
  });

  test('repeat still toggles while ejected', () => {
    expect(reduce(ejected(), { type: 'toggleRepeat' }).repeat).toBe(true);
  });
});

describe('key latches', () => {
  test('play latched while playing, pause while paused; eject never latches', () => {
    expect(keyLatches(playing())).toEqual({ pause: false, stop: false, prev: false, next: false, play: true, red: false });
    const paused = reduce(reduce(playing(), { type: 'toggleRepeat' }), { type: 'pause' });
    expect(keyLatches(paused)).toEqual({ pause: true, stop: false, prev: false, next: false, play: false, red: false });
    expect(keyLatches(reduce(paused, { type: 'stop' }))).toMatchObject({ play: false, pause: false, red: false });
    expect(keyLatches(reduce(playing(), { type: 'eject' }))).toMatchObject({ play: false, pause: false, red: false });
  });
});

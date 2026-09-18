import { describe, expect, test } from 'vitest';
import { resumeFrom, type Handoff } from './playback-handoff';

const state = (over: Partial<Handoff> = {}): Handoff => ({
  tracks: [
    { position: 1, title: 'One', streamUrl: '/1.mp3', durationSeconds: 30 },
    { position: 2, title: 'Two', streamUrl: '/2.mp3', durationSeconds: 30 },
    { position: 3, title: 'Three', streamUrl: '/3.mp3', durationSeconds: 30 },
  ],
  index: 0,
  positionSec: 0,
  playing: true,
  at: 1_000_000,
  access: 'preview',
  volume: 0.8,
  ...over,
});

describe('picking the music back up on the next page', () => {
  test('the page load is added back, so it carries on where it would have been', () => {
    const now = state().at + 1_500; // a second and a half to change page
    expect(resumeFrom(state({ positionSec: 10 }), now)).toEqual({ index: 0, positionSec: 11.5, playing: true });
  });

  test('a track that ran out during the load rolls into the next one', () => {
    const start = state({ index: 0, positionSec: 28 });
    expect(resumeFrom(start, start.at + 4_000)).toEqual({ index: 1, positionSec: 2, playing: true });
  });

  test('two tracks can go by if the page took that long to come back', () => {
    const start = state({ index: 0, positionSec: 0 });
    expect(resumeFrom(start, start.at + 65_000)).toEqual({ index: 2, positionSec: 5, playing: true });
  });

  test('the end of the album stops rather than wrapping round', () => {
    const start = state({ index: 2, positionSec: 25 });
    expect(resumeFrom(start, start.at + 30_000)).toEqual({ index: 2, positionSec: 0, playing: false });
  });

  test('paused stays exactly where it was, however long they were gone', () => {
    const start = state({ index: 1, positionSec: 12, playing: false });
    expect(resumeFrom(start, start.at + 600_000)).toEqual({ index: 1, positionSec: 12, playing: false });
  });

  test('a track of unknown length is never run past', () => {
    const start = state({
      tracks: [{ position: 1, title: 'One', streamUrl: '/1.mp3', durationSeconds: 0 }],
      positionSec: 5,
    });
    expect(resumeFrom(start, start.at + 10_000)).toEqual({ index: 0, positionSec: 15, playing: true });
  });

  test('an index past the end of the list comes back to the last track', () => {
    const start = state({ index: 9, positionSec: 3, playing: false });
    expect(resumeFrom(start, start.at)).toEqual({ index: 2, positionSec: 3, playing: false });
  });

  test('no tracks is not a resume', () => {
    expect(resumeFrom(state({ tracks: [] }), 0)).toEqual({ index: 0, positionSec: 0, playing: false });
  });
});

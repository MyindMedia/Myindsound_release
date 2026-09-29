import { describe, expect, it } from 'vitest';
import { playerModeRequested, resumeFromPlayback } from '../bundles/lit/copy';

const tracks = [{ id: 't1' }, { id: 't2' }, { id: 't3' }];

describe('player mode (the app player opens the deck with the playing disc in it)', () => {
  it('reads ?mode=player only', () => {
    expect(playerModeRequested('?mode=player')).toBe(true);
    expect(playerModeRequested('?mode=sleeve')).toBe(false);
    expect(playerModeRequested('')).toBe(false);
  });

  it('resumes at the playing track and place', () => {
    expect(resumeFromPlayback(tracks, { trackId: 't2', status: 'playing', positionSec: 42.5, rate: 1 })).toEqual({
      index: 1,
      positionSec: 42.5,
      playing: true,
    });
  });

  it('puts a cued, never started track in the deck, paused', () => {
    expect(resumeFromPlayback(tracks, { trackId: 't1', status: 'idle', positionSec: 0, rate: 0 })).toEqual({
      index: 0,
      positionSec: 0,
      playing: false,
    });
  });

  it('keeps a paused disc paused, and an ended track cued from its start', () => {
    expect(resumeFromPlayback(tracks, { trackId: 't3', status: 'paused', positionSec: 10, rate: 0 })?.playing).toBe(false);
    expect(resumeFromPlayback(tracks, { trackId: 't1', status: 'ended', positionSec: 200, rate: 0 })?.positionSec).toBe(0);
  });

  it('starts empty when nothing of this release is in the deck', () => {
    expect(resumeFromPlayback(tracks, { trackId: null, status: 'idle', positionSec: 0, rate: 0 })).toBeUndefined();
    expect(resumeFromPlayback(tracks, { trackId: null, status: 'stopped', positionSec: 0, rate: 0 })).toBeUndefined();
    expect(resumeFromPlayback(tracks, { trackId: 'other', status: 'playing', positionSec: 5, rate: 1 })).toBeUndefined();
    expect(resumeFromPlayback(tracks, { trackId: 't1', status: 'error', positionSec: 0, rate: 0 })).toBeUndefined();
  });
});

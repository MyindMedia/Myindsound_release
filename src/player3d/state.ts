/**
 * Deck state machine. Pure: no DOM, audio or Three.js, so every transition is unit-tested.
 */

export type DeckStatus =
  | 'booting'
  | 'inserting'
  | 'reading'
  | 'playing'
  | 'paused'
  | 'stopped'
  | 'resuming'
  | 'seeking'
  | 'ejecting'
  | 'ejected';
export type KeyId = 'pause' | 'stop' | 'prev' | 'next' | 'play' | 'red';

export const KEY_ORDER: readonly KeyId[] = ['pause', 'stop', 'prev', 'next', 'play', 'red'];
export const PREV_RESTART_THRESHOLD_SEC = 3;

export interface DeckState {
  status: DeckStatus;
  trackIndex: number;
  trackCount: number;
  repeat: boolean;
  positionSec: number;
}

export type DeckEvent =
  | { type: 'loaded'; trackCount: number }
  | { type: 'insert' }
  | { type: 'inserted' }
  | { type: 'ready' }
  | { type: 'seeked' }
  | { type: 'eject' }
  | { type: 'ejected' }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'stop' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'select'; index: number }
  | { type: 'toggleRepeat' }
  | { type: 'trackEnded' }
  | { type: 'tick'; positionSec: number };

export function initialState(): DeckState {
  return { status: 'booting', trackIndex: 0, trackCount: 0, repeat: false, positionSec: 0 };
}

const LOADED: ReadonlySet<DeckStatus> = new Set(['playing', 'paused', 'stopped']);
/** A seated disc the transport keys work on: loaded, recalibrating, or spinning back up after a pause or stop. */
const TRANSPORT: ReadonlySet<DeckStatus> = new Set([...LOADED, 'seeking', 'resuming']);
/** Selecting a track while the deck is running recalibrates the laser before playback (≥ 2 s). */
const RUNNING: ReadonlySet<DeckStatus> = new Set(['playing', 'seeking']);

function atTrack(state: DeckState, trackIndex: number): DeckState {
  return { ...state, trackIndex, positionSec: 0 };
}

export function reduce(state: DeckState, event: DeckEvent): DeckState {
  const transport = TRANSPORT.has(state.status);
  const last = Math.max(0, state.trackCount - 1);

  switch (event.type) {
    // The page opens with the cartridge floating out of the deck; insert, play or a track pick loads it.
    case 'loaded':
      return state.status === 'booting'
        ? { ...state, status: 'ejected', trackCount: event.trackCount }
        : { ...state, trackCount: event.trackCount };

    case 'insert':
      return state.status === 'ejected' ? { ...state, status: 'inserting' } : state;

    case 'inserted':
      return state.status === 'inserting' ? { ...state, status: 'reading' } : state;

    // The disc is up to speed: after the insert, or after a pause or stop.
    case 'ready':
      return state.status === 'reading' || state.status === 'resuming' ? { ...state, status: 'playing' } : state;

    case 'seeked':
      return state.status === 'seeking' ? { ...state, status: 'playing' } : state;

    // The red key: the cartridge comes out for inspection, and goes back in at the start of the track.
    case 'eject':
      return transport ? { ...state, status: 'ejecting', positionSec: 0 } : state;

    case 'ejected':
      return state.status === 'ejecting' ? { ...state, status: 'ejected' } : state;

    // A still disc spins back up before the music starts (`ready`).
    case 'play':
      if (state.status === 'ejected') return { ...state, status: 'inserting' };
      return state.status === 'paused' || state.status === 'stopped' ? { ...state, status: 'resuming' } : state;

    case 'pause':
      if (state.status === 'playing' || state.status === 'seeking' || state.status === 'resuming') {
        return { ...state, status: 'paused' };
      }
      if (state.status === 'paused') return { ...state, status: 'resuming' };
      return state;

    case 'stop':
      return transport && state.status !== 'stopped' ? { ...state, status: 'stopped', positionSec: 0 } : state;

    case 'next': {
      if (!transport) return state;
      const index = state.trackIndex < last ? state.trackIndex + 1 : state.repeat ? 0 : -1;
      if (index < 0) return state;
      return { ...atTrack(state, index), status: RUNNING.has(state.status) ? 'seeking' : state.status };
    }

    case 'prev': {
      if (!transport) return state;
      if (state.positionSec > PREV_RESTART_THRESHOLD_SEC && state.status !== 'seeking') {
        return atTrack(state, state.trackIndex);
      }
      const index = state.trackIndex > 0 ? state.trackIndex - 1 : state.repeat ? last : 0;
      if (index === state.trackIndex) return atTrack(state, index);
      return { ...atTrack(state, index), status: RUNNING.has(state.status) ? 'seeking' : state.status };
    }

    case 'select': {
      if (event.index < 0 || event.index > last || state.trackCount === 0) return state;
      if (state.status === 'ejected') return { ...atTrack(state, event.index), status: 'inserting' };
      if (!transport) return state;
      return { ...atTrack(state, event.index), status: 'seeking' };
    }

    case 'toggleRepeat':
      return state.status === 'booting' ? state : { ...state, repeat: !state.repeat };

    case 'trackEnded':
      if (!LOADED.has(state.status)) return state;
      if (state.trackIndex < last) return { ...atTrack(state, state.trackIndex + 1), status: 'playing' };
      if (state.repeat) return { ...atTrack(state, 0), status: 'playing' };
      return { ...atTrack(state, 0), status: 'stopped' };

    case 'tick':
      return LOADED.has(state.status) ? { ...state, positionSec: event.positionSec } : state;
  }
}

export function keyLatches(state: DeckState): Record<KeyId, boolean> {
  return {
    pause: state.status === 'paused',
    stop: false,
    prev: false,
    next: false,
    play: state.status === 'playing' || state.status === 'seeking' || state.status === 'resuming',
    red: false,
  };
}

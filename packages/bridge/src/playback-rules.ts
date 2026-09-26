import { PREVIOUS_RESTART_THRESHOLD_SEC, SPECTRUM_BANDS, WAVEFORM_SAMPLES, type BridgeTrack, type PlaybackFrame, type PlaybackState } from './types';

/**
 * Queue rules every bridge implementation shares (native, the web adapter and the mock), so `next`, `previous`
 * and the end of a track behave the same on every platform. See CONTRACT.md "Playback semantics".
 */

/** `next`: the following track, or null at the last one (the call is then a no-op). */
export function nextIndex(tracks: readonly BridgeTrack[], index: number): number | null {
  return index >= 0 && index < tracks.length - 1 ? index + 1 : null;
}

/** `previous`: restart the track once it is past the threshold (or it's the first), otherwise the one before. */
export function previousIndex(index: number, positionSec: number): number {
  if (index <= 0 || positionSec > PREVIOUS_RESTART_THRESHOLD_SEC) return Math.max(0, index);
  return index - 1;
}

export function idleState(): PlaybackState {
  return { trackId: null, status: 'idle', positionSec: 0, rate: 0 };
}

/** A frame with no signal: what native sends on a status change while not playing. */
export function silentFrame(state: PlaybackState): PlaybackFrame {
  return {
    ...state,
    bands: new Array(SPECTRUM_BANDS).fill(0),
    waveform: new Array(WAVEFORM_SAMPLES).fill(0),
    level: 0,
    bass: 0,
  };
}

/**
 * Carrying the music from the player to the rest of the site.
 *
 * The site is separate pages, so a link to the store is a real page load and the player's audio element
 * dies with it. What survives is this: the tracklist, where the needle had got to and whether it was
 * running, written to sessionStorage while the player plays. `mini-player.ts` picks it up on the next page,
 * works out where the music would be by now and carries on; coming back to the player hands it back.
 *
 * sessionStorage, so it belongs to this tab and goes when the tab does.
 */

export interface HandoffTrack {
  position: number;
  title: string;
  streamUrl: string;
  durationSeconds: number;
}

export interface Handoff {
  tracks: HandoffTrack[];
  /** Index into `tracks`, not the printed track number. */
  index: number;
  /** Where the track had got to when this was written. */
  positionSec: number;
  playing: boolean;
  /** `Date.now()` when it was written, so the gap over the page load can be added back. */
  at: number;
  access: 'full' | 'preview';
  volume: number;
}

const KEY = 'myind.playback';
const OPENED_KEY = 'myind.opened';
/** Older than this and it is not a handoff any more, it is what they were listening to earlier. */
export const HANDOFF_TTL_MS = 30 * 60 * 1000;

/**
 * Where the music has got to by `now`, allowing for the page load, and rolling into the next track if it
 * ran past the end of this one while the page was changing. Pure, so it is unit-tested.
 */
export function resumeFrom(
  state: Handoff,
  now: number,
): { index: number; positionSec: number; playing: boolean } {
  const last = state.tracks.length - 1;
  if (last < 0) return { index: 0, positionSec: 0, playing: false };
  const index = Math.max(0, Math.min(state.index, last));
  if (!state.playing) return { index, positionSec: Math.max(0, state.positionSec), playing: false };

  let at = index;
  let position = Math.max(0, state.positionSec) + Math.max(0, now - state.at) / 1000;
  while (at <= last) {
    const duration = state.tracks[at].durationSeconds;
    // A track with no known length can't be run past; stay on it.
    if (!(duration > 0) || position < duration) return { index: at, positionSec: position, playing: true };
    position -= duration;
    at++;
  }
  // The album finished while they were away: sit at the end of the last track, stopped.
  return { index: last, positionSec: 0, playing: false };
}

function storage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null; // Private mode, or storage is blocked: the handoff is a nicety, not a feature.
  }
}

export function writeHandoff(state: Handoff): void {
  if (state.tracks.length === 0) return;
  try {
    storage()?.setItem(KEY, JSON.stringify(state));
  } catch {
    /* Full or blocked: nothing to do about it. */
  }
}

export function readHandoff(now = Date.now()): Handoff | null {
  const raw = (() => {
    try {
      return storage()?.getItem(KEY) ?? null;
    } catch {
      return null;
    }
  })();
  if (!raw) return null;
  try {
    const state = JSON.parse(raw) as Handoff;
    if (!Array.isArray(state.tracks) || state.tracks.length === 0) return null;
    if (typeof state.at !== 'number' || now - state.at > HANDOFF_TTL_MS) return null;
    return state;
  } catch {
    return null;
  }
}

export function clearHandoff(): void {
  try {
    storage()?.removeItem(KEY);
  } catch {
    /* Nothing to do. */
  }
}

/** The packaging has come off once in this tab, so a link back to the player shouldn't wrap it again. */
export function markOpened(): void {
  try {
    storage()?.setItem(OPENED_KEY, '1');
  } catch {
    /* Nothing to do. */
  }
}

export function wasOpened(): boolean {
  try {
    return storage()?.getItem(OPENED_KEY) === '1';
  } catch {
    return false;
  }
}

export function clearOpened(): void {
  try {
    storage()?.removeItem(OPENED_KEY);
  } catch {
    /* Nothing to do. */
  }
}

/**
 * A reload of the player is a fresh start: the package comes back, sealed. Coming back to it from another
 * page in the same tab is not, so the disc is where they left it.
 */
export function isReload(): boolean {
  const [entry] = performance.getEntriesByType('navigation') as PerformanceNavigationTiming[];
  return entry?.type === 'reload';
}

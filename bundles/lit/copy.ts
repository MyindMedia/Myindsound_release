import type { BridgeContext, BridgeTrack, LendState, PlaybackState } from '../../packages/bridge/src/types';

/** What the bundle shows about this copy. Pure, so it's unit-tested (packages/bridge/test/bun0.test.ts). */
export type Copy = Pick<BridgeContext, 'ownership' | 'editionNumber' | 'unwrapped'> & { lend?: LendState };

/** DS-22: `PLAYS 03` for a borrower, `LEND ENDED` once it's over, `ON LOAN` for an owner whose copy is out. */
export function lendLine(copy: Copy): string | null {
  const lend = copy.lend;
  if (!lend) return null;
  if (copy.ownership === 'lent') {
    if (lend.status !== 'active') return 'LEND ENDED';
    return `PLAYS ${String(Math.max(0, lend.playsAllowed - lend.playsUsed)).padStart(2, '0')}`;
  }
  if (copy.ownership === 'owned' && lend.status === 'active') return 'ON LOAN';
  return null;
}

/** The copy's number is shown for copies that have one: owned, and a borrower's view of the owner's copy. */
export function editionOf(copy: Copy): number | null {
  return (copy.ownership === 'owned' || copy.ownership === 'lent') && copy.editionNumber !== null ? copy.editionNumber : null;
}

/** The label stamp: `No. 0007`. */
export function formatEdition(edition: number): string {
  return `No. ${String(Math.max(0, Math.trunc(edition))).padStart(4, '0')}`;
}

/**
 * `index.html?mode=sleeve`: the app's rack opens an unwrapped copy on its printed card sleeve, without the film
 * (RACK-3: a copy that has never been unwrapped still gets the film, whatever the mode says).
 */
export function sleeveModeRequested(search: string): boolean {
  return new URLSearchParams(search).get('mode') === 'sleeve';
}

/** Sleeve mode: the disc can't go in while the owner's copy is out on loan, or once a borrower's lend is over. */
export function canLoadCopy(copy: Copy | null): boolean {
  const lend = copy?.lend;
  if (!copy || !lend) return true;
  return copy.ownership === 'owned' ? lend.status !== 'active' : lend.status === 'active';
}

/** `?mode=player`: the app's player. The disc already in native's deck is shown in the 3D deck, never a sleeve. */
export function playerModeRequested(search: string): boolean {
  return new URLSearchParams(search).get('mode') === 'player';
}

/**
 * Player mode: where native's deck is, as the PlayerApp's resume (the disc goes straight in at that track and
 * place). Undefined when nothing of this release is loaded, so the deck starts empty.
 */
export function resumeFromPlayback(
  tracks: Pick<BridgeTrack, 'id'>[],
  state: PlaybackState,
): { index: number; positionSec: number; playing: boolean } | undefined {
  // A track named but idle is cued in native's deck (the now playing bar shows it): the disc is in, paused.
  if (!state.trackId || state.status === 'error') return undefined;
  const index = tracks.findIndex((track) => track.id === state.trackId);
  if (index < 0) return undefined;
  return {
    index,
    positionSec: state.status === 'ended' ? 0 : Math.max(0, state.positionSec),
    playing: state.status === 'playing' || state.status === 'loading',
  };
}

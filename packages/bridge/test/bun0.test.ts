import { beforeAll, describe, expect, test } from 'vitest';
// BUN-0 integration: the site's player driven by the bridge. Type-only imports from the site where its modules
// touch the DOM or Convex at load; tsc checks the shapes (packages/bridge tsconfig).
import type { AudioEngine, PlayerEngine } from '../../../src/player3d/audio-engine';
import type { PlayerEngineEvents } from '../../../src/player3d/player-app';
import { initialState, reduce, type DeckEvent, type DeckState } from '../../../src/player3d/state';
import { editionOf, formatEdition, lendLine } from '../../../bundles/lit/copy';
import { BridgeAudioEngine } from '../src/bridge-audio-engine';
import { MockBridge } from '../src/mock';
import type { LendState } from '../src/types';

// ── Conformance (compile time) ─────────────────────────────────────────────────────────────────────────
// The bundle's composition root hands this factory to PlayerApp: BridgeAudioEngine is a PlayerEngine, and the
// player's events (with onNativeChange) are what BridgeAudioEngine accepts.
const createEngine: (events: PlayerEngineEvents) => PlayerEngine = (events) => new BridgeAudioEngine(new MockBridge(), events);
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const shapes: [Equal<PlayerEngine, Omit<AudioEngine, 'element'>>, 'seek' extends keyof PlayerEngine ? true : false] = [true, true];

function run(events: DeckEvent[], from: DeckState = initialState()): DeckState {
  return events.reduce(reduce, from);
}

/** A seated deck of 7 tracks, playing track `index + 1`. */
function playing(index = 0): DeckState {
  return run([{ type: 'loaded', trackCount: 7 }, { type: 'select', index }, { type: 'inserted' }, { type: 'ready' }]);
}

describe('deck sync (native moved without the deck asking; CONTRACT.md §12.3)', () => {
  test('conformance holds', () => {
    expect(shapes.every(Boolean)).toBe(true);
    expect(typeof createEngine).toBe('function');
  });

  test('a lock-screen next moves the deck to that track, playing, with no calibration', () => {
    const next = reduce(playing(0), { type: 'sync', index: 1, status: 'playing' });
    expect(next).toMatchObject({ status: 'playing', trackIndex: 1, positionSec: 0 });
  });

  test('a native pause and resume follow at once, keeping the place', () => {
    const at = { ...playing(2), positionSec: 42 };
    const paused = reduce(at, { type: 'sync', index: 2, status: 'paused' });
    expect(paused).toMatchObject({ status: 'paused', trackIndex: 2, positionSec: 42 });
    expect(reduce(paused, { type: 'sync', index: 2, status: 'playing' }).status).toBe('playing');
  });

  test('a lend ending stops the deck at 0', () => {
    const stopped = reduce({ ...playing(0), positionSec: 12 }, { type: 'sync', index: 0, status: 'stopped' });
    expect(stopped).toMatchObject({ status: 'stopped', positionSec: 0 });
  });

  test('overrides a calibration or spin-up in progress', () => {
    const seeking = reduce(playing(0), { type: 'next' });
    expect(seeking.status).toBe('seeking');
    expect(reduce(seeking, { type: 'sync', index: 3, status: 'playing' })).toMatchObject({ status: 'playing', trackIndex: 3 });
    const resuming = run([{ type: 'pause' }, { type: 'play' }], playing(0));
    expect(resuming.status).toBe('resuming');
    expect(reduce(resuming, { type: 'sync', index: 0, status: 'paused' }).status).toBe('paused');
  });

  test('ignored unless a disc is seated; a no-op sync returns the same state; the index is clamped', () => {
    const ejected = run([{ type: 'loaded', trackCount: 7 }]);
    expect(reduce(ejected, { type: 'sync', index: 2, status: 'playing' })).toBe(ejected);
    const inserting = reduce(ejected, { type: 'insert' });
    expect(reduce(inserting, { type: 'sync', index: 2, status: 'playing' })).toBe(inserting);
    const at = playing(1);
    expect(reduce(at, { type: 'sync', index: 1, status: 'playing' })).toBe(at);
    expect(reduce(at, { type: 'sync', index: 99, status: 'playing' }).trackIndex).toBe(6);
  });
});

describe('AudioEngine.seek (replaces element.currentTime = 0 in player-app)', () => {
  class FakeAudio extends EventTarget {
    crossOrigin = '';
    preload = '';
    readyState = 4;
    paused = false;
    ended = false;
    volume = 1;
    currentTime = 0;
    src = '';
    pause(): void {
      this.paused = true;
    }
  }
  let Engine: typeof import('../../../src/player3d/audio-engine').AudioEngine;
  beforeAll(async () => {
    Object.assign(globalThis, { Audio: FakeAudio });
    ({ AudioEngine: Engine } = await import('../../../src/player3d/audio-engine'));
  });

  test('moves the element and keeps the play state; never negative', () => {
    const engine = new Engine();
    engine.element.currentTime = 90;
    engine.seek(0);
    expect(engine.element.currentTime).toBe(0);
    expect(engine.element.paused).toBe(false);
    engine.seek(-5);
    expect(engine.element.currentTime).toBe(0);
    engine.seek(12.5);
    expect(engine.currentTime).toBe(12.5);
  });
});

describe('LIT bundle copy helpers (DS-22, edition stamp)', () => {
  const lend = (patch: Partial<LendState> = {}): LendState => ({
    playsAllowed: 10,
    playsUsed: 7,
    expiresAt: 9_999_999,
    status: 'active',
    ...patch,
  });

  test('PLAYS nn for an active lend, LEND ENDED for any ended one, ON LOAN for the owner, else nothing', () => {
    expect(lendLine({ ownership: 'lent', editionNumber: 7, unwrapped: true, lend: lend() })).toBe('PLAYS 03');
    expect(lendLine({ ownership: 'lent', editionNumber: 7, unwrapped: true, lend: lend({ playsUsed: 12 }) })).toBe('PLAYS 00');
    for (const status of ['exhausted', 'expired', 'returned', 'revoked', 'converted'] as const) {
      expect(lendLine({ ownership: 'lent', editionNumber: 7, unwrapped: true, lend: lend({ status }) })).toBe('LEND ENDED');
    }
    expect(lendLine({ ownership: 'owned', editionNumber: 7, unwrapped: true, lend: lend() })).toBe('ON LOAN');
    expect(lendLine({ ownership: 'owned', editionNumber: 7, unwrapped: true, lend: lend({ status: 'returned' }) })).toBeNull();
    expect(lendLine({ ownership: 'owned', editionNumber: 7, unwrapped: true })).toBeNull();
    // Every line fits the 11-character LCD.
    expect('LEND ENDED'.length).toBeLessThanOrEqual(11);
  });

  test('the edition shows on owned and lent copies only, as No. 0007', () => {
    expect(editionOf({ ownership: 'owned', editionNumber: 7, unwrapped: false })).toBe(7);
    expect(editionOf({ ownership: 'lent', editionNumber: 12, unwrapped: true })).toBe(12);
    expect(editionOf({ ownership: 'preview', editionNumber: 3, unwrapped: false })).toBeNull();
    expect(editionOf({ ownership: 'owned', editionNumber: null, unwrapped: false })).toBeNull();
    expect(formatEdition(7)).toBe('No. 0007');
    expect(formatEdition(12345)).toBe('No. 12345');
  });
});

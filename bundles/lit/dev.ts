/**
 * Desktop harness for the LIT bundle: `MockBridge` stands in for native, over the same wire format a device uses
 * (`loopbackTransport`: requests and frames are serialised, frames quantised). `window.__mock` is the mock, for
 * poking from the console: `__mock.endLend('expired')`, `__mock.lifecycle('background')`, `__mock.calls`.
 */
import { createBridgeClient } from '../../packages/bridge/src/client';
import { MockBridge } from '../../packages/bridge/src/mock';
import { loopbackTransport } from '../../packages/bridge/src/transport';
import type { Ownership } from '../../packages/bridge/src/types';
import { computeWear, getWearConfig, type SafeZone, type WearDescriptor } from '../../packages/wear/src';
import previews from '../../src/player3d/lit-previews.json';
import manifest from './bundle.json';

const query = new URLSearchParams(window.location.search);
const ownership = (['owned', 'lent', 'preview', 'locked'] as const).find((o) => o === query.get('ownership')) ?? 'owned';
const number = (key: string) => {
  const value = Number(query.get(key));
  return query.has(key) && Number.isInteger(value) && value >= 0 ? value : undefined;
};

/** A fixed copy, so every run of `?wear=L` shows the same scratches. */
const WEAR_SEED = '6c6974776561723031666978656473ee';

/**
 * `?wear=0.3`: the descriptor `computeWear` gives this copy after enough plays to reach that level (§11.3,
 * solved for playSeconds), with the manifest's safe zones, as the server would compute it.
 */
function wearAt(level: number): WearDescriptor {
  const { K, SECONDS_PER_PLAY } = getWearConfig(1);
  const clamped = Math.min(Math.max(level, 0), 1);
  const plays = clamped >= 1 ? 1e7 : -Math.log(1 - clamped) / K;
  const stats = { playSeconds: plays * SECONDS_PER_PLAY, lentPlaySeconds: 0, loads: 0, ejects: 0 };
  return computeWear(WEAR_SEED, stats, 1, { wearSafeZones: manifest.wearSafeZones as SafeZone[] });
}
const wearLevel = Number(query.get('wear'));
const wear = query.has('wear') && Number.isFinite(wearLevel) ? wearAt(wearLevel) : null;

const mock = new MockBridge({
  wear,
  ownership: ownership satisfies Ownership,
  unwrapped: query.has('unwrapped'),
  editionNumber: number('edition'),
  lentPlays: number('plays'),
  latencyMs: 20,
  tracks: previews.tracks.map((track, i) => ({
    id: `lit-${String(track.position).padStart(2, '0')}`,
    position: track.position,
    title: track.title,
    // Made-up full lengths: the mock plays silence, native owns the real files.
    durationSeconds: 150 + ((i * 37) % 90),
  })),
});
(window as unknown as { __mock: MockBridge }).__mock = mock;
/** Live update over the bridge's `wear` event (WEAR-10): `__wear(0.7)`. */
(window as unknown as { __wear: (level: number) => void }).__wear = (level) => mock.setWear(wearAt(level));

const client = createBridgeClient({ transport: loopbackTransport(mock), autoStart: false });

import('./boot')
  .then(({ bootLit }) => bootLit(client, document.getElementById('player-root')!))
  .catch((err: unknown) => console.error('LIT bundle failed to start:', err));

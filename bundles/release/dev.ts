/**
 * Desktop harness for the generic release bundle: `MockBridge` stands in for native over the same wire format a
 * device uses, and the design comes from `packages/minidisc/samples/<name>.json` (`?design=blood`) instead of the
 * zip's `design/design.json`. `window.__mock` is the mock; `__wear(0.7)` updates the wear live.
 */
import { createBridgeClient } from '../../packages/bridge/src/client';
import { MockBridge } from '../../packages/bridge/src/mock';
import { loopbackTransport } from '../../packages/bridge/src/transport';
import type { Ownership } from '../../packages/bridge/src/types';
import { assertDesign, type DiscDesign } from '../../packages/minidisc/src/design';
import { computeWear, getWearConfig, type SafeZone, type WearDescriptor } from '../../packages/wear/src';
import manifest from './bundle.json';

const query = new URLSearchParams(window.location.search);
const ownership = (['owned', 'lent', 'preview', 'locked'] as const).find((o) => o === query.get('ownership')) ?? 'owned';
const number = (key: string) => {
  const value = Number(query.get(key));
  return query.has(key) && Number.isInteger(value) && value >= 0 ? value : undefined;
};

/** The sample designs, and their art, served by Vite from the package. */
const designs = import.meta.glob('../../packages/minidisc/samples/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const artUrls = import.meta.glob('../../packages/minidisc/samples/**/*.{png,jpg,webp}', { eager: true, import: 'default', query: '?url' }) as Record<string, string>;

const name = query.get('design') ?? 'blood';
const entry = Object.entries(designs).find(([path]) => path.endsWith(`/${name}.json`));
if (!entry) throw new Error(`No sample design "${name}" (have: ${Object.keys(designs).map((p) => p.split('/').pop()).join(', ')})`);
const design: DiscDesign = assertDesign(entry[1]);
/** Vite gives each art file its own URL: the design's relative refs are mapped through it. */
const resolveArt = (ref: string): string => {
  const hit = Object.entries(artUrls).find(([path]) => path.endsWith(`/samples/${ref}`));
  if (!hit) throw new Error(`Sample art missing: ${ref}`);
  return new URL(hit[1], window.location.href).href;
};

/** A fixed copy, so every run of `?wear=L` shows the same scratches. */
const WEAR_SEED = '6c6974776561723031666978656473ee';
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
  unwrapped: query.has('unwrapped') || query.has('load'),
  editionNumber: number('edition'),
  lentPlays: number('plays'),
  latencyMs: 20,
  tracks: [...design.tracks]
    .sort((a, b) => a.n - b.n)
    .map((track) => ({
      id: `${design.slug}-${String(track.n).padStart(2, '0')}`,
      position: track.n,
      title: track.title,
      durationSeconds: Math.max(1, Math.round(track.durationSec)),
    })),
});
(window as unknown as { __mock: MockBridge }).__mock = mock;
(window as unknown as { __wear: (level: number) => void }).__wear = (level) => mock.setWear(wearAt(level));

const client = createBridgeClient({ transport: loopbackTransport(mock), autoStart: false });

import('./boot')
  .then(({ bootRelease }) => bootRelease(client, document.getElementById('player-root')!, { design, resolveArt }))
  .catch((err: unknown) => console.error('Release bundle failed to start:', err));

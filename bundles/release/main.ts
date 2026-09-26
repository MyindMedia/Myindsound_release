/**
 * The generic release bundle's first script (CONTRACT.md §2): create the bridge client before any other code
 * runs, so it reads and removes the connect token from the meta tag first. The design, the player and GSAP
 * load after it. Same shape as bundles/lit/main.ts.
 */
import { createBridgeClient, type BridgeClient } from '../../packages/bridge/src/client';

let client: BridgeClient | null = null;
try {
  client = createBridgeClient({ autoStart: false });
} catch (err) {
  console.error('Release bundle: no native bridge.', err instanceof Error ? err.message : err);
}

if (client) {
  const bridge = client;
  import('./boot')
    .then(({ bootRelease }) => bootRelease(bridge, document.getElementById('player-root')!))
    .catch((err: unknown) => {
      console.error('Release bundle failed to start:', err instanceof Error ? err.name : err);
      bridge.ready();
    });
}

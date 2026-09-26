/**
 * The LIT bundle's first script (CONTRACT.md §2): create the bridge client before any other code runs, so it
 * reads and removes the connect token from the meta tag first. The player (and GSAP) load after it.
 */
import { createBridgeClient, type BridgeClient } from '../../packages/bridge/src/client';

let client: BridgeClient | null = null;
try {
  // Started by boot once its handlers are on, so no event native sent early is missed (CONTRACT.md §2).
  client = createBridgeClient({ autoStart: false });
} catch (err) {
  // No native bridge (E_TRANSPORT): opened outside the app. Nothing can play, and native's READY_TIMEOUT_MS
  // error screen covers a broken injection on device. dev.html is the desktop harness.
  console.error('LIT bundle: no native bridge.', err instanceof Error ? err.message : err);
}

if (client) {
  const bridge = client;
  import('./boot')
    .then(({ bootLit }) => bootLit(bridge, document.getElementById('player-root')!))
    .catch((err: unknown) => {
      console.error('LIT bundle failed to start:', err instanceof Error ? err.name : err);
      // Let native drop the splash and show its own error screen rather than wait out READY_TIMEOUT_MS.
      bridge.ready();
    });
}

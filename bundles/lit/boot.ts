/**
 * The LIT release bundle (PRD §10, BUN-0): the site's own player (`src/player3d/player-app.ts`) with the bridge in
 * place of the web audio and the Convex track source. Music plays natively (ARCH-2); the bundle never fetches
 * audio or calls Convex (BUN-5). Everything it knows comes through `MyindBridge`.
 */
import '../../src/player3d/hud.css';
import './fonts.css';
import { BridgeAudioEngine } from '../../packages/bridge/src/bridge-audio-engine';
import { BridgeTrackSource } from '../../packages/bridge/src/bridge-track-source';
import {
  BridgeError,
  type BridgeContext,
  type HapticKind,
  type MyindBridge,
  type OwnershipPayload,
} from '../../packages/bridge/src/types';
import type { Deck } from '../../src/player3d/deck';
import { PlayerApp, type PlayerMoment } from '../../src/player3d/player-app';
import type { PlayerScene } from '../../src/player3d/scene';
import { canLoadCopy, editionOf, lendLine, sleeveModeRequested, type Copy } from './copy';
import { addEditionStamp } from './edition-stamp';
import { installWear } from './wear';

/** Soft pulses while the film peels (DS-32): the peel runs about 2.6 s before the sleeve slides. */
const PEEL_PULSES_MS = [0, 650, 1300, 1950];
/** Soft pulses while the card sleeve is pulled off (DS-32): the slide runs about 2 s. */
const SLEEVE_PULSES_MS = [0, 380, 760, 1140, 1520];

/**
 * GSAP runs the insert and eject timelines (`insert-sequence.ts` reads `window.gsap`). The site takes it from a
 * CDN; the bundle carries it (public/vendor) and loads it only now, after the bridge client has connected.
 * Without it the timelines jump to their end state, so a failed load is not fatal.
 */
function loadGsap(): Promise<void> {
  if ((window as unknown as { gsap?: unknown }).gsap) return Promise.resolve();
  return new Promise((resolve) => {
    const script = document.createElement('script');
    script.src = 'vendor/gsap.min.js';
    script.onload = () => resolve();
    script.onerror = () => {
      console.warn('GSAP failed to load; the deck animates without its timelines');
      resolve();
    };
    document.head.append(script);
  });
}

const codeOf = (err: unknown) => (err instanceof BridgeError ? err.code : err instanceof Error ? err.name : 'unknown');

/** Fire and forget: a failed wear or ceremony call never breaks the experience (native queues and retries). */
function quietly(promise: Promise<void>, what: string): void {
  promise.catch((err: unknown) => console.warn(`${what} failed:`, codeOf(err)));
}

export async function bootLit(bridge: MyindBridge & { start?(): void }, root: HTMLElement): Promise<PlayerApp> {
  let copy: Copy | null = null;
  let app: PlayerApp | null = null;
  // Set from callbacks, so declared by assertion: TS would otherwise narrow them to null for good.
  let deck = null as Deck | null;
  let scene = null as PlayerScene | null;
  let removeStamp: (() => void) | null = null;
  let stampedEdition: number | null = null;
  let background = false;

  const haptic = (kind: HapticKind) => bridge.haptic(kind);

  const stamp = () => {
    const edition = copy ? editionOf(copy) : null;
    if (!deck || edition === stampedEdition) return;
    removeStamp?.();
    removeStamp = edition === null ? null : addEditionStamp(deck, edition);
    stampedEdition = edition;
  };

  const showLend = (flash: boolean) => {
    if (!app || !copy) return;
    const line = lendLine(copy);
    app.setLcdNote(line);
    if (line && flash) app.flashLcd(line, 1600);
  };

  // Handlers go on before the client starts, so nothing native sent early is missed (CONTRACT.md §2).
  bridge.on('ownership', (payload: OwnershipPayload) => {
    const before = copy ? lendLine(copy) : null;
    copy = { ...payload };
    stamp();
    showLend(lendLine(copy) !== before);
  });
  // BRG-2: no rendering in the background. The scene also stops itself when the document is hidden.
  let lifecycleEvent = false;
  bridge.on('lifecycle', ({ state }) => {
    lifecycleEvent = true;
    background = state === 'background';
    if (background) scene?.stop();
    else scene?.start();
  });
  // PRD §11.4: the copy's wear, from context.wear and then live on every `wear` event (WEAR-10).
  const wear = installWear();
  let wearEvent = false;
  bridge.on('wear', (descriptor) => {
    wearEvent = true;
    wear.set(descriptor);
  });
  bridge.start?.();

  const gsapReady = loadGsap();
  let context: BridgeContext | null = null;
  try {
    context = await bridge.getContext();
    copy = context;
    // A lifecycle event that beat getContext here is newer: a warm page shown while it was still booting got
    // `foreground` before this reply (built off screen, `background`) arrived, and would otherwise stay stopped.
    if (!lifecycleEvent) background = context.lifecycle === 'background';
    // An event that beat getContext here is at least as new.
    if (!wearEvent) wear.set(context.wear);
  } catch (err) {
    // The player still comes up and shows the failure from its own track load.
    console.warn('getContext failed:', codeOf(err));
  }
  const owned = context?.ownership === 'owned';
  const sleeved =
    sleeveModeRequested(window.location.search) &&
    Boolean(context?.unwrapped) &&
    (context?.ownership === 'owned' || context?.ownership === 'lent');

  const onMoment = (moment: PlayerMoment) => {
    switch (moment) {
      case 'unwrapStart':
        for (const at of PEEL_PULSES_MS) window.setTimeout(() => haptic('soft'), at);
        return;
      case 'unwrapped':
        // RACK-3: the unwrap plays once per copy. Only the owner's copy records it (E_NOT_ALLOWED otherwise).
        if (owned && copy && !copy.unwrapped) {
          copy = { ...copy, unwrapped: true };
          quietly(bridge.markUnwrapped(), 'markUnwrapped');
        }
        // DS-32: success as the edition number is revealed.
        if (copy && editionOf(copy) !== null) haptic('success');
        return;
      case 'sleevePull':
        for (const at of SLEEVE_PULSES_MS) window.setTimeout(() => haptic('soft'), at);
        // Tells the app's rack the load has begun (it fades its own readouts): a same-page fragment change,
        // which the host's navigation policy allows and reports.
        window.location.hash = 'loading';
        return;
      case 'insertStart':
        haptic('rigid');
        return;
      case 'seated':
        haptic('rigid');
        quietly(bridge.cartridgeLoaded(), 'cartridgeLoaded');
        if (copy && lendLine(copy)) showLend(true);
        return;
      case 'ejected':
        quietly(bridge.cartridgeEjected(), 'cartridgeEjected');
        return;
      case 'key':
        haptic('light');
        return;
    }
  };

  app = new PlayerApp(root, new BridgeTrackSource(bridge), {
    // RACK-3: sealed until this copy has been unwrapped once, then straight to the loaded cartridge.
    wrapped: context ? !context.unwrapped : false,
    sleeved,
    canLoadFromSleeve: () => canLoadCopy(copy),
    handoff: false,
    createEngine: (events) => new BridgeAudioEngine(bridge, events),
    // TODO(contract): the bridge has no purchase method yet (CONTRACT.md §11). Closing returns the fan to the
    // native release screen, which has the store.
    onGetLit: () => bridge.close(),
    onMoment,
    onSceneReady: (parts) => {
      deck = parts.deck;
      scene = parts.scene;
      stamp();
    },
  });

  await gsapReady;
  try {
    await app.mount();
  } finally {
    wear.done();
  }
  // The app's LOAD key under the sleeve (native calls this; the tap on the sleeve does the same).
  if (sleeved) {
    const player = app;
    (window as unknown as { __myindSleeve?: { load(): void } }).__myindSleeve = { load: () => player.loadFromSleeve() };
  }
  if (background) scene?.stop();
  showLend(false);
  // NAT-3: native keeps its splash until the first frame is on screen.
  requestAnimationFrame(() => requestAnimationFrame(() => bridge.ready()));
  return app;
}

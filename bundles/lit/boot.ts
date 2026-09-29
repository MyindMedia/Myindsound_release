/**
 * The LIT release bundle (PRD §10, BUN-0): the site's own player (`src/player3d/player-app.ts`) with the bridge in
 * place of the web audio and the Convex track source. Music plays natively (ARCH-2); the bundle never fetches
 * audio or calls Convex (BUN-5). Everything it knows comes through `MyindBridge`.
 *
 * The cartridge is the generated MiniDisc case (packages/minidisc, the same one every release gets: moulded
 * frame, exposed screws, one-piece sliding shutter, slot wear), built from LIT's design with LIT's own disc print
 * and cover art. LIT keeps its own card sleeve and city backdrop.
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
import { ensureFonts } from '../../packages/minidisc/src/canvas';
import type { BuiltCartridge } from '../../packages/minidisc/src/cartridge';
import { assertDesign, type DiscDesign } from '../../packages/minidisc/src/design';
import { cartridgeBuilder, loadDesignArt } from '../../packages/minidisc/src/minidisc';
import litSample from '../../packages/minidisc/samples/lit.json';
import { PlayerApp, type PlayerMoment } from '../../src/player3d/player-app';
import type { PlayerScene } from '../../src/player3d/scene';
import type { WearInput } from '../../src/player3d/wear-render';
import manifest from './bundle.json';
import { canLoadCopy, editionOf, lendLine, sleeveModeRequested, playerModeRequested, resumeFromPlayback, type Copy } from './copy';

/**
 * LIT's design for the generated case: the sample's title, tracks, label and colours, in a clear shell (LIT's
 * cartridge was always clear, so the disc art shows), printing LIT's own disc art and cover (the bundle carries
 * both as site assets; `/assets/...` becomes `./assets/...` in the bundle build).
 */
function litDesign(): DiscDesign {
  const at = (path: string) => new URL(path, document.baseURI).href;
  return {
    ...assertDesign(litSample),
    shell: 'clear',
    coverArt: at('/assets/images/lit-sleeve.webp'),
    discArt: at('/assets/images/minidisc/disc.webp'),
  };
}

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
  let scene = null as PlayerScene | null;
  let built = null as BuiltCartridge | null;
  let stampedEdition: number | null = null;
  let background = false;
  let latestWear: WearInput | null = null;

  const haptic = (kind: HapticKind) => bridge.haptic(kind);

  // The edition stamp goes on the generated cartridge's shutter plate.
  const stamp = () => {
    const edition = copy ? editionOf(copy) : null;
    if (!built || edition === stampedEdition) return;
    built.setEdition(edition);
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
  // PRD §11.4: the copy's wear, from context.wear and then live on every `wear` event (WEAR-10), drawn by the
  // generated cartridge (its slot and track wear included).
  let wearEvent = false;
  bridge.on('wear', (descriptor) => {
    wearEvent = true;
    latestWear = descriptor;
    built?.setWear(descriptor);
  });
  bridge.start?.();

  const gsapReady = loadGsap();
  // LIT's disc print and cover, and the fonts, before any print is drawn.
  const design = litDesign();
  const artReady = Promise.all([loadDesignArt(design), ensureFonts()]).then(([art]) => art);
  let context: BridgeContext | null = null;
  try {
    context = await bridge.getContext();
    copy = context;
    // A lifecycle event that beat getContext here is newer: a warm page shown while it was still booting got
    // `foreground` before this reply (built off screen, `background`) arrived, and would otherwise stay stopped.
    if (!lifecycleEvent) background = context.lifecycle === 'background';
    // An event that beat getContext here is at least as new.
    if (!wearEvent) latestWear = context.wear;
  } catch (err) {
    // The player still comes up and shows the failure from its own track load.
    console.warn('getContext failed:', codeOf(err));
  }
  const owned = context?.ownership === 'owned';
  // The app's player (the now playing bar): straight to the deck with the disc that's playing, no sleeve or film.
  const playerMode = playerModeRequested(window.location.search);
  let resume: ReturnType<typeof resumeFromPlayback>;
  if (playerMode) {
    try {
      const [tracks, playback] = await Promise.all([bridge.getTracks(), bridge.getPlaybackState()]);
      resume = resumeFromPlayback(tracks, playback);
    } catch (err) {
      console.warn('player mode: no playback state:', codeOf(err));
    }
  }
  const sleeved =
    !playerMode &&
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

  const art = await artReady;
  app = new PlayerApp(root, new BridgeTrackSource(bridge), {
    // RACK-3: sealed until this copy has been unwrapped once, then straight to the loaded cartridge.
    wrapped: !playerMode && context ? !context.unwrapped : false,
    sleeved,
    resume,
    canLoadFromSleeve: () => canLoadCopy(copy),
    handoff: false,
    createEngine: (events) => new BridgeAudioEngine(bridge, events),
    // TODO(contract): the bridge has no purchase method yet (CONTRACT.md §11). Closing returns the fan to the
    // native release screen, which has the store.
    onGetLit: () => bridge.close(),
    onMoment,
    // The generated MiniDisc case in LIT's deck; the wear and the edition go on it as soon as it's built.
    cartridge: cartridgeBuilder(design, art, { wearSafeZones: manifest.wearSafeZones }, (result) => {
      built = result;
      built.setWear(latestWear);
      stampedEdition = null;
      stamp();
    }),
    onSceneReady: (parts) => {
      scene = parts.scene;
      // The app's CoreMotion feed (ReleaseHostController): the deck leans only as the phone tilts.
      (window as unknown as { __myindTilt?: (x: number, y: number) => void }).__myindTilt = (x, y) => scene?.setDeviceTilt(x, y);
      stamp();
    },
  });

  await gsapReady;
  await app.mount();
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

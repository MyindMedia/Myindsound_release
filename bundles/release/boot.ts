/**
 * The generic release bundle (PRD §10, BUN-4: new releases need no app update). The same player, bridge contract
 * and behaviour as bundles/lit (sealed or unwrap-once, sleeve mode, insert and eject, wear, edition, lend LCD,
 * haptics, ready), but the cartridge, the printed sleeve and the backdrop are generated from the `design.json`
 * that ships in the release zip (`design/design.json` plus its art), by packages/minidisc. Music plays natively
 * (ARCH-2); the bundle never fetches audio or calls Convex (BUN-5).
 */
import '../../src/player3d/hud.css';
import './fonts.css';
import { SRGBColorSpace, Texture } from 'three';
import { BridgeAudioEngine } from '../../packages/bridge/src/bridge-audio-engine';
import { BridgeTrackSource } from '../../packages/bridge/src/bridge-track-source';
import {
  BridgeError,
  type BridgeContext,
  type HapticKind,
  type MyindBridge,
  type OwnershipPayload,
} from '../../packages/bridge/src/types';
import { ArtBackdrop } from '../../packages/minidisc/src/backdrop';
import type { BuiltCartridge } from '../../packages/minidisc/src/cartridge';
import { ensureFonts } from '../../packages/minidisc/src/canvas';
import { assertDesign, resolveTheme, type DiscDesign } from '../../packages/minidisc/src/design';
import { cartridgeBuilder, loadDesignArt, makeSleevePrints, resolveArtUrl, type LoadedArt } from '../../packages/minidisc/src/minidisc';
import type { WearInput } from '../../src/player3d/wear-render';
import { PlayerApp, type PlayerMoment } from '../../src/player3d/player-app';
import type { PlayerScene } from '../../src/player3d/scene';
import { canLoadCopy, editionOf, lendLine, sleeveModeRequested, type Copy } from '../lit/copy';
import manifest from './bundle.json';

/** Where the zip's design lives, next to index.html. */
const DESIGN_URL = './design/design.json';
/** Soft pulses while the film peels (DS-32): the peel runs about 2.6 s before the sleeve slides. */
const PEEL_PULSES_MS = [0, 650, 1300, 1950];
/** Soft pulses while the card sleeve is pulled off (DS-32): the slide runs about 2 s. */
const SLEEVE_PULSES_MS = [0, 380, 760, 1140, 1520];

export interface BootOverrides {
  /** The harness passes a sample design and a resolver for its art; the zip reads `design/design.json`. */
  design?: DiscDesign;
  resolveArt?(ref: string): string;
}

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

function quietly(promise: Promise<void>, what: string): void {
  promise.catch((err: unknown) => console.warn(`${what} failed:`, codeOf(err)));
}

/** The design and every image it names, from the zip (or the harness). */
async function loadRelease(overrides: BootOverrides): Promise<{ design: DiscDesign; art: LoadedArt }> {
  let design = overrides.design ?? null;
  const base = new URL(DESIGN_URL, document.baseURI).href;
  if (!design) {
    const response = await fetch(base);
    if (!response.ok) throw new Error(`design.json: HTTP ${response.status}`);
    design = assertDesign(await response.json());
  }
  const resolve = overrides.resolveArt ?? ((ref: string) => resolveArtUrl(ref, base));
  // loadDesignArt resolves against `base`; the harness maps each ref to Vite's URL for it instead.
  const mapped: DiscDesign = {
    ...design,
    coverArt: resolve(design.coverArt),
    discArt: design.discArt ? resolve(design.discArt) : undefined,
    theme: design.theme
      ? {
          ...design.theme,
          backdropImage: design.theme.backdropImage ? resolve(design.theme.backdropImage) : undefined,
          backdrop: design.theme.backdrop ? { ...design.theme.backdrop, image: design.theme.backdrop.image ? resolve(design.theme.backdrop.image) : undefined } : undefined,
        }
      : undefined,
  };
  const art = await loadDesignArt(mapped);
  return { design, art };
}

export async function bootRelease(bridge: MyindBridge & { start?(): void }, root: HTMLElement, overrides: BootOverrides = {}): Promise<PlayerApp> {
  let copy: Copy | null = null;
  let app: PlayerApp | null = null;
  let scene = null as PlayerScene | null;
  let built = null as BuiltCartridge | null;
  let stampedEdition: number | null = null;
  let background = false;
  let latestWear: WearInput | null = null;

  const haptic = (kind: HapticKind) => bridge.haptic(kind);

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

  bridge.on('ownership', (payload: OwnershipPayload) => {
    const before = copy ? lendLine(copy) : null;
    copy = { ...payload };
    stamp();
    showLend(lendLine(copy) !== before);
  });
  let lifecycleEvent = false;
  bridge.on('lifecycle', ({ state }) => {
    lifecycleEvent = true;
    background = state === 'background';
    if (background) scene?.stop();
    else scene?.start();
  });
  let wearEvent = false;
  bridge.on('wear', (descriptor) => {
    wearEvent = true;
    latestWear = descriptor;
    built?.setWear(descriptor);
  });
  bridge.start?.();

  const gsapReady = loadGsap();
  // The design and its art come up alongside the context; the fonts before any print is drawn.
  const releaseReady = Promise.all([loadRelease(overrides), ensureFonts()]).then(([release]) => release);
  let context: BridgeContext | null = null;
  try {
    context = await bridge.getContext();
    copy = context;
    if (!lifecycleEvent) background = context.lifecycle === 'background';
    if (!wearEvent) latestWear = context.wear;
  } catch (err) {
    console.warn('getContext failed:', codeOf(err));
  }
  const { design, art } = await releaseReady;
  const theme = resolveTheme(design);
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
        if (owned && copy && !copy.unwrapped) {
          copy = { ...copy, unwrapped: true };
          quietly(bridge.markUnwrapped(), 'markUnwrapped');
        }
        if (copy && editionOf(copy) !== null) haptic('success');
        return;
      case 'sleevePull':
        for (const at of SLEEVE_PULSES_MS) window.setTimeout(() => haptic('soft'), at);
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

  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  app = new PlayerApp(root, new BridgeTrackSource(bridge), {
    wrapped: context ? !context.unwrapped : false,
    sleeved,
    canLoadFromSleeve: () => canLoadCopy(copy),
    handoff: false,
    createEngine: (events) => new BridgeAudioEngine(bridge, events),
    onGetLit: () => bridge.close(),
    onMoment,
    title: design.title,
    // The generated cartridge in LIT's deck; the wear and the edition go on it as soon as it's built.
    cartridge: cartridgeBuilder(design, art, { wearSafeZones: manifest.wearSafeZones }, (result) => {
      built = result;
      built.setWear(latestWear);
      stampedEdition = null;
      stamp();
    }),
    // The printed card sleeve: the cover, and the back and spines set from the tracklist.
    sleeve: async () => {
      const coarse = window.matchMedia('(pointer: coarse)').matches;
      const sleeve = makeSleevePrints(design, art, { quality: coarse ? 'low' : 'high', anisotropy: 8 });
      for (const texture of [sleeve.poster, ...Object.values(sleeve.prints)]) {
        if (texture instanceof Texture) texture.colorSpace = SRGBColorSpace;
      }
      return sleeve;
    },
    // The cover art, blurred and dimmed, behind the deck (design.theme.backdrop).
    createBackdrop: (options) =>
      new ArtBackdrop({
        image: art.backdrop,
        blurPx: theme.backdrop.blurPx,
        scrim: theme.backdrop.scrim,
        reducedMotion: options.reducedMotion || reducedMotion,
      }),
    onSceneReady: (parts) => {
      scene = parts.scene;
      stamp();
    },
  });

  await gsapReady;
  await app.mount();
  if (sleeved) {
    const player = app;
    (window as unknown as { __myindSleeve?: { load(): void } }).__myindSleeve = { load: () => player.loadFromSleeve() };
  }
  if (background) scene?.stop();
  showLend(false);
  requestAnimationFrame(() => requestAnimationFrame(() => bridge.ready()));
  return app;
}

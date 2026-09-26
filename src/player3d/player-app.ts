import { DirectionalLight, HemisphereLight, PointLight, SRGBColorSpace, TextureLoader, type Texture } from 'three';
// convex/values only (no client): importing '../convex' would pull the Convex and Clerk clients into the app bundle.
import { ConvexError } from 'convex/values';
import { markOpened, writeHandoff } from '../playback-handoff';
import { refreshDelayMs, timeToReach } from './audio-math';
import { AudioEngine, type EngineEvents, type PlayerEngine } from './audio-engine';
import { createStudioEnvironment } from './cartridge-detail';
import { ComicCity, type Backdrop } from './backdrop';
import { CART_DEPTH, Deck, type CartridgeBuilder } from './deck';
import { DISC_SOUNDS, DiscMechanics, SPIN_LEAD_SECONDS, SPIN_UP_MOTOR_AT } from './disc-sounds';
import { Hud } from './hud';
import { PLAY_RPM, runEjectSequence, runFloatInSequence, runInsertSequence } from './insert-sequence';
import { CartridgeInspector } from './inspect';
import { DiscWrap, type SleevePrints } from './wrap';
import { loadUnwrapSounds, playUnwrap, prefetchUnwrapSounds } from './wrap-sound';
import { KeyController, type KeyCommand } from './keys';
import { buttonFlash, lcdContent } from './lcd-text';
import { PlayerScene } from './scene';
import { initialState, keyLatches, reduce, type DeckEvent, type DeckState, type SyncStatus } from './state';
import { loadDeckTextures } from './textures';
import type { PlayerTrack, TrackSource } from './track-source';

/** How often the handoff is rewritten while the music runs. */
const HANDOFF_SAVE_MS = 2000;
const PLAY_LOG_AFTER_SEC = 30;
const CALIBRATION_MS = 2000;
const SEEK_RPM_FRACTION = 0.35;
const IDLE_THROTTLE_MS = 10_000;
/** The package squares up to the camera before the unwrap starts. */
const RECENTRE_MS = 520;
/** How long the LCD shows a pressed button (NEXT 03, REPEAT ON) before the deck status again. */
const LCD_FLASH_MS = 900;
/** The sleeve art, small enough to be the first thing on screen (the print-size poster is 30 MB). */
const WRAP_POSTER = '/assets/images/lit-sleeve.webp';
/** The shrink film, from the supplied sheet: crinkle in the alpha, relief in the normal map. */
const WRAP_FILM = '/assets/images/minidisc/wrap-film.webp';
const WRAP_FILM_NORMAL = '/assets/images/minidisc/wrap-film-normal.webp';
/** Bloom: the default, and what the opening scene drops to so the wrapped package keeps its detail. */
const BLOOM_STRENGTH = 0.5;
const INTRO_BLOOM = 0.18;
const VOLUME_KEY = 'myind:player-volume';
/** Sleeve mode: a tap waits this long for a second one (a double-tap resets the view instead of loading). */
const SLEEVE_DOUBLE_TAP_MS = 320;

function hasWebGL(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * The error's code: a Convex `{ code }` error (the site), or a bridge error's `code` (the app bundle, whose
 * `BridgeError` is named so; see packages/bridge). Same answer as `convexErrorCode` for Convex errors.
 */
function errorCode(err: unknown): string | null {
  if (err instanceof ConvexError && typeof err.data === 'object' && err.data && 'code' in err.data) {
    return String((err.data as { code: unknown }).code);
  }
  const code = err instanceof Error && err.name === 'BridgeError' ? (err as Error & { code?: unknown }).code : null;
  if (typeof code === 'string') return code;
  return null;
}

function storedVolume(): number {
  try {
    const value = Number(localStorage.getItem(VOLUME_KEY));
    return Number.isFinite(value) && value > 0 && value <= 1 ? value : 0.8;
  } catch {
    return 0.8;
  }
}

export interface PlayerOptions {
  /** GET LIT in the HUD: opens the pay-what-you-want checkout. */
  onGetLit?(): void;
  /** Hold the cartridge inside its wrapper until `reveal()` (the poster peels first). */
  wrapped?: boolean;
  /**
   * Coming back from another page in the same tab: put the disc back in at the track and the place the
   * mini player left off, and start playing again if it was (`playback-handoff.ts`).
   */
  resume?: { index: number; positionSec: number; playing: boolean };
  /**
   * The audio engine. Defaults to the site's `AudioEngine` (an <audio> element through Web Audio). The app bundle
   * passes `BridgeAudioEngine`, which plays natively (BUN-0, ARCH-2) and reports changes it didn't ask for through
   * `onNativeChange`, which the deck follows with a `sync` (lock screen, auto-advance, a lend ending).
   */
  createEngine?(events: PlayerEngineEvents): PlayerEngine;
  /**
   * Carry the music to the site's other pages (`playback-handoff.ts`). Default true. The app bundle turns it off:
   * there are no other pages, and the handoff stores stream URLs.
   */
  handoff?: boolean;
  /** Mechanical and ceremony beats, for the app's haptics (DS-32) and wear events (§11.2). */
  onMoment?(moment: PlayerMoment): void;
  /** The 3D deck is built (not called on the no-WebGL fallback): the bundle adds its own touches, e.g. the edition. */
  onSceneReady?(parts: { deck: Deck; scene: PlayerScene }): void;
  /**
   * App only, off by default (the site never sets it): open on the printed card sleeve with no shrink film, for a
   * copy that has been unwrapped before (RACK-3). The fan turns and zooms it as in the sealed opening; a tap (or
   * Enter, or `loadFromSleeve()`) slides the sleeve off and inserts the disc. Ignored when `wrapped` is set.
   */
  sleeved?: boolean;
  /** Sleeve mode: whether the disc may be loaded now (false: a copy that is out on loan). Default true. */
  canLoadFromSleeve?(): boolean;
  /**
   * A generated release (packages/minidisc, `bundles/release`), all off by default so the site and LIT are
   * unchanged: the release's name for the HUD, its own cartridge in place of LIT's Canva one, its printed sleeve
   * in place of the LIT poster, and its own backdrop in place of the comic city.
   */
  title?: string;
  cartridge?: CartridgeBuilder;
  sleeve?(): Promise<{ poster: Texture; prints?: SleevePrints } | null>;
  createBackdrop?(options: { reducedMotion: boolean; coarsePointer: boolean; pixelRatio: number }): Backdrop;
}

/** What the audio tells the deck when it moved on its own. `PlaybackFrame` from the bridge satisfies it. */
export interface NativeChange {
  trackId: string | null;
  status: string;
}

export type PlayerEngineEvents = EngineEvents & { onNativeChange?: (change: NativeChange) => void };

/**
 * - `unwrapStart`: the film starts to peel. `unwrapped`: the packaging has left the frame.
 * - `sleevePull`: sleeve mode only, the sleeve starts to slide off (no `unwrapStart` or `unwrapped` follow).
 * - `insertStart`: the cartridge heads for the deck. `seated`: it's in (the deck's `inserted`).
 * - `ejected`: the cartridge is out, in front of the deck. `key`: a transport key or HUD control was pressed.
 */
export type PlayerMoment = 'unwrapStart' | 'unwrapped' | 'sleevePull' | 'insertStart' | 'seated' | 'ejected' | 'key';

/** Composition root: state machine → audio, 3D deck, keys and HUD. */
export class PlayerApp {
  private readonly root: HTMLElement;
  private readonly source: TrackSource;
  private readonly options: PlayerOptions;
  private state: DeckState = initialState();
  private hud!: Hud;
  private engine!: PlayerEngine;
  /** Drive sounds: spin-up, spinning loop, spin-down (fetched now, decoded once audio unlocks). */
  private readonly mechanics = new DiscMechanics();
  private keys!: KeyController;
  private scene: PlayerScene | null = null;
  private deck: Deck | null = null;
  private inspector: CartridgeInspector | null = null;
  private wrap: DiscWrap | null = null;
  private readonly introInput = new AbortController();
  private environment: Texture | null = null;
  private city: Backdrop | null = null;
  private accentLights: { light: PointLight; intensity: number }[] = [];
  private tracks: PlayerTrack[] = [];
  private expiresAt = 0;
  private refreshTimer = 0;
  private listenedSec = 0;
  private playLogged = false;
  private mediaRetries = 0;
  private seekTimer = 0;
  private resumeTimer = 0;
  private lcdFlash: { text: string; until: number } | null = null;
  /** Shown on the LCD in place of NO DISC while the cartridge is out (the app's `PLAYS 03` for a lend, DS-22). */
  private lcdNote: string | null = null;
  private lastInput = performance.now();
  private started = false;
  /** Consumed by the next `engine.load`: where the track was when it was handed over. */
  private resumeAt = 0;
  /** The next insert is a resume, so the disc goes back in without the timeline. */
  private instantInsert = false;
  /** The float-in timeline, kept so an insert can cancel it: it animates the cartridge's own position. */
  private floatIn: { cancel(): void } | null = null;
  private lastHandoffSave = 0;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  constructor(root: HTMLElement, source: TrackSource, options: PlayerOptions = {}) {
    this.root = root;
    this.source = source;
    this.options = options;
  }

  private get sleeved(): boolean {
    return Boolean(this.options.sleeved && !this.options.wrapped);
  }

  /** The wrapping is off: bring the deck, the city and the HUD up behind the disc. */
  private reveal(): void {
    this.introInput.abort();
    if (this.handoff) markOpened();
    this.keys?.setEnabled(true);
    this.scene?.setBloomStrength(BLOOM_STRENGTH);
    window.setTimeout(() => {
      this.wrap?.dispose();
      this.wrap = null;
    }, 1200);
    this.city?.setVisible(true);
    if (this.deck) this.deck.group.visible = true;
    this.inspector?.setIntro(false);
    this.inspector?.activate();
    this.hud.setIntro(false);
    this.keys?.setInspecting(true);
    if (this.sleeved) {
      // Sleeve mode: the disc is out of its sleeve, so it heads straight for the deck (in the same beat, so the
      // inspector's INSERT DISC key never shows).
      this.dispatch({ type: 'insert' });
      return;
    }
    this.options.onMoment?.('unwrapped');
  }

  private get handoff(): boolean {
    return this.options.handoff ?? true;
  }

  /** The LCD's line while the cartridge is out, in place of NO DISC; null puts NO DISC back. */
  setLcdNote(text: string | null): void {
    this.lcdNote = text;
  }

  /** Shows `text` on the LCD for a moment, like a button press does. */
  flashLcd(text: string, ms = LCD_FLASH_MS): void {
    this.lcdFlash = { text, until: performance.now() + ms };
  }

  /** Takes the wrapping off without waiting for a double-click (used straight after a purchase). */
  openPackage(): void {
    this.unwrap();
  }

  async mount(): Promise<void> {
    this.hud = new Hud(this.root, {
      onSelect: (index) => this.dispatch({ type: 'select', index }),
      onInsert: () => this.command('insert'),
      onRepeat: () => this.command('repeat'),
      onVolume: (value) => this.setVolume(value),
      onRetry: () => void this.loadTracks(),
      onGetLit: () => this.options.onGetLit?.(),
    });
    if (this.options.title) this.hud.setTitle(this.options.title);
    const events: PlayerEngineEvents = {
      onTime: (seconds) => this.dispatch({ type: 'tick', positionSec: seconds }),
      onEnded: () => {
        this.logPlayOnce();
        this.dispatch({ type: 'trackEnded' });
      },
      onError: () => void this.recoverFromMediaError(),
      onNativeChange: (change) => this.followAudio(change),
    };
    this.engine = this.options.createEngine ? this.options.createEngine(events) : new AudioEngine(events);
    // Wrapped: the page opens black, with nothing on it but the package once it's ready.
    if (this.options.wrapped || this.sleeved) this.hud.hideBoot();
    const volume = storedVolume();
    this.engine.setVolume(volume);
    this.mechanics.setVolume(volume);
    this.hud.setVolume(volume);

    const sceneReady = hasWebGL() ? this.initScene().catch((err) => this.initFallback(err)) : this.initFallback();
    await Promise.all([sceneReady, this.loadTracks()]);

    this.keys = new KeyController({
      deck: this.deck,
      scene: this.scene,
      canvas: this.scene ? this.hud.canvas : null,
      buttonsHost: this.hud.keysHost,
      onCommand: (command) => this.command(command),
    });
    this.keys.setLatches(keyLatches(this.state));
    this.hud.setBootProgress(1);
    this.hud.hideBoot();
    if (this.scene) this.scene.start();
    else this.startFallbackLoop();
    for (const type of ['pointerdown', 'pointermove', 'wheel', 'keydown']) {
      window.addEventListener(type, () => (this.lastInput = performance.now()), { passive: true });
    }
    this.started = true;
    // Dev only: a handle on the scene graph for debugging from the console.
    if (import.meta.env.DEV) {
      (window as unknown as Record<string, unknown>).__p3d = { app: this, scene: this.scene, deck: this.deck };
    }
    // Coming back mid-song there is nothing to float in: the disc goes straight back into the deck.
    if (this.state.status === 'ejected') {
      this.presentFloating(this.options.wrapped || this.sleeved || Boolean(this.options.resume));
    }
    if (this.options.wrapped) await this.startWrapped();
    else if (this.sleeved) await this.startSleeved();
    else this.startResume();
    // The music carries on to the rest of the site, so the state goes with whoever leaves the page.
    if (this.handoff) {
      window.addEventListener('pagehide', () => this.saveHandoff(true));
      document.addEventListener(
        'visibilitychange',
        () => document.visibilityState === 'hidden' && this.saveHandoff(true),
      );
    }
  }

  /**
   * Back from another page in the same tab, or straight from a purchase: the disc goes back in where the
   * mini player left it, without the insert timeline, and carries on if it was playing.
   */
  private startResume(): void {
    const resume = this.options.resume;
    if (!resume || this.tracks.length === 0 || this.state.status !== 'ejected') return;
    this.resumeAt = Math.max(0, resume.positionSec);
    this.instantInsert = true;
    this.dispatch({ type: 'select', index: Math.max(0, Math.min(resume.index, this.tracks.length - 1)) });
    // Paused when they left it: the disc is in and cued, it just isn't running.
    if (!resume.playing) this.dispatch({ type: 'pause' });
  }

  /** Where the track was when the handoff was written, used once by the next load. */
  private takeResumeAt(): number {
    const at = this.resumeAt;
    this.resumeAt = 0;
    return at;
  }

  /**
   * What the mini player on the other pages picks up: the tracklist, the track, the place and whether it
   * was running. Written while a disc is in, thrown away when there isn't one.
   */
  private saveHandoff(force = false): void {
    if (!this.handoff) return;
    if (!force && performance.now() - this.lastHandoffSave < HANDOFF_SAVE_MS) return;
    this.lastHandoffSave = performance.now();
    const seated = !['booting', 'ejected', 'ejecting', 'inserting'].includes(this.state.status);
    if (!seated || this.tracks.length === 0) return;
    writeHandoff({
      tracks: this.tracks.map((track) => ({
        position: track.position,
        title: track.title,
        streamUrl: track.streamUrl,
        durationSeconds: track.durationSeconds,
      })),
      index: this.state.trackIndex,
      positionSec: this.engine.currentTime,
      playing: this.state.status === 'playing' && this.engine.isPlaying,
      at: Date.now(),
      access: this.source.access?.mode === 'preview' ? 'preview' : 'full',
      volume: this.engine.getVolume(),
    });
  }

  /** Page open (or a retry that loads the tracks): the cartridge floats in front of the empty deck. */
  private presentFloating(instant = false): void {
    this.keys?.setInspecting(true);
    this.scene?.setTiltEnabled(false);
    if (!this.deck || !this.scene || !this.inspector) return;
    this.floatIn?.cancel();
    this.floatIn = runFloatInSequence(this.deck, this.scene, this.inspector, instant);
    this.inspector.activate();
  }

  private async initScene(): Promise<void> {
    const scene = new PlayerScene(this.hud.canvas, this.hud.frame, this.reducedMotion);
    const textures = await loadDeckTextures(scene.renderer.capabilities.getMaxAnisotropy(), (ratio) =>
      this.hud.setBootProgress(ratio * 0.9),
    );
    this.environment = createStudioEnvironment(scene.renderer);
    const deck = new Deck(textures, {
      reducedMotion: this.reducedMotion,
      environment: this.environment,
      quality: scene.coarsePointer ? 'low' : 'high',
      cartridge: this.options.cartridge,
    });
    deck.setCartridgeVisible(false);
    scene.deckRoot.add(deck.group);
    scene.setDeckBounds(deck.bounds);

    const backdropOptions = {
      reducedMotion: this.reducedMotion,
      coarsePointer: scene.coarsePointer,
      pixelRatio: scene.renderer.getPixelRatio(),
    };
    const city = this.options.createBackdrop ? this.options.createBackdrop(backdropOptions) : new ComicCity(backdropOptions);
    scene.scene.add(city.group);
    await city.attach(scene.camera);
    scene.onResize(() => city.fit(scene.camera));

    const key = new DirectionalLight('#ffffff', 1.6);
    key.position.set(1.5, 2.5, 4);
    const pink = new PointLight('#FF3DA8', 6, 9, 1.6);
    pink.position.set(-2.2, 0.4, 1.6);
    const ice = new PointLight('#9FD8FF', 4, 9, 1.6);
    ice.position.set(2.2, -0.6, 1.4);
    scene.scene.add(new HemisphereLight('#9FD8FF', '#1a0a14', 0.9), key, pink, ice);
    this.accentLights = [pink, ice].map((light) => ({ light, intensity: light.intensity }));

    this.inspector = new CartridgeInspector({
      scene,
      deck,
      canvas: this.hud.canvas,
      stageElement: this.hud.stage,
      reducedMotion: this.reducedMotion,
      onInsert: () => this.command('insert'),
    });

    this.scene = scene;
    this.deck = deck;
    this.city = city;
    scene.onFrame((dt, elapsed) => this.onFrame(dt, elapsed));
    this.options.onSceneReady?.({ deck, scene });
  }

  /**
   * The opening scene: the cartridge shrink-wrapped with the LIT poster on it, alone on black. A double-click
   * (or double-tap) unwraps it, and the page comes up behind the bare disc.
   */
  private async startWrapped(): Promise<void> {
    // No WebGL: there's no package to unwrap, so the page opens as itself.
    if (!this.deck || !this.scene || !this.inspector) {
      this.hud.setIntro(false);
      return;
    }
    // Black the page out first: nothing of the site, and no bare cartridge, while the sleeve art loads.
    this.city?.setVisible(false);
    this.deck.group.visible = false;
    this.deck.setCartridgeVisible(false);
    this.inspector.setIntro(true);
    this.hud.setIntro(true, this.scene.coarsePointer);
    this.keys?.setEnabled(false);
    this.scene.setBloomStrength(INTRO_BLOOM);

    const loader = new TextureLoader();
    const [sleeve, film, filmNormal] = await Promise.all([
      this.loadSleeve(),
      loader.loadAsync(WRAP_FILM).catch(() => null),
      loader.loadAsync(WRAP_FILM_NORMAL).catch(() => null),
    ]);
    if (!sleeve || !film || !filmNormal) {
      this.deck.setCartridgeVisible(true);
      this.reveal();
      return;
    }
    const { poster } = sleeve;
    const anisotropy = this.scene.renderer.capabilities.getMaxAnisotropy();
    poster.colorSpace = SRGBColorSpace;
    for (const texture of [poster, film, filmNormal]) texture.anisotropy = anisotropy;
    film.colorSpace = SRGBColorSpace;
    this.wrap = new DiscWrap({
      cartridge: this.deck.cartridge,
      width: this.deck.cartridgeWidth,
      height: this.deck.cartridgeHeight,
      depth: CART_DEPTH,
      poster,
      prints: sleeve.prints,
      film,
      filmNormal,
      environment: this.environment,
      onSleeveStart: () => this.inspector?.settleFront(),
      onReveal: () => this.reveal(),
    });
    // Only now, wrapped, does the cartridge come back on screen.
    this.deck.setCartridgeVisible(true);
    prefetchUnwrapSounds();

    if (this.reducedMotion) {
      this.wrap.finish();
      return;
    }
    // One gesture starts it, and the handlers go with it.
    const canvas = this.hud.canvas;
    const signal = this.introInput.signal;
    let lastTap = 0;
    const unwrap = () => this.unwrap();
    canvas.addEventListener('dblclick', unwrap, { signal });
    canvas.addEventListener(
      'pointerup',
      (event) => {
        if (event.pointerType === 'mouse') return;
        const now = performance.now();
        if (now - lastTap < 400) unwrap();
        lastTap = now;
      },
      { signal },
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        unwrap();
      },
      { signal },
    );
    this.hud.onOpen(unwrap);
  }

  /**
   * Sleeve mode (app only): the cartridge in its printed card sleeve, no film, alone on black, for the fan to turn
   * and zoom. A tap loads it, a double-tap squares it up again (the inspector's own reset is off in the intro).
   */
  private async startSleeved(): Promise<void> {
    if (!this.deck || !this.scene || !this.inspector) {
      this.hud.setIntro(false);
      return;
    }
    this.city?.setVisible(false);
    this.deck.group.visible = false;
    this.deck.setCartridgeVisible(false);
    this.inspector.setIntro(true);
    this.hud.setIntro(true, this.scene.coarsePointer);
    // The app draws its own hint and LOAD key under the sleeve; the sealed package's UNWRAP hint doesn't apply.
    this.hud.hideOpenHint();
    this.keys?.setEnabled(false);
    this.scene.setBloomStrength(INTRO_BLOOM);

    const sleeve = await this.loadSleeve();
    if (!sleeve) {
      this.deck.setCartridgeVisible(true);
      this.reveal();
      return;
    }
    const { poster } = sleeve;
    poster.colorSpace = SRGBColorSpace;
    poster.anisotropy = this.scene.renderer.capabilities.getMaxAnisotropy();
    this.wrap = new DiscWrap({
      cartridge: this.deck.cartridge,
      width: this.deck.cartridgeWidth,
      height: this.deck.cartridgeHeight,
      depth: CART_DEPTH,
      poster,
      prints: sleeve.prints,
      film: null,
      filmNormal: null,
      sleeveOnly: true,
      environment: this.environment,
      onSleeveStart: () => this.inspector?.settleFront(),
      onReveal: () => this.reveal(),
    });
    this.deck.setCartridgeVisible(true);

    const canvas = this.hud.canvas;
    const signal = this.introInput.signal;
    // One finger down and up again, quickly and in place: a tap. A turn, or any second finger (a pinch), isn't.
    let down: { id: number; x: number; y: number; at: number } | null = null;
    let fingers = 0;
    let pending = 0;
    let lastTap = 0;
    canvas.addEventListener(
      'pointerdown',
      (event) => {
        fingers++;
        down = fingers === 1 ? { id: event.pointerId, x: event.clientX, y: event.clientY, at: performance.now() } : null;
      },
      { signal },
    );
    canvas.addEventListener(
      'pointercancel',
      () => {
        fingers = Math.max(0, fingers - 1);
        down = null;
      },
      { signal },
    );
    canvas.addEventListener(
      'pointerup',
      (event) => {
        fingers = Math.max(0, fingers - 1);
        const start = down?.id === event.pointerId ? down : null;
        down = null;
        const now = performance.now();
        if (!start || now - start.at > 260 || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) return;
        window.clearTimeout(pending);
        if (now - lastTap < SLEEVE_DOUBLE_TAP_MS) {
          lastTap = 0;
          this.inspector?.reset();
          return;
        }
        lastTap = now;
        pending = window.setTimeout(() => this.loadFromSleeve(), SLEEVE_DOUBLE_TAP_MS);
      },
      { signal },
    );
    window.addEventListener(
      'keydown',
      (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        this.loadFromSleeve();
      },
      { signal },
    );
    signal.addEventListener('abort', () => window.clearTimeout(pending));
  }

  /** The sleeve's printed faces: the release's own (`options.sleeve`), else the LIT poster. */
  private async loadSleeve(): Promise<{ poster: Texture; prints?: SleevePrints } | null> {
    if (this.options.sleeve) return this.options.sleeve().catch(() => null);
    const poster = await new TextureLoader().loadAsync(WRAP_POSTER).catch(() => null);
    return poster ? { poster } : null;
  }

  /**
   * Sleeve mode: the sleeve slides down and off (the unwrap's second beat, without the film), the deck, the city
   * and the HUD come up, and the bare cartridge floats into the deck. Reduced motion: the sleeve is simply gone.
   * Also called by the app's own LOAD key.
   */
  loadFromSleeve(): void {
    if (!this.sleeved || !this.wrap || this.wrap.unwrapping) return;
    if (this.options.canLoadFromSleeve && !this.options.canLoadFromSleeve()) return;
    this.introInput.abort();
    this.engine.unlock();
    this.mechanics.attach(this.engine.context);
    this.options.onMoment?.('sleevePull');
    if (this.reducedMotion) this.wrap.finish();
    else this.wrap.pullSleeve();
  }

  /** Takes the wrapping off: the sound rides on the same gesture, which is what unlocks audio. */
  private unwrap(): void {
    if (!this.wrap || this.wrap.unwrapping) return;
    this.introInput.abort();
    this.hud.hideOpenHint();
    this.engine.unlock();
    this.mechanics.attach(this.engine.context);
    const context = this.engine.context;
    // However the visitor has turned it, it squares up to the camera first, then the unwrap runs.
    this.inspector?.settleFront();
    window.setTimeout(() => {
      this.wrap?.start();
      this.options.onMoment?.('unwrapStart');
      // Without a gesture behind it the context stays suspended, and the sound would replay later.
      if (context && context.state === 'running') {
        void loadUnwrapSounds(context).then(() => playUnwrap(context, this.engine.getVolume()));
      }
    }, RECENTRE_MS);
  }

  private initFallback(err?: unknown): void {
    if (err) console.error('3D deck unavailable, using the static deck:', err);
    this.scene?.stop();
    this.scene = null;
    this.deck = null;
    this.root.classList.add('p3d--fallback');
    const image = document.createElement('img');
    image.className = 'p3d-fallback-deck';
    image.src = '/assets/images/minidisc/fallback-deck.webp';
    image.alt = 'Myind Sound MiniDisc player';
    this.hud.frame.replaceChildren(image);
  }

  private startFallbackLoop(): void {
    let last = performance.now();
    const loop = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const rect = this.hud.frame.getBoundingClientRect();
      const centre = { x: rect.left + rect.width / 2, y: rect.top + rect.height * 0.36 };
      this.hud.anchor({ ...centre, r: rect.height * 0.22 });
      this.renderHud(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  private onFrame(dt: number, elapsed: number): void {
    const scene = this.scene!;
    const deck = this.deck!;
    this.city?.setAudio({ bass: this.engine.bass(), level: this.engine.level() });
    this.city?.update(dt, elapsed);
    this.keys?.update();
    this.wrap?.update(dt);
    deck.update(dt);
    if (this.lcdFlash && performance.now() > this.lcdFlash.until) this.lcdFlash = null;
    const note = this.state.status === 'ejected' ? this.lcdNote : null;
    deck.setLcd(lcdContent(this.state, this.lcdFlash?.text ?? note));
    this.mechanics.setSpeed(deck.getDiscRpm() / PLAY_RPM);
    this.inspector?.update(dt, elapsed);
    // The neon accents sit near the floating cartridge and would blow out its edges.
    const presence = this.inspector?.getPresence() ?? 0;
    for (const accent of this.accentLights) accent.light.intensity = accent.intensity * (1 - 0.75 * presence);

    const disc = deck.discAnchor();
    const centre = scene.project(disc.centre);
    const edge = scene.project(disc.edge);
    this.hud.anchor({ x: centre.x, y: centre.y, r: Math.hypot(edge.x - centre.x, edge.y - centre.y) });
    // The HUD panels and the city both stay flat: only the deck itself tilts.
    scene.setIdleThrottle(this.state.status === 'ejected' && performance.now() - this.lastInput > IDLE_THROTTLE_MS);
    this.renderHud(dt);
  }

  private renderHud(dt: number): void {
    if (this.state.status === 'playing' && this.engine.isPlaying) {
      this.listenedSec += dt;
      if (this.listenedSec >= PLAY_LOG_AFTER_SEC) this.logPlayOnce();
      this.saveHandoff();
    }
    this.hud.render(
      {
        state: this.state,
        track: this.currentTrack(),
        rpm: this.deck ? this.deck.getDiscRpm() : this.state.status === 'playing' ? PLAY_RPM : 0,
        level: this.engine.level(),
        spectrum: this.engine.spectrum(32),
        waveform: this.engine.waveform(96),
        simulated: this.engine.simulated,
        volume: this.engine.getVolume(),
      },
    );
  }

  private currentTrack(): PlayerTrack | null {
    return this.tracks[this.state.trackIndex] ?? null;
  }

  private async loadTracks(): Promise<void> {
    try {
      const list = await this.source.list();
      if (list.tracks.length === 0) throw new Error('No tracks');
      this.tracks = list.tracks;
      this.expiresAt = list.expiresAt;
      this.hud.setTracks(list.tracks);
      this.hud.setAccess(this.source.access ?? { mode: 'full', via: 'account' });
      this.hud.clearError();
      await this.engine.probe(list.tracks[0].streamUrl);
      this.engine.load(list.tracks[this.state.trackIndex]?.streamUrl ?? list.tracks[0].streamUrl);
      this.dispatch({ type: 'loaded', trackCount: list.tracks.length });
      this.scheduleRefresh();
    } catch (err) {
      const code = errorCode(err);
      if (code === 'UNAUTHENTICATED') {
        window.location.href = `/login.html?redirect=${encodeURIComponent('/')}`;
        return;
      }
      if (code === 'NOT_ENTITLED') this.hud.showError('NO LICENSE FOUND FOR LIT', { label: 'GET LIT', href: '/' });
      else if (code === 'NOT_CONFIGURED') this.hud.showError('AUDIO OFFLINE · TRY AGAIN SOON', { label: 'RETRY' });
      // Bridge errors (the app bundle, CONTRACT.md §8); the site never produces these codes.
      else if (code === 'E_LEND_ENDED') this.hud.showError('THIS LEND HAS ENDED');
      else if (code === 'E_NOT_ALLOWED') this.hud.showError('NOT PLAYABLE ON THIS COPY YET');
      else if (code === 'E_OFFLINE') this.hud.showError('OFFLINE · CONNECT TO PLAY', { label: 'RETRY' });
      else this.hud.showError('SIGNAL LOST · CHECK YOUR CONNECTION', { label: 'RETRY' });
      console.error('Track list failed:', code ?? err);
    }
  }

  private scheduleRefresh(): void {
    window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => void this.refreshLinks(), refreshDelayMs(this.expiresAt, Date.now()));
  }

  /** New signed links; the playing element keeps its current source until the next load. */
  private async refreshLinks(): Promise<boolean> {
    try {
      const list = await this.source.list();
      const byId = new Map(list.tracks.map((track) => [track.id, track.streamUrl]));
      this.tracks = this.tracks.map((track) => ({ ...track, streamUrl: byId.get(track.id) ?? track.streamUrl }));
      this.expiresAt = list.expiresAt;
      this.scheduleRefresh();
      return true;
    } catch (err) {
      console.error('Link refresh failed:', errorCode(err) ?? err);
      this.refreshTimer = window.setTimeout(() => void this.refreshLinks(), 30_000);
      return false;
    }
  }

  private async recoverFromMediaError(): Promise<void> {
    const track = this.currentTrack();
    const status = this.state.status;
    if (!track || status === 'booting' || status === 'ejecting' || status === 'ejected') return;
    if (this.mediaRetries < 2 && (await this.refreshLinks())) {
      this.mediaRetries++;
      const resumeAt = this.engine.currentTime;
      this.engine.load(this.currentTrack()!.streamUrl, resumeAt);
      if (this.state.status === 'playing') void this.engine.play();
      return;
    }
    this.mediaRetries = 0;
    this.lcdFlash = { text: 'READ ERROR', until: performance.now() + 1400 };
    this.dispatch({ type: 'next' });
  }

  private setVolume(value: number): void {
    this.engine.setVolume(value);
    this.mechanics.setVolume(value);
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      /* Private mode: volume just isn't remembered. */
    }
  }

  private command(command: KeyCommand): void {
    this.lastInput = performance.now();
    this.options.onMoment?.('key');
    this.runCommand(command);
    const flash = buttonFlash(command, this.state);
    if (flash) this.lcdFlash = { text: flash, until: performance.now() + LCD_FLASH_MS };
  }

  private runCommand(command: KeyCommand): void {
    const status = this.state.status;
    switch (command) {
      case 'insert':
        this.dispatch({ type: 'insert' });
        return;
      case 'toggle':
        if (status === 'playing' || status === 'resuming') this.dispatch({ type: 'pause' });
        else if (status === 'ejected') this.dispatch({ type: 'insert' });
        else this.dispatch({ type: 'play' });
        return;
      case 'play':
        this.dispatch({ type: 'play' });
        return;
      case 'pause':
        this.dispatch({ type: 'pause' });
        return;
      case 'stop':
        this.dispatch({ type: 'stop' });
        return;
      case 'prev':
        this.dispatch({ type: 'prev' });
        return;
      case 'next':
        this.dispatch({ type: 'next' });
        return;
      case 'red':
        this.dispatch({ type: 'eject' });
        return;
      case 'repeat':
        this.dispatch({ type: 'toggleRepeat' });
        return;
    }
  }

  /** Runs synchronously so audio unlock happens inside the user's gesture. */
  private dispatch(event: DeckEvent): void {
    const prev = this.state;
    const next = reduce(prev, event);
    if (next === prev) return;
    this.state = next;
    if (event.type !== 'tick') {
      this.applyEffects(prev, next, event);
      this.keys?.setLatches(keyLatches(next));
    }
  }

  private applyEffects(prev: DeckState, next: DeckState, event: DeckEvent): void {
    const track = this.tracks[next.trackIndex];
    if (prev.status !== next.status || prev.trackIndex !== next.trackIndex) {
      window.setTimeout(() => this.saveHandoff(true), 0);
    }
    // The drive noise sits under the music while a song runs, and comes back up when it stops.
    this.mechanics.setDucked(next.status === 'playing');
    if (next.status !== 'resuming') window.clearTimeout(this.resumeTimer);

    // The audio moved on its own (app only): the deck follows at once, and nothing is sent back to the audio.
    if (event.type === 'sync') {
      window.clearTimeout(this.seekTimer);
      if (next.trackIndex !== prev.trackIndex && track) {
        this.resetListen();
        this.mediaRetries = 0;
        // BridgeAudioEngine takes this load as "follow native there", without restarting the music.
        this.engine.load(track.streamUrl);
      }
      if (next.status === 'playing') this.deck?.setDiscRpm(PLAY_RPM);
      else if (prev.status !== 'paused' && prev.status !== 'stopped') this.spinDownDisc();
      return;
    }

    // Red key: fade out, spin down, unload, and hand the cartridge to the inspector.
    if (next.status === 'ejecting' && prev.status !== 'ejecting') {
      window.clearTimeout(this.seekTimer);
      this.engine.fadeOutAndStop(0.35);
      if ((this.deck?.getDiscRpm() ?? 0) > 5) this.mechanics.spinDown();
      else this.mechanics.cancelSpinUp();
      this.resetListen();
      this.keys?.setInspecting(true);
      this.scene?.setTiltEnabled(false);
      if (this.deck && this.scene && this.inspector) {
        runEjectSequence(this.deck, this.scene, this.inspector, {
          onUnload: () => this.mechanics.unload(),
          onEjected: () => this.dispatch({ type: 'ejected' }),
        });
      } else {
        this.dispatch({ type: 'ejected' });
      }
      return;
    }
    if (next.status === 'ejected') {
      if (prev.status === 'ejecting') {
        this.inspector?.activate();
        this.options.onMoment?.('ejected');
      }
      else if (this.started) this.presentFloating();
      return;
    }

    if (prev.status === 'ejected' && next.status === 'inserting') {
      this.options.onMoment?.('insertStart');
      const instant = this.instantInsert;
      this.instantInsert = false;
      // The float-in animates the cartridge's own position, so it has to stop before the deck seats it:
      // left running it drags the disc back out of the player a frame later.
      this.floatIn?.cancel();
      this.floatIn = null;
      if (track) this.engine.load(track.streamUrl, this.takeResumeAt());
      this.engine.unlock();
      this.mechanics.attach(this.engine.context);
      this.resetListen();
      this.inspector?.release();
      this.keys?.setInspecting(false);
      this.scene?.setTiltEnabled(true);
      if (this.deck && this.scene) {
        runInsertSequence(
          this.deck,
          this.scene,
          {
            onInserted: () => this.seat(),
            onSpinUp: () => this.mechanics.spinUp(),
            onReady: () => this.dispatch({ type: 'ready' }),
          },
          instant,
        );
      } else {
        this.mechanics.spinUp();
        this.seat();
        this.dispatch({ type: 'ready' });
      }
      return;
    }

    // Track selection: pause, recalibrate the laser (disc dip, CALIBRATING on the LCD) for 2 s, then play.
    if (next.status === 'seeking' && (prev.status !== 'seeking' || next.trackIndex !== prev.trackIndex)) {
      window.clearTimeout(this.seekTimer);
      this.engine.pause();
      this.resetListen();
      this.mediaRetries = 0;
      if (track) this.engine.load(track.streamUrl);
      const waitMs = CALIBRATION_MS;
      // Picked while paused or stopped: the disc was still, so the motor starts again under the calibration.
      if ((this.deck?.getDiscRpm() ?? PLAY_RPM) < 5) this.mechanics.spinUp(SPIN_UP_MOTOR_AT - SPIN_LEAD_SECONDS);
      this.deck?.setDiscRpm(PLAY_RPM * SEEK_RPM_FRACTION);
      const index = next.trackIndex;
      const stillSeeking = () => this.state.status === 'seeking' && this.state.trackIndex === index;
      this.seekTimer = window.setTimeout(() => {
        if (!stillSeeking()) return;
        this.deck?.setDiscRpm(PLAY_RPM);
        this.seekTimer = window.setTimeout(() => stillSeeking() && this.dispatch({ type: 'seeked' }), 800);
      }, waitMs - 800);
      return;
    }
    if (prev.status === 'seeking' && next.status !== 'seeking') {
      window.clearTimeout(this.seekTimer);
      if (next.status === 'playing') {
        void this.engine.play();
        this.engine.fadeIn(0.5);
        this.deck?.setDiscRpm(PLAY_RPM);
      } else {
        if (next.status === 'stopped') this.engine.stop();
        this.spinDownDisc();
      }
      return;
    }

    // Play after a pause or stop: the music waits until the disc is back up to speed.
    if (next.status === 'resuming' && prev.status !== 'resuming') {
      this.resumeDisc();
      return;
    }

    const trackChanged = next.trackIndex !== prev.trackIndex;
    const restarted =
      !trackChanged && next.positionSec === 0 && ['prev', 'select', 'trackEnded'].includes(event.type);
    if ((trackChanged || restarted) && track && next.status !== 'inserting') {
      this.resetListen();
      this.mediaRetries = 0;
      if (trackChanged) this.engine.load(track.streamUrl);
      else this.engine.seek(0);
    }

    if (next.status === 'playing' && (prev.status !== 'playing' || trackChanged || restarted)) {
      if (prev.status === 'reading') {
        this.keys?.press('play');
        void this.engine.play();
        this.engine.fadeIn(0.6);
      } else if (prev.status === 'resuming') {
        // The spin-up curve has just reached full speed.
        void this.engine.play();
        this.engine.fadeIn(0.15);
      } else {
        void this.engine.play();
        this.deck?.setDiscRpm(PLAY_RPM);
      }
    } else if (next.status === 'paused' && prev.status !== 'paused') {
      this.engine.pause();
      this.spinDownDisc();
    } else if (next.status === 'stopped' && prev.status !== 'stopped') {
      this.engine.stop();
      this.spinDownDisc();
    }
  }

  /** The cartridge has seated in the deck. */
  private seat(): void {
    const before = this.state.status;
    this.dispatch({ type: 'inserted' });
    if (before === 'inserting' && this.state.status === 'reading') this.options.onMoment?.('seated');
  }

  /** The audio changed track or play state by itself: the deck follows (a `sync`), without the calibration. */
  private followAudio(change: NativeChange): void {
    const index = this.tracks.findIndex((t) => t.id === change.trackId);
    if (index < 0) return;
    const status: SyncStatus | null =
      change.status === 'playing' || change.status === 'loading'
        ? 'playing'
        : change.status === 'paused'
          ? 'paused'
          : change.status === 'stopped' || change.status === 'ended'
            ? 'stopped'
            : null;
    if (status) this.dispatch({ type: 'sync', index, status });
  }

  /** Pause, stop or the end of the album: the disc winds down with the spin-down sound. */
  private spinDownDisc(): void {
    const rpm = this.deck?.getDiscRpm() ?? 0;
    if (rpm <= 5) {
      // Still (or stopped before a spin-up got the disc moving): nothing to wind down.
      this.deck?.setDiscRpm(0);
      this.mechanics.cancelSpinUp();
      return;
    }
    this.deck?.playRpmCurve(DISC_SOUNDS.spinDown.rpm, rpm);
    this.mechanics.spinDown();
  }

  /**
   * Resuming a loaded disc: the disc starts turning at once (from the motor's point on the curve, or from where
   * its current speed sits on it if it's still winding down), and the motor is heard `SPIN_LEAD_SECONDS` later.
   * `ready` starts the music as the disc reaches full speed.
   */
  private resumeDisc(): void {
    const spinUp = DISC_SOUNDS.spinUp;
    const speed = (this.deck?.getDiscRpm() ?? 0) / PLAY_RPM;
    const from = Math.min(spinUp.duration, Math.max(SPIN_UP_MOTOR_AT, timeToReach(spinUp.rpm, speed)));
    this.deck?.playRpmCurve(spinUp.rpm, PLAY_RPM, from);
    this.mechanics.spinUp(Math.max(0, from - SPIN_LEAD_SECONDS));
    this.resumeTimer = window.setTimeout(
      () => this.state.status === 'resuming' && this.dispatch({ type: 'ready' }),
      (spinUp.duration - from) * 1000,
    );
  }

  private resetListen(): void {
    this.listenedSec = 0;
    this.playLogged = false;
  }

  private logPlayOnce(): void {
    const track = this.currentTrack();
    if (this.playLogged || !track) return;
    this.playLogged = true;
    this.source.logPlay(track.id).catch((err) => console.warn('Play log failed:', errorCode(err) ?? err));
  }
}

import { BridgeEmitter } from './emitter';
import { idleState, nextIndex, previousIndex, silentFrame } from './playback-rules';
import {
  BridgeError,
  SPECTRUM_BANDS,
  WAVEFORM_SAMPLES,
  type BridgeContext,
  type BridgeEvent,
  type BridgeEventMap,
  type BridgeTrack,
  type HapticKind,
  type LayoutState,
  type MyindBridge,
  type PlaybackFrame,
  type PlaybackState,
  type PlaybackStatus,
  type Unsubscribe,
} from './types';
import { validateParams } from './validate';

/**
 * BUN-6: the bridge on the website. Same contract, but the audio is an HTML audio engine in the page and the data
 * comes from the site's Convex client. Everything is injected, so this file never imports the site or Convex; the
 * site wires it (see CONTRACT.md "Web adapter wiring").
 */

/** What the adapter needs from `src/player3d/audio-engine.ts` (`AudioEngine` satisfies it as is). */
export interface WebAudioEngine {
  readonly currentTime: number;
  readonly isPlaying: boolean;
  /** True until the element is routed through Web Audio (then the spectrum is real). */
  readonly simulated: boolean;
  /** The raw element, when the engine has one: a late routing leaves it muted, and the adapter un-mutes it. */
  readonly element?: { volume: number };
  /** CORS check for the media origin; routing only happens after it passed. */
  probe(url: string): Promise<void>;
  load(url: string, startAt?: number): void;
  unlock(): void;
  play(): Promise<boolean>;
  pause(): void;
  stop(): void;
  setVolume(value: number): void;
  /** From silence up to the set volume. AudioEngine's gain starts at 0 and `unlock` mutes an unrouted element. */
  fadeIn(seconds: number): void;
  spectrum(bins: number): number[];
  waveform(count: number): number[];
  bass(): number;
  level(): number;
}

export interface WebAudioEngineEvents {
  onTime?: (seconds: number) => void;
  onEnded?: () => void;
  onError?: () => void;
}

/** `(events) => new AudioEngine(events)` on the site. */
export type WebAudioEngineFactory = (events: WebAudioEngineEvents) => WebAudioEngine;

/** A track as the site's track sources return it (`PlayerTrack` fits): the URL stays inside the adapter. */
export interface WebTrack {
  id: string;
  position: number;
  title: string;
  durationSeconds: number;
  streamUrl: string;
}

export interface WebTrackList {
  tracks: WebTrack[];
  /** Epoch ms when the stream links expire; the adapter refetches before loading a track past this. */
  expiresAt: number;
  /** The site fell back to the 30 second previews. */
  preview: boolean;
}

/** The context minus what the adapter fills in itself (platform, layout, lifecycle). */
export type WebContextData = Omit<BridgeContext, 'platform' | 'layout' | 'lifecycle'>;

export interface WebAdapterProviders {
  getContext(): Promise<WebContextData>;
  getTracks(): Promise<WebTrackList>;
  /** Server side, e.g. a Convex mutation. Absent: resolves without persisting. */
  markUnwrapped?(): Promise<void>;
  cartridgeLoaded?(): Promise<void>;
  cartridgeEjected?(): Promise<void>;
  /** The site's play log (`api.plays.log`), called once per track start after PLAY_LOG_AFTER_SEC. */
  logPlay?(trackId: string): Promise<void>;
  /** Absent: E_NOT_SUPPORTED. */
  requestShare?(): Promise<void>;
  /** Lends need the app (PRD §2): absent means E_NOT_SUPPORTED; the site can show a "get the app" sheet instead. */
  requestLend?(): Promise<void>;
  close?(): void;
  haptic?(kind: HapticKind): void;
  playSound?(name: string): void;
  ready?(): void;
}

export interface WebAdapterEnvironment {
  readonly innerWidth: number;
  readonly innerHeight: number;
  addEventListener(type: 'resize', listener: () => void): void;
  removeEventListener(type: 'resize', listener: () => void): void;
  document?: {
    readonly visibilityState: string;
    addEventListener(type: 'visibilitychange', listener: () => void): void;
    removeEventListener(type: 'visibilitychange', listener: () => void): void;
  };
  requestAnimationFrame?(callback: () => void): number;
  cancelAnimationFrame?(handle: number): void;
}

export interface WebAdapterOptions {
  createEngine: WebAudioEngineFactory;
  providers: WebAdapterProviders;
  /** Defaults to `window` when there is one. */
  environment?: WebAdapterEnvironment | null;
  /** Epoch ms clock (for link expiry). */
  now?: () => number;
  /** Frame loop; defaults to requestAnimationFrame, or a 16 ms timer without it. */
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

/** Same threshold the player uses before a listen counts (`PLAY_LOG_AFTER_SEC` in `player-app.ts`). */
export const PLAY_LOG_AFTER_SEC = 30;
/** Refetch links this long before they expire (matches REFRESH_MARGIN_MS in `audio-math.ts`). */
export const LINK_REFRESH_MARGIN_MS = 10 * 60_000;
/** Fade after every start or resume: brings AudioEngine's gain (or an unrouted element) up from 0 without a click. */
export const START_FADE_SEC = 0.15;
/** Below this width the layout reports `compact`, like an iPhone in portrait. */
export const REGULAR_MIN_WIDTH_PT = 700;

export function webLayout(width: number, height: number): LayoutState {
  return {
    widthPt: width,
    heightPt: height,
    sizeClass: width >= REGULAR_MIN_WIDTH_PT ? 'regular' : 'compact',
    posture: 'standard',
  };
}

export class WebBridgeAdapter implements MyindBridge {
  private readonly emitter = new BridgeEmitter();
  private readonly engine: WebAudioEngine;
  private readonly providers: WebAdapterProviders;
  private readonly env: WebAdapterEnvironment | null;
  private readonly now: () => number;
  private readonly requestFrame: (callback: () => void) => number;
  private readonly cancelFrame: (handle: number) => void;
  private list: WebTrackList | null = null;
  private listLoad: Promise<WebTrackList> | null = null;
  private trackIndex = -1;
  private loadedUrl: string | null = null;
  private status: PlaybackStatus = 'idle';
  private frameHandle: number | null = null;
  private frameGeneration = 0;
  private playLogged = false;
  private probed = false;
  private rerouteAfterProbe = false;
  /** Bumped by every start and pause, so a slow `engine.play()` can't overrule a later call. */
  private epoch = 0;
  private readonly detach: Array<() => void> = [];

  constructor(options: WebAdapterOptions) {
    this.providers = options.providers;
    this.now = options.now ?? Date.now;
    this.env =
      options.environment !== undefined
        ? options.environment
        : typeof window !== 'undefined'
          ? (window as unknown as WebAdapterEnvironment)
          : null;
    const env = this.env;
    this.requestFrame =
      options.requestFrame ??
      (env?.requestAnimationFrame ? (cb) => env.requestAnimationFrame!(cb) : (cb) => setTimeout(cb, 16) as unknown as number);
    this.cancelFrame =
      options.cancelFrame ?? (env?.cancelAnimationFrame ? (h) => env.cancelAnimationFrame!(h) : (h) => clearTimeout(h));
    this.engine = options.createEngine({
      onTime: (seconds) => this.onTime(seconds),
      onEnded: () => void this.onEnded(),
      onError: () => this.setStatus('error'),
    });
    this.listen();
  }

  // ── Contract ──────────────────────────────────────────────────────────────────────────────────────────

  async getContext(): Promise<BridgeContext> {
    const data = await this.providers.getContext();
    const hidden = this.env?.document?.visibilityState === 'hidden';
    return { ...data, platform: 'web', layout: this.layout(), lifecycle: hidden ? 'background' : 'foreground' };
  }

  async getTracks(): Promise<BridgeTrack[]> {
    const list = await this.tracks(true);
    return list.tracks.map((track) => ({
      id: track.id,
      position: track.position,
      title: track.title,
      durationSeconds: track.durationSeconds,
      preview: list.preview,
    }));
  }

  /** Call inside the user gesture that starts audio (the insert tap): browsers only allow audio from one. */
  unlock(): void {
    // Before the CORS probe finished, AudioEngine can't route yet: do it on the next start (see `route`).
    this.rerouteAfterProbe = !this.probed;
    this.engine.unlock();
  }

  async play(trackId: string, startAt?: number): Promise<void> {
    const params = validateParams('play', startAt === undefined ? { trackId } : { trackId, startAt });
    const list = await this.tracks(false);
    const index = list.tracks.findIndex((track) => track.id === params.trackId);
    if (index < 0) throw new BridgeError('E_NOT_FOUND', 'Track is not in this release', 'play');
    if (params.startAt === undefined && index === this.trackIndex && this.status === 'paused') {
      await this.resume();
      return;
    }
    await this.start(index, params.startAt ?? 0);
  }

  async setVolume(volume: number): Promise<void> {
    const params = validateParams('setVolume', { volume });
    this.engine.setVolume(params.volume);
  }

  async pause(): Promise<void> {
    if (this.status !== 'playing' && this.status !== 'loading') return;
    this.epoch++;
    this.engine.pause();
    this.setStatus('paused');
  }

  async seek(seconds: number): Promise<void> {
    const params = validateParams('seek', { seconds });
    const track = this.current();
    if (!track || !this.loadedUrl) return;
    const target = Math.min(params.seconds, track.durationSeconds);
    // `load` on the file that's already loaded seeks it (AudioEngine semantics).
    this.engine.load(this.loadedUrl, target);
    if (this.status === 'ended') this.setStatus('paused');
    else this.emitFrame();
  }

  async next(): Promise<void> {
    const list = await this.tracks(false);
    const index = nextIndex(this.bridgeTracks(list), this.trackIndex);
    if (index !== null) await this.start(index, 0);
  }

  async previous(): Promise<void> {
    if (this.trackIndex < 0) return;
    await this.start(previousIndex(this.trackIndex, this.engine.currentTime), 0);
  }

  async getPlaybackState(): Promise<PlaybackState> {
    return this.state();
  }

  async markUnwrapped(): Promise<void> {
    await this.providers.markUnwrapped?.();
  }

  async cartridgeLoaded(): Promise<void> {
    await this.providers.cartridgeLoaded?.();
  }

  async cartridgeEjected(): Promise<void> {
    await this.providers.cartridgeEjected?.();
  }

  haptic(kind: HapticKind): void {
    const params = validateParams('haptic', { kind });
    this.providers.haptic?.(params.kind);
  }

  playSound(name: string): void {
    const params = validateParams('playSound', { name });
    this.providers.playSound?.(params.name);
  }

  async requestShare(): Promise<void> {
    if (!this.providers.requestShare) throw new BridgeError('E_NOT_SUPPORTED', 'Sharing is not available on the web', 'requestShare');
    await this.providers.requestShare();
  }

  async requestLend(): Promise<void> {
    if (!this.providers.requestLend) throw new BridgeError('E_NOT_SUPPORTED', 'Lending needs the app', 'requestLend');
    await this.providers.requestLend();
  }

  close(): void {
    this.providers.close?.();
  }

  ready(): void {
    this.providers.ready?.();
  }

  on<E extends BridgeEvent>(event: E, handler: (payload: BridgeEventMap[E]) => void): Unsubscribe {
    const off = this.emitter.on(event, handler);
    if (event === 'playback') this.syncFrameLoop();
    return () => {
      off();
      this.syncFrameLoop();
    };
  }

  dispose(): void {
    this.engine.pause();
    this.stopFrameLoop();
    for (const undo of this.detach.splice(0)) undo();
    this.emitter.clear();
  }

  // ── Internals ─────────────────────────────────────────────────────────────────────────────────────────

  private layout(): LayoutState {
    return webLayout(this.env?.innerWidth ?? 0, this.env?.innerHeight ?? 0);
  }

  private listen(): void {
    const env = this.env;
    if (!env) return;
    const onResize = () => this.emitter.emit('layout', this.layout());
    env.addEventListener('resize', onResize);
    this.detach.push(() => env.removeEventListener('resize', onResize));
    const doc = env.document;
    if (doc) {
      const onVisibility = () =>
        this.emitter.emit('lifecycle', { state: doc.visibilityState === 'hidden' ? 'background' : 'foreground' });
      doc.addEventListener('visibilitychange', onVisibility);
      this.detach.push(() => doc.removeEventListener('visibilitychange', onVisibility));
    }
  }

  /** The tracklist, refetched when missing or (for loading audio) when the links are about to expire. */
  private async tracks(cachedOk: boolean): Promise<WebTrackList> {
    const fresh = this.list && (cachedOk || this.list.expiresAt - LINK_REFRESH_MARGIN_MS > this.now());
    if (fresh) return this.list!;
    this.listLoad ??= this.providers.getTracks().finally(() => {
      this.listLoad = null;
    });
    const list = await this.listLoad;
    if (list.tracks.length === 0) throw new BridgeError('E_NOT_ALLOWED', 'No tracks available', 'getTracks');
    this.list = list;
    // Before the first unlock if possible: AudioEngine routes through Web Audio (a real spectrum) only after this.
    await this.engine.probe(list.tracks[0].streamUrl);
    this.probed = true;
    return list;
  }

  private bridgeTracks(list: WebTrackList): BridgeTrack[] {
    return list.tracks.map((track) => ({ ...track, preview: list.preview }));
  }

  private current(): WebTrack | null {
    return this.list?.tracks[this.trackIndex] ?? null;
  }

  private async start(index: number, startAt: number): Promise<void> {
    const list = await this.tracks(false);
    const track = list.tracks[index];
    if (!track) throw new BridgeError('E_NOT_FOUND', 'Track is not in this release', 'play');
    this.route();
    this.trackIndex = index;
    this.playLogged = false;
    this.loadedUrl = track.streamUrl;
    // A new file starts at `startAt`; the file already loaded is sought there (AudioEngine semantics).
    this.engine.load(track.streamUrl, startAt);
    this.setStatus('loading');
    await this.resume();
  }

  private async resume(): Promise<void> {
    const epoch = ++this.epoch;
    const started = await this.engine.play();
    // A pause, or another track, arrived while the browser was starting this one: that call wins.
    if (epoch !== this.epoch) return;
    if (!started) {
      this.setStatus('paused');
      throw new BridgeError('E_NOT_ALLOWED', 'The browser blocked playback until the next tap', 'play');
    }
    // AudioEngine starts its gain at 0 (and mutes an unrouted element in unlock): bring the level up.
    this.engine.fadeIn(START_FADE_SEC);
    this.setStatus('playing');
  }

  /**
   * Unlocked in a gesture before the CORS probe finished: the element is still unrouted. Unlocking again now
   * routes it through the (already resumed) context, and a late-routed element was muted by the first unlock, so it
   * goes back to full level (the gain carries the volume once routed). Never creates a context outside a gesture.
   */
  private route(): void {
    if (!this.rerouteAfterProbe || !this.probed) return;
    this.rerouteAfterProbe = false;
    if (!this.engine.simulated) return;
    this.engine.unlock();
    if (!this.engine.simulated && this.engine.element) this.engine.element.volume = 1;
  }

  private state(): PlaybackState {
    const track = this.current();
    return track
      ? {
          trackId: track.id,
          status: this.status,
          positionSec: this.engine.currentTime,
          durationSec: track.durationSeconds,
          rate: this.status === 'playing' ? 1 : 0,
        }
      : idleState();
  }

  private setStatus(status: PlaybackStatus): void {
    this.status = status;
    this.emitFrame();
    this.syncFrameLoop();
  }

  private frame(): PlaybackFrame {
    const state = this.state();
    if (state.status !== 'playing') return silentFrame(state);
    return {
      ...state,
      bands: this.engine.spectrum(SPECTRUM_BANDS),
      waveform: this.engine.waveform(WAVEFORM_SAMPLES),
      level: this.engine.level(),
      bass: this.engine.bass(),
    };
  }

  private emitFrame(): void {
    if (this.emitter.listenerCount('playback') > 0) this.emitter.emit('playback', this.frame());
  }

  /** Frames run only while something is playing and someone is listening. */
  private syncFrameLoop(): void {
    const wanted = () => this.status === 'playing' && this.emitter.listenerCount('playback') > 0;
    if (wanted() && this.frameHandle === null) {
      const generation = ++this.frameGeneration;
      const loop = () => {
        // A callback from a loop that has since stopped (or been replaced): let it lapse.
        if (generation !== this.frameGeneration) return;
        if (!wanted()) {
          this.frameHandle = null;
          return;
        }
        this.frameHandle = this.requestFrame(loop);
        this.emitFrame();
      };
      this.frameHandle = this.requestFrame(loop);
    } else if (!wanted()) {
      this.stopFrameLoop();
    }
  }

  private stopFrameLoop(): void {
    this.frameGeneration++;
    if (this.frameHandle !== null) this.cancelFrame(this.frameHandle);
    this.frameHandle = null;
  }

  private onTime(seconds: number): void {
    const track = this.current();
    if (!track || this.playLogged || this.status !== 'playing' || seconds < PLAY_LOG_AFTER_SEC) return;
    this.logPlay(track.id);
  }

  private logPlay(trackId: string): void {
    this.playLogged = true;
    this.providers.logPlay?.(trackId).catch((err: unknown) => console.warn('Play log failed:', err));
  }

  /** Native semantics: the next track starts on its own; after the last one the status is `ended`. */
  private async onEnded(): Promise<void> {
    const track = this.current();
    if (track && !this.playLogged) this.logPlay(track.id);
    const list = this.list;
    const index = list ? nextIndex(this.bridgeTracks(list), this.trackIndex) : null;
    if (index === null) {
      this.setStatus('ended');
      return;
    }
    try {
      await this.start(index, 0);
    } catch {
      this.setStatus('error');
    }
  }
}

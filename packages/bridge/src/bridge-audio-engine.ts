import { trackIdFromUrl } from './bridge-track-source';
import { silentFrame } from './playback-rules';
import { BridgeError, type MyindBridge, type PlaybackFrame, type Unsubscribe } from './types';

/**
 * BUN-0 / BRG-4: the player's audio engine inside the app. It has the public surface of `AudioEngine`
 * (`src/player3d/audio-engine.ts`) that `player-app.ts` drives, plus `seek`, but the music plays natively: calls
 * go over the bridge, and position, spectrum, waveform, level and bass come back in `playback` frames. The deck
 * state machine stays in the bundle and calls this, exactly as it calls `AudioEngine` on the web.
 *
 * Mechanical and wrap sounds stay in the bundle's Web Audio (NAT-6), so `unlock()` still creates the
 * AudioContext they need.
 */

export interface BridgeEngineEvents {
  onTime?: (seconds: number) => void;
  onEnded?: () => void;
  onError?: () => void;
  /**
   * Native changed track or play state without the bundle asking (lock screen or Control Center, RACK-5; an audio
   * interruption; the next track starting on its own). Without this handler a native track change is reported
   * as `onEnded`, which is right for the end of a track and wrong for a lock-screen "previous".
   */
  onNativeChange?: (frame: PlaybackFrame) => void;
}

export interface BridgeAudioEngineOptions {
  /** The AudioContext for the mechanical sounds. Defaults to `window.AudioContext`. */
  createContext?: () => AudioContext | null;
  /** Monotonic ms clock, for interpolating the position between frames. */
  now?: () => number;
}

/** `onTime` cadence, matching `AudioEngine`'s throttled `timeupdate`. */
const TIME_EMIT_MS = 240;

/** A bridge that needs a user gesture to start audio (the web adapter) exposes this outside the wire contract. */
interface Unlockable {
  unlock(): void;
}
const hasUnlock = (bridge: unknown): bridge is Unlockable => typeof (bridge as Unlockable).unlock === 'function';

function resample(source: readonly number[], count: number): number[] {
  if (count <= 0) return [];
  if (source.length === 0) return new Array(count).fill(0);
  if (count >= source.length) {
    return Array.from({ length: count }, (_, i) => source[Math.min(source.length - 1, Math.floor((i * source.length) / count))]);
  }
  // Fewer bins than bands: average each group, so energy isn't dropped.
  return Array.from({ length: count }, (_, i) => {
    const from = Math.floor((i * source.length) / count);
    const to = Math.max(from + 1, Math.floor(((i + 1) * source.length) / count));
    let sum = 0;
    for (let j = from; j < to; j++) sum += source[j];
    return sum / (to - from);
  });
}

function defaultContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  return Ctor ? new Ctor() : null;
}

export class BridgeAudioEngine {
  private readonly bridge: MyindBridge;
  private readonly events: BridgeEngineEvents;
  private readonly createContext: () => AudioContext | null;
  private readonly now: () => number;
  private readonly unsubscribe: Unsubscribe[];
  private ctx: AudioContext | null = null;
  private frame: PlaybackFrame | null = null;
  private receivedAt = 0;
  /** The track the player has loaded, by id. */
  private loaded: string | null = null;
  /** Loaded but not yet sent to native: where it should start. */
  private pendingStart: number | null = null;
  /** Native moved on to this track by itself (end of a track); the player's next `load` of it is absorbed. */
  private advancedTo: string | null = null;
  private wantsPlayback = false;
  private volume = 0.8;
  /** `fadeOutAndStop` took the level to 0; the next `fadeIn` or `play` restores it. */
  private muted = false;
  private lastTimeEmit = 0;
  /** Counts frames, so a `getPlaybackState` answer older than the latest frame is ignored. */
  private frameSeq = 0;

  constructor(bridge: MyindBridge, events: BridgeEngineEvents = {}, options: BridgeAudioEngineOptions = {}) {
    this.bridge = bridge;
    this.events = events;
    this.createContext = options.createContext ?? defaultContext;
    this.now = options.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : Date.now()));
    this.unsubscribe = [
      bridge.on('playback', (frame) => this.onFrame(frame)),
      // Frames are not delivered while the web view is suspended: catch up when it comes back.
      bridge.on('lifecycle', ({ state }) => state === 'foreground' && this.resync()),
    ];
    this.resync();
  }

  /**
   * Reads native's playback state and applies it as a frame, so a frame lost before the bundle subscribed (or
   * while it was in the background) can't leave the deck out of step. Runs on creation and on every foreground.
   */
  resync(): Promise<void> {
    const seq = this.frameSeq;
    return this.bridge.getPlaybackState().then(
      (state) => {
        if (seq === this.frameSeq) this.onFrame(silentFrame(state));
      },
      (err: unknown) => console.warn('Bridge playback resync failed:', err instanceof BridgeError ? err.code : err),
    );
  }

  /** The Web Audio context for the mechanical sounds, once `unlock()` has created it. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Simulated until native has sent a frame; after that the spectrum is the real music. */
  get simulated(): boolean {
    return this.frame === null;
  }

  get currentTime(): number {
    if (this.pendingStart !== null) return this.pendingStart;
    const frame = this.frame;
    if (!frame || frame.trackId !== this.loaded) return 0;
    const drift = frame.status === 'playing' ? (frame.rate * (this.now() - this.receivedAt)) / 1000 : 0;
    return Math.max(0, Math.min(frame.durationSec ?? Infinity, frame.positionSec + drift));
  }

  get isPlaying(): boolean {
    return this.wantsPlayback && this.pendingStart === null && this.nativeIsPlaying(this.loaded);
  }

  /** Nothing to probe: native owns the media. */
  async probe(): Promise<void> {}

  /**
   * Same contract as `AudioEngine.load`: a new track is cued at `startAt` (it starts on `play`), the track already
   * loaded is sought to `startAt`, and switching tracks silences the old one.
   */
  load(url: string, startAt = 0): void {
    const id = trackIdFromUrl(url);
    if (!id) throw new BridgeError('E_INVALID_PARAMS', 'BridgeAudioEngine needs a bridgeTrackUrl()', 'play');
    const at = Math.max(0, startAt);
    if (this.advancedTo === id && at <= 0) {
      this.advancedTo = null;
      this.loaded = id;
      this.pendingStart = null;
      return;
    }
    this.advancedTo = null;
    // Native already has this track (loaded by us, or playing before this engine existed): same file, so seek.
    if (this.pendingStart === null && this.frame?.trackId === id && (this.loaded === id || this.loaded === null)) {
      this.loaded = id;
      this.seek(at);
      return;
    }
    if (this.frame?.trackId && this.frame.trackId !== id && this.frame.status === 'playing') void this.call(this.bridge.pause());
    this.loaded = id;
    this.pendingStart = at;
  }

  /** Runs inside the user gesture: the context for the mechanical sounds, and the web adapter's audio unlock. */
  unlock(): void {
    if (!this.ctx) this.ctx = this.createContext();
    void this.ctx?.resume().catch(() => {});
    if (hasUnlock(this.bridge)) this.bridge.unlock();
  }

  async play(): Promise<boolean> {
    this.wantsPlayback = true;
    const id = this.loaded;
    if (!id) return false;
    try {
      if (this.muted) this.restoreLevel();
      if (this.pendingStart !== null) {
        // A load cued this track: start exactly there, from 0 included, never resume an older position.
        const at = this.pendingStart;
        this.pendingStart = null;
        await this.bridge.play(id, at);
        return true;
      }
      if (!this.nativeIsPlaying(id)) await this.bridge.play(id);
      return true;
    } catch {
      return false;
    }
  }

  pause(): void {
    this.wantsPlayback = false;
    if (this.loaded && this.pendingStart === null) void this.call(this.bridge.pause());
  }

  stop(): void {
    this.pause();
    if (this.pendingStart !== null) this.pendingStart = 0;
    else if (this.loaded) this.seek(0);
  }

  /**
   * Not on `AudioEngine` today: `player-app.ts` sets `engine.element.currentTime = 0` directly, which BUN-0 has to
   * replace with `engine.seek(0)` (see CONTRACT.md "BUN-0 integration").
   */
  seek(seconds: number): void {
    const at = Math.max(0, seconds);
    if (this.pendingStart !== null) {
      this.pendingStart = at;
      return;
    }
    if (this.frame && this.frame.trackId === this.loaded) {
      // Show the new place at once; native's next frame confirms it.
      this.frame = { ...this.frame, positionSec: at };
      this.receivedAt = this.now();
    }
    void this.call(this.bridge.seek(at));
  }

  /** The HUD slider: the player's own music level (native `setVolume`, the web adapter's AudioEngine gain). */
  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    this.muted = false;
    void this.call(this.bridge.setVolume(this.volume));
  }

  getVolume(): number {
    return this.volume;
  }

  /** Brings the level back after `fadeOutAndStop`. Native ramps level changes itself (CONTRACT.md §4). */
  fadeIn(_seconds?: number): void {
    if (this.muted) this.restoreLevel();
  }

  /** Eject: like `AudioEngine`, the level goes to 0 while the disc spins down, then it stops and rewinds. */
  fadeOutAndStop(seconds: number): void {
    this.wantsPlayback = false;
    this.muted = true;
    void this.call(this.bridge.setVolume(0));
    setTimeout(() => {
      if (!this.wantsPlayback) this.stop();
    }, seconds * 1000);
  }

  waveform(count: number): number[] {
    return this.isPlaying && this.frame ? resample(this.frame.waveform, count) : new Array(count).fill(0);
  }

  spectrum(bins: number): number[] {
    return this.isPlaying && this.frame ? resample(this.frame.bands, bins) : new Array(bins).fill(0);
  }

  bass(): number {
    return this.isPlaying && this.frame ? this.frame.bass : 0;
  }

  level(): number {
    return this.isPlaying && this.frame ? this.frame.level : 0;
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
  }

  private restoreLevel(): void {
    this.muted = false;
    void this.call(this.bridge.setVolume(this.volume));
  }

  private nativeIsPlaying(id: string | null): boolean {
    return id !== null && this.frame?.trackId === id && this.frame.status === 'playing';
  }

  private call(promise: Promise<void>): Promise<void> {
    return promise.catch((err: unknown) => {
      console.warn('Bridge playback call failed:', err instanceof BridgeError ? err.code : err);
    });
  }

  private onFrame(frame: PlaybackFrame): void {
    this.frameSeq++;
    const prev = this.frame;
    this.frame = frame;
    this.receivedAt = this.now();
    const loaded = this.loaded;
    if (!loaded || this.pendingStart !== null) return;

    // Native moved off the loaded track by itself: the end of a track (it keeps going in the background), or a
    // remote next / previous. The player's next `load` of that track is absorbed, so the music doesn't restart.
    if (prev?.trackId === loaded && frame.trackId && frame.trackId !== loaded) {
      this.advancedTo = frame.trackId;
      if (this.events.onNativeChange) this.events.onNativeChange(frame);
      else if (this.wantsPlayback) this.events.onEnded?.();
      return;
    }
    if (frame.trackId !== loaded) return;
    if (frame.status === 'ended' && prev?.status !== 'ended') {
      this.events.onEnded?.();
      return;
    }
    if (frame.status === 'error' && prev?.status !== 'error') {
      this.events.onError?.();
      return;
    }
    // Paused or resumed from outside the bundle: follow native, and tell the player if it listens.
    const unrequestedPause =
      (frame.status === 'paused' || frame.status === 'stopped') && prev?.status === 'playing' && this.wantsPlayback;
    const unrequestedPlay = frame.status === 'playing' && prev?.status === 'paused' && !this.wantsPlayback;
    if (unrequestedPause || unrequestedPlay) {
      this.wantsPlayback = unrequestedPlay;
      this.events.onNativeChange?.(frame);
    }
    if (frame.status === 'playing' && this.receivedAt - this.lastTimeEmit > TIME_EMIT_MS) {
      this.lastTimeEmit = this.receivedAt;
      this.events.onTime?.(frame.positionSec);
    }
  }
}

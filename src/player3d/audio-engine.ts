import { bandLevel, logBins, rmsLevel } from './audio-math';

export type EngineEvents = {
  onTime?: (seconds: number) => void;
  onEnded?: () => void;
  onError?: () => void;
};

/**
 * One <audio> element routed through Web Audio (gain + analyser) when the media origin allows CORS.
 * iOS ignores element.volume, so fades and volume go through the GainNode.
 * Without CORS the element plays directly and the spectrum is simulated (`simulated === true`),
 * because MediaElementSource outputs silence for non-CORS media.
 */
export class AudioEngine {
  readonly element: HTMLAudioElement;
  private ctx: AudioContext | null = null;
  private gain: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private routed = false;
  private corsAllowed: boolean | null = null;
  private freqData = new Uint8Array(1024);
  private timeData = new Uint8Array(2048);
  private volume = 0.8;
  private lastTimeEmit = 0;
  private wantsPlayback = false;

  constructor(events: EngineEvents = {}) {
    this.element = new Audio();
    this.element.crossOrigin = 'anonymous';
    this.element.preload = 'auto';
    this.element.addEventListener('timeupdate', () => {
      const now = performance.now();
      if (now - this.lastTimeEmit > 240) {
        this.lastTimeEmit = now;
        events.onTime?.(this.element.currentTime);
      }
    });
    this.element.addEventListener('ended', () => events.onEnded?.());
    this.element.addEventListener('error', () => events.onError?.());
  }

  /** The Web Audio context, once `unlock()` has created it. */
  get context(): AudioContext | null {
    return this.ctx;
  }

  get simulated(): boolean {
    return !this.routed;
  }

  get currentTime(): number {
    return this.element.currentTime;
  }

  get isPlaying(): boolean {
    return !this.element.paused && !this.element.ended;
  }

  /** Probe CORS for the media origin before the first user gesture. */
  async probe(url: string): Promise<void> {
    if (this.corsAllowed !== null) return;
    try {
      const response = await fetch(url, { method: 'HEAD', mode: 'cors', cache: 'no-store' });
      this.corsAllowed = response.ok || response.status === 206;
    } catch {
      this.corsAllowed = false;
    }
  }

  /**
   * Loads a track from `startAt` (default: the beginning). Loading the file that is already loaded restarts
   * it rather than carrying on, so picking a track always plays it from the top.
   */
  load(url: string, startAt = 0): void {
    const sameFile = this.element.src === new URL(url, window.location.href).href;
    if (!sameFile) this.element.src = url;
    if (!sameFile && startAt <= 0) return;
    const seek = () => {
      this.element.currentTime = startAt;
    };
    if (this.element.readyState >= 1) seek();
    else this.element.addEventListener('loadedmetadata', seek, { once: true });
  }

  /**
   * Must run synchronously inside a user gesture. Resumes the AudioContext, routes the element
   * when CORS allows it, and plays-then-pauses so later programmatic play() calls are permitted.
   */
  unlock(): void {
    const AudioCtx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!this.ctx && AudioCtx) {
      this.ctx = new AudioCtx();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0;
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.78;
      this.gain.connect(this.analyser);
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx && this.corsAllowed && !this.routed) {
      this.ctx.createMediaElementSource(this.element).connect(this.gain!);
      this.routed = true;
    }
    void this.ctx?.resume();
    if (!this.routed) this.element.volume = 0;
    const attempt = this.element.play();
    attempt
      ?.then(() => {
        if (!this.wantsPlayback) this.element.pause();
      })
      .catch(() => {
        /* Autoplay refused; the next gesture retries. */
      });
  }

  async play(): Promise<boolean> {
    this.wantsPlayback = true;
    void this.ctx?.resume();
    try {
      await this.element.play();
      return true;
    } catch {
      return false;
    }
  }

  pause(): void {
    this.wantsPlayback = false;
    this.element.pause();
  }

  stop(): void {
    this.pause();
    this.element.currentTime = 0;
  }

  /** Moves the loaded track to `seconds`, keeping the play state. */
  seek(seconds: number): void {
    this.element.currentTime = Math.max(0, seconds);
  }

  setVolume(value: number): void {
    this.volume = Math.min(1, Math.max(0, value));
    this.applyLevel(this.volume, 0.08);
  }

  getVolume(): number {
    return this.volume;
  }

  fadeIn(seconds: number): void {
    this.applyLevel(0, 0);
    this.applyLevel(this.volume, seconds);
  }

  /** Fades to silence, then stops and rewinds (eject). `fadeIn` restores the level on the next play. */
  fadeOutAndStop(seconds: number): void {
    this.wantsPlayback = false;
    this.applyLevel(0, seconds);
    window.setTimeout(() => {
      if (!this.wantsPlayback) this.stop();
    }, seconds * 1000);
  }

  private applyLevel(target: number, seconds: number): void {
    if (this.routed && this.ctx && this.gain) {
      const now = this.ctx.currentTime;
      this.gain.gain.cancelScheduledValues(now);
      this.gain.gain.setValueAtTime(this.gain.gain.value, now);
      if (seconds <= 0) this.gain.gain.setValueAtTime(target, now);
      else this.gain.gain.linearRampToValueAtTime(target, now + seconds);
      return;
    }
    if (seconds <= 0) {
      this.element.volume = target;
      return;
    }
    const start = this.element.volume;
    const began = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - began) / (seconds * 1000));
      this.element.volume = start + (target - start) * t;
      if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  /** Time-domain samples in -1..1 for the oscilloscope. Simulated when not routed. */
  waveform(count: number): number[] {
    if (this.routed && this.analyser && this.isPlaying) {
      this.analyser.getByteTimeDomainData(this.timeData);
      const step = this.timeData.length / count;
      return Array.from({ length: count }, (_, i) => (this.timeData[Math.floor(i * step)] - 128) / 128);
    }
    if (!this.isPlaying) return new Array(count).fill(0);
    const t = performance.now() / 1000;
    return Array.from({ length: count }, (_, i) => {
      const x = i / count;
      return 0.35 * Math.sin(x * 22 + t * 9) * Math.sin(x * 5 - t * 2) + 0.12 * Math.sin(x * 61 + t * 17);
    });
  }

  /** 0..1 levels for the HUD and scene. Simulated when the graph is not routed. */
  spectrum(bins: number): number[] {
    if (this.routed && this.analyser && this.ctx && this.isPlaying) {
      this.analyser.getByteFrequencyData(this.freqData);
      return logBins(this.freqData, bins, this.ctx.sampleRate);
    }
    if (!this.isPlaying) return new Array(bins).fill(0);
    const t = performance.now() / 1000;
    return Array.from({ length: bins }, (_, i) => {
      const falloff = 1 - i / (bins * 1.25);
      const wobble = 0.5 + 0.5 * Math.sin(t * (2.1 + i * 0.37) + i * 1.7) * Math.sin(t * 0.9 + i);
      return Math.max(0, Math.min(1, falloff * (0.25 + 0.6 * wobble)));
    });
  }

  bass(): number {
    if (this.routed && this.analyser && this.ctx && this.isPlaying) {
      this.analyser.getByteFrequencyData(this.freqData);
      return bandLevel(this.freqData, this.ctx.sampleRate, 40, 160);
    }
    if (!this.isPlaying) return 0;
    const t = performance.now() / 1000;
    return 0.35 + 0.3 * Math.max(0, Math.sin(t * Math.PI * 2 * 1.5));
  }

  level(): number {
    if (this.routed && this.analyser && this.isPlaying) {
      this.analyser.getByteTimeDomainData(this.timeData);
      return rmsLevel(this.timeData);
    }
    return this.isPlaying ? 0.3 + 0.1 * Math.sin(performance.now() / 180) : 0;
  }
}

/**
 * What `player-app.ts` drives: every public member of `AudioEngine` except the raw element. The app bundle
 * supplies `BridgeAudioEngine` (packages/bridge), which plays natively (BUN-0, ARCH-2).
 */
export type PlayerEngine = Omit<AudioEngine, 'element'>;

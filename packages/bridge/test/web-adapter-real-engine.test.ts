import { afterEach, beforeEach, describe, expect, test } from 'vitest';
// The real site engine (it imports only audio-math), driven under minimal Web Audio and HTMLMediaElement stubs.
import { AudioEngine } from '../../../src/player3d/audio-engine';
import { BridgeAudioEngine } from '../src/bridge-audio-engine';
import { BridgeTrackSource } from '../src/bridge-track-source';
import type { PlaybackFrame } from '../src/types';
import { WebBridgeAdapter, type WebTrackList } from '../src/web-adapter';

class StubAudio {
  private source = '';
  /** Like HTMLMediaElement: a new source resets the position and pauses. */
  get src() {
    return this.source;
  }
  set src(value: string) {
    this.source = value;
    this.currentTime = 0;
    this.paused = true;
  }
  volume = 1;
  paused = true;
  ended = false;
  currentTime = 0;
  readyState = 4;
  crossOrigin: string | null = null;
  preload = '';
  addEventListener() {}
  play() {
    this.paused = false;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

class StubParam {
  value: number;
  constructor(value: number) {
    this.value = value;
  }
  cancelScheduledValues() {}
  setValueAtTime(value: number) {
    this.value = value;
  }
  /** Ramps land at once: the test reads the level the engine is heading for. */
  linearRampToValueAtTime(value: number) {
    this.value = value;
  }
}

class StubContext {
  static last: StubContext | null = null;
  currentTime = 0;
  sampleRate = 48_000;
  destination = {};
  state = 'running';
  gain: { gain: StubParam; connect(): void } | null = null;
  routed: unknown[] = [];
  constructor() {
    StubContext.last = this;
  }
  createGain() {
    this.gain = { gain: new StubParam(1), connect() {} };
    return this.gain;
  }
  createAnalyser() {
    return {
      fftSize: 0,
      smoothingTimeConstant: 0,
      connect() {},
      getByteFrequencyData: (data: Uint8Array) => data.fill(180),
      getByteTimeDomainData: (data: Uint8Array) => data.forEach((_, i) => (data[i] = i % 2 ? 200 : 56)),
    };
  }
  createMediaElementSource(element: unknown) {
    this.routed.push(element);
    return { connect() {} };
  }
  resume() {
    return Promise.resolve();
  }
}

const LIST: WebTrackList = {
  expiresAt: Date.now() + 3_600_000,
  preview: false,
  tracks: [
    { id: 't1', position: 1, title: 'One', durationSeconds: 180, streamUrl: 'https://cdn.test/1.mp3' },
    { id: 't2', position: 2, title: 'Two', durationSeconds: 200, streamUrl: 'https://cdn.test/2.mp3' },
  ],
};

const saved: Record<string, unknown> = {};
const G = globalThis as Record<string, unknown>;
let corsOk = true;

beforeEach(() => {
  for (const key of ['window', 'Audio', 'fetch', 'requestAnimationFrame']) saved[key] = G[key];
  corsOk = true;
  StubContext.last = null;
  G.Audio = StubAudio;
  G.window = { location: { href: 'https://stream.myindsound.com/' }, AudioContext: StubContext };
  G.fetch = async () => {
    if (!corsOk) throw new TypeError('CORS');
    return { ok: true, status: 200 };
  };
  G.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 4);
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) G[key] = value;
});

function rig() {
  let engine!: AudioEngine;
  const adapter = new WebBridgeAdapter({
    environment: null,
    createEngine: (events) => (engine = new AudioEngine(events)),
    providers: {
      getContext: async () => ({
        releaseId: 'lit',
        ownership: 'owned',
        editionNumber: 1,
        ownerDisplayName: null,
        wear: null,
        unwrapped: true,
        dropAt: 0,
        serverNow: 0,
      }),
      getTracks: async () => LIST,
    },
    requestFrame: (cb) => setTimeout(cb, 16) as unknown as number,
    cancelFrame: (h) => clearTimeout(h),
  });
  return { adapter, engine: () => engine, gain: () => StubContext.last?.gain?.gain.value };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('WebBridgeAdapter with the real AudioEngine (BUN-6)', () => {
  test('tracks listed, then the gesture: routed through Web Audio, audible gain, real spectrum', async () => {
    const { adapter, engine, gain } = rig();
    await adapter.getTracks();
    adapter.unlock();
    await adapter.play('t1');
    const element = engine().element as unknown as StubAudio;
    expect(element.paused).toBe(false);
    expect(engine().simulated).toBe(false);
    expect(StubContext.last!.routed).toEqual([element]);
    expect(element.volume).toBe(1);
    expect(gain()).toBeCloseTo(0.8);
    const frames: PlaybackFrame[] = [];
    adapter.on('playback', (f) => frames.push(f));
    await wait(40);
    expect(frames.length).toBeGreaterThan(0);
    // 180/255 from the stub analyser: the real routed spectrum, not the simulated wobble.
    expect(frames.at(-1)!.bands.every((b) => Math.abs(b - 180 / 255) < 1e-9 || b === 0)).toBe(true);
    await adapter.pause();
  });

  test('the gesture before the probe (the critic’s order): routed on the first start and un-muted', async () => {
    const { adapter, engine, gain } = rig();
    adapter.unlock();
    await adapter.play('t1');
    const element = engine().element as unknown as StubAudio;
    expect(element.paused).toBe(false);
    expect(engine().simulated).toBe(false);
    expect(element.volume).toBe(1);
    expect(gain()).toBeCloseTo(0.8);
  });

  test('CORS refused: unrouted, and the muted element fades back up to the volume', async () => {
    corsOk = false;
    const { adapter, engine } = rig();
    await adapter.getTracks();
    adapter.unlock();
    const element = engine().element as unknown as StubAudio;
    expect(element.volume).toBe(0);
    await adapter.play('t1');
    expect(engine().simulated).toBe(true);
    await wait(250);
    expect(element.volume).toBeCloseTo(0.8, 2);
  });

  test('setVolume, pause, resume, seek and startAt on the real element', async () => {
    const { adapter, engine, gain } = rig();
    await adapter.getTracks();
    adapter.unlock();
    await adapter.play('t1', 42);
    const element = engine().element as unknown as StubAudio;
    expect(element.currentTime).toBe(42);
    await adapter.setVolume(0.3);
    expect(gain()).toBeCloseTo(0.3);
    await adapter.pause();
    expect(element.paused).toBe(true);
    await adapter.play('t1');
    expect(element.paused).toBe(false);
    expect(element.currentTime).toBe(42);
    await adapter.seek(90);
    expect(element.currentTime).toBe(90);
    await adapter.play('t2');
    expect(element.src).toBe('https://cdn.test/2.mp3');
    expect(element.currentTime).toBe(0);
  });

  test('the full web chain: BridgeTrackSource + BridgeAudioEngine → adapter → AudioEngine', async () => {
    const { adapter, engine, gain } = rig();
    const list = await new BridgeTrackSource(adapter).list();
    const bridgeEngine = new BridgeAudioEngine(adapter, {}, { createContext: () => null });
    bridgeEngine.setVolume(0.5);
    bridgeEngine.load(list.tracks[1].streamUrl, 30);
    bridgeEngine.unlock();
    expect(await bridgeEngine.play()).toBe(true);
    const element = engine().element as unknown as StubAudio;
    expect(element.src).toBe('https://cdn.test/2.mp3');
    expect(element.currentTime).toBe(30);
    expect(element.paused).toBe(false);
    expect(gain()).toBeCloseTo(0.5);
    bridgeEngine.fadeOutAndStop(0.05);
    await wait(80);
    expect(element.paused).toBe(true);
    expect(gain()).toBe(0);
    bridgeEngine.fadeIn();
    await wait(0);
    expect(gain()).toBeCloseTo(0.5);
    bridgeEngine.dispose();
    await adapter.pause();
  });
});

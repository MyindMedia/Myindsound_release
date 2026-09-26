import { describe, expect, test, vi } from 'vitest';
import {
  WebBridgeAdapter,
  webLayout,
  type WebAdapterEnvironment,
  type WebAdapterProviders,
  type WebAudioEngine,
  type WebAudioEngineEvents,
  type WebTrackList,
} from '../src/web-adapter';
import type { PlaybackFrame } from '../src/types';
import { isContext, isPlaybackFrame } from '../src/validate';

/** Mirrors AudioEngine: `load` of a new URL cues it at startAt; `load` of the loaded URL seeks it. */
class FakeEngine implements WebAudioEngine {
  src = '';
  currentTime = 0;
  playing = false;
  unlocked = 0;
  allowPlay = true;
  simulated = true;
  probed: string[] = [];
  volume = 0.8;
  fades = 0;
  readonly events: WebAudioEngineEvents;
  constructor(events: WebAudioEngineEvents) {
    this.events = events;
  }
  get isPlaying() {
    return this.playing;
  }
  load(url: string, startAt = 0) {
    if (url !== this.src) {
      this.src = url;
      this.playing = false;
      this.currentTime = 0;
    }
    this.currentTime = startAt;
  }
  unlock() {
    this.unlocked++;
  }
  async probe(url: string) {
    this.probed.push(url);
  }
  setVolume(value: number) {
    this.volume = value;
  }
  fadeIn() {
    this.fades++;
  }
  async play() {
    if (!this.allowPlay) return false;
    this.playing = true;
    return true;
  }
  pause() {
    this.playing = false;
  }
  stop() {
    this.pause();
    this.currentTime = 0;
  }
  spectrum(bins: number) {
    return new Array(bins).fill(0.5);
  }
  waveform(count: number) {
    return new Array(count).fill(0.1);
  }
  bass() {
    return 0.4;
  }
  level() {
    return 0.3;
  }
}

const LIST: WebTrackList = {
  expiresAt: Number.MAX_SAFE_INTEGER,
  preview: false,
  tracks: [
    { id: 't1', position: 1, title: 'One', durationSeconds: 180, streamUrl: 'https://cdn.test/1.mp3?sig=a' },
    { id: 't2', position: 2, title: 'Two', durationSeconds: 200, streamUrl: 'https://cdn.test/2.mp3?sig=a' },
  ],
};

function envFake() {
  const listeners: Record<string, Array<() => void>> = {};
  const doc = {
    visibilityState: 'visible',
    addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  const env = {
    innerWidth: 390,
    innerHeight: 844,
    addEventListener: (type: string, fn: () => void) => (listeners[type] ??= []).push(fn),
    removeEventListener: (type: string, fn: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    document: doc,
  };
  const fire = (type: string) => (listeners[type] ?? []).forEach((fn) => fn());
  return { env: env as unknown as WebAdapterEnvironment & { innerWidth: number }, doc, fire, listeners };
}

function setup(providers: Partial<WebAdapterProviders> = {}, list: WebTrackList = LIST) {
  let engine!: FakeEngine;
  const frames: Array<() => void> = [];
  const { env, doc, fire, listeners } = envFake();
  const getTracks = vi.fn(async () => list);
  const adapter = new WebBridgeAdapter({
    createEngine: (events) => (engine = new FakeEngine(events)),
    providers: {
      getContext: async () => ({
        releaseId: 'lit',
        ownership: 'owned',
        editionNumber: 3,
        ownerDisplayName: null,
        wear: null,
        unwrapped: false,
        dropAt: 0,
        serverNow: 5,
      }),
      getTracks,
      ...providers,
    },
    environment: env,
    now: () => 1_000,
    requestFrame: (cb) => frames.push(cb),
    cancelFrame: () => {},
  });
  const runFrame = () => {
    const pending = frames.splice(0);
    pending.forEach((cb) => cb());
  };
  return { adapter, engine: () => engine, env, doc, fire, listeners, runFrame, frames, getTracks };
}

describe('WebBridgeAdapter (BUN-6)', () => {
  test('context: provider data plus platform web and the window layout', async () => {
    const { adapter } = setup();
    const context = await adapter.getContext();
    expect(isContext(context)).toBe(true);
    expect(context.platform).toBe('web');
    expect(context.layout).toEqual({ widthPt: 390, heightPt: 844, sizeClass: 'compact', posture: 'standard' });
    expect(context.lifecycle).toBe('foreground');
  });

  test('tracks never expose the stream URL to the bundle', async () => {
    const { adapter } = setup();
    const tracks = await adapter.getTracks();
    expect(tracks).toEqual([
      { id: 't1', position: 1, title: 'One', durationSeconds: 180, preview: false },
      { id: 't2', position: 2, title: 'Two', durationSeconds: 200, preview: false },
    ]);
    expect(JSON.stringify(tracks)).not.toContain('cdn.test');
  });

  test('play, pause, resume and seek drive the injected engine; every start fades the level in', async () => {
    const { adapter, engine } = setup();
    await adapter.getTracks();
    expect(engine().probed).toEqual([LIST.tracks[0].streamUrl]);
    adapter.unlock();
    await adapter.play('t1');
    expect(engine().src).toBe(LIST.tracks[0].streamUrl);
    expect(engine().unlocked).toBe(1);
    expect(engine().fades).toBe(1);
    expect(engine().isPlaying).toBe(true);
    expect(await adapter.getPlaybackState()).toEqual({ trackId: 't1', status: 'playing', positionSec: 0, durationSec: 180, rate: 1 });

    engine().currentTime = 42;
    await adapter.pause();
    expect(engine().isPlaying).toBe(false);
    expect((await adapter.getPlaybackState()).status).toBe('paused');

    await adapter.play('t1');
    expect(engine().currentTime).toBe(42);
    expect((await adapter.getPlaybackState()).status).toBe('playing');
    expect(engine().fades).toBe(2);
    await adapter.play('t1', 100);
    expect(engine().currentTime).toBe(100);
    await adapter.setVolume(0.3);
    expect(engine().volume).toBe(0.3);

    await adapter.seek(90);
    expect(engine().src).toBe(LIST.tracks[0].streamUrl);
    expect(engine().currentTime).toBe(90);
    await adapter.seek(5000);
    expect(engine().currentTime).toBe(180);
  });

  test('play of another track loads it from the top; next and previous follow the shared rules', async () => {
    const { adapter, engine } = setup();
    await adapter.play('t1');
    await adapter.next();
    expect(engine().src).toBe(LIST.tracks[1].streamUrl);
    expect(engine().currentTime).toBe(0);
    await adapter.next();
    expect(engine().src).toBe(LIST.tracks[1].streamUrl);
    engine().currentTime = 10;
    await adapter.previous();
    expect((await adapter.getPlaybackState()).trackId).toBe('t2');
    expect(engine().currentTime).toBe(0);
    await adapter.previous();
    expect((await adapter.getPlaybackState()).trackId).toBe('t1');
  });

  test('bad params and unknown tracks are refused', async () => {
    const { adapter } = setup();
    await expect(adapter.play('')).rejects.toMatchObject({ code: 'E_INVALID_PARAMS' });
    await expect(adapter.play('t9')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await expect(adapter.seek(Number.NaN)).rejects.toMatchObject({ code: 'E_INVALID_PARAMS' });
    expect(() => adapter.haptic('buzz' as never)).toThrow();
  });

  test('a browser that refuses playback reports paused and E_NOT_ALLOWED', async () => {
    const { adapter, engine } = setup();
    await adapter.getTracks();
    engine().allowPlay = false;
    await expect(adapter.play('t1')).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
    expect((await adapter.getPlaybackState()).status).toBe('paused');
  });

  test('the end of a track starts the next; the end of the album is "ended"; each start logs once', async () => {
    const logPlay = vi.fn(async () => {});
    const { adapter, engine } = setup({ logPlay });
    await adapter.play('t1');
    engine().events.onTime!(31);
    engine().events.onTime!(32);
    expect(logPlay).toHaveBeenCalledTimes(1);
    engine().events.onEnded!();
    await vi.waitFor(() => expect(engine().src).toBe(LIST.tracks[1].streamUrl));
    expect(logPlay).toHaveBeenCalledTimes(1);
    engine().events.onEnded!();
    expect(logPlay).toHaveBeenCalledTimes(2);
    expect(logPlay).toHaveBeenLastCalledWith('t2');
    expect((await adapter.getPlaybackState()).status).toBe('ended');
  });

  test('frames run while playing and someone listens, and stop on pause or unsubscribe', async () => {
    const { adapter, runFrame, frames } = setup();
    const seen: PlaybackFrame[] = [];
    const off = adapter.on('playback', (f) => seen.push(f));
    await adapter.play('t1');
    const before = seen.length;
    runFrame();
    runFrame();
    expect(seen.length).toBe(before + 2);
    const live = seen[seen.length - 1];
    expect(isPlaybackFrame(live)).toBe(true);
    expect(live.bands).toHaveLength(64);
    expect(live.waveform).toHaveLength(128);
    expect(live.bass).toBe(0.4);
    await adapter.pause();
    expect(seen[seen.length - 1].bands.every((b) => b === 0)).toBe(true);
    runFrame();
    expect(frames.length).toBe(0);
    await adapter.play('t1');
    off();
    runFrame();
    expect(frames.length).toBe(0);
  });

  test('layout on resize and lifecycle on visibility change; dispose detaches them', async () => {
    const { adapter, env, doc, fire, listeners } = setup();
    const layout = vi.fn();
    const lifecycle = vi.fn();
    adapter.on('layout', layout);
    adapter.on('lifecycle', lifecycle);
    (env as { innerWidth: number }).innerWidth = 1024;
    fire('resize');
    expect(layout).toHaveBeenCalledWith(expect.objectContaining({ widthPt: 1024, sizeClass: 'regular' }));
    doc.visibilityState = 'hidden';
    fire('visibilitychange');
    doc.visibilityState = 'visible';
    fire('visibilitychange');
    expect(lifecycle.mock.calls.map((c) => c[0].state)).toEqual(['background', 'foreground']);
    adapter.dispose();
    expect(listeners.resize).toEqual([]);
    expect(listeners.visibilitychange).toEqual([]);
  });

  test('expired links are refetched before a track loads; one fetch serves concurrent calls', async () => {
    let expiresAt = 1_000 + 5 * 60_000;
    const getTracks = vi.fn(async () => ({ ...LIST, expiresAt }));
    const { adapter } = setup({ getTracks });
    await Promise.all([adapter.getTracks(), adapter.getTracks()]);
    expect(getTracks).toHaveBeenCalledTimes(1);
    expiresAt = Number.MAX_SAFE_INTEGER;
    await adapter.play('t1');
    expect(getTracks).toHaveBeenCalledTimes(2);
  });

  test('share and lend are unsupported on the web unless the site provides them; wear events go to providers', async () => {
    const { adapter } = setup();
    await expect(adapter.requestLend()).rejects.toMatchObject({ code: 'E_NOT_SUPPORTED' });
    await expect(adapter.requestShare()).rejects.toMatchObject({ code: 'E_NOT_SUPPORTED' });
    const cartridgeLoaded = vi.fn(async () => {});
    const markUnwrapped = vi.fn(async () => {});
    const requestLend = vi.fn(async () => {});
    const wired = setup({ cartridgeLoaded, markUnwrapped, requestLend }).adapter;
    await wired.cartridgeLoaded();
    await wired.markUnwrapped();
    await wired.requestLend();
    expect([cartridgeLoaded, markUnwrapped, requestLend].every((fn) => fn.mock.calls.length === 1)).toBe(true);
  });

  test('webLayout: compact below the regular width', () => {
    expect(webLayout(699, 800).sizeClass).toBe('compact');
    expect(webLayout(700, 800).sizeClass).toBe('regular');
  });
});

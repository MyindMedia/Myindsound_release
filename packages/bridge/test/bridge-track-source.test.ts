import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
// Type-only: these files pull in the site's Convex client, so nothing from them runs here. tsc checks the shapes.
import type { AudioEngine } from '../../../src/player3d/audio-engine';
import type {
  PlayerTrack as SitePlayerTrack,
  StreamAccess as SiteStreamAccess,
  TrackList as SiteTrackList,
  TrackSource as SiteTrackSource,
} from '../../../src/player3d/track-source';
import { BridgeAudioEngine } from '../src/bridge-audio-engine';
import {
  BRIDGE_LIST_TTL_MS,
  BridgeTrackSource,
  bridgeTrackUrl,
  trackIdFromUrl,
  type PlayerTrack,
  type StreamAccess,
  type TrackList,
  type TrackSource,
} from '../src/bridge-track-source';
import { createBridgeClient } from '../src/client';
import { MockBridge } from '../src/mock';
import { loopbackTransport } from '../src/transport';
import type { WebAudioEngine } from '../src/web-adapter';

// ── Conformance (compile time): a drift on either side fails `tsc -p packages/bridge` ───────────────────
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const shapesMatch: [
  Equal<PlayerTrack, SitePlayerTrack>,
  Equal<TrackList, SiteTrackList>,
  Equal<StreamAccess, SiteStreamAccess>,
  Equal<TrackSource, SiteTrackSource>,
  // The site's AudioEngine plugs straight into the web adapter.
  AudioEngine extends WebAudioEngine ? true : false,
  // BridgeAudioEngine has every public member of AudioEngine except the raw <audio> element.
  Equal<Exclude<keyof AudioEngine, keyof BridgeAudioEngine>, 'element'>,
] = [true, true, true, true, true, true];

function asSiteEngine(engine: BridgeAudioEngine): Omit<AudioEngine, 'element'> {
  return engine;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(2_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('BridgeTrackSource (BUN-0)', () => {
  test('is a TrackSource the player accepts', () => {
    const source: SiteTrackSource = new BridgeTrackSource(new MockBridge());
    expect(source.label).toBe('bridge');
    expect(shapesMatch.every(Boolean)).toBe(true);
  });

  test('list(): tracks in album order with bridge URLs, never a real link, and a refresh a day out', async () => {
    const bridge = new MockBridge({
      tracks: [
        { id: 'b', position: 2, title: 'Two', durationSeconds: 200 },
        { id: 'a', position: 1, title: 'One', durationSeconds: 180 },
      ],
    });
    const source = new BridgeTrackSource(bridge);
    const list = await source.list();
    expect(list.tracks).toEqual([
      { id: 'a', position: 1, title: 'One', durationSeconds: 180, format: 'mp3', streamUrl: 'myind-bridge://track/a' },
      { id: 'b', position: 2, title: 'Two', durationSeconds: 200, format: 'mp3', streamUrl: 'myind-bridge://track/b' },
    ]);
    expect(list.expiresAt).toBe(2_000_000 + BRIDGE_LIST_TTL_MS);
    expect(BRIDGE_LIST_TTL_MS).toBeLessThan(2 ** 31);
    expect(source.context?.editionNumber).toBe(7);
  });

  test.each([
    ['owned', { mode: 'full', via: 'account' }],
    ['lent', { mode: 'full', via: 'account' }],
    ['preview', { mode: 'preview', reason: 'not-owner' }],
    ['locked', { mode: 'preview', reason: 'not-owner' }],
  ] as const)('access for %s', async (ownership, access) => {
    const source = new BridgeTrackSource(new MockBridge({ ownership }));
    await source.list();
    expect(source.access).toEqual(access);
  });

  test('locked before the drop: list() fails, so the player shows its error state', async () => {
    const source = new BridgeTrackSource(new MockBridge({ ownership: 'locked', dropAt: 9_999_999 }));
    await expect(source.list()).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
  });

  test('logPlay is a no-op: native records play events itself (WEAR-6)', async () => {
    const bridge = new MockBridge();
    const source = new BridgeTrackSource(bridge);
    await source.logPlay();
    expect(bridge.calls).toEqual([]);
  });

  test('track URLs round-trip; other URLs are not bridge tracks', () => {
    expect(trackIdFromUrl(bridgeTrackUrl('k57_x-1'))).toBe('k57_x-1');
    expect(trackIdFromUrl('https://cdn.test/1.mp3')).toBeNull();
    expect(trackIdFromUrl('myind-bridge://track/')).toBeNull();
  });
});

describe('BridgeAudioEngine (BRG-4)', () => {
  function rig(options: ConstructorParameters<typeof MockBridge>[0] = {}, events: ConstructorParameters<typeof BridgeAudioEngine>[1] = {}) {
    const bridge = new MockBridge({ frameIntervalMs: 50, ...options });
    const play = vi.spyOn(bridge, 'play');
    const seek = vi.spyOn(bridge, 'seek');
    const engine = new BridgeAudioEngine(bridge, events, { createContext: () => null, now: () => Date.now() });
    return { bridge, engine, play, seek };
  }

  test('load cues, play starts natively, frames drive isPlaying, spectrum and waveform', async () => {
    const { bridge, engine, play } = rig();
    engine.load(bridgeTrackUrl('mock-1'));
    expect(play).not.toHaveBeenCalled();
    expect(engine.isPlaying).toBe(false);
    expect(engine.simulated).toBe(true);
    expect(await engine.play()).toBe(true);
    expect(play).toHaveBeenCalledWith('mock-1', 0);
    vi.advanceTimersByTime(1000);
    expect(engine.isPlaying).toBe(true);
    expect(engine.simulated).toBe(false);
    expect(engine.currentTime).toBeCloseTo(1, 1);
    expect(engine.spectrum(32)).toHaveLength(32);
    expect(engine.spectrum(32).some((v) => v > 0)).toBe(true);
    expect(engine.waveform(96)).toHaveLength(96);
    expect(engine.bass()).toBeGreaterThan(0);
    expect(engine.level()).toBeGreaterThan(0);
    // Between frames the position runs on at the native rate.
    const between = engine.currentTime;
    vi.setSystemTime(Date.now() + 20);
    expect(engine.currentTime).toBeCloseTo(between + 0.02, 5);
    bridge.dispose();
  });

  test('load with startAt starts right there (no jump); load of the loaded track just seeks', async () => {
    const { bridge, engine, play, seek } = rig();
    const positions: number[] = [];
    bridge.on('playback', (f) => positions.push(f.positionSec));
    engine.load(bridgeTrackUrl('mock-2'), 42);
    expect(engine.currentTime).toBe(42);
    await engine.play();
    expect(play).toHaveBeenCalledWith('mock-2', 42);
    expect(seek).not.toHaveBeenCalled();
    expect(positions[0]).toBe(42);
    expect(bridge.playback.positionSec).toBe(42);
    engine.load(bridgeTrackUrl('mock-2'), 10);
    expect(play).toHaveBeenCalledTimes(1);
    expect(seek).toHaveBeenLastCalledWith(10);
    expect(engine.currentTime).toBe(10);
    bridge.dispose();
  });

  test('pause silences, stop rewinds, play resumes the same track', async () => {
    const { bridge, engine, play } = rig();
    engine.load(bridgeTrackUrl('mock-1'));
    await engine.play();
    vi.advanceTimersByTime(5000);
    engine.pause();
    await Promise.resolve();
    expect(bridge.playback.status).toBe('paused');
    expect(engine.isPlaying).toBe(false);
    expect(engine.spectrum(8)).toEqual(new Array(8).fill(0));
    engine.stop();
    await Promise.resolve();
    expect(bridge.playback.positionSec).toBe(0);
    await engine.play();
    expect(play).toHaveBeenLastCalledWith('mock-1');
    expect(bridge.playback).toMatchObject({ trackId: 'mock-1', status: 'playing' });
    bridge.dispose();
  });

  test('loading another track while one plays silences the old one', async () => {
    const { bridge, engine } = rig();
    engine.load(bridgeTrackUrl('mock-1'));
    await engine.play();
    engine.load(bridgeTrackUrl('mock-3'));
    await Promise.resolve();
    expect(bridge.playback).toMatchObject({ trackId: 'mock-1', status: 'paused' });
    await engine.play();
    expect(bridge.playback).toMatchObject({ trackId: 'mock-3', status: 'playing' });
    bridge.dispose();
  });

  test('native moving to the next track by itself: onEnded once, and the player’s load of it does not restart it', async () => {
    const onEnded = vi.fn();
    const { bridge, engine, play } = rig({}, { onEnded });
    engine.load(bridgeTrackUrl('mock-1'));
    await engine.play();
    vi.advanceTimersByTime(181_000);
    expect(bridge.playback.trackId).toBe('mock-2');
    expect(onEnded).toHaveBeenCalledTimes(1);
    const at = bridge.playback.positionSec;
    expect(at).toBeGreaterThan(0);
    // What player-app does on `trackEnded`: load the next track, then play.
    engine.load(bridgeTrackUrl('mock-2'));
    await engine.play();
    expect(play).toHaveBeenCalledTimes(1);
    expect(bridge.playback.positionSec).toBe(at);
    expect(engine.isPlaying).toBe(true);
    bridge.dispose();
  });

  test('the end of the album reports onEnded', async () => {
    const onEnded = vi.fn();
    const { bridge, engine } = rig({}, { onEnded });
    engine.load(bridgeTrackUrl('mock-3'));
    await engine.play();
    vi.advanceTimersByTime(161_000);
    expect(bridge.playback.status).toBe('ended');
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  test('lock-screen changes reach onNativeChange instead of being mistaken for the end of a track', async () => {
    const onEnded = vi.fn();
    const onNativeChange = vi.fn();
    const { bridge, engine } = rig({}, { onEnded, onNativeChange });
    engine.load(bridgeTrackUrl('mock-2'));
    await engine.play();
    await bridge.pause();
    expect(onNativeChange).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'paused' }));
    expect(engine.isPlaying).toBe(false);
    await bridge.play('mock-2');
    expect(engine.isPlaying).toBe(true);
    await bridge.previous();
    await bridge.previous();
    expect(onNativeChange).toHaveBeenLastCalledWith(expect.objectContaining({ trackId: 'mock-1' }));
    expect(onEnded).not.toHaveBeenCalled();
    bridge.dispose();
  });

  test('onTime is throttled like the web engine', async () => {
    const onTime = vi.fn();
    const { bridge, engine } = rig({ frameIntervalMs: 16 }, { onTime });
    engine.load(bridgeTrackUrl('mock-1'));
    await engine.play();
    vi.advanceTimersByTime(1000);
    expect(onTime.mock.calls.length).toBeGreaterThanOrEqual(3);
    expect(onTime.mock.calls.length).toBeLessThanOrEqual(5);
    bridge.dispose();
  });

  test('fadeOutAndStop (eject) takes the level to 0, stops and rewinds; the next play restores the level', async () => {
    const { bridge, engine } = rig();
    engine.setVolume(0.6);
    await Promise.resolve();
    expect(bridge.currentVolume).toBe(0.6);
    engine.load(bridgeTrackUrl('mock-1'));
    await engine.play();
    vi.advanceTimersByTime(3000);
    engine.fadeOutAndStop(0.35);
    await Promise.resolve();
    expect(bridge.currentVolume).toBe(0);
    expect(bridge.playback.status).toBe('playing');
    vi.advanceTimersByTime(350);
    await Promise.resolve();
    expect(bridge.playback).toMatchObject({ status: 'paused', positionSec: 0 });
    await engine.play();
    expect(bridge.currentVolume).toBe(0.6);
    engine.fadeIn(0.5);
    expect(bridge.calls.filter((c) => c.method === 'setVolume')).toHaveLength(3);
    bridge.dispose();
  });

  test('the critic’s scenario: paused at 90 on mock-1, load mock-2, load mock-1, play → from 0', async () => {
    const { bridge, engine } = rig();
    engine.load(bridgeTrackUrl('mock-1'));
    await engine.play();
    engine.seek(90);
    engine.pause();
    await Promise.resolve();
    await Promise.resolve();
    expect(bridge.playback).toMatchObject({ trackId: 'mock-1', status: 'paused', positionSec: 90 });
    engine.load(bridgeTrackUrl('mock-2'));
    engine.load(bridgeTrackUrl('mock-1'));
    await engine.play();
    expect(bridge.playback).toMatchObject({ trackId: 'mock-1', status: 'playing', positionSec: 0 });
    expect(engine.currentTime).toBe(0);
    bridge.dispose();
  });

  test('lent: load at 42 starts at 42 and uses no play until 30 s have played', async () => {
    const { bridge, engine } = rig({ ownership: 'lent', lentPlays: 2 });
    engine.load(bridgeTrackUrl('mock-1'), 42);
    await engine.play();
    expect(bridge.playback.positionSec).toBe(42);
    expect(bridge.playsRemaining).toBe(2);
    vi.advanceTimersByTime(30_000);
    expect(bridge.playsRemaining).toBe(1);
    bridge.dispose();
  });

  test('a frame lost before the engine existed is recovered from getPlaybackState, and again on foreground', async () => {
    const native = new MockBridge({ frameIntervalMs: 60_000 });
    await native.play('mock-2', 12);
    // Frames can be lost (sent before the bundle subscribed, or while the web view was suspended): a gate drops them.
    const gate = { open: true };
    const bridge = new Proxy(native, {
      get(target, key) {
        if (key === 'on') {
          return (event: string, handler: (p: unknown) => void) =>
            target.on(event as 'playback', (p) => (event !== 'playback' || gate.open) && handler(p));
        }
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const onNativeChange = vi.fn();
    const engine = new BridgeAudioEngine(bridge, { onNativeChange }, { createContext: () => null, now: () => Date.now() });
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.simulated).toBe(false);
    // The resync told the engine native is already on mock-2 at 12: loading it seeks, playing it doesn't restart it.
    engine.load(bridgeTrackUrl('mock-2'), 12);
    await engine.play();
    expect(native.calls.filter((c) => c.method === 'play')).toHaveLength(1);
    expect(engine.isPlaying).toBe(true);
    vi.advanceTimersByTime(5_000);
    native.lifecycle('background');
    gate.open = false;
    await native.pause();
    gate.open = true;
    expect(engine.isPlaying).toBe(true);
    native.lifecycle('foreground');
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.isPlaying).toBe(false);
    expect(engine.currentTime).toBeCloseTo(17, 3);
    expect(onNativeChange).toHaveBeenCalledWith(expect.objectContaining({ status: 'paused' }));
    native.dispose();
  });

  test('unlock makes the mechanical-sounds AudioContext and unlocks a bridge that needs a gesture', () => {
    const resume = vi.fn(async () => {});
    const context = { resume } as unknown as AudioContext;
    const bridge = Object.assign(new MockBridge(), { unlock: vi.fn() });
    const engine = new BridgeAudioEngine(bridge, {}, { createContext: () => context });
    engine.unlock();
    engine.unlock();
    expect(engine.context).toBe(context);
    expect(resume).toHaveBeenCalledTimes(2);
    expect(bridge.unlock).toHaveBeenCalledTimes(2);
  });

  test('a URL that is not a bridge track is a loud error', () => {
    const { engine } = rig();
    expect(() => engine.load('https://cdn.test/1.mp3')).toThrow(/bridgeTrackUrl/);
  });

  test('driven only through the site AudioEngine surface (minus the raw element), it plays natively', async () => {
    const { bridge, engine } = rig();
    const site = asSiteEngine(engine);
    await site.probe(bridgeTrackUrl('mock-1'));
    site.setVolume(0.4);
    site.load(bridgeTrackUrl('mock-3'), 5);
    site.unlock();
    expect(await site.play()).toBe(true);
    site.fadeIn(0.5);
    vi.advanceTimersByTime(1000);
    expect(site.isPlaying).toBe(true);
    expect(site.currentTime).toBeCloseTo(6, 1);
    expect(site.spectrum(32).some((v) => v > 0)).toBe(true);
    site.stop();
    await Promise.resolve();
    expect(bridge.playback).toMatchObject({ trackId: 'mock-3', status: 'paused', positionSec: 0 });
    expect(bridge.currentVolume).toBe(0.4);
    bridge.dispose();
  });
});

describe('full chain: track source + engine → client → wire → mock native', () => {
  test('lists, plays and streams frames exactly as it would on a device', async () => {
    const native = new MockBridge({ ownership: 'lent', frameIntervalMs: 50 });
    const client = createBridgeClient({ transport: loopbackTransport(native) });
    const source = new BridgeTrackSource(client);
    const list = await source.list();
    expect(source.access).toEqual({ mode: 'full', via: 'account' });
    const engine = new BridgeAudioEngine(client, {}, { createContext: () => null, now: () => Date.now() });
    engine.load(list.tracks[1].streamUrl, 30);
    expect(await engine.play()).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(native.playback).toMatchObject({ trackId: 'mock-2', status: 'playing' });
    expect(engine.isPlaying).toBe(true);
    expect(engine.currentTime).toBeGreaterThan(30);
    expect(engine.spectrum(32).some((v) => v > 0)).toBe(true);
    engine.pause();
    await vi.advanceTimersByTimeAsync(10);
    expect(native.playback.status).toBe('paused');
    native.dispose();
    client.dispose();
  });
});

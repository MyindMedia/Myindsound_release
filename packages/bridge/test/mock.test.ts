import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MockBridge } from '../src/mock';
import type { PlaybackFrame, WearDescriptor } from '../src/types';
import { isContext, isPlaybackFrame } from '../src/validate';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ownership states', () => {
  test('owned: full songs, edition number, may unwrap, share and lend; loads and ejects count', async () => {
    const bridge = new MockBridge({ ownership: 'owned' });
    const context = await bridge.getContext();
    expect(isContext(context)).toBe(true);
    expect(context).toMatchObject({ ownership: 'owned', editionNumber: 7, ownerDisplayName: null, unwrapped: false });
    const tracks = await bridge.getTracks();
    expect(tracks.every((t) => !t.preview)).toBe(true);
    expect(tracks[0].durationSeconds).toBe(180);
    await bridge.markUnwrapped();
    expect((await bridge.getContext()).unwrapped).toBe(true);
    await expect(bridge.requestShare()).resolves.toBeUndefined();
    await expect(bridge.requestLend()).resolves.toBeUndefined();
    await bridge.cartridgeLoaded();
    await bridge.cartridgeEjected();
    expect(bridge.stats).toEqual({ loads: 1, ejects: 1 });
  });

  test('lent: full songs, the lender name and the lend in the context; no unwrap, share or lend', async () => {
    const bridge = new MockBridge({ ownership: 'lent', lentPlays: 2 });
    const context = await bridge.getContext();
    expect(context).toMatchObject({ ownership: 'lent', editionNumber: 7, ownerDisplayName: 'Mock Lender' });
    expect(context.lend).toMatchObject({ playsAllowed: 2, playsUsed: 0, status: 'active' });
    expect(context.lend!.expiresAt).toBe(1_000_000 + 7 * 24 * 60 * 60_000);
    expect((await bridge.getTracks())[0].preview).toBe(false);
    await expect(bridge.markUnwrapped()).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
    await expect(bridge.requestLend()).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
    await expect(bridge.requestShare()).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
    await bridge.cartridgeLoaded();
    expect(bridge.stats.loads).toBe(1);
  });

  test('LEND-5: a lent play is committed after 30 s of actual playback, never at the start', async () => {
    const bridge = new MockBridge({ ownership: 'lent', lentPlays: 2 });
    await bridge.play('mock-1', 170);
    expect(bridge.playsRemaining).toBe(2);
    vi.advanceTimersByTime(29_000);
    expect(bridge.playsRemaining).toBe(2);
    // Past the end of mock-1 after 10 s: that start is never committed. mock-2 starts on its own.
    vi.advanceTimersByTime(2_000);
    expect(bridge.playback.trackId).toBe('mock-2');
    expect(bridge.playsRemaining).toBe(2);
    // mock-2 has played 21 s. Paused time doesn't count; a resume carries on the same start.
    await bridge.pause();
    vi.advanceTimersByTime(60_000);
    await bridge.play('mock-2');
    vi.advanceTimersByTime(8_000);
    expect(bridge.playsRemaining).toBe(2);
    vi.advanceTimersByTime(2_000);
    expect(bridge.playsRemaining).toBe(1);
    vi.advanceTimersByTime(60_000);
    expect(bridge.playsRemaining).toBe(1);
    bridge.dispose();
  });

  test('an exhausted lend stays "lent": the next start stops, sends a stopped frame, then ownership, and play is E_LEND_ENDED', async () => {
    const bridge = new MockBridge({ ownership: 'lent', lentPlays: 1 });
    const events: string[] = [];
    bridge.on('playback', (f) => events.push(`playback:${f.trackId}:${f.status}`));
    bridge.on('ownership', (p) => events.push(`ownership:${p.ownership}:${p.lend?.status}`));
    await bridge.play('mock-1');
    vi.advanceTimersByTime(31_000);
    expect(bridge.playsRemaining).toBe(0);
    // The committed play carries on to its end; the auto-advance start is the one refused (mid album).
    vi.advanceTimersByTime(150_000);
    expect(events.slice(-2)).toEqual(['playback:mock-1:stopped', 'ownership:lent:exhausted']);
    expect(bridge.playback).toMatchObject({ status: 'stopped', positionSec: 0, rate: 0 });
    await expect(bridge.play('mock-2')).rejects.toMatchObject({ code: 'E_LEND_ENDED' });
    expect((await bridge.getContext()).ownership).toBe('lent');
    expect(bridge.lendState?.status).toBe('exhausted');
  });

  test('every start is checked: restart, next and previous included; an expired lend refuses a resume too', async () => {
    const bridge = new MockBridge({ ownership: 'lent', lend: { expiresAt: 1_000_000 + 60_000 } });
    await bridge.play('mock-1');
    vi.advanceTimersByTime(10_000);
    await bridge.pause();
    vi.advanceTimersByTime(60_000);
    await expect(bridge.play('mock-1')).rejects.toMatchObject({ code: 'E_LEND_ENDED' });
    expect(bridge.lendState?.status).toBe('expired');
    await expect(bridge.next()).rejects.toMatchObject({ code: 'E_LEND_ENDED' });
    await expect(bridge.previous()).rejects.toMatchObject({ code: 'E_LEND_ENDED' });
    await expect(bridge.play('mock-1', 0)).rejects.toMatchObject({ code: 'E_LEND_ENDED' });
  });

  test('the server ending a lend mid song (returned, revoked, converted) stops at once, never as "locked"', async () => {
    const bridge = new MockBridge({ ownership: 'lent' });
    const ownership = vi.fn();
    bridge.on('ownership', ownership);
    await bridge.play('mock-2');
    vi.advanceTimersByTime(5_000);
    bridge.endLend('returned', 'called back');
    expect(bridge.playback.status).toBe('stopped');
    expect(ownership).toHaveBeenCalledWith(
      expect.objectContaining({ ownership: 'lent', lend: expect.objectContaining({ status: 'returned', endReason: 'called back' }) }),
    );
    await expect(bridge.play('mock-2')).rejects.toMatchObject({ code: 'E_LEND_ENDED' });
  });

  test('LOCK_WHILE_LENT: an owned copy out on an active lend cannot play', async () => {
    const bridge = new MockBridge({ ownership: 'owned', lend: { status: 'active' } });
    expect((await bridge.getContext()).lend?.status).toBe('active');
    await expect(bridge.play('mock-1')).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
    bridge.endLend('returned');
    await expect(bridge.play('mock-1')).resolves.toBeUndefined();
    bridge.dispose();
  });

  test('preview: 30 second previews, no edition number, loads are not counted', async () => {
    const bridge = new MockBridge({ ownership: 'preview' });
    expect(await bridge.getContext()).toMatchObject({ ownership: 'preview', editionNumber: null });
    const tracks = await bridge.getTracks();
    expect(tracks.every((t) => t.preview && t.durationSeconds === 30)).toBe(true);
    await bridge.cartridgeLoaded();
    expect(bridge.stats.loads).toBe(0);
    await expect(bridge.markUnwrapped()).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
  });

  test('locked before the drop: no tracks and play is refused; after the drop: previews', async () => {
    const bridge = new MockBridge({ ownership: 'locked', dropAt: 1_000_000 + 60_000 });
    const context = await bridge.getContext();
    expect(context.dropAt - context.serverNow).toBe(60_000);
    expect(await bridge.getTracks()).toEqual([]);
    await expect(bridge.play('mock-1')).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
    vi.advanceTimersByTime(60_000);
    const tracks = await bridge.getTracks();
    expect(tracks.length).toBe(3);
    expect(tracks[0].preview).toBe(true);
    await expect(bridge.play('mock-1')).resolves.toBeUndefined();
    bridge.dispose();
  });

  test('setOwnership fires an ownership event (lend returned, purchase completed)', async () => {
    const bridge = new MockBridge({ ownership: 'preview' });
    const handler = vi.fn();
    bridge.on('ownership', handler);
    bridge.setOwnership('owned', { editionNumber: 88 });
    expect(handler).toHaveBeenCalledWith({ ownership: 'owned', editionNumber: 88, ownerDisplayName: null, unwrapped: false });
    expect((await bridge.getContext()).editionNumber).toBe(88);
    expect((await bridge.getTracks())[0].preview).toBe(false);
  });
});

describe('fake playback', () => {
  test('ticks the position, sends 64-band frames while playing, silent frames on pause', async () => {
    const bridge = new MockBridge({ frameIntervalMs: 100 });
    const frames: PlaybackFrame[] = [];
    bridge.on('playback', (f) => frames.push(f));
    await bridge.play('mock-1');
    vi.advanceTimersByTime(1000);
    expect(frames.length).toBe(11);
    expect(frames.every(isPlaybackFrame)).toBe(true);
    expect(frames[10].bands.length).toBe(64);
    expect(frames[10].waveform.length).toBe(128);
    expect(frames[10].positionSec).toBeCloseTo(1, 5);
    expect(frames[10].bands.some((b) => b > 0)).toBe(true);
    await bridge.pause();
    const paused = frames[frames.length - 1];
    expect(paused.status).toBe('paused');
    expect(paused.rate).toBe(0);
    expect(paused.bands.every((b) => b === 0)).toBe(true);
    vi.advanceTimersByTime(1000);
    expect(frames[frames.length - 1]).toBe(paused);
    expect((await bridge.getPlaybackState()).positionSec).toBeCloseTo(1, 5);
  });

  test('play on the paused track resumes; seek moves it; previous restarts past 3 s', async () => {
    const bridge = new MockBridge();
    await bridge.play('mock-2');
    vi.advanceTimersByTime(10_000);
    await bridge.pause();
    await bridge.play('mock-2');
    expect(bridge.playback.positionSec).toBeCloseTo(10, 3);
    await bridge.seek(100);
    expect(bridge.playback.positionSec).toBe(100);
    await bridge.seek(50);
    await bridge.previous();
    expect(bridge.playback).toMatchObject({ trackId: 'mock-2', positionSec: 0 });
    await bridge.previous();
    expect(bridge.playback.trackId).toBe('mock-1');
    await bridge.next();
    await bridge.next();
    expect(bridge.playback.trackId).toBe('mock-3');
    await bridge.next();
    expect(bridge.playback.trackId).toBe('mock-3');
    // Seeking past the end clamps to it, and the track then ends like any other: last track, so "ended".
    await bridge.seek(9999);
    expect(bridge.playback.positionSec).toBe(160);
    vi.advanceTimersByTime(100);
    expect(bridge.playback.status).toBe('ended');
    bridge.dispose();
  });

  test('the end of a track starts the next one by itself; the end of the album is "ended"', async () => {
    const bridge = new MockBridge({ frameIntervalMs: 250 });
    const tracks: Array<string | null> = [];
    bridge.on('playback', (f) => {
      if (tracks[tracks.length - 1] !== `${f.trackId}:${f.status}`) tracks.push(`${f.trackId}:${f.status}`);
    });
    await bridge.play('mock-2');
    vi.advanceTimersByTime(200_000 + 160_000 + 1_000);
    expect(tracks).toEqual(['mock-2:playing', 'mock-3:playing', 'mock-3:ended']);
    expect(bridge.playback).toMatchObject({ status: 'ended', positionSec: 160, rate: 0 });
  });

  test('unknown tracks and bad params are refused like native', async () => {
    const bridge = new MockBridge();
    await expect(bridge.play('nope')).rejects.toMatchObject({ code: 'E_NOT_FOUND' });
    await expect(bridge.play('')).rejects.toMatchObject({ code: 'E_INVALID_PARAMS' });
    await expect(bridge.seek(-1)).rejects.toMatchObject({ code: 'E_INVALID_PARAMS' });
    expect(() => bridge.haptic('buzz' as never)).toThrow();
  });
});

describe('layout, wear and lifecycle events', () => {
  test('each helper fires its event, and unsubscribing stops it', async () => {
    const bridge = new MockBridge();
    const layout = vi.fn();
    const wear = vi.fn();
    const lifecycle = vi.fn();
    const offLayout = bridge.on('layout', layout);
    bridge.on('wear', wear);
    bridge.on('lifecycle', lifecycle);
    const open = { widthPt: 800, heightPt: 700, sizeClass: 'regular', posture: 'open', hingeRect: { x: 399, y: 0, w: 2, h: 700 } } as const;
    bridge.setLayout(open);
    expect(layout).toHaveBeenCalledWith(open);
    expect((await bridge.getContext()).layout).toEqual(open);
    offLayout();
    bridge.setLayout({ ...open, posture: 'partial' });
    expect(layout).toHaveBeenCalledTimes(1);
    expect(bridge.listenerCount('layout')).toBe(0);

    const descriptor: WearDescriptor = {
      version: 1,
      seed: 'a'.repeat(32),
      level: 0.2,
      scratches: [],
      scuffZones: [],
      labelFade: 0.05,
      edgeWear: 0.1,
      dustAmount: 0.02,
    };
    bridge.setWear(descriptor);
    expect(wear).toHaveBeenCalledWith(descriptor);
    bridge.lifecycle('background');
    expect(lifecycle).toHaveBeenCalledWith({ state: 'background' });
    // The context always carries the current value, so a lost event can't wedge the bundle.
    expect((await bridge.getContext()).lifecycle).toBe('background');
  });

  test('play with startAt starts there; setVolume is kept', async () => {
    const bridge = new MockBridge();
    await bridge.play('mock-1', 42);
    expect(bridge.playback).toMatchObject({ trackId: 'mock-1', positionSec: 42, status: 'playing' });
    await bridge.pause();
    await bridge.play('mock-1', 0);
    expect(bridge.playback.positionSec).toBe(0);
    await bridge.setVolume(0.25);
    expect(bridge.currentVolume).toBe(0.25);
    await expect(bridge.setVolume(2)).rejects.toMatchObject({ code: 'E_INVALID_PARAMS' });
    bridge.dispose();
  });

  test('fire-and-forget calls are recorded for assertions', () => {
    const bridge = new MockBridge();
    bridge.haptic('rigid');
    bridge.playSound('peel');
    bridge.ready();
    bridge.close();
    expect(bridge.calls.map((c) => c.method)).toEqual(['haptic', 'playSound', 'ready', 'close']);
  });
});

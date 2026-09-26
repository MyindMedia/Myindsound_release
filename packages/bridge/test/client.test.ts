import { afterEach, describe, expect, test, vi } from 'vitest';
import { createBridgeClient } from '../src/client';
import { loopbackTransport } from '../src/transport';
import { MockBridge } from '../src/mock';
import { BRIDGE_METHODS, BridgeError, DEFAULT_TIMEOUTS_MS, type BridgeErrorCode, type WearDescriptor } from '../src/types';
import { normalizeContext, normalizeWear, validateParams, validateResult } from '../src/validate';
import { decodeFrame, encodeFrame } from '../src/wire';
import { CONTEXT, LAYOUT, fakeTransport, frame, nextMacrotask, wireFrame } from './helpers';

afterEach(() => {
  vi.useRealTimers();
});

async function rejection(promise: Promise<unknown>): Promise<BridgeError> {
  try {
    await promise;
  } catch (err) {
    return err as BridgeError;
  }
  throw new Error('expected a rejection');
}

function syncError(fn: () => void): BridgeError {
  try {
    fn();
  } catch (err) {
    return err as BridgeError;
  }
  throw new Error('expected a throw');
}

/** A started client over the in-memory native side. */
async function started(options: Parameters<typeof fakeTransport>[0] = {}) {
  const native = fakeTransport(options);
  const onWarning = vi.fn();
  const client = createBridgeClient({ transport: native.transport, onWarning });
  client.start();
  return { native, client, onWarning };
}

const WEAR: WearDescriptor = {
  version: 1,
  seed: 'ab'.repeat(16),
  level: 0.3,
  scratches: [{ surface: 'disc', x: 0.1, y: 0.2, angle: 30, length: 0.1, depth: 0.5 }],
  scuffZones: [{ surface: 'shell', x: 0.5, y: 0.5, radius: 0.05, intensity: 0.2 }],
  labelFade: 0.1,
  edgeWear: 0.3,
  dustAmount: 0.05,
};

describe('request / response', () => {
  test('round trip: posts {id, method, params} with a random 128-bit id and resolves with the result', async () => {
    const { native, client } = await started();
    const pending = client.getContext();
    expect(native.last()).toMatchObject({ method: 'getContext', params: {} });
    expect(native.lastId()).toMatch(/^[0-9a-f]{32}$/);
    native.resolve(native.lastId(), CONTEXT);
    await expect(pending).resolves.toEqual(CONTEXT);
    expect(client.pendingCount).toBe(0);
  });

  test('ids are unique and unguessable; resolves land on the right promise out of order', async () => {
    const { native, client } = await started();
    const play = client.play('t1');
    const seek = client.seek(42.5);
    const [a, b] = native.sent;
    expect(a.id).not.toBe(b.id);
    expect([a.id, b.id]).not.toContain('r1');
    expect([a.method, a.params, b.method, b.params]).toEqual(['play', { trackId: 't1' }, 'seek', { seconds: 42.5 }]);
    native.resolve(b.id!, null);
    native.resolve(a.id!, null);
    await expect(Promise.all([play, seek])).resolves.toEqual([undefined, undefined]);
  });

  test('play carries startAt only when given; setVolume is on the wire', async () => {
    const { native, client } = await started();
    void client.play('t1', 42);
    expect(native.last().params).toEqual({ trackId: 't1', startAt: 42 });
    void client.play('t1', 0);
    expect(native.last().params).toEqual({ trackId: 't1', startAt: 0 });
    void client.setVolume(0.5);
    expect(native.last()).toMatchObject({ method: 'setVolume', params: { volume: 0.5 } });
  });

  test('a native error { code, message } rejects with that code', async () => {
    const { native, client } = await started();
    const pending = client.requestLend();
    native.resolve(native.lastId(), null, { code: 'E_LEND_ENDED', message: 'The lend has ended' });
    const err = await rejection(pending);
    expect(err).toBeInstanceOf(BridgeError);
    expect([err.code, err.message, err.method]).toEqual(['E_LEND_ENDED', 'The lend has ended', 'requestLend']);
  });

  test.each([
    ['0', 0],
    ['false', false],
    ['a bare code string', 'E_NOT_ALLOWED'],
    ['an unknown code', { code: 'E_SOMETHING_NEW', message: 'x' }],
    ['a missing message', { code: 'E_NOT_ALLOWED' }],
    ['an array', ['E_NOT_ALLOWED']],
  ])('an error that is %s becomes E_INTERNAL (never success)', async (_label, error) => {
    const { native, client } = await started();
    const pending = client.pause();
    native.resolve(native.lastId(), null, error);
    expect((await rejection(pending)).code).toBe('E_INTERNAL');
  });

  test('a result that breaks the contract rejects with E_INVALID_RESULT', async () => {
    const { native, client } = await started();
    const pending = client.getContext();
    native.resolve(native.lastId(), { ...CONTEXT, ownership: 'stolen' });
    expect((await rejection(pending)).code).toBe('E_INVALID_RESULT');
    const tracks = client.getTracks();
    native.resolve(native.lastId(), [{ id: 't1', position: 1, title: 'x' }]);
    expect((await rejection(tracks)).code).toBe('E_INVALID_RESULT');
    const noLifecycle = client.getContext();
    const { lifecycle: _drop, ...withoutLifecycle } = CONTEXT;
    native.resolve(native.lastId(), withoutLifecycle);
    expect((await rejection(noLifecycle)).code).toBe('E_INVALID_RESULT');
  });

  test('void methods resolve undefined whatever native sends back', async () => {
    const { native, client } = await started();
    const pending = client.markUnwrapped();
    native.resolve(native.lastId(), { ignored: true });
    await expect(pending).resolves.toBeUndefined();
  });

  test('a late or unknown resolve is a warning without the id, not a crash', async () => {
    const { native, onWarning } = await started();
    native.resolve('deadbeef'.repeat(4), null);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0][0]).not.toContain('deadbeef');
  });

  test('a post that throws rejects with E_TRANSPORT and leaves nothing pending', async () => {
    const { client } = await started({ throwOnPost: true });
    expect((await rejection(client.getContext())).code).toBe('E_TRANSPORT');
    expect(client.pendingCount).toBe(0);
  });

  test('no transport and no native shim on the page: createBridgeClient throws E_TRANSPORT', () => {
    expect(syncError(() => createBridgeClient({ transport: null })).code).toBe('E_TRANSPORT');
  });
});

describe('encoding rules (CONTRACT.md §5)', () => {
  test('optional fields may be null or omitted; handlers only ever see them omitted', async () => {
    const { native, client } = await started();
    const pending = client.getContext();
    native.resolve(native.lastId(), { ...CONTEXT, layout: { ...LAYOUT, hingeRect: null }, lend: null });
    const context = await pending;
    expect('hingeRect' in context.layout).toBe(false);
    expect('lend' in context).toBe(false);
    const state = client.getPlaybackState();
    native.resolve(native.lastId(), { trackId: 't1', status: 'loading', positionSec: 0, durationSec: null, rate: 0 });
    expect('durationSec' in (await state)).toBe(false);
  });

  test('required nullable fields must be present; placeholders like 0 duration are rejected', async () => {
    const { editionNumber: _e, ...noEdition } = CONTEXT;
    expect(normalizeContext(noEdition)).toBeNull();
    expect(validateResult.bind(null, 'getPlaybackState', { trackId: 't1', status: 'playing', positionSec: 1, durationSec: 0, rate: 1 })).toThrow();
  });

  test('a lent context must say where its lend stands; the lend is deep-checked', () => {
    const lent = { ...CONTEXT, ownership: 'lent', ownerDisplayName: 'Kim' };
    expect(normalizeContext(lent)).toBeNull();
    const lend = { playsAllowed: 10, playsUsed: 3, expiresAt: 5_000, status: 'active' };
    expect(normalizeContext({ ...lent, lend })?.lend).toEqual(lend);
    expect(normalizeContext({ ...lent, lend: { ...lend, status: 'offered' } })).toBeNull();
    expect(normalizeContext({ ...lent, lend: { ...lend, playsUsed: 1.5 } })).toBeNull();
    expect(normalizeContext({ ...lent, lend: { ...lend, status: 'expired', endReason: null } })?.lend).toEqual({ ...lend, status: 'expired' });
  });

  test('WearDescriptor is validated item by item', () => {
    expect(normalizeWear(WEAR)).toEqual(WEAR);
    expect(normalizeWear({ ...WEAR, scratches: [null] })).toBeNull();
    expect(normalizeWear({ ...WEAR, scratches: [{ ...WEAR.scratches[0], surface: 'sleeve' }] })).toBeNull();
    expect(normalizeWear({ ...WEAR, scratches: [{ ...WEAR.scratches[0], x: '0.1' }] })).toBeNull();
    expect(normalizeWear({ ...WEAR, scuffZones: [{ surface: 'shell', x: 0 }] })).toBeNull();
    expect(normalizeContext({ ...CONTEXT, wear: { ...WEAR, scratches: [null] } })).toBeNull();
  });

  test('frames are quantised on the wire, fit under 1 KB, and decode back within a step', () => {
    const f = frame({
      trackId: 'k57d8s9f0a1b2c3d4e5f6g7h8',
      positionSec: 12.345678901,
      durationSec: 201.1234,
      bands: Array.from({ length: 64 }, (_, i) => (i % 7) / 7),
      waveform: Array.from({ length: 128 }, (_, i) => Math.sin(i)),
      level: 0.42,
      bass: 0.77,
    });
    const wire = encodeFrame(f);
    expect(JSON.stringify(wire).length).toBeLessThan(1024);
    expect(wire.positionSec).toBe(12.346);
    expect(wire.bands.every(Number.isInteger)).toBe(true);
    const back = decodeFrame(wire);
    expect(Math.max(...back.bands.map((b, i) => Math.abs(b - f.bands[i])))).toBeLessThanOrEqual(1 / 255);
    expect(Math.max(...back.waveform.map((s, i) => Math.abs(s - f.waveform[i])))).toBeLessThanOrEqual(1 / 127);
  });

  test('float or out-of-range frames on the wire are dropped', async () => {
    const { native, client, onWarning } = await started();
    const seen = vi.fn();
    client.on('playback', seen);
    native.emit('playback', frame({ bands: new Array(64).fill(0.5) }));
    native.emit('playback', { ...wireFrame(), bands: new Array(63).fill(1) });
    native.emit('playback', { ...wireFrame(), positionSec: Number.NaN });
    expect(seen).not.toHaveBeenCalled();
    expect(onWarning).toHaveBeenCalledTimes(3);
    native.emit('playback', wireFrame({ positionSec: 3, bands: new Array(64).fill(1) }));
    expect(seen.mock.calls[0][0].bands[0]).toBe(1);
  });
});

describe('timeouts', () => {
  test('no resolve within the method timeout rejects with E_TIMEOUT, and a late resolve is ignored', async () => {
    vi.useFakeTimers();
    const { native, client, onWarning } = await started();
    const pending = client.getPlaybackState();
    const id = native.lastId();
    const caught = rejection(pending);
    vi.advanceTimersByTime(DEFAULT_TIMEOUTS_MS.getPlaybackState! - 1);
    expect(client.pendingCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect((await caught).code).toBe('E_TIMEOUT');
    expect(client.pendingCount).toBe(0);
    native.resolve(id, { trackId: null, status: 'idle', positionSec: 0, rate: 0 });
    expect(onWarning).toHaveBeenCalled();
  });

  test('per-method overrides; share and lend wait for the fan with no timeout', async () => {
    vi.useFakeTimers();
    const native = fakeTransport();
    const client = createBridgeClient({ transport: native.transport, timeouts: { play: 50 } });
    const caught = rejection(client.play('t1'));
    const share = client.requestShare();
    const shareId = native.lastId();
    vi.advanceTimersByTime(60);
    expect((await caught).code).toBe('E_TIMEOUT');
    vi.advanceTimersByTime(60 * 60_000);
    expect(client.pendingCount).toBe(1);
    native.resolve(shareId, null);
    await expect(share).resolves.toBeUndefined();
  });
});

describe('BRG-1 on the JS side', () => {
  test('methods outside the contract reject with E_UNKNOWN_METHOD and are never posted', async () => {
    const { native, client } = await started();
    for (const method of ['deleteEverything', '__resolve', 'getcontext', '', 'constructor', 'toString']) {
      expect((await rejection(client.call(method))).code).toBe('E_UNKNOWN_METHOD');
    }
    expect(native.sent).toEqual([]);
  });

  test('call() reaches every contract method with the same validation', async () => {
    const { native, client } = await started();
    void client.call('seek', { seconds: 3 });
    expect(native.last()).toMatchObject({ method: 'seek', params: { seconds: 3 } });
    await client.call('haptic', { kind: 'rigid' });
    expect(native.last()).toEqual({ id: null, method: 'haptic', params: { kind: 'rigid' } });
    expect((await rejection(client.call('seek', { seconds: -1 }))).code).toBe('E_INVALID_PARAMS');
    expect((await rejection(client.call('haptic', { kind: 'buzz' }))).code).toBe('E_INVALID_PARAMS');
  });

  const bad: Array<[string, unknown]> = [
    ['play', {}],
    ['play', { trackId: '' }],
    ['play', { trackId: 42 }],
    ['play', { trackId: '../etc/passwd' }],
    ['play', { trackId: 'x'.repeat(129) }],
    ['play', { trackId: 't1', extra: 1 }],
    ['play', { trackId: 't1', startAt: -1 }],
    ['play', { trackId: 't1', startAt: null }],
    ['play', { trackId: 't1', startAt: Number.NaN }],
    ['seek', {}],
    ['seek', { seconds: -0.1 }],
    ['seek', { seconds: Number.NaN }],
    ['seek', { seconds: Number.POSITIVE_INFINITY }],
    ['seek', { seconds: '10' }],
    ['seek', { seconds: 6 * 60 * 60 + 1 }],
    ['setVolume', {}],
    ['setVolume', { volume: 1.01 }],
    ['setVolume', { volume: -0.01 }],
    ['haptic', { kind: 'buzz' }],
    ['haptic', {}],
    ['playSound', { name: 'Peel' }],
    ['playSound', { name: '../peel' }],
    ['playSound', { name: '' }],
    ['getContext', { anything: true }],
    ['pause', []],
    ['next', null],
    ['close', { now: true }],
  ];
  test.each(bad)('%s rejects params %j with E_INVALID_PARAMS', (method, params) => {
    expect(syncError(() => validateParams(method, params)).code).toBe('E_INVALID_PARAMS');
  });

  const good: Array<[string, unknown, unknown]> = [
    ['play', { trackId: 'k57abc_DEF-1' }, { trackId: 'k57abc_DEF-1' }],
    ['play', { trackId: 't1', startAt: 0 }, { trackId: 't1', startAt: 0 }],
    ['play', { trackId: 't1', startAt: undefined }, { trackId: 't1' }],
    ['seek', { seconds: 0 }, { seconds: 0 }],
    ['seek', { seconds: 181.25 }, { seconds: 181.25 }],
    ['setVolume', { volume: 0 }, { volume: 0 }],
    ['haptic', { kind: 'success' }, { kind: 'success' }],
    ['playSound', { name: 'peel-2' }, { name: 'peel-2' }],
    ['getContext', undefined, {}],
    ['ready', {}, {}],
  ];
  test.each(good)('%s accepts %j', (method, params, clean) => {
    expect(validateParams(method, params)).toEqual(clean);
  });

  test('every contract method has a validator entry', () => {
    const sample: Record<string, unknown> = { play: { trackId: 't' }, seek: { seconds: 1 }, setVolume: { volume: 1 }, haptic: { kind: 'light' }, playSound: { name: 'peel' } };
    for (const method of BRIDGE_METHODS) expect(() => validateParams(method, sample[method] ?? {})).not.toThrow();
  });

  test('typed methods validate before posting: bad params never cross', async () => {
    const { native, client } = await started();
    expect((await rejection(client.play(''))).code).toBe('E_INVALID_PARAMS');
    expect((await rejection(client.seek(-5))).code).toBe('E_INVALID_PARAMS');
    expect((await rejection(client.setVolume(2))).code).toBe('E_INVALID_PARAMS');
    expect(syncError(() => client.haptic('buzz' as never)).code).toBe('E_INVALID_PARAMS');
    expect(syncError(() => client.playSound('NOPE')).code).toBe('E_INVALID_PARAMS');
    expect(native.sent).toEqual([]);
  });

  test('fire-and-forget methods post with id null and leave nothing pending', async () => {
    const { native, client } = await started();
    client.haptic('light');
    client.playSound('peel');
    client.close();
    client.ready();
    expect(native.sent).toEqual([
      { id: null, method: 'haptic', params: { kind: 'light' } },
      { id: null, method: 'playSound', params: { name: 'peel' } },
      { id: null, method: 'close', params: {} },
      { id: null, method: 'ready', params: {} },
    ]);
    expect(client.pendingCount).toBe(0);
  });
});

describe('events', () => {
  test('held until the client starts (first macrotask), then live', async () => {
    const native = fakeTransport();
    const client = createBridgeClient({ transport: native.transport });
    native.emit('layout', LAYOUT);
    const layout = vi.fn();
    client.on('layout', layout);
    expect(client.started).toBe(false);
    expect(layout).not.toHaveBeenCalled();
    await nextMacrotask();
    expect(client.started).toBe(true);
    expect(layout).toHaveBeenCalledWith(LAYOUT);
  });

  test('subscribe, receive, unsubscribe', async () => {
    const { native, client } = await started();
    const layout = vi.fn();
    const off = client.on('layout', layout);
    const payload = { widthPt: 800, heightPt: 900, sizeClass: 'regular', posture: 'open', hingeRect: { x: 400, y: 0, w: 1, h: 900 } };
    native.emit('layout', payload);
    expect(layout).toHaveBeenCalledWith(payload);
    off();
    native.emit('layout', payload);
    expect(layout).toHaveBeenCalledTimes(1);
  });

  test('payloads are frozen copies: one handler cannot change what the next sees, or native’s object', async () => {
    const { native, client } = await started();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    client.on('ownership', (p) => {
      (p as { ownership: string }).ownership = 'owned';
    });
    client.on('ownership', (p) => seen.push(p.ownership));
    const payload = { ownership: 'locked', editionNumber: null, ownerDisplayName: null, unwrapped: false };
    native.emit('ownership', payload);
    expect(seen).toEqual(['locked']);
    expect(errors).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(payload)).toBe(false);
    errors.mockRestore();
  });

  test('each subscription is independent, and a throwing handler does not stop the others', async () => {
    const { native, client } = await started();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    const handler = (p: { state: string }) => seen.push(p.state);
    const offA = client.on('lifecycle', handler);
    client.on('lifecycle', handler);
    client.on('lifecycle', () => {
      throw new Error('bundle bug');
    });
    native.emit('lifecycle', { state: 'background' });
    offA();
    native.emit('lifecycle', { state: 'foreground' });
    expect(seen).toEqual(['background', 'background', 'foreground']);
    expect(errors).toHaveBeenCalledTimes(2);
    errors.mockRestore();
  });

  test('on() with an event outside the contract throws E_UNKNOWN_EVENT', async () => {
    const { client } = await started();
    expect(syncError(() => client.on('purchase' as never, () => {})).code).toBe('E_UNKNOWN_EVENT');
  });

  test('unknown events from a newer native are ignored; malformed payloads are dropped', async () => {
    const { native, client, onWarning } = await started();
    const ownership = vi.fn();
    client.on('ownership', ownership);
    native.emit('karaoke', { line: 1 });
    native.emit('ownership', { ownership: 'lent', editionNumber: 3, ownerDisplayName: 'Kim', unwrapped: true });
    native.emit('ownership', {
      ownership: 'lent',
      editionNumber: 3,
      ownerDisplayName: 'Kim',
      unwrapped: true,
      lend: { playsAllowed: 10, playsUsed: 10, expiresAt: 1, status: 'exhausted' },
    });
    expect(ownership).toHaveBeenCalledTimes(1);
    expect(ownership.mock.calls[0][0].lend.status).toBe('exhausted');
    expect(onWarning).toHaveBeenCalledTimes(2);
  });
});

describe('versioning (BRG-3) and lifetime', () => {
  test('native that does not speak v1 fails every call with E_BRIDGE_VERSION and posts nothing', async () => {
    const { native, client } = await started({ version: 3, minVersion: 2 });
    expect(client.compatible).toBe(false);
    expect((await rejection(client.getContext())).code).toBe('E_BRIDGE_VERSION');
    expect(syncError(() => client.ready()).code).toBe('E_BRIDGE_VERSION');
    expect(native.sent).toEqual([]);
  });

  test('native that speaks a range including v1 is compatible', async () => {
    expect((await started({ version: 2, minVersion: 1 })).client.compatible).toBe(true);
  });

  test('dispose is terminal: pending calls reject with E_DISPOSED and events stop', async () => {
    const { native, client } = await started();
    const handler = vi.fn();
    client.on('lifecycle', handler);
    const pending = client.getContext();
    client.dispose();
    expect((await rejection(pending)).code satisfies BridgeErrorCode).toBe('E_DISPOSED');
    native.emit('lifecycle', { state: 'background' });
    expect(handler).not.toHaveBeenCalled();
    expect((await rejection(client.pause())).code).toBe('E_DISPOSED');
  });
});

describe('loopback transport (client ↔ mock over the wire format)', () => {
  test('requests, errors and quantised frames all cross as copies', async () => {
    // A frozen clock: the mock advances playback by elapsed time, so on the wall clock a millisecond between play()
    // and the read below would move the position to 10.001.
    const mock = new MockBridge({ ownership: 'lent', now: () => 1_000_000 });
    const client = createBridgeClient({ transport: loopbackTransport(mock) });
    client.start();
    const context = await client.getContext();
    expect(context).toMatchObject({ ownership: 'lent', ownerDisplayName: 'Mock Lender', lifecycle: 'foreground' });
    expect(context.lend).toMatchObject({ playsAllowed: 10, playsUsed: 0, status: 'active' });
    const tracks = await client.getTracks();
    const frames: number[] = [];
    const positions: number[] = [];
    client.on('playback', (f) => {
      frames.push(f.bands.length);
      positions.push(f.positionSec);
    });
    await client.play(tracks[0].id, 10);
    expect(frames).toEqual([64]);
    expect(positions).toEqual([10]);
    expect(mock.playback.positionSec).toBe(10);
    expect((await rejection(client.requestLend())).code).toBe('E_NOT_ALLOWED');
    expect((await rejection(client.play('missing'))).code).toBe('E_NOT_FOUND');
    client.haptic('rigid');
    await nextMacrotask();
    expect(mock.calls.some((c) => c.method === 'haptic')).toBe(true);
    mock.dispose();
  });
});

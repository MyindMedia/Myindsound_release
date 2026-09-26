import { describe, expect, test, vi } from 'vitest';
import { createBridgeClient } from '../src/client';
import { detectTransport, type HostWindow } from '../src/transport';
import type { BridgeRequest, NativeShim } from '../src/types';
import { randomHex } from '../src/wire';
import { CONTEXT, LAYOUT, SHIM_SOURCE, nextMacrotask, vmPage, wireFrame } from './helpers';

const OWNED = { ownership: 'owned', editionNumber: 1, ownerDisplayName: null, unwrapped: true };

function connect(page: ReturnType<typeof vmPage>) {
  return createBridgeClient({ transport: detectTransport(page.win as HostWindow), onWarning: () => {} });
}

describe('native-shim.js in its own realm (node:vm)', () => {
  test('defines a frozen, non-writable, non-configurable window.myind; page code cannot replace it', () => {
    const page = vmPage();
    expect(page.run('[myind.version, myind.minVersion, myind.platform].join()')).toBe('1,1,ios');
    expect(page.run('Object.isFrozen(window.myind)')).toBe(true);
    expect(page.run('var d = Object.getOwnPropertyDescriptor(window, "myind"); [d.writable, d.configurable].join()')).toBe('false,false');
    expect(() => page.run('"use strict"; window.myind = {};')).toThrow();
    expect(() => page.run('"use strict"; window.myind.__emit = function () {};')).toThrow();
    expect(() => page.run('Object.defineProperty(window, "myind", { value: {} })')).toThrow();
    expect(page.run('delete window.myind')).toBe(false);
  });

  test('refuses to install when native forgot to bake in the per-page secrets', () => {
    const page = vmPage({ secrets: false });
    expect(page.run('typeof window.myind')).toBe('undefined');
  });

  test('end to end with the real client: token from the meta tag, random ids, keyed resolves', async () => {
    const page = vmPage();
    const client = connect(page);
    expect(client.platform).toBe('ios');
    expect(page.run('document.querySelector(\'meta[name="myind-bridge"]\')')).toBeNull();
    const pending = client.getContext();
    const request = page.inbox[0] as BridgeRequest;
    expect(request).toMatchObject({ method: 'getContext', params: {} });
    expect(request.id).toMatch(/^[0-9a-f]{32}$/);
    page.resolve(request.id!, CONTEXT);
    await expect(pending).resolves.toEqual(CONTEXT);
    const second = client.pause();
    expect((page.inbox[1] as BridgeRequest).id).not.toBe(request.id);
    page.resolve((page.inbox[1] as BridgeRequest).id!, null, { code: 'E_NOT_ALLOWED', message: 'no' });
    await expect(second).rejects.toMatchObject({ code: 'E_NOT_ALLOWED' });
  });

  test('events native sends before the bundle exists reach handlers subscribed right after creation', async () => {
    const page = vmPage();
    page.emit('layout', LAYOUT);
    page.emit('playback', wireFrame({ positionSec: 1 }));
    page.emit('lifecycle', { state: 'background' });
    page.emit('playback', wireFrame({ positionSec: 2 }));
    const client = connect(page);
    const seen: string[] = [];
    client.on('layout', () => seen.push('layout'));
    client.on('lifecycle', (p) => seen.push(`lifecycle:${p.state}`));
    client.on('playback', (f) => seen.push(`playback:${f.positionSec}`));
    // Also held: an event between connect and the client's start.
    page.emit('lifecycle', { state: 'foreground' });
    expect(seen).toEqual([]);
    await nextMacrotask();
    expect(seen).toEqual(['layout', 'lifecycle:background', 'playback:2', 'lifecycle:foreground']);
    page.emit('lifecycle', { state: 'background' });
    expect(seen.at(-1)).toBe('lifecycle:background');
  });

  test('autoStart: false holds events until start()', async () => {
    const page = vmPage();
    page.emit('layout', LAYOUT);
    const client = createBridgeClient({ transport: detectTransport(page.win as HostWindow), autoStart: false });
    const layout = vi.fn();
    client.on('layout', layout);
    await nextMacrotask();
    expect(layout).not.toHaveBeenCalled();
    client.start();
    client.start();
    expect(layout).toHaveBeenCalledTimes(1);
  });

  test('hostile page code that connects first loses: no token, wrong token, and it does not use up the connect', async () => {
    const page = vmPage();
    const attempt = (token: string) =>
      page.run(`(function () { try { myind.__connect(${JSON.stringify(token)}, { resolve: function () {}, emit: function () {} }); return 'connected'; } catch (e) { return e.message; } })()`);
    expect(attempt('')).toMatch(/token rejected/);
    expect(attempt('0'.repeat(32))).toMatch(/token rejected/);
    expect(page.run(`(function () { try { myind.__connect({ resolve: function () {}, emit: function () {} }); return 'connected'; } catch (e) { return e.message; } })()`)).toMatch(/token rejected/);
    const client = connect(page);
    const pending = client.getContext();
    page.resolve((page.inbox[0] as BridgeRequest).id!, CONTEXT);
    await expect(pending).resolves.toMatchObject({ releaseId: 'lit' });
    // Even with the right token, the connect is one-shot.
    expect(attempt(page.token)).toMatch(/already connected/);
  });

  test('page code cannot forge events or resolves without the channel key, even knowing the request id', async () => {
    const page = vmPage();
    const client = connect(page);
    await nextMacrotask();
    const ownership = vi.fn();
    client.on('ownership', ownership);
    page.run(`myind.__emit('ownership', ${JSON.stringify(OWNED)})`);
    page.run(`myind.__emit('wrong-key', 'ownership', ${JSON.stringify(OWNED)})`);
    expect(ownership).not.toHaveBeenCalled();

    const pending = client.getContext();
    const id = (page.inbox[0] as BridgeRequest).id!;
    page.run(`myind.__resolve(${JSON.stringify(id)}, ${JSON.stringify({ ...CONTEXT, editionNumber: 1 })})`);
    page.run(`myind.__resolve('nope', ${JSON.stringify(id)}, ${JSON.stringify({ ...CONTEXT, editionNumber: 1 })})`);
    expect(client.pendingCount).toBe(1);
    page.resolve(id, CONTEXT);
    await expect(pending).resolves.toMatchObject({ editionNumber: 12 });
  });

  test('patching the handler, Reflect, JSON or Function.prototype after load cannot reroute or observe requests', async () => {
    const page = vmPage();
    const client = connect(page);
    page.run(`
      window.hijacked = 0;
      webkit.messageHandlers.myind.postMessage = function () { hijacked++; };
      Reflect.apply = function () { hijacked++; };
      JSON.stringify = function () { hijacked++; return '{}'; };
      Function.prototype.apply = function () { hijacked++; };
      Function.prototype.call = function () { hijacked++; };
    `);
    void client.seek(12);
    expect(page.run('hijacked')).toBe(0);
    expect(page.inbox.at(-1)).toMatchObject({ method: 'seek', params: { seconds: 12 } });
  });

  test('prototype poisoning (Array methods, inherited index setters) never sees queued events or resolves', async () => {
    const page = vmPage();
    page.run(`
      window.spy = 0;
      ['push', 'splice', 'shift', 'filter', 'map', 'slice', 'concat'].forEach(function (name) {
        var original = Array.prototype[name];
        Array.prototype[name] = function () { spy++; return original.apply(this, arguments); };
      });
      Object.defineProperty(Array.prototype, '0', { set: function () { spy++; }, configurable: true });
      Object.defineProperty(Object.prototype, '1', { set: function () { spy++; }, configurable: true });
    `);
    page.emit('layout', LAYOUT);
    page.emit('lifecycle', { state: 'background' });
    page.emit('playback', wireFrame());
    page.emit('playback', wireFrame({ positionSec: 3 }));
    const before = page.run('spy');
    const client = connect(page);
    const pending = client.getPlaybackState();
    const state = { trackId: null, status: 'idle', positionSec: 0, rate: 0 };
    const spyBefore = page.run('spy');
    page.resolve((page.inbox[0] as BridgeRequest).id!, state);
    expect(page.run('spy')).toBe(spyBefore);
    expect(before).toBe(0);
    await expect(pending).resolves.toEqual(state);
    const seen: string[] = [];
    client.on('layout', () => seen.push('layout'));
    client.on('lifecycle', () => seen.push('lifecycle'));
    client.on('playback', (f) => seen.push(`playback:${f.positionSec}`));
    await nextMacrotask();
    expect(seen).toEqual(['layout', 'lifecycle', 'playback:3']);
  });

  test('a handler that throws never throws back into native', async () => {
    const page = vmPage();
    const client = connect(page);
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.on('layout', () => {
      throw new Error('bundle bug');
    });
    await nextMacrotask();
    expect(() => page.emit('layout', LAYOUT)).not.toThrow();
    expect(() => page.resolve('unknown', null)).not.toThrow();
    expect(() => page.run(`myind.__resolve(${JSON.stringify(page.key)}, 42, null)`)).not.toThrow();
    errors.mockRestore();
  });

  test('Android: posts a JSON string through the myindNative web message listener', async () => {
    const page = vmPage({ platform: 'android' });
    expect((page.win.myind as NativeShim).platform).toBe('android');
    const client = connect(page);
    const pending = client.seek(12);
    expect(typeof page.inbox[0]).toBe('string');
    const request = JSON.parse(page.inbox[0] as string);
    expect(request).toMatchObject({ method: 'seek', params: { seconds: 12 } });
    page.resolve(request.id, null);
    await expect(pending).resolves.toBeUndefined();
  });

  test('outside the app it defines nothing; an existing window.myind is never redefined', () => {
    expect(detectTransport({} as HostWindow)).toBeNull();
    const page = vmPage();
    const before = page.run('window.myind');
    // A second injection (another frame load, a retry) with fresh secrets leaves the first shim in place.
    page.run(SHIM_SOURCE.replace('__MYIND_CONNECT_TOKEN__', randomHex()).replace('__MYIND_CHANNEL_KEY__', randomHex()));
    expect(page.run('window.myind')).toBe(before);
  });
});

describe('fallback transport (handler present, shim missing)', () => {
  test('reads versions from the meta tag, holds events until start, and keeps exceptions out of native', async () => {
    const page = vmPage({ secrets: false });
    const client = connect(page);
    expect(client.compatible).toBe(true);
    const layout = vi.fn(() => {
      throw new Error('bundle bug');
    });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.on('layout', layout);
    expect(() => page.emit('layout', LAYOUT)).not.toThrow();
    expect(layout).not.toHaveBeenCalled();
    await nextMacrotask();
    expect(layout).toHaveBeenCalledTimes(1);
    expect(() => page.emit('layout', LAYOUT)).not.toThrow();
    const pending = client.getContext();
    page.resolve((page.inbox[0] as BridgeRequest).id!, CONTEXT);
    await expect(pending).resolves.toMatchObject({ releaseId: 'lit' });
    errors.mockRestore();
  });

  test('no meta tag: the native version is unknown, so BRG-3 refuses every call', async () => {
    const page = vmPage({ secrets: false });
    page.run('__meta.removed = true;');
    const client = connect(page);
    expect(client.compatible).toBe(false);
    await expect(client.getContext()).rejects.toMatchObject({ code: 'E_BRIDGE_VERSION' });
    expect(page.inbox).toEqual([]);
  });
});

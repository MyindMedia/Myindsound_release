import { BRIDGE_EVENTS, BridgeError, type BridgeReceiver, type BridgeRequest, type MyindBridge, type NativeShim, type Platform } from './types';
import { encodeFrame, readBridgeMeta, type BridgeMeta, type MetaDocument } from './wire';
import type { PlaybackFrame } from './types';

/**
 * How the client reaches native. iOS and Android differ only in how a request is posted (an object through
 * `webkit.messageHandlers.myind`, a JSON string through the `myindNative` web message listener); both answer
 * through `window.myind.__resolve` / `__emit`. A transport hides that difference behind `connect`.
 */
export interface Transport {
  readonly platform: Platform;
  /** Highest and lowest bridge version the other side speaks (BRG-3). 0 when unknown: the client then refuses. */
  readonly version: number;
  readonly minVersion: number;
  /** Registers the receiver for resolves and events, and returns the function that posts a request. */
  connect(receiver: BridgeReceiver): (request: BridgeRequest) => void;
}

/** The Android web message listener's object name (`WebViewCompat.addWebMessageListener(webView, ANDROID_INTERFACE, …)`). */
export const ANDROID_INTERFACE = 'myindNative';

interface Poster {
  postMessage(message: unknown): void;
}
export interface HostWindow {
  myind?: unknown;
  webkit?: { messageHandlers?: { myind?: Poster } };
  myindNative?: Poster;
  document?: MetaDocument;
}

function isShim(value: unknown): value is NativeShim {
  return typeof value === 'object' && value !== null && typeof (value as NativeShim).__connect === 'function';
}

/** `native-shim.js` was injected at document start: the normal path on iOS and Android. */
export function shimTransport(shim: NativeShim, token: string | null): Transport {
  return {
    platform: shim.platform,
    version: shim.version,
    minVersion: shim.minVersion,
    connect(receiver) {
      if (!token) throw new BridgeError('E_TRANSPORT', 'No connect token (native writes it into <meta name="myind-bridge">)');
      try {
        return shim.__connect(token, receiver);
      } catch (err) {
        throw new BridgeError('E_TRANSPORT', `Connect refused: ${(err as Error)?.message ?? 'unknown'}`);
      }
    },
  };
}

/**
 * Fallback when the handler exists but the shim didn't load (a misconfigured WKUserScript). The client defines
 * `window.myind` itself. Degraded: there is no channel key, so page code can forge resolves and events; the
 * versions come from the meta tag (absent → incompatible, BRG-3). Receiver exceptions never reach native.
 */
export function directTransport(win: HostWindow, meta: BridgeMeta): Transport | null {
  const webkit = win.webkit?.messageHandlers?.myind;
  const android = win[ANDROID_INTERFACE];
  let post: (request: BridgeRequest) => void;
  let platform: 'ios' | 'android';
  if (webkit && typeof webkit.postMessage === 'function') {
    const send = webkit.postMessage;
    post = (request) => Reflect.apply(send, webkit, [request]);
    platform = 'ios';
  } else if (android && typeof android.postMessage === 'function') {
    const send = android.postMessage;
    post = (request) => Reflect.apply(send, android, [JSON.stringify(request)]);
    platform = 'android';
  } else {
    return null;
  }
  const safe = (fn: () => void) => {
    try {
      fn();
    } catch (err) {
      console.error('myind bridge (fallback): receiver failed', err);
    }
  };
  return {
    platform,
    version: meta.version ?? 0,
    minVersion: meta.minVersion ?? meta.version ?? 0,
    connect(receiver) {
      Object.defineProperty(win, 'myind', {
        value: Object.freeze({
          version: meta.version ?? 0,
          minVersion: meta.minVersion ?? meta.version ?? 0,
          platform,
          // Same signature as the shim; the key can't be checked without the shim.
          __resolve: (_key: string, id: string, result: unknown, error?: unknown) => safe(() => receiver.resolve(id, result, error)),
          __emit: (_key: string, event: string, payload: unknown) => safe(() => receiver.emit(event, payload)),
          __connect: () => {
            throw new Error('myind bridge already connected');
          },
        }),
        writable: false,
        configurable: false,
      });
      return post;
    },
  };
}

/**
 * The native transport for this page, or null on the plain website (use the web adapter there). Reads (and
 * removes) native's meta tag for the connect token and, for the fallback, the version range.
 */
export function detectTransport(
  win: HostWindow | undefined = globalThis as unknown as HostWindow,
  meta: BridgeMeta = readBridgeMeta(win?.document),
): Transport | null {
  if (!win) return null;
  if (isShim(win.myind)) return shimTransport(win.myind, meta.token);
  return directTransport(win, meta);
}

/**
 * Runs the wire protocol against any in-page MyindBridge (the mock or the web adapter): requests and events go
 * through the same serialisation (frames quantised), validation and async resolve as on a device.
 */
export function loopbackTransport(target: MyindBridge, platform: Platform = 'ios', version = 1): Transport {
  return {
    platform,
    version,
    minVersion: version,
    connect(receiver) {
      for (const event of BRIDGE_EVENTS) {
        target.on(event, (payload) => {
          const wire = event === 'playback' ? encodeFrame(payload as PlaybackFrame) : payload;
          receiver.emit(event, JSON.parse(JSON.stringify(wire)));
        });
      }
      return (request) => {
        // Structured like a real post: a copy crosses, never a shared reference.
        const { id, method, params } = JSON.parse(JSON.stringify(request)) as BridgeRequest;
        queueMicrotask(async () => {
          try {
            const fn = (target as unknown as Record<string, (...args: unknown[]) => unknown>)[method];
            if (typeof fn !== 'function') throw new BridgeError('E_UNKNOWN_METHOD', `Unknown bridge method: ${method}`);
            const p = params as Record<string, unknown>;
            const args = method === 'play' ? [p.trackId, p.startAt] : Object.values(p);
            const result = await fn.apply(target, args);
            if (id !== null) receiver.resolve(id, result === undefined ? null : JSON.parse(JSON.stringify(result)));
          } catch (err) {
            if (id === null) return;
            const code = err instanceof BridgeError ? err.code : 'E_INTERNAL';
            receiver.resolve(id, null, { code, message: err instanceof Error ? err.message : 'Bridge call failed' });
          }
        });
      };
    },
  };
}

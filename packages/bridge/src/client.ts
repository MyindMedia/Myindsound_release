import { BridgeEmitter } from './emitter';
import { detectTransport, type Transport } from './transport';
import {
  BRIDGE_ERROR_CODES,
  BRIDGE_VERSION,
  BridgeError,
  DEFAULT_TIMEOUTS_MS,
  type BridgeErrorCode,
  type BridgeEvent,
  type BridgeEventMap,
  type BridgeMethod,
  type BridgeRequest,
  type HapticKind,
  type MethodParams,
  type MethodResults,
  type MyindBridge,
  type NotifyMethod,
  type RequestMethod,
  type Unsubscribe,
} from './types';
import {
  assertMethod,
  isBridgeEvent,
  isNotifyMethod,
  normalizeLayout,
  normalizeOwnership,
  normalizeWear,
  normalizeWireFrame,
  validateParams,
  validateResult,
} from './validate';
import { decodeFrame, randomHex } from './wire';

export interface BridgeClientOptions {
  /** Defaults to the injected native shim (`detectTransport()`). */
  transport?: Transport | null;
  /** Per-method overrides of DEFAULT_TIMEOUTS_MS; `null` waits forever. */
  timeouts?: Partial<Record<RequestMethod, number | null>>;
  /**
   * Default true: events that arrive before the client starts (including the shim's pre-connect queue) are held
   * and delivered on the first macrotask after `createBridgeClient` returns, so handlers subscribed synchronously
   * right after creation get them. False: they wait for an explicit `start()`.
   */
  autoStart?: boolean;
  /** Protocol warnings (late resolves, dropped events). Messages carry method names only, never payloads or ids. */
  onWarning?: (message: string) => void;
  /** Request id source. Defaults to 128 random bits from crypto.getRandomValues. */
  newId?: () => string;
}

interface Pending {
  method: RequestMethod;
  resolve(value: unknown): void;
  reject(err: BridgeError): void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** The in-page client a bundle talks to. Implements the contract over whatever transport native provides. */
export interface BridgeClient extends MyindBridge {
  readonly platform: Transport['platform'];
  /** BRG-3: false when native's supported range doesn't include BRIDGE_VERSION; every call then fails. */
  readonly compatible: boolean;
  readonly started: boolean;
  readonly pendingCount: number;
  /** Delivers held events and switches to live delivery. Idempotent. */
  start(): void;
  /** Generic entry point. Methods outside the contract reject with E_UNKNOWN_METHOD and are never posted. */
  call(method: string, params?: unknown): Promise<unknown>;
  /** Terminal: rejects everything pending with E_DISPOSED and drops every handler. One client per page load. */
  dispose(): void;
}

const MAX_HELD_EVENTS = 64;

/** `{ code, message }` with a known code; anything else (a string, 0, an array) is E_INTERNAL. */
function toBridgeError(error: unknown, method: RequestMethod): BridgeError {
  if (typeof error === 'object' && error !== null && !Array.isArray(error)) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    if ((BRIDGE_ERROR_CODES as readonly unknown[]).includes(code) && typeof message === 'string') {
      return new BridgeError(code as BridgeErrorCode, message, method);
    }
  }
  return new BridgeError('E_INTERNAL', 'Native returned an error that is not { code, message }', method);
}

/** Wire payload → what handlers get, or null when it breaks the contract. */
function decodeEvent(event: BridgeEvent, payload: unknown): unknown {
  switch (event) {
    case 'playback': {
      const wire = normalizeWireFrame(payload);
      return wire && decodeFrame(wire);
    }
    case 'layout':
      return normalizeLayout(payload);
    case 'wear':
      return normalizeWear(payload);
    case 'ownership':
      return normalizeOwnership(payload);
    case 'lifecycle': {
      const state = (payload as { state?: unknown } | null)?.state;
      return state === 'background' || state === 'foreground' ? { state } : null;
    }
  }
}

export function createBridgeClient(options: BridgeClientOptions = {}): BridgeClient {
  const transport = options.transport === undefined ? detectTransport() : options.transport;
  if (!transport) throw new BridgeError('E_TRANSPORT', 'No native bridge on this page (use the web adapter)');
  const warn = options.onWarning ?? ((message: string) => console.warn(message));
  const newId = options.newId ?? (() => randomHex(16));
  newId(); // Fail at creation, not on the first call, when there is no crypto.
  const timeouts = { ...DEFAULT_TIMEOUTS_MS, ...options.timeouts };
  const compatible = transport.minVersion <= BRIDGE_VERSION && BRIDGE_VERSION <= transport.version;
  const emitter = new BridgeEmitter();
  const pending = new Map<string, Pending>();
  let held: Array<[BridgeEvent, unknown]> = [];
  let started = false;
  let disposed = false;

  function deliver(event: BridgeEvent, payload: unknown): void {
    emitter.emit(event, payload as BridgeEventMap[typeof event]);
  }

  const post = transport.connect({
    resolve(id, result, error) {
      const entry = typeof id === 'string' ? pending.get(id) : undefined;
      if (!entry) {
        warn('Bridge: resolve for an unknown or expired request');
        return;
      }
      pending.delete(id);
      if (entry.timer !== null) clearTimeout(entry.timer);
      if (error !== null && error !== undefined) {
        entry.reject(toBridgeError(error, entry.method));
        return;
      }
      try {
        entry.resolve(validateResult(entry.method, result));
      } catch (err) {
        entry.reject(err as BridgeError);
      }
    },
    emit(event, payload) {
      if (disposed) return;
      if (!isBridgeEvent(event)) {
        // Newer native, older bundle: ignore events this version doesn't know.
        warn('Bridge: ignored an unknown event');
        return;
      }
      const decoded = decodeEvent(event, payload);
      if (decoded === null) {
        warn(`Bridge: dropped malformed "${event}" event`);
        return;
      }
      if (started) {
        deliver(event, decoded);
        return;
      }
      if (event === 'playback') held = held.filter(([e]) => e !== 'playback');
      held.push([event, decoded]);
      if (held.length > MAX_HELD_EVENTS) held.shift();
    },
  });

  function start(): void {
    if (started || disposed) return;
    started = true;
    const backlog = held;
    held = [];
    for (const [event, payload] of backlog) deliver(event, payload);
  }
  if (options.autoStart !== false) setTimeout(start, 0);

  function guard(method: string): BridgeError | null {
    if (disposed) return new BridgeError('E_DISPOSED', 'Bridge client disposed', method);
    if (!compatible) {
      return new BridgeError(
        'E_BRIDGE_VERSION',
        `Bundle speaks bridge v${BRIDGE_VERSION}, native speaks v${transport!.minVersion}-v${transport!.version}`,
        method,
      );
    }
    return null;
  }

  function send(request: BridgeRequest): void {
    try {
      post(request);
    } catch (err) {
      throw new BridgeError('E_TRANSPORT', `Posting ${request.method} failed: ${(err as Error)?.message ?? 'unknown'}`, request.method);
    }
  }

  function request<M extends RequestMethod>(method: M, params?: unknown): Promise<MethodResults[M]> {
    const blocked = guard(method);
    if (blocked) return Promise.reject(blocked);
    let clean: MethodParams[M];
    try {
      clean = validateParams(method, params);
    } catch (err) {
      return Promise.reject(err);
    }
    const id = newId();
    return new Promise<MethodResults[M]>((resolve, reject) => {
      const limit = timeouts[method];
      const timer =
        limit === null
          ? null
          : setTimeout(() => {
              pending.delete(id);
              reject(new BridgeError('E_TIMEOUT', `${method} timed out after ${limit} ms`, method));
            }, limit);
      pending.set(id, { method, resolve: resolve as (value: unknown) => void, reject, timer });
      try {
        send({ id, method, params: clean } as BridgeRequest);
      } catch (err) {
        pending.delete(id);
        if (timer !== null) clearTimeout(timer);
        reject(err);
      }
    });
  }

  /** Fire-and-forget. Throws synchronously on bad params, so a bundle bug is loud. */
  function notify<M extends NotifyMethod>(method: M, params?: unknown): void {
    const blocked = guard(method);
    if (blocked) throw blocked;
    send({ id: null, method, params: validateParams(method, params) } as BridgeRequest);
  }

  function call(method: string, params?: unknown): Promise<unknown> {
    try {
      assertMethod(method);
    } catch (err) {
      return Promise.reject(err);
    }
    const known = method as BridgeMethod;
    if (isNotifyMethod(known)) {
      try {
        notify(known, params);
        return Promise.resolve(undefined);
      } catch (err) {
        return Promise.reject(err);
      }
    }
    return request(known, params);
  }

  return {
    get platform() {
      return transport.platform;
    },
    get compatible() {
      return compatible;
    },
    get started() {
      return started;
    },
    get pendingCount() {
      return pending.size;
    },
    start,
    call,
    getContext: () => request('getContext'),
    getTracks: () => request('getTracks'),
    play: (trackId: string, startAt?: number) => request('play', startAt === undefined ? { trackId } : { trackId, startAt }),
    pause: () => request('pause'),
    seek: (seconds: number) => request('seek', { seconds }),
    next: () => request('next'),
    previous: () => request('previous'),
    getPlaybackState: () => request('getPlaybackState'),
    setVolume: (volume: number) => request('setVolume', { volume }),
    markUnwrapped: () => request('markUnwrapped'),
    cartridgeLoaded: () => request('cartridgeLoaded'),
    cartridgeEjected: () => request('cartridgeEjected'),
    requestShare: () => request('requestShare'),
    requestLend: () => request('requestLend'),
    haptic: (kind: HapticKind) => notify('haptic', { kind }),
    playSound: (name: string) => notify('playSound', { name }),
    close: () => notify('close'),
    ready: () => notify('ready'),
    on<E extends BridgeEvent>(event: E, handler: (payload: BridgeEventMap[E]) => void): Unsubscribe {
      return emitter.on(event, handler);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      held = [];
      for (const [id, entry] of pending) {
        if (entry.timer !== null) clearTimeout(entry.timer);
        entry.reject(new BridgeError('E_DISPOSED', 'Bridge client disposed', entry.method));
        pending.delete(id);
      }
      emitter.clear();
    },
  };
}

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import type { Transport } from '../src/transport';
import { BRIDGE_VERSION, type BridgeContext, type BridgeReceiver, type BridgeRequest, type PlaybackFrame } from '../src/types';
import { silentFrame } from '../src/playback-rules';
import { encodeFrame, randomHex } from '../src/wire';

/** A native side in memory: records every posted request and lets the test resolve or emit by hand. */
export function fakeTransport(options: { version?: number; minVersion?: number; throwOnPost?: boolean } = {}) {
  const sent: BridgeRequest[] = [];
  let receiver: BridgeReceiver | null = null;
  const transport: Transport = {
    platform: 'ios',
    version: options.version ?? BRIDGE_VERSION,
    minVersion: options.minVersion ?? BRIDGE_VERSION,
    connect(next) {
      receiver = next;
      return (request) => {
        if (options.throwOnPost) throw new Error('handler gone');
        sent.push(structuredClone(request));
      };
    },
  };
  return {
    transport,
    sent,
    last: () => sent[sent.length - 1],
    lastId: () => sent[sent.length - 1].id!,
    resolve: (id: string, result: unknown, error?: unknown) => receiver!.resolve(id, result, error),
    emit: (event: string, payload: unknown) => receiver!.emit(event, payload),
  };
}

export const LAYOUT = { widthPt: 393, heightPt: 852, sizeClass: 'compact', posture: 'standard' } as const;

export const CONTEXT: BridgeContext = {
  releaseId: 'lit',
  ownership: 'owned',
  editionNumber: 12,
  ownerDisplayName: null,
  wear: null,
  unwrapped: true,
  platform: 'ios',
  layout: { ...LAYOUT },
  lifecycle: 'foreground',
  dropAt: 0,
  serverNow: 1_000,
};

export function frame(patch: Partial<PlaybackFrame> = {}): PlaybackFrame {
  return {
    ...silentFrame({ trackId: 't1', status: 'playing', positionSec: 0, durationSec: 180, rate: 1 }),
    ...patch,
  };
}

/** A frame as native puts it on the wire (quantised). */
export const wireFrame = (patch: Partial<PlaybackFrame> = {}) => encodeFrame(frame(patch));

export const SHIM_SOURCE = readFileSync(fileURLToPath(new URL('../native-shim.js', import.meta.url)), 'utf8');

/**
 * A page in its own `node:vm` realm, the way WKWebView runs it: native bakes fresh secrets into the shim, runs it at
 * document start, and writes the token into the page's meta tag. `native` resolves and emits the way Swift's
 * evaluateJavaScript would (with the channel key); `run` executes page code (possibly hostile) in the page realm.
 */
export function vmPage(options: { platform?: 'ios' | 'android'; secrets?: boolean } = {}) {
  const token = randomHex(16);
  const key = randomHex(16);
  const inbox: unknown[] = [];
  const context = vm.createContext({ console: { error() {}, warn() {} } });
  const run = (source: string) => vm.runInContext(source, context);
  run('var window = this;');
  // The native channel lives in the page realm, like WKScriptMessageHandler's proxy.
  // Structured clone happens on the native side, outside the page realm (page code can't patch it).
  context.__nativeInbox = (message: unknown) => inbox.push(typeof message === 'string' ? message : structuredClone(message));
  if (options.platform === 'android') {
    run('window.myindNative = { postMessage: function (json) { __nativeInbox(json); } };');
  } else {
    run('window.webkit = { messageHandlers: { myind: { postMessage: function (m) { __nativeInbox(m); } } } };');
  }
  const source =
    options.secrets === false
      ? SHIM_SOURCE
      : SHIM_SOURCE.replaceAll('__MYIND_CONNECT_TOKEN__', token).replaceAll('__MYIND_CHANNEL_KEY__', key);
  run(source);
  context.__meta = { content: `token=${token};version=1;min=1`, removed: false };
  run(`window.document = { querySelector: function (s) {
    if (s !== 'meta[name="myind-bridge"]' || __meta.removed) return null;
    return { getAttribute: function () { return __meta.content; }, remove: function () { __meta.removed = true; } };
  } };`);
  const js = (value: unknown) => JSON.stringify(value);
  return {
    win: context as Record<string, unknown>,
    token,
    key,
    inbox,
    run,
    /** Native answering a request (evaluateJavaScript with every argument JSON-encoded). */
    resolve: (id: string, result: unknown, error?: unknown) =>
      run(`window.myind.__resolve(${js(key)}, ${js(id)}, ${js(result ?? null)}${error === undefined ? '' : `, ${js(error)}`})`),
    emit: (event: string, payload: unknown) => run(`window.myind.__emit(${js(key)}, ${js(event)}, ${js(payload)})`),
  };
}

/** Lets the client's auto-start (first macrotask) run. */
export const nextMacrotask = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

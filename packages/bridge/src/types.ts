/**
 * JS bridge contract v1 (PRD §10.2). The single source of truth for the TypeScript side; `CONTRACT.md` is the
 * same contract for the Swift and Kotlin sides. Changing anything here that a native side reads is a
 * BRIDGE_VERSION bump (BRG-3), never a silent reinterpretation.
 */

/** The contract version this package implements. Bundles publish it as `manifest.bridgeVersion` (BUN-1). */
export const BRIDGE_VERSION = 1;

export type Ownership = 'owned' | 'lent' | 'locked' | 'preview';
export type Platform = 'ios' | 'android' | 'web';
export type LifecycleState = 'background' | 'foreground';

export const HAPTIC_KINDS = ['light', 'medium', 'heavy', 'rigid', 'soft', 'success'] as const;
export type HapticKind = (typeof HAPTIC_KINDS)[number];

export const SCRATCH_SURFACES = ['shell', 'window', 'label', 'disc'] as const;

/**
 * PRD §11.4, copied field for field. `packages/wear` (P1) owns `computeWear` and will export the canonical
 * type; this local copy exists so the bridge has no dependency on a package that hasn't landed. Once P1 lands,
 * replace this with `export type { WearDescriptor } from '@myind/wear'` (the shapes must stay identical).
 */
export interface WearDescriptor {
  version: number;
  seed: string;
  /** 0..1 */
  level: number;
  scratches: Array<{
    surface: 'shell' | 'window' | 'label' | 'disc';
    x: number;
    y: number;
    angle: number;
    length: number;
    depth: number;
  }>;
  scuffZones: Array<{ surface: string; x: number; y: number; radius: number; intensity: number }>;
  /** 0..0.35 max, keeps text legible */
  labelFade: number;
  /** 0..1 */
  edgeWear: number;
  /** 0..0.3 */
  dustAmount: number;
}

/** PRD §18 DUO-7. Bundles re-fit the 3D camera on every `layout` event. */
export interface LayoutState {
  widthPt: number;
  heightPt: number;
  sizeClass: 'compact' | 'regular';
  posture: 'folded' | 'open' | 'partial' | 'standard';
  hingeRect?: { x: number; y: number; w: number; h: number };
}

/** PRD §12.1 lend statuses a bundle can see (`offered` and `unclaimed_expired` never reach a borrower's copy). */
export const LEND_STATUSES = ['active', 'exhausted', 'expired', 'returned', 'revoked', 'converted'] as const;
export type LendStatus = (typeof LEND_STATUSES)[number];

/**
 * The lend behind a `lent` copy (the borrower's view), or the lend a copy is out on (the owner's view, while
 * LOCK_WHILE_LENT holds it). An ended lend keeps `ownership: 'lent'` with a terminal `status`; it never turns into
 * `locked`. LEND-5, LEND-8, DS-22 (`PLAYS 03`), RACK-1.
 */
export interface LendState {
  playsAllowed: number;
  playsUsed: number;
  /** Server epoch ms. */
  expiresAt: number;
  status: LendStatus;
  /** PRD §12.1 `endReason`, when the server recorded one. Display only. */
  endReason?: string;
}

/** `getContext()` result (PRD §10.2). The server decides every field; the bundle only displays them. */
export interface BridgeContext {
  releaseId: string;
  ownership: Ownership;
  editionNumber: number | null;
  /** Shown when lent. */
  ownerDisplayName: string | null;
  /** PRD §11. */
  wear: WearDescriptor | null;
  unwrapped: boolean;
  platform: Platform;
  /** PRD §18. The current value, so a lost `layout` event can't leave the camera wrong. */
  layout: LayoutState;
  /** The current app state, so a lost `lifecycle` event can't leave rendering paused. */
  lifecycle: LifecycleState;
  /** Present for `lent` copies, and for `owned` copies that are out on an active lend. */
  lend?: LendState;
  /** Server epoch ms. */
  dropAt: number;
  serverNow: number;
}

/**
 * One track as the bundle sees it. Never a URL or a storage id: audio stays native (ARCH-2, ARCH-4, BUN-5).
 * `durationSeconds` is what will actually play, so a preview track reports its preview length.
 */
export interface BridgeTrack {
  id: string;
  /** 1-based, album order. */
  position: number;
  title: string;
  durationSeconds: number;
  /** True when the player will hear the 30 second preview of this track (ownership `preview` or `locked`). */
  preview: boolean;
}

/**
 * `stopped`: native halted playback on its own (a lend ended mid album) and rewound; only an explicit `play`
 * starts it again. `ended`: the last track finished.
 */
export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'stopped' | 'ended' | 'error';

/** BRG-4 playback state: position, rate, track, status. */
export interface PlaybackState {
  /** The track native has loaded, or null before the first `play`. */
  trackId: string | null;
  status: PlaybackStatus;
  positionSec: number;
  /** Omitted until the media duration is known. Never NaN, Infinity or a placeholder. */
  durationSec?: number;
  /** 1 while playing, 0 otherwise. */
  rate: number;
}

export const SPECTRUM_BANDS = 64;
export const WAVEFORM_SAMPLES = 128;
export const MAX_FRAMES_PER_SECOND = 60;
/** Quantisation on the wire: bands, level and bass are 0..255, waveform samples -127..127. */
export const LEVEL_SCALE = 255;
export const WAVEFORM_SCALE = 127;

/**
 * BRG-4 frame as handlers receive it: the `playback` event payload, decoded by the client. Native sends one on
 * every status or track change and up to MAX_FRAMES_PER_SECOND while playing (from an AVAudioEngine tap), so the
 * deck's RPM curve, spindle, LCD, oscilloscope and backdrop pulse run off it exactly as they run off
 * `audio-engine.ts` on the web.
 */
export interface PlaybackFrame extends PlaybackState {
  /** SPECTRUM_BANDS levels 0..1, log spaced 40 Hz to 16 kHz (same bands as `logBins` in `audio-math.ts`). */
  bands: number[];
  /** WAVEFORM_SAMPLES time-domain samples -1..1 for the oscilloscope. All zero while not playing. */
  waveform: number[];
  /** RMS level 0..1. */
  level: number;
  /** Average 40–160 Hz level 0..1 (the backdrop pulse). */
  bass: number;
}

/** The same frame on the wire: integers, so 60 frames a second stay under ~1 KB each (see `encodeFrame`). */
export interface WirePlaybackFrame extends PlaybackState {
  /** SPECTRUM_BANDS integers 0..255. */
  bands: number[];
  /** WAVEFORM_SAMPLES integers -127..127. */
  waveform: number[];
  /** Integer 0..255. */
  level: number;
  /** Integer 0..255. */
  bass: number;
}

export interface LifecyclePayload {
  state: LifecycleState;
}

/** Ownership changed while the experience is open (lend ended or returned, purchase completed, drop went live). */
export type OwnershipPayload = Pick<BridgeContext, 'ownership' | 'editionNumber' | 'ownerDisplayName' | 'unwrapped' | 'lend'>;

export const BRIDGE_EVENTS = ['playback', 'layout', 'wear', 'lifecycle', 'ownership'] as const;
export type BridgeEvent = (typeof BRIDGE_EVENTS)[number];

export interface BridgeEventMap {
  playback: PlaybackFrame;
  layout: LayoutState;
  /** WEAR-10: fires when the descriptor changes. */
  wear: WearDescriptor;
  /** BRG-2 */
  lifecycle: LifecyclePayload;
  ownership: OwnershipPayload;
}

export type Unsubscribe = () => void;

/**
 * PRD §10.2, plus additions the lead approved or the PRD needs (CONTRACT.md §11): `getTracks` (BUN-5 forbids
 * fetching the tracklist), `ready` (NAT-3), `setVolume` (the player's own volume, not the system's) and the
 * optional `startAt` on `play`. `on` returns an unsubscribe function instead of `void`, which every PRD-shaped
 * caller still accepts. Handlers receive a frozen payload shared by every handler of that emit.
 */
export interface MyindBridge {
  getContext(): Promise<BridgeContext>;
  /** [PRD-GAP] The release's tracklist in album order. */
  getTracks(): Promise<BridgeTrack[]>;
  /** Without `startAt`: resume the paused track, else start from 0. With `startAt`: start there, no jump. */
  play(trackId: string, startAt?: number): Promise<void>;
  pause(): Promise<void>;
  seek(seconds: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  getPlaybackState(): Promise<PlaybackState>;
  /** [LEAD-APPROVED] 0..1, the player's own music level (not the system volume). */
  setVolume(volume: number): Promise<void>;
  /** Persisted server side; unwrap plays once per copy. */
  markUnwrapped(): Promise<void>;
  /** Records a "load" wear event. */
  cartridgeLoaded(): Promise<void>;
  /** Records an "eject" wear event. */
  cartridgeEjected(): Promise<void>;
  haptic(kind: HapticKind): void;
  /** Native low latency UI sounds (peel, click, whir). */
  playSound(name: string): void;
  /** Opens the native share sheet (PRD §15). */
  requestShare(): Promise<void>;
  /** Opens the native lend flow (PRD §12). */
  requestLend(): Promise<void>;
  close(): void;
  /** [PRD-GAP] NAT-3: the first frame is on screen; native can drop the splash. */
  ready(): void;
  on<E extends BridgeEvent>(event: E, handler: (payload: BridgeEventMap[E]) => void): Unsubscribe;
}

/** Methods that return a promise and get a `__resolve`. */
export const REQUEST_METHODS = [
  'getContext',
  'getTracks',
  'play',
  'pause',
  'seek',
  'next',
  'previous',
  'getPlaybackState',
  'setVolume',
  'markUnwrapped',
  'cartridgeLoaded',
  'cartridgeEjected',
  'requestShare',
  'requestLend',
] as const;
/** Fire-and-forget methods: posted with `id: null`, native never resolves them. */
export const NOTIFY_METHODS = ['haptic', 'playSound', 'close', 'ready'] as const;
export const BRIDGE_METHODS = [...REQUEST_METHODS, ...NOTIFY_METHODS] as const;

export type RequestMethod = (typeof REQUEST_METHODS)[number];
export type NotifyMethod = (typeof NOTIFY_METHODS)[number];
export type BridgeMethod = RequestMethod | NotifyMethod;

/** The params object each method sends on the wire. Every method sends an object, `{}` when it takes none. */
export interface MethodParams {
  getContext: Record<string, never>;
  getTracks: Record<string, never>;
  play: { trackId: string; startAt?: number };
  pause: Record<string, never>;
  seek: { seconds: number };
  next: Record<string, never>;
  previous: Record<string, never>;
  getPlaybackState: Record<string, never>;
  setVolume: { volume: number };
  markUnwrapped: Record<string, never>;
  cartridgeLoaded: Record<string, never>;
  cartridgeEjected: Record<string, never>;
  requestShare: Record<string, never>;
  requestLend: Record<string, never>;
  haptic: { kind: HapticKind };
  playSound: { name: string };
  close: Record<string, never>;
  ready: Record<string, never>;
}

export interface MethodResults {
  getContext: BridgeContext;
  getTracks: BridgeTrack[];
  getPlaybackState: PlaybackState;
  play: void;
  pause: void;
  seek: void;
  next: void;
  previous: void;
  setVolume: void;
  markUnwrapped: void;
  cartridgeLoaded: void;
  cartridgeEjected: void;
  requestShare: void;
  requestLend: void;
}

/**
 * How long the client waits for `__resolve` before rejecting with E_TIMEOUT. `null` waits forever: share and
 * lend wait on the fan, not on native. [DECIDE] tune with real devices; override per client in its options.
 */
export const DEFAULT_TIMEOUTS_MS: Readonly<Record<RequestMethod, number | null>> = {
  getContext: 10_000,
  getTracks: 10_000,
  play: 10_000,
  pause: 5_000,
  seek: 5_000,
  next: 10_000,
  previous: 10_000,
  getPlaybackState: 5_000,
  setVolume: 5_000,
  markUnwrapped: 10_000,
  cartridgeLoaded: 10_000,
  cartridgeEjected: 10_000,
  requestShare: null,
  requestLend: null,
};

/** [DECIDE] NAT-3: native shows an error with Retry if `ready()` hasn't arrived this long after load. */
export const READY_TIMEOUT_MS = 8_000;
/** LEND-5: a lent play is committed (playsUsed + 1) after this much actual playback of one track start. */
export const LEND_COMMIT_AFTER_SEC = 30;
/** `previous` restarts the current track when it is past this point (matches `PREV_RESTART_THRESHOLD_SEC` in `state.ts`). */
export const PREVIOUS_RESTART_THRESHOLD_SEC = 3;
/** Longest seek or start position accepted, in seconds. */
export const MAX_SEEK_SEC = 6 * 60 * 60;
export const TRACK_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
export const SOUND_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export const BRIDGE_ERROR_CODES = [
  /** Native: method not in the contract (BRG-1). Client: same, raised before posting. */
  'E_UNKNOWN_METHOD',
  /** Native or client: params failed validation (BRG-1). */
  'E_INVALID_PARAMS',
  /** Client only: native returned a result that doesn't match the contract. */
  'E_INVALID_RESULT',
  /** Client only: `on()` with an event not in the contract. */
  'E_UNKNOWN_EVENT',
  /** Native: the server-side ownership forbids it (locked before drop, lend on a lent copy, owner's copy out on loan). */
  'E_NOT_ALLOWED',
  /** Native: a lent copy whose lend has ended (exhausted, expired, returned, revoked, converted). LEND-8. */
  'E_LEND_ENDED',
  /** Native: the trackId isn't in this release. */
  'E_NOT_FOUND',
  /** This platform can't do it (lending on the web). */
  'E_NOT_SUPPORTED',
  /** Needs the network and there is none, and there is no offline copy. Lent plays always need it (LEND-5). */
  'E_OFFLINE',
  /** BRG-3: native and bundle bridge versions are incompatible. */
  'E_BRIDGE_VERSION',
  /** Client only: no `__resolve` within the method's timeout. */
  'E_TIMEOUT',
  /** Client only: no transport, no connect token, or posting failed. */
  'E_TRANSPORT',
  /** Client only: the client was disposed with the call still pending. */
  'E_DISPOSED',
  /** Anything else, including an error that isn't `{ code, message }`. */
  'E_INTERNAL',
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export interface BridgeErrorPayload {
  code: BridgeErrorCode;
  /** Human readable, never PII. */
  message: string;
}

export class BridgeError extends Error {
  readonly code: BridgeErrorCode;
  readonly method: string | null;

  constructor(code: BridgeErrorCode, message: string, method: string | null = null) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    this.method = method;
  }
}

// ── Wire ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * JS → native: `window.webkit.messageHandlers.myind.postMessage(request)` on iOS, the same object as a JSON string
 * through the Android web message port. `id` is a random hex string per request (32 characters), null for
 * NOTIFY_METHODS.
 */
export interface BridgeRequest<M extends BridgeMethod = BridgeMethod> {
  id: string | null;
  method: M;
  params: MethodParams[M];
}

/** What the shim (or the fallback) hands the client: resolves and events, already checked against the channel key. */
export interface BridgeReceiver {
  resolve(id: string, result: unknown, error?: unknown): void;
  emit(event: string, payload: unknown): void;
}

/** What `native-shim.js` defines as `window.myind` (frozen, non-writable). */
export interface NativeShim {
  /** Highest bridge version native speaks. */
  readonly version: number;
  /** Lowest bridge version native still speaks. */
  readonly minVersion: number;
  readonly platform: 'ios' | 'android';
  /** Native only: `key` is the per-page channel key baked into the shim source; calls without it are dropped. */
  __resolve(key: string, id: string, result: unknown, error?: unknown): void;
  __emit(key: string, event: string, payload: unknown): void;
  /**
   * One-shot, and only with the per-page connect token (from the bundle's `<meta name="myind-bridge">`). A wrong
   * token throws without using up the connect. Returns the post function.
   */
  __connect(token: string, receiver: BridgeReceiver): (request: BridgeRequest) => void;
}

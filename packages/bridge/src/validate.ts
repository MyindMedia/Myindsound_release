import {
  BRIDGE_EVENTS,
  BRIDGE_METHODS,
  BridgeError,
  HAPTIC_KINDS,
  LEND_STATUSES,
  LEVEL_SCALE,
  MAX_SEEK_SEC,
  NOTIFY_METHODS,
  SCRATCH_SURFACES,
  SOUND_NAME_PATTERN,
  SPECTRUM_BANDS,
  TRACK_ID_PATTERN,
  WAVEFORM_SAMPLES,
  WAVEFORM_SCALE,
  type BridgeContext,
  type BridgeEvent,
  type BridgeMethod,
  type BridgeTrack,
  type LayoutState,
  type LendState,
  type MethodParams,
  type NotifyMethod,
  type OwnershipPayload,
  type PlaybackState,
  type WearDescriptor,
  type WirePlaybackFrame,
} from './types';

/**
 * BRG-1 on the JS side (the same checks native runs), plus the checks the client runs on everything native sends.
 * Encoding rule for native → JS (CONTRACT.md §5): an optional field may be omitted or null; both mean "absent" and
 * the normalisers below drop it, so handlers only ever see it omitted. Required fields must be present. NaN and
 * Infinity are never valid (JSON can't carry them anyway).
 */

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isInt = (value: unknown, lo: number, hi: number): boolean =>
  typeof value === 'number' && Number.isInteger(value) && value >= lo && value <= hi;
const oneOf = (value: unknown, options: readonly string[]): boolean => typeof value === 'string' && options.includes(value);
const absent = (value: unknown) => value === undefined || value === null;

export function isBridgeMethod(method: unknown): method is BridgeMethod {
  return typeof method === 'string' && (BRIDGE_METHODS as readonly string[]).includes(method);
}

export function isNotifyMethod(method: BridgeMethod): method is NotifyMethod {
  return (NOTIFY_METHODS as readonly string[]).includes(method);
}

export function isBridgeEvent(event: unknown): event is BridgeEvent {
  return typeof event === 'string' && (BRIDGE_EVENTS as readonly string[]).includes(event);
}

export function assertMethod(method: unknown): asserts method is BridgeMethod {
  if (!isBridgeMethod(method)) {
    throw new BridgeError('E_UNKNOWN_METHOD', `Unknown bridge method: ${String(method).slice(0, 64)}`);
  }
}

export function assertEvent(event: unknown): asserts event is BridgeEvent {
  if (!isBridgeEvent(event)) {
    throw new BridgeError('E_UNKNOWN_EVENT', `Unknown bridge event: ${String(event).slice(0, 64)}`);
  }
}

function invalid(method: string, message: string): BridgeError {
  return new BridgeError('E_INVALID_PARAMS', `${method}: ${message}`, method);
}

function onlyKeys(method: string, params: Json, allowed: readonly string[]): void {
  for (const key of Object.keys(params)) {
    if (!allowed.includes(key)) throw invalid(method, `unexpected param "${key.slice(0, 32)}"`);
  }
}

function seconds(method: string, name: string, value: unknown): number {
  if (!isFiniteNumber(value) || value < 0 || value > MAX_SEEK_SEC) {
    throw invalid(method, `${name} must be a finite number from 0 to ${MAX_SEEK_SEC}`);
  }
  return value;
}

/**
 * Checks and returns a clean copy of the params for `method`. Unknown methods throw E_UNKNOWN_METHOD; missing,
 * extra or out of range params throw E_INVALID_PARAMS. `undefined` params mean `{}`; an `undefined` optional
 * param is dropped.
 */
export function validateParams<M extends BridgeMethod>(method: M, params?: unknown): MethodParams[M];
export function validateParams(method: unknown, params?: unknown): MethodParams[BridgeMethod];
export function validateParams(method: unknown, params: unknown = {}): MethodParams[BridgeMethod] {
  assertMethod(method);
  if (!isObject(params)) throw invalid(method, 'params must be an object');

  switch (method) {
    case 'play': {
      onlyKeys(method, params, ['trackId', 'startAt']);
      const { trackId, startAt } = params;
      if (typeof trackId !== 'string' || !TRACK_ID_PATTERN.test(trackId)) {
        throw invalid(method, 'trackId must be 1-128 characters of A-Z a-z 0-9 _ -');
      }
      return startAt === undefined ? { trackId } : { trackId, startAt: seconds(method, 'startAt', startAt) };
    }
    case 'seek':
      onlyKeys(method, params, ['seconds']);
      return { seconds: seconds(method, 'seconds', params.seconds) };
    case 'setVolume': {
      onlyKeys(method, params, ['volume']);
      const { volume } = params;
      if (!isFiniteNumber(volume) || volume < 0 || volume > 1) throw invalid(method, 'volume must be a number from 0 to 1');
      return { volume };
    }
    case 'haptic': {
      onlyKeys(method, params, ['kind']);
      const { kind } = params;
      if (!oneOf(kind, HAPTIC_KINDS)) throw invalid(method, `kind must be one of ${HAPTIC_KINDS.join(', ')}`);
      return { kind: kind as MethodParams['haptic']['kind'] };
    }
    case 'playSound': {
      onlyKeys(method, params, ['name']);
      const { name } = params;
      if (typeof name !== 'string' || !SOUND_NAME_PATTERN.test(name)) {
        throw invalid(method, 'name must be 1-64 characters of a-z 0-9 -, starting with a letter or digit');
      }
      return { name };
    }
    default:
      onlyKeys(method, params, []);
      return {};
  }
}

// ── Normalisers: a clean copy, or null when the value breaks the contract ──────────────────────────────

export function normalizeLayout(value: unknown): LayoutState | null {
  if (!isObject(value)) return null;
  const { widthPt, heightPt, sizeClass, posture, hingeRect } = value;
  if (!isFiniteNumber(widthPt) || !isFiniteNumber(heightPt)) return null;
  if (!oneOf(sizeClass, ['compact', 'regular']) || !oneOf(posture, ['folded', 'open', 'partial', 'standard'])) return null;
  const layout: LayoutState = {
    widthPt,
    heightPt,
    sizeClass: sizeClass as LayoutState['sizeClass'],
    posture: posture as LayoutState['posture'],
  };
  if (absent(hingeRect)) return layout;
  if (!isObject(hingeRect) || ![hingeRect.x, hingeRect.y, hingeRect.w, hingeRect.h].every(isFiniteNumber)) return null;
  layout.hingeRect = { x: hingeRect.x as number, y: hingeRect.y as number, w: hingeRect.w as number, h: hingeRect.h as number };
  return layout;
}

/** Every scratch and scuff zone is checked, so `scratches: [null]` fails. Value rules (ceilings) belong to packages/wear. */
export function normalizeWear(value: unknown): WearDescriptor | null {
  if (!isObject(value)) return null;
  const { version, seed, level, scratches, scuffZones, labelFade, edgeWear, dustAmount } = value;
  if (!isFiniteNumber(version) || typeof seed !== 'string' || !isFiniteNumber(level)) return null;
  if (![labelFade, edgeWear, dustAmount].every(isFiniteNumber)) return null;
  if (!Array.isArray(scratches) || !Array.isArray(scuffZones)) return null;
  const cleanScratches: WearDescriptor['scratches'] = [];
  for (const s of scratches) {
    if (!isObject(s) || !oneOf(s.surface, SCRATCH_SURFACES)) return null;
    if (![s.x, s.y, s.angle, s.length, s.depth].every(isFiniteNumber)) return null;
    cleanScratches.push({
      surface: s.surface as WearDescriptor['scratches'][number]['surface'],
      x: s.x as number,
      y: s.y as number,
      angle: s.angle as number,
      length: s.length as number,
      depth: s.depth as number,
    });
  }
  const cleanZones: WearDescriptor['scuffZones'] = [];
  for (const z of scuffZones) {
    if (!isObject(z) || typeof z.surface !== 'string') return null;
    if (![z.x, z.y, z.radius, z.intensity].every(isFiniteNumber)) return null;
    cleanZones.push({ surface: z.surface, x: z.x as number, y: z.y as number, radius: z.radius as number, intensity: z.intensity as number });
  }
  return {
    version,
    seed,
    level,
    scratches: cleanScratches,
    scuffZones: cleanZones,
    labelFade: labelFade as number,
    edgeWear: edgeWear as number,
    dustAmount: dustAmount as number,
  };
}

export function normalizeLend(value: unknown): LendState | null {
  if (!isObject(value)) return null;
  const { playsAllowed, playsUsed, expiresAt, status, endReason } = value;
  if (!isInt(playsAllowed, 0, Number.MAX_SAFE_INTEGER) || !isInt(playsUsed, 0, Number.MAX_SAFE_INTEGER)) return null;
  if (!isFiniteNumber(expiresAt) || !oneOf(status, LEND_STATUSES)) return null;
  const lend: LendState = { playsAllowed: playsAllowed as number, playsUsed: playsUsed as number, expiresAt, status: status as LendState['status'] };
  if (!absent(endReason)) {
    if (typeof endReason !== 'string') return null;
    lend.endReason = endReason;
  }
  return lend;
}

export function normalizeOwnership(value: unknown): OwnershipPayload | null {
  if (!isObject(value)) return null;
  const { ownership, editionNumber, ownerDisplayName, unwrapped, lend } = value;
  if (!oneOf(ownership, ['owned', 'lent', 'locked', 'preview'])) return null;
  if (!(editionNumber === null || isFiniteNumber(editionNumber))) return null;
  if (!(ownerDisplayName === null || typeof ownerDisplayName === 'string')) return null;
  if (typeof unwrapped !== 'boolean') return null;
  const out: OwnershipPayload = {
    ownership: ownership as OwnershipPayload['ownership'],
    editionNumber: editionNumber as number | null,
    ownerDisplayName: ownerDisplayName as string | null,
    unwrapped,
  };
  if (!absent(lend)) {
    const clean = normalizeLend(lend);
    if (!clean) return null;
    out.lend = clean;
  }
  // A lent copy always says where its lend stands (RACK-1, DS-22).
  if (out.ownership === 'lent' && !out.lend) return null;
  return out;
}

export function normalizeContext(value: unknown): BridgeContext | null {
  const base = normalizeOwnership(value);
  if (!base || !isObject(value)) return null;
  const { releaseId, wear, platform, layout, lifecycle, dropAt, serverNow } = value;
  if (typeof releaseId !== 'string' || !oneOf(platform, ['ios', 'android', 'web'])) return null;
  if (!oneOf(lifecycle, ['background', 'foreground']) || !isFiniteNumber(dropAt) || !isFiniteNumber(serverNow)) return null;
  const cleanLayout = normalizeLayout(layout);
  if (!cleanLayout) return null;
  let cleanWear: WearDescriptor | null = null;
  if (wear !== null) {
    cleanWear = normalizeWear(wear);
    if (!cleanWear) return null;
  }
  return {
    releaseId,
    ...base,
    wear: cleanWear,
    platform: platform as BridgeContext['platform'],
    layout: cleanLayout,
    lifecycle: lifecycle as BridgeContext['lifecycle'],
    dropAt,
    serverNow,
  };
}

export function normalizeTrack(value: unknown): BridgeTrack | null {
  if (!isObject(value)) return null;
  const { id, position, title, durationSeconds, preview } = value;
  if (typeof id !== 'string' || !TRACK_ID_PATTERN.test(id) || !isFiniteNumber(position) || typeof title !== 'string') return null;
  if (!isFiniteNumber(durationSeconds) || typeof preview !== 'boolean') return null;
  return { id, position, title, durationSeconds, preview };
}

const STATUSES = ['idle', 'loading', 'playing', 'paused', 'stopped', 'ended', 'error'];

export function normalizePlaybackState(value: unknown): PlaybackState | null {
  if (!isObject(value)) return null;
  const { trackId, status, positionSec, durationSec, rate } = value;
  if (!(trackId === null || (typeof trackId === 'string' && TRACK_ID_PATTERN.test(trackId)))) return null;
  if (!oneOf(status, STATUSES) || !isFiniteNumber(positionSec) || positionSec < 0 || !isFiniteNumber(rate)) return null;
  const state: PlaybackState = { trackId: trackId as string | null, status: status as PlaybackState['status'], positionSec, rate };
  if (!absent(durationSec)) {
    if (!isFiniteNumber(durationSec) || durationSec <= 0) return null;
    state.durationSec = durationSec;
  }
  return state;
}

/** The quantised wire frame (CONTRACT.md §6): exact lengths, integers in range. */
export function normalizeWireFrame(value: unknown): WirePlaybackFrame | null {
  const state = normalizePlaybackState(value);
  if (!state || !isObject(value)) return null;
  const { bands, waveform, level, bass } = value;
  if (!Array.isArray(bands) || bands.length !== SPECTRUM_BANDS || !bands.every((b) => isInt(b, 0, LEVEL_SCALE))) return null;
  if (!Array.isArray(waveform) || waveform.length !== WAVEFORM_SAMPLES) return null;
  if (!waveform.every((s) => isInt(s, -WAVEFORM_SCALE, WAVEFORM_SCALE))) return null;
  if (!isInt(level, 0, LEVEL_SCALE) || !isInt(bass, 0, LEVEL_SCALE)) return null;
  return { ...state, bands: [...bands], waveform: [...waveform], level: level as number, bass: bass as number };
}

/** Checks a native result for `method` and returns the normalised value. Void methods ignore what native sends back. */
export function validateResult(method: BridgeMethod, result: unknown): unknown {
  const bad = () => new BridgeError('E_INVALID_RESULT', `${method}: native result does not match the contract`, method);
  switch (method) {
    case 'getContext': {
      const context = normalizeContext(result);
      if (!context) throw bad();
      return context;
    }
    case 'getTracks': {
      if (!Array.isArray(result)) throw bad();
      const tracks = result.map(normalizeTrack);
      if (tracks.some((t) => t === null)) throw bad();
      return tracks;
    }
    case 'getPlaybackState': {
      const state = normalizePlaybackState(result);
      if (!state) throw bad();
      return state;
    }
    default:
      return undefined;
  }
}

/** For in-page bridges and tests: does a decoded payload match the contract? */
export function isValidEventPayload(event: BridgeEvent, payload: unknown): boolean {
  switch (event) {
    case 'playback': {
      if (!normalizePlaybackState(payload) || !isObject(payload)) return false;
      const { bands, waveform, level, bass } = payload;
      return (
        Array.isArray(bands) &&
        bands.length === SPECTRUM_BANDS &&
        Array.isArray(waveform) &&
        waveform.length === WAVEFORM_SAMPLES &&
        [...bands, ...waveform, level, bass].every(isFiniteNumber)
      );
    }
    case 'layout':
      return normalizeLayout(payload) !== null;
    case 'wear':
      return normalizeWear(payload) !== null;
    case 'lifecycle':
      return isObject(payload) && oneOf(payload.state, ['background', 'foreground']);
    case 'ownership':
      return normalizeOwnership(payload) !== null;
  }
}

export const isContext = (value: unknown) => normalizeContext(value) !== null;
export const isLayoutState = (value: unknown) => normalizeLayout(value) !== null;
export const isWearDescriptor = (value: unknown) => normalizeWear(value) !== null;
export const isPlaybackFrame = (value: unknown) => isValidEventPayload('playback', value);

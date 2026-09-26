import {
  LEVEL_SCALE,
  SPECTRUM_BANDS,
  WAVEFORM_SAMPLES,
  WAVEFORM_SCALE,
  type PlaybackFrame,
  type WirePlaybackFrame,
} from './types';

/** Wire helpers shared by the client, the loopback transport and the tests. CONTRACT.md §2 and §6. */

const clamp = (value: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, value));
const pad = (values: readonly number[], length: number) =>
  Array.from({ length }, (_, i) => (Number.isFinite(values[i]) ? values[i] : 0));
/** Seconds to the millisecond: the precision the contract promises and the deck can show. */
const ms = (seconds: number) => Math.round(seconds * 1000) / 1000;

/** Float frame → wire frame (what native sends): integers, positions to the millisecond. Under ~1 KB as JSON. */
export function encodeFrame(frame: PlaybackFrame): WirePlaybackFrame {
  const wire: WirePlaybackFrame = {
    trackId: frame.trackId,
    status: frame.status,
    positionSec: ms(frame.positionSec),
    rate: frame.rate,
    bands: pad(frame.bands, SPECTRUM_BANDS).map((b) => Math.round(clamp(b, 0, 1) * LEVEL_SCALE)),
    waveform: pad(frame.waveform, WAVEFORM_SAMPLES).map((s) => Math.round(clamp(s, -1, 1) * WAVEFORM_SCALE)),
    level: Math.round(clamp(frame.level, 0, 1) * LEVEL_SCALE),
    bass: Math.round(clamp(frame.bass, 0, 1) * LEVEL_SCALE),
  };
  if (frame.durationSec !== undefined) wire.durationSec = ms(frame.durationSec);
  return wire;
}

/** Wire frame (already validated) → the float frame handlers receive. */
export function decodeFrame(wire: WirePlaybackFrame): PlaybackFrame {
  return {
    ...wire,
    bands: wire.bands.map((b) => b / LEVEL_SCALE),
    waveform: wire.waveform.map((s) => s / WAVEFORM_SCALE),
    level: wire.level / LEVEL_SCALE,
    bass: wire.bass / LEVEL_SCALE,
  };
}

/** 128 random bits as 32 hex characters. Request ids must not be guessable (CONTRACT.md §2). */
export function randomHex(bytes = 16): string {
  const crypto = (globalThis as { crypto?: Crypto }).crypto;
  if (!crypto?.getRandomValues) throw new Error('crypto.getRandomValues is required for bridge request ids');
  const buffer = crypto.getRandomValues(new Uint8Array(bytes));
  let hex = '';
  for (const byte of buffer) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

export interface BridgeMeta {
  /** The per-page connect token native also baked into the shim. */
  token: string | null;
  version: number | null;
  minVersion: number | null;
}

interface MetaElement {
  getAttribute(name: string): string | null;
  remove(): void;
}
export interface MetaDocument {
  querySelector(selector: string): MetaElement | null;
}

export const BRIDGE_META_NAME = 'myind-bridge';

/** Parses `token=<hex>;version=1;min=1`. */
export function parseBridgeMeta(content: string | null): BridgeMeta {
  const meta: BridgeMeta = { token: null, version: null, minVersion: null };
  for (const part of (content ?? '').split(';')) {
    const [key, value] = part.split('=').map((s) => s.trim());
    if (key === 'token' && /^[0-9a-f]{32,128}$/.test(value ?? '')) meta.token = value;
    if (key === 'version' && /^\d{1,4}$/.test(value ?? '')) meta.version = Number(value);
    if (key === 'min' && /^\d{1,4}$/.test(value ?? '')) meta.minVersion = Number(value);
  }
  return meta;
}

/**
 * Reads native's `<meta name="myind-bridge">` and removes it, so a script that runs after the client can't read
 * the token. The bundle must create its client in its first script, before any other code runs (CONTRACT.md §2).
 */
export function readBridgeMeta(doc: MetaDocument | undefined): BridgeMeta {
  const element = doc?.querySelector(`meta[name="${BRIDGE_META_NAME}"]`) ?? null;
  const meta = parseBridgeMeta(element?.getAttribute('content') ?? null);
  element?.remove();
  return meta;
}

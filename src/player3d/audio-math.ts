/** Pure helpers for time display, link refresh and spectrum analysis. */

export const REFRESH_MARGIN_MS = 10 * 60_000;

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function needsRefresh(expiresAtMs: number, nowMs: number, marginMs = REFRESH_MARGIN_MS): boolean {
  return expiresAtMs - nowMs < marginMs;
}

export function refreshDelayMs(expiresAtMs: number, nowMs: number, marginMs = REFRESH_MARGIN_MS): number {
  return Math.max(0, expiresAtMs - marginMs - nowMs);
}

function hzToIndex(hz: number, sampleRate: number, binCount: number): number {
  const nyquist = sampleRate / 2;
  return Math.min(binCount - 1, Math.max(0, Math.round((hz / nyquist) * binCount)));
}

/** Average level (0..1) of the analyser bins between two frequencies. */
export function bandLevel(freqData: Uint8Array, sampleRate: number, fromHz: number, toHz: number): number {
  const start = hzToIndex(fromHz, sampleRate, freqData.length);
  const end = Math.max(start, hzToIndex(toHz, sampleRate, freqData.length));
  let sum = 0;
  for (let i = start; i <= end; i++) sum += freqData[i];
  return sum / ((end - start + 1) * 255);
}

/** Log-spaced bands from 40 Hz to 16 kHz, each 0..1. */
export function logBins(freqData: Uint8Array, bins: number, sampleRate: number, minHz = 40, maxHz = 16_000): number[] {
  const ratio = Math.pow(maxHz / minHz, 1 / bins);
  const out: number[] = [];
  for (let b = 0; b < bins; b++) {
    const from = minHz * Math.pow(ratio, b);
    out.push(bandLevel(freqData, sampleRate, from, from * ratio));
  }
  return out;
}

/** RMS of 8-bit time-domain data (128 = silence), 0..1. */
export function rmsLevel(timeData: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) {
    const v = (timeData[i] - 128) / 128;
    sum += v * v;
  }
  return Math.min(1, Math.sqrt(sum / timeData.length));
}

/** Value of a [time, value] keyframe curve at `t`: linear between keys, held before the first and after the last. */
export function curveAt(keys: number[][], t: number): number {
  if (t <= keys[0][0]) return keys[0][1];
  for (let i = 1; i < keys.length; i++) {
    const [t1, v1] = keys[i];
    if (t <= t1) {
      const [t0, v0] = keys[i - 1];
      return v0 + ((v1 - v0) * (t - t0)) / Math.max(1e-9, t1 - t0);
    }
  }
  return keys[keys.length - 1][1];
}

import { describe, expect, test } from 'vitest';
import { bandLevel, formatTime, logBins, needsRefresh, refreshDelayMs, rmsLevel } from './audio-math';

describe('formatTime', () => {
  test('m:ss with padding and safe fallbacks', () => {
    expect(formatTime(0)).toBe('0:00');
    expect(formatTime(9.9)).toBe('0:09');
    expect(formatTime(191.84)).toBe('3:11');
    expect(formatTime(Number.NaN)).toBe('0:00');
    expect(formatTime(-5)).toBe('0:00');
  });
});

describe('link refresh', () => {
  const now = 1_000_000;
  test('refreshes inside the 10-minute margin', () => {
    expect(needsRefresh(now + 11 * 60_000, now)).toBe(false);
    expect(needsRefresh(now + 9 * 60_000, now)).toBe(true);
    expect(needsRefresh(now - 1, now)).toBe(true);
  });

  test('schedules the refresh for 10 minutes before expiry', () => {
    expect(refreshDelayMs(now + 2 * 60 * 60_000, now)).toBe(110 * 60_000);
    expect(refreshDelayMs(now + 60_000, now)).toBe(0);
  });
});

describe('spectrum', () => {
  test('logBins returns the requested count in 0..1', () => {
    const data = new Uint8Array(1024).fill(255);
    const bins = logBins(data, 32, 48_000);
    expect(bins).toHaveLength(32);
    expect(bins.every((value) => value === 1)).toBe(true);
    expect(logBins(new Uint8Array(1024), 32, 48_000).every((value) => value === 0)).toBe(true);
  });

  test('bass band reads only low frequencies', () => {
    const data = new Uint8Array(1024);
    // 48 kHz / 2048 fft => 23.4 Hz per bin; 40-140 Hz rounds to bins 2..6.
    for (let i = 2; i <= 6; i++) data[i] = 255;
    expect(bandLevel(data, 48_000, 40, 140)).toBeGreaterThan(0.9);
    expect(bandLevel(data, 48_000, 2000, 8000)).toBe(0);
  });

  test('rmsLevel of silence is 0 and of a full-scale square is 1', () => {
    expect(rmsLevel(new Uint8Array(512).fill(128))).toBe(0);
    const square = new Uint8Array(512).map((_, i) => (i % 2 ? 255 : 0));
    expect(rmsLevel(square)).toBeGreaterThan(0.99);
  });
});

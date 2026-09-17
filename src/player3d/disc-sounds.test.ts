import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import sounds from './disc-sounds.json';
import { SPIN_LEAD_SECONDS, SPIN_UP_MOTOR_AT } from './disc-sounds';
import { curveAt } from './audio-math';

const last = (keys: number[][]) => keys[keys.length - 1];

describe('disc mechanics sounds', () => {
  test('files exist', () => {
    for (const part of [sounds.spinUp, sounds.loop, sounds.spinDown, sounds.unload]) {
      expect(existsSync(resolve('public', `.${part.url}`))).toBe(true);
    }
  });

  test('spin-up: the disc reaches full speed exactly as the sound ends; the clamp comes before the motor', () => {
    expect(last(sounds.spinUp.rpm)).toEqual([sounds.spinUp.duration, 1]);
    expect(sounds.spinUp.clampAt).toBeLessThan(SPIN_UP_MOTOR_AT);
  });

  test('the disc starts turning a moment before the motor is heard', () => {
    // SPIN_UP_MOTOR_AT is where the sound's motor takes hold; the deck starts its curve there, and plays the
    // sound from SPIN_LEAD_SECONDS earlier, so the picture leads.
    expect(curveAt(sounds.spinUp.rpm, SPIN_UP_MOTOR_AT)).toBe(0);
    expect(curveAt(sounds.spinUp.rpm, SPIN_UP_MOTOR_AT + 0.1)).toBeGreaterThan(0);
    expect(SPIN_LEAD_SECONDS).toBeGreaterThan(0);
    expect(SPIN_LEAD_SECONDS).toBeLessThan(SPIN_UP_MOTOR_AT);
  });

  test('spin-down: the disc stops as the sound ends, and speed never rises on the way down', () => {
    expect(last(sounds.spinDown.rpm)[1]).toBe(0);
    expect(Math.abs(last(sounds.spinDown.rpm)[0] - sounds.spinDown.duration)).toBeLessThan(0.05);
    const speeds = sounds.spinDown.rpm.map(([, speed]) => speed);
    expect(speeds).toEqual([...speeds].sort((a, b) => b - a));
  });

  test('unload: the hub unclamps, then the cartridge is released before the sound ends', () => {
    const { unclampAt, releaseAt, duration } = sounds.unload;
    // The eject starts the spindle drop 0.1 s before the unclamp.
    expect(unclampAt).toBeGreaterThanOrEqual(0.1);
    expect(releaseAt).toBeGreaterThan(unclampAt + 0.3);
    expect(releaseAt).toBeLessThan(duration);
  });

  test('the loop has guard bands and a 6 s body', () => {
    expect(sounds.loop.guard).toBeGreaterThan(0.1);
    expect(sounds.loop.length).toBeCloseTo(6, 1);
  });
});

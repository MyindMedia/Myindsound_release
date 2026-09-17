import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import sounds from './disc-sounds.json';

const last = (keys: number[][]) => keys[keys.length - 1];

describe('disc mechanics sounds', () => {
  test('files exist', () => {
    for (const part of [sounds.spinUp, sounds.loop, sounds.spinDown]) {
      expect(existsSync(resolve('public', `.${part.url}`))).toBe(true);
    }
  });

  test('spin-up: the disc reaches full speed exactly as the sound ends; the clamp comes before the motor', () => {
    expect(last(sounds.spinUp.rpm)).toEqual([sounds.spinUp.duration, 1]);
    const motorStart = [...sounds.spinUp.rpm].reverse().find((key) => key[1] === 0)![0];
    expect(sounds.spinUp.clampAt).toBeLessThan(motorStart);
    expect(sounds.spinUp.resumeFrom).toBeLessThan(motorStart);
  });

  test('spin-down: the disc stops as the sound ends, and speed never rises on the way down', () => {
    expect(last(sounds.spinDown.rpm)[1]).toBe(0);
    expect(Math.abs(last(sounds.spinDown.rpm)[0] - sounds.spinDown.duration)).toBeLessThan(0.05);
    const speeds = sounds.spinDown.rpm.map(([, speed]) => speed);
    expect(speeds).toEqual([...speeds].sort((a, b) => b - a));
  });

  test('the loop has guard bands and a 6 s body', () => {
    expect(sounds.loop.guard).toBeGreaterThan(0.1);
    expect(sounds.loop.length).toBeCloseTo(6, 1);
  });
});

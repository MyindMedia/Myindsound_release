import { beforeAll, describe, expect, test } from 'vitest';

/** Just enough of HTMLAudioElement: `src` resolves to an absolute URL and a new source starts at 0. */
class FakeAudio extends EventTarget {
  crossOrigin = '';
  preload = '';
  readyState = 4;
  paused = true;
  ended = false;
  volume = 1;
  currentTime = 0;
  private source = '';
  get src(): string {
    return this.source;
  }
  set src(value: string) {
    this.source = new URL(value, 'https://stream.myindsound.com/stream').href;
    this.currentTime = 0;
  }
  pause(): void {
    this.paused = true;
  }
}

let AudioEngine: typeof import('./audio-engine').AudioEngine;

beforeAll(async () => {
  Object.assign(globalThis, { Audio: FakeAudio, window: { location: { href: 'https://stream.myindsound.com/stream' } } });
  ({ AudioEngine } = await import('./audio-engine'));
});

describe('AudioEngine.load', () => {
  test('a new track starts from the beginning', () => {
    const engine = new AudioEngine();
    engine.load('/assets/audio/a.mp3');
    engine.element.currentTime = 42;
    engine.load('/assets/audio/b.mp3');
    expect(engine.element.src).toBe('https://stream.myindsound.com/assets/audio/b.mp3');
    expect(engine.element.currentTime).toBe(0);
  });

  test('loading the same file again restarts it instead of carrying on', () => {
    const engine = new AudioEngine();
    engine.load('/assets/audio/a.mp3');
    engine.element.currentTime = 42;
    engine.load('/assets/audio/a.mp3');
    expect(engine.element.currentTime).toBe(0);
  });

  test('a start time resumes there (link refresh recovery)', () => {
    const engine = new AudioEngine();
    engine.load('/assets/audio/a.mp3', 12);
    expect(engine.element.currentTime).toBe(12);
  });
});

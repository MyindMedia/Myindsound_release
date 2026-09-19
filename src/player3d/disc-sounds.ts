import sounds from './disc-sounds.json';

/**
 * Disc mechanics, cut from a real drive recording by `npm run disc-sounds`: spin-up (loading clunks, clamp,
 * motor whine), a seamless spinning loop, spin-down (brake click and decay), and unload (the load sound,
 * played before the eject). The deck follows the same RPM curves and markers (`disc-sounds.json`), so
 * what you hear and what you see line up.
 * Plays on the engine's AudioContext, beside the music (not through the spectrum analyser).
 */

export const DISC_SOUNDS = sounds;

/** Where the motor takes hold in the spin-up sound: before this it's only the loading mechanism. */
export const SPIN_UP_MOTOR_AT = [...sounds.spinUp.rpm].reverse().find(([, speed]) => speed === 0)![0];
/** The disc starts turning this long before its motor is heard, so the picture leads the sound. */
export const SPIN_LEAD_SECONDS = 0.2;

type Part = 'spinUp' | 'loop' | 'spinDown' | 'unload';

/** Mechanics level against the music volume; the loop sits under the music. */
const MIX = 0.6;
/** And drops further once a song is playing: the drive is texture under it, not something beside it. */
const DUCK = 0.34;
const LEVEL: Record<Part, number> = { spinUp: 1, loop: 0.5, spinDown: 1, unload: 1 };

interface Voice {
  part: Part;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class DiscMechanics {
  private ctx: AudioContext | null = null;
  private output: GainNode | null = null;
  private readonly files: Promise<Partial<Record<Part, ArrayBuffer>>>;
  private buffers: Partial<Record<Part, AudioBuffer>> = {};
  private voices: Voice[] = [];
  private loop: Voice | null = null;
  private volume = 0.8;
  private ducked = false;

  constructor() {
    // Fetched up front so the sounds are ready by the time the disc seats.
    const parts: Part[] = ['spinUp', 'loop', 'spinDown', 'unload'];
    this.files = Promise.all(
      parts.map((part) =>
        fetch(sounds[part].url)
          .then((response) => (response.ok ? response.arrayBuffer() : null))
          .catch(() => null),
      ),
    ).then((data) => Object.fromEntries(parts.flatMap((part, i) => (data[i] ? [[part, data[i]]] : []))));
  }

  /** Call once the engine's AudioContext exists (inside the unlocking gesture). */
  attach(ctx: AudioContext | null): void {
    if (!ctx || this.ctx) return;
    this.ctx = ctx;
    this.output = ctx.createGain();
    this.output.gain.value = this.volume * MIX * (this.ducked ? DUCK : 1);
    this.output.connect(ctx.destination);
    void this.files.then(async (files) => {
      for (const [part, data] of Object.entries(files) as [Part, ArrayBuffer][]) {
        try {
          this.buffers[part] = await ctx.decodeAudioData(data.slice(0));
        } catch {
          /* A part that won't decode stays silent; the animation timing doesn't depend on it. */
        }
      }
    });
  }

  setVolume(value: number): void {
    this.volume = value;
    this.applyOutput(0.05);
  }

  /** Music is playing: the drive drops under it, and comes back up when the song stops. */
  setDucked(value: boolean): void {
    if (this.ducked === value) return;
    this.ducked = value;
    this.applyOutput(0.3);
  }

  private applyOutput(seconds: number): void {
    if (!this.ctx || !this.output) return;
    const level = this.volume * MIX * (this.ducked ? DUCK : 1);
    this.output.gain.setTargetAtTime(level, this.ctx.currentTime, seconds);
  }

  /** Spin-up from `from` seconds into the sound, then the loop from the moment it ends. */
  spinUp(from = 0): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.silence(0.05);
    const now = ctx.currentTime;
    if (this.buffers.spinUp) this.play('spinUp', now, from);
    this.startLoop(now + Math.max(0, sounds.spinUp.duration - from));
  }

  spinDown(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.silence(0.06);
    if (this.buffers.spinDown) this.play('spinDown', ctx.currentTime, 0);
  }

  /** Stopped before the disc moved (paused or ejected early in a spin-up): drop the pending spin-up and loop. */
  cancelSpinUp(): void {
    this.silence(0.05, ['spinUp', 'loop']);
  }

  /** Before the eject: the hub unclamps and the catch releases (`unload.unclampAt`, `unload.releaseAt`). */
  unload(): void {
    const ctx = this.ctx;
    if (!ctx || !this.buffers.unload) return;
    this.play('unload', ctx.currentTime, 0);
  }

  /** The loop follows the disc speed (e.g. the dip while the laser recalibrates). */
  setSpeed(fraction: number): void {
    if (!this.ctx || !this.loop) return;
    const rate = 0.6 + 0.4 * Math.min(1, Math.max(0, fraction));
    this.loop.source.playbackRate.setTargetAtTime(rate, this.ctx.currentTime, 0.12);
  }

  private startLoop(at: number): void {
    if (!this.buffers.loop) return;
    // Loop points sit inside the guard bands, so the seam is the crossfaded one baked into the file.
    this.loop = this.play('loop', at, sounds.loop.guard, [sounds.loop.guard, sounds.loop.guard + sounds.loop.length]);
  }

  private play(part: Part, at: number, offset: number, loop?: [number, number]): Voice {
    const ctx = this.ctx!;
    const source = ctx.createBufferSource();
    source.buffer = this.buffers[part]!;
    if (loop) {
      source.loop = true;
      [source.loopStart, source.loopEnd] = loop;
    }
    const gain = ctx.createGain();
    gain.gain.value = LEVEL[part];
    source.connect(gain).connect(this.output!);
    source.start(at, offset);
    const voice = { part, source, gain };
    this.voices.push(voice);
    source.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
      if (this.loop === voice) this.loop = null;
    };
    return voice;
  }

  private silence(seconds: number, parts?: Part[]): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    const stopping = this.voices.filter((voice) => !parts || parts.includes(voice.part));
    for (const voice of stopping) {
      voice.gain.gain.cancelScheduledValues(now);
      voice.gain.gain.setValueAtTime(voice.gain.gain.value, now);
      voice.gain.gain.linearRampToValueAtTime(0, now + seconds);
      try {
        voice.source.stop(now + seconds + 0.02);
      } catch {
        /* already stopped */
      }
    }
    this.voices = this.voices.filter((voice) => !stopping.includes(voice));
    if (this.loop && stopping.includes(this.loop)) this.loop = null;
  }
}

import sounds from './wrap-sounds.json';
import { UNWRAP } from './wrap-math';

/**
 * Unwrapping, from Lawrence's own recordings (`npm run wrap-sounds`): a plastic wrap peel and a hand pulling
 * card. Both are short one-shots, so the peel is layered across its phase at varying speeds to cover it, and
 * the hand lands on the sleeve coming off. Plays on the engine's AudioContext, beside the music.
 */

type Part = keyof typeof sounds;

/** Against the music volume. */
const MIX = 0.85;

const buffers: Partial<Record<Part, AudioBuffer>> = {};
let fetched: Promise<Partial<Record<Part, ArrayBuffer>>> | null = null;

function files(): Promise<Partial<Record<Part, ArrayBuffer>>> {
  if (!fetched) {
    const parts = Object.keys(sounds) as Part[];
    fetched = Promise.all(
      parts.map((part) =>
        fetch(sounds[part].url)
          .then((response) => (response.ok ? response.arrayBuffer() : null))
          .catch(() => null),
      ),
    ).then((data) => Object.fromEntries(parts.flatMap((part, i) => (data[i] ? [[part, data[i]]] : []))));
  }
  return fetched;
}

/** Starts the download as the packaging is built, so the gesture only has to decode. */
export function prefetchUnwrapSounds(): void {
  void files();
}

/** Decodes both sounds against this context. */
export async function loadUnwrapSounds(ctx: AudioContext): Promise<void> {
  const data = await files();
  for (const [part, bytes] of Object.entries(data) as [Part, ArrayBuffer][]) {
    if (buffers[part]) continue;
    try {
      buffers[part] = await ctx.decodeAudioData(bytes.slice(0));
    } catch {
      /* A sound that won't decode stays silent; the animation doesn't depend on it. */
    }
  }
}

interface Hit {
  part: Part;
  at: number;
  level: number;
  rate: number;
}

function play(ctx: AudioContext, out: GainNode, now: number, hit: Hit): void {
  const buffer = buffers[hit.part];
  if (!buffer) return;
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = hit.rate;
  const gain = ctx.createGain();
  gain.gain.value = hit.level;
  source.connect(gain).connect(out);
  source.start(now + hit.at);
}

/** One pass of the peel across its phase, then the hand taking the sleeve off. Returns the length in seconds. */
export function playUnwrap(ctx: AudioContext, volume: number): number {
  const out = ctx.createGain();
  out.gain.value = Math.max(0, Math.min(1, volume)) * MIX;
  out.connect(ctx.destination);
  const now = ctx.currentTime;
  // One peel, slowed to run the length of the peel, and one hand on the sleeve. Nothing repeats.
  const hits: Hit[] = [
    {
      part: 'peel',
      at: UNWRAP.peel.at,
      level: 1,
      rate: Math.max(0.4, sounds.peel.duration / UNWRAP.peel.duration),
    },
    { part: 'sleeve', at: Math.max(0, UNWRAP.slide.at - 0.1), level: 1, rate: 0.9 },
  ];

  for (const hit of hits) play(ctx, out, now, hit);
  window.setTimeout(() => out.disconnect(), (UNWRAP.total + 0.5) * 1000);
  return UNWRAP.total;
}

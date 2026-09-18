/**
 * The music follows you round the site.
 *
 * Every page but the player imports this. If the player was playing when the visitor left it, it left a
 * handoff behind (`playback-handoff.ts`); this picks it up, works out where the track would be by now and
 * carries on in a small set of controls in the bottom right corner (a bar across the bottom on a phone).
 *
 * Styling lives with the rest of the site's chrome in `theme.css`.
 */
import {
  clearHandoff,
  readHandoff,
  resumeFrom,
  writeHandoff,
  type Handoff,
  type HandoffTrack,
} from './playback-handoff';

/** How often the handoff is rewritten while it plays, so the next page starts close to the right spot. */
const SAVE_EVERY_MS = 2000;

const ICONS = {
  prev: '<path d="M14 5 7 10l7 5V5Z" fill="currentColor"/><rect x="4" y="5" width="2" height="10" fill="currentColor"/>',
  next: '<path d="M6 5l7 5-7 5V5Z" fill="currentColor"/><rect x="14" y="5" width="2" height="10" fill="currentColor"/>',
  play: '<path d="M6 4.5 16 10 6 15.5v-11Z" fill="currentColor"/>',
  pause: '<rect x="5" y="4.5" width="3.5" height="11" fill="currentColor"/><rect x="11.5" y="4.5" width="3.5" height="11" fill="currentColor"/>',
  close: '<path d="M5 5l8 8M13 5l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
};

const icon = (name: keyof typeof ICONS): string =>
  `<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const clock = (seconds: number): string => {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  return `${Math.floor(safe / 60)}:${String(safe % 60).padStart(2, '0')}`;
};

class MiniPlayer {
  private readonly audio = new Audio();
  private readonly root = document.createElement('div');
  private readonly title: HTMLElement;
  private readonly time: HTMLElement;
  private readonly fill: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly playButton: HTMLButtonElement;
  private tracks: HandoffTrack[];
  private index: number;
  private access: Handoff['access'];
  private volume: number;
  private lastSave = 0;

  constructor(state: Handoff) {
    const from = resumeFrom(state, Date.now());
    this.tracks = state.tracks;
    this.index = from.index;
    this.access = state.access;
    this.volume = state.volume;

    this.root.className = 'mini-player';
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Now playing');
    this.root.innerHTML = `
      <a class="mini-player__art" href="/" aria-label="Back to the player">
        <img class="mini-player__shell" src="/assets/images/minidisc/shell.webp" alt="" />
        <img class="mini-player__disc" src="/assets/images/minidisc/disc.webp" alt="" />
      </a>
      <div class="mini-player__body">
        <a class="mini-player__title" href="/"></a>
        <div class="mini-player__meta">
          <span class="mini-player__tag">${state.access === 'full' ? 'Full' : 'Preview'}</span>
          <span class="mini-player__time mono">0:00</span>
        </div>
        <div class="mini-player__bar" role="slider" tabindex="0" aria-label="Seek"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
      </div>
      <div class="mini-player__keys">
        <button type="button" class="mini-player__key" data-key="prev" aria-label="Previous track">${icon('prev')}</button>
        <button type="button" class="mini-player__key mini-player__key--play" data-key="play" aria-label="Play">${icon('play')}</button>
        <button type="button" class="mini-player__key" data-key="next" aria-label="Next track">${icon('next')}</button>
      </div>
      <button type="button" class="mini-player__close" aria-label="Stop the music">${icon('close')}</button>`;

    this.title = this.root.querySelector('.mini-player__title')!;
    this.time = this.root.querySelector('.mini-player__time')!;
    this.bar = this.root.querySelector('.mini-player__bar')!;
    this.fill = this.bar.querySelector('i')!;
    this.playButton = this.root.querySelector('[data-key="play"]')!;

    this.audio.preload = 'auto';
    this.audio.volume = Math.max(0, Math.min(1, state.volume));
    document.body.appendChild(this.root);
    this.wire();
    this.load(from.positionSec, from.playing);
  }

  private get track(): HandoffTrack | undefined {
    return this.tracks[this.index];
  }

  private wire(): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('.mini-player__key')) {
      button.addEventListener('click', () => {
        const key = button.dataset.key;
        if (key === 'play') void this.toggle();
        else if (key === 'next') this.skip(1);
        else if (key === 'prev') this.skip(-1);
      });
    }
    this.root.querySelector('.mini-player__close')!.addEventListener('click', () => this.dismiss());

    // Anywhere on the bar seeks; the keyboard nudges it in ten-second steps.
    const seekTo = (clientX: number): void => {
      const box = this.bar.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - box.left) / box.width));
      if (Number.isFinite(this.audio.duration)) this.audio.currentTime = ratio * this.audio.duration;
    };
    this.bar.addEventListener('pointerdown', (event) => seekTo(event.clientX));
    this.bar.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight') this.audio.currentTime += 10;
      else if (event.key === 'ArrowLeft') this.audio.currentTime -= 10;
      else return;
      event.preventDefault();
    });

    this.audio.addEventListener('timeupdate', () => this.tick());
    this.audio.addEventListener('play', () => this.paint());
    this.audio.addEventListener('pause', () => this.paint());
    this.audio.addEventListener('ended', () => this.skip(1, { onlyIfMore: true }));
    this.audio.addEventListener('error', () => this.dismiss());
    // The next page has to know where the music got to, even if it is closed in a hurry.
    window.addEventListener('pagehide', () => this.save(true));
    document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && this.save(true));
  }

  /** Points the element at a track, optionally from part way in, and tries to carry on playing. */
  private load(positionSec: number, playing: boolean): void {
    const track = this.track;
    if (!track) return this.dismiss();
    this.audio.src = track.streamUrl;
    const seek = (): void => {
      if (positionSec > 0) this.audio.currentTime = positionSec;
    };
    if (this.audio.readyState >= 1) seek();
    else this.audio.addEventListener('loadedmetadata', seek, { once: true });
    this.paint();
    this.announce();
    if (playing) {
      this.audio.play().catch(() => {
        // Autoplay refused on this page: leave it cued up and say so on the button.
        this.root.classList.add('mini-player--blocked');
        this.paint();
      });
    }
  }

  private async toggle(): Promise<void> {
    this.root.classList.remove('mini-player--blocked');
    if (this.audio.paused) {
      try {
        await this.audio.play();
      } catch {
        /* Still refused: the button stays as it is. */
      }
    } else {
      this.audio.pause();
    }
    this.save(true);
  }

  private skip(by: number, { onlyIfMore = false } = {}): void {
    const next = this.index + by;
    if (next < 0) {
      this.audio.currentTime = 0;
      return;
    }
    if (next >= this.tracks.length) {
      if (onlyIfMore) {
        this.audio.pause();
        this.save(true);
        return;
      }
      return;
    }
    const wasPlaying = !this.audio.paused || onlyIfMore;
    this.index = next;
    this.load(0, wasPlaying);
    this.save(true);
  }

  private tick(): void {
    const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : this.track?.durationSeconds ?? 0;
    const ratio = duration > 0 ? Math.min(1, this.audio.currentTime / duration) : 0;
    this.fill.style.width = `${(ratio * 100).toFixed(2)}%`;
    this.bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
    this.time.textContent = `${clock(this.audio.currentTime)} / ${clock(duration)}`;
    if (performance.now() - this.lastSave > SAVE_EVERY_MS) this.save();
  }

  private paint(): void {
    const track = this.track;
    const number = String(track?.position ?? 1).padStart(2, '0');
    this.title.textContent = `${number} · ${track?.title ?? ''}`;
    this.title.setAttribute('title', `${track?.title ?? ''} — back to the player`);
    const playing = !this.audio.paused;
    this.playButton.innerHTML = icon(playing ? 'pause' : 'play');
    this.playButton.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.root.classList.toggle('mini-player--playing', playing);
    if (playing) this.root.classList.remove('mini-player--blocked');
  }

  /** Lock screens and headphone buttons, where the browser offers them. */
  private announce(): void {
    if (!('mediaSession' in navigator)) return;
    const track = this.track;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track?.title ?? 'LIT',
      artist: 'Tha Myind',
      album: this.access === 'full' ? 'LIT' : 'LIT (previews)',
      artwork: [{ src: '/assets/images/lit-sleeve.webp', sizes: '512x512', type: 'image/webp' }],
    });
    navigator.mediaSession.setActionHandler('play', () => void this.toggle());
    navigator.mediaSession.setActionHandler('pause', () => void this.toggle());
    navigator.mediaSession.setActionHandler('previoustrack', () => this.skip(-1));
    navigator.mediaSession.setActionHandler('nexttrack', () => this.skip(1));
  }

  private save(force = false): void {
    if (!force && performance.now() - this.lastSave < SAVE_EVERY_MS) return;
    this.lastSave = performance.now();
    writeHandoff({
      tracks: this.tracks,
      index: this.index,
      positionSec: this.audio.currentTime,
      playing: !this.audio.paused,
      at: Date.now(),
      access: this.access,
      volume: this.volume,
    });
  }

  /** Closed by hand, or the audio failed: stop, forget it, and take the controls off the page. */
  private dismiss(): void {
    this.audio.pause();
    this.audio.removeAttribute('src');
    clearHandoff();
    this.root.remove();
  }
}

export function mountMiniPlayer(): void {
  if (document.querySelector('.mini-player')) return;
  const state = readHandoff();
  // Nothing was playing when they left the player, so there is nothing to carry.
  if (!state) return;
  new MiniPlayer(state);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => mountMiniPlayer(), { once: true });
} else {
  mountMiniPlayer();
}

import { formatTime } from './audio-math';
import { BootTerminal, drawWaveform, glitchText, RadialGauge, Sparkline } from './hud-fx';
import type { DeckState, DeckStatus } from './state';
import type { PlayerTrack, StreamAccess } from './track-source';

export interface HudHandlers {
  onSelect(index: number): void;
  onInsert(): void;
  onRepeat(): void;
  onVolume(value: number): void;
  onRetry(): void;
  /** GET LIT: opens the pay-what-you-want checkout on the page. */
  onGetLit(): void;
}

export interface HudFrame {
  state: DeckState;
  track: PlayerTrack | null;
  rpm: number;
  level: number;
  spectrum: number[];
  waveform: number[];
  simulated: boolean;
  volume: number;
}

const STATUS_TEXT: Record<DeckStatus, string> = {
  booting: 'BOOTING',
  inserting: 'LOADING',
  reading: 'READING',
  playing: 'PLAY',
  paused: 'PAUSE',
  stopped: 'STOP',
  resuming: 'SPIN UP',
  seeking: 'CALIBRATING',
  ejecting: 'EJECTING',
  ejected: 'EJECTED',
};

const pad2 = (n: number) => String(n).padStart(2, '0');

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function readout(label: string): { row: HTMLElement; value: HTMLElement } {
  const row = el('div', 'p3d-readout');
  row.append(el('span', 'p3d-readout__label', label));
  const value = el('span', 'p3d-readout__value p3d-mono', '--');
  row.append(value);
  return { row, value };
}

/** HTML HUD: tracklist, readouts, spectrum and the phone strip. The deck's own LCD carries the status. */
export class Hud {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly frame: HTMLElement;
  readonly keysHost: HTMLElement;
  /** Invisible box (sized in CSS per layout) that the ejected cartridge is fitted into. */
  readonly stage: HTMLElement;
  private handlers: HudHandlers;
  private statusEl: HTMLElement;
  private statusText: HTMLElement;
  private insertButton: HTMLButtonElement;
  private inspectHint: HTMLElement;
  private repeatButton: HTMLButtonElement;
  private accessNote: HTMLElement;
  private openHint: HTMLButtonElement;
  private hudLayer: HTMLElement;
  private listMeta: HTMLElement;
  private sheetSuffix = '';
  private lastRepeat: boolean | null = null;
  private boot: HTMLElement;
  private bootBar: HTMLElement;
  private bootPercent: HTMLElement;
  private errorBox: HTMLElement;
  private list: HTMLOListElement;
  private trackButtons: HTMLButtonElement[] = [];
  private stripStatus: HTMLElement;
  private stripTime: HTMLElement;
  private stripTrack: HTMLElement;
  private stripRpm: HTMLElement;
  private readouts: Record<'time' | 'track' | 'rpm' | 'format' | 'repeat', HTMLElement>;
  private sparkline = new Sparkline(60, 0.6);
  private gauge = new RadialGauge();
  private terminal: BootTerminal;
  private readonly reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  private signalMode: HTMLElement;
  private volumeInput: HTMLInputElement;
  private spectrumCanvas: HTMLCanvasElement;
  private spectrumCtx: CanvasRenderingContext2D | null;
  private sheetToggle: HTMLButtonElement;
  private sheetLabel: HTMLElement;
  private tracks: PlayerTrack[] = [];
  private lastStatus: DeckStatus | null = null;
  private lastIndex = -1;
  private errorActive = false;

  constructor(root: HTMLElement, handlers: HudHandlers) {
    this.root = root;
    this.handlers = handlers;
    root.classList.add('p3d');
    root.replaceChildren();

    this.canvas = el('canvas', 'p3d-canvas');
    this.canvas.setAttribute('aria-hidden', 'true');

    const hud = el('div', 'p3d-hud');

    // Phone top strip.
    const strip = el('div', 'p3d-strip p3d-mono');
    strip.setAttribute('aria-hidden', 'true');
    this.stripStatus = el('span', 'p3d-strip__status', 'BOOTING');
    this.stripTime = el('span', '', '0:00');
    this.stripTrack = el('span', '', 'TRK --/--');
    this.stripRpm = el('span', '', '0 RPM');
    strip.append(this.stripStatus, this.stripTime, this.stripTrack, this.stripRpm);

    // Tracklist panel (bottom sheet on narrow screens).
    const tracklist = el('section', 'p3d-panel p3d-tracklist');
    tracklist.setAttribute('aria-label', 'Tracklist');
    const header = el('header', 'p3d-panel__header');
    this.listMeta = el('span', 'p3d-panel__meta p3d-mono', 'SIDE A');
    header.append(el('span', 'p3d-panel__title', 'LIT · TRACKLIST'), this.listMeta);
    this.list = el('ol', 'p3d-tracks');
    this.repeatButton = el('button', 'p3d-repeat p3d-mono');
    this.repeatButton.type = 'button';
    this.repeatButton.setAttribute('aria-pressed', 'false');
    this.repeatButton.addEventListener('click', () => handlers.onRepeat());
    this.accessNote = el('div', 'p3d-access');
    this.accessNote.hidden = true;
    tracklist.append(header, this.list, this.repeatButton, this.accessNote);

    this.sheetToggle = el('button', 'p3d-sheet-toggle p3d-mono');
    this.sheetToggle.type = 'button';
    this.sheetToggle.setAttribute('aria-expanded', 'false');
    this.sheetLabel = el('span', '', 'TRACKLIST --/--');
    this.sheetToggle.append(this.sheetLabel, el('span', 'p3d-sheet-toggle__chevron', '▲'));
    this.sheetToggle.addEventListener('click', () => {
      const open = !this.root.classList.contains('p3d--sheet-open');
      this.root.classList.toggle('p3d--sheet-open', open);
      this.sheetToggle.setAttribute('aria-expanded', String(open));
    });

    this.frame = el('div', 'p3d-frame');

    // Readouts panel.
    const readoutsPanel = el('section', 'p3d-panel p3d-readouts');
    readoutsPanel.setAttribute('aria-label', 'Deck readouts');
    const rHeader = el('header', 'p3d-panel__header');
    rHeader.append(el('span', 'p3d-panel__title', 'DECK · MD-01'), el('span', 'p3d-panel__meta p3d-mono', 'ONLINE'));
    const time = readout('TIME');
    const track = readout('TRACK');
    const rpm = readout('RPM');
    rpm.row.insertBefore(this.gauge.element, rpm.value);
    const format = readout('FORMAT');
    const repeat = readout('REPEAT');
    this.readouts = { time: time.value, track: track.value, rpm: rpm.value, format: format.value, repeat: repeat.value };
    const signal = el('div', 'p3d-readout p3d-readout--signal');
    this.signalMode = el('span', 'p3d-readout__label', 'SIGNAL');
    signal.append(this.signalMode, this.sparkline.canvas);

    const volume = el('label', 'p3d-volume');
    volume.append(el('span', 'p3d-readout__label', 'VOL'));
    this.volumeInput = el('input', 'p3d-volume__input');
    this.volumeInput.type = 'range';
    this.volumeInput.min = '0';
    this.volumeInput.max = '100';
    this.volumeInput.setAttribute('aria-label', 'Volume');
    this.volumeInput.addEventListener('input', () => handlers.onVolume(Number(this.volumeInput.value) / 100));
    volume.append(this.volumeInput);
    readoutsPanel.append(rHeader, time.row, track.row, rpm.row, signal, format.row, repeat.row, volume);

    // Spectrum.
    const spectrumWrap = el('div', 'p3d-spectrum');
    this.spectrumCanvas = el('canvas');
    this.spectrumCanvas.setAttribute('aria-hidden', 'true');
    spectrumWrap.append(this.spectrumCanvas);
    this.spectrumCtx = this.spectrumCanvas.getContext('2d');

    hud.append(strip, tracklist, this.frame, readoutsPanel, spectrumWrap, this.sheetToggle);
    this.hudLayer = hud;

    // Anchored overlays. The status is announced to screen readers only: on screen it's on the deck's LCD
    // (and in the phone strip).
    this.statusEl = el('div', 'p3d-status');
    this.statusText = el('span', '', 'BOOTING');
    this.statusEl.append(this.statusText);
    this.statusEl.setAttribute('role', 'status');
    this.statusEl.setAttribute('aria-live', 'polite');

    this.openHint = el('button', 'p3d-open-hint p3d-mono', 'DOUBLE-CLICK TO UNWRAP');
    this.openHint.type = 'button';
    this.openHint.hidden = true;

    this.insertButton = el('button', 'p3d-insert p3d-mono', 'INSERT DISC');
    this.insertButton.type = 'button';
    this.insertButton.addEventListener('click', () => handlers.onInsert());

    this.stage = el('div', 'p3d-stage');
    this.stage.setAttribute('aria-hidden', 'true');
    const touch = window.matchMedia('(pointer: coarse)').matches;
    this.inspectHint = el(
      'p',
      'p3d-inspect-hint p3d-mono',
      touch ? 'DRAG TO ROTATE · PINCH TO ZOOM · DOUBLE-TAP TO RESET' : 'DRAG TO ROTATE · SCROLL TO ZOOM · DOUBLE-CLICK TO RESET',
    );
    this.inspectHint.hidden = true;

    this.boot = el('div', 'p3d-boot p3d-mono');
    this.boot.setAttribute('aria-hidden', 'true');
    this.terminal = new BootTerminal(
      [
        { text: 'MD-01 FIRMWARE v2.6 · MYIND SOUND', at: 0 },
        { text: 'UPLINK ............... OK', at: 0.12 },
        { text: 'DECK TEXTURES ........ LOADED', at: 0.55 },
        { text: 'LASER DIODE .......... ARMED', at: 0.8 },
        { text: 'CITY GRID ............ ONLINE', at: 0.95 },
      ],
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
    );
    const bootLabel = this.terminal.element;
    const bootTrack = el('div', 'p3d-boot__track');
    this.bootBar = el('div', 'p3d-boot__bar');
    bootTrack.append(this.bootBar);
    this.bootPercent = el('div', 'p3d-boot__percent', '0%');
    this.boot.append(bootLabel, bootTrack, this.bootPercent);

    this.errorBox = el('div', 'p3d-error');
    this.errorBox.setAttribute('role', 'alert');
    this.errorBox.hidden = true;

    this.keysHost = el('div', 'p3d-keys');
    this.keysHost.setAttribute('role', 'group');
    this.keysHost.setAttribute('aria-label', 'Deck keys');

    root.append(
      this.canvas,
      hud,
      this.stage,
      this.openHint,
      this.statusEl,
      this.inspectHint,
      this.insertButton,
      this.keysHost,
      this.boot,
      this.errorBox,
    );
    this.measure();
    window.addEventListener('resize', () => this.measure());
  }

  setTracks(tracks: PlayerTrack[]): void {
    this.tracks = tracks;
    this.trackButtons = tracks.map((track, index) => {
      const item = el('li');
      const button = el('button', 'p3d-track');
      button.type = 'button';
      button.append(
        el('span', 'p3d-track__num p3d-mono', pad2(track.position)),
        el('span', 'p3d-track__title', track.title),
        el('span', 'p3d-track__eq', ''),
        el('span', 'p3d-track__dur p3d-mono', formatTime(track.durationSeconds)),
      );
      button.addEventListener('click', () => {
        this.root.classList.remove('p3d--sheet-open');
        this.sheetToggle.setAttribute('aria-expanded', 'false');
        this.handlers.onSelect(index);
      });
      item.append(button);
      return button;
    });
    this.list.replaceChildren(...this.trackButtons.map((button) => button.parentElement!));
    this.lastIndex = -1;
  }

  /** Full album for owners; for everyone else, a previews note with sign-in and purchase links. */
  /** Opening scene: nothing but the wrapped cartridge, with the button under it. */
  setIntro(on: boolean, coarsePointer = false): void {
    this.root.classList.toggle('p3d--intro', on);
    document.body.classList.toggle('p3d-sealed', on);
    this.openHint.hidden = !on;
    this.openHint.textContent = coarsePointer
      ? 'DRAG TO TURN · DOUBLE-TAP TO UNWRAP'
      : 'DRAG TO TURN · DOUBLE-CLICK TO UNWRAP';
    // Everything behind the black is out of the tab order and out of the accessibility tree.
    for (const node of [this.hudLayer, this.insertButton, this.inspectHint]) node.inert = on;
  }

  /** The hint is also the button, for anyone not double-clicking a 3D object. */
  onOpen(handler: () => void): void {
    this.openHint.addEventListener('click', handler);
  }

  /** The button goes as soon as the unwrapping starts. */
  hideOpenHint(): void {
    this.openHint.hidden = true;
  }

  /** The list header, the sheet label and the note under the tracklist follow what the listener gets. */
  setAccess(access: StreamAccess): void {
    const preview = access.mode === 'preview';
    this.listMeta.textContent = preview ? '30s PREVIEWS' : 'FULL ALBUM';
    this.sheetSuffix = preview ? ' · PREVIEWS' : '';
    const actions = el('div', 'p3d-access__actions');
    const link = (label: string, href: string) => {
      const anchor = el('a', 'p3d-access__link p3d-mono', label);
      anchor.href = href;
      return anchor;
    };
    const signIn = () => link('SIGN IN', `/login.html?redirect=${encodeURIComponent('/')}`);

    // Unlocked by a checkout session rather than an account: it runs out, so offer to make it permanent.
    if (!preview) {
      this.accessNote.hidden = access.via !== 'purchase';
      if (access.via !== 'purchase') return;
      actions.append(signIn());
      const message = 'Thank you. The full album is unlocked here for 24 hours. Sign in to keep it on any device.';
      this.accessNote.replaceChildren(el('p', 'p3d-access__text', message), actions);
      return;
    }

    this.accessNote.hidden = false;
    const message = {
      'signed-out': 'Playing 30-second previews. Pay what you want to hear the full album.',
      'not-owner': "Playing 30-second previews. This account doesn't own LIT yet.",
      unavailable: "Full songs can't load right now, so previews are playing. Try again soon.",
    }[access.reason];
    if (access.reason === 'signed-out') actions.append(signIn());
    if (access.reason !== 'unavailable') {
      const getLit = el('button', 'p3d-access__link p3d-access__link--primary p3d-mono', 'GET LIT');
      getLit.type = 'button';
      getLit.addEventListener('click', () => this.handlers.onGetLit());
      actions.append(getLit);
    }
    this.accessNote.replaceChildren(el('p', 'p3d-access__text', message), actions);
  }

  setVolume(value: number): void {
    this.volumeInput.value = String(Math.round(value * 100));
  }

  setBootProgress(ratio: number): void {
    const percent = Math.round(ratio * 100);
    this.bootBar.style.transform = `scaleX(${ratio})`;
    this.bootPercent.textContent = `${percent}%`;
    this.terminal.progress(ratio);
  }

  hideBoot(): void {
    this.boot.classList.add('p3d-boot--done');
  }

  showError(message: string, action?: { label: string; href?: string }): void {
    this.errorActive = true;
    this.errorBox.hidden = false;
    this.errorBox.replaceChildren(el('p', 'p3d-error__text p3d-mono', message));
    if (action) {
      if (action.href) {
        const link = el('a', 'p3d-error__action p3d-mono', action.label);
        link.href = action.href;
        this.errorBox.append(link);
      } else {
        const retry = el('button', 'p3d-error__action p3d-mono', action.label);
        retry.type = 'button';
        retry.addEventListener('click', () => this.handlers.onRetry());
        this.errorBox.append(retry);
      }
    }
    this.statusText.textContent = message;
  }

  clearError(): void {
    this.errorActive = false;
    this.errorBox.hidden = true;
    this.lastStatus = null;
  }

  /** Screen positions (CSS px): the insert button and errors sit on the disc. */
  anchor(disc: { x: number; y: number; r: number }): void {
    const style = this.root.style;
    style.setProperty('--p3d-disc-x', `${disc.x}px`);
    style.setProperty('--p3d-disc-y', `${disc.y}px`);
    style.setProperty('--p3d-disc-r', `${disc.r}px`);
  }

  render(frame: HudFrame): void {
    const { state, track } = frame;
    const total = this.tracks.length;

    if (state.status !== this.lastStatus) {
      this.lastStatus = state.status;
      this.root.dataset.status = state.status;
      if (!this.errorActive) this.statusText.textContent = STATUS_TEXT[state.status];
      glitchText(this.stripStatus, STATUS_TEXT[state.status], this.reducedMotion);
      this.insertButton.hidden = state.status !== 'ejected';
      this.inspectHint.hidden = state.status !== 'ejected';
    }

    if (state.repeat !== this.lastRepeat) {
      this.lastRepeat = state.repeat;
      this.repeatButton.setAttribute('aria-pressed', String(state.repeat));
      this.repeatButton.replaceChildren(el('span', 'p3d-repeat__icon', '↻'), `REPEAT ${state.repeat ? 'ON' : 'OFF'}`);
    }

    if (state.trackIndex !== this.lastIndex && this.trackButtons.length) {
      this.lastIndex = state.trackIndex;
      this.trackButtons.forEach((button, index) => {
        if (index === state.trackIndex) button.setAttribute('aria-current', 'true');
        else button.removeAttribute('aria-current');
      });
    }

    const loaded = state.status !== 'booting';
    const trackLabel = loaded && total ? `${pad2(state.trackIndex + 1)}/${pad2(total)}` : `--/${pad2(total)}`;
    const timeLabel = track ? `${formatTime(state.positionSec)} / ${formatTime(track.durationSeconds)}` : '0:00 / 0:00';
    const rpmLabel = String(Math.round(frame.rpm)).padStart(3, '0');

    this.readouts.time.textContent = timeLabel;
    this.readouts.track.textContent = trackLabel;
    this.readouts.rpm.textContent = rpmLabel;
    this.readouts.format.textContent = track ? track.format.toUpperCase() : '--';
    this.readouts.repeat.textContent = state.repeat ? 'ON' : 'OFF';
    this.readouts.repeat.classList.toggle('p3d-readout__value--on', state.repeat);
    this.signalMode.textContent = frame.simulated && state.status === 'playing' ? 'SIGNAL SIM' : 'SIGNAL';
    const now = performance.now();
    this.sparkline.push(frame.level * 1.8, now);
    this.gauge.set(frame.rpm / 300, now);

    this.stripTime.textContent = track ? formatTime(state.positionSec) : '0:00';
    this.stripTrack.textContent = `TRK ${trackLabel}`;
    this.stripRpm.textContent = `${rpmLabel} RPM`;
    // The phone's collapsed tracklist is the only place the title shows, so it carries the song itself.
    this.sheetLabel.textContent = track
      ? `${String(track.position).padStart(2, '0')} · ${track.title}`
      : `TRACKLIST ${trackLabel}${this.sheetSuffix}`;


    this.drawSpectrum(frame.spectrum, frame.waveform);
  }

  private measure(): void {
    this.resizeSpectrum();
  }

  private resizeSpectrum(): void {
    const rect = this.spectrumCanvas.getBoundingClientRect();
    const ratio = Math.min(window.devicePixelRatio, 2);
    this.spectrumCanvas.width = Math.max(1, Math.round(rect.width * ratio));
    this.spectrumCanvas.height = Math.max(1, Math.round(rect.height * ratio));
  }

  private drawSpectrum(values: number[], waveform: number[]): void {
    const ctx = this.spectrumCtx;
    if (!ctx) return;
    const { width, height } = this.spectrumCanvas;
    ctx.clearRect(0, 0, width, height);
    const silent = values.every((value) => value < 0.01);
    if (silent) {
      ctx.fillStyle = 'rgba(253, 185, 19, 0.45)';
      ctx.fillRect(0, height - 2 * (window.devicePixelRatio || 1), width, 2 * (window.devicePixelRatio || 1));
      return;
    }
    const gap = width / values.length;
    const barWidth = gap * 0.62;
    const gradient = ctx.createLinearGradient(0, height, 0, 0);
    gradient.addColorStop(0, '#FF3DA8');
    gradient.addColorStop(0.55, '#FF8C00');
    gradient.addColorStop(1, '#FDB913');
    ctx.fillStyle = gradient;
    ctx.shadowColor = 'rgba(253, 185, 19, 0.55)';
    ctx.shadowBlur = 8;
    values.forEach((value, index) => {
      const barHeight = Math.max(2, value * height * 0.95);
      ctx.fillRect(index * gap + (gap - barWidth) / 2, height - barHeight, barWidth, barHeight);
    });
    ctx.shadowBlur = 0;
    drawWaveform(ctx, waveform, width, height);
  }
}

/**
 * HUD effects ported to vanilla TS from React Bits Pro blocks (originals kept locally, gitignored, in
 * src/vendor/reactbits/): chromatic glitch text (404-6), terminal boot printout (404-8 + cta-12
 * typing cadence), oscilloscope waveform (bento-41), rolling metric sparkline with threshold
 * (monitoring-2) and radial gauge sweep (analytics-10).
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** 404-6: swap text with offset cyan/magenta clip-sliced copies for a short burst. */
export function glitchText(element: HTMLElement, text: string, reducedMotion: boolean): void {
  element.textContent = text;
  element.dataset.text = text;
  if (reducedMotion) return;
  element.classList.remove('p3d-glitch');
  void element.offsetWidth;
  element.classList.add('p3d-glitch');
  window.setTimeout(() => element.classList.remove('p3d-glitch'), 560);
}

/** 404-8: printout lines appear as progress passes each threshold, typed at a terminal cadence (cta-12). */
export class BootTerminal {
  readonly element: HTMLElement;
  private readonly lines: { text: string; at: number; node: HTMLElement | null }[];
  private typing = Promise.resolve();
  private readonly reducedMotion: boolean;

  constructor(lines: { text: string; at: number }[], reducedMotion: boolean) {
    this.reducedMotion = reducedMotion;
    this.element = document.createElement('div');
    this.element.className = 'p3d-terminal';
    this.lines = lines.map((line) => ({ ...line, node: null }));
    const caret = document.createElement('span');
    caret.className = 'p3d-terminal__caret';
    this.element.append(caret);
  }

  progress(ratio: number): void {
    for (const line of this.lines) {
      if (line.node || ratio < line.at) continue;
      const node = document.createElement('div');
      node.className = 'p3d-terminal__line';
      line.node = node;
      this.element.insertBefore(node, this.element.lastChild);
      this.typing = this.typing.then(() => this.type(node, line.text));
    }
  }

  private type(node: HTMLElement, text: string): Promise<void> {
    if (this.reducedMotion) {
      node.textContent = text;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      let shown = 0;
      const tick = () => {
        shown = Math.min(text.length, shown + 2);
        node.textContent = text.slice(0, shown);
        if (shown < text.length) window.setTimeout(tick, 14 + Math.random() * 12);
        else resolve();
      };
      tick();
    });
  }
}

/** bento-41: oscilloscope trace with a centre swell envelope, drawn over the spectrum. */
export function drawWaveform(ctx: CanvasRenderingContext2D, samples: number[], width: number, height: number): void {
  if (samples.length < 2) return;
  const mid = height * 0.55;
  ctx.save();
  ctx.lineWidth = Math.max(1.5, height * 0.02);
  ctx.strokeStyle = 'rgba(159, 216, 255, 0.85)';
  ctx.shadowColor = 'rgba(159, 216, 255, 0.8)';
  ctx.shadowBlur = 10;
  ctx.beginPath();
  samples.forEach((sample, i) => {
    const t = i / (samples.length - 1);
    const envelope = 0.3 + 0.7 * Math.sin(t * Math.PI);
    const x = t * width;
    const y = mid - sample * envelope * height * 0.42;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
  ctx.restore();
}

/** monitoring-2: rolling window with a dashed threshold line and a peak marker. */
export class Sparkline {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly values: number[] = [];
  private readonly window: number;
  private readonly threshold: number;
  private lastPush = 0;

  constructor(windowSize = 60, threshold = 0.6) {
    this.window = windowSize;
    this.threshold = threshold;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'p3d-sparkline';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.ctx = this.canvas.getContext('2d');
  }

  push(value: number, now: number): void {
    if (now - this.lastPush < 80) return;
    this.lastPush = now;
    this.values.push(Math.min(1, Math.max(0, value)));
    if (this.values.length > this.window) this.values.shift();
    this.draw();
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const ratio = Math.min(window.devicePixelRatio, 2);
    const width = Math.round(this.canvas.clientWidth * ratio);
    const height = Math.round(this.canvas.clientHeight * ratio);
    if (!width || !height) return;
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;
    ctx.clearRect(0, 0, width, height);

    const y = (v: number) => height - 2 - v * (height - 4);
    ctx.setLineDash([3 * ratio, 3 * ratio]);
    ctx.strokeStyle = 'rgba(255, 140, 0, 0.55)';
    ctx.lineWidth = ratio;
    ctx.beginPath();
    ctx.moveTo(0, y(this.threshold));
    ctx.lineTo(width, y(this.threshold));
    ctx.stroke();
    ctx.setLineDash([]);

    const step = width / (this.window - 1);
    const offset = (this.window - this.values.length) * step;
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, 'rgba(253, 185, 19, 0.35)');
    gradient.addColorStop(1, 'rgba(253, 185, 19, 0)');
    ctx.beginPath();
    this.values.forEach((v, i) => (i === 0 ? ctx.moveTo(offset, y(v)) : ctx.lineTo(offset + i * step, y(v))));
    ctx.lineTo(offset + (this.values.length - 1) * step, height);
    ctx.lineTo(offset, height);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.beginPath();
    this.values.forEach((v, i) => (i === 0 ? ctx.moveTo(offset, y(v)) : ctx.lineTo(offset + i * step, y(v))));
    ctx.strokeStyle = '#FDB913';
    ctx.lineWidth = 1.5 * ratio;
    ctx.stroke();

    if (this.values.length) {
      const peak = Math.max(...this.values);
      const index = this.values.lastIndexOf(peak);
      ctx.fillStyle = peak > this.threshold ? '#FF8C00' : '#FDB913';
      ctx.beginPath();
      ctx.arc(offset + index * step, y(peak), 2.2 * ratio, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

/** analytics-10: 240° radial gauge with target ticks; the fill eases toward its value. */
export class RadialGauge {
  readonly element: SVGSVGElement;
  private readonly fill: SVGPathElement;
  private shown = 0;
  private from = 0;
  private target = 0;
  private startedAt = 0;
  private static readonly START = -120;
  private static readonly SPAN = 240;

  constructor() {
    this.element = document.createElementNS(SVG_NS, 'svg');
    this.element.setAttribute('viewBox', '-50 -50 100 100');
    this.element.setAttribute('class', 'p3d-gauge');
    this.element.setAttribute('aria-hidden', 'true');
    const track = document.createElementNS(SVG_NS, 'path');
    track.setAttribute('d', RadialGauge.arcPath(1));
    track.setAttribute('class', 'p3d-gauge__track');
    this.fill = document.createElementNS(SVG_NS, 'path');
    this.fill.setAttribute('class', 'p3d-gauge__fill');
    const ticks = document.createElementNS(SVG_NS, 'g');
    for (let i = 0; i <= 12; i++) {
      const angle = ((RadialGauge.START + (RadialGauge.SPAN * i) / 12) * Math.PI) / 180;
      const tick = document.createElementNS(SVG_NS, 'line');
      const inner = i % 3 === 0 ? 26 : 30;
      tick.setAttribute('x1', String(Math.sin(angle) * inner));
      tick.setAttribute('y1', String(-Math.cos(angle) * inner));
      tick.setAttribute('x2', String(Math.sin(angle) * 34));
      tick.setAttribute('y2', String(-Math.cos(angle) * 34));
      ticks.append(tick);
    }
    this.element.append(track, this.fill, ticks);
    this.render(0);
  }

  private static arcPath(fraction: number): string {
    const radius = 42;
    const start = (RadialGauge.START * Math.PI) / 180;
    const end = ((RadialGauge.START + RadialGauge.SPAN * Math.max(0.0001, fraction)) * Math.PI) / 180;
    const large = RadialGauge.SPAN * fraction > 180 ? 1 : 0;
    const point = (a: number) => `${(Math.sin(a) * radius).toFixed(2)} ${(-Math.cos(a) * radius).toFixed(2)}`;
    return `M ${point(start)} A ${radius} ${radius} 0 ${large} 1 ${point(end)}`;
  }

  set(value: number, now: number): void {
    const clamped = Math.min(1, Math.max(0, value));
    if (Math.abs(clamped - this.target) > 0.02) {
      this.from = this.shown;
      this.target = clamped;
      this.startedAt = now;
    }
    const t = Math.min(1, (now - this.startedAt) / 600);
    this.render(this.from + (this.target - this.from) * easeOut(t));
  }

  private render(value: number): void {
    this.shown = value;
    this.fill.setAttribute('d', RadialGauge.arcPath(value));
    this.fill.style.opacity = value < 0.005 ? '0' : '1';
  }
}

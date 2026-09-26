/**
 * Original placeholder covers for the sample releases: canvas gradients, procedural noise and the brand type.
 * No photographs, no borrowed artwork. Saved as 1024 px PNGs into samples/<slug>/cover.png.
 */
import { INTER, MONO, canvas, ensureFonts, grain, prng } from '../src/canvas';

const SIZE = 1024;

function veins(ctx: CanvasRenderingContext2D, seed: number, colour: string): void {
  const random = prng(seed);
  ctx.lineCap = 'round';
  for (let i = 0; i < 14; i++) {
    const x = random() * SIZE;
    const y = random() * SIZE;
    ctx.strokeStyle = colour;
    ctx.globalAlpha = 0.25 + random() * 0.5;
    ctx.lineWidth = 1 + random() * 3;
    ctx.shadowColor = colour;
    ctx.shadowBlur = 18;
    ctx.beginPath();
    ctx.moveTo(x, y);
    let px = x;
    let py = y;
    for (let s = 0; s < 6; s++) {
      const nx = px + (random() - 0.5) * 420;
      const ny = py + (random() - 0.2) * 420;
      ctx.quadraticCurveTo(px + (random() - 0.5) * 200, py + (random() - 0.5) * 200, nx, ny);
      px = nx;
      py = ny;
    }
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
  ctx.globalAlpha = 1;
}

function blood(): HTMLCanvasElement {
  const [element, ctx] = canvas(SIZE);
  const base = ctx.createRadialGradient(SIZE * 0.3, SIZE * 0.25, 40, SIZE * 0.5, SIZE * 0.5, SIZE * 0.85);
  base.addColorStop(0, '#5a0910');
  base.addColorStop(0.55, '#2a0407');
  base.addColorStop(1, '#070203');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);
  veins(ctx, 7, '#e63024');
  const glow = ctx.createRadialGradient(SIZE * 0.72, SIZE * 0.78, 10, SIZE * 0.72, SIZE * 0.78, SIZE * 0.5);
  glow.addColorStop(0, 'rgba(230, 48, 36, 0.55)');
  glow.addColorStop(1, 'rgba(230, 48, 36, 0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = 'rgba(242, 233, 225, 0.6)';
  ctx.font = `600 ${SIZE * 0.022}px ${MONO}`;
  ctx.fillText('THA MYIND   ·   MS-BLOOD-26   ·   MINIDISC', SIZE * 0.07, SIZE * 0.1);
  ctx.strokeStyle = 'rgba(242, 233, 225, 0.35)';
  ctx.lineWidth = 2;
  ctx.strokeRect(SIZE * 0.05, SIZE * 0.05, SIZE * 0.9, SIZE * 0.9);
  ctx.fillStyle = '#F2E9E1';
  ctx.font = `800 ${SIZE * 0.3}px ${INTER}`;
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('BLOOD', SIZE * 0.055, SIZE * 0.86);
  ctx.fillStyle = '#e63024';
  ctx.fillRect(SIZE * 0.07, SIZE * 0.575, SIZE * 0.2, 6);
  grain(ctx, 26, 7);
  return element;
}

function reflections(): HTMLCanvasElement {
  const [element, ctx] = canvas(SIZE);
  const sky = ctx.createLinearGradient(0, 0, 0, SIZE);
  sky.addColorStop(0, '#0a0a10');
  sky.addColorStop(0.5, '#2a2c35');
  sky.addColorStop(0.55, '#c9ccd2');
  sky.addColorStop(0.58, '#3a3d47');
  sky.addColorStop(1, '#05050a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Chrome bands.
  const random = prng(21);
  for (let i = 0; i < 40; i++) {
    const y = SIZE * (0.2 + random() * 0.7);
    ctx.fillStyle = `rgba(${random() < 0.5 ? '245,241,230' : '159,216,255'}, ${0.03 + random() * 0.12})`;
    ctx.fillRect(0, y, SIZE, 1 + random() * 4);
  }
  const horizon = SIZE * 0.555;
  ctx.textBaseline = 'alphabetic';
  ctx.font = `800 ${SIZE * 0.128}px ${INTER}`;
  ctx.textAlign = 'center';
  ctx.fillStyle = '#F5F1E6';
  ctx.fillText('REFLECTIONS', SIZE / 2, horizon - SIZE * 0.02);
  // The mirrored copy, fading down into the floor.
  ctx.save();
  ctx.translate(0, horizon + SIZE * 0.02);
  ctx.scale(1, -1);
  const fade = ctx.createLinearGradient(0, 0, 0, SIZE * 0.14);
  fade.addColorStop(0, 'rgba(253, 185, 19, 0.75)');
  fade.addColorStop(1, 'rgba(253, 185, 19, 0)');
  ctx.fillStyle = fade;
  ctx.fillText('REFLECTIONS', SIZE / 2, 0);
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(245, 241, 230, 0.66)';
  ctx.font = `600 ${SIZE * 0.022}px ${MONO}`;
  ctx.fillText('THA MYIND', SIZE * 0.07, SIZE * 0.1);
  ctx.textAlign = 'right';
  ctx.fillText('MS-REFLECTIONS-26', SIZE * 0.93, SIZE * 0.1);
  ctx.textAlign = 'left';
  ctx.fillStyle = 'rgba(253, 185, 19, 0.9)';
  ctx.fillRect(SIZE * 0.07, SIZE * 0.115, SIZE * 0.86, 2);
  grain(ctx, 18, 21);
  return element;
}

function letHimCook(): HTMLCanvasElement {
  const [element, ctx] = canvas(SIZE);
  const base = ctx.createLinearGradient(0, 0, SIZE, SIZE);
  base.addColorStop(0, '#ff3da8');
  base.addColorStop(0.55, '#b0106b');
  base.addColorStop(1, '#3a0626');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, SIZE, SIZE);
  const heat = ctx.createRadialGradient(SIZE * 0.78, SIZE * 0.82, 10, SIZE * 0.78, SIZE * 0.82, SIZE * 0.55);
  heat.addColorStop(0, 'rgba(255, 227, 110, 0.95)');
  heat.addColorStop(0.5, 'rgba(255, 140, 0, 0.45)');
  heat.addColorStop(1, 'rgba(255, 140, 0, 0)');
  ctx.fillStyle = heat;
  ctx.fillRect(0, 0, SIZE, SIZE);
  // Halftone.
  const random = prng(33);
  for (let y = 0; y < SIZE; y += 18) {
    for (let x = 0; x < SIZE; x += 18) {
      const d = Math.hypot(x - SIZE * 0.78, y - SIZE * 0.82) / SIZE;
      const r = Math.max(0, 6 - d * 9) * (0.6 + random() * 0.4);
      if (r < 0.6) continue;
      ctx.fillStyle = 'rgba(7, 7, 12, 0.35)';
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.textBaseline = 'alphabetic';
  const lines = ['LET', 'HIM', 'COOK'];
  ctx.font = `800 ${SIZE * 0.24}px ${INTER}`;
  lines.forEach((line, i) => {
    const y = SIZE * (0.34 + i * 0.235);
    ctx.fillStyle = '#FFE36E';
    ctx.fillText(line, SIZE * 0.075, y + 10);
    ctx.fillStyle = '#07070C';
    ctx.fillText(line, SIZE * 0.06, y);
  });
  ctx.fillStyle = 'rgba(7, 7, 12, 0.8)';
  ctx.font = `600 ${SIZE * 0.022}px ${MONO}`;
  ctx.fillText('THA MYIND   ·   MS-LETHIMCOOK-26', SIZE * 0.06, SIZE * 0.09);
  grain(ctx, 16, 33);
  return element;
}

async function main(): Promise<void> {
  await ensureFonts();
  const row = document.getElementById('row')!;
  const status = document.getElementById('status')!;
  const covers: [string, HTMLCanvasElement][] = [
    ['blood', blood()],
    ['reflections', reflections()],
    ['let-him-cook', letHimCook()],
  ];
  const reports: string[] = [];
  for (const [slug, cover] of covers) {
    row.append(cover);
    if (new URLSearchParams(location.search).has('nosave')) continue;
    const blob = await new Promise<Blob | null>((resolve) => cover.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('PNG failed');
    const response = await fetch(`/__save?path=${encodeURIComponent(`samples/${slug}/cover.png`)}`, { method: 'POST', body: blob });
    reports.push(await response.text());
  }
  status.textContent = reports.join(' · ') || 'DRAWN (not saved)';
  (window as unknown as { __done: boolean }).__done = true;
}
main().catch((err) => {
  document.getElementById('status')!.textContent = `FAILED: ${err instanceof Error ? err.message : err}`;
});

/**
 * Preset gallery: every shell preset side by side on the chosen sample's art, spinning and slowly turning; a
 * second mode shows the sample alone, in its sleeve. "Render spin loop" runs `renderSpinLoop` in this page and
 * saves the sheet, its metadata and the still into `shots/` through the dev server.
 */
import {
  ACESFilmicToneMapping,
  DirectionalLight,
  HemisphereLight,
  PerspectiveCamera,
  PointLight,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
} from 'three';
import { createStudioEnvironment } from '../../../src/player3d/cartridge-detail';
import { computeWear, getWearConfig } from '../../wear/src';
import { ensureFonts } from '../src/canvas';
import { DISC_FINISHES, LABEL_STYLES, assertDesign, type DiscDesign, type ShellPresetId } from '../src/design';
import { createMiniDisc, loadDesignArt, type LoadedArt, type MiniDisc } from '../src/minidisc';
import { SHELL_PRESET_LIST } from '../src/presets';
import { renderSpinLoop } from '../src/spin-loop';

const designs = import.meta.glob('../samples/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const artUrls = import.meta.glob('../samples/**/*.{png,jpg,webp}', { eager: true, import: 'default', query: '?url' }) as Record<string, string>;

const query = new URLSearchParams(location.search);
const status = document.getElementById('status')!;
const labels = document.getElementById('labels')!;
const select = document.getElementById('design') as HTMLSelectElement;
const modeButton = document.getElementById('mode') as HTMLButtonElement;
const loopButton = document.getElementById('loop') as HTMLButtonElement;
const wearButton = document.getElementById('wear') as HTMLButtonElement;
const sheetImage = document.getElementById('sheet') as HTMLImageElement;

function sampleDesign(name: string): DiscDesign {
  const entry = Object.entries(designs).find(([path]) => path.endsWith(`/${name}.json`));
  if (!entry) throw new Error(`No sample "${name}"`);
  // `?labelart=c-walk/cover.png`: try an uploaded label image (sample art path) on the shutter.
  const design = { ...assertDesign(entry[1]) };
  const labelArt = new URLSearchParams(location.search).get('labelart');
  if (labelArt) design.labelArt = labelArt;
  // `?stickerdemo`: four any-shape image stickers (drawn here, transparent PNG) on the slide cover and one on the shell.
  if (new URLSearchParams(location.search).has('stickerdemo')) {
    const star = demoSticker('star');
    const blob = demoSticker('blob');
    design.stickers = [
      ...(design.stickers ?? []),
      { kind: 'image', src: star, area: 'shutter', x: 0.2, y: 0.3, size: 0.3, rotation: -15 },
      { kind: 'image', src: blob, area: 'shutter', x: 0.75, y: 0.7, size: 0.35, rotation: 20 },
      { kind: 'image', src: star, area: 'shutter', x: 0.95, y: 0.05, size: 0.25, rotation: 45 },
      { kind: 'image', src: blob, area: 'shutter', x: 0.5, y: 0.55, size: 0.2, rotation: 90 },
      { kind: 'image', src: star, area: 'shell', x: 0.8, y: 0.85, size: 0.18, rotation: 10 },
    ];
  }
  const resolve = (ref: string) => {
    if (/^(data|https?):/.test(ref)) return ref;
    const hit = Object.entries(artUrls).find(([path]) => path.endsWith(`/samples/${ref}`));
    if (!hit) throw new Error(`Sample art missing: ${ref}`);
    return new URL(hit[1], location.href).href;
  };
  return { ...design, coverArt: resolve(design.coverArt), discArt: design.discArt ? resolve(design.discArt) : undefined, labelArt: design.labelArt ? resolve(design.labelArt) : undefined, stickers: design.stickers?.map((sticker) => (sticker.kind === 'image' ? { ...sticker, src: resolve(sticker.src) } : sticker)), theme: design.theme ? { ...design.theme, backdrop: design.theme.backdrop ? { ...design.theme.backdrop, image: design.theme.backdrop.image ? resolve(design.theme.backdrop.image) : undefined } : undefined } : undefined };
}

const canvas = document.getElementById('stage') as HTMLCanvasElement;
const renderer = new WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = SRGBColorSpace;
renderer.toneMapping = ACESFilmicToneMapping;
renderer.setClearColor('#07070C', 1);
const environment = createStudioEnvironment(renderer);
const scene = new Scene();
const camera = new PerspectiveCamera(28, 1, 0.05, 40);
const key = new DirectionalLight('#ffffff', 1.6);
key.position.set(1.5, 2.5, 4);
const pink = new PointLight('#FF3DA8', 2.5, 14, 1.6);
pink.position.set(-3.6, 0.8, 2.6);
const ice = new PointLight('#9FD8FF', 2, 14, 1.6);
ice.position.set(3.6, -0.6, 2.6);
(window as unknown as { __preview: unknown }).__preview = { scene, camera, renderer, lights: { key, pink, ice } };
scene.add(new HemisphereLight('#9FD8FF', '#1a0a14', 0.9), key, pink, ice);

let discs: MiniDisc[] = [];
let mode: 'presets' | 'sleeve' = query.has('sleeve') ? 'sleeve' : 'presets';
let art: LoadedArt | null = null;
let design: DiscDesign | null = null;
let worn = false;
const edition = Number(query.get('edition')) || null;
const front = query.has('front');
// `?neutral`: key light only, as the catalogue's studio photos are lit (no pink or ice rims).
if (query.has('neutral')) { pink.visible = false; ice.visible = false; }

/** The same fixed copy the harness uses, at a level. */
function wearAt(level: number) {
  const { K, SECONDS_PER_PLAY } = getWearConfig(1);
  const plays = level >= 1 ? 1e7 : -Math.log(1 - level) / K;
  return computeWear('6c6974776561723031666978656473ee', { playSeconds: plays * SECONDS_PER_PLAY, lentPlaySeconds: 0, loads: 0, ejects: 0 }, 1, {
    wearSafeZones: [],
  });
}

async function build(): Promise<void> {
  for (const disc of discs) {
    scene.remove(disc.group);
    disc.dispose();
  }
  discs = [];
  labels.replaceChildren();
  const name = select.value;
  design = sampleDesign(name);
  status.textContent = `LOADING ${name.toUpperCase()}`;
  art = await loadDesignArt(design);
  if (mode === 'presets') {
    // `?only=clear,frost`: just those shells.
    const only = query.get('only')?.split(',');
    // `?wearstrip=green`: that shell five times, new to heavily played, for reviewing wear over time.
    const strip = query.get('wearstrip');
    const stripPreset = strip ? SHELL_PRESET_LIST.find((preset) => preset.id === strip) : undefined;
    const WEAR_STEPS = [0, 0.25, 0.5, 0.75, 1];
    const presets = stripPreset
      ? WEAR_STEPS.map(() => stripPreset)
      : only
        ? SHELL_PRESET_LIST.filter((preset) => only.includes(preset.id))
        : SHELL_PRESET_LIST;
    const gap = 0.98;
    // A grid, four across, so the whole catalogue fits one frame. `?label=` and `?disc=` try every shell with
    // one slide cover or disc finish; `?cycle` walks the covers and discs across the grid instead.
    const columns = stripPreset ? 5 : Math.min(4, presets.length);
    const rows = Math.ceil(presets.length / columns);
    const labelParam = query.get('label') as DiscDesign['labelStyle'] | null;
    const discParam = query.get('disc') as DiscDesign['discFinish'] | null;
    const cycle = query.has('cycle');
    presets.forEach((preset, i) => {
      const labelStyle = cycle ? LABEL_STYLES[i % LABEL_STYLES.length] : labelParam ?? design!.labelStyle;
      const discFinish = cycle ? DISC_FINISHES[i % DISC_FINISHES.length] : discParam ?? undefined;
      const disc = createMiniDisc({ ...design!, shell: preset.id as ShellPresetId, shellTint: undefined, discFinish, labelStyle }, art!, {
        environment,
        quality: 'high',
        sleeve: false,
        anisotropy: renderer.capabilities.getMaxAnisotropy(),
      });
      disc.group.position.x = ((i % columns) - (columns - 1) / 2) * gap;
      disc.group.position.y = ((rows - 1) / 2 - Math.floor(i / columns)) * gap;
      disc.setEdition(edition ?? 7 + i);
      if (stripPreset) {
        if (WEAR_STEPS[i] > 0) disc.setWear(wearAt(WEAR_STEPS[i]));
      } else if (query.has('wear')) {
        // `?wear=0.5`: a fixed wear level (0 new .. 1 worn out), for straight-on wear reviews.
        const level = Number(query.get('wear'));
        if (level > 0) disc.setWear(wearAt(Math.min(1, level)));
      } else if (worn && !front) disc.setWear(wearAt(0.6));
      // `?front`: still and square on, for diffing against a reference photo.
      if (!front && !stripPreset) disc.spin(1.4);
      // `?shutter=0..1` slides the shutter; `?back` turns the cartridge round, `?side` shows its edge at an angle.
      if (query.has('shutter')) disc.built.setShutter(Number(query.get('shutter')));
      scene.add(disc.group);
      discs.push(disc);
      const label = document.createElement('span');
      label.textContent = stripPreset ? `WEAR ${Math.round(WEAR_STEPS[i] * 100)}%` : cycle ? `${preset.label} · ${labelStyle} · ${discFinish}` : preset.label;
      label.style.width = `${100 / columns}%`;
      label.style.textAlign = 'center';
      labels.append(label);
    });
    if (stripPreset) camera.position.set(0, 0, 3.1);
    else if (query.has('side')) camera.position.set(0.05, 0, 1.25);
    else if (front && presets.length === 1) camera.position.set(0, 0, 0.82 / 0.9 / (2 * Math.tan((28 / 2) * (Math.PI / 180))));
    else camera.position.set(0, 0.1, 3.4 + Math.max(rows, 2) * 1.45);
    camera.lookAt(0, 0, 0);
  } else {
    const disc = createMiniDisc(design, art, { environment, quality: 'high', sleeve: true, sleeveDrop: 0.35, anisotropy: renderer.capabilities.getMaxAnisotropy() });
    disc.setEdition(edition ?? 7);
    if (worn) disc.setWear(wearAt(0.6));
    disc.spin(1.4);
    scene.add(disc.group);
    discs.push(disc);
    camera.position.set(0, -0.15, 2.9);
    camera.lookAt(0, -0.15, 0);
  }
  status.textContent = `${name.toUpperCase()} · ${mode.toUpperCase()}`;
}

function resize(): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let last = performance.now();
let elapsed = 0;
renderer.setAnimationLoop((now) => {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  elapsed += dt;
  discs.forEach((disc, i) => {
    disc.update(dt);
    if (query.has('back')) disc.group.rotation.set(0, Math.PI, 0);
    else if (query.has('side')) disc.group.rotation.set(0.12, -Math.PI / 2 + 0.3, 0);
    else if (front) disc.group.rotation.set(0, 0, 0);
    else {
      disc.group.rotation.y = Math.sin(elapsed * 0.5 + i * 0.4) * 0.45;
      disc.group.rotation.x = Math.sin(elapsed * 0.31 + i) * 0.12 - 0.05;
    }
  });
  renderer.render(scene, camera);
});

select.value = query.get('design') ?? 'blood';
select.addEventListener('change', () => void build());
modeButton.addEventListener('click', () => {
  mode = mode === 'presets' ? 'sleeve' : 'presets';
  modeButton.textContent = `MODE: ${mode.toUpperCase()}`;
  void build();
});
modeButton.textContent = `MODE: ${mode.toUpperCase()}`;
wearButton.addEventListener('click', () => {
  worn = !worn;
  wearButton.textContent = worn ? 'WEAR 0.6 · ON' : 'WEAR 0.6';
  for (const disc of discs) disc.setWear(worn ? wearAt(0.6) : null);
});

async function save(path: string, blob: Blob): Promise<string> {
  const response = await fetch(`/__save?path=${encodeURIComponent(path)}`, { method: 'POST', body: blob });
  return response.text();
}

loopButton.addEventListener('click', async () => {
  if (!design || !art) return;
  loopButton.disabled = true;
  status.textContent = 'RENDERING SPIN LOOP';
  const started = performance.now();
  try {
    const result = await renderSpinLoop(design, { art, frames: 36, frameSize: 512, edition: edition ?? 7 });
    const slug = design.slug;
    const reports = [
      await save(`shots/${slug}-spin.png`, result.sheet.png),
      result.sheet.webp ? await save(`shots/${slug}-spin.webp`, result.sheet.webp) : 'no webp encoder',
      await save(`shots/${slug}-spin.json`, new Blob([JSON.stringify(result.sheet.meta, null, 2)], { type: 'application/json' })),
      await save(`shots/${slug}-still.png`, result.still),
    ];
    sheetImage.src = URL.createObjectURL(result.sheet.webp ?? result.sheet.png);
    sheetImage.style.display = 'block';
    status.textContent = `SPIN LOOP ${Math.round(performance.now() - started)} MS · ${result.sheet.meta.cols}×${result.sheet.meta.rows} · ${result.sheet.webp ? 'WEBP+PNG' : 'PNG'}`;
    console.log(reports.join('\n'));
    (window as unknown as { __spin: unknown }).__spin = result.sheet.meta;
  } catch (err) {
    status.textContent = `SPIN LOOP FAILED: ${err instanceof Error ? err.message : err}`;
    console.error(err);
  } finally {
    loopButton.disabled = false;
  }
});

ensureFonts()
  .then(build)
  .then(() => {
    (window as unknown as { __ready: boolean }).__ready = true;
  })
  .catch((err) => {
    status.textContent = `FAILED: ${err instanceof Error ? err.message : err}`;
    console.error(err);
  });

/** A transparent PNG of an odd shape, for `?stickerdemo`. */
function demoSticker(shape: 'star' | 'blob'): string {
  const size = 512;
  const element = document.createElement('canvas');
  element.width = element.height = size;
  const ctx = element.getContext('2d')!;
  ctx.beginPath();
  if (shape === 'star') {
    for (let i = 0; i < 10; i++) {
      const r = i % 2 === 0 ? size * 0.48 : size * 0.2;
      const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
      ctx.lineTo(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r);
    }
    ctx.fillStyle = '#ffd23f';
  } else {
    ctx.ellipse(size / 2, size / 2, size * 0.46, size * 0.3, 0.4, 0, Math.PI * 2);
    ctx.fillStyle = '#39c0ff';
  }
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = size * 0.03;
  ctx.strokeStyle = '#111';
  ctx.stroke();
  ctx.fillStyle = '#111';
  ctx.font = `800 ${size * 0.12}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(shape === 'star' ? 'HOT' : 'NEW', size / 2, size / 2);
  return element.toDataURL('image/png');
}

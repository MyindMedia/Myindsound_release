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
import { assertDesign, type DiscDesign, type ShellPresetId } from '../src/design';
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
  const design = assertDesign(entry[1]);
  const resolve = (ref: string) => {
    const hit = Object.entries(artUrls).find(([path]) => path.endsWith(`/samples/${ref}`));
    if (!hit) throw new Error(`Sample art missing: ${ref}`);
    return new URL(hit[1], location.href).href;
  };
  return { ...design, coverArt: resolve(design.coverArt), discArt: design.discArt ? resolve(design.discArt) : undefined, theme: design.theme ? { ...design.theme, backdrop: design.theme.backdrop ? { ...design.theme.backdrop, image: design.theme.backdrop.image ? resolve(design.theme.backdrop.image) : undefined } : undefined } : undefined };
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
    const presets = SHELL_PRESET_LIST;
    const gap = 0.98;
    presets.forEach((preset, i) => {
      const disc = createMiniDisc({ ...design!, shell: preset.id as ShellPresetId, shellTint: undefined, discFinish: undefined }, art!, {
        environment,
        quality: 'high',
        sleeve: false,
        anisotropy: renderer.capabilities.getMaxAnisotropy(),
      });
      disc.group.position.x = (i - (presets.length - 1) / 2) * gap;
      disc.setEdition(edition ?? 7 + i);
      if (worn) disc.setWear(wearAt(0.6));
      disc.spin(1.4);
      scene.add(disc.group);
      discs.push(disc);
      const label = document.createElement('span');
      label.textContent = preset.label;
      label.style.width = `${100 / presets.length}%`;
      label.style.textAlign = 'center';
      labels.append(label);
    });
    camera.position.set(0, 0.25, 6.3);
    camera.lookAt(0, -0.02, 0);
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
    disc.group.rotation.y = Math.sin(elapsed * 0.5 + i * 0.4) * 0.45;
    disc.group.rotation.x = Math.sin(elapsed * 0.31 + i) * 0.12 - 0.05;
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

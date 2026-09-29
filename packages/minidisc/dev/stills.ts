/**
 * Renders the rack stills (`renderSleeveStill`) for the sample designs and saves them into `shots/` through the
 * dev server: `<slug>-sleeve.png`, `<slug>-sleeve.webp` and `<slug>-sleeve.json` (size and the face rectangle), and
 * the cartridge on its own for the app's now playing thumbnail: `<slug>-cart.png` / `.webp` (512 px).
 * `?designs=lit,blood` picks samples (default: all). `window.__stills` resolves with the saved paths.
 */
import { ensureFonts } from '../src/canvas';
import { assertDesign, type DiscDesign } from '../src/design';
import { renderSleeveStill } from '../src/sleeve-still';

const designs = import.meta.glob('../samples/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;
const artUrls = import.meta.glob('../samples/**/*.{png,jpg,webp}', { eager: true, import: 'default', query: '?url' }) as Record<string, string>;
const status = document.getElementById('status')!;
const grid = document.getElementById('grid')!;

function sampleDesign(path: string): DiscDesign {
  const design = assertDesign(designs[path]);
  const resolve = (ref: string) => {
    const hit = Object.entries(artUrls).find(([p]) => p.endsWith(`/samples/${ref}`));
    if (!hit) throw new Error(`Sample art missing: ${ref}`);
    return new URL(hit[1], location.href).href;
  };
  return { ...design, coverArt: resolve(design.coverArt), discArt: design.discArt ? resolve(design.discArt) : undefined, labelArt: design.labelArt ? resolve(design.labelArt) : undefined, stickers: design.stickers?.map((sticker) => (sticker.kind === 'image' ? { ...sticker, src: resolve(sticker.src) } : sticker)), theme: design.theme ? { ...design.theme, backdrop: design.theme.backdrop ? { ...design.theme.backdrop, image: design.theme.backdrop.image ? resolve(design.theme.backdrop.image) : undefined } : undefined } : undefined };
}

async function save(path: string, blob: Blob): Promise<string> {
  const response = await fetch(`/__save?path=${encodeURIComponent(path)}`, { method: 'POST', body: blob });
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return path;
}

/** A render at `size` px (the renderer's floor is 1024; the thumbnail needs no more than 512). */
async function shrink(blob: Blob, size: number, type: string): Promise<Blob> {
  const image = await createImageBitmap(blob);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, size, size);
  return new Promise((resolve, reject) => canvas.toBlob((out) => (out ? resolve(out) : reject(new Error('encode failed'))), type, 0.92));
}

async function run(): Promise<string[]> {
  await ensureFonts();
  const wanted = new URLSearchParams(location.search).get('designs')?.split(',').filter(Boolean);
  const paths = Object.keys(designs)
    .filter((p) => !wanted || wanted.some((name) => p.endsWith(`/${name}.json`)))
    .sort();
  const saved: string[] = [];
  for (const path of paths) {
    const design = sampleDesign(path);
    const slug = path.split('/').pop()!.replace(/\.json$/, '');
    status.textContent = `RENDERING ${slug}`;
    const started = performance.now();
    const still = await renderSleeveStill(design, { size: 1024 });
    saved.push(await save(`shots/${slug}-sleeve.png`, still.png));
    if (still.webp) saved.push(await save(`shots/${slug}-sleeve.webp`, still.webp));
    const cart = await renderSleeveStill(design, { size: 1024, cartridge: true });
    saved.push(await save(`shots/${slug}-cart.png`, await shrink(cart.png, 512, 'image/png')));
    if (cart.webp) saved.push(await save(`shots/${slug}-cart.webp`, await shrink(cart.webp, 512, 'image/webp')));
    const meta = { size: still.size, face: still.face };
    saved.push(await save(`shots/${slug}-sleeve.json`, new Blob([JSON.stringify(meta, null, 2) + '\n'], { type: 'application/json' })));
    const figure = document.createElement('figure');
    figure.innerHTML = `<img alt="${slug} sleeve" src="${URL.createObjectURL(still.png)}"><figcaption>${slug} · ${((performance.now() - started) / 1000).toFixed(1)} s · png ${(still.png.size / 1024).toFixed(0)} KB · webp ${still.webp ? (still.webp.size / 1024).toFixed(0) + ' KB' : 'none'}</figcaption>`;
    grid.append(figure);
  }
  status.textContent = `DONE · ${saved.length} FILES`;
  return saved;
}

(window as unknown as { __stills: Promise<string[]> }).__stills = run().catch((error) => {
  status.textContent = `FAILED: ${error instanceof Error ? error.message : String(error)}`;
  throw error;
});

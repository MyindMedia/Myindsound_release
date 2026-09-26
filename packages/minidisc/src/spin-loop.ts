/**
 * `renderSpinLoop`: N frames of the release in its sleeve, pulled part way out so the disc shows and spins one
 * full turn while the whole thing turns gently, over a transparent background, packed into a sprite sheet
 * (WebP with alpha, PNG fallback) with a still front. Runs in the browser (the admin portal at publish time);
 * returns Blobs for upload. The loop is seamless: both the disc and the turn are periodic over N frames.
 */
import { DirectionalLight, HemisphereLight, NeutralToneMapping, PerspectiveCamera, PointLight, Scene, SRGBColorSpace, WebGLRenderer } from 'three';
import { createStudioEnvironment } from '../../../src/player3d/cartridge-detail';
import { ensureFonts } from './canvas';
import type { DiscDesign } from './design';
import { createMiniDisc, loadDesignArt, type DesignArt } from './minidisc';
import { largestFrameSize, packSprites, spriteCell, type SpriteSheetMeta } from './sprite';

export interface SpinLoopOptions {
  /** Frames in the loop. Default 36. */
  frames?: number;
  /** Square frame size in px; shrunk if the sheet would pass 4096 px. Default 512. */
  frameSize?: number;
  fps?: number;
  /** The still front's size in px. Default 1024. */
  stillSize?: number;
  /** Already loaded art (else loaded relative to `base`). */
  art?: DesignArt;
  /** Where relative art paths resolve from (the design.json URL). */
  base?: string;
  /** How far the cartridge stands out of its sleeve, as a fraction of its height. Default 0.55. */
  sleeveDrop?: number;
  /** Peak yaw of the gentle turn, degrees. Default 14. */
  turnDeg?: number;
  /** Edition stamp to show, if any. */
  edition?: number | null;
  /** WebP quality 0..1. Default 0.9. */
  webpQuality?: number;
}

export interface SpinLoopResult {
  sheet: {
    /** `null` when the browser cannot encode WebP (Firefox before 96, older Safari): use `png`. */
    webp: Blob | null;
    png: Blob;
    meta: SpriteSheetMeta;
  };
  /** A still of the front, sleeved, PNG with alpha. */
  still: Blob;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob && blob.type === type ? blob : null), type, quality));
}

export async function renderSpinLoop(design: DiscDesign, options: SpinLoopOptions = {}): Promise<SpinLoopResult> {
  const frames = options.frames ?? 36;
  const fps = options.fps ?? 24;
  const frameSize = largestFrameSize(frames, options.frameSize ?? 512);
  const stillSize = options.stillSize ?? 1024;
  const layout = packSprites(frames, frameSize, frameSize);
  await ensureFonts();
  const art = options.art ?? (await loadDesignArt(design, options.base));

  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = Math.max(frameSize, stillSize);
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = SRGBColorSpace;
  renderer.toneMapping = NeutralToneMapping;
  const environment = createStudioEnvironment(renderer);

  const scene = new Scene();
  const camera = new PerspectiveCamera(26, 1, 0.05, 20);
  // Soft key from high left, well off the mirror angle of the turn, so no frame flares white.
  const key = new DirectionalLight('#ffffff', 0.9);
  key.position.set(-2.5, 4, 3);
  const pink = new PointLight('#FF3DA8', 2.5, 12, 1.6);
  pink.position.set(-3, 0.8, 2.6);
  const ice = new PointLight('#9FD8FF', 2, 12, 1.6);
  ice.position.set(3, -0.4, 2.6);
  scene.add(new HemisphereLight('#c9d8e6', '#1a0a14', 1.1), key, pink, ice);

  const drop = options.sleeveDrop ?? 0.55;
  const disc = createMiniDisc(design, art, {
    environment,
    quality: 'high',
    transmission: false,
    anisotropy: renderer.capabilities.getMaxAnisotropy(),
    sleeve: true,
    sleeveDrop: drop,
  });
  disc.setEdition(options.edition ?? null);
  scene.add(disc.group);
  // The package (cartridge + sleeve hanging below it) centred and filling the frame.
  const packageHeight = disc.height * (1 + drop) + 0.03;
  const packageWidth = disc.width + 0.05;
  const fit = Math.max(packageHeight, packageWidth) * 1.08;
  const distance = fit / 2 / Math.tan((camera.fov * Math.PI) / 360);
  camera.position.set(0, -disc.height * drop * 0.5, distance);
  camera.lookAt(0, -disc.height * drop * 0.5, 0);
  disc.group.position.y = 0;

  const turn = ((options.turnDeg ?? 14) * Math.PI) / 180;
  const sheet = document.createElement('canvas');
  sheet.width = layout.sheetW;
  sheet.height = layout.sheetH;
  const sctx = sheet.getContext('2d')!;
  const spinning = disc.built.spinning;

  const renderFrame = (index: number, px: number) => {
    const t = index / frames;
    for (const object of spinning) object.rotation.z = -t * Math.PI * 2;
    // Pitched a little towards the camera, so the flat face mirrors the studio floor, never its ceiling lights.
    disc.group.rotation.set(0.1 + Math.sin(t * Math.PI * 2 + Math.PI / 2) * 0.04, Math.sin(t * Math.PI * 2) * turn, 0);
    renderer.setSize(px, px, false);
    camera.aspect = 1;
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };

  for (let i = 0; i < frames; i++) {
    renderFrame(i, frameSize);
    const cell = spriteCell(layout, i);
    // setSize resized the canvas to the frame, so the frame is the whole canvas.
    sctx.drawImage(canvas, 0, 0, frameSize, frameSize, cell.x, cell.y, frameSize, frameSize);
  }
  const webp = await toBlob(sheet, 'image/webp', options.webpQuality ?? 0.9);
  const png = await toBlob(sheet, 'image/png');
  if (!png) throw new Error('renderSpinLoop: PNG encoding failed');

  // The still: the front, straight on, sleeve fully on.
  disc.setSleeve(true, 0);
  for (const object of spinning) object.rotation.z = 0;
  disc.group.rotation.set(-0.04, 0.12, 0);
  const stillFit = Math.max(disc.height + 0.05, disc.width + 0.05) * 1.06;
  camera.position.set(0, 0, stillFit / 2 / Math.tan((camera.fov * Math.PI) / 360));
  camera.lookAt(0, 0, 0);
  renderer.setSize(stillSize, stillSize, false);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const stillCanvas = document.createElement('canvas');
  stillCanvas.width = stillCanvas.height = stillSize;
  stillCanvas.getContext('2d')!.drawImage(canvas, 0, 0, stillSize, stillSize, 0, 0, stillSize, stillSize);
  const still = await toBlob(stillCanvas, 'image/png');
  if (!still) throw new Error('renderSpinLoop: still PNG encoding failed');

  disc.dispose();
  environment.dispose();
  renderer.dispose();

  return {
    sheet: { webp, png, meta: { ...layout, fps, format: webp ? 'image/webp' : 'image/png' } },
    still,
  };
}

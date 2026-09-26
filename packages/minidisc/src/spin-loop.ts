/**
 * `renderSpinLoop`: N frames of the release in its sleeve, pulled part way out so the disc shows and spins one
 * full turn while the whole thing turns gently, over a transparent background, packed into a sprite sheet
 * (WebP with alpha, PNG fallback) with a still front. Runs in the browser (the admin portal at publish time);
 * returns Blobs for upload. The loop is seamless: both the disc and the turn are periodic over N frames.
 */
import { Box3, DirectionalLight, HemisphereLight, NeutralToneMapping, PerspectiveCamera, PointLight, Scene, SRGBColorSpace, Vector3, WebGLRenderer } from 'three';
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
  // The package (cartridge + the sleeve hanging below it) fits the frame through the whole turn: the camera sits
  // back far enough for the bounding sphere of the whole thing (its box, whichever way it turns), plus a margin.
  const margin = 1.06;
  const frame = (): void => {
    disc.group.rotation.set(0, 0, 0);
    disc.group.updateMatrixWorld(true);
    const box = new Box3().setFromObject(disc.group, true);
    const centre = box.getCenter(new Vector3());
    const radius = box.getSize(new Vector3()).length() / 2;
    const distance = (radius * margin) / Math.sin((camera.fov * Math.PI) / 360);
    // Turn about the package's own centre, so the box is what sweeps, not a corner of it.
    disc.group.position.sub(centre);
    camera.position.set(0, 0, distance);
    camera.lookAt(0, 0, 0);
  };
  frame();

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
  // A blank sheet must never come back as a result: check that the frames actually drew something.
  const probe = sctx.getImageData(0, 0, Math.min(sheet.width, 256), Math.min(sheet.height, 256)).data;
  let drawn = 0;
  for (let i = 3; i < probe.length; i += 4) if (probe[i] > 0) drawn++;
  const full = sctx.getImageData(0, 0, sheet.width, sheet.height).data;
  let any = drawn;
  for (let i = 3; i < full.length && any === 0; i += 64) if (full[i] > 0) any++;
  if (any === 0) throw new Error('renderSpinLoop: every frame came out blank (no pixel with alpha > 0)');
  const webp = await toBlob(sheet, 'image/webp', options.webpQuality ?? 0.9);
  const png = await toBlob(sheet, 'image/png');
  if (!png) throw new Error('renderSpinLoop: PNG encoding failed');

  // The still: the front, nearly straight on, sleeve fully on, fitted the same way.
  disc.setSleeve(true, 0);
  for (const object of spinning) object.rotation.z = 0;
  disc.group.position.set(0, 0, 0);
  frame();
  disc.group.rotation.set(0.06, 0.12, 0);
  renderer.setSize(stillSize, stillSize, false);
  camera.updateProjectionMatrix();
  renderer.render(scene, camera);
  const stillCanvas = document.createElement('canvas');
  stillCanvas.width = stillCanvas.height = stillSize;
  stillCanvas.getContext('2d')!.drawImage(canvas, 0, 0, stillSize, stillSize, 0, 0, stillSize, stillSize);
  const stillProbe = stillCanvas.getContext('2d')!.getImageData(0, 0, stillSize, stillSize).data;
  let stillDrawn = 0;
  for (let i = 3; i < stillProbe.length && stillDrawn === 0; i += 64) if (stillProbe[i] > 0) stillDrawn++;
  if (stillDrawn === 0) throw new Error('renderSpinLoop: the still came out blank');
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

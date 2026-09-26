import { CanvasTexture, Color, Mesh, MeshStandardMaterial, PlaneGeometry, SRGBColorSpace } from 'three';
import { CART_DEPTH, type Deck } from '../../src/player3d/deck';
import geometry from '../../src/player3d/geometry.json';
import { formatEdition } from './copy';

/**
 * The copy's edition number, rubber-stamped in the corner of the cartridge label ("Do Not Duplicate"), without
 * re-texturing the label: a small plane with its own canvas texture, laid on the label (PRD §8, DS-32).
 */

/**
 * Where the stamp sits on the label, as fractions of the label art with the origin top left. The manifest's
 * `wearSafeZones` keeps scratches off this corner (bundle.json, a little padded).
 */
export const STAMP_UV = { x: 0.72, y: 0.83, w: 0.25, h: 0.13 } as const;

/** Mirrors `labelDrop` in deck.ts: the label sits this much lower than in the Canva comp. */
const LABEL_DROP = 0.045;
/** The label's handwriting red, a touch darker, as stamp ink. */
const INK = '#a8102c';

/** The label's face (deck.ts puts it at CART_DEPTH / 2 + 0.0015). */
export const LABEL_Z = CART_DEPTH / 2 + 0.0015;
/** Just above the label, and above its wear (wear.ts). */
const STAMP_Z = LABEL_Z + 0.0003;

/** The label's rectangle in the cartridge group's space, as deck.ts builds it. */
export function labelRect() {
  const cart = geometry.cartridge.rect;
  const cx = (cart.x0 + cart.x1) / 2;
  const cy = (cart.y0 + cart.y1) / 2;
  const label = geometry.label.rect;
  return {
    x0: label.x0 - cx,
    x1: label.x1 - cx,
    y0: label.y0 - cy - LABEL_DROP,
    y1: label.y1 - cy - LABEL_DROP,
  };
}

/** A tiny seeded PRNG, so a copy's stamp wears the same every time. */
function prng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function drawStamp(canvas: HTMLCanvasElement, edition: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const { width, height } = canvas;
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(width / 2, height / 2);
  ctx.rotate((-2.5 * Math.PI) / 180);
  ctx.globalAlpha = 0.88;
  ctx.strokeStyle = INK;
  ctx.fillStyle = INK;
  const boxW = width * 0.92;
  const boxH = height * 0.78;
  ctx.lineWidth = height * 0.06;
  ctx.beginPath();
  ctx.roundRect(-boxW / 2, -boxH / 2, boxW, boxH, height * 0.12);
  ctx.stroke();
  ctx.font = `700 ${Math.round(height * 0.5)}px 'JetBrains Mono', ui-monospace, Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatEdition(edition), 0, height * 0.03, boxW * 0.9);
  ctx.restore();
  // Rubber stamps never ink evenly: knock out specks, the same ones for the same edition.
  const random = prng(edition * 2654435761);
  ctx.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 260; i++) {
    ctx.globalAlpha = 0.25 + random() * 0.6;
    ctx.beginPath();
    ctx.arc(random() * width, random() * height, 0.6 + random() * 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
}

/**
 * Adds the stamp to the cartridge. The text is drawn once the mono font is ready (it is bundled); returns a
 * function that takes the stamp off again.
 */
export function addEditionStamp(deck: Deck, edition: number): () => void {
  const rect = labelRect();
  const labelW = rect.x1 - rect.x0;
  const labelH = rect.y1 - rect.y0;
  const w = STAMP_UV.w * labelW;
  const h = STAMP_UV.h * labelH;
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = Math.round((512 * h) / w);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  const material = new MeshStandardMaterial({
    map: texture,
    // Same lighting as the label: lit so it shades as it turns, emissive so it stays legible.
    emissiveMap: texture,
    emissive: new Color(0.62, 0.62, 0.62),
    roughness: 0.92,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
  });
  const stamp = new Mesh(new PlaneGeometry(w, h), material);
  stamp.name = 'edition-stamp';
  stamp.position.set(
    rect.x0 + (STAMP_UV.x + STAMP_UV.w / 2) * labelW,
    rect.y1 - (STAMP_UV.y + STAMP_UV.h / 2) * labelH,
    STAMP_Z,
  );
  stamp.renderOrder = 5;
  deck.cartridge.add(stamp);

  const draw = () => {
    drawStamp(canvas, edition);
    texture.needsUpdate = true;
  };
  draw();
  document.fonts?.load(`700 32px 'JetBrains Mono'`).then(draw, () => {});

  return () => {
    deck.cartridge.remove(stamp);
    stamp.geometry.dispose();
    material.dispose();
    texture.dispose();
  };
}

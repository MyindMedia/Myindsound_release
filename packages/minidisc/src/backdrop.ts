/**
 * The release bundle's backdrop: the current release's cover art (or `theme.backdrop.image`), scaled to cover
 * the viewport, lightly blurred so it stays recognisable, and dimmed under an ink scrim so the HUD and the deck
 * stay legible. Pinned flat to the camera like the comic city, with a very slow drift (still under Reduce
 * Motion) and a soft pulse on the bass. The scene's CRT pass adds the scanlines, vignette and grain on top.
 */
import { Group, Mesh, PlaneGeometry, ShaderMaterial, Vector2, type PerspectiveCamera, type Texture } from 'three';
import type { Backdrop } from '../../../src/player3d/backdrop';
import { canvas, drawCover, srgbTexture, type ArtSource } from './canvas';

const DISTANCE = 30;
/** Room for the drift without showing an edge. */
const MARGIN = 1.12;
/** The art is blurred for a 390 pt phone; the canvas is this wide, so the blur scales with it. */
const PHONE_WIDTH = 390;
const SIZE = 512;

export interface ArtBackdropOptions {
  image: ArtSource;
  /** Blur at phone width, in CSS px. */
  blurPx: number;
  /** Ink over the art, 0..1. */
  scrim: number;
  reducedMotion: boolean;
}

/**
 * Blurs by drawing the art small and back up again (two passes), which every browser does the same way;
 * `ctx.filter` is used on top where it exists for a smoother result.
 */
export function blurArt(image: ArtSource, blurPx: number, size = SIZE): HTMLCanvasElement {
  const [out, ctx] = canvas(size);
  const radius = (blurPx * size) / PHONE_WIDTH;
  if (radius < 0.5) {
    drawCover(ctx, image, 0, 0, size, size);
    return out;
  }
  const small = Math.max(4, Math.round(size / Math.max(1, radius * 0.9)));
  const [tiny, tctx] = canvas(small);
  tctx.imageSmoothingEnabled = true;
  tctx.imageSmoothingQuality = 'high';
  // Draw a little over the edges, so the blur has no dark border.
  drawCover(tctx, image, -1, -1, small + 2, small + 2);
  const [mid, mctx] = canvas(small * 2);
  mctx.imageSmoothingQuality = 'high';
  mctx.drawImage(tiny, 0, 0, small * 2, small * 2);
  ctx.imageSmoothingQuality = 'high';
  if ('filter' in ctx) ctx.filter = `blur(${(radius * 0.25).toFixed(1)}px)`;
  ctx.drawImage(mid, -size * 0.02, -size * 0.02, size * 1.04, size * 1.04);
  if ('filter' in ctx) ctx.filter = 'none';
  return out;
}

const SHADER = {
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uMap;
    uniform vec2 uCover;
    uniform float uTime;
    uniform float uMotion;
    uniform float uScrim;
    uniform float uBass;
    varying vec2 vUv;
    const vec3 INK = vec3(0.027, 0.027, 0.047);
    void main() {
      // Cover-fit, then a slow drift and breathe.
      vec2 uv = (vUv - 0.5) * uCover;
      float t = uTime * 0.05 * uMotion;
      uv *= 0.94 + 0.012 * sin(t * 0.7);
      uv += vec2(sin(t) * 0.012, cos(t * 0.8) * 0.009) * uMotion;
      vec3 art = texture2D(uMap, uv + 0.5).rgb;
      float vig = smoothstep(1.15, 0.3, length((vUv - 0.5) * vec2(1.1, 1.0)));
      vec3 colour = art * mix(0.55, 1.0, vig);
      colour = mix(colour, INK, uScrim);
      colour += art * uBass * 0.08;
      gl_FragColor = vec4(colour, 1.0);
      #include <colorspace_fragment>
    }
  `,
};

export class ArtBackdrop implements Backdrop {
  readonly group = new Group();
  private plane: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private texture: Texture | null = null;
  private aspect = 1;
  private readonly options: ArtBackdropOptions;

  constructor(options: ArtBackdropOptions) {
    this.options = options;
  }

  async attach(camera: PerspectiveCamera): Promise<void> {
    const blurred = blurArt(this.options.image, this.options.blurPx);
    this.texture = srgbTexture(blurred, 1);
    this.material = new ShaderMaterial({
      vertexShader: SHADER.vertexShader,
      fragmentShader: SHADER.fragmentShader,
      uniforms: {
        uMap: { value: this.texture },
        uCover: { value: new Vector2(1, 1) },
        uTime: { value: 0 },
        uMotion: { value: this.options.reducedMotion ? 0 : 1 },
        uScrim: { value: this.options.scrim },
        uBass: { value: 0 },
      },
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    });
    const plane = new Mesh(new PlaneGeometry(1, 1), this.material);
    plane.renderOrder = -100;
    plane.frustumCulled = false;
    plane.position.z = -DISTANCE;
    camera.add(plane);
    this.plane = plane;
    this.fit(camera);
  }

  fit(camera: PerspectiveCamera): void {
    if (!this.plane || !this.material) return;
    const viewHeight = 2 * DISTANCE * Math.tan((camera.fov * Math.PI) / 360) * MARGIN;
    const viewWidth = viewHeight * camera.aspect;
    this.plane.scale.set(viewWidth, viewHeight, 1);
    this.aspect = viewWidth / viewHeight;
    // The art is square: cover-fit means cropping the short axis.
    const cover = this.material.uniforms.uCover.value as Vector2;
    if (this.aspect >= 1) cover.set(1, 1 / this.aspect);
    else cover.set(this.aspect, 1);
  }

  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (this.plane) this.plane.visible = visible;
  }

  setAudio(drive: { bass: number; level: number }): void {
    if (this.material) this.material.uniforms.uBass.value += (drive.bass - this.material.uniforms.uBass.value) * 0.2;
  }

  update(_dt: number, elapsed: number): void {
    if (this.material) this.material.uniforms.uTime.value = elapsed;
  }

  dispose(): void {
    this.plane?.removeFromParent();
    this.plane?.geometry.dispose();
    this.material?.dispose();
    this.texture?.dispose();
  }
}

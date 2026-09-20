import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Mesh,
  PlaneGeometry,
  Points,
  ShaderMaterial,
  SRGBColorSpace,
  TextureLoader,
  Vector4,
  type PerspectiveCamera,
  type Texture,
} from 'three';
import { COMIC_CITY, EMBERS, MAX_CRAFT, MAX_WALKER } from './backdrop-shaders';
import { PALETTE, RAIN } from './shaders';

/**
 * The city the player is set in: the LIT street painting (`npm run city`), plus neon pulse, beam
 * shimmer, flying craft, people on the pavements, embers and rain.
 *
 * The painting is pinned flat to the camera and stays that way. It neither tilts with the deck nor
 * bends under a parallax shift: those read as the backdrop wobbling behind the player.
 */

const BASE = '/assets/images/minidisc/';
const DISTANCE = 30;
const MARGIN = 1.16;
const IMAGE_ASPECT = 21 / 9;

type Craft = { x: number; y: number; scale: number; dir: number; speed: number };
/**
 * The street runs away from the camera to a vanishing point, so anything on it travels a line rather than
 * a row of pixels: `t` is how far down that line it is, 0 at the camera and 1 at the far end, and
 * everything about it follows from that.
 */
type Lane = { nearX: number; nearY: number; farX: number; farY: number };
/** Somebody on the pavement, pacing a few steps along it and back. */
type Walker = { lane: Lane; home: number; span: number; rate: number; phase: number };

/** Where the pavements sit in the painting, near edge to vanishing point. */
const PAVEMENT: Lane[] = [
  { nearX: 0.1, nearY: 0.05, farX: 0.44, farY: 0.42 },
  { nearX: 0.9, nearY: 0.05, farX: 0.57, farY: 0.42 },
];

/** Position and size at `t` along a lane: further away is nearer the vanishing point, and smaller. */
function along(lane: Lane, t: number): { x: number; y: number; scale: number } {
  const eased = t * t; // perspective: the far half of the street takes up very little of the frame
  return {
    x: lane.nearX + (lane.farX - lane.nearX) * eased,
    y: lane.nearY + (lane.farY - lane.nearY) * eased,
    scale: 1.55 - 1.25 * eased,
  };
}

function load(loader: TextureLoader, file: string, srgb: boolean): Promise<Texture> {
  return new Promise((resolve, reject) => {
    loader.load(
      BASE + file,
      (texture) => {
        if (srgb) texture.colorSpace = SRGBColorSpace;
        resolve(texture);
      },
      undefined,
      reject,
    );
  });
}

export class ComicCity {
  readonly group = new Group();
  private plane: Mesh | null = null;
  private material: ShaderMaterial | null = null;
  private timed: ShaderMaterial[] = [];
  private crafts: Craft[] = [];
  private walkers: Walker[] = [];
  private bass = 0;
  private readonly motion: number;
  private readonly pixelRatio: number;

  constructor(options: { reducedMotion: boolean; coarsePointer: boolean; pixelRatio: number }) {
    this.motion = options.reducedMotion ? 0 : 1;
    this.pixelRatio = options.pixelRatio;
    this.buildEmbers(options.coarsePointer ? 160 : 420);
    if (!options.reducedMotion) this.buildRain(options.coarsePointer ? 360 : 900);
    for (let i = 0; i < (options.coarsePointer ? 3 : 5); i++) this.crafts.push(this.spawnCraft(Math.random()));
    const walkers = options.coarsePointer ? 4 : MAX_WALKER;
    for (let i = 0; i < walkers; i++) this.walkers.push(this.spawnWalker(i, walkers));
  }

  /** Loads the painted city and pins it to the camera, cover-fitted. */
  async attach(camera: PerspectiveCamera): Promise<void> {
    const loader = new TextureLoader();
    const [map, depth, mask] = await Promise.all([
      load(loader, 'city-comic.webp', true),
      load(loader, 'city-depth.webp', false),
      load(loader, 'city-mask.webp', false),
    ]);
    this.material = new ShaderMaterial({
      vertexShader: COMIC_CITY.vertexShader,
      fragmentShader: COMIC_CITY.fragmentShader,
      uniforms: {
        uMap: { value: map },
        uDepth: { value: depth },
        uMask: { value: mask },
        uTime: { value: 0 },
        uMotion: { value: this.motion },
        uBass: { value: 0 },
        uAspect: { value: IMAGE_ASPECT },
        uCraft: { value: Array.from({ length: MAX_CRAFT }, () => new Vector4()) },
        uCraftColor: { value: Array.from({ length: MAX_CRAFT }, () => new Color()) },
        uWalker: { value: Array.from({ length: MAX_WALKER }, () => new Vector4()) },
        uHaze: { value: this.motion > 0 ? 1 : 0.7 },
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
    if (!this.plane) return;
    const viewHeight = 2 * DISTANCE * Math.tan((camera.fov * Math.PI) / 360) * MARGIN;
    const viewWidth = viewHeight * camera.aspect;
    const height = Math.max(viewHeight, viewWidth / IMAGE_ASPECT);
    this.plane.scale.set(height * IMAGE_ASPECT, height, 1);
  }

  /** People are spread along both pavements and pace a little way up and down them. */
  private spawnWalker(index: number, total: number): Walker {
    const lane = PAVEMENT[index % 2];
    // Spread along the near half of the pavement, where a figure is big enough to read.
    const home = 0.12 + ((index + 0.5) / total) * 0.55;
    return {
      lane,
      home,
      span: 0.04 + Math.random() * 0.06,
      rate: 0.06 + Math.random() * 0.09,
      phase: Math.random() * Math.PI * 2,
    };
  }

  private spawnCraft(startX?: number): Craft {
    const dir = Math.random() < 0.5 ? -1 : 1;
    return {
      dir,
      x: startX ?? (dir > 0 ? -0.08 : 1.08),
      y: 0.66 + Math.random() * 0.3,
      scale: 0.55 + Math.random() * 0.8,
      speed: 0.018 + Math.random() * 0.04,
    };
  }

  private buildEmbers(count: number): void {
    const positions = new Float32Array(count * 3);
    const seeds = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const palette = ['#FF9A4A', '#FF9A4A', '#FF6FB8', '#FFFFFF', '#7FEFFF'].map((hex) => new Color(hex));
    for (let i = 0; i < count; i++) {
      positions.set([(Math.random() - 0.5) * 9, -2.5 + Math.random() * 8, -2.5 - Math.random() * 9], i * 3);
      seeds.set([Math.random(), Math.random(), Math.random()], i * 3);
      const color = palette[Math.floor(Math.random() * palette.length)];
      colors.set([color.r, color.g, color.b], i * 3);
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
    geometry.setAttribute('aSeed', new Float32BufferAttribute(seeds, 3));
    geometry.setAttribute('aColor', new Float32BufferAttribute(colors, 3));
    const material = new ShaderMaterial({
      vertexShader: EMBERS.vertexShader,
      fragmentShader: EMBERS.fragmentShader,
      uniforms: { uTime: { value: 0 }, uMotion: { value: this.motion }, uPixelRatio: { value: this.pixelRatio } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.timed.push(material);
    const points = new Points(geometry, material);
    points.frustumCulled = false;
    this.group.add(points);
  }

  private buildRain(count: number): void {
    const base = new PlaneGeometry(0.0035, 0.22);
    const geometry = new InstancedBufferGeometry();
    geometry.index = base.index;
    geometry.setAttribute('position', base.getAttribute('position'));
    geometry.instanceCount = count;
    const seeds = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) seeds.set([(Math.random() - 0.5) * 16, Math.random(), Math.random()], i * 3);
    geometry.setAttribute('aSeed', new InstancedBufferAttribute(seeds, 3));
    const material = new ShaderMaterial({
      vertexShader: RAIN.vertexShader,
      fragmentShader: RAIN.fragmentShader,
      uniforms: { uTime: { value: 0 }, uHeight: { value: 9 }, uColor: { value: PALETTE.ice } },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.timed.push(material);
    const rain = new Mesh(geometry, material);
    rain.frustumCulled = false;
    this.group.add(rain);
  }

  /** The whole backdrop, including the sky plane that rides on the camera (hidden for the opening scene). */
  setVisible(visible: boolean): void {
    this.group.visible = visible;
    if (this.plane) this.plane.visible = visible;
  }

  setAudio(drive: { bass: number; level: number }): void {
    this.bass += (drive.bass - this.bass) * 0.25;
  }

  update(dt: number, elapsed: number): void {
    const time = elapsed * this.motion;
    for (const material of this.timed) material.uniforms.uTime.value = time;
    if (!this.material) return;
    const uniforms = this.material.uniforms;
    uniforms.uTime.value = time;
    uniforms.uBass.value = this.bass;
    const slots = uniforms.uCraft.value as Vector4[];
    const colors = uniforms.uCraftColor.value as Color[];
    this.crafts.forEach((craft, i) => {
      if (this.motion > 0) {
        craft.x += craft.dir * craft.speed * dt;
        if (craft.x < -0.12 || craft.x > 1.12) this.crafts[i] = craft = this.spawnCraft();
      }
      slots[i].set(craft.x, craft.y + Math.sin(elapsed * 0.6 + i) * 0.004, this.motion > 0 ? craft.scale : 0, craft.dir);
      colors[i].copy(i % 2 === 0 ? PALETTE.ice : PALETTE.pink);
    });

    const walkers = uniforms.uWalker.value as Vector4[];
    this.walkers.forEach((walker, i) => {
      // A few paces along the pavement and back, so they walk into and out of the frame's depth.
      const swing = Math.sin(elapsed * walker.rate * Math.PI * 2 + walker.phase) * this.motion;
      const t = Math.max(0.02, Math.min(0.95, walker.home + swing * walker.span));
      const at = along(walker.lane, t);
      const bob = Math.abs(Math.cos(elapsed * walker.rate * Math.PI * 6 + walker.phase)) * 0.0016 * at.scale;
      walkers[i].set(at.x, at.y + bob, at.scale * 0.72, walker.phase);
    });
  }
}

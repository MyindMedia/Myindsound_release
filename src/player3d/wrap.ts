import {
  CanvasTexture,
  DoubleSide,
  FrontSide,
  ExtrudeGeometry,
  SRGBColorSpace,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  MeshStandardMaterial,
  Path as ShapePath,
  PlaneGeometry,
  RepeatWrapping,
  Shape,
  Vector2,
  type Material,
  type Object3D,
  type Texture,
  type WebGLProgramParametersWithUniforms,
} from 'three';
import { phase, UNWRAP } from './wrap-math';

/**
 * The cartridge as it arrives: in a printed sleeve (the LIT poster, full bleed) inside clear shrink film.
 * Double-click and the film's front sheet curls off (a fold running across the face in the vertex shader),
 * what's left of the film shrivels away, and then the sleeve slides down off the disc.
 * Everything is a child of the cartridge, so it all turns with it.
 */

/** How far the sleeve stands off the cartridge, and the film off the sleeve (the film is shrunk on tight). */
const SLEEVE_GAP = 0.009;
const FILM_GAP = 0.0026;
/** Card thickness of the sleeve: enough to read as board, not paper. */
const CARD = 0.006;
/** Radius of the curl as the sheet rolls back. */
const CURL_RADIUS = 0.027;
/** The fold runs square to the top-right corner, straight across the face. */
const BASE_ANGLE = Math.PI / 4;

interface PeelUniforms {
  uFold: { value: number };
  uDir: { value: Vector2 };
  uRadius: { value: number };
  /** How far the rolled part is dragged off the package, out over the screen. */
  uDrag: { value: number };
}

/** Long, shallow creases: what catches the light on a shrink-wrapped box. */
function crinkleNormal(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const image = ctx.createImageData(size, size);
  const waves = Array.from({ length: 7 }, () => ({
    angle: Math.random() * Math.PI,
    frequency: 4 + Math.random() * 16,
    phase: Math.random() * Math.PI * 2,
    amplitude: 0.35 + Math.random() * 0.65,
  }));
  const height = (x: number, y: number): number => {
    let sum = 0;
    for (const wave of waves) {
      const along = (x * Math.cos(wave.angle) + y * Math.sin(wave.angle)) / size;
      sum += Math.sin(along * wave.frequency * Math.PI * 2 + wave.phase) * wave.amplitude;
    }
    return sum / waves.length;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = height(x + 1, y) - height(x - 1, y);
      const dy = height(x, y + 1) - height(x, y - 1);
      const index = (y * size + x) * 4;
      image.data[index] = Math.round((0.5 - dx * 2) * 255);
      image.data[index + 1] = Math.round((0.5 - dy * 2) * 255);
      image.data[index + 2] = 255;
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  const texture = new CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = RepeatWrapping;
  return texture;
}

/** Fills the panel with the poster without stretching it (the same idea as CSS `cover`). */
function coverFit(texture: Texture, panelAspect: number): void {
  const image = texture.image as { width?: number; height?: number } | null;
  const imageAspect = image?.width && image?.height ? image.width / image.height : 1;
  if (imageAspect > panelAspect) {
    const scale = panelAspect / imageAspect;
    texture.repeat.set(scale, 1);
    texture.offset.set((1 - scale) / 2, 0);
  } else {
    const scale = imageAspect / panelAspect;
    texture.repeat.set(1, scale);
    texture.offset.set(0, (1 - scale) / 2);
  }
  texture.needsUpdate = true;
}

/**
 * The back of the packaging, as a relic that has been sitting in a dead city for years: a printed back cover
 * faded almost out, stains, creases and scuffs, knocked corners, and film over it that has gone cloudy.
 */
const TRACKS: [string, string][] = [
  ['L.I.T. (LIVING IN TRUTH)', '3:12'],
  ['G. O. D.', '3:45'],
  ['VICTORY IN THE VALLEY', '2:38'],
  ['TIRED', '2:22'],
  ['LET HIM COOK', '2:19'],
  ['HE THE TRUTH', '3:03'],
  ['FAITH', '3:03'],
];

const MONO = "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Menlo, monospace";

/** The back of the sleeve: the tracklist, the imprint and a barcode, printed before it gets aged. */
function backCover(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#151119';
  ctx.fillRect(0, 0, size, size);

  const left = size * 0.11;
  const right = size * 0.89;
  const gold = '#fdb913';
  ctx.textBaseline = 'alphabetic';

  ctx.fillStyle = gold;
  ctx.font = `700 ${size * 0.085}px ${MONO}`;
  ctx.fillText('LIT', left, size * 0.15);
  ctx.fillStyle = 'rgba(245, 241, 230, 0.75)';
  ctx.font = `500 ${size * 0.027}px ${MONO}`;
  ctx.fillText('THA MYIND  ·  MYIND SOUND', left, size * 0.195);

  ctx.fillStyle = 'rgba(253, 185, 19, 0.5)';
  ctx.fillRect(left, size * 0.225, right - left, 2);

  TRACKS.forEach(([title, length], index) => {
    const y = size * 0.3 + index * size * 0.062;
    ctx.fillStyle = gold;
    ctx.font = `700 ${size * 0.028}px ${MONO}`;
    ctx.fillText(String(index + 1).padStart(2, '0'), left, y);
    ctx.fillStyle = 'rgba(245, 241, 230, 0.86)';
    ctx.font = `500 ${size * 0.03}px ${MONO}`;
    ctx.fillText(title, left + size * 0.075, y);
    ctx.fillStyle = 'rgba(245, 241, 230, 0.55)';
    ctx.font = `500 ${size * 0.026}px ${MONO}`;
    const width = ctx.measureText(length).width;
    ctx.fillText(length, right - width, y);
    ctx.fillStyle = 'rgba(245, 241, 230, 0.12)';
    ctx.fillRect(left, y + size * 0.014, right - left, 1);
  });

  ctx.fillStyle = 'rgba(245, 241, 230, 0.45)';
  ctx.font = `500 ${size * 0.021}px ${MONO}`;
  ctx.fillText('MINIDISC · 7 TRACKS · MS-LIT-001', left, size * 0.79);
  ctx.fillText('© MYIND SOUND. ALL RIGHTS RESERVED.', left, size * 0.83);
  ctx.fillText('MYINDSOUND.COM', left, size * 0.87);

  // Barcode.
  ctx.fillStyle = 'rgba(245, 241, 230, 0.82)';
  ctx.fillRect(right - size * 0.24, size * 0.78, size * 0.24, size * 0.1);
  ctx.fillStyle = '#151119';
  for (let bar = 0, x = right - size * 0.23; x < right - size * 0.012; bar++) {
    const width = size * (0.002 + (bar % 3) * 0.0015);
    ctx.fillRect(x, size * 0.79, width, size * 0.07);
    x += width + size * 0.0035;
  }
  ctx.fillStyle = 'rgba(21, 17, 25, 0.9)';
  ctx.font = `500 ${size * 0.016}px ${MONO}`;
  ctx.fillText('0 12345 67890 1', right - size * 0.225, size * 0.872);

  return canvas;
}

function weathered(kind: 'card' | 'film' | 'back'): CanvasTexture {
  const size = 512;
  const card = kind !== 'film';
  const canvas = kind === 'back' ? backCover(size) : document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  if (kind !== 'back') {
    canvas.width = canvas.height = size;
    ctx.fillStyle = card ? '#241d29' : '#e6e0d2';
    ctx.fillRect(0, 0, size, size);
  }

  // Damp blooms and stains.
  for (let i = 0; i < 30; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const r = size * (0.05 + Math.random() * 0.26);
    const blot = ctx.createRadialGradient(x, y, 0, x, y, r);
    const alpha = (card ? 0.22 : 0.3) * (0.35 + Math.random() * 0.65);
    blot.addColorStop(0, card ? `rgba(122, 96, 58, ${alpha})` : `rgba(158, 146, 104, ${alpha})`);
    blot.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = blot;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }

  // Creases: long pale lines where it has been folded and rubbed.
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const vertical = Math.random() < 0.5;
    const at = size * (0.15 + Math.random() * 0.7);
    ctx.strokeStyle = `rgba(232, 224, 205, ${0.08 + Math.random() * 0.1})`;
    ctx.lineWidth = 1 + Math.random() * 2.5;
    ctx.beginPath();
    ctx.moveTo(vertical ? at : 0, vertical ? 0 : at);
    ctx.lineTo(vertical ? at + (Math.random() - 0.5) * 40 : size, vertical ? size : at + (Math.random() - 0.5) * 40);
    ctx.stroke();
  }

  // Scuffs and scratches.
  for (let i = 0; i < 140; i++) {
    const x = Math.random() * size;
    const y = Math.random() * size;
    const length = size * (0.03 + Math.random() * 0.34);
    const angle = Math.random() * Math.PI;
    ctx.strokeStyle = `rgba(240, 233, 216, ${(card ? 0.16 : 0.26) * Math.random()})`;
    ctx.lineWidth = Math.random() * (card ? 2 : 2.6);
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x + Math.cos(angle) * length, y + Math.sin(angle) * length);
    ctx.stroke();
  }

  // Knocked corners and rubbed edges.
  const edge = ctx.createRadialGradient(size / 2, size / 2, size * 0.3, size / 2, size / 2, size * 0.75);
  edge.addColorStop(0, 'rgba(0, 0, 0, 0)');
  edge.addColorStop(1, card ? 'rgba(206, 190, 158, 0.34)' : 'rgba(255, 255, 255, 0.32)');
  ctx.fillStyle = edge;
  ctx.fillRect(0, 0, size, size);

  // Grain.
  const grain = ctx.getImageData(0, 0, size, size);
  for (let i = 0; i < grain.data.length; i += 4) {
    const noise = (Math.random() - 0.5) * (card ? 30 : 20);
    grain.data[i] += noise;
    grain.data[i + 1] += noise;
    grain.data[i + 2] += noise;
  }
  ctx.putImageData(grain, 0, 0);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Bends everything past the fold around a cylinder, so the sheet rolls back as the fold travels. */
function addPeel(material: Material, uniforms: PeelUniforms): void {
  material.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    shader.uniforms.uFold = uniforms.uFold;
    shader.uniforms.uDir = uniforms.uDir;
    shader.uniforms.uRadius = uniforms.uRadius;
    shader.uniforms.uDrag = uniforms.uDrag;
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
         uniform float uFold;
         uniform vec2 uDir;
         uniform float uRadius;
         uniform float uDrag;
         varying float vCurl;
         float peelCurl() {
           float past = dot(position.xy, uDir) - uFold;
           return past > 0.0 ? min(past / uRadius, 3.1415926 * 1.6) : -1.0;
         }`,
      )
      // The normal turns with the curl, so the rolled part catches the light like a tube.
      .replace(
        '#include <beginnormal_vertex>',
        `#include <beginnormal_vertex>
         float peelTheta = peelCurl();
         if (peelTheta >= 0.0) {
           objectNormal = normalize(vec3(-uDir * sin(peelTheta), cos(peelTheta)));
         }`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
         vCurl = peelTheta >= 0.0 ? clamp(peelTheta / 2.2, 0.0, 1.0) : 0.0;
         if (peelTheta >= 0.0) {
           float past = dot(position.xy, uDir) - uFold;
           vec2 base = position.xy - uDir * past;
           // The roll is dragged the way the peel runs, down towards the bottom-left corner, and out
           // towards the viewer, so it hangs over the screen instead of staying inside the sleeve.
           float hang = uDrag * smoothstep(0.0, 1.2, peelTheta);
           transformed.xy = base + uDir * (uRadius * sin(peelTheta) - hang * 0.45);
           // Mostly towards the viewer: the coil lifts off the sleeve instead of sliding across it.
           transformed.z = position.z + uRadius * (1.0 - cos(peelTheta)) + hang * 1.3;
         }`,
      );
    // The rolled lip catches the light, so you can see where the plastic has gone.
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n varying float vCurl;`)
      .replace(
        '#include <alphamap_fragment>',
        `#include <alphamap_fragment>
         diffuseColor.a = clamp(diffuseColor.a * (1.0 + 2.6 * vCurl), 0.0, 1.0);`,
      )
      .replace(
        '#include <emissivemap_fragment>',
        `#include <emissivemap_fragment>
         totalEmissiveRadiance += vec3(0.2) * vCurl;`,
      );
  };
  material.needsUpdate = true;
}

/** Extra printed faces of a sleeve; anything missing is derived from the poster, as LIT's is. */
export interface SleevePrints {
  /** The back of the sleeve (LIT's is the aged tracklist drawn here). */
  back?: Texture;
  /** The two spines (LIT's sample the cover's edges). */
  spineLeft?: Texture;
  spineRight?: Texture;
}

export interface WrapOptions {
  cartridge: Object3D;
  width: number;
  height: number;
  depth: number;
  poster: Texture;
  /** Off by default: a generated release's own back cover and spines (packages/minidisc). */
  prints?: SleevePrints;
  /** The shrink film itself: white with the crinkle in its alpha, and its relief as a normal map. */
  film: Texture | null;
  filmNormal: Texture | null;
  /**
   * App only (off by default): the printed card sleeve with no shrink film round it, for a copy that has already
   * been unwrapped once (RACK-3). `pullSleeve()` then slides the sleeve off without the peel.
   */
  sleeveOnly?: boolean;
  environment: Texture | null;
  /** The plastic is off and the sleeve is about to slide: time to square the disc up to the camera. */
  onSleeveStart(): void;
  /** The disc is clear of the wrapping. */
  onReveal(): void;
}

export class DiscWrap {
  readonly group = new Group();
  private readonly peelGroup = new Group();
  private readonly sleeve = new Group();
  private readonly filmMaterial: MeshPhysicalMaterial | null = null;
  private readonly sleeveMaterials: MeshStandardMaterial[] = [];
  private readonly skins: MeshPhysicalMaterial[] = [];
  private readonly textures: Texture[] = [];
  private readonly uniforms: PeelUniforms;
  private readonly extent: number;
  private readonly slideBy: number;
  private readonly exitBy: number;
  private readonly sleeveRest: number;
  private readonly dragBy: number;
  private readonly options: WrapOptions;
  private elapsed = -1;
  private revealed = false;
  private sleeveStarted = false;

  constructor(options: WrapOptions) {
    this.options = options;
    const { width, height, depth } = options;
    // Sleeve around the cartridge, then film around the sleeve.
    const sw = width + SLEEVE_GAP * 2;
    const sh = height + SLEEVE_GAP * 2;
    const sd = depth + SLEEVE_GAP * 2 + CARD * 2;
    const w = sw + FILM_GAP * 2;
    const h = sh + FILM_GAP * 2;
    const d = sd + FILM_GAP * 2;
    const front = d / 2;
    // Far enough that the sleeve and the plastic leave the screen instead of fading out on it.
    this.slideBy = height * 2.4;
    this.exitBy = height * 3.6;
    // The cartridge stands a little proud of the sleeve's mouth, so you can see what's inside it.
    this.sleeveRest = -height * 0.07;
    const crinkle = crinkleNormal();
    this.textures.push(crinkle, options.poster);

    // ── The sleeve: real card with thickness, wrapped right round the cartridge and open at the top ──
    coverFit(options.poster, sw / sh);
    const worn = weathered('card');
    worn.wrapS = worn.wrapT = RepeatWrapping;
    this.textures.push(worn);
    const card = (map: Texture | null): MeshStandardMaterial => {
      const material = new MeshStandardMaterial({
        map,
        color: map ? '#ffffff' : '#181320',
        roughness: 0.78,
        metalness: 0,
        envMap: options.environment,
        envMapIntensity: 0.2,
        side: DoubleSide,
      });
      this.sleeveMaterials.push(material);
      return material;
    };

    // Cross-section through the sleeve (width x depth), hollow where the cartridge sits, extruded up its
    // height: card walls all the way round, open at the top, closed at the foot.
    const mouth = (halfW: number, halfD: number, radius: number): Vector2[] => {
      const points: Vector2[] = [];
      const corners: [number, number][] = [
        [halfW - radius, halfD - radius],
        [-halfW + radius, halfD - radius],
        [-halfW + radius, -halfD + radius],
        [halfW - radius, -halfD + radius],
      ];
      corners.forEach(([cx, cz], corner) => {
        for (let step = 0; step <= 4; step++) {
          const angle = (corner * Math.PI) / 2 + (step / 4) * (Math.PI / 2);
          points.push(new Vector2(cx + Math.cos(angle) * radius, cz + Math.sin(angle) * radius));
        }
      });
      return points;
    };
    const outline = new Shape(mouth(sw / 2, sd / 2, CARD * 1.6));
    outline.holes.push(new ShapePath(mouth(sw / 2 - CARD, sd / 2 - CARD, CARD * 0.8).reverse()));
    const walls = new ExtrudeGeometry(outline, { depth: sh, bevelEnabled: false, curveSegments: 6 });
    walls.rotateX(-Math.PI / 2);
    walls.translate(0, -sh / 2, 0);
    const body = new Mesh(walls, card(worn));

    // The closed foot.
    const footShape = new Shape(mouth(sw / 2, sd / 2, CARD * 1.6));
    const footGeometry = new ExtrudeGeometry(footShape, { depth: CARD, bevelEnabled: false, curveSegments: 6 });
    footGeometry.rotateX(-Math.PI / 2);
    footGeometry.translate(0, -sh / 2, 0);
    const foot = new Mesh(footGeometry, card(worn));

    // What's printed on it: the cover, and a back that has seen better days.
    const printed = (map: Texture, z: number, turned: boolean): Mesh => {
      const mesh = new Mesh(new PlaneGeometry(sw, sh), card(map));
      mesh.position.z = z;
      if (turned) mesh.rotation.y = Math.PI;
      return mesh;
    };
    const cover = printed(options.poster, sd / 2 + 0.0004, false);
    const prints = options.prints ?? {};
    const backArt = prints.back ?? weathered('back');
    this.textures.push(backArt);
    const backPrint = printed(backArt, -sd / 2 - 0.0004, true);

    // The print carries on round the spine and the foot, the way a real sleeve is wrapped: each strip
    // samples the edge of the cover.
    const edge = (repeatX: number, repeatY: number, offsetX: number, offsetY: number): Texture => {
      const slice = options.poster.clone();
      slice.repeat.set(repeatX, repeatY);
      slice.offset.set(offsetX, offsetY);
      slice.needsUpdate = true;
      this.textures.push(slice);
      return slice;
    };
    const rim = 0.05;
    const spineLeft = new Mesh(new PlaneGeometry(sd, sh), card(prints.spineLeft ?? edge(rim, 1, 0, 0)));
    spineLeft.rotation.y = -Math.PI / 2;
    spineLeft.position.x = -sw / 2 - 0.0003;
    const spineRight = new Mesh(new PlaneGeometry(sd, sh), card(prints.spineRight ?? edge(rim, 1, 1 - rim, 0)));
    spineRight.rotation.y = Math.PI / 2;
    spineRight.position.x = sw / 2 + 0.0003;
    this.sleeve.add(body, foot, cover, backPrint, spineLeft, spineRight);
    this.sleeve.position.y = this.sleeveRest;

    // Peel direction: from the top-right corner down across the face.
    const direction = new Vector2(Math.cos(BASE_ANGLE), Math.sin(BASE_ANGLE));
    this.extent = (Math.abs(w * direction.x) + Math.abs(h * direction.y)) / 2;
    this.uniforms = {
      uFold: { value: this.extent + CURL_RADIUS },
      uDir: { value: direction },
      uRadius: { value: CURL_RADIUS },
      uDrag: { value: 0 },
    };
    // Just enough to lift the coil clear of the sleeve; the wrapper's exit does the travelling.
    this.dragBy = width * 0.14;
    const { film, filmNormal } = options;
    if (!options.sleeveOnly && film && filmNormal) {
      // Plastic over every face of the sleeve, from the supplied sheet: its crinkle is the alpha, its relief
      // the normal map. One layer per face, front-side only, so you never see the far side through the near one.
      const filmMaterial = new MeshPhysicalMaterial({
        map: film,
        // No alpha map: the sheet's crinkle is in its normal map. Used as alpha it punched holes through the
        // wrap, so the package looked half unwrapped before anyone touched it.
        color: '#c8ced8',
        transparent: true,
        opacity: 0.46,
        roughness: 0.1,
        metalness: 0,
        clearcoat: 0.9,
        clearcoatRoughness: 0.06,
        iridescence: 0.16,
        iridescenceIOR: 1.2,
        normalMap: filmNormal,
        normalScale: new Vector2(0.75, 0.75),
        envMap: options.environment,
        envMapIntensity: 0.45,
        side: DoubleSide, // You see the inside of the sheet once it rolls back.
        depthWrite: false,
      });
      this.filmMaterial = filmMaterial;

      /** The same film on another face, with its own slice of the sheet so the crinkle carries round. */
      const skin = (repeatX: number, repeatY: number, offsetX: number, offsetY: number): MeshPhysicalMaterial => {
        const material = filmMaterial.clone();
        material.side = FrontSide;
        // Seen edge-on, a sheet at the face's opacity disappears; these carry the wrap round the package.
        material.opacity = 0.6;
        material.clearcoat = 1;
        material.envMapIntensity = 0.7;
        const slice = film.clone();
        slice.repeat.set(repeatX, repeatY);
        slice.offset.set(offsetX, offsetY);
        slice.needsUpdate = true;
        material.map = slice;
        this.textures.push(slice);
        this.skins.push(material);
        return material;
      };

      addPeel(filmMaterial, this.uniforms);

      // Front of the film: the sheet that peels. Segmented, because the curl is per-vertex. Double-sided,
      // because you see the inside of it once it rolls back.
      filmMaterial.side = DoubleSide;
      const sheet = new Mesh(new PlaneGeometry(w, h, 64, 64), filmMaterial);
      sheet.position.z = front;
      this.peelGroup.add(sheet);

      // The rest of the skin: back and four sides, as one piece that shrivels off.
      // The back and the four sides, so the whole package is wrapped. They are part of the same wrapper, so
      // they travel with the sheet that peels. The rims take a wide slice of the sheet rather than a sliver,
      // or the edges of the package read as bare card next to the filmed face.
      const filmRim = 0.34;
      const filmBack = new Mesh(new PlaneGeometry(w, h), skin(1, 1, 0, 0));
      filmBack.position.z = -front;
      filmBack.rotation.y = Math.PI;
      // A little proud of the sleeve on every face, so the wrap has a lip to catch the light.
      const lip = 1.02;
      const filmTop = new Mesh(new PlaneGeometry(w * lip, d * lip), skin(1, filmRim, 0, 1 - filmRim));
      filmTop.rotation.x = -Math.PI / 2;
      filmTop.position.y = h / 2;
      const filmBottom = new Mesh(new PlaneGeometry(w * lip, d * lip), skin(1, filmRim, 0, 0));
      filmBottom.rotation.x = Math.PI / 2;
      filmBottom.position.y = -h / 2;
      const filmLeft = new Mesh(new PlaneGeometry(d * lip, h * lip), skin(filmRim, 1, 0, 0));
      filmLeft.rotation.y = -Math.PI / 2;
      filmLeft.position.x = -w / 2;
      const filmRight = new Mesh(new PlaneGeometry(d * lip, h * lip), skin(filmRim, 1, 1 - filmRim, 0));
      filmRight.rotation.y = Math.PI / 2;
      filmRight.position.x = w / 2;
      for (const piece of [filmBack, filmTop, filmBottom, filmLeft, filmRight]) {
        piece.renderOrder = 59;
        this.peelGroup.add(piece);
      }
      // renderOrder isn't inherited from a group: the film sorts itself after the sleeve.
      // After the sleeve and the inspector's dim plane (50), but still depth-tested, so the sleeve is never
      // see-through and the peeled plastic hangs clear of it on its own (see uDrag).
      sheet.renderOrder = 60;
    }

    this.group.add(this.sleeve, this.peelGroup);
    options.cartridge.add(this.group);
  }

  get unwrapping(): boolean {
    return this.elapsed >= 0;
  }

  /** Take it off. */
  start(): void {
    if (this.unwrapping) return;
    this.elapsed = 0;
  }

  /**
   * The sleeve beat alone (`sleeveOnly`): no film to peel, so the sleeve is tugged loose and pulled straight
   * down off the disc, as the second half of `start()` does. `onSleeveStart` fires at once.
   */
  pullSleeve(): void {
    if (this.unwrapping) return;
    this.peelGroup.visible = false;
    this.elapsed = UNWRAP.slide.at - 0.35;
  }

  /** Straight to bare disc, for reduced motion. */
  finish(): void {
    this.elapsed = UNWRAP.total;
    this.group.visible = false;
    if (!this.revealed) {
      this.revealed = true;
      this.options.onReveal();
    }
  }

  update(dt: number): void {
    if (!this.unwrapping || !this.group.visible) return;
    this.elapsed += dt;
    const t = this.elapsed;

    // The film tightens, then the fold runs across the face.
    const squeeze = phase(t, UNWRAP.squeeze.at, UNWRAP.squeeze.duration);
    const peel = phase(t, UNWRAP.peel.at, UNWRAP.peel.duration);
    const discard = phase(t, UNWRAP.discard.at, UNWRAP.discard.duration);
    const slide = phase(t, UNWRAP.slide.at, UNWRAP.slide.duration);

    // The film tightens on the sleeve before it gives.
    const tighten = 1 - 0.014 * Math.sin(squeeze * Math.PI);
    this.peelGroup.scale.setScalar(tighten);

    // One clean sweep across the face: no wobble, no wander. Sleeker than a hand-pulled sheet.
    const start = this.extent + CURL_RADIUS;
    const end = -this.extent - CURL_RADIUS * 2;
    this.uniforms.uFold.value = start + (end - start) * peel;
    this.uniforms.uDrag.value = peel * this.dragBy;

    // The sheet lifts off the face as it rolls, then the whole wrapper is thrown off the way the peel ran:
    // the fold sweeps towards the bottom-left corner, so the plastic carries on that way and out of shot.
    // It leaves the frame rather than fading, so nothing dissolves on screen.
    const direction = this.uniforms.uDir.value;
    const fall = discard * discard;
    this.peelGroup.position.set(
      -direction.x * discard * this.exitBy,
      -direction.y * discard * this.exitBy * 0.55 - fall * this.exitBy * 0.8,
      discard * 0.35 + peel * 0.012,
    );
    this.peelGroup.rotation.set(discard * 0.9, discard * 0.4, discard * 1.4);
    this.peelGroup.scale.setScalar(tighten * (1 - 0.35 * discard));
    // Nothing of the wrapper stays on screen once it has gone.
    if (discard >= 1) this.peelGroup.visible = false;

    // With the plastic off, the sleeve is tugged loose and then pulled away, leaving the disc where it was.
    if (!this.sleeveStarted && t >= UNWRAP.slide.at - 0.35) {
      this.sleeveStarted = true;
      this.options.onSleeveStart();
    }
    const tug = Math.sin(Math.min(1, slide * 5) * Math.PI) * this.slideBy * 0.03;
    const pull = slide * slide; // slow to let go, then away
    this.sleeve.position.set(pull * this.slideBy * 0.05, this.sleeveRest + tug - pull * this.slideBy, pull * 0.03);
    this.sleeve.rotation.set(-pull * 0.1, pull * 0.06, slide * 0.05);

    if (!this.revealed && t >= UNWRAP.revealAt) {
      this.revealed = true;
      this.options.onReveal();
    }
    if (t >= UNWRAP.total) this.group.visible = false;
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((node) => {
      if (node instanceof Mesh) node.geometry.dispose();
    });
    // The canvases and the sleeve art only ever belonged to the packaging.
    for (const texture of this.textures) texture.dispose();
    this.filmMaterial?.dispose();
    for (const material of this.skins) material.dispose();
    for (const material of this.sleeveMaterials) material.dispose();
  }
}

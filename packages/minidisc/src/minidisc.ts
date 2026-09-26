/**
 * `createMiniDisc`: a standalone generated MiniDisc (cartridge + printed card sleeve) from a `DiscDesign`,
 * for the preset gallery, the portal's live preview and the spin-loop renderer. The release bundle goes
 * through the deck instead (`cartridgeBuilder` + `sleevePrints`), so the same cartridge sits in LIT's player.
 */
import { Group, Texture, type Object3D } from 'three';
import { CART_BEVEL, CART_DEPTH, DISC_THICKNESS, DISC_TOP_Z, HUB_BASE_Z, HUB_TOP_Z, type CartridgeBuilder, type Rect } from '../../../src/player3d/deck';
import geometry from '../../../src/player3d/geometry.json';
import type { DetailQuality } from '../../../src/player3d/cartridge-detail';
import type { WearInput, WearZone } from '../../../src/player3d/wear-render';
import { DiscWrap, type SleevePrints } from '../../../src/player3d/wrap';
import { buildCartridge, type BuildOptions, type BuiltCartridge, type DesignArt } from './cartridge';
import { canvas, drawCover, srgbTexture } from './canvas';
import { designArtRefs, resolveTheme, type DiscDesign } from './design';
import { backCoverPrint, spinePrint } from './prints';

export type { DesignArt } from './cartridge';

/** Resolves an art reference against the design file's location (or the page). */
export function resolveArtUrl(ref: string, base?: string): string {
  return new URL(ref, base ?? document.baseURI).href;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`Art failed to load: ${url}`));
    image.src = url;
  });
}

export interface LoadedArt extends DesignArt {
  cover: HTMLImageElement;
  disc: HTMLImageElement;
  /** The backdrop image (the cover unless the theme names another). */
  backdrop: HTMLImageElement;
}

/** Loads every image the design refers to, relative to `base` (the design.json URL). */
export async function loadDesignArt(design: DiscDesign, base?: string): Promise<LoadedArt> {
  const theme = resolveTheme(design);
  const images = new Map<string, Promise<HTMLImageElement>>();
  for (const ref of designArtRefs(design)) images.set(ref, loadImage(resolveArtUrl(ref, base)));
  const get = (ref: string) => images.get(ref)!;
  const [cover, disc, backdrop] = await Promise.all([get(design.coverArt), get(design.discArt ?? design.coverArt), get(theme.backdrop.image)]);
  return { cover, disc, backdrop };
}

/** LIT's cartridge rectangle and disc, in the cartridge's own space (deck.ts `buildCartridge`). */
export function cartridgeLayout(): { rect: Rect; disc: { x: number; y: number }; width: number; height: number } {
  const cart = geometry.cartridge.rect;
  const cx = (cart.x0 + cart.x1) / 2;
  const cy = (cart.y0 + cart.y1) / 2;
  return {
    rect: { x0: cart.x0 - cx, y0: cart.y0 - cy, x1: cart.x1 - cx, y1: cart.y1 - cy },
    disc: { x: geometry.disc.center[0] - cx, y: geometry.disc.center[1] - cy },
    width: cart.x1 - cart.x0,
    height: cart.y1 - cart.y0,
  };
}

export interface MiniDiscOptions extends BuildOptions {
  environment?: Texture | null;
  /** Coarse-pointer devices get the low tier (BUN-0a). Default 'high'. */
  quality?: DetailQuality;
  /** Start in the printed card sleeve. Default true. */
  sleeve?: boolean;
  /** How far the sleeve sits down the cartridge, as a fraction of its height (0 = fully sleeved). Default 0. */
  sleeveDrop?: number;
  wearSafeZones?: readonly WearZone[];
}

export interface MiniDisc {
  /** The cartridge, with the sleeve as a child when it's on. Put this in a scene. */
  readonly group: Group;
  readonly cartridge: Group;
  readonly width: number;
  readonly height: number;
  readonly depth: number;
  readonly built: BuiltCartridge;
  /** Target disc speed, in revolutions per second (LIT plays at about 3.3). Eased, as the deck does. */
  spin(rate: number): void;
  /** Advance the spin (and the sleeve, when it's sliding). */
  update(dt: number): void;
  setWear(descriptor: WearInput | null): void;
  setEdition(edition: number | null): void;
  /** Put the sleeve on or take it off; `drop` slides it down the cartridge (fraction of the height). */
  setSleeve(on: boolean, drop?: number): void;
  dispose(): void;
}

const SPIN_RESPONSE = 3;

/** The sleeve's printed faces from the design: the cover, and the generated back and spines. */
export function makeSleevePrints(design: DiscDesign, art: DesignArt, options: { quality?: DetailQuality; anisotropy?: number } = {}): {
  poster: Texture;
  prints: SleevePrints;
} {
  const size = options.quality === 'low' ? 1024 : 2048;
  const anisotropy = options.anisotropy ?? 4;
  const [cover, ctx] = canvas(size);
  drawCover(ctx, art.cover, 0, 0, size, size);
  const layout = cartridgeLayout();
  // wrap.ts: the sleeve stands SLEEVE_GAP (0.009) off the cartridge and its card is 0.006 thick.
  const sleeveDepth = CART_DEPTH + 0.009 * 2 + 0.006 * 2;
  const sleeveHeight = layout.height + 0.009 * 2;
  return {
    poster: srgbTexture(cover, anisotropy),
    prints: {
      back: srgbTexture(backCoverPrint(design, size / 2), anisotropy),
      spineLeft: srgbTexture(spinePrint(design, sleeveDepth, sleeveHeight, 'left'), anisotropy),
      spineRight: srgbTexture(spinePrint(design, sleeveDepth, sleeveHeight, 'right'), anisotropy),
    },
  };
}

/** A deck `CartridgeBuilder` for this design: the release bundle passes it to `PlayerApp`. */
export function cartridgeBuilder(design: DiscDesign, art: DesignArt, options: BuildOptions, onBuilt: (built: BuiltCartridge) => void): CartridgeBuilder {
  return (input) => {
    const built = buildCartridge(design, art, input, options);
    onBuilt(built);
    return built;
  };
}

export function createMiniDisc(design: DiscDesign, art: DesignArt, options: MiniDiscOptions = {}): MiniDisc {
  const layout = cartridgeLayout();
  const quality = options.quality ?? 'high';
  const environment = options.environment ?? null;
  const group = new Group();
  const cartridge = new Group();
  cartridge.name = 'cartridge';
  const built = buildCartridge(
    design,
    art,
    {
      cartridge,
      rect: layout.rect,
      disc: {
        x: layout.disc.x,
        y: layout.disc.y,
        radius: geometry.disc.radius,
        topZ: DISC_TOP_Z,
        thickness: DISC_THICKNESS,
        hub: geometry.disc.hub,
        hubBaseZ: HUB_BASE_Z,
        hubTopZ: HUB_TOP_Z,
      },
      depth: CART_DEPTH,
      bevel: CART_BEVEL,
      environment,
      quality,
    },
    { transmission: options.transmission, wearSafeZones: options.wearSafeZones, anisotropy: options.anisotropy },
  );
  group.add(cartridge);

  let wrap: DiscWrap | null = null;
  let sleeveTextures: Texture[] = [];
  const spinning: Object3D[] = built.spinning;
  let rate = 0;
  let target = 0;

  const setSleeve = (on: boolean, drop = 0) => {
    if (!on) {
      wrap?.dispose();
      wrap = null;
      for (const t of sleeveTextures) t.dispose();
      sleeveTextures = [];
      return;
    }
    if (!wrap) {
      const sleeve = makeSleevePrints(design, art, { quality, anisotropy: options.anisotropy });
      sleeveTextures = [sleeve.poster, ...Object.values(sleeve.prints).filter((t): t is Texture => t instanceof Texture)];
      wrap = new DiscWrap({
        cartridge,
        width: layout.width,
        height: layout.height,
        depth: CART_DEPTH,
        poster: sleeve.poster,
        prints: sleeve.prints,
        film: null,
        filmNormal: null,
        sleeveOnly: true,
        environment,
        onSleeveStart: () => {},
        onReveal: () => {},
      });
    }
    wrap.group.position.y = -drop * layout.height;
  };
  if (options.sleeve ?? true) setSleeve(true, options.sleeveDrop ?? 0);

  return {
    group,
    cartridge,
    width: layout.width,
    height: layout.height,
    depth: CART_DEPTH,
    built,
    spin: (rps) => {
      target = rps;
    },
    update(dt) {
      rate += (target - rate) * (1 - Math.exp(-dt * SPIN_RESPONSE));
      const angle = rate * Math.PI * 2 * dt;
      for (const object of spinning) object.rotation.z -= angle;
      wrap?.update(dt);
    },
    setWear: (d) => built.setWear(d),
    setEdition: (n) => built.setEdition(n),
    setSleeve,
    dispose() {
      setSleeve(false);
      built.dispose();
      group.removeFromParent();
    },
  };
}

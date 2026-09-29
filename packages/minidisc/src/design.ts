/**
 * `DiscDesign` v1: everything the MiniDisc generator needs to build one release's cartridge, disc and printed
 * sleeve (Grilled.md "Release portal + generated discs"). The admin portal writes it, the backend stores it,
 * and the generic release bundle (`bundles/release`) renders it. The JSON Schema in `../schema/` is the same
 * contract for other languages; `validateDesign` is the TypeScript check, dependency free so Node scripts
 * (`scripts/build-bundle.mjs`) can import it directly.
 */

export const DISC_DESIGN_VERSION = 1;

/** The shell presets, taken from the design catalogue's references (internal look-dev only). */
export const SHELL_PRESET_IDS = [
  'smoke-black',
  'clear',
  'clear-pink',
  'purple',
  'blue',
  'red',
  'smoke-gold',
  'jet-black',
  'frost',
  'slate',
  'ice-blue',
  'green',
  'lime',
  'orange',
  'rose',
  'lavender',
] as const;
export type ShellPresetId = (typeof SHELL_PRESET_IDS)[number];

/**
 * The slide cover on the shell's left side, which carries the label. `metal`: brushed steel (refs 18, 19, 30).
 * `metal-dark`: black anodised steel (17, 24). `tinted`: frosted plastic in the shell's own colour (26, 32, 33).
 * `sticker`: a printed paper label on the plate (20, 23). `none`: the bare shell.
 */
export const LABEL_STYLES = ['metal', 'metal-dark', 'tinted', 'sticker', 'none'] as const;
export type LabelStyle = (typeof LABEL_STYLES)[number];

/**
 * The spinning disc. `print`: the cover art edge to edge. `gold` / `silver`: a metal pressing tinted by the art
 * (18, 30). `vinyl`: black grooved disc with the art as a centre label (12, 14, 24). `rainbow`: silver data side
 * with the diffraction bands, the art faint over it (15, 26, 34).
 */
export const DISC_FINISHES = ['print', 'gold', 'silver', 'vinyl', 'rainbow'] as const;
export type DiscFinish = (typeof DISC_FINISHES)[number];

/**
 * How much of the shell is see-through over the disc. `auto` (default): a clear window over the disc whenever the
 * disc carries art (every generated release does), so the printed disc is plainly visible and spinning (refs 03,
 * 08); the rest of the shell keeps the preset's tint. `tinted`: the preset's plastic over the disc too. `opaque`:
 * a solid shell that hides the disc (ref 10, a blank disc).
 */
export const SHELL_WINDOWS = ['auto', 'clear', 'tinted', 'opaque'] as const;
export type ShellWindow = (typeof SHELL_WINDOWS)[number];

export const STICKER_KINDS = ['text', 'advisory', 'badge'] as const;
export type StickerKind = (typeof STICKER_KINDS)[number];

export interface DiscTrack {
  /** 1-based position. */
  n: number;
  title: string;
  durationSec: number;
}

/** A small extra label on the shell, placed in shell UV space (origin top left, sizes as fractions of the width). */
export interface PrintedSticker {
  kind: StickerKind;
  /** `text` and `badge`: what it says (`advisory` has fixed wording). */
  text?: string;
  x: number;
  y: number;
  w: number;
  /** Degrees, -45..45. */
  rotation?: number;
  /** `#RRGGBB` fill and ink; defaults come from the design's accents. */
  fill?: string;
  ink?: string;
}

/** The slide cover's uploaded label: centre and width as fractions of the label area, like an image sticker. */
export interface LabelImage {
  /** PNG, JPEG or WebP: relative to the design file, or absolute. */
  src: string;
  x: number;
  y: number;
  /** 0.05..1 of the label area's width. */
  size: number;
  /** Degrees, -180..180. */
  rotation?: number;
}

/**
 * Built-in stickers, drawn in code (no upload): an image sticker's `src` is `preset:<id>`. `emoji:<emoji>` draws
 * any emoji the same way.
 */
export const STICKER_PRESETS = [
  { id: 'advisory', title: 'Parental Advisory' },
  { id: 'hot', title: 'HOT' },
  { id: 'new', title: 'NEW' },
  { id: 'limited', title: 'Limited Edition' },
  { id: 'exclusive', title: 'Exclusive' },
  { id: 'bonus', title: 'Bonus Track' },
  { id: 'remastered', title: 'Remastered' },
  { id: 'fire', title: 'Fire' },
  { id: 'heart', title: 'Heart' },
  { id: 'star', title: 'Gold Star' },
  { id: 'smiley', title: 'Smiley' },
  { id: 'lightning', title: 'Lightning' },
] as const;
export type StickerPresetId = (typeof STICKER_PRESETS)[number]['id'];

/** Whether an art reference is drawn in code (a built-in or an emoji) rather than a file to load and ship. */
export function isDrawnArt(ref: string): boolean {
  return ref.startsWith('preset:') || ref.startsWith('emoji:');
}

/** The slide cover's colour, whole: `slideColor`, else what the older label styles implied, else steel. */
export function resolveSlideColor(design: Pick<DiscDesign, 'slideColor' | 'labelStyle' | 'shell' | 'shellTint'>, shellGel?: string): string {
  if (design.slideColor) return design.slideColor;
  if (design.labelStyle === 'metal-dark') return '#2b2d33';
  if (design.labelStyle === 'tinted' && shellGel) return shellGel;
  return '#8b9097';
}

/** Where an image sticker goes: on the metal slide cover (it rides with it), or anywhere on the plastic shell. */
export const STICKER_AREAS = ['shutter', 'shell'] as const;
export type StickerArea = (typeof STICKER_AREAS)[number];
/** At most this many image stickers on the slide cover. */
export const MAX_SHUTTER_STICKERS = 4;

/**
 * An uploaded image stuck on the cartridge: any shape (a PNG keeps its alpha), always kept inside its area. Placed by
 * its centre, as fractions of the area (origin top left); `size` is its width as a fraction of the area's width.
 */
export interface ImageSticker {
  kind: 'image';
  /** PNG, JPEG or WebP: relative to the design file, or absolute. */
  src: string;
  area: StickerArea;
  x: number;
  y: number;
  /** 0.05..1 of the area's width. */
  size: number;
  /** Degrees, -180..180. */
  rotation?: number;
}

export type DiscSticker = PrintedSticker | ImageSticker;

/** The design's image stickers, in order. */
export function imageStickers(design: DiscDesign): ImageSticker[] {
  return (design.stickers ?? []).filter((sticker): sticker is ImageSticker => sticker.kind === 'image');
}

/** The design's printed stickers (text, advisory, badge), in order. */
export function printedStickers(design: DiscDesign): PrintedSticker[] {
  return (design.stickers ?? []).filter((sticker): sticker is PrintedSticker => sticker.kind !== 'image');
}

/** The player's backdrop behind the deck: the cover art, blurred and dimmed, unless another image is given. */
export interface DiscBackdrop {
  /** Relative to the design file, or absolute. Defaults to `coverArt`. */
  image?: string;
  /** Blur at phone width, in CSS pixels. Default 12. */
  blurPx?: number;
  /** How much ink is laid over the art, 0..1. Default 0.62 (keeps HUD text at 4.5:1 on any art). */
  scrim?: number;
}

/** PRD §4A.8 per-release theme, plus the backdrop. */
export interface DiscTheme {
  accent?: string;
  accent2?: string;
  lcdTint?: string;
  /** The app's `products.theme.backdropImage`; `backdrop.image` wins when both are set. */
  backdropImage?: string;
  backdrop?: DiscBackdrop;
}

export interface DiscDesign {
  v: 1;
  /** Release slug (`^[a-z0-9][a-z0-9-]{0,63}$`); names the bundle zip. */
  slug: string;
  title: string;
  artist: string;
  year: number;
  tracks: DiscTrack[];
  /** Cover art: relative to the design file, or absolute. Square, 1024 px or more. */
  coverArt: string;
  /** Art printed on the disc; defaults to the cover. */
  discArt?: string;
  shell: ShellPresetId;
  /** `#RRGGBB`: recolours the preset's plastic. */
  shellTint?: string;
  /** See `SHELL_WINDOWS`. Default `auto`. */
  shellWindow?: ShellWindow;
  labelStyle: LabelStyle;
  /** Printed on the label plate; defaults to the title (line 1) and artist (line 2). */
  labelText?: string;
  /**
   * The whole metal slide cover's colour (`#RRGGBB`): front, fold, back leaf and spine, anodised over the brushed
   * steel. Default: steel (or, for the older label styles, black for `metal-dark` and the shell's colour for
   * `tinted`). The label and the stickers are separate layers on top of it.
   */
  slideColor?: string;
  /**
   * An uploaded image as the slide cover's label, its own layer between the slide and the stickers, placed and
   * sized within the label area. When set, the printed label (`labelStyle`) is not drawn.
   */
  labelImage?: LabelImage;
  /** `#RRGGBB` accents for the prints; default gold and cream. */
  accent?: string;
  accent2?: string;
  /** Defaults to the preset's (gold on `smoke-gold`, print otherwise). */
  discFinish?: DiscFinish;
  stickers?: DiscSticker[];
  theme?: DiscTheme;
}

export const DEFAULT_ACCENT = '#FDB913';
export const DEFAULT_ACCENT2 = '#F5F1E6';
export const DEFAULT_BLUR_PX = 12;
export const DEFAULT_SCRIM = 0.62;
export const MAX_TRACKS = 40;
export const MAX_STICKERS = 8;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const HEX_COLOUR = /^#[0-9a-fA-F]{6}$/;

export type ValidationResult = { ok: true; design: DiscDesign } | { ok: false; errors: string[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isFinite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Checks a parsed JSON value against the v1 contract. Every problem is reported (not just the first), each as
 * `path: what is wrong`, so the portal can show them next to the fields.
 */
export function validateDesign(value: unknown): ValidationResult {
  const errors: string[] = [];
  const fail = (path: string, what: string) => errors.push(`${path}: ${what}`);
  if (!isRecord(value)) return { ok: false, errors: ['design: must be an object'] };
  const d = value;

  if (d.v !== DISC_DESIGN_VERSION) fail('v', `must be ${DISC_DESIGN_VERSION}`);
  if (typeof d.slug !== 'string' || !SLUG_PATTERN.test(d.slug)) fail('slug', 'must match ^[a-z0-9][a-z0-9-]{0,63}$');
  for (const key of ['title', 'artist'] as const) {
    const text = d[key];
    if (typeof text !== 'string' || text.trim().length === 0) fail(key, 'must be a non-empty string');
    else if (text.length > 80) fail(key, 'must be 80 characters or fewer');
  }
  if (!isInt(d.year) || d.year < 1900 || d.year > 2100) fail('year', 'must be an integer year (1900..2100)');

  if (!Array.isArray(d.tracks) || d.tracks.length === 0) fail('tracks', 'must be a non-empty array');
  else if (d.tracks.length > MAX_TRACKS) fail('tracks', `must have ${MAX_TRACKS} entries or fewer`);
  else {
    const seen = new Set<number>();
    d.tracks.forEach((track, i) => {
      const path = `tracks[${i}]`;
      if (!isRecord(track)) return fail(path, 'must be an object');
      if (!isInt(track.n) || track.n < 1) fail(`${path}.n`, 'must be a positive integer');
      else if (seen.has(track.n)) fail(`${path}.n`, `duplicate position ${track.n}`);
      else seen.add(track.n);
      if (typeof track.title !== 'string' || track.title.trim().length === 0) fail(`${path}.title`, 'must be a non-empty string');
      else if (track.title.length > 120) fail(`${path}.title`, 'must be 120 characters or fewer');
      if (!isFinite(track.durationSec) || track.durationSec < 0) fail(`${path}.durationSec`, 'must be a number >= 0');
    });
  }

  const path = (key: string, allowEmpty = false) => {
    const text = d[key];
    if (text === undefined && allowEmpty) return;
    if (typeof text !== 'string' || text.trim().length === 0) fail(key, 'must be a non-empty path or URL');
  };
  path('coverArt');
  path('discArt', true);
  if (d.labelImage !== undefined) {
    const label = d.labelImage as Record<string, unknown>;
    if (!isRecord(label)) fail('labelImage', 'must be an object');
    else {
      if (typeof label.src !== 'string' || label.src.trim().length === 0) fail('labelImage.src', 'must be a non-empty path or URL');
      for (const key of ['x', 'y'] as const) {
        const n = label[key] as number;
        if (!isFinite(n) || n < 0 || n > 1) fail(`labelImage.${key}`, 'must be a number in 0..1');
      }
      const size = label.size as number;
      if (!isFinite(size) || size < 0.05 || size > 1) fail('labelImage.size', 'must be a number in 0.05..1');
      const rotation = label.rotation as number | undefined;
      if (rotation !== undefined && (!isFinite(rotation) || Math.abs(rotation) > 180)) fail('labelImage.rotation', 'must be a number in -180..180');
    }
  }

  if (typeof d.shell !== 'string' || !(SHELL_PRESET_IDS as readonly string[]).includes(d.shell)) {
    fail('shell', `must be one of ${SHELL_PRESET_IDS.join(', ')}`);
  }
  if (typeof d.labelStyle !== 'string' || !(LABEL_STYLES as readonly string[]).includes(d.labelStyle)) {
    fail('labelStyle', `must be one of ${LABEL_STYLES.join(', ')}`);
  }
  if (d.shellWindow !== undefined && !(SHELL_WINDOWS as readonly unknown[]).includes(d.shellWindow)) {
    fail('shellWindow', `must be one of ${SHELL_WINDOWS.join(', ')}`);
  }
  if (d.labelText !== undefined && (typeof d.labelText !== 'string' || d.labelText.length > 160)) {
    fail('labelText', 'must be a string of 160 characters or fewer');
  }
  if (d.discFinish !== undefined && !(DISC_FINISHES as readonly unknown[]).includes(d.discFinish)) {
    fail('discFinish', `must be one of ${DISC_FINISHES.join(', ')}`);
  }
  const colour = (key: string, holder: Record<string, unknown>, prefix = '') => {
    const text = holder[key];
    if (text === undefined) return;
    if (typeof text !== 'string' || !HEX_COLOUR.test(text)) fail(`${prefix}${key}`, 'must be a #RRGGBB colour');
  };
  colour('shellTint', d);
  colour('accent', d);
  colour('accent2', d);
  colour('slideColor', d);

  if (d.stickers !== undefined) {
    if (!Array.isArray(d.stickers)) fail('stickers', 'must be an array');
    else if (d.stickers.length > MAX_STICKERS) fail('stickers', `must have ${MAX_STICKERS} entries or fewer`);
    else if (d.stickers.filter((s) => (s as ImageSticker).kind === 'image' && (s as ImageSticker).area === 'shutter').length > MAX_SHUTTER_STICKERS) {
      fail('stickers', `must have ${MAX_SHUTTER_STICKERS} image stickers or fewer on the slide cover`);
    }
    else {
      d.stickers.forEach((raw, i) => {
        const at = `stickers[${i}]`;
        if (!isRecord(raw)) return fail(at, 'must be an object');
        if (raw.kind === 'image') {
          const sticker = raw as unknown as ImageSticker;
          if (typeof sticker.src !== 'string' || sticker.src.trim().length === 0) fail(`${at}.src`, 'must be a non-empty path or URL');
          if (!(STICKER_AREAS as readonly unknown[]).includes(sticker.area)) fail(`${at}.area`, `must be one of ${STICKER_AREAS.join(', ')}`);
          for (const key of ['x', 'y'] as const) {
            const n = sticker[key];
            if (!isFinite(n) || n < 0 || n > 1) fail(`${at}.${key}`, 'must be a number in 0..1');
          }
          if (!isFinite(sticker.size) || sticker.size < 0.05 || sticker.size > 1) fail(`${at}.size`, 'must be a number in 0.05..1');
          if (sticker.rotation !== undefined && (!isFinite(sticker.rotation) || Math.abs(sticker.rotation) > 180)) {
            fail(`${at}.rotation`, 'must be a number in -180..180');
          }
          return;
        }
        const sticker = raw;
        if (!(STICKER_KINDS as readonly unknown[]).includes(sticker.kind)) fail(`${at}.kind`, `must be one of ${STICKER_KINDS.join(', ')}`);
        if (sticker.text !== undefined && (typeof sticker.text !== 'string' || sticker.text.length > 40)) {
          fail(`${at}.text`, 'must be a string of 40 characters or fewer');
        }
        for (const key of ['x', 'y', 'w'] as const) {
          const n = sticker[key];
          if (!isFinite(n) || n < 0 || n > 1) fail(`${at}.${key}`, 'must be a number in 0..1');
        }
        if (isFinite(sticker.w) && sticker.w < 0.04) fail(`${at}.w`, 'must be at least 0.04');
        if (sticker.rotation !== undefined && (!isFinite(sticker.rotation) || Math.abs(sticker.rotation) > 45)) {
          fail(`${at}.rotation`, 'must be a number in -45..45');
        }
        colour('fill', sticker, `${at}.`);
        colour('ink', sticker, `${at}.`);
      });
    }
  }

  if (d.theme !== undefined) {
    if (!isRecord(d.theme)) fail('theme', 'must be an object');
    else {
      const theme = d.theme;
      colour('accent', theme, 'theme.');
      colour('accent2', theme, 'theme.');
      colour('lcdTint', theme, 'theme.');
      if (theme.backdropImage !== undefined && (typeof theme.backdropImage !== 'string' || theme.backdropImage.length === 0)) {
        fail('theme.backdropImage', 'must be a non-empty path or URL');
      }
      if (theme.backdrop !== undefined) {
        if (!isRecord(theme.backdrop)) fail('theme.backdrop', 'must be an object');
        else {
          const b = theme.backdrop;
          if (b.image !== undefined && (typeof b.image !== 'string' || b.image.length === 0)) fail('theme.backdrop.image', 'must be a non-empty path or URL');
          if (b.blurPx !== undefined && (!isFinite(b.blurPx) || b.blurPx < 0 || b.blurPx > 64)) fail('theme.backdrop.blurPx', 'must be a number in 0..64');
          if (b.scrim !== undefined && (!isFinite(b.scrim) || b.scrim < 0 || b.scrim > 1)) fail('theme.backdrop.scrim', 'must be a number in 0..1');
        }
      }
    }
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, design: d as unknown as DiscDesign };
}

/** `validateDesign`, throwing on the first failure with every error in the message. */
export function assertDesign(value: unknown): DiscDesign {
  const result = validateDesign(value);
  if (!result.ok) throw new Error(`Invalid DiscDesign:\n  ${result.errors.join('\n  ')}`);
  return result.design;
}

/** The design's theme with every default filled in, as the release bundle and the app read it. */
export interface ResolvedTheme {
  accent: string;
  accent2: string;
  lcdTint: string | null;
  backdrop: { image: string; blurPx: number; scrim: number };
}

export function resolveTheme(design: DiscDesign): ResolvedTheme {
  const theme = design.theme ?? {};
  const backdrop = theme.backdrop ?? {};
  return {
    accent: theme.accent ?? design.accent ?? DEFAULT_ACCENT,
    accent2: theme.accent2 ?? design.accent2 ?? DEFAULT_ACCENT2,
    lcdTint: theme.lcdTint ?? null,
    backdrop: {
      image: backdrop.image ?? theme.backdropImage ?? design.coverArt,
      blurPx: backdrop.blurPx ?? DEFAULT_BLUR_PX,
      scrim: backdrop.scrim ?? DEFAULT_SCRIM,
    },
  };
}

/** Whether the disc carries art (a generated release always does: `coverArt` is required, and the disc prints it). */
export function discHasArt(design: DiscDesign): boolean {
  return Boolean(design.discArt ?? design.coverArt);
}

/** The window rule, derived: clear over a disc with art unless the design asks for the tint or a solid shell. */
export function resolveShellWindow(design: DiscDesign): Exclude<ShellWindow, 'auto'> {
  const asked = design.shellWindow ?? 'auto';
  if (asked !== 'auto') return asked;
  return discHasArt(design) ? 'clear' : 'opaque';
}

/** Every art file a design refers to, deduplicated, as written (relative paths are relative to the design file). */
export function designArtRefs(design: DiscDesign): string[] {
  const theme = resolveTheme(design);
  const refs = [
    design.coverArt,
    design.discArt ?? design.coverArt,
    theme.backdrop.image,
    ...(design.labelImage ? [design.labelImage.src] : []),
    ...imageStickers(design).map((sticker) => sticker.src),
  ].filter((ref) => !isDrawnArt(ref));
  return [...new Set(refs)];
}

/** `m:ss` for the sleeve's tracklist. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** The catalogue number printed on the back: `MS-<SLUG>-<year>`. */
export function catalogueNumber(design: DiscDesign): string {
  return `MS-${design.slug.toUpperCase().replace(/[^A-Z0-9]+/g, '')}-${String(design.year).slice(-2).padStart(2, '0')}`;
}

/**
 * Where an image sticker lands in its area (world units): `size` of the area's width, the art's own aspect, shrunk
 * until its rotated bounds fit, and its centre moved in just far enough to keep the whole sticker inside the area.
 */
export function placeImageSticker(
  sticker: Pick<ImageSticker, 'x' | 'y' | 'size' | 'rotation'>,
  area: { x0: number; y0: number; x1: number; y1: number },
  art: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const areaW = area.x1 - area.x0;
  const areaH = area.y1 - area.y0;
  let width = Math.max(0.05, Math.min(1, sticker.size)) * areaW;
  let height = (width * art.height) / Math.max(1, art.width);
  const angle = ((sticker.rotation ?? 0) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(angle));
  const sin = Math.abs(Math.sin(angle));
  const boundsW = cos * width + sin * height;
  const boundsH = sin * width + cos * height;
  const fit = Math.min(1, areaW / boundsW, areaH / boundsH);
  width *= fit;
  height *= fit;
  const halfW = (boundsW * fit) / 2;
  const halfH = (boundsH * fit) / 2;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
  return {
    x: clamp(area.x0 + sticker.x * areaW, area.x0 + halfW, area.x1 - halfW),
    y: clamp(area.y1 - sticker.y * areaH, area.y0 + halfH, area.y1 - halfH),
    width,
    height,
  };
}

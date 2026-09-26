/**
 * `DiscDesign` v1: everything the MiniDisc generator needs to build one release's cartridge, disc and printed
 * sleeve (Grilled.md "Release portal + generated discs"). The admin portal writes it, the backend stores it,
 * and the generic release bundle (`bundles/release`) renders it. The JSON Schema in `../schema/` is the same
 * contract for other languages; `validateDesign` is the TypeScript check, dependency free so Node scripts
 * (`scripts/build-bundle.mjs`) can import it directly.
 */

export const DISC_DESIGN_VERSION = 1;

/** The shell presets, taken from the design catalogue's references (internal look-dev only). */
export const SHELL_PRESET_IDS = ['smoke-black', 'clear', 'clear-pink', 'purple', 'blue', 'red', 'smoke-gold'] as const;
export type ShellPresetId = (typeof SHELL_PRESET_IDS)[number];

export const LABEL_STYLES = ['metal', 'sticker', 'none'] as const;
export type LabelStyle = (typeof LABEL_STYLES)[number];

export const DISC_FINISHES = ['print', 'gold', 'silver'] as const;
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
export interface DiscSticker {
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

  if (d.stickers !== undefined) {
    if (!Array.isArray(d.stickers)) fail('stickers', 'must be an array');
    else if (d.stickers.length > MAX_STICKERS) fail('stickers', `must have ${MAX_STICKERS} entries or fewer`);
    else {
      d.stickers.forEach((sticker, i) => {
        const at = `stickers[${i}]`;
        if (!isRecord(sticker)) return fail(at, 'must be an object');
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
  const refs = [design.coverArt, design.discArt ?? design.coverArt, theme.backdrop.image];
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

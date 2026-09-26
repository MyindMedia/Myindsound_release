/**
 * Release portal rules (Grilled.md "Release portal + generated discs", PRD §17 ADM-7), pure so `releases.test.ts`
 * covers them without a deployment: what an uploaded file may be (sniffed from its first bytes, never trusted from
 * the browser's content type), the DiscDesign the server stores (the portal picks the look, the server owns the
 * facts: slug, title, artist, year, tracklist, cover), the design hash that ties the rack art and the bundle to the
 * design they were made from, and the publish preconditions.
 */
import { validateDesign, type DiscDesign, type ValidationResult } from '../packages/minidisc/src/design';

export const MB = 1024 * 1024;

/** What each upload is for. Each has its own sniffed formats and size cap. */
export type UploadPurpose = 'audio' | 'cover' | 'spriteWebp' | 'spritePng' | 'still' | 'bundle';
export type FileKind = 'mp3' | 'png' | 'jpeg' | 'webp' | 'zip';

export const UPLOAD_RULES: Record<UploadPurpose, { kinds: FileKind[]; maxBytes: number; label: string; headBytes: number }> = {
  // 320 kbps for 30 minutes is about 69 MB.
  audio: { kinds: ['mp3'], maxBytes: 80 * MB, label: 'MP3', headBytes: 16 },
  // JPEG keeps its size in a frame header that can sit after the EXIF block, so read further for images.
  cover: { kinds: ['png', 'jpeg', 'webp'], maxBytes: 25 * MB, label: 'PNG, JPEG or WebP image', headBytes: 512 * 1024 },
  spriteWebp: { kinds: ['webp'], maxBytes: 40 * MB, label: 'WebP sprite sheet', headBytes: 64 },
  spritePng: { kinds: ['png'], maxBytes: 60 * MB, label: 'PNG sprite sheet', headBytes: 64 },
  still: { kinds: ['png'], maxBytes: 15 * MB, label: 'PNG still', headBytes: 64 },
  // NAT-5: bundle CI fails over 40 MB.
  bundle: { kinds: ['zip'], maxBytes: 40 * MB, label: 'zip', headBytes: 16 },
};

/** Content types a browser or script may have sent for each kind (checked when present; the bytes decide). */
const CONTENT_TYPES: Record<FileKind, string[]> = {
  mp3: ['audio/mpeg', 'audio/mp3', 'audio/mpeg3', 'audio/x-mpeg-3'],
  png: ['image/png'],
  jpeg: ['image/jpeg', 'image/jpg', 'image/pjpeg'],
  webp: ['image/webp'],
  zip: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'],
};

/** The cover must be square (to 1%) and at least this big: `validateDesign`'s contract. The portal warns below 1500. */
export const MIN_COVER_PX = 1024;
export const RECOMMENDED_COVER_PX = 1500;
export const MAX_TRACKS = 40;
export const MAX_TITLE = 80;
export const MAX_TRACK_TITLE = 120;
/** No MP3 runs longer than this (seconds); longer is a parse error on the client. */
export const MAX_DURATION_SEC = 2 * 60 * 60;
/** Constant or variable bitrate MP3s land between 16 and 384 kbps: bytes per second of audio. */
const MIN_BYTES_PER_SEC = 2_000;
const MAX_BYTES_PER_SEC = 48_000;

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** BUN-1 versions look like 1.3.0; the portal adds `+r<design rev>` so each design gets its own. */
export const BUNDLE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,40})?$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;

// ---------------------------------------------------------------------------------------------------------------
// File sniffing

const startsWith = (bytes: Uint8Array, signature: number[], at = 0) =>
  bytes.length >= at + signature.length && signature.every((byte, i) => bytes[at + i] === byte);
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));

/** The file's real format from its first bytes, or null. */
export function sniffKind(head: Uint8Array): FileKind | null {
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, ascii('RIFF')) && startsWith(head, ascii('WEBP'), 8)) return 'webp';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (startsWith(head, ascii('ID3'))) return 'mp3';
  // A bare MPEG audio frame: 11 sync bits, then layer III (bits 01).
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 0x06) === 0x02) return 'mp3';
  return null;
}

/** Pixel size of a PNG, JPEG or WebP from its header bytes, or null when the header isn't in `bytes`. */
export function imageSize(bytes: Uint8Array, kind: FileKind): { width: number; height: number } | null {
  const u16be = (i: number) => (bytes[i] << 8) | bytes[i + 1];
  const u32be = (i: number) => ((bytes[i] << 24) >>> 0) + (bytes[i + 1] << 16) + (bytes[i + 2] << 8) + bytes[i + 3];
  const u24le = (i: number) => bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16);
  if (kind === 'png') {
    if (bytes.length < 24 || !startsWith(bytes, ascii('IHDR'), 12)) return null;
    return { width: u32be(16), height: u32be(20) };
  }
  if (kind === 'webp') {
    if (bytes.length < 30) return null;
    if (startsWith(bytes, ascii('VP8X'), 12)) return { width: 1 + u24le(24), height: 1 + u24le(27) };
    if (startsWith(bytes, ascii('VP8L'), 12)) {
      const [b0, b1, b2, b3] = [bytes[21], bytes[22], bytes[23], bytes[24]];
      return { width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
    }
    if (startsWith(bytes, ascii('VP8 '), 12)) {
      return { width: (bytes[26] | (bytes[27] << 8)) & 0x3fff, height: (bytes[28] | (bytes[29] << 8)) & 0x3fff };
    }
    return null;
  }
  if (kind === 'jpeg') {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) return null;
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1; // fill byte
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2; // markers with no length
        continue;
      }
      const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isFrame) return { width: u16be(i + 7), height: u16be(i + 5) };
      if (marker === 0xd9 || marker === 0xda) return null; // end of image or start of scan before a frame header
      i += 2 + u16be(i + 2);
    }
    return null;
  }
  return null;
}

export type StoredFile = { size: number; contentType?: string | null };

/**
 * Checks one upload against its purpose: size cap, sniffed format, and the browser's content type when it sent
 * one. Returns the sniffed kind, or a message safe to show.
 */
export function checkUpload(purpose: UploadPurpose, file: StoredFile, head: Uint8Array): { kind: FileKind } | { error: string } {
  const rule = UPLOAD_RULES[purpose];
  if (file.size <= 0) return { error: 'The file is empty.' };
  if (file.size > rule.maxBytes) return { error: `The file is ${(file.size / MB).toFixed(1)} MB; the limit is ${rule.maxBytes / MB} MB.` };
  const kind = sniffKind(head);
  if (!kind || !rule.kinds.includes(kind)) return { error: `That is not a ${rule.label}.` };
  const declared = (file.contentType ?? '').split(';')[0].trim().toLowerCase();
  if (declared && !CONTENT_TYPES[kind].includes(declared)) {
    return { error: `The upload says ${declared}, but the file is ${kind.toUpperCase()}.` };
  }
  return { kind };
}

/** The cover rules on a sniffed header: square to 1% and at least MIN_COVER_PX. */
export function checkCoverSize(size: { width: number; height: number } | null): string | null {
  if (!size) return 'Could not read the image size. Save it as PNG or JPEG and try again.';
  const { width, height } = size;
  if (Math.abs(width - height) > Math.max(width, height) * 0.01) return `The cover must be square (this one is ${width} × ${height}).`;
  if (Math.min(width, height) < MIN_COVER_PX) return `The cover must be at least ${MIN_COVER_PX} px (this one is ${width} px).`;
  return null;
}

/** The client read the duration; the server checks it is a plausible length for the file's size. */
export function checkDuration(sizeBytes: number, durationSec: number): string | null {
  if (!Number.isFinite(durationSec) || durationSec < 1 || durationSec > MAX_DURATION_SEC) {
    return 'The track length could not be read. Re-export the MP3 and try again.';
  }
  const rate = sizeBytes / durationSec;
  if (rate < MIN_BYTES_PER_SEC || rate > MAX_BYTES_PER_SEC) {
    return `A ${Math.round(durationSec)} second MP3 should not be ${(sizeBytes / MB).toFixed(1)} MB. Re-export it and try again.`;
  }
  return null;
}

export type SpriteMeta = {
  frames: number;
  cols: number;
  rows: number;
  frameW: number;
  frameH: number;
  sheetW: number;
  sheetH: number;
  fps: number;
  format: string;
};

/** `renderSpinLoop`'s metadata, checked against itself and against the PNG sheet's real size. */
export function checkSpriteMeta(meta: SpriteMeta, pngSize: { width: number; height: number } | null): string | null {
  const ints = [meta.frames, meta.cols, meta.rows, meta.frameW, meta.frameH, meta.sheetW, meta.sheetH];
  if (!ints.every((n) => Number.isInteger(n) && n > 0)) return 'Sprite metadata must be positive whole numbers.';
  if (meta.frames > 400) return 'At most 400 frames.';
  if (meta.cols * meta.rows < meta.frames) return 'The sheet has fewer cells than frames.';
  if (meta.cols * meta.frameW > meta.sheetW || meta.rows * meta.frameH > meta.sheetH) return 'The frames do not fit the sheet.';
  if (meta.sheetW > 4096 || meta.sheetH > 4096) return 'The sheet is over 4096 px.';
  if (!Number.isFinite(meta.fps) || meta.fps < 1 || meta.fps > 60) return 'fps must be 1 to 60.';
  if (!pngSize || pngSize.width !== meta.sheetW || pngSize.height !== meta.sheetH) {
    return 'The PNG sheet is not the size its metadata says.';
  }
  return null;
}

/** Convex keeps `_storage.sha256` as base64; the app and the manifest use hex. */
export function base64ToHex(base64: string): string {
  const binary = atob(base64);
  let hex = '';
  for (let i = 0; i < binary.length; i++) hex += binary.charCodeAt(i).toString(16).padStart(2, '0');
  return hex;
}

// ---------------------------------------------------------------------------------------------------------------
// The draft's facts

/** Slug, title, artist and year for a new draft, cleaned; throws nothing, returns the problems. */
export function checkDraftFacts(facts: { slug: string; title: string; artist: string; year: number }): string[] {
  const problems: string[] = [];
  if (!SLUG_PATTERN.test(facts.slug)) problems.push('The slug uses lowercase letters, digits and dashes (for example "blood").');
  for (const [name, value] of [['Title', facts.title], ['Artist', facts.artist]] as const) {
    if (!value.trim()) problems.push(`${name} is required.`);
    else if (value.trim().length > MAX_TITLE) problems.push(`${name} must be ${MAX_TITLE} characters or fewer.`);
  }
  if (!Number.isInteger(facts.year) || facts.year < 1900 || facts.year > 2100) problems.push('Year must be 1900 to 2100.');
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------
// The design

/** What the server knows and the design must say: the portal cannot change these through a design. */
export type ReleaseFacts = {
  slug: string;
  title: string;
  artist: string;
  year: number;
  coverUrl: string;
  tracks: { n: number; title: string; durationSec: number }[];
};

const DESIGN_KEYS = ['shell', 'shellTint', 'labelStyle', 'labelText', 'accent', 'accent2', 'discFinish'] as const;
const STICKER_KEYS = ['kind', 'text', 'x', 'y', 'w', 'rotation', 'fill', 'ink'] as const;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key];
  return out;
}

/**
 * The design the server stores: the portal's look (shell, tint, label, accents, finish, stickers, theme colours
 * and backdrop blur) over the server's facts. Unknown keys are dropped. Art is the release's cover only (the
 * portal uploads nothing else), so a disc or backdrop image other than the cover is refused rather than kept.
 */
export function buildDesign(input: unknown, facts: ReleaseFacts): ValidationResult {
  if (!isRecord(input)) return { ok: false, errors: ['design: must be an object'] };
  const errors: string[] = [];
  const art = (path: string, value: unknown) => {
    if (value !== undefined && value !== facts.coverUrl) errors.push(`${path}: only the release's cover art can be used`);
  };
  art('discArt', input.discArt);
  const out: Record<string, unknown> = {
    v: 1,
    slug: facts.slug,
    title: facts.title,
    artist: facts.artist,
    year: facts.year,
    tracks: facts.tracks,
    coverArt: facts.coverUrl,
    ...pick(input, DESIGN_KEYS),
  };
  if (input.stickers !== undefined) {
    out.stickers = Array.isArray(input.stickers) ? input.stickers.map((s) => (isRecord(s) ? pick(s, STICKER_KEYS) : s)) : input.stickers;
  }
  if (input.theme !== undefined) {
    if (!isRecord(input.theme)) out.theme = input.theme;
    else {
      const theme = pick(input.theme, ['accent', 'accent2', 'lcdTint']);
      art('theme.backdropImage', input.theme.backdropImage);
      if (input.theme.backdrop !== undefined) {
        if (isRecord(input.theme.backdrop)) {
          art('theme.backdrop.image', input.theme.backdrop.image);
          theme.backdrop = pick(input.theme.backdrop, ['blurPx', 'scrim']);
        } else theme.backdrop = input.theme.backdrop;
      }
      out.theme = theme;
    }
  }
  const result = validateDesign(out);
  if (!result.ok) return { ok: false, errors: [...errors, ...result.errors] };
  return errors.length > 0 ? { ok: false, errors } : result;
}

/** The stored design brought up to date with new facts (a renamed track, a new cover). */
export function refreshDesign(design: DiscDesign, facts: ReleaseFacts): DiscDesign {
  return { ...design, slug: facts.slug, title: facts.title, artist: facts.artist, year: facts.year, tracks: facts.tracks, coverArt: facts.coverUrl };
}

/** JSON with object keys sorted, so the same design always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/** SHA-256 hex of the canonical design: the rack art and the bundle record the hash they were made from. */
export async function designHash(design: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalJson(design))));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------------------------
// Publish

export type PublishState = {
  status: 'draft' | 'scheduled' | 'live' | undefined;
  tracks: { position: number; hasAudio: boolean; durationSeconds: number }[];
  hasCover: boolean;
  designHash: string | null;
  rackDesignHash: string | null;
  bundleDesignHash: string | null;
};

/** Everything that stops a draft going out, in the portal's step order. Empty means it can be published. */
export function publishProblems(state: PublishState): string[] {
  const problems: string[] = [];
  if (state.status !== 'draft') problems.push('Only a draft can be published from the portal. Use RELEASE settings for a published release.');
  if (state.tracks.length === 0) problems.push('Upload at least one track.');
  for (const track of state.tracks) {
    if (!track.hasAudio) problems.push(`Track ${track.position} has no audio.`);
    else if (!(track.durationSeconds > 0)) problems.push(`Track ${track.position} has no length.`);
  }
  if (!state.hasCover) problems.push('Upload the cover art.');
  if (!state.designHash) problems.push('Save the casing (the design).');
  else {
    if (state.rackDesignHash !== state.designHash) {
      problems.push(state.rackDesignHash ? 'The rack art is out of date: render it again.' : 'Render the rack art.');
    }
    if (state.bundleDesignHash !== state.designHash) {
      problems.push(state.bundleDesignHash ? 'The bundle is out of date: build it again.' : 'Build and upload the bundle.');
    }
  }
  return problems;
}

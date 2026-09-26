/**
 * The release zip, built in the admin's browser (PRD §10.1 BUN-1, BUN-4): the prebuilt generic bundle
 * (`bundles/release`, staged at `/release-bundle/` by `scripts/stage-release-bundle.mjs`), plus `design/design.json`
 * and the cover, plus `manifest.json`. Same layout and manifest fields as `scripts/build-bundle.mjs release --design`,
 * so the app can't tell which one built it. Deterministic like that script: sorted entries, fixed 1980 timestamps.
 */
import { resolveTheme, type DiscDesign } from '../packages/minidisc/src/design';

/** `/release-bundle/index.json`, written by the stage script from the generic bundle's own manifest. */
export interface GenericBundleIndex {
  version: string;
  entry: string;
  bridgeVersion: number;
  minAppVersion: string;
  wearSafeZones: unknown[];
  files: { path: string; size: number }[];
}

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** Raw DEFLATE through the browser's CompressionStream; null where it isn't available (the entry is stored). */
async function deflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const stream = new Blob([data as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Already compressed formats are stored as they are. */
const STORED = /\.(png|jpe?g|webp|mp3|zip|woff2?)$/i;

// 1980-01-01 00:00:00, so the bytes don't depend on when it was built.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

/** A PKWARE zip (local headers, central directory, end record; no ZIP64). Entries are sorted by name. */
export async function buildZip(input: ZipEntry[]): Promise<Uint8Array> {
  const entries = [...input].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = encoder.encode(name);
    const deflated = STORED.test(name) ? null : await deflateRaw(data);
    const stored = !deflated || deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true);
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, stored ? 0 : 8, true);
    local.setUint16(10, DOS_TIME, true);
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, body.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, nameBytes.length, true);
    const central = new DataView(new ArrayBuffer(46));
    central.setUint32(0, 0x02014b50, true);
    central.setUint16(4, 0x0314, true); // made by Unix, 2.0
    central.setUint16(6, 20, true);
    central.setUint16(8, 0x0800, true);
    central.setUint16(10, stored ? 0 : 8, true);
    central.setUint16(12, DOS_TIME, true);
    central.setUint16(14, DOS_DATE, true);
    central.setUint32(16, crc, true);
    central.setUint32(20, body.length, true);
    central.setUint32(24, data.length, true);
    central.setUint16(28, nameBytes.length, true);
    central.setUint32(38, (0o100644 << 16) >>> 0, true); // -rw-r--r--
    central.setUint32(42, offset, true);
    chunks.push(new Uint8Array(local.buffer), nameBytes, body);
    centrals.push(new Uint8Array(central.buffer), nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...centrals, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of all) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function sha256Hex(data: Uint8Array | Blob): Promise<string> {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : (data as Uint8Array<ArrayBuffer>);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `png`, `jpg` or `webp` from the image's first bytes. */
export function imageExtension(head: Uint8Array): 'png' | 'jpg' | 'webp' | null {
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
  if (String.fromCharCode(...head.slice(0, 4)) === 'RIFF' && String.fromCharCode(...head.slice(8, 12)) === 'WEBP') return 'webp';
  return null;
}

/** NAT-5: the same 40 MB budget as build-bundle.mjs and `releases.attachBundle`. */
export const MAX_ZIP_BYTES = 40 * 1024 * 1024;

export interface ReleaseZipInput {
  index: GenericBundleIndex;
  /** Every path in `index.files`, with its bytes. */
  files: Map<string, Uint8Array>;
  /** The saved design (from `releases.get`); its cover URL is rewritten to the shipped file. */
  design: DiscDesign;
  cover: Uint8Array;
  releaseId: string;
  version: string;
}

/**
 * The zip and its manifest. The design ships as `design/design.json` with its art at `design/cover.<ext>` (the
 * bundle reads `./design/design.json` and resolves art against it), exactly as build-bundle.mjs lays it out.
 */
export async function assembleReleaseZip(input: ReleaseZipInput): Promise<{ zip: Uint8Array; sha256: string; manifest: Record<string, unknown> }> {
  const ext = imageExtension(input.cover.slice(0, 12));
  if (!ext) throw new Error('The cover is not a PNG, JPEG or WebP image.');
  const coverName = `cover.${ext}`;
  const coverRef = input.design.coverArt;
  const rewrite = (ref: string | undefined) => (ref === undefined ? undefined : ref === coverRef ? coverName : null);
  const art = [input.design.discArt, input.design.theme?.backdropImage, input.design.theme?.backdrop?.image];
  if (art.some((ref) => rewrite(ref) === null)) throw new Error('The design names art other than its cover.');
  const shipped: DiscDesign = {
    ...input.design,
    coverArt: coverName,
    discArt: rewrite(input.design.discArt) ?? undefined,
    theme: input.design.theme
      ? {
          ...input.design.theme,
          backdropImage: rewrite(input.design.theme.backdropImage) ?? undefined,
          backdrop: input.design.theme.backdrop
            ? { ...input.design.theme.backdrop, image: rewrite(input.design.theme.backdrop.image) ?? undefined }
            : undefined,
        }
      : undefined,
  };
  const { index } = input;
  const manifest = {
    releaseId: input.releaseId,
    slug: shipped.slug,
    version: input.version,
    entry: index.entry,
    bridgeVersion: index.bridgeVersion,
    minAppVersion: index.minAppVersion,
    wearSafeZones: index.wearSafeZones,
    generator: `minidisc/${shipped.v}`,
    design: {
      title: shipped.title,
      artist: shipped.artist,
      year: shipped.year,
      shell: shipped.shell,
      labelStyle: shipped.labelStyle,
      theme: resolveTheme(shipped),
    },
  };
  const encoder = new TextEncoder();
  const entries: ZipEntry[] = [
    { name: 'manifest.json', data: encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`) },
    { name: 'design/design.json', data: encoder.encode(`${JSON.stringify(shipped, null, 2)}\n`) },
    { name: `design/${coverName}`, data: input.cover },
  ];
  for (const { path } of index.files) {
    if (path === 'manifest.json' || path.startsWith('design/')) continue;
    const data = input.files.get(path);
    if (!data) throw new Error(`Generic bundle file missing: ${path}`);
    entries.push({ name: path, data });
  }
  if (!entries.some((entry) => entry.name === index.entry)) throw new Error(`The generic bundle has no ${index.entry}.`);
  const zip = await buildZip(entries);
  if (zip.length > MAX_ZIP_BYTES) throw new Error(`The zip is ${(zip.length / 1048576).toFixed(1)} MB, over the 40 MB budget (NAT-5).`);
  return { zip, sha256: await sha256Hex(zip), manifest };
}

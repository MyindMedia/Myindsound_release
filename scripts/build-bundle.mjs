#!/usr/bin/env node
/**
 * Packs a built release bundle (PRD §10.1, BUN-1): `dist-bundles/<slug>` → `dist-bundles/<slug>-<version>.zip`
 * plus `dist-bundles/<slug>-<version>.manifest.json`, the manifest published next to the zip, carrying its SHA-256.
 *
 *   node scripts/build-bundle.mjs lit          (after `vite build -c vite.bundles.config.ts`; `npm run bundle:lit` does both)
 *   RELEASE_ID=<Convex products id> node scripts/build-bundle.mjs lit
 *
 * The zip also holds a `manifest.json` (the same fields without `sha256`, which can't be inside the file it
 * hashes), so native can read `bridgeVersion` from an unpacked copy (BRG-3).
 *
 * Fails when: the zip is over 40 MB (NAT-5); the dev harness or mock leaked into the release; anything looks like
 * music or a Convex call (BUN-5, ARCH-2); the wear safe zones break packages/wear's rules.
 *
 * The zip is deterministic: sorted entries, fixed timestamps, DEFLATE, so the same build gives the same SHA-256.
 */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MAX_ZIP_BYTES = 40 * 1024 * 1024;
const SURFACES = new Set(['shell', 'window', 'label', 'disc']);

function fail(message) {
  console.error(`build-bundle: ${message}`);
  process.exit(1);
}

const slug = process.argv[2] ?? 'lit';
if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) fail(`bad slug "${slug}"`);
const srcDir = join(ROOT, 'bundles', slug);
const outDir = join(ROOT, 'dist-bundles', slug);
if (!existsSync(join(outDir, 'index.html'))) fail(`${relative(ROOT, outDir)}/index.html missing: run the Vite bundle build first`);

const config = JSON.parse(readFileSync(join(srcDir, 'bundle.json'), 'utf8'));
if (config.slug !== slug) fail(`bundle.json slug "${config.slug}" is not "${slug}"`);

/**
 * Generic release mode (`release --design <design.json>`, PRD BUN-4): the built `bundles/release` is packaged
 * with one release's `DiscDesign` and its art, copied into `design/` inside the zip (the bundle reads
 * `./design/design.json`). The zip and manifest take the DESIGN's slug: `<slug>-<bundle version>.zip`.
 */
const designArg = process.argv.indexOf('--design');
const designPath = designArg > 0 ? process.argv[designArg + 1] : null;
if (slug === 'release' && !designPath) fail('release mode needs --design <path to design.json>');
if (designPath && slug !== 'release') fail('--design only applies to the generic release bundle (slug "release")');
let design = null;
if (designPath) {
  const { assertDesign, designArtRefs, resolveTheme } = await import('../packages/minidisc/src/design.ts');
  const file = resolve(process.cwd(), designPath);
  if (!existsSync(file)) fail(`design not found: ${designPath}`);
  try {
    design = assertDesign(JSON.parse(readFileSync(file, 'utf8')));
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
  }
  const designDir = join(outDir, 'design');
  rmSync(designDir, { recursive: true, force: true });
  mkdirSync(designDir, { recursive: true });
  // Each art file is copied in under its basename; the copied design.json refers to those names.
  const renamed = new Map();
  const taken = new Set(['design.json']);
  for (const ref of designArtRefs(design)) {
    if (/^[a-z]+:/i.test(ref)) fail(`art must ship inside the zip, not from a URL: ${ref}`);
    const source = resolve(dirname(file), ref);
    if (!existsSync(source)) fail(`art missing: ${ref} (from ${relative(ROOT, file)})`);
    if (!/\.(png|jpe?g|webp)$/i.test(source)) fail(`art must be PNG, JPEG or WebP: ${ref}`);
    let name = basename(source);
    if (taken.has(name)) name = `${createHash('sha256').update(ref).digest('hex').slice(0, 8)}-${name}`;
    taken.add(name);
    cpSync(source, join(designDir, name));
    renamed.set(ref, name);
  }
  const rewrite = (ref) => (ref === undefined ? undefined : renamed.get(ref));
  const shipped = {
    ...design,
    coverArt: rewrite(design.coverArt),
    discArt: rewrite(design.discArt),
    theme: design.theme
      ? {
          ...design.theme,
          backdropImage: rewrite(design.theme.backdropImage),
          backdrop: design.theme.backdrop ? { ...design.theme.backdrop, image: rewrite(design.theme.backdrop.image) } : undefined,
        }
      : undefined,
  };
  writeFileSync(join(designDir, 'design.json'), `${JSON.stringify(shipped, null, 2)}\n`);
  design = { ...design, theme: resolveTheme(design) };
}
const releaseSlug = design ? design.slug : slug;
if (!/^\d+\.\d+\.\d+$/.test(config.version ?? '')) fail('bundle.json version must be x.y.z');
if (!/^\d+\.\d+\.\d+$/.test(config.minAppVersion ?? '')) fail('bundle.json minAppVersion must be x.y.z');

// The bridge version the bundle was built against: the client's own constant.
const typesSource = readFileSync(join(ROOT, 'packages/bridge/src/types.ts'), 'utf8');
const bridgeVersion = Number(/export const BRIDGE_VERSION = (\d+);/.exec(typesSource)?.[1]);
if (!Number.isInteger(bridgeVersion)) fail('could not read BRIDGE_VERSION from packages/bridge/src/types.ts');

// packages/wear README §1: dense array of { surface, x, y, w, h }, numbers finite in 0..1. Extra keys dropped.
const wearSafeZones = (config.wearSafeZones ?? []).map((zone, i) => {
  const { surface, x, y, w, h } = zone ?? {};
  if (!SURFACES.has(surface)) fail(`wearSafeZones[${i}].surface must be one of ${[...SURFACES].join(', ')}`);
  for (const [key, value] of Object.entries({ x, y, w, h })) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      fail(`wearSafeZones[${i}].${key} must be a number in 0..1`);
    }
  }
  return { surface, x, y, w, h };
});

// ── Files ──────────────────────────────────────────────────────────────────────────────────────────────
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
const isDevOnly = (path) => path === 'dev.html' || /^assets\/dev-[^/]+\.js$/.test(path);
const built = walk(outDir)
  .map((file) => relative(outDir, file).split(sep).join('/'))
  .filter((path) => path !== 'manifest.json' && !path.endsWith('.DS_Store'))
  .sort();
// Assets only the dev harness refers to (its sample art, say) are as dev-only as the harness itself.
// Vite refers to a hashed asset by path (`./assets/x-H4sh.png`) or, from inside assets/, by bare name.
const assetRefs = (path) => {
  const text = readFileSync(join(outDir, path), 'utf8');
  return new Set([...text.matchAll(/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{8}\.[a-z0-9]+/g)].map((m) => m[0]));
};
const keptRefs = new Set();
const devRefs = new Set();
for (const path of built.filter((p) => /\.(js|html|css)$/.test(p))) {
  for (const ref of assetRefs(path)) (isDevOnly(path) ? devRefs : keptRefs).add(ref);
}
const isDevAsset = (path) => {
  if (!path.startsWith('assets/')) return false;
  const name = path.slice('assets/'.length);
  return devRefs.has(name) && !keptRefs.has(name);
};
const files = built.filter((path) => !isDevOnly(path) && !isDevAsset(path));

if (!files.includes(config.entry)) fail(`entry "${config.entry}" is not in the build`);

// BUN-5 / ARCH-2 guards on everything that ships. Strings, not a parser: cheap, and a hit is always worth a look.
const FORBIDDEN = [
  [/Mock Lender|MockBridge/, 'the dev harness mock'],
  [/lit-previews/, 'song previews'],
  [/\.convex\.(cloud|site)|ConvexClient|convex\/browser/, 'a Convex client'],
  [/clerk\.accounts|@clerk\//, 'Clerk'],
  [/fonts\.googleapis|cdnjs\.cloudflare/, 'a network font or CDN script'],
];
for (const path of files) {
  if (/\.(mp3|m4a|aac|wav|flac|ogg)$/i.test(path) && !/^assets\/audio\/(disc|wrap)\//.test(path)) {
    fail(`${path}: music must never ship in a bundle (ARCH-2)`);
  }
  if (!/\.(js|html|css|json)$/.test(path)) continue;
  const text = readFileSync(join(outDir, path), 'utf8');
  for (const [pattern, what] of FORBIDDEN) if (pattern.test(text)) fail(`${path} contains ${what}`);
}

const manifestBase = {
  releaseId: process.env.RELEASE_ID ?? 'REPLACE_WITH_RELEASE_ID',
  slug: releaseSlug,
  version: config.version,
  entry: config.entry,
  bridgeVersion,
  minAppVersion: config.minAppVersion,
  wearSafeZones,
  // Generic release bundles: what the app shows before the bundle boots (title, theme), and which generator made it.
  ...(design
    ? {
        generator: `minidisc/${design.v}`,
        design: { title: design.title, artist: design.artist, year: design.year, shell: design.shell, labelStyle: design.labelStyle, theme: design.theme },
      }
    : {}),
};

// ── Zip (PKWARE APPNOTE: local headers, central directory, end record; no ZIP64, so < 4 GB) ─────────────
const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
// 1980-01-01 00:00:00, so the bytes don't depend on when the build ran.
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, 'utf8');
    const deflated = deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(stored ? 0 : 8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0314, 4); // made by: Unix, 2.0
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(stored ? 0 : 8, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // -rw-r--r--
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, body);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + body.length;
  }
  const centralSize = centrals.reduce((sum, b) => sum + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

const inner = Buffer.from(`${JSON.stringify(manifestBase, null, 2)}\n`);
writeFileSync(join(outDir, 'manifest.json'), inner);
const entries = [
  { name: 'manifest.json', data: inner },
  ...files.map((name) => ({ name, data: readFileSync(join(outDir, name)) })),
].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const archive = zip(entries);
if (archive.length > MAX_ZIP_BYTES) {
  fail(`zip is ${(archive.length / 1048576).toFixed(2)} MB, over the 40 MB budget (NAT-5)`);
}

const sha256 = createHash('sha256').update(archive).digest('hex');
const zipPath = join(ROOT, 'dist-bundles', `${releaseSlug}-${config.version}.zip`);
const manifestPath = join(ROOT, 'dist-bundles', `${releaseSlug}-${config.version}.manifest.json`);
writeFileSync(zipPath, archive);
writeFileSync(manifestPath, `${JSON.stringify({ ...manifestBase, sha256 }, null, 2)}\n`);

const raw = files.reduce((sum, path) => sum + statSync(join(outDir, path)).size, 0);
console.log(
  `build-bundle: ${relative(ROOT, zipPath)} ${(archive.length / 1048576).toFixed(2)} MB ` +
    `(${entries.length} files, ${(raw / 1048576).toFixed(2)} MB unpacked), sha256 ${sha256}`,
);
console.log(`build-bundle: ${relative(ROOT, manifestPath)}`);

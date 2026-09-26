#!/usr/bin/env node
/**
 * Puts the generic release bundle (`bundles/release`, PRD BUN-4) on the site at `/release-bundle/`, so the admin
 * release portal can build a release's zip in the browser (src/admin-releases-zip.ts):
 *
 *   dist/release-bundle/index.json        { version, entry, bridgeVersion, minAppVersion, wearSafeZones, files }
 *   dist/release-bundle/files/<path>      every generic file the release zip carries
 *
 * The file set is exactly what `scripts/build-bundle.mjs release --design …` ships, because it comes out of a zip
 * that script built (from packages/minidisc/samples/blood.json, renamed so it never clobbers a real release): the
 * dev harness, its sample art, the design and the manifest are left out; the manifest's generic fields go into
 * index.json. So the browser zip and the CLI zip can't drift apart.
 *
 *   node scripts/stage-release-bundle.mjs            (part of `npm run build`; builds bundles/release first)
 *   node scripts/stage-release-bundle.mjs --no-build (reuse dist-bundles/release)
 *   node scripts/stage-release-bundle.mjs --strict   (fail instead of warning; `npm run stage:release-bundle`,
 *                                                     which `npm run dev` then serves at /release-bundle/)
 *
 * Without --strict a failure only warns: the website must deploy even if the bundle build breaks, and the portal
 * then tells the admin to use `npm run publish:release` instead.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'dist', 'release-bundle');
const TEMPLATE_SLUG = 'release-template';
const args = process.argv.slice(2);
const strict = args.includes('--strict');

/** Entries of a zip, read through its central directory (build-bundle.mjs writes no ZIP64). */
export function readZip(buffer) {
  const endAt = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (endAt < 0) throw new Error('not a zip');
  const count = buffer.readUInt16LE(endAt + 10);
  let at = buffer.readUInt32LE(endAt + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (buffer.readUInt32LE(at) !== 0x02014b50) throw new Error('bad central directory');
    const method = buffer.readUInt16LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 20);
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    const local = buffer.readUInt32LE(at + 42);
    const name = buffer.subarray(at + 46, at + 46 + nameLength).toString('utf8');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const body = buffer.subarray(start, start + compressed);
    entries.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function run(command, commandArgs, env = {}) {
  execFileSync(command, commandArgs, { cwd: ROOT, stdio: 'inherit', env: { ...process.env, ...env } });
}

function stage() {
  if (!args.includes('--no-build') || !existsSync(join(ROOT, 'dist-bundles/release/index.html'))) {
    run('npx', ['vite', 'build', '-c', 'vite.bundles.config.ts', '--logLevel', 'warn'], { BUNDLE_SLUG: 'release' });
  }
  // A throwaway copy of the sample design under a slug no release uses, so its zip lands in its own file.
  const sampleDir = join(ROOT, 'packages/minidisc/samples');
  const temp = mkdtempSync(join(tmpdir(), 'release-template-'));
  try {
    const sample = JSON.parse(readFileSync(join(sampleDir, 'blood.json'), 'utf8'));
    cpSync(join(sampleDir, 'blood'), join(temp, 'blood'), { recursive: true });
    writeFileSync(join(temp, 'design.json'), JSON.stringify({ ...sample, slug: TEMPLATE_SLUG }));
    run('node', ['scripts/build-bundle.mjs', 'release', '--design', join(temp, 'design.json')], { RELEASE_ID: 'template' });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
  const bundleJson = JSON.parse(readFileSync(join(ROOT, 'bundles/release/bundle.json'), 'utf8'));
  const zipPath = join(ROOT, 'dist-bundles', `${TEMPLATE_SLUG}-${bundleJson.version}.zip`);
  const entries = readZip(readFileSync(zipPath));
  const manifest = JSON.parse(entries.get('manifest.json').toString('utf8'));
  const generic = [...entries.keys()].filter((name) => name !== 'manifest.json' && !name.startsWith('design/')).sort();
  if (!generic.includes(manifest.entry)) throw new Error(`the zip has no ${manifest.entry}`);

  rmSync(OUT, { recursive: true, force: true });
  for (const name of generic) {
    const file = join(OUT, 'files', name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, entries.get(name));
  }
  const index = {
    version: manifest.version,
    entry: manifest.entry,
    bridgeVersion: manifest.bridgeVersion,
    minAppVersion: manifest.minAppVersion,
    wearSafeZones: manifest.wearSafeZones,
    files: generic.map((path) => ({ path, size: entries.get(path).length })),
  };
  writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
  rmSync(zipPath, { force: true });
  rmSync(zipPath.replace(/\.zip$/, '.manifest.json'), { force: true });
  const bytes = index.files.reduce((sum, file) => sum + file.size, 0);
  console.log(`stage-release-bundle: dist/release-bundle ${index.files.length} files, ${(bytes / 1048576).toFixed(2)} MB, bundle ${index.version}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    stage();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (strict) {
      console.error(`stage-release-bundle: ${message}`);
      process.exit(1);
    }
    console.warn(`stage-release-bundle: WARNING, not staged (${message}). The portal will point to npm run publish:release.`);
  }
}

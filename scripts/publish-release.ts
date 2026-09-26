/**
 * Builds a portal release's zip on this machine and attaches it, for when the portal can't build it in the
 * browser (the site deployed without `/release-bundle/`, or the zip needs checking locally first).
 *
 *   npm run publish:release -- --slug blood --as you@myindsound.com            # dev deployment
 *   npm run publish:release -- --slug blood --as you@myindsound.com --prod     # production
 *   npm run publish:release -- --slug blood --dry-run                          # build only, upload nothing
 *
 * 1. Reads the saved casing from Convex (`releases:designForPublish`).
 * 2. Downloads its cover into a temp folder and writes a design.json that names it relatively.
 * 3. Builds `bundles/release` (unless `--no-build`) and runs `scripts/build-bundle.mjs release --design …`,
 *    which validates the design and applies every bundle guard (size, no music, no Convex).
 * 4. Uploads the zip and attaches it (`releases:attachBundleFromCli`): the server checks the SHA-256 against the
 *    stored file and writes the audit row as the admin named by `--as`.
 *
 * Runs Convex functions through `npx convex run`, so it uses your Convex CLI login; no keys in files.
 * Then open /admin → RELEASES to publish.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const slug = option('--slug');
const adminEmail = option('--as');
const prod = flag('--prod');
const dryRun = flag('--dry-run');

function fail(message: string): never {
  console.error(`publish-release: ${message}`);
  process.exit(1);
}

function convexRun<T>(fn: string, fnArgs: object): T {
  const out = execFileSync('npx', ['convex', 'run', ...(prod ? ['--prod'] : []), fn, JSON.stringify(fnArgs)], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  return (out ? JSON.parse(out) : null) as T;
}

function imageExtension(bytes: Buffer): string {
  if (bytes.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))) return 'png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg';
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return 'webp';
  fail('the cover is not a PNG, JPEG or WebP image');
}

type DesignForPublish = {
  releaseId: string;
  design: { slug: string; coverArt: string; discArt?: string; theme?: { backdropImage?: string; backdrop?: { image?: string } } } & Record<string, unknown>;
  designHash: string;
  designRev: number;
  status: string;
};

async function main() {
  if (!slug || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(slug)) fail('pass --slug <release slug>');
  if (!dryRun && !adminEmail) fail('pass --as <your admin email> (the audit log names who attached the bundle)');
  console.log(`Target: ${prod ? 'production' : 'dev'} deployment`);

  const saved = convexRun<DesignForPublish>('releases:designForPublish', { slug });
  if (saved.status !== 'draft') fail(`${slug} is ${saved.status}; only drafts take a new bundle`);
  const cover = Buffer.from(await (await fetch(saved.design.coverArt)).arrayBuffer());
  const coverName = `cover.${imageExtension(cover)}`;

  const temp = mkdtempSync(join(tmpdir(), `publish-${slug}-`));
  try {
    writeFileSync(join(temp, coverName), cover);
    // The portal only uses the cover, so every art reference becomes the local file.
    const design = {
      ...saved.design,
      coverArt: coverName,
      discArt: saved.design.discArt ? coverName : undefined,
      theme: saved.design.theme
        ? {
            ...saved.design.theme,
            backdropImage: saved.design.theme.backdropImage ? coverName : undefined,
            backdrop: saved.design.theme.backdrop
              ? { ...saved.design.theme.backdrop, image: saved.design.theme.backdrop.image ? coverName : undefined }
              : undefined,
          }
        : undefined,
    };
    writeFileSync(join(temp, 'design.json'), JSON.stringify(design, null, 2));

    const env = { ...process.env, RELEASE_ID: saved.releaseId };
    if (!flag('--no-build')) {
      execFileSync('npx', ['vite', 'build', '-c', 'vite.bundles.config.ts', '--logLevel', 'warn'], {
        cwd: root,
        stdio: 'inherit',
        env: { ...env, BUNDLE_SLUG: 'release' },
      });
    }
    execFileSync('node', ['scripts/build-bundle.mjs', 'release', '--design', join(temp, 'design.json')], { cwd: root, stdio: 'inherit', env });
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }

  const genericVersion = (JSON.parse(readFileSync(join(root, 'bundles/release/bundle.json'), 'utf8')) as { version: string }).version;
  const zipPath = join(root, 'dist-bundles', `${slug}-${genericVersion}.zip`);
  const zip = readFileSync(zipPath);
  const sha256 = createHash('sha256').update(zip).digest('hex');
  // The same version the portal gives a browser-built zip: the generic bundle's, plus the design revision.
  const version = `${genericVersion}+r${saved.designRev}`;
  console.log(`Zip: ${zipPath} (${(zip.length / 1048576).toFixed(2)} MB), sha256 ${sha256}, version ${version}`);
  if (dryRun) {
    console.log('Dry run: nothing uploaded.');
    return;
  }

  const uploadUrl = convexRun<string>('tracks:generateUploadUrl', {});
  const response = await fetch(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: zip });
  if (!response.ok) fail(`upload failed: HTTP ${response.status}`);
  const { storageId } = (await response.json()) as { storageId: string };
  const attached = convexRun<{ version: string; url: string; sha256: string }>('releases:attachBundleFromCli', {
    slug,
    version,
    zip: storageId,
    sha256,
    designHash: saved.designHash,
    adminEmail,
  });
  console.log(`Attached bundle ${attached.version} to ${slug}. Publish it from /admin → RELEASES.`);
}

main().catch((error: unknown) => fail(error instanceof Error ? error.message : String(error)));

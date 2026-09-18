/**
 * Uploads the LIT audio into Convex file storage and seeds the `tracks` table.
 *
 *   npm run upload:audio -- --dry-run            # plan only
 *   npm run upload:audio                         # dev deployment
 *   npm run upload:audio -- --prod               # production
 *   npm run upload:audio -- --source "<folder>"  # override the masters folder
 *
 * Uploads each full song (WAV masters are also encoded to a 320 kbps MP3 for streaming, and the WAV is
 * kept as the original), plus the album zip. Runs Convex functions through `npx convex run`, so it uses
 * your Convex CLI login; no keys in files. Safe to rerun: files whose sha256 already matches are skipped,
 * and replaced files are deleted from storage.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, utimesSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

type TrackConfig = { position: number; title: string; file: string; name: string; previewStart?: number; gainDb?: number };
type Config = { slug: string; defaultSourceDir: string; zipName: string; albumLufs?: number; previewLufs?: number; tracks: TrackConfig[] };

const root = resolve(import.meta.dirname, '..');
const config = JSON.parse(readFileSync(join(root, 'scripts/lit-tracks.json'), 'utf8')) as Config;
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const dryRun = flag('--dry-run');
const prod = flag('--prod');
const sourceDir = (option('--source') ?? config.defaultSourceDir).replace(/^~/, homedir());
const cacheDir = join(root, '.cache/audio');

type Upload =
  | { kind: 'stream' | 'original'; position: number; path: string; contentType: string }
  | { kind: 'download'; path: string; contentType: string };

function probeDuration(path: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], {
    encoding: 'utf8',
  });
  return Math.round(Number.parseFloat(out.trim()) * 100) / 100;
}

/** Same encoding Convex stores in `_storage.sha256`. */
function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('base64');
}

function prepare() {
  if (!existsSync(sourceDir)) throw new Error(`Masters folder not found: ${sourceDir}`);
  mkdirSync(cacheDir, { recursive: true });
  const uploads: Upload[] = [];
  const seedTracks = [];
  const zipStaging = join(cacheDir, 'zip');
  rmSync(zipStaging, { recursive: true, force: true });
  mkdirSync(zipStaging, { recursive: true });

  for (const track of config.tracks) {
    const source = join(sourceDir, track.file);
    if (!existsSync(source)) throw new Error(`Missing master: ${track.file}`);
    let streamPath = source;
    if (track.file.endsWith('.wav')) {
      streamPath = join(cacheDir, `${track.name}.mp3`);
      if (!existsSync(streamPath) || statSync(streamPath).mtimeMs < statSync(source).mtimeMs) {
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', source, '-codec:a', 'libmp3lame', '-b:a', '320k', streamPath]);
      }
      uploads.push({ kind: 'original', position: track.position, path: source, contentType: 'audio/wav' });
    }
    // Album levelling: a master that came in louder or quieter than the rest is corrected by a flat gain
    // (measured with ffmpeg loudnorm, recorded in the manifest). Nothing else about the mix is touched, and
    // the levelled file is what both the stream and the album zip carry, so a buyer hears one album.
    const gainDb = track.gainDb ?? 0;
    let albumPath = source;
    if (gainDb) {
      const levelled = join(cacheDir, `${track.name}-${gainDb.toFixed(2)}dB.mp3`);
      if (!existsSync(levelled) || statSync(levelled).mtimeMs < statSync(streamPath).mtimeMs) {
        execFileSync('ffmpeg', [
          '-y', '-v', 'error', '-i', streamPath, '-map', '0:a', '-map_metadata', '-1',
          '-af', `volume=${gainDb}dB`, '-codec:a', 'libmp3lame', '-b:a', '320k', levelled,
        ]);
      }
      streamPath = levelled;
      albumPath = levelled;
    }
    uploads.push({ kind: 'stream', position: track.position, path: streamPath, contentType: 'audio/mpeg' });
    const extension = gainDb ? '.mp3' : track.file.slice(track.file.lastIndexOf('.'));
    const numbered = `${String(track.position).padStart(2, '0')} - ${track.title.replace(/[/\\:]/g, '-')}${extension}`;
    const staged = join(zipStaging, numbered);
    copyFileSync(albumPath, staged);
    // Keep the master's timestamps so the zip is byte-identical between runs (and isn't re-uploaded).
    const { atime, mtime } = statSync(source);
    utimesSync(staged, atime, mtime);
    seedTracks.push({ position: track.position, title: track.title, durationSeconds: probeDuration(streamPath) });
  }

  const zipPath = join(cacheDir, config.zipName);
  rmSync(zipPath, { force: true });
  const staged = execFileSync('ls', ['-1', zipStaging], { encoding: 'utf8' }).trim().split('\n').sort();
  execFileSync('zip', ['-q', '-j', '-X', zipPath, ...staged.map((file) => join(zipStaging, file))]);
  uploads.push({ kind: 'download', path: zipPath, contentType: 'application/zip' });
  return { uploads, seedTracks };
}

function convexRun<T>(fn: string, fnArgs: object): T {
  const out = execFileSync('npx', ['convex', 'run', ...(prod ? ['--prod'] : []), fn, JSON.stringify(fnArgs)], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
  return (out ? JSON.parse(out) : null) as T;
}

async function main() {
  const { uploads, seedTracks } = prepare();
  const megabytes = (path: string) => (statSync(path).size / 1e6).toFixed(1);
  const label = (item: Upload) => (item.kind === 'download' ? `album zip` : `track ${item.position} ${item.kind}`);

  console.log(`Masters: ${sourceDir}`);
  console.log(`Target: ${prod ? 'production' : 'dev'} deployment`);
  for (const item of uploads) console.log(`  ${label(item).padEnd(20)} ${megabytes(item.path)} MB`);
  if (dryRun) {
    console.log('Dry run: nothing uploaded or seeded.');
    return;
  }

  convexRun('seed:products', {});
  convexRun('tracks:seed', { slug: config.slug, tracks: seedTracks });
  const current = convexRun<{ download: string | null; tracks: { position: number; stream: string | null; original: string | null }[] }>(
    'tracks:fileHashes',
    { slug: config.slug },
  );

  for (const item of uploads) {
    const existing =
      item.kind === 'download'
        ? current.download
        : current.tracks.find((track) => track.position === item.position)?.[item.kind];
    if (existing && existing === sha256(item.path)) {
      console.log(`  unchanged  ${label(item)}`);
      continue;
    }
    const uploadUrl = convexRun<string>('tracks:generateUploadUrl', {});
    const response = await fetch(uploadUrl, {
      method: 'POST',
      headers: { 'Content-Type': item.contentType },
      body: readFileSync(item.path),
    });
    if (!response.ok) throw new Error(`Upload failed for ${label(item)}: HTTP ${response.status}`);
    const { storageId } = (await response.json()) as { storageId: string };
    if (item.kind === 'download') convexRun('tracks:attachDownload', { slug: config.slug, file: storageId });
    else convexRun('tracks:attachTrackFile', { slug: config.slug, position: item.position, kind: item.kind, file: storageId });
    console.log(`  uploaded   ${label(item)}`);
  }
  console.log('Done.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

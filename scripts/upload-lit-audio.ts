/**
 * Uploads the LIT audio to Cloudflare R2 and seeds the Convex `tracks` table.
 *
 *   npm run upload:audio -- --dry-run            # plan only, no credentials needed
 *   npm run upload:audio                         # upload + seed the dev deployment
 *   npm run upload:audio -- --prod               # upload + seed production
 *   npm run upload:audio -- --cors               # also apply the bucket CORS rules
 *   npm run upload:audio -- --source "<folder>"  # override the masters folder
 *   npm run upload:audio -- --seed-only          # seed Convex tracks without touching R2
 *
 * R2 credentials come from .env.local (R2_ENDPOINT, R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY).
 * Safe to rerun: objects whose MD5 already matches are skipped, and the seed upserts by position.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  HeadObjectCommand,
  PutBucketCorsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

type TrackConfig = { position: number; title: string; file: string; streamKey: string; originalKey?: string };
type Config = {
  slug: string;
  defaultSourceDir: string;
  zipName: string;
  zipKey: string;
  tracks: TrackConfig[];
  corsOrigins: string[];
};

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

function probeDuration(path: string): number {
  const out = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], {
    encoding: 'utf8',
  });
  return Math.round(Number.parseFloat(out.trim()) * 100) / 100;
}

function md5(path: string): string {
  return createHash('md5').update(readFileSync(path)).digest('hex');
}

function contentType(key: string): string {
  if (key.endsWith('.mp3')) return 'audio/mpeg';
  if (key.endsWith('.wav')) return 'audio/wav';
  return 'application/zip';
}

type Upload = { key: string; path: string; disposition?: string };

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
      streamPath = join(cacheDir, track.streamKey.split('/').pop()!);
      if (!existsSync(streamPath) || statSync(streamPath).mtimeMs < statSync(source).mtimeMs) {
        execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', source, '-codec:a', 'libmp3lame', '-b:a', '320k', streamPath]);
      }
      uploads.push({ key: track.originalKey!, path: source });
    }
    uploads.push({ key: track.streamKey, path: streamPath });
    const extension = track.file.slice(track.file.lastIndexOf('.'));
    const numbered = `${String(track.position).padStart(2, '0')} - ${track.title.replace(/[/\\:]/g, '-')}${extension}`;
    copyFileSync(source, join(zipStaging, numbered));
    seedTracks.push({
      position: track.position,
      title: track.title,
      durationSeconds: probeDuration(streamPath),
      streamKey: track.streamKey,
      originalKey: track.originalKey ?? track.streamKey,
    });
  }

  const zipPath = join(cacheDir, config.zipName);
  rmSync(zipPath, { force: true });
  execFileSync('zip', ['-q', '-j', '-X', zipPath, ...readdirSorted(zipStaging).map((file) => join(zipStaging, file))]);
  uploads.push({ key: config.zipKey, path: zipPath, disposition: `attachment; filename="${config.zipName}"` });
  return { uploads, seedTracks };
}

function readdirSorted(dir: string): string[] {
  return execFileSync('ls', ['-1', dir], { encoding: 'utf8' }).trim().split('\n').sort();
}

function r2Client() {
  try {
    process.loadEnvFile(join(root, '.env.local'));
  } catch {
    // Fall back to the shell environment.
  }
  const missing = ['R2_ENDPOINT', 'R2_BUCKET', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'].filter((key) => !process.env[key]);
  if (missing.length) throw new Error(`Missing in .env.local: ${missing.join(', ')}`);
  return {
    bucket: process.env.R2_BUCKET!,
    client: new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT!,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    }),
  };
}

async function upload(client: S3Client, bucket: string, item: Upload) {
  const hash = md5(item.path);
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: item.key }));
    if (head.ETag?.replaceAll('"', '') === hash) return 'unchanged';
  } catch {
    // Not uploaded yet.
  }
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: item.key,
      Body: readFileSync(item.path),
      ContentType: contentType(item.key),
      ContentDisposition: item.disposition,
      CacheControl: 'private, max-age=3600',
    }),
  );
  return 'uploaded';
}

async function main() {
  const { uploads, seedTracks } = prepare();
  const megabytes = (path: string) => (statSync(path).size / 1e6).toFixed(1);

  console.log(`Masters: ${sourceDir}`);
  for (const item of uploads) console.log(`  ${item.key}  (${megabytes(item.path)} MB)`);
  console.log('Tracks:');
  for (const track of seedTracks) console.log(`  ${track.position}. ${track.title}  ${track.durationSeconds}s`);
  if (dryRun) {
    console.log('Dry run: nothing uploaded or seeded.');
    return;
  }

  const convexArgs = ['convex', 'run', ...(prod ? ['--prod'] : []), 'tracks:seed', JSON.stringify({ slug: config.slug, tracks: seedTracks })];
  if (flag('--seed-only')) {
    console.log(execFileSync('npx', convexArgs, { cwd: root, encoding: 'utf8' }).trim());
    return;
  }

  const { client, bucket } = r2Client();
  if (flag('--cors')) {
    await client.send(
      new PutBucketCorsCommand({
        Bucket: bucket,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedOrigins: config.corsOrigins,
              AllowedMethods: ['GET', 'HEAD'],
              AllowedHeaders: ['Range'],
              ExposeHeaders: ['Content-Length', 'Content-Range', 'Accept-Ranges', 'ETag'],
              MaxAgeSeconds: 3600,
            },
          ],
        },
      }),
    );
    console.log(`CORS set for ${config.corsOrigins.join(', ')}`);
  }
  for (const item of uploads) console.log(`  ${await upload(client, bucket, item)}  ${item.key}`);

  console.log(execFileSync('npx', convexArgs, { cwd: root, encoding: 'utf8' }).trim());
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

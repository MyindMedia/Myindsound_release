/**
 * Dev only (`npm run dev`, then `/admin?mock=1`): the release portal against an in-memory server, so the whole
 * flow (uploads, casing, spin render, bundle, publish) can be driven without Clerk or a deployment, and nothing is
 * written anywhere. It applies the real rules from `convex/releasesLogic.ts` (design, hash, file checks, publish
 * preconditions). Never imported by a production build: admin.ts loads it behind `import.meta.env.DEV`.
 */
import type { Id } from '../convex/_generated/dataModel';
import {
  buildDesign,
  checkCoverSize,
  checkDraftFacts,
  checkUpload,
  designHash,
  imageSize,
  publishProblems,
  refreshDesign,
  type ReleaseFacts,
  type SpriteMeta,
  type UploadPurpose,
} from '../convex/releasesLogic';
import type { DiscDesign } from '../packages/minidisc/src/design';
import type { DraftRow, PortalBackend } from './admin-releases-backend';

type Track = { id: string; position: number; title: string; durationSeconds: number; file: string | null };
type Release = {
  releaseId: string;
  slug: string;
  title: string;
  artist: string;
  year: number;
  status: 'draft' | 'scheduled' | 'live';
  active: boolean;
  dropAt: number | null;
  createdAt: number;
  tracks: Track[];
  cover: string | null;
  design: DiscDesign | null;
  designHash: string | null;
  designRev: number;
  rack: { sprite: string; meta: SpriteMeta; still: string; designHash: string } | null;
  bundle: { version: string; file: string; sha256: string; designHash: string } | null;
};

const fail = (message: string): never => {
  throw new Error(message);
};

export function mockBackend(): PortalBackend {
  const files = new Map<string, Blob>();
  const urls = new Map<string, string>();
  const releases = new Map<string, Release>();
  let ids = 0;
  const nextId = (prefix: string) => `${prefix}${++ids}`;
  const urlOf = (id: string | null) => {
    if (!id) return null;
    if (!urls.has(id)) urls.set(id, URL.createObjectURL(files.get(id)!));
    return urls.get(id)!;
  };
  const release = (slug: string) => releases.get(slug) ?? fail(`No release with slug ${slug}.`);
  const draft = (slug: string) => {
    const row = release(slug);
    if (row.status !== 'draft') fail(`${slug} is already published. The portal edits drafts only; use RELEASE settings.`);
    return row;
  };
  const facts = (row: Release): ReleaseFacts | null => {
    const coverUrl = urlOf(row.cover);
    if (!coverUrl || row.tracks.length === 0) return null;
    return {
      slug: row.slug,
      title: row.title,
      artist: row.artist,
      year: row.year,
      coverUrl,
      tracks: row.tracks.map((t) => ({ n: t.position, title: t.title, durationSec: t.durationSeconds })),
    };
  };
  const sync = async (row: Release) => {
    if (!row.design) return;
    const f = facts(row);
    const rebuilt = f ? buildDesign(refreshDesign(row.design, f), f) : null;
    const hash = rebuilt?.ok ? await designHash(rebuilt.design) : null;
    if (hash === row.designHash) return;
    if (rebuilt?.ok) row.design = rebuilt.design;
    row.designHash = hash;
    row.designRev += 1;
  };
  const check = async (id: string, purpose: UploadPurpose) => {
    const blob = files.get(id) ?? fail('The upload was not found.');
    const head = new Uint8Array(await blob.slice(0, 512 * 1024).arrayBuffer());
    const result = checkUpload(purpose, { size: blob.size, contentType: blob.type }, head);
    if ('error' in result) {
      files.delete(id);
      fail(result.error);
    }
    return { head, kind: (result as { kind: 'png' }).kind, size: blob.size };
  };
  const state = (row: Release) => ({
    status: row.status,
    tracks: row.tracks.map((t) => ({ position: t.position, hasAudio: Boolean(t.file), durationSeconds: t.durationSeconds })),
    hasCover: Boolean(row.cover),
    designHash: row.designHash,
    rackDesignHash: row.rack?.designHash ?? null,
    bundleDesignHash: row.bundle?.designHash ?? null,
  });
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  const backend: PortalBackend = {
    async drafts() {
      return [...releases.values()]
        .filter((row) => row.status === 'draft')
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((row): DraftRow => {
          const s = state(row);
          return {
            slug: row.slug,
            title: row.title,
            artist: row.artist,
            year: row.year,
            createdAt: row.createdAt,
            tracks: row.tracks.length,
            tracksWithAudio: row.tracks.filter((t) => t.file).length,
            hasCover: s.hasCover,
            hasDesign: s.designHash !== null,
            rackFresh: s.designHash !== null && s.rackDesignHash === s.designHash,
            bundleFresh: s.designHash !== null && s.bundleDesignHash === s.designHash,
            ready: publishProblems(s).length === 0,
          };
        });
    },
    async get(slug) {
      const row = release(slug);
      return {
        releaseId: row.releaseId as Id<'products'>,
        slug: row.slug,
        title: row.title,
        artist: row.artist,
        year: row.year,
        status: row.status,
        active: row.active,
        dropAt: row.dropAt,
        tracks: row.tracks.map((t) => ({
          id: t.id as Id<'tracks'>,
          position: t.position,
          title: t.title,
          durationSeconds: t.durationSeconds,
          hasAudio: Boolean(t.file),
        })),
        coverUrl: urlOf(row.cover),
        design: row.design,
        designHash: row.designHash,
        designRev: row.designRev,
        rack: row.rack ? { spriteUrl: urlOf(row.rack.sprite), spriteMeta: row.rack.meta, stillUrl: urlOf(row.rack.still), fresh: row.rack.designHash === row.designHash } : null,
        bundle: row.bundle
          ? { version: row.bundle.version, url: urlOf(row.bundle.file)!, sha256: row.bundle.sha256, fresh: row.bundle.designHash === row.designHash }
          : null,
        problems: publishProblems(state(row)),
      };
    },
    async createDraft(args) {
      const problems = checkDraftFacts({ ...args, slug: args.slug.trim(), title: args.title.trim(), artist: args.artist.trim() });
      if (problems.length) fail(problems.join(' '));
      if (releases.has(args.slug.trim()) || args.slug.trim() === 'lit') fail(`The slug ${args.slug} is taken.`);
      const releaseId = nextId('mockrelease');
      releases.set(args.slug.trim(), {
        releaseId,
        slug: args.slug.trim(),
        title: args.title.trim(),
        artist: args.artist.trim(),
        year: args.year,
        status: 'draft',
        active: false,
        dropAt: null,
        createdAt: Date.now(),
        tracks: [],
        cover: null,
        design: null,
        designHash: null,
        designRev: 0,
        rack: null,
        bundle: null,
      });
      return { slug: args.slug.trim(), releaseId: releaseId as Id<'products'>, auditId: nextId('audit') as Id<'auditLog'> };
    },
    async upload(slug, blob, contentType, onProgress) {
      draft(slug);
      for (let step = 1; step <= 5; step++) {
        await wait(60);
        onProgress?.(step / 5);
      }
      const id = nextId('mockfile');
      files.set(id, new Blob([blob], { type: contentType }));
      return id as Id<'_storage'>;
    },
    async attachTrackAudio(args) {
      const row = draft(args.slug);
      await check(args.file, 'audio');
      const title = (args.title ?? '').trim();
      if (args.trackId) {
        const track = row.tracks.find((t) => t.id === args.trackId) ?? fail('That track is not on this release.');
        track.file = args.file;
        track.durationSeconds = Math.round(args.durationSec * 100) / 100;
        await sync(row);
        return { trackId: track.id as Id<'tracks'>, position: track.position, title: track.title };
      }
      const position = row.tracks.reduce((max, t) => Math.max(max, t.position), 0) + 1;
      const track = { id: nextId('mocktrack'), position, title: title || `Track ${position}`, durationSeconds: Math.round(args.durationSec * 100) / 100, file: args.file };
      row.tracks.push(track);
      await sync(row);
      return { trackId: track.id as Id<'tracks'>, position, title: track.title };
    },
    async setTracks(args) {
      const row = draft(args.slug);
      const kept = args.tracks.map(({ trackId, title }, i) => {
        const track = row.tracks.find((t) => t.id === trackId) ?? fail('A track in the list is not on this release.');
        if (!title.trim()) fail('Every track needs a title.');
        return { ...track, position: i + 1, title: title.trim() };
      });
      const removed = row.tracks.length - kept.length;
      row.tracks = kept;
      await sync(row);
      return { tracks: kept.length, removed, auditId: nextId('audit') as Id<'auditLog'> };
    },
    async attachCover(args) {
      const row = draft(args.slug);
      const { head, kind } = await check(args.file, 'cover');
      const size = imageSize(head, kind);
      const problem = checkCoverSize(size);
      if (problem || !size) {
        files.delete(args.file);
        return fail(problem ?? 'Could not read the image size.');
      }
      row.cover = args.file;
      await sync(row);
      return { coverUrl: urlOf(row.cover)!, ...size };
    },
    async saveDesign(args) {
      const row = draft(args.slug);
      const f = facts(row) ?? fail('Upload the tracks and the cover before the casing.');
      const result = buildDesign(args.design, f);
      if (!result.ok) return fail(`The design is not valid: ${result.errors.slice(0, 8).join('; ')}`);
      const hash = await designHash(result.design);
      const changed = hash !== row.designHash;
      if (changed) {
        row.design = result.design;
        row.designHash = hash;
        row.designRev += 1;
      }
      return { designHash: hash, designRev: row.designRev, changed, design: result.design, auditId: nextId('audit') as Id<'auditLog'> };
    },
    async attachRackArt(args) {
      const row = draft(args.slug);
      if (args.spriteWebp) await check(args.spriteWebp, 'spriteWebp');
      await check(args.spritePng, 'spritePng');
      await check(args.still, 'still');
      if (row.designHash !== args.designHash) fail('The casing changed since this render. Render the rack art again.');
      row.rack = { sprite: args.spriteWebp ?? args.spritePng, meta: args.spriteMeta, still: args.still, designHash: args.designHash };
      return { designHash: args.designHash };
    },
    async attachBundle(args) {
      const row = draft(args.slug);
      await check(args.zip, 'bundle');
      if (row.designHash !== args.designHash) fail('The casing changed since this bundle was built. Build it again.');
      row.bundle = { version: args.version, file: args.zip, sha256: args.sha256, designHash: args.designHash };
      return { version: args.version, url: urlOf(args.zip)!, sha256: args.sha256 };
    },
    async publish(args) {
      const row = release(args.slug);
      const problems = publishProblems(state(row));
      if (problems.length) fail(`Not ready to publish. ${problems.join(' ')}`);
      if (!args.reason.trim()) fail('A reason is required.');
      const now = Date.now();
      if (args.status === 'scheduled' && (!args.dropAt || args.dropAt <= now)) fail('Scheduling a release needs a dropAt in the future.');
      row.status = args.status;
      row.dropAt = args.dropAt ?? now;
      row.active = true;
      return { slug: row.slug, status: row.status, dropAt: row.dropAt, auditId: nextId('audit') as Id<'auditLog'> };
    },
  };
  return backend;
}

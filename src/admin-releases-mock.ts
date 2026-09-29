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
  checkRackParts,
  publishProblems,
  refreshDesign,
  MAX_IMAGE_STICKERS,
  MAX_SHUTTER_IMAGE_STICKERS,
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
  /** Uploaded sticker image files, storage-id-shaped local keys (see `files`). */
  stickers: string[];
  /** The uploaded label image's file (`design.labelImage`), or null. */
  label: string | null;
  design: DiscDesign | null;
  designHash: string | null;
  designRev: number;
  rack: { still: string; stillWebp: string | null; sprite: string | null; meta: SpriteMeta | null; designHash: string } | null;
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
      stickerUrls: row.stickers.map((id) => urlOf(id)!),
      labelUrl: urlOf(row.label),
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
    rackHasStill: Boolean(row.rack?.still),
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
        stickerFiles: row.stickers.map((id) => ({ file: id as Id<'_storage'>, url: urlOf(id)! })),
        labelUrl: urlOf(row.label),
        design: row.design,
        designHash: row.designHash,
        designRev: row.designRev,
        rack: row.rack
          ? { stillUrl: urlOf(row.rack.still), stillWebpUrl: urlOf(row.rack.stillWebp), spriteUrl: urlOf(row.rack.sprite), spriteMeta: row.rack.meta, fresh: row.rack.designHash === row.designHash }
          : null,
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
        stickers: [],
        label: null,
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
    async attachSticker(args) {
      const row = draft(args.slug);
      await check(args.file, 'sticker');
      if (Math.max(row.stickers.length, row.design?.stickers?.length ?? 0) >= MAX_IMAGE_STICKERS) {
        files.delete(args.file);
        return fail(`A release has at most ${MAX_IMAGE_STICKERS} stickers.`);
      }
      const existing = ((row.design?.stickers ?? []) as { kind: string; area?: string }[]).filter((s) => s.kind === 'image');
      if (args.area === 'shutter' && existing.filter((s) => s.area === 'shutter').length >= MAX_SHUTTER_IMAGE_STICKERS) {
        files.delete(args.file);
        return fail(`The slide cover has at most ${MAX_SHUTTER_IMAGE_STICKERS} image stickers.`);
      }
      const f = facts(row);
      if (!f) {
        files.delete(args.file);
        return fail('Upload the tracks and the cover before stickers.');
      }
      row.stickers.push(args.file);
      const url = urlOf(args.file)!;
      const sticker = { kind: 'image', src: url, area: args.area, x: 0.5, y: 0.5, size: 0.25, rotation: 0 };
      // `facts()` read `row.stickers` before the push above, so it does not carry `url` yet either.
      const result = buildDesign({ ...(row.design ?? {}), stickers: [...(row.design?.stickers ?? []), sticker] }, { ...f, stickerUrls: [...f.stickerUrls, url] });
      if (!result.ok) {
        row.stickers.pop();
        files.delete(args.file);
        return fail(`Could not place the sticker: ${result.errors.slice(0, 8).join('; ')}`);
      }
      row.design = result.design;
      row.designHash = await designHash(result.design);
      row.designRev += 1;
      return { url, file: args.file as Id<'_storage'> };
    },
    async removeSticker(args) {
      const row = draft(args.slug);
      if (!row.stickers.includes(args.file)) fail('That sticker is not on this release.');
      const url = urlOf(args.file);
      row.stickers = row.stickers.filter((id) => id !== args.file);
      const existing = (row.design?.stickers ?? []) as { kind: string; src?: string }[];
      const kept = existing.filter((s) => !(s.kind === 'image' && s.src === url));
      if (row.design) {
        row.design = { ...row.design, stickers: kept.length > 0 ? (kept as DiscDesign['stickers']) : undefined };
        row.designHash = await designHash(row.design);
        row.designRev += 1;
      }
      files.delete(args.file);
      return null;
    },
    async attachLabel(args) {
      const row = draft(args.slug);
      await check(args.file, 'label');
      const f = facts(row);
      if (!f) {
        files.delete(args.file);
        return fail('Upload the tracks and the cover before the label.');
      }
      const url = urlOf(args.file)!;
      const previous = row.design?.labelImage;
      const place = previous ? { x: previous.x, y: previous.y, size: previous.size, rotation: previous.rotation ?? 0 } : { x: 0.5, y: 0.5, size: 0.9, rotation: 0 };
      const result = buildDesign({ ...(row.design ?? {}), labelImage: { src: url, ...place } }, { ...f, labelUrl: url });
      if (!result.ok) {
        files.delete(args.file);
        return fail(`Could not place the label: ${result.errors.slice(0, 8).join('; ')}`);
      }
      if (row.label && row.label !== args.file) files.delete(row.label);
      row.label = args.file;
      row.design = result.design;
      row.designHash = await designHash(result.design);
      row.designRev += 1;
      return { url, file: args.file as Id<'_storage'> };
    },
    async removeLabel(args) {
      const row = draft(args.slug);
      if (!row.label) fail('This release has no label image.');
      if (row.design) {
        const { labelImage: _dropped, ...rest } = row.design;
        row.design = rest as DiscDesign;
        row.designHash = await designHash(row.design);
        row.designRev += 1;
      }
      files.delete(row.label!);
      row.label = null;
      return null;
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
      const parts = checkRackParts({
        still: Boolean(args.still),
        stillWebp: Boolean(args.stillWebp),
        spriteWebp: Boolean(args.spriteWebp),
        spritePng: Boolean(args.spritePng),
        spriteMeta: Boolean(args.spriteMeta),
      });
      if (parts) fail(parts);
      await check(args.still, 'still');
      if (args.stillWebp) await check(args.stillWebp, 'stillWebp');
      if (args.spriteWebp) await check(args.spriteWebp, 'spriteWebp');
      if (args.spritePng) await check(args.spritePng, 'spritePng');
      if (row.designHash !== args.designHash) fail('The casing changed since this render. Render the rack art again.');
      row.rack = {
        still: args.still,
        stillWebp: args.stillWebp ?? null,
        sprite: args.spriteWebp ?? args.spritePng ?? null,
        meta: args.spriteMeta ?? null,
        designHash: args.designHash,
      };
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

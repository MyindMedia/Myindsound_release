/**
 * What the release portal needs from the server (convex/releases.ts). The real one is Convex; the dev-only mock
 * (`admin-releases-mock.ts`, `/admin?mock=1` under `npm run dev`) keeps everything in memory.
 */
import type { FunctionArgs, FunctionReturnType } from 'convex/server';
import type { Id } from '../convex/_generated/dataModel';
import { api, getConvex } from './convex';

export type ReleaseState = FunctionReturnType<typeof api.releases.get>;
export type DraftRow = FunctionReturnType<typeof api.releases.drafts>[number];
type Args<K extends keyof typeof api.releases> = FunctionArgs<(typeof api.releases)[K]>;
type Result<K extends keyof typeof api.releases> = FunctionReturnType<(typeof api.releases)[K]>;

export interface PortalBackend {
  drafts(): Promise<DraftRow[]>;
  get(slug: string): Promise<ReleaseState>;
  createDraft(args: Args<'createDraft'>): Promise<Result<'createDraft'>>;
  /** POSTs one file to storage, reporting progress 0..1, and returns its storage id. */
  upload(slug: string, blob: Blob, contentType: string, onProgress?: (fraction: number) => void): Promise<Id<'_storage'>>;
  attachTrackAudio(args: Args<'attachTrackAudio'>): Promise<Result<'attachTrackAudio'>>;
  setTracks(args: Args<'setTracks'>): Promise<Result<'setTracks'>>;
  attachCover(args: Args<'attachCover'>): Promise<Result<'attachCover'>>;
  saveDesign(args: Args<'saveDesign'>): Promise<Result<'saveDesign'>>;
  attachRackArt(args: Args<'attachRackArt'>): Promise<Result<'attachRackArt'>>;
  attachBundle(args: Args<'attachBundle'>): Promise<Result<'attachBundle'>>;
  publish(args: Args<'publish'>): Promise<Result<'publish'>>;
}

/** XHR, not fetch: fetch can't report upload progress. */
export function postFile(url: string, blob: Blob, contentType: string, onProgress?: (fraction: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve((JSON.parse(xhr.responseText) as { storageId: string }).storageId);
        } catch {
          reject(new Error('The upload finished but storage sent no id.'));
        }
      } else reject(new Error(`The upload failed (HTTP ${xhr.status}).`));
    };
    xhr.onerror = () => reject(new Error('The upload failed: network error.'));
    xhr.send(blob);
  });
}

export function convexBackend(): PortalBackend {
  const convex = getConvex();
  const r = api.releases;
  return {
    drafts: () => convex.query(r.drafts, {}),
    get: (slug) => convex.query(r.get, { slug }),
    createDraft: (args) => convex.mutation(r.createDraft, args),
    async upload(slug, blob, contentType, onProgress) {
      const url = await convex.mutation(r.generateUploadUrl, { slug });
      return (await postFile(url, blob, contentType, onProgress)) as Id<'_storage'>;
    },
    attachTrackAudio: (args) => convex.action(r.attachTrackAudio, args),
    setTracks: (args) => convex.mutation(r.setTracks, args),
    attachCover: (args) => convex.action(r.attachCover, args),
    saveDesign: (args) => convex.mutation(r.saveDesign, args),
    attachRackArt: (args) => convex.action(r.attachRackArt, args),
    attachBundle: (args) => convex.action(r.attachBundle, args),
    publish: (args) => convex.mutation(r.publish, args),
  };
}

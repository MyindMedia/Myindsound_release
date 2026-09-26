import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { action, httpAction, internalQuery, type QueryCtx } from './_generated/server';
import { isPrelaunch } from './lib/editions';
import { fail, type ErrorCode } from './lib/errors';
import { heldCopy, lendOutFor } from './wear';

/**
 * Gated audio for the app (AUD-1 option (a), AUD-2, ARCH-4).
 *
 * `getStreamUrl` checks the licence (or lend) and returns a 5 minute URL to the HTTP route `/media/stream?t=…`.
 * The token is an HMAC-SHA256 signed payload binding one track, one account and an expiry; the route verifies
 * it, checks access again, and serves that one track's storage blob with byte ranges. The permanent Convex
 * storage link never leaves the server.
 *
 * Config (Convex env):
 * - `MEDIA_TOKEN_SECRET`: required, at least 32 characters. Rotating it invalidates every outstanding URL.
 * - `AUDIO_DELIVERY`: `proxy` (default, this file) or `r2`. `r2` is the switch for AUD-1 option (b): implement
 *   `r2StreamUrl` with `@convex-dev/r2` presigned URLs and nothing else in the app changes.
 * - `CONVEX_SITE_URL`: set by Convex on every deployment; the route's origin.
 */

/** AUD-2: stream URLs live for 5 minutes. A range request that starts inside the window completes. */
export const STREAM_URL_TTL_MS = 5 * 60 * 1000;
/**
 * Largest body one response carries. Convex HTTP action responses are capped (20 MB), so an open ended or
 * oversized range gets this much and the player asks for the rest (a valid 206 per RFC 9110).
 */
export const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MIN_SECRET_LENGTH = 32;
const TOKEN_VERSION = 1;

export type AudioDelivery = 'proxy' | 'r2';

export function audioDelivery(): AudioDelivery {
  return process.env.AUDIO_DELIVERY === 'r2' ? 'r2' : 'proxy';
}

// ---------------------------------------------------------------------------------------------------------------
// Tokens (pure, WebCrypto)

export type MediaClaims = { trackId: string; userId: string; exp: number; lendId?: string };

const encoder = new TextEncoder();

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/** `<base64url(JSON payload)>.<base64url(HMAC-SHA256 of the first part)>`. */
export async function signMediaToken(claims: MediaClaims, secret: string): Promise<string> {
  const payload = toBase64Url(
    encoder.encode(
      JSON.stringify({ v: TOKEN_VERSION, trk: claims.trackId, usr: claims.userId, exp: claims.exp, lnd: claims.lendId }),
    ),
  );
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(new Uint8Array(signature))}`;
}

/** The claims of a genuine, unexpired token, or null. The signature check is constant time (WebCrypto verify). */
export async function verifyMediaToken(token: string, secret: string, now: number): Promise<MediaClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payload, signatureText] = parts;
  const signature = fromBase64Url(signatureText);
  if (!signature || signature.length !== 32) return null;
  const genuine = await crypto.subtle.verify('HMAC', await hmacKey(secret), signature, encoder.encode(payload));
  if (!genuine) return null;
  const bytes = fromBase64Url(payload);
  if (!bytes) return null;
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const d = data as { v?: unknown; trk?: unknown; usr?: unknown; exp?: unknown; lnd?: unknown };
  if (d.v !== TOKEN_VERSION || typeof d.trk !== 'string' || typeof d.usr !== 'string' || typeof d.exp !== 'number') {
    return null;
  }
  if (d.lnd !== undefined && typeof d.lnd !== 'string') return null;
  if (!(now < d.exp)) return null;
  return { trackId: d.trk, userId: d.usr, exp: d.exp, ...(typeof d.lnd === 'string' ? { lendId: d.lnd } : {}) };
}

function mediaSecret(): string | null {
  const secret = process.env.MEDIA_TOKEN_SECRET;
  return secret && secret.length >= MIN_SECRET_LENGTH ? secret : null;
}

// ---------------------------------------------------------------------------------------------------------------
// Byte ranges (pure)

export type ByteRange = { start: number; end: number };

/**
 * One `Range: bytes=…` header against a blob of `size` bytes (RFC 9110 §14). Returns:
 * - `null`: no header, or one this server ignores (malformed, several ranges, another unit): serve 200 in full;
 * - `'unsatisfiable'`: 416;
 * - `{ start, end }` (inclusive), with `end` capped so the body is at most `maxBytes`.
 */
export function parseRange(header: string | null, size: number, maxBytes = MAX_RANGE_BYTES): ByteRange | 'unsatisfiable' | null {
  if (header === null) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  let start: number;
  let end: number;
  if (first === '') {
    if (last === '') return null;
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return 'unsatisfiable';
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === '' ? size - 1 : Number(last);
    if (last !== '' && end < start) return null;
    if (start >= size) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }
  return { start, end: Math.min(end, start + maxBytes - 1) };
}

// ---------------------------------------------------------------------------------------------------------------
// Access

type Access =
  | { ok: true; userId: Id<'users'>; trackId: Id<'tracks'>; storageId: Id<'_storage'> }
  | { ok: false; code: ErrorCode; message: string };

/**
 * AUD-2: the caller may stream this track when they hold a live licence for its release (or an active lend of
 * one, with `lendId`), the release has dropped, and the audio exists. An owner whose copy is out on a lend
 * can't play it (LOCK_WHILE_LENT; TODO(lends): `lendOutFor` is a stub).
 */
async function streamAccess(
  ctx: QueryCtx,
  userId: Id<'users'>,
  trackIdText: string,
  lendId: string | undefined,
  now: number,
): Promise<Access> {
  const trackId = ctx.db.normalizeId('tracks', trackIdText);
  const track = trackId ? await ctx.db.get(trackId) : null;
  if (!track) return { ok: false, code: 'NOT_FOUND', message: 'Track not found.' };
  const product = await ctx.db.get(track.productId);
  if (!product) return { ok: false, code: 'NOT_FOUND', message: 'Track not found.' };
  // [DECIDE] Presale owners hear nothing before the drop either: drops are events (DROP-1).
  if (isPrelaunch(product, now)) return { ok: false, code: 'NOT_YET_LIVE', message: 'This release is not out yet.' };
  const copy = await heldCopy(ctx, userId, product._id, lendId);
  if (!copy) return { ok: false, code: 'NOT_ENTITLED', message: 'No license found for this release.' };
  if (!copy.lend && (await lendOutFor(ctx, copy.entitlement._id))) {
    return { ok: false, code: 'NOT_ENTITLED', message: 'Your copy is out on loan.' };
  }
  if (!track.streamFile) return { ok: false, code: 'NOT_CONFIGURED', message: 'The audio has not been uploaded yet.' };
  return { ok: true, userId, trackId: track._id, storageId: track.streamFile };
}

export const accessForClerk = internalQuery({
  args: { clerkId: v.string(), trackId: v.string(), lendId: v.optional(v.string()) },
  handler: async (ctx, { clerkId, trackId, lendId }): Promise<Access> => {
    const user = await ctx.db
      .query('users')
      .withIndex('by_clerkId', (q) => q.eq('clerkId', clerkId))
      .unique();
    if (!user) return { ok: false, code: 'NOT_ENTITLED', message: 'No license found for this release.' };
    return await streamAccess(ctx, user._id, trackId, lendId, Date.now());
  },
});

export const accessForToken = internalQuery({
  args: { userId: v.string(), trackId: v.string(), lendId: v.optional(v.string()) },
  handler: async (ctx, { userId, trackId, lendId }): Promise<Access> => {
    const id = ctx.db.normalizeId('users', userId);
    const user = id ? await ctx.db.get(id) : null;
    if (!user) return { ok: false, code: 'NOT_ENTITLED', message: 'No license found for this release.' };
    return await streamAccess(ctx, user._id, trackId, lendId, Date.now());
  },
});

/** AUD-1 option (b). TODO(r2): presign `tracks.audioKey` with `@convex-dev/r2` for STREAM_URL_TTL_MS. */
function r2StreamUrl(): never {
  fail('NOT_CONFIGURED', 'R2 audio delivery is not set up yet.');
}

/** AUD-2: `{ url, expiresAt }` for one track, valid 5 minutes, after the licence or lend check. */
export const getStreamUrl = action({
  args: { trackId: v.string(), lendId: v.optional(v.string()) },
  handler: async (ctx, { trackId, lendId }): Promise<{ url: string; expiresAt: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) fail('UNAUTHENTICATED', 'Sign in to listen.');
    const access = await ctx.runQuery(internal.media.accessForClerk, { clerkId: identity.subject, trackId, lendId });
    if (!access.ok) fail(access.code, access.message);
    if (audioDelivery() === 'r2') r2StreamUrl();
    const secret = mediaSecret();
    const origin = process.env.CONVEX_SITE_URL;
    if (!secret || !origin) fail('NOT_CONFIGURED', 'Audio streaming is not configured.');
    const expiresAt = Date.now() + STREAM_URL_TTL_MS;
    const token = await signMediaToken(
      { trackId: access.trackId, userId: access.userId, exp: expiresAt, ...(lendId ? { lendId } : {}) },
      secret,
    );
    return { url: `${origin.replace(/\/$/, '')}/media/stream?t=${token}`, expiresAt };
  },
});

// ---------------------------------------------------------------------------------------------------------------
// HTTP route (registered in http.ts)

const NO_STORE = { 'Cache-Control': 'private, no-store' };

function plain(status: number, body: string, headers: Record<string, string> = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...NO_STORE, ...headers } });
}

/** GET /media/stream?t=<token>: the token's one track, with byte ranges (206, Content-Range, Accept-Ranges). */
export const streamTrack = httpAction(async (ctx, request) => {
  const token = new URL(request.url).searchParams.get('t');
  if (!token) return plain(400, 'Missing token');
  const secret = mediaSecret();
  if (!secret) return plain(503, 'Not configured');
  const claims = await verifyMediaToken(token, secret, Date.now());
  if (!claims) return plain(403, 'Invalid or expired link');
  // Checked again on every request, so a refund or an ended lend stops playback inside the 5 minutes too.
  const access = await ctx.runQuery(internal.media.accessForToken, {
    userId: claims.userId,
    trackId: claims.trackId,
    lendId: claims.lendId,
  });
  if (!access.ok) return plain(403, 'No access');
  const blob = await ctx.storage.get(access.storageId);
  if (!blob) return plain(404, 'Not found');

  const size = blob.size;
  const common = {
    'Content-Type': blob.type || 'audio/mpeg',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    ...NO_STORE,
  };
  const range = parseRange(request.headers.get('Range'), size);
  if (range === 'unsatisfiable') return plain(416, 'Range not satisfiable', { 'Content-Range': `bytes */${size}` });
  if (range === null) {
    return new Response(blob, { status: 200, headers: { ...common, 'Content-Length': String(size) } });
  }
  const body = blob.slice(range.start, range.end + 1);
  return new Response(body, {
    status: 206,
    headers: {
      ...common,
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Content-Length': String(range.end - range.start + 1),
    },
  });
});

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import { MAX_RANGE_BYTES, parseRange, signMediaToken, STREAM_URL_TTL_MS, verifyMediaToken } from './media';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

const SECRET = 'test-media-secret-0123456789abcdef-0123456789';
const OTHER_SECRET = 'another-secret-0123456789abcdef-0123456789ab';
type T = ReturnType<typeof newTest>;

beforeEach(() => {
  vi.stubEnv('MEDIA_TOKEN_SECRET', SECRET);
  vi.stubEnv('CONVEX_SITE_URL', 'https://example.convex.site');
});
afterEach(() => {
  vi.unstubAllEnvs();
});

function b64url(text: string) {
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

describe('media tokens', () => {
  const now = 1_700_000_000_000;
  const claims = { trackId: 'track_a', userId: 'user_1', exp: now + STREAM_URL_TTL_MS };

  test('a signed token verifies and carries its claims', async () => {
    const token = await signMediaToken(claims, SECRET);
    expect(await verifyMediaToken(token, SECRET, now)).toEqual(claims);
    const lent = await signMediaToken({ ...claims, lendId: 'lend_9' }, SECRET);
    expect(await verifyMediaToken(lent, SECRET, now)).toEqual({ ...claims, lendId: 'lend_9' });
  });

  test('expired at exp, not before', async () => {
    const token = await signMediaToken(claims, SECRET);
    expect(await verifyMediaToken(token, SECRET, claims.exp - 1)).not.toBeNull();
    expect(await verifyMediaToken(token, SECRET, claims.exp)).toBeNull();
  });

  test('another secret, a tampered signature or a malformed token is refused', async () => {
    const token = await signMediaToken(claims, SECRET);
    expect(await verifyMediaToken(token, OTHER_SECRET, now)).toBeNull();
    const [payload, signature] = token.split('.');
    const flipped = signature.slice(0, -2) + (signature.endsWith('A') ? 'B' : 'A') + signature.slice(-1);
    expect(await verifyMediaToken(`${payload}.${flipped}`, SECRET, now)).toBeNull();
    for (const bad of ['', 'abc', `${payload}.`, `${payload}.${signature}.x`, `${payload}.!!`]) {
      expect(await verifyMediaToken(bad, SECRET, now)).toBeNull();
    }
  });

  test('track binding: the signature of one track never grants another, nor a later expiry or another user', async () => {
    const token = await signMediaToken(claims, SECRET);
    const [, signature] = token.split('.');
    const forge = (body: object) => `${b64url(JSON.stringify(body))}.${signature}`;
    const base = { v: 1, trk: 'track_a', usr: 'user_1', exp: claims.exp };
    expect(await verifyMediaToken(forge(base), SECRET, now)).toEqual(claims);
    expect(await verifyMediaToken(forge({ ...base, trk: 'track_b' }), SECRET, now)).toBeNull();
    expect(await verifyMediaToken(forge({ ...base, exp: claims.exp + 60_000 }), SECRET, now)).toBeNull();
    expect(await verifyMediaToken(forge({ ...base, usr: 'user_2' }), SECRET, now)).toBeNull();
  });
});

describe('parseRange', () => {
  test('closed, open ended and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=0-1', 1000)).toEqual({ start: 0, end: 1 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-5000', 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange('bytes=500-5000', 1000)).toEqual({ start: 500, end: 999 });
  });

  test('capped at the chunk size', () => {
    expect(parseRange('bytes=0-', 50_000_000)).toEqual({ start: 0, end: MAX_RANGE_BYTES - 1 });
    expect(parseRange('bytes=10-', 100, 20)).toEqual({ start: 10, end: 29 });
  });

  test('unsatisfiable ranges are 416', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=1000-2000', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 1000)).toBe('unsatisfiable');
    expect(parseRange('bytes=0-', 0)).toBe('unsatisfiable');
  });

  test('no header, malformed, reversed and multi ranges are ignored (200 in full)', () => {
    for (const header of [null, 'bytes=', 'bytes=-', 'items=0-1', 'bytes=5-1', 'bytes=0-1,5-6', 'bytes=a-b']) {
      expect(parseRange(header, 1000)).toBeNull();
    }
  });
});

async function streamPath(t: T, trackId: string) {
  const { url, expiresAt } = await t.withIdentity(OWNER).action(api.media.getStreamUrl, { trackId });
  expect(url.startsWith('https://example.convex.site/media/stream?t=')).toBe(true);
  expect(expiresAt - Date.now()).toBeGreaterThan(STREAM_URL_TTL_MS - 5000);
  expect(expiresAt - Date.now()).toBeLessThanOrEqual(STREAM_URL_TTL_MS);
  const parsed = new URL(url);
  return `${parsed.pathname}${parsed.search}`;
}

describe('media.getStreamUrl (AUD-2)', () => {
  test('owner gets a 5 minute link that is not a storage link', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t);
    const path = await streamPath(t, trackIds[0]);
    const storageUrl = await t.run(async (ctx) => ctx.storage.getUrl((await ctx.db.get(trackIds[0]))!.streamFile!));
    expect(path).not.toContain(storageUrl!);
  });

  test('stranger, signed out, lend (not built yet), unknown track and pre-drop are refused', async () => {
    const t = newTest();
    const { trackIds, litId } = await seedLitWithOwner(t);
    await expect(t.withIdentity(STRANGER).action(api.media.getStreamUrl, { trackId: trackIds[0] })).rejects.toThrow(
      /NOT_ENTITLED|No license/,
    );
    await expect(t.action(api.media.getStreamUrl, { trackId: trackIds[0] })).rejects.toThrow(/UNAUTHENTICATED|Sign in/);
    await expect(
      t.withIdentity(STRANGER).action(api.media.getStreamUrl, { trackId: trackIds[0], lendId: 'lend_1' }),
    ).rejects.toThrow(/NOT_ENTITLED|No license/);
    await expect(t.withIdentity(OWNER).action(api.media.getStreamUrl, { trackId: 'nope' })).rejects.toThrow(/NOT_FOUND/);
    await t.run((ctx) => ctx.db.patch(litId, { dropAt: Date.now() + 60 * 60 * 1000 }));
    await expect(t.withIdentity(OWNER).action(api.media.getStreamUrl, { trackId: trackIds[0] })).rejects.toThrow(
      /NOT_YET_LIVE|not out yet/,
    );
  });

  test('missing secret, a short secret, or the r2 switch without R2 set up is NOT_CONFIGURED', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t);
    vi.stubEnv('MEDIA_TOKEN_SECRET', 'short');
    await expect(t.withIdentity(OWNER).action(api.media.getStreamUrl, { trackId: trackIds[0] })).rejects.toThrow(/NOT_CONFIGURED/);
    vi.stubEnv('MEDIA_TOKEN_SECRET', SECRET);
    vi.stubEnv('AUDIO_DELIVERY', 'r2');
    await expect(t.withIdentity(OWNER).action(api.media.getStreamUrl, { trackId: trackIds[0] })).rejects.toThrow(
      /NOT_CONFIGURED|R2/,
    );
  });

  test('audio not uploaded yet is NOT_CONFIGURED', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t, { uploaded: false });
    await expect(t.withIdentity(OWNER).action(api.media.getStreamUrl, { trackId: trackIds[0] })).rejects.toThrow(/NOT_CONFIGURED/);
  });
});

describe('GET /media/stream', () => {
  test('serves the token track in full, and byte ranges as 206 with Content-Range', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t);
    const path = await streamPath(t, trackIds[0]);

    const full = await t.fetch(path);
    expect(full.status).toBe(200);
    expect(full.headers.get('Accept-Ranges')).toBe('bytes');
    expect(full.headers.get('Cache-Control')).toContain('no-store');
    expect(await full.text()).toBe('track 1');

    const head = await t.fetch(path, { headers: { Range: 'bytes=0-2' } });
    expect(head.status).toBe(206);
    expect(head.headers.get('Content-Range')).toBe('bytes 0-2/7');
    expect(head.headers.get('Content-Length')).toBe('3');
    expect(await head.text()).toBe('tra');

    const tail = await t.fetch(path, { headers: { Range: 'bytes=-3' } });
    expect(tail.status).toBe(206);
    expect(tail.headers.get('Content-Range')).toBe('bytes 4-6/7');
    expect(await tail.text()).toBe('k 1');

    const beyond = await t.fetch(path, { headers: { Range: 'bytes=50-' } });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('Content-Range')).toBe('bytes */7');
  });

  test('a token only ever serves its own track', async () => {
    const t = newTest();
    const { trackIds } = await seedLitWithOwner(t);
    const second = await streamPath(t, trackIds[1]);
    expect(await (await t.fetch(second)).text()).toBe('track 2');
    const tampered = second.replace(/t=([^.]+)\./, (_m, payload: string) => {
      const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
      return `t=${b64url(JSON.stringify({ ...json, trk: trackIds[0] }))}.`;
    });
    expect((await t.fetch(tampered)).status).toBe(403);
  });

  test('missing, forged and expired tokens are 400/403; a refund stops a live link', async () => {
    const t = newTest();
    const { trackIds, ownerId } = await seedLitWithOwner(t);
    expect((await t.fetch('/media/stream')).status).toBe(400);
    const forged = await signMediaToken({ trackId: trackIds[0], userId: ownerId, exp: Date.now() + 60_000 }, OTHER_SECRET);
    expect((await t.fetch(`/media/stream?t=${forged}`)).status).toBe(403);
    const expired = await signMediaToken({ trackId: trackIds[0], userId: ownerId, exp: Date.now() - 1 }, SECRET);
    expect((await t.fetch(`/media/stream?t=${expired}`)).status).toBe(403);

    const path = await streamPath(t, trackIds[0]);
    expect((await t.fetch(path)).status).toBe(200);
    await t.mutation(internal.fulfilment.revokeEntitlement, { source: 'stripe', sourceRef: 'cs_test_owner' });
    expect((await t.fetch(path)).status).toBe(403);
  });

  test('a genuine token for a stranger (no licence) is refused at the route too', async () => {
    const t = newTest();
    const { trackIds, strangerId } = await seedLitWithOwner(t);
    const token = await signMediaToken({ trackId: trackIds[0], userId: strangerId, exp: Date.now() + 60_000 }, SECRET);
    expect((await t.fetch(`/media/stream?t=${token}`)).status).toBe(403);
  });
});

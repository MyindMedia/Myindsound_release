import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { api, internal } from './_generated/api';
import {
  APPLE_INTERMEDIATE_OID,
  APPLE_LEAF_OID,
  APPLE_ROOT_CA_G3,
  APPLE_ROOT_CA_G3_SHA256,
  BUNDLE_ID,
  base64ToBytes,
  parseCertificate,
  setTrustAnchorsForTesting,
  verifyCertSignature,
  verifySignedData,
  type TrustAnchor,
} from './storekitLogic';
import { newTest, OWNER, seedLitWithOwner, STRANGER } from './test.setup';

/**
 * StoreKit 2 server verification (PRD §7.2, PAY-4..9). The tests build a throwaway CA, intermediate and leaf with
 * WebCrypto and a tiny DER encoder below, and inject the test root through `setTrustAnchorsForTesting` (a module
 * seam nothing outside the process can reach). The embedded Apple root and Apple's real WWDR G6 intermediate are
 * checked with the same parser, so the code that runs in production is exercised on real Apple certificates too.
 */

type T = ReturnType<typeof newTest>;
const THIRD = { subject: 'user_third', email: 'third@example.test', name: 'Third Person' };
const TIER1 = 'com.myindsound.app.lit.tier1';
const DAY = 24 * 60 * 60 * 1000;

/** Apple Worldwide Developer Relations CA G6, from https://www.apple.com/certificateauthority/AppleWWDRCAG6.cer. */
const APPLE_WWDR_G6_B64 =
  'MIIDFjCCApygAwIBAgIUIsGhRwp0c2nvU4YSycafPTjzbNcwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMjEwMzE3MjAzNzEwWhcNMzYwMzE5MDAwMDAwWjB1MUQwQgYDVQQDDDtBcHBsZSBXb3JsZHdpZGUgRGV2ZWxvcGVyIFJlbGF0aW9ucyBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTELMAkGA1UECwwCRzYxEzARBgNVBAoMCkFwcGxlIEluYy4xCzAJBgNVBAYTAlVTMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEbsQKC94PrlWmZXnXgtxzdVJL8T0SGYngDRGpngn3N6PT8JMEb7FDi4bBmPhCnZ3/sq6PF/cGcKXWsL5vOteRhyJ45x3ASP7cOB+aao90fcpxSv/EZFbniAbNgZGhIhpIo4H6MIH3MBIGA1UdEwEB/wQIMAYBAf8CAQAwHwYDVR0jBBgwFoAUu7DeoVgziJqkipnevr3rr9rLJKswRgYIKwYBBQUHAQEEOjA4MDYGCCsGAQUFBzABhipodHRwOi8vb2NzcC5hcHBsZS5jb20vb2NzcDAzLWFwcGxlcm9vdGNhZzMwNwYDVR0fBDAwLjAsoCqgKIYmaHR0cDovL2NybC5hcHBsZS5jb20vYXBwbGVyb290Y2FnMy5jcmwwHQYDVR0OBBYEFD8vlCNR01DJmig97bB85c+lkGKZMA4GA1UdDwEB/wQEAwIBBjAQBgoqhkiG92NkBgIBBAIFADAKBggqhkjOPQQDAwNoADBlAjBAXhSq5IyKogMCPtw490BaB677CaEGJXufQB/EqZGd6CSjiCtOnuMTbXVXmxxcxfkCMQDTSPxarZXvNrkxU3TkUMI33yzvFVVRT4wxWJC994OsdcZ4+RGNsYDyR5gmdr0nDGg=';

// ---------------------------------------------------------------------------------------------------------------
// A minimal DER encoder, enough for an X.509 v3 certificate with EC keys

const enc = new TextEncoder();
function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
function derLength(n: number): Uint8Array {
  if (n < 0x80) return Uint8Array.of(n);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
const tlv = (tag: number, ...parts: Uint8Array[]) => {
  const body = concat(...parts);
  return concat(Uint8Array.of(tag), derLength(body.length), body);
};
const seq = (...parts: Uint8Array[]) => tlv(0x30, ...parts);
const set = (...parts: Uint8Array[]) => tlv(0x31, ...parts);
function oid(dotted: string) {
  const [a, b, ...rest] = dotted.split('.').map(Number);
  const bytes = [40 * a + b];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let n = Math.floor(arc / 128); n > 0; n = Math.floor(n / 128)) chunk.unshift((n & 0x7f) | 0x80);
    bytes.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(bytes));
}
function integer(bytes: Uint8Array) {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const trimmed = bytes.slice(start);
  return tlv(0x02, trimmed[0] & 0x80 ? concat(Uint8Array.of(0), trimmed) : trimmed);
}
function time(ms: number) {
  const iso = new Date(ms).toISOString().replace(/[-:T]/g, '').slice(0, 14) + 'Z'; // YYYYMMDDHHMMSSZ
  return Number(iso.slice(0, 4)) < 2050 ? tlv(0x17, enc.encode(iso.slice(2))) : tlv(0x18, enc.encode(iso));
}
const name = (cn: string) => seq(set(seq(oid('2.5.4.3'), tlv(0x0c, enc.encode(cn)))));
const ecdsaWith = (hash: 'SHA-256' | 'SHA-384') => seq(oid(hash === 'SHA-256' ? '1.2.840.10045.4.3.2' : '1.2.840.10045.4.3.3'));
function rawToDer(raw: Uint8Array) {
  const half = raw.length / 2;
  return seq(integer(raw.slice(0, half)), integer(raw.slice(half)));
}

type KeyPair = CryptoKeyPair;
const newKey = (curve: 'P-256' | 'P-384') =>
  crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: curve }, true, ['sign', 'verify']) as Promise<KeyPair>;

let serial = 1;
async function makeCert(options: {
  cn: string;
  issuerCn: string;
  key: KeyPair;
  issuerKey: KeyPair;
  hash?: 'SHA-256' | 'SHA-384';
  notBefore?: number;
  notAfter?: number;
  ca: boolean;
  oids?: string[];
}): Promise<Uint8Array<ArrayBuffer>> {
  const hash = options.hash ?? 'SHA-384';
  const spki = new Uint8Array(await crypto.subtle.exportKey('spki', options.key.publicKey));
  const extensions = [seq(oid('2.5.29.19'), tlv(0x01, Uint8Array.of(0xff)), tlv(0x04, options.ca ? seq(tlv(0x01, Uint8Array.of(0xff))) : seq()))];
  for (const extra of options.oids ?? []) extensions.push(seq(oid(extra), tlv(0x04, tlv(0x05))));
  const tbs = seq(
    tlv(0xa0, integer(Uint8Array.of(2))),
    integer(Uint8Array.of(serial++ & 0x7f, 1)),
    ecdsaWith(hash),
    name(options.issuerCn),
    seq(time(options.notBefore ?? Date.now() - 365 * DAY), time(options.notAfter ?? Date.now() + 365 * DAY)),
    name(options.cn),
    spki,
    tlv(0xa3, seq(...extensions)),
  );
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash }, options.issuerKey.privateKey, tbs));
  return seq(tbs, ecdsaWith(hash), tlv(0x03, Uint8Array.of(0), rawToDer(signature)));
}

type Chain = { root: Uint8Array<ArrayBuffer>; certs: Uint8Array<ArrayBuffer>[]; leafKey: KeyPair };

/** Test root (P-384) -> intermediate (P-384) -> leaf (P-256), shaped like Apple's StoreKit chain. */
async function makeChain(options: { leafNotAfter?: number; leafOids?: string[] } = {}): Promise<Chain> {
  const rootKey = await newKey('P-384');
  const intermediateKey = await newKey('P-384');
  const leafKey = await newKey('P-256');
  const root = await makeCert({ cn: 'Test Root CA - G3', issuerCn: 'Test Root CA - G3', key: rootKey, issuerKey: rootKey, ca: true });
  const intermediate = await makeCert({
    cn: 'Test WWDR CA',
    issuerCn: 'Test Root CA - G3',
    key: intermediateKey,
    issuerKey: rootKey,
    ca: true,
    oids: [APPLE_INTERMEDIATE_OID],
  });
  const leaf = await makeCert({
    cn: 'Test StoreKit Signing',
    issuerCn: 'Test WWDR CA',
    key: leafKey,
    issuerKey: intermediateKey,
    ca: false,
    notAfter: options.leafNotAfter,
    oids: options.leafOids ?? [APPLE_LEAF_OID],
  });
  return { root, certs: [leaf, intermediate, root], leafKey };
}

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const b64url = (bytes: Uint8Array) => b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function signJws(payload: object, chain: Pick<Chain, 'certs' | 'leafKey'>, header: object = {}) {
  const h = b64url(enc.encode(JSON.stringify({ alg: 'ES256', x5c: chain.certs.map(b64), ...header })));
  const p = b64url(enc.encode(JSON.stringify(payload)));
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, chain.leafKey.privateKey, enc.encode(`${h}.${p}`)),
  );
  return `${h}.${p}.${b64url(signature)}`;
}

function transaction(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    transactionId: '2000000900000001',
    originalTransactionId: '2000000900000001',
    bundleId: BUNDLE_ID,
    productId: TIER1,
    purchaseDate: now - 1000,
    originalPurchaseDate: now - 1000,
    quantity: 1,
    type: 'Non-Consumable',
    inAppOwnershipType: 'PURCHASED',
    signedDate: now,
    environment: 'Sandbox',
    price: 4990,
    currency: 'USD',
    ...overrides,
  };
}

async function sha256Hex(bytes: Uint8Array<ArrayBuffer>) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------------------------------------------

describe('Apple certificates (real)', () => {
  test('the embedded root is byte for byte Apple Root CA - G3 (published SHA-256), and self-signed', async () => {
    expect(await sha256Hex(APPLE_ROOT_CA_G3)).toBe(APPLE_ROOT_CA_G3_SHA256);
    expect(APPLE_ROOT_CA_G3_SHA256).toBe('63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179');
    const root = parseCertificate(APPLE_ROOT_CA_G3);
    expect(root).toMatchObject({ curve: 'P-384', isCA: true });
    expect(root.notAfter).toBe(Date.UTC(2039, 3, 30, 18, 19, 6));
    expect(await verifyCertSignature(root, root)).toBe(true);
  });

  test("Apple's WWDR G6 intermediate chains to the embedded root and carries Apple's intermediate OID", async () => {
    const root = parseCertificate(APPLE_ROOT_CA_G3);
    const g6 = parseCertificate(base64ToBytes(APPLE_WWDR_G6_B64));
    expect(g6.isCA).toBe(true);
    expect(g6.extensions.has(APPLE_INTERMEDIATE_OID)).toBe(true);
    expect(await verifyCertSignature(g6, root)).toBe(true);
    const other = parseCertificate((await makeChain()).root);
    expect(await verifyCertSignature(g6, other)).toBe(false);
  });
});

describe('verifySignedData (JWS x5c chain + ES256)', () => {
  test('a valid chain and signature pass and return the payload', async () => {
    const chain = await makeChain();
    const anchors: TrustAnchor[] = [{ der: chain.root, kind: 'apple' }];
    const result = await verifySignedData(await signJws(transaction(), chain), anchors, Date.now());
    expect(result.payload).toMatchObject({ productId: TIER1, bundleId: BUNDLE_ID });
    expect(result.anchor.kind).toBe('apple');
  });

  test('a wrong root, a bad signature, an expired certificate or a malformed token fail', async () => {
    const chain = await makeChain();
    const other = await makeChain();
    const anchors: TrustAnchor[] = [{ der: chain.root, kind: 'apple' }];
    const good = await signJws(transaction(), chain);
    const reason = (p: Promise<unknown>) => p.then(() => 'passed', (e: { reason?: string }) => e.reason ?? String(e));

    // Wrong root: another CA's chain, and this leaf presented with the other CA's intermediate and root.
    expect(await reason(verifySignedData(await signJws(transaction(), other), anchors, Date.now()))).toBe('untrusted');
    const spliced = await signJws(transaction(), { certs: [chain.certs[0], other.certs[1], chain.root], leafKey: chain.leafKey });
    expect(await reason(verifySignedData(spliced, anchors, Date.now()))).toBe('chain');
    // Bad signature: payload changed after signing, or signed by a key that isn't the leaf's.
    const [h, , s] = good.split('.');
    const tampered = `${h}.${b64url(enc.encode(JSON.stringify(transaction({ productId: 'free.stuff' }))))}.${s}`;
    expect(await reason(verifySignedData(tampered, anchors, Date.now()))).toBe('signature');
    const wrongKey = await signJws(transaction(), { certs: chain.certs, leafKey: other.leafKey });
    expect(await reason(verifySignedData(wrongKey, anchors, Date.now()))).toBe('signature');
    // Expired leaf.
    const stale = await makeChain({ leafNotAfter: Date.now() - DAY });
    const staleJws = await signJws(transaction(), stale);
    expect(await reason(verifySignedData(staleJws, [{ der: stale.root, kind: 'apple' }], Date.now()))).toBe('expired');
    // Apple chains are exactly three, carry Apple's OIDs, and use ES256.
    const short = await signJws(transaction(), { certs: [chain.certs[0], chain.root], leafKey: chain.leafKey });
    expect(await reason(verifySignedData(short, anchors, Date.now()))).toBe('chain');
    const noOid = await makeChain({ leafOids: [] });
    expect(await reason(verifySignedData(await signJws(transaction(), noOid), [{ der: noOid.root, kind: 'apple' }], Date.now()))).toBe('chain');
    expect(await reason(verifySignedData(await signJws(transaction(), chain, { alg: 'none' }), anchors, Date.now()))).toBe('algorithm');
    for (const bad of ['', 'a.b', 'a.b.c', `${h}.${h}`]) expect(await reason(verifySignedData(bad, anchors, Date.now()))).toBe('malformed');
  });
});

describe('storekit.verifyPurchase (PAY-5, PAY-6)', () => {
  let chain: Chain;
  beforeEach(async () => {
    chain = await makeChain();
    setTrustAnchorsForTesting([{ der: chain.root, kind: 'apple' }]);
  });
  afterEach(() => {
    setTrustAnchorsForTesting(null);
    vi.unstubAllEnvs();
  });

  async function seed(t: T) {
    const seeded = await seedLitWithOwner(t);
    await t.mutation(internal.migrations.assignEditions, {});
    await t.run((ctx) => ctx.db.patch(seeded.litId, { appStoreProductIds: [TIER1, 'com.myindsound.app.lit.tier2'] }));
    return seeded;
  }
  const storekitRows = (t: T) =>
    t.run(async (ctx) => (await ctx.db.query('entitlements').collect()).filter((row) => row.source === 'storekit'));

  test('a verified purchase grants the next edition; a replay is idempotent; another account cannot take it', async () => {
    const t = newTest();
    await seed(t);
    const jws = await signJws(transaction(), chain);
    const first = await t.withIdentity(STRANGER).action(api.storekit.verifyPurchase, { signedTransaction: jws });
    expect(first).toMatchObject({ granted: true, editionNumber: 2, outcome: 'created', slug: 'lit', finish: true });
    const replay = await t.withIdentity(STRANGER).action(api.storekit.verifyPurchase, { signedTransaction: jws });
    expect(replay).toMatchObject({ granted: true, editionNumber: 2, outcome: 'replayed' });
    const rows = await storekitRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sourceRef: '2000000900000001', editionNumber: 2 });
    const stolen = await t.withIdentity(THIRD).action(api.storekit.verifyPurchase, { signedTransaction: jws });
    expect(stolen).toMatchObject({ granted: false, outcome: 'taken', editionNumber: null });
    expect(await storekitRows(t)).toHaveLength(1);
  });

  test('wrong bundle id, a disallowed environment, an unknown product, a consumable or signed out are rejected', async () => {
    const t = newTest();
    await seed(t);
    const as = t.withIdentity(STRANGER);
    const verify = async (overrides: Record<string, unknown>) =>
      as.action(api.storekit.verifyPurchase, { signedTransaction: await signJws(transaction(overrides), chain) });
    await expect(verify({ bundleId: 'com.someone.else' })).rejects.toThrow(/INVALID_INPUT/);
    await expect(verify({ environment: 'Xcode' })).rejects.toThrow(/INVALID_INPUT/);
    vi.stubEnv('STOREKIT_ENVIRONMENTS', 'Production');
    await expect(verify({})).rejects.toThrow(/INVALID_INPUT/);
    vi.unstubAllEnvs();
    await expect(verify({ productId: 'com.myindsound.app.unknown' })).rejects.toThrow(/NOT_FOUND/);
    await expect(verify({ type: 'Consumable' })).rejects.toThrow(/INVALID_INPUT/);
    await expect(t.action(api.storekit.verifyPurchase, { signedTransaction: await signJws(transaction(), chain) })).rejects.toThrow(
      /UNAUTHENTICATED/,
    );
    const revoked = await verify({ revocationDate: Date.now() - 1000 });
    expect(revoked).toMatchObject({ granted: false, outcome: 'revoked', finish: true });
    expect(await storekitRows(t)).toHaveLength(0);
  });

  test('Xcode local testing: accepted only with STOREKIT_ALLOW_XCODE_TEST=true and the exported cert, never on production', async () => {
    const t = newTest();
    await seed(t);
    const key = await newKey('P-256');
    const cert = await makeCert({ cn: 'StoreKit Testing in Xcode', issuerCn: 'StoreKit Testing in Xcode', key, issuerKey: key, hash: 'SHA-256', ca: true });
    const jws = await signJws(transaction({ environment: 'Xcode', originalTransactionId: '1', transactionId: '1' }), { certs: [cert], leafKey: key });
    const verify = () => t.withIdentity(STRANGER).action(api.storekit.verifyPurchase, { signedTransaction: jws });
    await expect(verify()).rejects.toThrow(/INVALID_INPUT/);
    vi.stubEnv('STOREKIT_XCODE_TEST_CERT', b64(cert));
    await expect(verify()).rejects.toThrow(/INVALID_INPUT/);
    vi.stubEnv('STOREKIT_ALLOW_XCODE_TEST', 'true');
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://loyal-tortoise-999.convex.cloud');
    await expect(verify()).rejects.toThrow(/INVALID_INPUT/);
    vi.stubEnv('CONVEX_CLOUD_URL', 'https://decisive-iguana-954.convex.cloud');
    expect(await verify()).toMatchObject({ granted: true, editionNumber: 2 });
    // An Xcode-signed transaction claiming another environment is still refused.
    const lying = await signJws(transaction({ environment: 'Production', originalTransactionId: '2' }), { certs: [cert], leafKey: key });
    await expect(t.withIdentity(THIRD).action(api.storekit.verifyPurchase, { signedTransaction: lying })).rejects.toThrow(/INVALID_INPUT/);
  });
});

describe('POST /appstore/notifications (PAY-8, App Store Server Notifications V2)', () => {
  let chain: Chain;
  beforeEach(async () => {
    chain = await makeChain();
    setTrustAnchorsForTesting([{ der: chain.root, kind: 'apple' }]);
  });
  afterEach(() => {
    setTrustAnchorsForTesting(null);
  });

  async function notification(type: string, uuid: string, tx: Record<string, unknown> = transaction()) {
    const signedTransactionInfo = await signJws(tx, chain);
    const payload = {
      notificationType: type,
      notificationUUID: uuid,
      version: '2.0',
      signedDate: Date.now(),
      data: { bundleId: BUNDLE_ID, environment: 'Sandbox', signedTransactionInfo },
    };
    return JSON.stringify({ signedPayload: await signJws(payload, chain) });
  }
  const post = (t: T, body: string) => t.fetch('/appstore/notifications', { method: 'POST', body });

  async function bought(t: T) {
    const seeded = await seedLitWithOwner(t);
    await t.mutation(internal.migrations.assignEditions, {});
    await t.run((ctx) => ctx.db.patch(seeded.litId, { appStoreProductIds: [TIER1] }));
    await t.withIdentity(STRANGER).action(api.storekit.verifyPurchase, { signedTransaction: await signJws(transaction(), chain) });
    return seeded;
  }
  const storekitRow = (t: T) =>
    t.run(async (ctx) => (await ctx.db.query('entitlements').collect()).find((row) => row.source === 'storekit')!);

  test('REFUND revokes the licence and its lends (LEND-10); a redelivery of the same notificationUUID is a no-op', async () => {
    const t = newTest();
    await bought(t);
    const { lendId, claimUrl } = await t.withIdentity(STRANGER).action(api.lends.create, { slug: 'lit' });
    await t.withIdentity(THIRD).mutation(api.lends.claim, { token: claimUrl.split('/').pop()! });

    const body = await notification('REFUND', '0f3a1c9e-refund-0001');
    const res = await post(t, body);
    expect(res.status).toBe(200);
    expect(await storekitRow(t)).toMatchObject({ status: 'revoked' });
    expect(await t.run((ctx) => ctx.db.get(lendId))).toMatchObject({ status: 'revoked', endReason: 'lender_revoked' });
    const again = await post(t, body);
    expect(again.status).toBe(200);
    const seen = await t.run(async (ctx) => (await ctx.db.query('stripeEvents').collect()).filter((e) => e.eventId.startsWith('appstore:')));
    expect(seen).toHaveLength(1);
    // The owner's Stripe copy is untouched.
    expect((await t.withIdentity(OWNER).query(api.app.context, { slug: 'lit' })).ownership).toBe('owned');
  });

  test('REVOKE revokes too; a refund that arrives before the purchase is verified blocks the later grant', async () => {
    const t = newTest();
    await bought(t);
    expect((await post(t, await notification('REVOKE', 'uuid-revoke-0001'))).status).toBe(200);
    expect(await storekitRow(t)).toMatchObject({ status: 'revoked' });

    const early = transaction({ originalTransactionId: '2000000900000777', transactionId: '2000000900000777' });
    expect((await post(t, await notification('REFUND', 'uuid-refund-early', early))).status).toBe(200);
    const late = await t.withIdentity(THIRD).action(api.storekit.verifyPurchase, { signedTransaction: await signJws(early, chain) });
    expect(late).toMatchObject({ granted: false, outcome: 'revoked' });
  });

  test('other types are logged and answered 200; a bad signature is 400', async () => {
    const t = newTest();
    await bought(t);
    expect((await post(t, await notification('CONSUMPTION_REQUEST', 'uuid-other-0001'))).status).toBe(200);
    expect((await post(t, await notification('TEST', 'uuid-test-0001'))).status).toBe(200);
    expect(await storekitRow(t)).toMatchObject({ status: 'active' });
    const other = await makeChain();
    const forged = JSON.stringify({ signedPayload: await signJws({ notificationType: 'REFUND', notificationUUID: 'x' }, other) });
    expect((await post(t, forged)).status).toBe(400);
    expect((await post(t, 'not json')).status).toBe(400);
    expect(await storekitRow(t)).toMatchObject({ status: 'active' });
  });
});

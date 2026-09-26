/**
 * StoreKit 2 signed data verification (PRD §7.2, PAY-5, PAY-8), in plain WebCrypto so it runs in the Convex
 * default runtime with no dependency.
 *
 * Apple signs every transaction and server notification as a JWS (ES256) whose `x5c` header carries the chain
 * leaf -> Apple Worldwide Developer Relations CA G6 -> Apple Root CA - G3. We check, like Apple's own
 * app-store-server-library does:
 * - the chain is exactly three certificates and the top one is byte for byte the Apple root embedded below;
 * - each certificate is signed by the next (ECDSA, DER signatures) and names it as issuer; the upper two are CAs;
 * - the leaf carries Apple's receipt signing OID and the intermediate Apple's WWDR OID;
 * - every certificate was valid at the payload's `signedDate` (Apple's library uses signedDate when it is not
 *   doing online revocation checks, so an old transaction still verifies after the leaf rotates), and signedDate
 *   is not in the future;
 * - the JWS signature over `header.payload`, ES256 with the leaf's P-256 key.
 */

// ---------------------------------------------------------------------------------------------------------------
// Constants

export const BUNDLE_ID = 'com.myindsound.app';

/**
 * Apple Root CA - G3, DER, base64. Source: https://www.apple.com/certificateauthority/AppleRootCA-G3.cer
 * (Apple PKI page https://www.apple.com/certificateauthority/). Downloaded 2026-09-25 and checked byte for byte:
 * SHA-256 63:34:3A:BF:B8:9A:6A:03:EB:B5:7E:9B:3F:5F:A7:BE:7C:4F:5C:75:6F:30:17:B3:A8:C4:88:C3:65:3E:91:79, the
 * fingerprint Apple publishes. Valid 2014-04-30 to 2039-04-30. `storekit.test.ts` re-checks the hash.
 */
const APPLE_ROOT_CA_G3_B64 =
  'MIICQzCCAcmgAwIBAgIILcX8iNLFS5UwCgYIKoZIzj0EAwMwZzEbMBkGA1UEAwwSQXBwbGUgUm9vdCBDQSAtIEczMSYwJAYDVQQLDB1BcHBsZSBDZXJ0aWZpY2F0aW9uIEF1dGhvcml0eTETMBEGA1UECgwKQXBwbGUgSW5jLjELMAkGA1UEBhMCVVMwHhcNMTQwNDMwMTgxOTA2WhcNMzkwNDMwMTgxOTA2WjBnMRswGQYDVQQDDBJBcHBsZSBSb290IENBIC0gRzMxJjAkBgNVBAsMHUFwcGxlIENlcnRpZmljYXRpb24gQXV0aG9yaXR5MRMwEQYDVQQKDApBcHBsZSBJbmMuMQswCQYDVQQGEwJVUzB2MBAGByqGSM49AgEGBSuBBAAiA2IABJjpLz1AcqTtkyJygRMc3RCV8cWjTnHcFBbZDuWmBSp3ZHtfTjjTuxxEtX/1H7YyYl3J6YRbTzBPEVoA/VhYDKX1DyxNB0cTddqXl5dvMVztK517IDvYuVTZXpmkOlEKMaNCMEAwHQYDVR0OBBYEFLuw3qFYM4iapIqZ3r6966/ayySrMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMAoGCCqGSM49BAMDA2gAMGUCMQCD6cHEFl4aXTQY2e3v9GwOAEZLuN+yRhHFD/3meoyhpmvOwgPUnPWTxnS4at+qIxUCMG1mihDK1A3UT82NQz60imOlM27jbdoXt2QfyFMm+YhidDkLF1vLUagM6BgD56KyKA==';
export const APPLE_ROOT_CA_G3_SHA256 = '63343abfb89a6a03ebb57e9b3f5fa7be7c4f5c756f3017b3a8c488c3653e9179';

/** Apple's marker extensions (app-store-server-library `SignedDataVerifier`). */
export const APPLE_LEAF_OID = '1.2.840.113635.100.6.11.1';
export const APPLE_INTERMEDIATE_OID = '1.2.840.113635.100.6.2.1';

/** A payload may be signed at most this far ahead of our clock. */
const SIGNED_DATE_SKEW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------------
// Bytes

export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new VerificationError('malformed');
  return base64ToBytes(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export const APPLE_ROOT_CA_G3: Uint8Array<ArrayBuffer> = base64ToBytes(APPLE_ROOT_CA_G3_B64);

// ---------------------------------------------------------------------------------------------------------------
// Errors

export type VerificationFailure =
  | 'malformed' // not a JWS, bad base64 or JSON, or a certificate that doesn't parse
  | 'algorithm' // not ES256, or a leaf key that isn't P-256
  | 'untrusted' // the chain doesn't end in a trusted root
  | 'chain' // a link doesn't verify, wrong length, not a CA, or Apple's OIDs missing
  | 'signature' // the JWS signature doesn't verify with the leaf key
  | 'expired'; // a certificate wasn't valid at signedDate, or signedDate is in the future

export class VerificationError extends Error {
  readonly reason: VerificationFailure;
  constructor(reason: VerificationFailure) {
    super(`StoreKit signed data rejected: ${reason}`);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// DER (only what X.509 v3 certificates with EC keys need)

type Node = { tag: number; buf: Uint8Array<ArrayBuffer>; start: number; body: number; end: number };

function readNode(buf: Uint8Array<ArrayBuffer>, offset: number, limit = buf.length): Node {
  if (offset + 2 > limit) throw new VerificationError('malformed');
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new VerificationError('malformed');
  let length = buf[offset + 1];
  let body = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || body + count > limit) throw new VerificationError('malformed');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + buf[body + i];
    body += count;
  }
  const end = body + length;
  if (end > limit) throw new VerificationError('malformed');
  return { tag, buf, start: offset, body, end };
}

const contentOf = (node: Node) => node.buf.slice(node.body, node.end);
const bytesOf = (node: Node) => node.buf.slice(node.start, node.end);

function childrenOf(node: Node): Node[] {
  const out: Node[] = [];
  for (let offset = node.body; offset < node.end; ) {
    const child = readNode(node.buf, offset, node.end);
    out.push(child);
    offset = child.end;
  }
  return out;
}

function expectTag(node: Node | undefined, tag: number): Node {
  if (!node || node.tag !== tag) throw new VerificationError('malformed');
  return node;
}

function oidOf(node: Node): string {
  const bytes = contentOf(expectTag(node, 0x06));
  if (bytes.length === 0) throw new VerificationError('malformed');
  const arcs = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (let i = 1; i < bytes.length; i++) {
    value = value * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join('.');
}

function timeOf(node: Node): number {
  const text = new TextDecoder().decode(contentOf(node));
  let match: RegExpExecArray | null;
  let year: number;
  if (node.tag === 0x17 && (match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text))) {
    year = Number(match[1]);
    year += year < 50 ? 2000 : 1900;
  } else if (node.tag === 0x18 && (match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(text))) {
    year = Number(match[1]);
  } else {
    throw new VerificationError('malformed');
  }
  const [, , month, day, hour, minute, second] = match.map(Number);
  return Date.UTC(year, month - 1, day, hour, minute, second);
}

const CURVES: Record<string, { name: 'P-256' | 'P-384' | 'P-521'; size: number }> = {
  '1.2.840.10045.3.1.7': { name: 'P-256', size: 32 },
  '1.3.132.0.34': { name: 'P-384', size: 48 },
  '1.3.132.0.35': { name: 'P-521', size: 66 },
};
const SIGNATURE_HASHES: Record<string, 'SHA-256' | 'SHA-384' | 'SHA-512'> = {
  '1.2.840.10045.4.3.2': 'SHA-256',
  '1.2.840.10045.4.3.3': 'SHA-384',
  '1.2.840.10045.4.3.4': 'SHA-512',
};
const EC_PUBLIC_KEY = '1.2.840.10045.2.1';
const BASIC_CONSTRAINTS = '2.5.29.19';

export type Certificate = {
  tbs: Uint8Array<ArrayBuffer>;
  signatureHash: 'SHA-256' | 'SHA-384' | 'SHA-512' | null;
  /** DER `SEQUENCE { r, s }`. */
  signature: Uint8Array<ArrayBuffer>;
  issuer: Uint8Array<ArrayBuffer>;
  subject: Uint8Array<ArrayBuffer>;
  notBefore: number;
  notAfter: number;
  spki: Uint8Array<ArrayBuffer>;
  curve: 'P-256' | 'P-384' | 'P-521' | null;
  isCA: boolean;
  extensions: Map<string, { critical: boolean; value: Uint8Array<ArrayBuffer> }>;
};

/** Parses an X.509 v3 certificate (DER). Throws `VerificationError('malformed')` on anything unexpected. */
export function parseCertificate(der: Uint8Array<ArrayBuffer>): Certificate {
  try {
    const cert = expectTag(readNode(der, 0), 0x30);
    if (cert.end !== der.length) throw new VerificationError('malformed');
    const [tbsNode, algNode, sigNode, ...extra] = childrenOf(cert);
    if (extra.length > 0) throw new VerificationError('malformed');
    const tbsParts = childrenOf(expectTag(tbsNode, 0x30));
    let i = 0;
    if (tbsParts[0]?.tag === 0xa0) i++; // version
    expectTag(tbsParts[i++], 0x02); // serial
    const innerAlg = expectTag(tbsParts[i++], 0x30);
    const issuer = expectTag(tbsParts[i++], 0x30);
    const [notBefore, notAfter] = childrenOf(expectTag(tbsParts[i++], 0x30));
    const subject = expectTag(tbsParts[i++], 0x30);
    const spki = expectTag(tbsParts[i++], 0x30);
    const extensions = new Map<string, { critical: boolean; value: Uint8Array<ArrayBuffer> }>();
    for (; i < tbsParts.length; i++) {
      if (tbsParts[i].tag !== 0xa3) continue; // issuer/subject unique ids
      for (const ext of childrenOf(expectTag(childrenOf(tbsParts[i])[0], 0x30))) {
        const parts = childrenOf(expectTag(ext, 0x30));
        const critical = parts.length === 3 && parts[1].tag === 0x01 && contentOf(parts[1])[0] !== 0;
        extensions.set(oidOf(parts[0]), { critical, value: contentOf(expectTag(parts[parts.length - 1], 0x04)) });
      }
    }

    // The signature algorithm is stated twice and must agree.
    expectTag(algNode, 0x30);
    if (!equalBytes(bytesOf(innerAlg), bytesOf(algNode))) throw new VerificationError('malformed');
    const signatureBits = contentOf(expectTag(sigNode, 0x03));
    if (signatureBits[0] !== 0) throw new VerificationError('malformed');

    const [keyAlg] = childrenOf(spki);
    const [keyType, curveOid] = childrenOf(expectTag(keyAlg, 0x30));
    const curve = oidOf(keyType) === EC_PUBLIC_KEY && curveOid?.tag === 0x06 ? CURVES[oidOf(curveOid)]?.name ?? null : null;

    let isCA = false;
    const constraints = extensions.get(BASIC_CONSTRAINTS);
    if (constraints) {
      const holder = new Uint8Array(constraints.value);
      const [flag] = childrenOf(expectTag(readNode(holder, 0), 0x30));
      isCA = flag?.tag === 0x01 && contentOf(flag)[0] !== 0;
    }

    return {
      tbs: bytesOf(tbsNode),
      signatureHash: SIGNATURE_HASHES[oidOf(childrenOf(algNode)[0])] ?? null,
      signature: signatureBits.slice(1),
      issuer: bytesOf(issuer),
      subject: bytesOf(subject),
      notBefore: timeOf(notBefore),
      notAfter: timeOf(notAfter),
      spki: bytesOf(spki),
      curve,
      isCA,
      extensions,
    };
  } catch (error) {
    if (error instanceof VerificationError) throw error;
    throw new VerificationError('malformed');
  }
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` to the fixed width `r || s` WebCrypto verifies. */
function derSignatureToRaw(der: Uint8Array<ArrayBuffer>, size: number): Uint8Array<ArrayBuffer> {
  const seq = expectTag(readNode(der, 0), 0x30);
  if (seq.end !== der.length) throw new VerificationError('malformed');
  const ints = childrenOf(seq);
  if (ints.length !== 2) throw new VerificationError('malformed');
  const raw = new Uint8Array(size * 2);
  ints.forEach((node, index) => {
    let value = contentOf(expectTag(node, 0x02));
    while (value.length > 1 && value[0] === 0) value = value.slice(1);
    if (value.length > size) throw new VerificationError('malformed');
    raw.set(value, index * size + (size - value.length));
  });
  return raw;
}

async function publicKeyOf(cert: Certificate): Promise<CryptoKey> {
  if (!cert.curve) throw new VerificationError('algorithm');
  return await crypto.subtle.importKey('spki', cert.spki, { name: 'ECDSA', namedCurve: cert.curve }, false, ['verify']);
}

/** Whether `child` is signed by `parent`'s key (ECDSA). */
export async function verifyCertSignature(child: Certificate, parent: Certificate): Promise<boolean> {
  if (!child.signatureHash || !parent.curve) return false;
  const size = Object.values(CURVES).find((c) => c.name === parent.curve)!.size;
  try {
    const raw = derSignatureToRaw(child.signature, size);
    return await crypto.subtle.verify({ name: 'ECDSA', hash: child.signatureHash }, await publicKeyOf(parent), raw, child.tbs);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// JWS

/**
 * A trusted root. `apple`: Apple Root CA - G3 (or a test root standing in for it), with the full Apple checks.
 * `xcode`: the local StoreKit test certificate Xcode signs with, accepted only for `environment: 'Xcode'` and
 * only when `STOREKIT_ALLOW_XCODE_TEST=true` on a non-production deployment (see storekit.ts).
 */
export type TrustAnchor = { der: Uint8Array<ArrayBuffer>; kind: 'apple' | 'xcode' };

let testAnchors: TrustAnchor[] | null = null;

/**
 * Test-only seam: replaces the Apple root with a throwaway CA. Module state inside the running function bundle,
 * so nothing outside the process (no request, no env var) can set it.
 */
export function setTrustAnchorsForTesting(anchors: TrustAnchor[] | null): void {
  testAnchors = anchors;
}

export function appleAnchors(): TrustAnchor[] {
  return testAnchors ?? [{ der: APPLE_ROOT_CA_G3, kind: 'apple' }];
}

/** Verifies a StoreKit JWS against `anchors` and returns its payload. Throws `VerificationError`. */
export async function verifySignedData(
  jws: string,
  anchors: TrustAnchor[],
  now: number,
): Promise<{ payload: Record<string, unknown>; anchor: TrustAnchor }> {
  const parts = jws.split('.');
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new VerificationError('malformed');
  const [headerText, payloadText, signatureText] = parts;
  let header: { alg?: unknown; x5c?: unknown };
  let payload: unknown;
  try {
    header = JSON.parse(new TextDecoder().decode(base64UrlToBytes(headerText)));
    payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(payloadText)));
  } catch {
    throw new VerificationError('malformed');
  }
  if (typeof header !== 'object' || header === null || typeof payload !== 'object' || payload === null) {
    throw new VerificationError('malformed');
  }
  if (header.alg !== 'ES256') throw new VerificationError('algorithm');
  const x5c = header.x5c;
  if (!Array.isArray(x5c) || x5c.length < 1 || x5c.length > 3 || !x5c.every((c) => typeof c === 'string')) {
    throw new VerificationError('malformed');
  }
  let ders: Uint8Array<ArrayBuffer>[];
  try {
    ders = (x5c as string[]).map(base64ToBytes);
  } catch {
    throw new VerificationError('malformed');
  }

  const anchor = anchors.find((candidate) => equalBytes(candidate.der, ders[ders.length - 1]));
  if (!anchor) throw new VerificationError('untrusted');
  if (anchor.kind === 'apple' && ders.length !== 3) throw new VerificationError('chain');
  const certs = ders.map(parseCertificate);

  for (let i = 0; i < certs.length - 1; i++) {
    if (!equalBytes(certs[i].issuer, certs[i + 1].subject)) throw new VerificationError('chain');
    if (!(await verifyCertSignature(certs[i], certs[i + 1]))) throw new VerificationError('chain');
  }
  for (let i = 1; i < certs.length; i++) if (!certs[i].isCA) throw new VerificationError('chain');
  if (anchor.kind === 'apple') {
    if (!certs[0].extensions.has(APPLE_LEAF_OID) || !certs[1].extensions.has(APPLE_INTERMEDIATE_OID)) {
      throw new VerificationError('chain');
    }
  }

  const leaf = certs[0];
  if (leaf.curve !== 'P-256') throw new VerificationError('algorithm');
  let signature: Uint8Array<ArrayBuffer>;
  try {
    signature = base64UrlToBytes(signatureText);
  } catch {
    throw new VerificationError('malformed');
  }
  const signed = new TextEncoder().encode(`${headerText}.${payloadText}`);
  const genuine =
    signature.length === 64 &&
    (await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, await publicKeyOf(leaf), signature, signed));
  if (!genuine) throw new VerificationError('signature');

  const body = payload as Record<string, unknown>;
  const signedDate = typeof body.signedDate === 'number' ? body.signedDate : now;
  if (signedDate > now + SIGNED_DATE_SKEW_MS) throw new VerificationError('expired');
  for (const cert of certs) {
    if (signedDate < cert.notBefore || signedDate > cert.notAfter) throw new VerificationError('expired');
  }
  return { payload: body, anchor };
}

// ---------------------------------------------------------------------------------------------------------------
// Transactions

/** The JWSTransaction fields we read (Apple: JWSTransactionDecodedPayload). */
export type StoreKitTransaction = {
  transactionId: string;
  originalTransactionId: string;
  bundleId: string;
  productId: string;
  environment: string;
  type: string;
  signedDate: number;
  price?: number; // milliunits
  currency?: string;
  revocationDate?: number;
};

export type TransactionProblem = 'fields' | 'bundle' | 'environment' | 'type';

/** Field, bundle, environment and type checks (PAY-4: one non-consumable per release tier). */
export function checkTransaction(
  payload: Record<string, unknown>,
  allowedEnvironments: ReadonlySet<string>,
): { ok: true; transaction: StoreKitTransaction } | { ok: false; problem: TransactionProblem } {
  const text = (key: string) => (typeof payload[key] === 'string' && payload[key] !== '' ? (payload[key] as string) : null);
  const transactionId = text('transactionId');
  const originalTransactionId = text('originalTransactionId');
  const bundleId = text('bundleId');
  const productId = text('productId');
  const environment = text('environment');
  const type = text('type');
  if (!transactionId || !originalTransactionId || !bundleId || !productId || !environment || !type) {
    return { ok: false, problem: 'fields' };
  }
  if (bundleId !== BUNDLE_ID) return { ok: false, problem: 'bundle' };
  if (!allowedEnvironments.has(environment)) return { ok: false, problem: 'environment' };
  if (type !== 'Non-Consumable') return { ok: false, problem: 'type' };
  return {
    ok: true,
    transaction: {
      transactionId,
      originalTransactionId,
      bundleId,
      productId,
      environment,
      type,
      signedDate: typeof payload.signedDate === 'number' ? payload.signedDate : 0,
      ...(typeof payload.price === 'number' ? { price: payload.price } : {}),
      ...(typeof payload.currency === 'string' ? { currency: payload.currency } : {}),
      ...(typeof payload.revocationDate === 'number' ? { revocationDate: payload.revocationDate } : {}),
    },
  };
}

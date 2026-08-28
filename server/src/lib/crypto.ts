import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

// promisify picks the three-argument overload, which cannot carry the cost
// parameters below. The options form is the one this module always uses.
const scrypt = promisify(scryptCallback) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * scrypt work factor.
 *
 * N=2^15 with r=8 costs roughly 32 MiB and ~100 ms per hash on a modern
 * server, comfortably above the OWASP floor while still letting a small VPS
 * serve sign-ins. The parameters are written into the stored hash, so raising
 * them later re-hashes on next sign-in instead of invalidating every password.
 */
const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 32;
// scrypt needs roughly 128 * N * r bytes; Node's default maxmem is too low for N=2^15.
const SCRYPT_MAXMEM = 128 * SCRYPT_N * SCRYPT_R * 2;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, SCRYPT_N, SCRYPT_R, SCRYPT_P);
  return [
    'scrypt',
    `${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}`,
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join(':');
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const [n, r, p] = parts[1].split('$').map((value) => Number.parseInt(value, 10));
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;
  // An attacker-supplied hash is never verified here, but a corrupted row
  // should fail rather than let a caller request an unbounded allocation.
  if (n > SCRYPT_N * 4 || r > 32 || p > 16) return false;
  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = Buffer.from(parts[3], 'base64url');
    actual = await derive(password, Buffer.from(parts[2], 'base64url'), n, r, p, expected.length);
  } catch {
    return false;
  }
  return safeEqual(actual, expected);
}

/** True when a stored hash uses weaker parameters than the current policy. */
export function passwordNeedsRehash(encoded: string): boolean {
  const parts = encoded.split(':');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return true;
  const [n, r, p] = parts[1].split('$').map((value) => Number.parseInt(value, 10));
  return n < SCRYPT_N || r < SCRYPT_R || p < SCRYPT_P;
}

async function derive(
  password: string,
  salt: Buffer,
  n: number,
  r: number,
  p: number,
  keylen = SCRYPT_KEYLEN,
): Promise<Buffer> {
  return await scrypt(password, salt, keylen, {
    N: n,
    r,
    p,
    maxmem: Math.max(SCRYPT_MAXMEM, 128 * n * r * 2),
  });
}

export function safeEqual(a: string | Buffer, b: string | Buffer): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Opaque tokens are stored only as digests, so a database copy cannot replay one. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('base64url');
}

export function randomToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString('base64url')}`;
}

/**
 * Derives a key bound to one purpose, so the same configured secret cannot be
 * reused across two features in a way that lets one forge the other.
 */
export function purposeKey(keyMaterial: string, purpose: string): Buffer {
  return createHash('sha256')
    .update(`ravelon-sync:${purpose}:v1\0`, 'utf8')
    .update(keyMaterial, 'utf8')
    .digest();
}

/** Authenticated encryption for values that must round-trip out of the database. */
export function encryptSecret(keyMaterial: string, purpose: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', purposeKey(keyMaterial, purpose), iv);
  cipher.setAAD(Buffer.from(purpose, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return [
    'v1',
    iv.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
    ciphertext.toString('base64url'),
  ].join('.');
}

export function decryptSecret(keyMaterial: string, purpose: string, encrypted: string): string {
  const [version, ivText, tagText, ciphertextText, ...extra] = encrypted.split('.');
  if (version !== 'v1' || !ivText || !tagText || !ciphertextText || extra.length > 0) {
    throw new Error('Invalid encrypted value');
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    purposeKey(keyMaterial, purpose),
    Buffer.from(ivText, 'base64url'),
  );
  decipher.setAAD(Buffer.from(purpose, 'utf8'));
  decipher.setAuthTag(Buffer.from(tagText, 'base64url'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, 'base64url')),
    decipher.final(),
  ]).toString('utf8');
}

export interface AccessTokenClaims {
  sub: string;
  email: string;
  role: string;
  deviceId: string;
  iat: number;
  exp: number;
}

export function signAccessToken(
  secret: string,
  claims: Omit<AccessTokenClaims, 'iat' | 'exp'>,
  ttlSeconds: number,
): string {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Json({ alg: 'HS256', typ: 'JWT' });
  const payload = base64Json({ ...claims, iat: issuedAt, exp: issuedAt + ttlSeconds });
  const data = `${header}.${payload}`;
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`;
}

export function verifyAccessToken(secret: string, token: string): AccessTokenClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const expected = createHmac('sha256', secret).update(data).digest('base64url');
  if (!safeEqual(parts[2], expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as AccessTokenClaims;
    if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) return null;
    if (typeof claims.sub !== 'string' || typeof claims.deviceId !== 'string') return null;
    return claims;
  } catch {
    return null;
  }
}

function base64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

// Password hashing (scrypt), random tokens, HMAC signing, field encryption and TOTP (RFC 6238).
import {
  createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomInt, scrypt, timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from '../config.js';

const scryptAsync = promisify(scrypt);

// N=2^15, r=8, p=1 uses 32 MiB and roughly 50-100 ms per hash on a modern CPU.
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64 };
const SCRYPT_MAXMEM = 128 * SCRYPT.N * SCRYPT.r * 2;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password.normalize('NFKC'), salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT_MAXMEM });
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const [alg, n, r, p, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scryptAsync(password.normalize('NFKC'), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n), r: Number(r), p: Number(p), maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return key.length === expected.length && timingSafeEqual(key, expected);
}

/** A precomputed hash so failed lookups take as long as real password checks. */
let dummyHash;
export async function burnPasswordCheck(password) {
  dummyHash ||= await hashPassword('lumina-timing-equaliser');
  await verifyPassword(password, dummyHash);
  return false;
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');

const ID_ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz'; // Crockford base32, lowercase
/** Opaque, unguessable identifiers such as `acc_2x9f…`. */
export function newId(prefix, length = 20) {
  let s = '';
  for (let i = 0; i < length; i++) s += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
  return `${prefix}_${s}`;
}

export function hmac(data, purpose = 'default') {
  return createHmac('sha256', `${config.secret}:${purpose}`).update(data).digest('base64url');
}

export function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

// ---- Field encryption (AES-256-GCM) for secrets stored in the database (e.g. TOTP seeds)
const fieldKey = Buffer.from(hkdfSync('sha256', config.secret, 'lumina-field-salt', 'lumina-field-encryption', 32));

export function encryptField(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', fieldKey, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptField(value) {
  const [ver, iv, tag, data] = String(value).split('.');
  if (ver !== 'v1') throw new Error('Unknown field encryption version');
  const decipher = createDecipheriv('aes-256-gcm', fieldKey, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
}

// ---- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) compatible with common authenticator apps
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export const generateTotpSecret = () => base32Encode(randomBytes(20));

export function totp(secret, timeMs = Date.now(), step = 30) {
  const counter = Math.floor(timeMs / 1000 / step);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0xf;
  const code = (digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

export function verifyTotp(secret, code, window = 1) {
  if (!/^\d{6}$/.test(String(code || ''))) return false;
  const now = Date.now();
  for (let w = -window; w <= window; w++) {
    if (safeEqual(totp(secret, now + w * 30_000), code)) return true;
  }
  return false;
}

export function otpauthUrl(secret, accountName, issuer = 'Lumina') {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

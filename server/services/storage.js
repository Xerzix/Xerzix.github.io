// Private object storage on the local filesystem plus signed, expiring URLs.
// Keys look like "uploads/<id>" or "media/<mediaId>/master.m3u8". Files under storage are
// never served by the static handler; they are reachable only through /media/private/
// with a valid signature. To move to S3/GCS/R2, keep this interface and swap the
// implementation (see docs/STREAMING.md).
import { mkdirSync } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { hmac, safeEqual } from '../lib/crypto.js';
import { safeJoin } from '../lib/static.js';

export function storagePath(key) {
  const full = safeJoin(config.storageDir, key);
  if (!full) throw new Error(`Invalid storage key: ${key}`);
  return full;
}

export function ensureDirFor(key) {
  const full = storagePath(key);
  mkdirSync(dirname(full), { recursive: true });
  return full;
}

export async function removeKey(key) {
  await rm(storagePath(key), { recursive: true, force: true });
}

export async function sizeOf(key) {
  try {
    return (await stat(storagePath(key))).size;
  } catch {
    return 0;
  }
}

/**
 * Signs a directory-scoped grant so an HLS manifest and all of its segments are playable:
 * /media/private/<scope>/<file>?exp=<unix>&sig=<hmac(scope|exp)>
 * `scope` is a directory key such as "media/med_abc".
 */
export function signScope(scope, minutes = config.media.signedUrlMinutes) {
  const exp = Math.floor(Date.now() / 1000) + minutes * 60;
  return { exp, sig: hmac(`${scope}|${exp}`, 'media') };
}

export function signedUrl(key, minutes) {
  const scope = dirname(key);
  const { exp, sig } = signScope(scope, minutes);
  return `/media/private/${key}?exp=${exp}&sig=${sig}`;
}

export function verifyScope(scope, exp, sig) {
  if (!exp || !sig || Number(exp) < Date.now() / 1000) return false;
  return safeEqual(hmac(`${scope}|${exp}`, 'media'), sig);
}

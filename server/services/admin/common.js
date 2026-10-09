// Shared helpers for the administration services: paging, slugs, reference validators
// and small row mappers. Nothing here touches the request; routes pass plain values in.
import { config } from '../../config.js';
import { HttpError } from '../../lib/errors.js';

/** ?page & ?pageSize → { page, pageSize, offset } with sane bounds. */
export function paging(query = {}, { size = 25, max = 100 } = {}) {
  const page = Math.max(1, Math.min(10_000, Number.parseInt(query.page, 10) || 1));
  const pageSize = Math.max(1, Math.min(max, Number.parseInt(query.pageSize, 10) || size));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

/** Escapes a user search term for LIKE ... ESCAPE '\'. */
export function likeTerm(q) {
  return `%${String(q || '').trim().slice(0, 100).replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

export function slugify(text, max = 60) {
  const s = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s.length >= 2 ? s : `title-${Date.now().toString(36)}`;
}

/** Returns `base`, or `base-2`, `base-3`… whichever is not taken according to `exists(id)`. */
export function uniqueId(base, exists) {
  if (!exists(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/;
const hasTraversal = (p) => p.split('/').some((seg) => seg === '..' || seg === '.' || seg.startsWith('.'));

/**
 * Artwork: a public site path (assets/…) or an https URL on an origin the
 * Content-Security-Policy lets browsers load images from (MEDIA_ORIGINS). Anything else would
 * be stored but never render. Returns an error message or null.
 */
export function imageRefProblem(s) {
  if (typeof s !== 'string' || !s) return 'Enter an image location.';
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return 'Enter a valid URL.';
    }
    if (u.protocol !== 'https:') return 'External artwork must use https.';
    if (!allowedMediaOrigins().includes(u.origin)) return `${u.origin} is not in MEDIA_ORIGINS, so browsers would block the image. Upload the artwork or add the origin to MEDIA_ORIGINS first.`;
    return null;
  }
  return SAFE_PATH.test(s) && !hasTraversal(s) && s.length <= 500 ? null : 'Use a site path such as assets/art/poster.svg or an allowed https URL.';
}

export const isImageRef = (s) => imageRefProblem(s) === null;

/** Origins (besides this server) that browsers may load media from under the CSP. */
export function allowedMediaOrigins() {
  return config.media.extraOrigins.map((o) => {
    try {
      return new URL(o).origin;
    } catch {
      return o;
    }
  });
}

/**
 * Media locations: a public site path under media/, a private "storage:<key>", or an
 * http(s) URL on an origin listed in MEDIA_ORIGINS (anything else would be blocked by the
 * Content-Security-Policy in every browser). Returns an error message or null.
 */
export function mediaRefProblem(s) {
  if (typeof s !== 'string' || !s) return 'Enter a media location.';
  if (s.startsWith('storage:')) {
    const key = s.slice(8);
    return SAFE_PATH.test(key) && !hasTraversal(key) ? null : 'Storage keys may only contain letters, numbers, dots, dashes, underscores and slashes.';
  }
  if (/^https?:\/\//i.test(s)) {
    let u;
    try {
      u = new URL(s);
    } catch {
      return 'Enter a valid URL.';
    }
    if (!allowedMediaOrigins().includes(u.origin)) return `${u.origin} is not in MEDIA_ORIGINS, so browsers would block it. Add the origin to MEDIA_ORIGINS first.`;
    return null;
  }
  if (!s.startsWith('media/')) return 'Use a site path under media/, a storage: key, or an allowed https URL.';
  return SAFE_PATH.test(s) && !hasTraversal(s) ? null : 'That path contains characters that are not allowed.';
}

export const isMediaRef = (s) => mediaRefProblem(s) === null;

/** Internal app link (#/…) or an https URL — used for notification and announcement links. */
export function isAppLink(s) {
  if (s.startsWith('#/')) return !/[\s<>"]/.test(s) && s.length <= 300;
  try {
    return new URL(s).protocol === 'https:';
  } catch {
    return false;
  }
}

export function httpError(status, code, message, extra) {
  return new HttpError(status, code, message, extra);
}

/** Lowercases the primary language subtag: "EN-us" → "en-US". */
export function normLang(code) {
  if (!code) return null;
  const [primary, ...rest] = String(code).trim().split(/[-_]/);
  if (!primary) return null;
  return [primary.toLowerCase(), ...rest.map((r) => (r.length === 2 ? r.toUpperCase() : r))].join('-');
}

export function languageLabel(code) {
  if (!code || code === 'und') return 'Unknown language';
  if (code === 'zxx') return 'No dialogue';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

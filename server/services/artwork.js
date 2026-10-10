// Real title artwork from TMDB, matched to each catalog title by name and release year.
//
// - Metadata (search, details, season episode lists) comes from TMDB with the server-side
//   credential and is cached in metadata_cache, so repeated syncs do not ask again.
// - Images are referenced by TMDB file path and served to browsers from Lumina's own origin
//   (/media/artwork/tmdb/<size>/<file>): the first request downloads the file once from TMDB's
//   image CDN and keeps it on disk; later requests are served from the cache.
// - A title is only given artwork from an entry whose title matches exactly (after removing
//   accents, punctuation and a leading article) and whose year is within one of the catalog's
//   year. No match means no artwork: the interface shows the Lumina fallback, never a guess.
// - Lumina Originals carry artwork made from their own frames and are locked against sync.
// - Artwork never implies streaming: playback depends only on media rows (and availability).
import { createWriteStream, existsSync, mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { now, parseJson, toJson } from '../db/index.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { isConfigured, tmdbGet } from './admin/tmdb.js';

export const POSTER_SIZES = [185, 342, 500, 780];
export const BACKDROP_SIZES = [300, 780, 1280];
export const STILL_SIZES = [185, 300];
export const IMAGE_SIZES = new Set(['w92', 'w154', 'w185', 'w300', 'w342', 'w500', 'w780', 'w1280']);
/** A TMDB image file name, as it appears after /t/p/<size>/. */
export const TMDB_FILE = /^[A-Za-z0-9_-]{6,80}\.(jpg|jpeg|png|webp)$/;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const CACHE_TTL_MS = 7 * 24 * 3600_000;
const CACHE_PREFIX = 'media/artwork/tmdb/';

const fileOf = (path) => (typeof path === 'string' ? path.replace(/^\//, '') : '');
export const cacheUrl = (size, path) => `${CACHE_PREFIX}w${size}/${fileOf(path)}`;
const sizeSet = (path, sizes) => (path ? sizes.map((w) => ({ url: cacheUrl(w, path), w })) : []);

/** Rewrites a cached artwork URL to TMDB's CDN (for Preview mode, which has no server). */
export function cdnUrl(url, imageBase = 'https://image.tmdb.org/t/p') {
  if (typeof url !== 'string' || !url.startsWith(CACHE_PREFIX)) return url;
  return `${imageBase}/${url.slice(CACHE_PREFIX.length)}`;
}

/** Lower-case, accent-free, punctuation-free; "&" → "and"; a leading article is dropped. */
export function normalizeTitle(s) {
  return String(s || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/^(the|a|an) /, '');
}

const yearOf = (date) => (typeof date === 'string' && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);

/**
 * Scores a TMDB search result against a catalog title, or returns null when it must not be
 * used. Titles must match exactly (title or original title); years may differ by one (festival
 * vs. release dates) but a known year further away rules the candidate out.
 */
export function scoreCandidate(title, cand, type) {
  const names = type === 'tv' ? [cand.name, cand.original_name] : [cand.title, cand.original_title];
  const wanted = [normalizeTitle(title.title), normalizeTitle(title.original_title || title.originalTitle)].filter(Boolean);
  if (!names.some((n) => n && wanted.includes(normalizeTitle(n)))) return null;
  const candYear = yearOf(type === 'tv' ? cand.first_air_date : cand.release_date);
  let score = 50;
  if (title.year && candYear) {
    const diff = Math.abs(title.year - candYear);
    if (diff > 1) return null;
    score = diff === 0 ? 100 : 80;
  }
  if (cand.poster_path) score += 5;
  // Popularity only breaks ties between equally good matches.
  score += Math.min(4, Math.log10(1 + (cand.vote_count || 0)));
  return score;
}

export function pickMatch(title, results, type) {
  let best = null;
  for (const cand of results || []) {
    const score = scoreCandidate(title, cand, type);
    if (score !== null && (!best || score > best.score)) best = { cand, score };
  }
  return best;
}

export class ArtworkService {
  constructor(db, config, { fetchImpl = fetch, catalog = null } = {}) {
    this.db = db;
    this.config = config;
    this.fetch = fetchImpl;
    this.catalog = catalog;
    this.inflight = new Map();
    this.cacheDir = join(config.storageDir, 'artwork-cache', 'tmdb');
  }

  configured() {
    return isConfigured(this.config);
  }

  /** TMDB GET through metadata_cache. Throws HttpError (503 not configured, 502 unreachable). */
  async tmdb(path, params = {}, { fresh = false } = {}) {
    const key = `tmdb:${path}?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')).toString()}`;
    const hit = this.db.get('SELECT body, fetched_at FROM metadata_cache WHERE key = ?', key);
    if (hit && !fresh && Date.now() - Date.parse(hit.fetched_at) < CACHE_TTL_MS) return JSON.parse(hit.body);
    const body = await tmdbGet(this.config, path, params, this.fetch);
    this.db.run('INSERT INTO metadata_cache (key, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at', key, JSON.stringify(body), now());
    return body;
  }

  /** Every title with its artwork state, for the admin dashboard. */
  status() {
    return this.db.all('SELECT id, title, year, type, status, availability, poster, backdrop, tmdb_id, tmdb_type, artwork FROM titles ORDER BY title').map((r) => {
      const a = parseJson(r.artwork, {});
      return {
        id: r.id,
        title: r.title,
        year: r.year,
        type: r.type,
        status: r.status,
        availability: r.availability,
        source: a.source || (r.poster ? 'manual' : null),
        locked: !!a.locked,
        hasPoster: !!r.poster,
        hasBackdrop: !!r.backdrop,
        tmdbId: r.tmdb_id,
        tmdbType: r.tmdb_type,
        syncedAt: a.tmdb?.syncedAt || null,
        lastResult: a.lastResult || null,
      };
    });
  }

  /**
   * Finds and stores TMDB artwork for one title. Options: tmdbId (+ tmdbType) to pin the entry
   * instead of searching; force to search again for an already-synced title; unlock to replace
   * locked (Lumina) artwork. Never throws for "no match" — returns {status}.
   */
  async syncTitle(id, { tmdbId = null, tmdbType = null, force = false, unlock = false } = {}) {
    const row = this.db.get('SELECT * FROM titles WHERE id = ?', id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'That title is not in the catalog.');
    const artwork = parseJson(row.artwork, {});
    if (artwork.locked && !unlock) return { id, status: 'skipped', message: 'This title has Lumina artwork, which sync leaves alone.' };
    if (!this.configured()) throw new HttpError(503, 'TMDB_NOT_CONFIGURED', 'TMDB is not configured. Set TMDB_API_TOKEN (or TMDB_API_KEY) on the server.');
    const type = tmdbType || row.tmdb_type || (row.type === 'series' ? 'tv' : 'movie');
    if (!['movie', 'tv'].includes(type)) throw new HttpError(422, 'VALIDATION_FAILED', 'tmdbType must be movie or tv.');

    let entryId = tmdbId || (force ? null : row.tmdb_id);
    let matchedBy = entryId ? 'id' : 'search';
    if (!entryId) {
      const yearParam = type === 'tv' ? 'first_air_date_year' : 'year';
      const query = { query: row.title, include_adult: 'false', language: 'en-US', page: 1 };
      // A forced sync asks TMDB again instead of trusting cached search results.
      const opts = { fresh: force };
      let match = pickMatch(row, (await this.tmdb(`/search/${type}`, { ...query, [yearParam]: row.year || undefined }, opts)).results, type);
      // A festival premiere can sit in the year before the release year TMDB indexes.
      if (!match && row.year) match = pickMatch(row, (await this.tmdb(`/search/${type}`, query, opts)).results, type);
      if (!match) return this.record(row, artwork, { status: 'not_found', message: `No TMDB ${type === 'tv' ? 'series' : 'film'} matches “${row.title}”${row.year ? ` (${row.year})` : ''} exactly.` });
      entryId = match.cand.id;
    }

    const d = await this.tmdb(`/${type}/${entryId}`, { language: 'en-US' }, { fresh: force });
    const dTitle = type === 'tv' ? d.name : d.title;
    const dYear = yearOf(type === 'tv' ? d.first_air_date : d.release_date);
    // Even a pinned id must describe the same work; refuse obvious mismatches.
    if (matchedBy === 'id' && !tmdbId && scoreCandidate(row, d, type) === null) {
      return this.record(row, artwork, { status: 'mismatch', message: `TMDB ${entryId} is “${dTitle}” (${dYear ?? 'no year'}), which does not match this title.` });
    }
    if (!d.poster_path && !d.backdrop_path) {
      return this.record(row, artwork, { status: 'no_artwork', message: `TMDB has no poster or backdrop for “${dTitle}”.` }, { tmdbId: entryId, tmdbType: type });
    }

    const next = {
      source: 'tmdb',
      posterSet: sizeSet(d.poster_path, POSTER_SIZES),
      backdropSet: sizeSet(d.backdrop_path, BACKDROP_SIZES),
      tmdb: { posterPath: d.poster_path || null, backdropPath: d.backdrop_path || null, matchedTitle: dTitle, matchedYear: dYear, syncedAt: now() },
      lastResult: { status: 'matched', at: now() },
    };
    this.db.tx(() => {
      this.db.run(
        'UPDATE titles SET poster = ?, backdrop = ?, tmdb_id = ?, tmdb_type = ?, artwork = ?, updated_at = ? WHERE id = ?',
        d.poster_path ? cacheUrl(500, d.poster_path) : null,
        d.backdrop_path ? cacheUrl(1280, d.backdrop_path) : null,
        entryId, type, toJson(next), now(), row.id,
      );
    });
    let stills = 0;
    if (type === 'tv') stills = await this.syncStills(row.id, entryId);
    this.catalog?.invalidate();
    return { id, status: 'matched', tmdbId: entryId, tmdbType: type, matchedTitle: dTitle, matchedYear: dYear, poster: !!d.poster_path, backdrop: !!d.backdrop_path, stills, matchedBy };
  }

  /** Episode stills for a series, by season and episode number. Local stills are kept. */
  async syncStills(titleId, tvId) {
    const seasons = this.db.all('SELECT DISTINCT season_number AS n FROM episodes WHERE title_id = ?', titleId).map((r) => r.n);
    let count = 0;
    for (const n of seasons) {
      let season;
      try {
        season = await this.tmdb(`/tv/${tvId}/season/${n}`, { language: 'en-US' });
      } catch (err) {
        if (err.status === 404) continue;
        throw err;
      }
      for (const ep of season.episodes || []) {
        if (!ep.still_path) continue;
        const res = this.db.run(
          `UPDATE episodes SET still = ? WHERE title_id = ? AND season_number = ? AND number = ? AND (still IS NULL OR still LIKE '${CACHE_PREFIX}%')`,
          cacheUrl(300, ep.still_path), titleId, n, ep.episode_number,
        );
        count += res.changes || 0;
      }
    }
    return count;
  }

  record(row, artwork, result, ids = {}) {
    const next = { ...artwork, lastResult: { status: result.status, message: result.message, at: now() } };
    this.db.run('UPDATE titles SET artwork = ?, tmdb_id = COALESCE(?, tmdb_id), tmdb_type = COALESCE(?, tmdb_type) WHERE id = ?', toJson(next), ids.tmdbId ?? null, ids.tmdbType ?? null, row.id);
    return { id: row.id, ...result };
  }

  /** Syncs every title (or the given ids). One failure does not stop the others. */
  async syncAll({ ids = null, force = false } = {}) {
    if (!this.configured()) throw new HttpError(503, 'TMDB_NOT_CONFIGURED', 'TMDB is not configured. Set TMDB_API_TOKEN (or TMDB_API_KEY) on the server.');
    const rows = ids?.length ? ids.map((id) => ({ id })) : this.db.all('SELECT id FROM titles ORDER BY title');
    const results = [];
    for (const { id } of rows) {
      try {
        results.push(await this.syncTitle(id, { force }));
      } catch (err) {
        log.warn('artwork sync failed', { title: id, code: err.code, message: err.message });
        results.push({ id, status: 'error', code: err.code || 'ERROR', message: err instanceof HttpError ? err.message : 'Sync failed; see the server log.' });
        // Stop early when TMDB itself is unreachable or rejects the credential.
        if (['TMDB_UNAVAILABLE', 'TMDB_AUTH_FAILED'].includes(err.code)) break;
      }
    }
    this.catalog?.invalidate();
    const count = (s) => results.filter((r) => r.status === s).length;
    return { results, summary: { matched: count('matched'), notFound: count('not_found'), skipped: count('skipped'), noArtwork: count('no_artwork'), mismatch: count('mismatch'), errors: count('error') } };
  }

  /** True when some title or episode references this cached file (the image route serves nothing else). */
  isReferenced(file) {
    const like = `%/${file}%`;
    return !!(this.db.get('SELECT 1 FROM titles WHERE poster LIKE ? OR backdrop LIKE ? OR artwork LIKE ? LIMIT 1', like, like, like)
      || this.db.get('SELECT 1 FROM episodes WHERE still LIKE ? LIMIT 1', like));
  }

  /** Path of the cached image, downloading it once from TMDB's CDN when missing. */
  async cachedImage(size, file) {
    if (!IMAGE_SIZES.has(size) || !TMDB_FILE.test(file)) return null;
    const path = join(this.cacheDir, size, file);
    if (existsSync(path)) return path;
    if (!this.isReferenced(file)) return null;
    const key = `${size}/${file}`;
    if (!this.inflight.has(key)) {
      this.inflight.set(key, this.download(size, file, path).finally(() => this.inflight.delete(key)));
    }
    return this.inflight.get(key);
  }

  async download(size, file, path) {
    const url = `${this.config.tmdb.imageBase}/${size}/${file}`;
    let res;
    try {
      res = await this.fetch(url, { signal: AbortSignal.timeout(10_000), redirect: 'error' });
    } catch (err) {
      log.warn('artwork download failed', { url, message: err.message });
      return null;
    }
    const type = res.headers.get('content-type') || '';
    const length = Number(res.headers.get('content-length') || 0);
    if (!res.ok || !/^image\/(jpeg|png|webp)\b/.test(type) || length > MAX_IMAGE_BYTES || !res.body) {
      res.body?.cancel?.().catch(() => {});
      log.warn('artwork download refused', { url, status: res.status, type });
      return null;
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.part`;
    let bytes = 0;
    try {
      const body = Readable.fromWeb(res.body);
      body.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_IMAGE_BYTES) body.destroy(new Error('image too large'));
      });
      await pipeline(body, createWriteStream(tmp));
      await rename(tmp, path);
      return path;
    } catch (err) {
      await rm(tmp, { force: true });
      log.warn('artwork download aborted', { url, message: err.message });
      return null;
    }
  }
}

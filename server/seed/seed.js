// Seeds the catalog from data/seed/catalog.seed.json on first start, and exports the public
// catalog snapshot (data/catalog.json) that Preview mode (static hosting) reads.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config, ROOT } from '../config.js';
import { cdnUrl } from '../services/artwork.js';
import { now, toJson } from '../db/index.js';
import { log } from '../lib/log.js';
import { minAgeFor } from '../../js/core/ratings.js';

export const SEED_FILE = join(ROOT, 'data', 'seed', 'catalog.seed.json');

function insertMedia(db, m, { titleId, episodeId = null, role = 'main' }) {
  if (!m) return;
  const ts = now();
  db.run(
    `INSERT INTO media (id, title_id, episode_id, role, label, kind, source, fallbacks, variants, resolutions, audio_tracks, subtitle_tracks,
                        audio_formats, video_codecs, hdr, duration_s, intro_start, intro_end, credits_start, status, verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?, ?)`,
    m.id || `med_${episodeId || titleId}${role === 'main' ? '' : `_${role}`}`,
    titleId, episodeId, role, m.label || null, m.kind, m.source,
    toJson(m.fallbacks || []), toJson(m.variants || []), toJson(m.resolutions || []),
    toJson(m.audioTracks || []), toJson(m.subtitleTracks || []), toJson(m.audioFormats || []), toJson(m.videoCodecs || []),
    m.hdr || null, m.durationS ?? null, m.introStart ?? null, m.introEnd ?? null, m.creditsStart ?? null,
    m.verified ? (m.verifiedAt || ts) : null, ts, ts,
  );
}

/** Imports catalog entries in the seed format. Existing ids are skipped. */
export function importCatalog(db, seed) {
  let added = 0;
  db.tx(() => {
    for (const t of seed.titles || []) {
      if (db.get('SELECT 1 FROM titles WHERE id = ?', t.id)) continue;
      const ts = now();
      db.run(
        `INSERT INTO titles (id, type, title, original_title, tagline, synopsis, year, release_date, runtime_min, age_rating, rating_source, min_age,
                             genres, tags, moods, keywords, countries, original_language, credits, awards, poster, backdrop, palette, license,
                             status, featured, editorial_rank, added_at, updated_at, published_at, availability, tmdb_id, tmdb_type, artwork)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        t.id, t.type, t.title, t.originalTitle || null, t.tagline || null, t.synopsis || '', t.year ?? null, t.releaseDate || null,
        t.runtimeMin ?? null, t.ageRating || 'NR', t.ratingSource || 'advisory', minAgeFor(t.ageRating || 'NR'),
        toJson(t.genres || []), toJson(t.tags || []), toJson(t.moods || []), toJson(t.keywords || []), toJson(t.countries || []),
        t.originalLanguage || null, toJson(t.credits || {}), toJson(t.awards || []), t.poster || null, t.backdrop || null,
        toJson(t.palette || []), toJson(t.license || {}), t.status || 'published', t.featured ? 1 : 0, t.editorialRank ?? 1000,
        t.addedAt || ts, ts, (t.status || 'published') === 'published' ? ts : null,
        t.availability === 'catalog' ? 'catalog' : 'stream', t.tmdb?.id ?? null, t.tmdb?.type || null, toJson(t.artwork || {}),
      );
      insertMedia(db, t.media, { titleId: t.id });
      insertMedia(db, t.trailer, { titleId: t.id, role: 'trailer' });
      for (const s of t.seasons || []) {
        db.run('INSERT INTO seasons (id, title_id, number, name, synopsis, year) VALUES (?, ?, ?, ?, ?, ?)', `${t.id}-s${s.number}`, t.id, s.number, s.name || null, s.synopsis || null, s.year ?? null);
        for (const e of s.episodes || []) {
          db.run(
            'INSERT INTO episodes (id, title_id, season_number, number, name, synopsis, runtime_min, still, air_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
            e.id, t.id, s.number, e.number, e.name, e.synopsis || '', e.runtimeMin ?? null, e.still || null, e.airDate || null,
          );
          insertMedia(db, e.media, { titleId: t.id, episodeId: e.id });
        }
      }
      added++;
    }
  });
  return added;
}

export function seedIfEmpty(db) {
  const count = db.get('SELECT COUNT(*) AS n FROM titles').n;
  if (count > 0 || !existsSync(SEED_FILE)) return 0;
  const added = importCatalog(db, JSON.parse(readFileSync(SEED_FILE, 'utf8')));
  log.info('catalog seeded', { titles: added });
  return added;
}

/**
 * Public snapshot for Preview mode: every published title's detail plus its playable
 * public media. Media stored privately ("storage:") is never exported.
 */
export function exportCatalog(db, catalog, { imageBase = config.tmdb.imageBase } = {}) {
  // Static hosting has no artwork cache, so synced TMDB images point at TMDB's CDN there.
  const cdn = (url) => cdnUrl(url, imageBase);
  const cdnSet = (srcset) => (srcset ? srcset.split(', ').map((part) => { const [u, w] = part.split(' '); return `${cdn(u)} ${w}`; }).join(', ') : srcset);
  const titles = catalog.load().summaries.map((s) => catalog.detail(s.id)).map((t) => ({
    ...t,
    poster: cdn(t.poster),
    backdrop: cdn(t.backdrop),
    ...(t.posterSrcset ? { posterSrcset: cdnSet(t.posterSrcset) } : {}),
    ...(t.backdropSrcset ? { backdropSrcset: cdnSet(t.backdropSrcset) } : {}),
    seasons: (t.seasons || []).map((season) => ({ ...season, episodes: season.episodes.map((e) => ({ ...e, still: cdn(e.still) })) })),
  }));
  const mediaRows = db.all(`SELECT * FROM media WHERE status = 'ready' AND source NOT LIKE 'storage:%'`);
  const media = {};
  for (const m of mediaRows) {
    media[m.id] = {
      id: m.id,
      titleId: m.title_id,
      episodeId: m.episode_id,
      role: m.role,
      kind: m.kind,
      src: m.source,
      fallbacks: JSON.parse(m.fallbacks),
      variants: JSON.parse(m.variants),
      resolutions: JSON.parse(m.resolutions),
      verified: !!m.verified_at,
      audioTracks: JSON.parse(m.audio_tracks),
      subtitleTracks: JSON.parse(m.subtitle_tracks),
      audioFormats: JSON.parse(m.audio_formats),
      hdr: m.hdr,
      durationS: m.duration_s,
      introStart: m.intro_start,
      introEnd: m.intro_end,
      creditsStart: m.credits_start,
    };
  }
  return { version: 1, generatedAt: now(), titles, media };
}

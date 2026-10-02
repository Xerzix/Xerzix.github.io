// TMDB metadata import (metadata only — never media). Administrators search TMDB and
// pre-fill the title form with the result; nothing is saved until they review and save it.
// The token (TMDB_API_TOKEN, a v4 "read access token") stays on the server.
//
// The mapping functions are pure and unit-tested with fixture JSON (tests/unit/tmdb.test.js).
import { AGE_RATINGS } from '../../../js/core/ratings.js';
import { HttpError } from '../../lib/errors.js';

const API = 'https://api.themoviedb.org/3';
const IMAGE = 'https://image.tmdb.org/t/p';
const KNOWN_RATINGS = new Set(AGE_RATINGS.map((r) => r.code));

// TMDB's TV genres combine two ideas ("Action & Adventure"); Lumina keeps them separate.
const GENRE_SPLIT = {
  'Action & Adventure': ['Action', 'Adventure'],
  'Sci-Fi & Fantasy': ['Science Fiction', 'Fantasy'],
  'War & Politics': ['War', 'Politics'],
};
const CREW_JOBS = new Set(['Screenplay', 'Writer', 'Story', 'Novel', 'Producer', 'Executive Producer', 'Original Music Composer', 'Director of Photography', 'Editor', 'Production Design', 'Creator']);

const year = (date) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const image = (path, size) => (path ? `${IMAGE}/${size}${path}` : null);

export function mapGenres(genres = []) {
  const out = [];
  for (const g of genres) for (const name of GENRE_SPLIT[g.name] || [g.name]) if (name && !out.includes(name)) out.push(name);
  return out;
}

/** US certification for a movie (release_dates) — prefers theatrical, then any dated release. */
export function movieCertification(details) {
  const us = details.release_dates?.results?.find((r) => r.iso_3166_1 === 'US');
  if (!us) return null;
  const dates = [...(us.release_dates || [])].sort((a, b) => (a.type === 3 ? -1 : 0) - (b.type === 3 ? -1 : 0));
  const cert = dates.map((d) => (d.certification || '').trim()).find(Boolean);
  return cert || null;
}

/** US TV Parental Guidelines rating for a series (content_ratings). */
export function tvCertification(details) {
  const us = details.content_ratings?.results?.find((r) => r.iso_3166_1 === 'US');
  return us?.rating?.trim() || null;
}

/**
 * Rating fields. rating_source is 'official' only when TMDB reports a US certification that
 * Lumina recognises; otherwise the title is 'NR' and staff must assign an advisory rating.
 */
export function ratingFields(cert) {
  if (cert && KNOWN_RATINGS.has(cert) && cert !== 'NR') return { ageRating: cert, ratingSource: 'official', certification: cert };
  return { ageRating: 'NR', ratingSource: 'advisory', certification: cert || null };
}

function credits(castList = [], crewList = [], directors = []) {
  const seen = new Set();
  return {
    directors,
    cast: castList
      .slice()
      .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
      .slice(0, 15)
      .map((c) => ({ name: c.name, role: c.character || c.roles?.[0]?.character || undefined }))
      .filter((c) => c.name),
    crew: crewList
      .filter((c) => CREW_JOBS.has(c.job || c.jobs?.[0]?.job))
      .map((c) => ({ name: c.name, job: c.job || c.jobs?.[0]?.job }))
      .filter((c) => {
        const k = `${c.name}|${c.job}`;
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 20),
  };
}

/** Maps a TMDB movie details payload (append_to_response=credits,release_dates,keywords). */
export function mapMovie(d) {
  const directors = [...new Set((d.credits?.crew || []).filter((c) => c.job === 'Director').map((c) => c.name))];
  return {
    type: 'movie',
    title: d.title || d.original_title || '',
    originalTitle: d.original_title && d.original_title !== d.title ? d.original_title : null,
    tagline: d.tagline || null,
    synopsis: d.overview || '',
    year: year(d.release_date),
    releaseDate: d.release_date || null,
    runtimeMin: d.runtime || null,
    ...ratingFields(movieCertification(d)),
    genres: mapGenres(d.genres),
    keywords: (d.keywords?.keywords || []).map((k) => k.name).slice(0, 30),
    countries: (d.production_countries || []).map((c) => c.iso_3166_1).filter(Boolean),
    originalLanguage: d.original_language || null,
    credits: credits(d.credits?.cast, d.credits?.crew, directors),
    artwork: { poster: image(d.poster_path, 'w780'), backdrop: image(d.backdrop_path, 'w1280') },
    source: { provider: 'tmdb', id: d.id, url: `https://www.themoviedb.org/movie/${d.id}` },
  };
}

/** Maps a TMDB TV details payload (append_to_response=aggregate_credits,credits,content_ratings,keywords). */
export function mapTv(d) {
  const cast = d.aggregate_credits?.cast?.length ? d.aggregate_credits.cast : d.credits?.cast;
  const crew = d.aggregate_credits?.crew?.length ? d.aggregate_credits.crew : d.credits?.crew;
  return {
    type: 'series',
    title: d.name || d.original_name || '',
    originalTitle: d.original_name && d.original_name !== d.name ? d.original_name : null,
    tagline: d.tagline || null,
    synopsis: d.overview || '',
    year: year(d.first_air_date),
    releaseDate: d.first_air_date || null,
    runtimeMin: d.episode_run_time?.[0] || d.last_episode_to_air?.runtime || null,
    ...ratingFields(tvCertification(d)),
    genres: mapGenres(d.genres),
    keywords: (d.keywords?.results || []).map((k) => k.name).slice(0, 30),
    countries: d.origin_country?.length ? d.origin_country : (d.production_countries || []).map((c) => c.iso_3166_1),
    originalLanguage: d.original_language || null,
    credits: credits(cast, crew, (d.created_by || []).map((c) => c.name)),
    seasons: (d.seasons || [])
      .filter((s) => s.season_number > 0)
      .map((s) => ({ number: s.season_number, name: s.name, episodeCount: s.episode_count, year: year(s.air_date) })),
    artwork: { poster: image(d.poster_path, 'w780'), backdrop: image(d.backdrop_path, 'w1280') },
    source: { provider: 'tmdb', id: d.id, url: `https://www.themoviedb.org/tv/${d.id}` },
  };
}

/** Maps one search result (movie, tv or multi). People are dropped. */
export function mapSearchResult(r, forcedType) {
  const mediaType = forcedType || r.media_type;
  if (mediaType !== 'movie' && mediaType !== 'tv') return null;
  const isMovie = mediaType === 'movie';
  return {
    tmdbId: r.id,
    type: isMovie ? 'movie' : 'series',
    tmdbType: mediaType,
    title: isMovie ? r.title : r.name,
    originalTitle: isMovie ? r.original_title : r.original_name,
    year: year(isMovie ? r.release_date : r.first_air_date),
    overview: r.overview || '',
    poster: image(r.poster_path, 'w185'),
  };
}

export function isConfigured(config) {
  return !!config.tmdb?.token;
}

function notConfigured() {
  return new HttpError(503, 'TMDB_NOT_CONFIGURED', 'TMDB import is not configured. Set TMDB_API_TOKEN on the server to enable it.');
}

async function tmdbGet(config, path, params = {}, fetchImpl = fetch) {
  if (!isConfigured(config)) throw notConfigured();
  const url = new URL(API + path);
  for (const [k, val] of Object.entries(params)) if (val !== undefined && val !== null && val !== '') url.searchParams.set(k, String(val));
  let res;
  try {
    res = await fetchImpl(url, { headers: { Authorization: `Bearer ${config.tmdb.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new HttpError(502, 'TMDB_UNAVAILABLE', 'TMDB could not be reached. Try again later.');
  }
  if (res.status === 401) throw new HttpError(502, 'TMDB_AUTH_FAILED', 'TMDB rejected the configured token. Check TMDB_API_TOKEN.');
  if (res.status === 404) throw new HttpError(404, 'NOT_FOUND', 'TMDB has no entry with that id.');
  if (!res.ok) throw new HttpError(502, 'TMDB_UNAVAILABLE', `TMDB answered HTTP ${res.status}.`);
  return res.json();
}

export async function searchTmdb(config, { q, type = 'multi' }, fetchImpl) {
  const kind = type === 'movie' ? 'movie' : type === 'tv' || type === 'series' ? 'tv' : 'multi';
  const data = await tmdbGet(config, `/search/${kind}`, { query: q, include_adult: 'false', language: 'en-US', page: 1 }, fetchImpl);
  return {
    items: (data.results || []).map((r) => mapSearchResult(r, kind === 'multi' ? null : kind)).filter(Boolean).slice(0, 20),
  };
}

export async function tmdbDetails(config, { type, id }, fetchImpl) {
  if (type === 'movie') {
    const d = await tmdbGet(config, `/movie/${id}`, { append_to_response: 'credits,release_dates,keywords', language: 'en-US' }, fetchImpl);
    return mapMovie(d);
  }
  const d = await tmdbGet(config, `/tv/${id}`, { append_to_response: 'aggregate_credits,credits,content_ratings,keywords', language: 'en-US' }, fetchImpl);
  return mapTv(d);
}

// Live TMDB catalogue for visitors: search, trending, popular and top-rated lists, genres and
// title details. Everything goes through the server so the TMDB credential (TMDB_API_KEY or
// TMDB_API_TOKEN) never reaches the browser; the browser only receives mapped JSON and public
// image URLs on TMDB's image CDN.
//
// Responses are cached in memory (lists for minutes, genres and details for hours) so browsing
// thousands of titles stays well inside TMDB's rate limits. The mappers are pure and tested
// with fixture JSON (tests/unit/tmdb-catalog.test.js).
import { isConfigured, movieCertification, tmdbGet, tvCertification } from './admin/tmdb.js';

export const TMDB_ATTRIBUTION = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';
/** TMDB never serves results past page 500, whatever total_pages says. */
export const MAX_PAGE = 500;

const MINUTE = 60_000;
const TTL = { list: 10 * MINUTE, search: 5 * MINUTE, genres: 12 * 60 * MINUTE, details: 6 * 60 * MINUTE };
const CACHE_MAX = 800;

const year = (date) => (date && /^\d{4}/.test(date) ? Number(date.slice(0, 4)) : null);
const round1 = (n) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);

/** Poster/backdrop/profile URLs with a srcset in TMDB's standard widths. */
export function imageSet(base, path, kind) {
  if (!path) return null;
  const widths = kind === 'backdrop' ? ['w300', 'w780', 'w1280'] : kind === 'profile' ? ['w185'] : ['w185', 'w342', 'w500'];
  const src = `${base}/${kind === 'backdrop' ? 'w1280' : kind === 'profile' ? 'w185' : 'w342'}${path}`;
  return {
    src,
    srcset: widths.length > 1 ? widths.map((w) => `${base}/${w}${path} ${w.slice(1)}w`).join(', ') : null,
  };
}

/** One list/search result. `forcedType` is 'movie' or 'tv' for typed endpoints; people are dropped. */
export function mapSummary(r, { imageBase, genreNames = new Map(), forcedType = null } = {}) {
  const type = forcedType || r.media_type;
  if (type !== 'movie' && type !== 'tv') return null;
  const isMovie = type === 'movie';
  const releaseDate = (isMovie ? r.release_date : r.first_air_date) || null;
  return {
    id: r.id,
    type,
    title: (isMovie ? r.title || r.original_title : r.name || r.original_name) || 'Untitled',
    originalTitle: (isMovie ? r.original_title : r.original_name) || null,
    overview: r.overview || '',
    releaseDate,
    year: year(releaseDate),
    rating: r.vote_count ? round1(r.vote_average) : null,
    voteCount: r.vote_count || 0,
    genres: (r.genre_ids || []).map((id) => genreNames.get(id)).filter(Boolean),
    originalLanguage: r.original_language || null,
    poster: imageSet(imageBase, r.poster_path, 'poster'),
    backdrop: imageSet(imageBase, r.backdrop_path, 'backdrop'),
  };
}

/** A TMDB paged list → { page, totalPages, totalResults, items }. Pages are capped at MAX_PAGE. */
export function mapPage(data, opts) {
  const totalPages = Math.min(Number(data.total_pages) || 0, MAX_PAGE);
  return {
    page: Number(data.page) || 1,
    totalPages,
    totalResults: Number(data.total_results) || 0,
    items: (data.results || []).map((r) => mapSummary(r, opts)).filter(Boolean),
  };
}

/** Full title details (movie or tv) with cast, crew, certification and recommendations. */
export function mapDetails(d, type, { imageBase }) {
  const isMovie = type === 'movie';
  const base = mapSummary({ ...d, genre_ids: [] }, { imageBase, forcedType: type });
  const credits = isMovie ? d.credits : (d.aggregate_credits?.cast?.length ? d.aggregate_credits : d.credits);
  const cast = (credits?.cast || [])
    .slice()
    .sort((a, b) => (a.order ?? 999) - (b.order ?? 999))
    .slice(0, 20)
    .map((c) => ({
      id: c.id,
      name: c.name,
      character: c.character || c.roles?.[0]?.character || null,
      profile: imageSet(imageBase, c.profile_path, 'profile'),
    }))
    .filter((c) => c.name);
  const crew = d.credits?.crew || credits?.crew || [];
  const directors = isMovie
    ? [...new Set(crew.filter((c) => c.job === 'Director').map((c) => c.name))]
    : (d.created_by || []).map((c) => c.name);
  const writers = [...new Set(crew.filter((c) => ['Screenplay', 'Writer'].includes(c.job)).map((c) => c.name))].slice(0, 6);
  return {
    ...base,
    genres: (d.genres || []).map((g) => g.name),
    genreIds: (d.genres || []).map((g) => ({ id: g.id, name: g.name })),
    tagline: d.tagline || null,
    status: d.status || null,
    runtimeMin: isMovie ? d.runtime || null : d.episode_run_time?.[0] || d.last_episode_to_air?.runtime || null,
    certification: (isMovie ? movieCertification(d) : tvCertification(d)) || null,
    seasonCount: isMovie ? null : d.number_of_seasons ?? null,
    episodeCount: isMovie ? null : d.number_of_episodes ?? null,
    countries: isMovie ? (d.production_countries || []).map((c) => c.iso_3166_1) : d.origin_country || [],
    spokenLanguages: (d.spoken_languages || []).map((l) => l.english_name || l.name).filter(Boolean),
    directors,
    directorLabel: isMovie ? 'Director' : 'Created by',
    writers,
    cast,
    homepage: /^https:\/\//.test(d.homepage || '') ? d.homepage : null,
    tmdbUrl: `https://www.themoviedb.org/${type}/${d.id}`,
    recommendations: (d.recommendations?.results || [])
      .map((r) => mapSummary(r, { imageBase, forcedType: type }))
      .filter(Boolean)
      .slice(0, 18),
  };
}

const TRENDING_TYPES = new Set(['all', 'movie', 'tv']);
const SORTS = {
  popular: 'popularity.desc',
  rating: 'vote_average.desc',
  newest: 'primary_release_date.desc',
};

export class TmdbCatalog {
  constructor(config, { fetchImpl = (...a) => fetch(...a) } = {}) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.cache = new Map();
  }

  configured() {
    return isConfigured(this.config);
  }

  get imageBase() {
    return this.config.tmdb.imageBase || 'https://image.tmdb.org/t/p';
  }

  /** Cached GET. Concurrent identical requests share one TMDB call; failures are not cached. */
  async get(path, params, ttl) {
    const key = `${path}?${new URLSearchParams(params).toString()}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    if (hit && hit.expires > now) return hit.value;
    const value = tmdbGet(this.config, path, params, this.fetchImpl);
    this.cache.set(key, { value, expires: now + ttl });
    value.catch(() => {
      if (this.cache.get(key)?.value === value) this.cache.delete(key);
    });
    if (this.cache.size > CACHE_MAX) {
      // Map keeps insertion order: drop the oldest entries.
      for (const k of [...this.cache.keys()].slice(0, this.cache.size - CACHE_MAX)) this.cache.delete(k);
    }
    return value;
  }

  /** id → name for both movie and TV genres. A failure leaves cards without genre names. */
  async genreNames() {
    try {
      const { movie, tv } = await this.genres();
      return new Map([...movie, ...tv].map((g) => [g.id, g.name]));
    } catch {
      return new Map();
    }
  }

  async genres() {
    const [movie, tv] = await Promise.all([
      this.get('/genre/movie/list', { language: 'en-US' }, TTL.genres),
      this.get('/genre/tv/list', { language: 'en-US' }, TTL.genres),
    ]);
    return { movie: movie.genres || [], tv: tv.genres || [] };
  }

  async page(path, params, ttl, forcedType) {
    const [data, genreNames] = await Promise.all([this.get(path, params, ttl), this.genreNames()]);
    return mapPage(data, { imageBase: this.imageBase, genreNames, forcedType });
  }

  trending({ type = 'all', window = 'week', page = 1 } = {}) {
    const t = TRENDING_TYPES.has(type) ? type : 'all';
    const w = window === 'day' ? 'day' : 'week';
    return this.page(`/trending/${t}/${w}`, { language: 'en-US', page }, TTL.list, t === 'all' ? null : t);
  }

  popular({ type, page = 1 }) {
    return this.page(`/${type}/popular`, { language: 'en-US', page }, TTL.list, type);
  }

  topRated({ type, page = 1 }) {
    return this.page(`/${type}/top_rated`, { language: 'en-US', page }, TTL.list, type);
  }

  /** Titles in one genre, via /discover. Rating sorts need enough votes to be meaningful. */
  discover({ type, genre, sort = 'popular', page = 1 }) {
    let sortBy = SORTS[sort] || SORTS.popular;
    if (type === 'tv' && sortBy === SORTS.newest) sortBy = 'first_air_date.desc';
    const params = {
      language: 'en-US',
      page,
      sort_by: sortBy,
      with_genres: genre,
      include_adult: 'false',
      'vote_count.gte': sort === 'rating' ? 200 : sort === 'newest' ? 10 : undefined,
      // "Newest" means released already, not announced for next year.
      [type === 'tv' ? 'first_air_date.lte' : 'primary_release_date.lte']: sort === 'newest' ? new Date().toISOString().slice(0, 10) : undefined,
    };
    for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
    return this.page(`/discover/${type}`, params, TTL.list, type);
  }

  search({ q, type = 'multi', page = 1 }) {
    const kind = type === 'movie' || type === 'tv' ? type : 'multi';
    return this.page(`/search/${kind}`, { query: q, include_adult: 'false', language: 'en-US', page }, TTL.search, kind === 'multi' ? null : kind);
  }

  async details({ type, id }) {
    const append = type === 'movie'
      ? 'credits,release_dates,recommendations'
      : 'aggregate_credits,credits,content_ratings,recommendations';
    const d = await this.get(`/${type}/${id}`, { append_to_response: append, language: 'en-US' }, TTL.details);
    return mapDetails(d, type, { imageBase: this.imageBase });
  }
}

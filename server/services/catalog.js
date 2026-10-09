// Catalog read model. Published titles are loaded into memory (with a search index) and
// rebuilt whenever an administrator changes content. Every availability fact on a summary
// (resolutions, audio and subtitle languages) is derived from the title's actual media rows.
import { parseJson, placeholders } from '../db/index.js';
import { notFound, HttpError } from '../lib/errors.js';
import { buildIndex, search as runSearch, suggest as runSuggest } from '../../js/core/search.js';
import { similarTitles } from '../../js/core/similarity.js';
import { allowedFor } from '../../js/core/ratings.js';
import { signedUrl } from './storage.js';
import { canPlay } from './entitlements.js';
import { artSrcset, artUploadId } from './media/artwork.js';

const RATINGS_TTL_MS = 30_000;

export function qualityLabel(heights) {
  const max = heights?.[0] || 0;
  if (max >= 2160) return '4K';
  if (max >= 720) return 'HD';
  if (max > 0) return 'SD';
  return null;
}

function mediaRowToDto(m) {
  return {
    id: m.id,
    kind: m.kind,
    source: m.source,
    variants: parseJson(m.variants, []),
    fallbacks: parseJson(m.fallbacks, []),
    resolutions: parseJson(m.resolutions, []).sort((a, b) => b - a),
    audioTracks: parseJson(m.audio_tracks, []),
    subtitleTracks: parseJson(m.subtitle_tracks, []),
    audioFormats: parseJson(m.audio_formats, []),
    videoCodecs: parseJson(m.video_codecs, []),
    hdr: m.hdr || null,
    durationS: m.duration_s,
    introStart: m.intro_start,
    introEnd: m.intro_end,
    creditsStart: m.credits_start,
    status: m.status,
    verified: !!m.verified_at,
    role: m.role,
    label: m.label,
    titleId: m.title_id,
    episodeId: m.episode_id,
  };
}

/** Resolves stored media locations into URLs the browser can load. */
export function resolveSource(source) {
  if (!source) return null;
  if (source.startsWith('storage:')) return signedUrl(source.slice('storage:'.length));
  return source;
}

function intersectSorted(lists) {
  if (!lists.length) return [];
  let acc = new Set(lists[0]);
  for (const l of lists.slice(1)) acc = new Set(l.filter((x) => acc.has(x)));
  return [...acc].sort((a, b) => b - a);
}

export class CatalogService {
  constructor(db) {
    this.db = db;
    this.cache = null;
    this.ratings = null;
    this.ratingsAt = 0;
    this.version = 0;
  }

  invalidate() {
    this.cache = null;
    this.version++;
  }

  invalidateRatings() {
    this.ratings = null;
    this.cache = null;
  }

  memberRatings() {
    if (this.ratings && Date.now() - this.ratingsAt < RATINGS_TTL_MS) return this.ratings;
    const rows = this.db.all(`SELECT title_id, AVG(rating) AS avg, COUNT(*) AS n FROM reviews WHERE status = 'visible' GROUP BY title_id`);
    this.ratings = new Map(rows.map((r) => [r.title_id, { average: Math.round(r.avg * 10) / 10, count: r.n }]));
    this.ratingsAt = Date.now();
    return this.ratings;
  }

  /** Builds summaries for the given title rows (any status). */
  buildSummaries(rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const media = this.db.all(`SELECT * FROM media WHERE title_id IN (${placeholders(ids.length)}) AND status = 'ready'`, ...ids);
    const episodes = this.db.all(`SELECT id, title_id, season_number FROM episodes WHERE title_id IN (${placeholders(ids.length)})`, ...ids);
    const ratings = this.memberRatings();
    const mediaByTitle = new Map();
    for (const m of media) {
      if (!mediaByTitle.has(m.title_id)) mediaByTitle.set(m.title_id, []);
      mediaByTitle.get(m.title_id).push(mediaRowToDto(m));
    }
    const epByTitle = new Map();
    for (const e of episodes) {
      if (!epByTitle.has(e.title_id)) epByTitle.set(e.title_id, []);
      epByTitle.get(e.title_id).push(e);
    }
    // Responsive sizes of uploaded artwork (srcset), when resized copies were made.
    const artIds = [...new Set(rows.flatMap((r) => [artUploadId(r.poster), artUploadId(r.backdrop)]).filter(Boolean))];
    const art = new Map(artIds.length
      ? this.db.all(`SELECT id, result FROM uploads WHERE id IN (${placeholders(artIds.length)}) AND status = 'complete'`, ...artIds).map((u) => [u.id, parseJson(u.result, null)])
      : []);
    const srcset = (url) => (artUploadId(url) ? artSrcset(url, art.get(artUploadId(url))) : null);
    return rows.map((r) => {
      const s = this.summaryFromRow(r, mediaByTitle.get(r.id) || [], epByTitle.get(r.id) || [], ratings.get(r.id) || null);
      const posterSrcset = srcset(r.poster);
      const backdropSrcset = srcset(r.backdrop);
      if (posterSrcset) s.posterSrcset = posterSrcset;
      if (backdropSrcset) s.backdropSrcset = backdropSrcset;
      return s;
    });
  }

  summaryFromRow(r, media, episodes, rating) {
    const credits = parseJson(r.credits, {});
    const main = media.filter((m) => m.role === 'main' && (r.type === 'movie' ? !m.episodeId : !!m.episodeId));
    const verifiedHeights = main.filter((m) => m.verified && m.resolutions.length).map((m) => m.resolutions);
    const resolutions = verifiedHeights.length === main.length ? intersectSorted(verifiedHeights) : [];
    const audioLanguages = [...new Set(main.flatMap((m) => m.audioTracks.map((a) => a.lang)).filter(Boolean))];
    const subtitleLanguages = [...new Set(main.flatMap((m) => m.subtitleTracks.map((s) => s.lang)).filter(Boolean))];
    const audioFormats = [...new Set(main.flatMap((m) => m.audioFormats))];
    const seasons = new Set(episodes.map((e) => e.season_number));
    const trailer = media.find((m) => m.role === 'trailer');
    return {
      id: r.id,
      type: r.type,
      title: r.title,
      originalTitle: r.original_title || null,
      tagline: r.tagline || null,
      synopsis: r.synopsis,
      year: r.year,
      releaseDate: r.release_date,
      runtimeMin: r.runtime_min,
      ageRating: r.age_rating,
      ratingSource: r.rating_source,
      minAge: r.min_age,
      genres: parseJson(r.genres, []),
      tags: parseJson(r.tags, []),
      moods: parseJson(r.moods, []),
      keywords: parseJson(r.keywords, []),
      countries: parseJson(r.countries, []),
      originalLanguage: r.original_language,
      directors: credits.directors || [],
      cast: (credits.cast || []).slice(0, 8).map((c) => c.name),
      awards: parseJson(r.awards, []),
      poster: r.poster,
      backdrop: r.backdrop,
      palette: parseJson(r.palette, []),
      resolutions,
      quality: qualityLabel(resolutions),
      hdr: main.some((m) => m.hdr) ? main.find((m) => m.hdr).hdr : null,
      audioLanguages,
      subtitleLanguages,
      hasSubtitles: subtitleLanguages.length > 0,
      audioFormats,
      seasonCount: r.type === 'series' ? seasons.size : null,
      episodeCount: r.type === 'series' ? episodes.length : null,
      playable: main.length > 0,
      hasTrailer: !!trailer,
      memberRating: rating,
      featured: !!r.featured,
      editorialRank: r.editorial_rank,
      status: r.status,
      addedAt: r.added_at,
      publishedAt: r.published_at,
    };
  }

  load() {
    if (this.cache) return this.cache;
    const rows = this.db.all(`SELECT * FROM titles WHERE status = 'published' ORDER BY editorial_rank, title`);
    const summaries = this.buildSummaries(rows);
    const byId = new Map(summaries.map((s) => [s.id, s]));
    // The admin-curated genre order and editorial collections (Admin → Settings), if saved.
    const taxonomy = parseJson(this.db.get(`SELECT value FROM platform_settings WHERE key = 'taxonomy'`)?.value, null);
    this.cache = { summaries, byId, index: buildIndex(summaries), rowsById: new Map(rows.map((r) => [r.id, r])), taxonomy };
    return this.cache;
  }

  /** Admin-defined editorial collections ([{ id, name, description? }]), in the admin's order. */
  editorialCollections() {
    const list = this.load().taxonomy?.collections;
    return Array.isArray(list) ? list : [];
  }

  /** Published summaries visible to the profile (parental controls applied). */
  published(profile) {
    const p = profile ? { maxAge: profile.max_age ?? profile.maxAge ?? null } : null;
    return this.load().summaries.filter((t) => allowedFor(p, t.minAge));
  }

  visibleIndex(profile) {
    const p = profile ? { maxAge: profile.max_age ?? null } : null;
    return this.load().index.filter((d) => allowedFor(p, d.t.minAge));
  }

  search(params, profile) {
    return runSearch(this.visibleIndex(profile), params);
  }

  suggest(q, profile) {
    return runSuggest(this.visibleIndex(profile), q);
  }

  similar(id, profile, limit = 12) {
    const target = this.load().byId.get(id);
    if (!target) throw notFound('That title is not in the Lumina catalog.');
    return similarTitles(target, this.published(profile), limit);
  }

  genres(profile) {
    const counts = new Map();
    for (const t of this.published(profile)) for (const g of t.genres) counts.set(g, (counts.get(g) || 0) + 1);
    // Genres follow the order an administrator saved in the taxonomy; the rest are alphabetical.
    const order = new Map((this.load().taxonomy?.genres || []).map((g, i) => [String(g).toLowerCase(), i]));
    const rank = (name) => order.get(name.toLowerCase()) ?? Infinity;
    return [...counts.entries()].map(([name, count]) => ({ name, count })).sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  }

  /** Full detail for a published title, or 404. `allowUnpublished` is for staff/owners. */
  detail(id, { profile = null, allowUnpublished = false } = {}) {
    let row = this.load().rowsById.get(id);
    let summary = this.load().byId.get(id);
    if (!row && allowUnpublished) {
      row = this.db.get('SELECT * FROM titles WHERE id = ?', id);
      if (row) summary = this.buildSummaries([row])[0];
    }
    if (!row) throw notFound('That title is not in the Lumina catalog.');
    if (profile && !allowedFor({ maxAge: profile.max_age ?? null }, row.min_age)) {
      throw new HttpError(403, 'PROFILE_RESTRICTED', 'This title is outside the maturity setting for this profile.');
    }
    const credits = parseJson(row.credits, {});
    const seasons = this.db.all('SELECT * FROM seasons WHERE title_id = ? ORDER BY number', id);
    const episodes = this.db.all('SELECT * FROM episodes WHERE title_id = ? ORDER BY season_number, number', id);
    const epMedia = new Set(this.db.all(`SELECT episode_id FROM media WHERE title_id = ? AND role = 'main' AND status = 'ready' AND episode_id IS NOT NULL`, id).map((m) => m.episode_id));
    const trailer = this.db.get(`SELECT id FROM media WHERE title_id = ? AND role = 'trailer' AND status = 'ready' LIMIT 1`, id);
    const creator = row.creator_account_id ? this.db.get('SELECT id, display_name, is_creator FROM accounts WHERE id = ?', row.creator_account_id) : null;
    const seasonNumbers = [...new Set([...seasons.map((s) => s.number), ...episodes.map((e) => e.season_number)])].sort((a, b) => a - b);
    return {
      ...summary,
      credits: { directors: credits.directors || [], cast: credits.cast || [], crew: credits.crew || [] },
      license: parseJson(row.license, {}),
      trailerMediaId: trailer?.id || null,
      // `id` is what members follow (PUT /api/follows/creator/:id); only set while the account
      // still holds creator access, since the follow route accepts creators only.
      creator: creator ? { id: creator.is_creator ? creator.id : null, name: creator.display_name } : null,
      seasons: row.type === 'series'
        ? seasonNumbers.map((n) => {
          const s = seasons.find((x) => x.number === n) || {};
          return {
            number: n,
            name: s.name || `Season ${n}`,
            synopsis: s.synopsis || '',
            year: s.year || null,
            episodes: episodes.filter((e) => e.season_number === n).map((e) => episodeDto(e, epMedia.has(e.id))),
          };
        })
        : [],
    };
  }

  /** Everything the player needs, with entitlement and parental checks applied. */
  playback(titleId, episodeId, { profile = null, account = null, role = 'main', progress = null } = {}) {
    const detail = this.detail(titleId, { profile });
    const ent = canPlay({ account, title: detail });
    if (!ent.allowed) throw new HttpError(402, ent.reason, ent.message);

    let episode = null;
    let mediaRow;
    if (role === 'trailer') {
      mediaRow = this.db.get(`SELECT * FROM media WHERE title_id = ? AND role = 'trailer' AND status = 'ready' LIMIT 1`, titleId);
    } else if (detail.type === 'series') {
      const all = detail.seasons.flatMap((s) => s.episodes);
      if (!all.length) throw notFound('This series has no episodes yet.');
      episode = episodeId ? all.find((e) => e.id === episodeId) : null;
      if (episodeId && !episode) throw notFound('That episode does not exist.');
      if (!episode) {
        // Resume the most recently watched episode, else start at the first.
        const last = progress?.lastEpisodeId && all.find((e) => e.id === progress.lastEpisodeId);
        episode = last || all[0];
      }
      mediaRow = this.db.get(`SELECT * FROM media WHERE episode_id = ? AND role = 'main' AND status = 'ready' LIMIT 1`, episode.id);
    } else {
      mediaRow = this.db.get(`SELECT * FROM media WHERE title_id = ? AND episode_id IS NULL AND role = 'main' AND status = 'ready' LIMIT 1`, titleId);
    }
    if (!mediaRow) throw new HttpError(404, 'MEDIA_UNAVAILABLE', 'No playable media is available for this title yet.');
    const media = mediaRowToDto(mediaRow);
    const src = resolveSource(media.source);
    const out = {
      titleId,
      title: stripDetail(detail),
      episode: episode ? { ...episode } : null,
      media: {
        id: media.id,
        kind: media.kind,
        src,
        variants: media.variants.map((v) => ({ ...v, src: resolveSource(v.src) })),
        fallbacks: media.fallbacks.map((f) => ({ ...f, src: resolveSource(f.src) })),
        resolutions: media.resolutions,
        verified: media.verified,
        audioTracks: media.audioTracks,
        subtitleTracks: media.subtitleTracks.map((s) => ({ ...s, src: resolveSource(s.src) })),
        audioFormats: media.audioFormats,
        hdr: media.hdr,
        durationS: media.durationS,
        introStart: media.introStart,
        introEnd: media.introEnd,
        creditsStart: media.creditsStart,
      },
      next: null,
      previous: null,
      resumeAt: 0,
    };
    if (episode) {
      const all = detail.seasons.flatMap((s) => s.episodes).filter((e) => e.hasMedia);
      const i = all.findIndex((e) => e.id === episode.id);
      out.next = i >= 0 && all[i + 1] ? all[i + 1] : null;
      out.previous = i > 0 ? all[i - 1] : null;
    }
    return out;
  }
}

export function episodeDto(e, hasMedia = true) {
  return {
    id: e.id,
    seasonNumber: e.season_number,
    number: e.number,
    name: e.name,
    synopsis: e.synopsis,
    runtimeMin: e.runtime_min,
    still: e.still,
    airDate: e.air_date,
    hasMedia,
  };
}

function stripDetail(d) {
  const { seasons, credits, license, ...rest } = d;
  return rest;
}

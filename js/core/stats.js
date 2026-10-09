// Private viewing statistics, computed from a profile's own viewing history. Shared by the
// server (/api/library/stats) and Preview mode (device-local history). Pure: no I/O, no DOM.
//
// Every figure is derived from recorded history rows; nothing is estimated or padded. A
// history row is one viewing session: { titleId, episodeId, watchedAt, seconds }.
// "Mark as watched" creates a row with 0 seconds, so it counts as watched but adds no time.

const MONTHS = 12;
const TOP_GENRES = 8;
const RECENT = 12;
const FAVORITES = 6;

/** 'YYYY-MM' in UTC for an ISO timestamp or epoch ms. */
export function monthKey(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The last `count` month keys ending with the month containing `now`, oldest first. */
export function lastMonths(now, count = MONTHS) {
  const d = new Date(now);
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    const m = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - i, 1));
    out.push(`${m.getUTCFullYear()}-${String(m.getUTCMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

/** Strips heavy detail fields so stats return plain TitleSummary-like objects. */
function summary(t) {
  if (!t) return t;
  const { seasons, credits, license, ...rest } = t;
  return rest;
}

/** Episode count for a series: detail seasons when present, else the summary's episodeCount. */
function episodeTotal(t) {
  if (Array.isArray(t.seasons) && t.seasons.length) return t.seasons.reduce((n, s) => n + (s.episodes?.length || 0), 0);
  return t.episodeCount || 0;
}

/**
 * @param {Array<{titleId, episodeId?, watchedAt, seconds?}>} historyRows  the profile's history
 * @param {object[]} titles  catalog titles (summaries or details) used to resolve ids
 * @param {{ now?: number, progress?: Array<{titleId, episodeId?, completed}> }} options
 *   progress: optional completed-episode records (server) that supplement history when
 *   deciding whether a series has been completed.
 */
export function computeStats(historyRows, titles, { now = Date.now(), progress = [] } = {}) {
  const byId = new Map((titles || []).map((t) => [t.id, t]));
  const rows = (historyRows || [])
    .filter((r) => r && r.titleId && r.watchedAt && !Number.isNaN(Date.parse(r.watchedAt)))
    .map((r) => ({ titleId: r.titleId, episodeId: r.episodeId || '', watchedAt: r.watchedAt, seconds: Math.max(0, Math.round(Number(r.seconds) || 0)) }))
    .sort((a, b) => Date.parse(b.watchedAt) - Date.parse(a.watchedAt));

  let totalSeconds = 0;
  const titleIds = new Set();
  const episodes = new Set();
  const perTitle = new Map(); // titleId -> { seconds, sessions, lastWatchedAt }
  const genreSeconds = new Map();
  const genreTitles = new Map();
  const monthly = new Map(lastMonths(now).map((m) => [m, 0]));
  const wholeSeriesMarked = new Set();
  const episodesByTitle = new Map();

  for (const r of rows) {
    totalSeconds += r.seconds;
    titleIds.add(r.titleId);
    const m = monthKey(r.watchedAt);
    if (monthly.has(m)) monthly.set(m, monthly.get(m) + r.seconds);

    const pt = perTitle.get(r.titleId) || { seconds: 0, sessions: 0, lastWatchedAt: r.watchedAt };
    pt.seconds += r.seconds;
    pt.sessions += 1;
    perTitle.set(r.titleId, pt);

    const t = byId.get(r.titleId);
    if (t?.type === 'series') {
      if (r.episodeId) {
        episodes.add(`${r.titleId}::${r.episodeId}`);
        if (!episodesByTitle.has(r.titleId)) episodesByTitle.set(r.titleId, new Set());
        episodesByTitle.get(r.titleId).add(r.episodeId);
      } else {
        // A series row without an episode is "Mark as watched" for the whole series.
        wholeSeriesMarked.add(r.titleId);
      }
    }
  }

  const addEpisode = (titleId, episodeId) => {
    episodes.add(`${titleId}::${episodeId}`);
    if (!episodesByTitle.has(titleId)) episodesByTitle.set(titleId, new Set());
    episodesByTitle.get(titleId).add(episodeId);
  };
  // Completed episodes from progress (e.g. "Mark series watched" on the server) count as watched.
  for (const p of progress || []) {
    if (!p?.completed || !p.episodeId || !titleIds.has(p.titleId)) continue;
    addEpisode(p.titleId, p.episodeId);
  }
  // A whole-series mark covers every episode we know about.
  for (const id of wholeSeriesMarked) {
    for (const s of byId.get(id)?.seasons || []) for (const e of s.episodes || []) addEpisode(id, e.id);
  }

  for (const [id, pt] of perTitle) {
    const t = byId.get(id);
    if (!t) continue;
    for (const g of t.genres || []) {
      genreSeconds.set(g, (genreSeconds.get(g) || 0) + pt.seconds);
      genreTitles.set(g, (genreTitles.get(g) || 0) + 1);
    }
  }

  const known = [...titleIds].filter((id) => byId.has(id));
  const moviesWatched = known.filter((id) => byId.get(id).type === 'movie').length;

  const completedSeries = known
    .map((id) => byId.get(id))
    .filter((t) => t.type === 'series')
    .filter((t) => {
      if (wholeSeriesMarked.has(t.id)) return true;
      const total = episodeTotal(t);
      return total > 0 && (episodesByTitle.get(t.id)?.size || 0) >= total;
    })
    .map(summary);

  const topGenres = [...genreTitles.keys()]
    .map((genre) => ({ genre, seconds: genreSeconds.get(genre) || 0, titles: genreTitles.get(genre) || 0 }))
    .sort((a, b) => b.seconds - a.seconds || b.titles - a.titles || a.genre.localeCompare(b.genre))
    .slice(0, TOP_GENRES);

  const recent = [];
  const seenRecent = new Set();
  for (const r of rows) {
    if (seenRecent.has(r.titleId) || !byId.has(r.titleId)) continue;
    seenRecent.add(r.titleId);
    recent.push({ title: summary(byId.get(r.titleId)), watchedAt: r.watchedAt });
    if (recent.length >= RECENT) break;
  }

  // Favourites: the titles this profile has spent the most time with (actual seconds only).
  const favorites = [...perTitle.entries()]
    .filter(([id, pt]) => byId.has(id) && pt.seconds > 0)
    .sort((a, b) => b[1].seconds - a[1].seconds || b[1].sessions - a[1].sessions || Date.parse(b[1].lastWatchedAt) - Date.parse(a[1].lastWatchedAt))
    .slice(0, FAVORITES)
    .map(([id, pt]) => ({ ...summary(byId.get(id)), watchedSeconds: pt.seconds, sessions: pt.sessions }));

  return {
    enabled: true,
    totalSeconds,
    sessions: rows.length,
    titlesWatched: titleIds.size,
    episodesWatched: episodes.size,
    moviesWatched,
    completedSeries,
    topGenres,
    recent,
    favorites,
    monthly: [...monthly.entries()].map(([month, seconds]) => ({ month, seconds })),
    firstWatchedAt: rows.length ? rows[rows.length - 1].watchedAt : null,
  };
}

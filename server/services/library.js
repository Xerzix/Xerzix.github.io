// Per-profile library: My List, playback progress, viewing history and home signals.
// Every function takes a profile id that the route has already verified belongs to the
// signed-in account (see requireProfile); callers never pass client-supplied profile ids.
import { now, parseJson } from '../db/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import { episodeDto } from './catalog.js';

const HISTORY_MERGE_MS = 30 * 60_000;
const COMPLETE_RATIO = 0.95;

export class LibraryService {
  constructor(db, catalog) {
    this.db = db;
    this.catalog = catalog;
  }

  // ── My List ───────────────────────────────────────────────
  watchlistIds(profileId) {
    return this.db.all('SELECT title_id, added_at, sort_order FROM watchlist WHERE profile_id = ? ORDER BY sort_order, added_at DESC', profileId);
  }

  addToList(profile, titleId) {
    this.assertVisible(profile, titleId);
    const min = this.db.get('SELECT MIN(sort_order) AS m FROM watchlist WHERE profile_id = ?', profile.id)?.m ?? 0;
    this.db.run('INSERT OR IGNORE INTO watchlist (profile_id, title_id, added_at, sort_order) VALUES (?, ?, ?, ?)', profile.id, titleId, now(), min - 1);
  }

  removeFromList(profileId, titleId) {
    this.db.run('DELETE FROM watchlist WHERE profile_id = ? AND title_id = ?', profileId, titleId);
  }

  reorderList(profileId, titleIds) {
    this.db.tx(() => {
      titleIds.forEach((id, i) => this.db.run('UPDATE watchlist SET sort_order = ? WHERE profile_id = ? AND title_id = ?', i, profileId, id));
    });
  }

  // ── Progress & history ────────────────────────────────────
  assertVisible(profile, titleId) {
    const t = this.catalog.load().byId.get(titleId);
    if (!t) throw notFound('That title is not in the Lumina catalog.');
    if (profile.max_age !== null && profile.max_age !== undefined && t.minAge > profile.max_age) {
      throw new HttpError(403, 'PROFILE_RESTRICTED', 'This title is outside the maturity setting for this profile.');
    }
    return t;
  }

  /**
   * Records playback position. `watchedDelta` is the number of seconds actually played since
   * the previous report (the client bounds it; the server caps it again).
   */
  saveProgress(profile, { titleId, episodeId = '', positionS, durationS = null, completed, watchedDelta = 0 }) {
    const title = this.assertVisible(profile, titleId);
    if (title.type === 'series') {
      if (!episodeId) throw new HttpError(422, 'VALIDATION_FAILED', 'Episode is required for series.', { fields: { episodeId: 'Required for series.' } });
      const ep = this.db.get('SELECT id FROM episodes WHERE id = ? AND title_id = ?', episodeId, titleId);
      if (!ep) throw notFound('That episode does not exist.');
    } else {
      episodeId = '';
    }
    const media = this.db.get(
      `SELECT credits_start, duration_s FROM media WHERE role = 'main' AND status = 'ready' AND ${episodeId ? 'episode_id = ?' : 'title_id = ? AND episode_id IS NULL'} LIMIT 1`,
      episodeId || titleId,
    );
    const duration = durationS || media?.duration_s || null;
    const isComplete = completed ?? !!(duration && (positionS / duration >= COMPLETE_RATIO || (media?.credits_start && positionS >= media.credits_start)));
    const ts = now();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO progress (profile_id, title_id, episode_id, position_s, duration_s, completed, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (profile_id, title_id, episode_id) DO UPDATE SET position_s = excluded.position_s,
           duration_s = COALESCE(excluded.duration_s, progress.duration_s), completed = excluded.completed, updated_at = excluded.updated_at`,
        profile.id, titleId, episodeId, Math.max(0, positionS), duration, isComplete ? 1 : 0, ts,
      );
      const delta = Math.max(0, Math.min(Number(watchedDelta) || 0, 60));
      const last = this.db.get('SELECT id, updated_at FROM history WHERE profile_id = ? AND title_id = ? AND episode_id = ? ORDER BY updated_at DESC LIMIT 1', profile.id, titleId, episodeId);
      if (last && Date.now() - Date.parse(last.updated_at) < HISTORY_MERGE_MS) {
        this.db.run('UPDATE history SET seconds = seconds + ?, updated_at = ? WHERE id = ?', Math.round(delta), ts, last.id);
      } else {
        this.db.run('INSERT INTO history (profile_id, title_id, episode_id, watched_at, updated_at, seconds) VALUES (?, ?, ?, ?, ?, ?)', profile.id, titleId, episodeId, ts, ts, Math.round(delta));
      }
    });
    return { completed: isComplete, positionS, durationS: duration, updatedAt: ts };
  }

  markWatched(profile, titleId, episodeId = '') {
    const title = this.assertVisible(profile, titleId);
    const ts = now();
    const targets = title.type === 'series' && !episodeId
      ? this.db.all('SELECT id FROM episodes WHERE title_id = ?', titleId).map((e) => e.id)
      : [title.type === 'series' ? episodeId : ''];
    this.db.tx(() => {
      for (const ep of targets) {
        this.db.run(
          `INSERT INTO progress (profile_id, title_id, episode_id, position_s, duration_s, completed, updated_at)
           VALUES (?, ?, ?, COALESCE((SELECT duration_s FROM media WHERE ${ep ? 'episode_id' : 'title_id'} = ? AND role = 'main' LIMIT 1), 0), NULL, 1, ?)
           ON CONFLICT (profile_id, title_id, episode_id) DO UPDATE SET completed = 1, updated_at = excluded.updated_at`,
          profile.id, titleId, ep, ep || titleId, ts,
        );
      }
      this.db.run('INSERT INTO history (profile_id, title_id, episode_id, watched_at, updated_at, seconds) VALUES (?, ?, ?, ?, ?, 0)', profile.id, titleId, title.type === 'series' ? episodeId : '', ts, ts);
    });
  }

  unmarkWatched(profileId, titleId) {
    this.db.run('DELETE FROM progress WHERE profile_id = ? AND title_id = ?', profileId, titleId);
  }

  /** Progress rows for the profile, newest first, with episode info for series. */
  progressRows(profileId) {
    const rows = this.db.all('SELECT * FROM progress WHERE profile_id = ? ORDER BY updated_at DESC LIMIT 500', profileId);
    const epIds = rows.map((r) => r.episode_id).filter(Boolean);
    const eps = epIds.length ? this.db.all(`SELECT * FROM episodes WHERE id IN (${epIds.map(() => '?').join(',')})`, ...epIds) : [];
    const epById = new Map(eps.map((e) => [e.id, e]));
    return rows.map((r) => ({
      titleId: r.title_id,
      episodeId: r.episode_id || null,
      positionS: r.position_s,
      durationS: r.duration_s,
      completed: !!r.completed,
      updatedAt: r.updated_at,
      episode: r.episode_id && epById.has(r.episode_id) ? episodeDto(epById.get(r.episode_id)) : null,
    }));
  }

  nextEpisodeAfter(titleId, episodeId) {
    const eps = this.db.all(
      `SELECT e.* FROM episodes e WHERE e.title_id = ? AND EXISTS (SELECT 1 FROM media m WHERE m.episode_id = e.id AND m.role = 'main' AND m.status = 'ready')
       ORDER BY e.season_number, e.number`,
      titleId,
    );
    const i = eps.findIndex((e) => e.id === episodeId);
    return i >= 0 && eps[i + 1] ? episodeDto(eps[i + 1]) : null;
  }

  /** Where to resume a title: the saved position, and for series the last episode watched. */
  resumeInfo(profileId, titleId, episodeId) {
    if (episodeId) {
      const p = this.db.get('SELECT position_s, completed FROM progress WHERE profile_id = ? AND title_id = ? AND episode_id = ?', profileId, titleId, episodeId);
      return { lastEpisodeId: episodeId, positionS: p && !p.completed ? p.position_s : 0 };
    }
    const p = this.db.get('SELECT episode_id, position_s, completed FROM progress WHERE profile_id = ? AND title_id = ? ORDER BY updated_at DESC LIMIT 1', profileId, titleId);
    if (!p) return { lastEpisodeId: null, positionS: 0 };
    if (p.completed && p.episode_id) {
      const next = this.nextEpisodeAfter(titleId, p.episode_id);
      return { lastEpisodeId: next ? next.id : p.episode_id, positionS: 0 };
    }
    return { lastEpisodeId: p.episode_id || null, positionS: p.completed ? 0 : p.position_s };
  }

  history(profileId, { page = 1, pageSize = 50 } = {}) {
    const total = this.db.get('SELECT COUNT(*) AS n FROM history WHERE profile_id = ?', profileId).n;
    const rows = this.db.all('SELECT * FROM history WHERE profile_id = ? ORDER BY watched_at DESC LIMIT ? OFFSET ?', profileId, pageSize, (page - 1) * pageSize);
    return { total, page, pageSize, rows };
  }

  removeHistoryEntry(profileId, id) {
    const r = this.db.run('DELETE FROM history WHERE profile_id = ? AND id = ?', profileId, id);
    if (!r.changes) throw notFound();
  }

  clearHistory(profileId) {
    this.db.tx(() => {
      this.db.run('DELETE FROM history WHERE profile_id = ?', profileId);
      this.db.run('DELETE FROM progress WHERE profile_id = ?', profileId);
    });
  }

  ownRatings(profileId) {
    const out = {};
    for (const r of this.db.all('SELECT title_id, rating FROM reviews WHERE profile_id = ?', profileId)) out[r.title_id] = r.rating;
    return out;
  }

  /** Compact state for cards: which titles are in My List and how far along each one is. */
  summary(profileId) {
    const progress = {};
    for (const p of this.progressRows(profileId)) {
      if (!progress[p.titleId]) progress[p.titleId] = { episodeId: p.episodeId, positionS: p.positionS, durationS: p.durationS, completed: p.completed, updatedAt: p.updatedAt };
    }
    return { watchlistIds: this.watchlistIds(profileId).map((w) => w.title_id), progress, ratings: this.ownRatings(profileId) };
  }

  /** Signals for js/core/home-rows.js composeHome(). */
  homeSignals(profile) {
    const prefs = parseJson(profile.preferences, {});
    const useHistory = prefs?.privacy?.useHistoryForRecommendations !== false;
    const progress = this.progressRows(profile.id).map((p) => (p.completed && p.episodeId ? { ...p, nextEpisode: this.nextEpisodeAfter(p.titleId, p.episodeId) } : p));
    return {
      progress,
      watchlist: this.watchlistIds(profile.id).map((w) => ({ titleId: w.title_id, addedAt: w.added_at })),
      history: this.db.all('SELECT title_id AS titleId, MAX(watched_at) AS watchedAt FROM history WHERE profile_id = ? GROUP BY title_id ORDER BY watchedAt DESC LIMIT 50', profile.id),
      ratings: this.ownRatings(profile.id),
      useHistory,
    };
  }
}

/** Platform-wide activity used for Trending (plays in the last 14 days, distinct profiles). */
export function platformActivity(db) {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString();
  const out = {};
  for (const r of db.all('SELECT title_id, COUNT(DISTINCT profile_id) AS n FROM history WHERE watched_at >= ? GROUP BY title_id', since)) out[r.title_id] = r.n;
  return out;
}

export function communityActivity(db) {
  const out = {};
  for (const r of db.all(`SELECT title_id, COUNT(*) AS reviews, SUM(comment_count) AS comments FROM reviews WHERE status = 'visible' AND body IS NOT NULL GROUP BY title_id`)) {
    out[r.title_id] = { reviews: r.reviews, comments: r.comments || 0 };
  }
  return out;
}

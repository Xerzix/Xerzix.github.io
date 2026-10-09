// Playback quality: member-submitted reports (subjective) and the public per-title summary.
//
// The summary always keeps two sources apart:
//   • measured — aggregated from Lumina players' own telemetry (playback_sessions)
//   • reports  — what members told us about their experience (quality_reports)
// Each half carries a `sufficient` flag. Below the threshold the numbers are withheld
// (null / empty) so a handful of sessions or reports is never presented as a statistic.
//
// Measured figures come only from signed-in members' sessions, and each member counts
// once: their sessions are first combined into one set of figures per member, then
// averaged across members (the start time is the median across members). One member — or
// a script replaying telemetry — can therefore move a figure by at most 1/N, and the
// threshold is a number of different members, not of sessions. Anonymous sessions are
// still recorded for the operators' usage view but are not published.
import { now, toJson } from '../db/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import { newId } from '../lib/crypto.js';

export const QUALITY_CATEGORIES = ['buffering', 'interruptions', 'poor_quality', 'audio_sync', 'missing_subtitles', 'wrong_language', 'playback_error', 'crash', 'other'];
export const QUALITY_WINDOW_DAYS = 90;
export const REPORTS_THRESHOLD = 5; // distinct reporters
export const VIEWERS_THRESHOLD = 10; // different signed-in members with measured sessions
const PER_TITLE_DAILY_REPORTS = 3;
const CACHE_MS = 30_000;

const round = (n, digits = 0) => (n === null || n === undefined || !Number.isFinite(n) ? null : Math.round(n * 10 ** digits) / 10 ** digits);

export class QualityService {
  constructor(db, catalog) {
    this.db = db;
    this.catalog = catalog;
    this.cache = new Map();
  }

  invalidate(titleId) {
    if (titleId) this.cache.delete(titleId);
    else this.cache.clear();
  }

  /**
   * Stores a member's report. The route has validated the body; here we check the title
   * (and episode) exist and are visible to the reporter, and cap duplicates per day.
   */
  createReport({ account, profile }, body) {
    this.catalog.detail(body.titleId, { profile });
    let episodeId = null;
    if (body.episodeId) {
      const ep = this.db.get('SELECT id FROM episodes WHERE id = ? AND title_id = ?', body.episodeId, body.titleId);
      if (!ep) throw notFound('That episode does not exist.');
      episodeId = ep.id;
    }
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const recent = this.db.get('SELECT COUNT(*) AS n FROM quality_reports WHERE account_id = ? AND title_id = ? AND created_at >= ?', account.id, body.titleId, since).n;
    if (recent >= PER_TITLE_DAILY_REPORTS) {
      throw new HttpError(429, 'RATE_LIMITED', 'You have already reported this title several times today. Thank you — our team will look into it.', { retryAfter: 3600 });
    }
    const media = episodeId
      ? this.db.get(`SELECT id FROM media WHERE episode_id = ? AND role = 'main' LIMIT 1`, episodeId)
      : this.db.get(`SELECT id FROM media WHERE title_id = ? AND episode_id IS NULL AND role = 'main' LIMIT 1`, body.titleId);
    const id = newId('qr');
    const ts = now();
    this.db.run(
      `INSERT INTO quality_reports (id, title_id, episode_id, media_id, account_id, category, description, device, connection_mbps, selected_resolution, diagnostics, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
      id, body.titleId, episodeId, media?.id || null, account.id, body.category, body.description || null, body.device || null,
      body.connectionMbps ?? null, body.selectedResolution || null, body.diagnostics && Object.keys(body.diagnostics).length ? toJson(body.diagnostics) : null, ts,
    );
    this.invalidate(body.titleId);
    return { id, titleId: body.titleId, episodeId, category: body.category, status: 'open', createdAt: ts };
  }

  /** Public aggregate for a title over the last 90 days. */
  summary(titleId) {
    const hit = this.cache.get(titleId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
    const since = new Date(Date.now() - QUALITY_WINDOW_DAYS * 86_400_000).toISOString();
    const value = { window: `${QUALITY_WINDOW_DAYS}d`, reports: this.reportSummary(titleId, since), measured: this.measuredSummary(titleId, since) };
    this.cache.set(titleId, { at: Date.now(), value });
    return value;
  }

  reportSummary(titleId, since) {
    const totals = this.db.get(
      'SELECT COUNT(*) AS count, COUNT(DISTINCT account_id) AS reporters FROM quality_reports WHERE title_id = ? AND created_at >= ?',
      titleId, since,
    );
    const sufficient = totals.reporters >= REPORTS_THRESHOLD;
    const categories = sufficient
      ? this.db.all(
        `SELECT category, COUNT(*) AS count FROM quality_reports WHERE title_id = ? AND created_at >= ?
         GROUP BY category ORDER BY count DESC, category`,
        titleId, since,
      )
      : [];
    return { count: totals.count, distinctReporters: totals.reporters, threshold: REPORTS_THRESHOLD, categories, sufficient };
  }

  measuredSummary(titleId, since) {
    // A session counts once the player actually started, played something or failed.
    const perViewer = `
      SELECT account_id,
             COUNT(*) AS sessions,
             SUM(seconds_watched) AS watched,
             SUM(rebuffer_seconds) AS rebuffer,
             AVG(CASE WHEN error_count > 0 THEN 1.0 ELSE 0.0 END) AS errorShare,
             SUM(CASE WHEN avg_bitrate_kbps IS NOT NULL AND seconds_watched > 0 THEN avg_bitrate_kbps * seconds_watched END)
               / SUM(CASE WHEN avg_bitrate_kbps IS NOT NULL AND seconds_watched > 0 THEN seconds_watched END) AS bitrate,
             AVG(startup_ms) AS startup
        FROM playback_sessions
       WHERE title_id = ? AND started_at >= ? AND account_id IS NOT NULL
         AND (seconds_watched > 0 OR error_count > 0 OR startup_ms IS NOT NULL)
       GROUP BY account_id`;
    const agg = this.db.get(
      `WITH per AS (${perViewer})
       SELECT COUNT(*) AS viewers,
              COALESCE(SUM(sessions), 0) AS sessions,
              AVG(CASE WHEN watched + rebuffer > 0 THEN rebuffer / (watched + rebuffer) END) AS rebufferRatio,
              AVG(errorShare) AS errorRate,
              AVG(bitrate) AS bitrate
         FROM per`,
      titleId, since,
    );
    const viewers = agg.viewers || 0;
    const sessions = agg.sessions || 0;
    const sufficient = viewers >= VIEWERS_THRESHOLD;
    const base = { viewers, sessions, threshold: VIEWERS_THRESHOLD };
    if (!sufficient) {
      return { ...base, rebufferRatio: null, avgBitrateKbps: null, errorRate: null, medianStartupMs: null, sufficient };
    }
    return {
      ...base,
      rebufferRatio: agg.rebufferRatio === null ? 0 : round(agg.rebufferRatio, 4),
      avgBitrateKbps: agg.bitrate === null ? null : round(agg.bitrate),
      errorRate: round(agg.errorRate || 0, 4),
      medianStartupMs: this.medianStartup(perViewer, titleId, since),
      sufficient,
    };
  }

  /** Median across members of each member's average start time. */
  medianStartup(perViewer, titleId, since) {
    const row = this.db.get(
      `WITH per AS (${perViewer}),
            ranked AS (SELECT startup, ROW_NUMBER() OVER (ORDER BY startup) AS rn, COUNT(*) OVER () AS n FROM per WHERE startup IS NOT NULL)
       SELECT AVG(startup) AS median FROM ranked WHERE rn IN ((n + 1) / 2, (n + 2) / 2)`,
      titleId, since,
    );
    return row?.median === null || row?.median === undefined ? null : Math.round(row.median);
  }
}

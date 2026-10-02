// Playback quality: member-submitted reports (subjective) and the public per-title summary.
//
// The summary always keeps two sources apart:
//   • measured — aggregated from Lumina players' own telemetry (playback_sessions)
//   • reports  — what members told us about their experience (quality_reports)
// Each half carries a `sufficient` flag. Below the threshold the numbers are withheld
// (null / empty) so a handful of sessions or reports is never presented as a statistic.
import { now, toJson } from '../db/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import { newId } from '../lib/crypto.js';

export const QUALITY_CATEGORIES = ['buffering', 'interruptions', 'poor_quality', 'audio_sync', 'missing_subtitles', 'wrong_language', 'playback_error', 'crash', 'other'];
export const QUALITY_WINDOW_DAYS = 90;
export const REPORTS_THRESHOLD = 5; // distinct reporters
export const SESSIONS_THRESHOLD = 10; // measured viewing sessions
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
    const where = `title_id = ? AND started_at >= ? AND (seconds_watched > 0 OR error_count > 0 OR startup_ms IS NOT NULL)`;
    const agg = this.db.get(
      `SELECT COUNT(*) AS sessions,
              SUM(seconds_watched) AS watched,
              SUM(rebuffer_seconds) AS rebuffer,
              SUM(CASE WHEN error_count > 0 THEN 1 ELSE 0 END) AS withErrors,
              SUM(CASE WHEN avg_bitrate_kbps IS NOT NULL AND seconds_watched > 0 THEN avg_bitrate_kbps * seconds_watched ELSE 0 END) AS bitrateWeighted,
              SUM(CASE WHEN avg_bitrate_kbps IS NOT NULL AND seconds_watched > 0 THEN seconds_watched ELSE 0 END) AS bitrateSeconds
         FROM playback_sessions WHERE ${where}`,
      titleId, since,
    );
    const sessions = agg.sessions || 0;
    const sufficient = sessions >= SESSIONS_THRESHOLD;
    if (!sufficient) {
      return { sessions, threshold: SESSIONS_THRESHOLD, rebufferRatio: null, avgBitrateKbps: null, errorRate: null, medianStartupMs: null, sufficient };
    }
    const watched = agg.watched || 0;
    const rebuffer = agg.rebuffer || 0;
    return {
      sessions,
      threshold: SESSIONS_THRESHOLD,
      rebufferRatio: watched + rebuffer > 0 ? round(rebuffer / (watched + rebuffer), 4) : 0,
      avgBitrateKbps: agg.bitrateSeconds > 0 ? round(agg.bitrateWeighted / agg.bitrateSeconds) : null,
      errorRate: round((agg.withErrors || 0) / sessions, 4),
      medianStartupMs: this.medianStartup(titleId, since, where),
      sufficient,
    };
  }

  medianStartup(titleId, since, where) {
    const n = this.db.get(`SELECT COUNT(*) AS n FROM playback_sessions WHERE ${where} AND startup_ms IS NOT NULL`, titleId, since).n;
    if (!n) return null;
    const rows = this.db.all(
      `SELECT startup_ms FROM playback_sessions WHERE ${where} AND startup_ms IS NOT NULL ORDER BY startup_ms LIMIT ? OFFSET ?`,
      titleId, since, n % 2 ? 1 : 2, Math.floor((n - 1) / 2),
    );
    return Math.round(rows.reduce((s, r) => s + r.startup_ms, 0) / rows.length);
  }
}

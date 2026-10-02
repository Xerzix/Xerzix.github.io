// Playback telemetry measured by Lumina players themselves (objective data). One row per
// viewing session in `playback_sessions`, plus individual error events in `playback_errors`.
//
// Clients report cumulative totals for their session every minute and at exit; the server
// upserts the row by the client-generated session id and clamps every value so a buggy or
// hostile client cannot distort the aggregates (see quality.js). User-reported, subjective
// quality lives in a separate table and is never mixed with these measurements.
import { now } from '../db/index.js';
import { HttpError, notFound } from '../lib/errors.js';

export const TELEMETRY_LIMITS = {
  secondsWatched: 24 * 3600,
  startupMs: 120_000,
  rebufferCount: 10_000,
  rebufferSeconds: 24 * 3600,
  avgBitrateKbps: 200_000,
  maxHeight: 4320,
  droppedFrames: 10_000_000,
  bytesEstimate: 1e12,
  errorCount: 1000,
  // Playback may run at up to 2x speed; allow a little slack on top of wall-clock time.
  maxSpeed: 2,
  slackS: 90,
  detailsBytes: 2048,
};

const RETENTION = { sessionsDays: 400, errorsDays: 180 };
const PRUNE_EVERY_MS = 3600_000;

const clamp = (n, min, max) => (Number.isFinite(n) ? Math.min(Math.max(n, min), max) : min);
const orNull = (n, min, max) => (n === undefined || n === null || !Number.isFinite(n) ? null : clamp(n, min, max));

/** Serializes client-supplied diagnostic details into bounded JSON (or null). */
export function boundedJson(value, maxBytes = TELEMETRY_LIMITS.detailsBytes) {
  if (value === undefined || value === null) return null;
  let text;
  try {
    text = JSON.stringify(value);
  } catch {
    return null;
  }
  if (!text || text === '{}' || text === '[]') return null;
  if (Buffer.byteLength(text) > maxBytes) return JSON.stringify({ truncated: true });
  return text;
}

export class TelemetryService {
  constructor(db) {
    this.db = db;
    this.lastPrune = 0;
    this.listeners = new Set();
  }

  /** Called with a title id whenever measurements for it change (used to drop caches). */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  changed(titleId) {
    for (const fn of this.listeners) fn(titleId);
  }

  /** Validates that `mediaId` is a media row of `titleId` (and of `episodeId`, when given). */
  resolveMedia(titleId, mediaId, episodeId) {
    const media = this.db.get('SELECT id, title_id, episode_id FROM media WHERE id = ? AND title_id = ?', mediaId, titleId);
    if (!media) throw notFound('That media does not belong to this title.', 'MEDIA_NOT_FOUND');
    if (episodeId && media.episode_id && media.episode_id !== episodeId) throw notFound('That media does not belong to this episode.', 'MEDIA_NOT_FOUND');
    return media;
  }

  /**
   * Upserts one viewing session. `body` is already validated by the route; values are
   * cumulative for the session and are clamped here.
   */
  recordSession({ account = null }, body) {
    const media = this.resolveMedia(body.titleId, body.mediaId, body.episodeId);
    const ts = now();
    const existing = this.db.get('SELECT id, account_id, media_id, started_at FROM playback_sessions WHERE id = ?', body.sessionId);
    if (existing) {
      // Only the viewer who started a session can keep reporting into it.
      if ((existing.account_id && existing.account_id !== account?.id) || existing.media_id !== media.id) {
        throw new HttpError(409, 'SESSION_CONFLICT', 'That playback session belongs to another viewer or media.');
      }
    }
    const startedAt = existing?.started_at || ts;
    const elapsedS = Math.max(0, (Date.now() - Date.parse(startedAt)) / 1000);
    const wallCap = elapsedS * TELEMETRY_LIMITS.maxSpeed + TELEMETRY_LIMITS.slackS;
    const L = TELEMETRY_LIMITS;
    const row = {
      seconds: clamp(body.secondsWatched, 0, Math.min(L.secondsWatched, wallCap)),
      startup: orNull(body.startupMs, 0, L.startupMs),
      rebufferCount: Math.round(clamp(body.rebufferCount, 0, L.rebufferCount)),
      rebufferSeconds: clamp(body.rebufferSeconds, 0, Math.min(L.rebufferSeconds, elapsedS + L.slackS)),
      bitrate: orNull(body.avgBitrateKbps, 0, L.avgBitrateKbps),
      maxHeight: orNull(body.maxHeight, 0, L.maxHeight),
      dropped: Math.round(clamp(body.droppedFrames, 0, L.droppedFrames)),
      bytes: Math.round(clamp(body.bytesEstimate, 0, L.bytesEstimate)),
      errors: Math.round(clamp(body.errorCount, 0, L.errorCount)),
    };
    if (existing) {
      this.db.run(
        `UPDATE playback_sessions SET account_id = COALESCE(account_id, ?), updated_at = ?, seconds_watched = ?, startup_ms = COALESCE(startup_ms, ?),
           rebuffer_count = ?, rebuffer_seconds = ?, avg_bitrate_kbps = ?, max_height = ?, dropped_frames = ?, bytes_estimate = ?, error_count = ?
         WHERE id = ?`,
        account?.id ?? null, ts, row.seconds, row.startup === null ? null : Math.round(row.startup), row.rebufferCount, row.rebufferSeconds, row.bitrate,
        row.maxHeight === null ? null : Math.round(row.maxHeight), row.dropped, row.bytes, row.errors, body.sessionId,
      );
    } else {
      this.db.run(
        `INSERT INTO playback_sessions (id, media_id, title_id, episode_id, account_id, started_at, updated_at, seconds_watched, startup_ms,
           rebuffer_count, rebuffer_seconds, avg_bitrate_kbps, max_height, dropped_frames, bytes_estimate, error_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        body.sessionId, media.id, media.title_id, media.episode_id || null, account?.id ?? null, ts, ts, row.seconds,
        row.startup === null ? null : Math.round(row.startup), row.rebufferCount, row.rebufferSeconds, row.bitrate,
        row.maxHeight === null ? null : Math.round(row.maxHeight), row.dropped, row.bytes, row.errors,
      );
    }
    this.changed(media.title_id);
    this.maybePrune();
    return { ok: true, secondsWatched: row.seconds };
  }

  /** Records a single player error. */
  recordError({ account = null, userAgent = '' }, body) {
    const title = this.db.get('SELECT id FROM titles WHERE id = ?', body.titleId);
    if (!title) throw notFound('That title is not in the Lumina catalog.');
    let mediaId = null;
    let episodeId = body.episodeId || null;
    if (body.mediaId) {
      const media = this.resolveMedia(body.titleId, body.mediaId, body.episodeId);
      mediaId = media.id;
      episodeId = media.episode_id || episodeId;
    }
    this.db.run(
      `INSERT INTO playback_errors (media_id, title_id, episode_id, account_id, code, message, fatal, details, user_agent, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mediaId, title.id, episodeId, account?.id ?? null, body.code, body.message || null, body.fatal ? 1 : 0,
      boundedJson(body.details), String(userAgent || '').slice(0, 300), now(),
    );
    this.changed(title.id);
    this.maybePrune();
    return { ok: true };
  }

  maybePrune() {
    if (Date.now() - this.lastPrune < PRUNE_EVERY_MS) return;
    this.lastPrune = Date.now();
    const sessionsBefore = new Date(Date.now() - RETENTION.sessionsDays * 86_400_000).toISOString();
    const errorsBefore = new Date(Date.now() - RETENTION.errorsDays * 86_400_000).toISOString();
    this.db.run('DELETE FROM playback_sessions WHERE updated_at < ?', sessionsBefore);
    this.db.run('DELETE FROM playback_errors WHERE created_at < ?', errorsBefore);
  }
}


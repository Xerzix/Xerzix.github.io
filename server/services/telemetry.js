// Playback telemetry measured by Lumina players themselves (objective data). One row per
// viewing session in `playback_sessions`, plus individual error events in `playback_errors`.
//
// Sessions are issued by the server: the player asks for one when it starts loading
// (POST /api/playback/sessions/open) and gets back a signed id that names the media, the
// viewer's account (or none) and the issue time. Reports for an id this server did not
// issue, for other media or from another account are rejected. The player then reports
// cumulative totals for that session every minute and at exit; the server upserts the row
// and bounds every value by the time elapsed since the session was issued (watch time,
// rebuffering, startup) and by the media's verified renditions (bitrate, bytes).
//
// These bounds stop a buggy client from recording impossible numbers, but a hostile client
// can still report plausible ones. That is why the public per-title summary (quality.js)
// counts each signed-in member once and leaves anonymous sessions out. User-reported,
// subjective quality lives in a separate table and is never mixed with these measurements.
import { randomBytes } from 'node:crypto';
import { now, parseJson } from '../db/index.js';
import { HttpError, notFound } from '../lib/errors.js';
import { hmac, safeEqual } from '../lib/crypto.js';

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
  // Playback may run at up to 2x speed; allow a little slack on top of wall-clock time for
  // the round trip that issued the session.
  maxSpeed: 2,
  slackS: 15,
  // A player keeps up to ~2 minutes of video buffered ahead and re-downloads after seeks or
  // quality switches, so bytes may exceed what was watched. This much extra content time
  // (growing with elapsed time) is allowed on top of the watched seconds.
  bufferBaseS: 30,
  bufferMaxS: 600,
  sessionTtlS: 48 * 3600,
  detailsBytes: 2048,
};

// Generous upper bounds for the bitrate of one rendition (video + audio), by height class.
// They are well above Lumina's ladders and common delivery profiles and are used only to
// bound what a client may claim, never shown as a measurement.
const BITRATE_CEILINGS_KBPS = [[360, 2_500], [480, 4_000], [720, 8_000], [1080, 16_000], [1440, 32_000], [2160, 80_000]];
const TOP_CEILING_KBPS = 160_000;

export function bitrateCeilingKbps(maxHeight) {
  if (!Number.isFinite(maxHeight) || maxHeight <= 0) return TOP_CEILING_KBPS;
  for (const [h, kbps] of BITRATE_CEILINGS_KBPS) if (maxHeight <= h) return kbps;
  return TOP_CEILING_KBPS;
}

const RETENTION = { sessionsDays: 400, errorsDays: 180 };
const PRUNE_EVERY_MS = 3600_000;
const SESSION_ID = /^([A-Za-z0-9_-]{16})\.([0-9a-z]{6,12})\.([A-Za-z0-9_-]{27})$/;

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

const signSession = (nonce, issued, mediaId, accountId) => hmac(`${nonce}.${issued}.${mediaId}.${accountId || ''}`, 'playback-session').slice(0, 27);

export class TelemetryService {
  constructor(db, { clock = () => Date.now() } = {}) {
    this.db = db;
    this.clock = clock;
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
    const media = this.db.get('SELECT id, title_id, episode_id, resolutions FROM media WHERE id = ? AND title_id = ?', mediaId, titleId);
    if (!media) throw notFound('That media does not belong to this title.', 'MEDIA_NOT_FOUND');
    if (episodeId && media.episode_id && media.episode_id !== episodeId) throw notFound('That media does not belong to this episode.', 'MEDIA_NOT_FOUND');
    return media;
  }

  /** Issues a signed viewing-session id for this viewer and media. */
  openSession({ account = null }, { titleId, mediaId, episodeId }) {
    const media = this.resolveMedia(titleId, mediaId, episodeId);
    const issuedAt = this.clock();
    const nonce = randomBytes(12).toString('base64url');
    const issued = issuedAt.toString(36);
    return { sessionId: `${nonce}.${issued}.${signSession(nonce, issued, media.id, account?.id)}`, issuedAt: new Date(issuedAt).toISOString() };
  }

  /** Returns the issue time (ms) of a session id issued to this viewer for this media. */
  verifySession(sessionId, mediaId, accountId) {
    const m = SESSION_ID.exec(String(sessionId || ''));
    const issuedAt = m ? parseInt(m[2], 36) : NaN;
    const age = this.clock() - issuedAt;
    if (!m || !Number.isFinite(issuedAt) || !safeEqual(m[3], signSession(m[1], m[2], mediaId, accountId)) || age < -60_000) {
      throw new HttpError(404, 'SESSION_NOT_FOUND', 'This playback session was not issued to this viewer for this media.');
    }
    if (age > TELEMETRY_LIMITS.sessionTtlS * 1000) throw new HttpError(404, 'SESSION_NOT_FOUND', 'This playback session has expired.');
    return issuedAt;
  }

  /**
   * Upserts one viewing session. `body` is already validated by the route; values are
   * cumulative for the session and are bounded here.
   */
  recordSession({ account = null }, body) {
    const media = this.resolveMedia(body.titleId, body.mediaId, body.episodeId);
    const issuedAt = this.verifySession(body.sessionId, media.id, account?.id);
    const ts = now();
    const existing = this.db.get('SELECT id, account_id, media_id FROM playback_sessions WHERE id = ?', body.sessionId);
    if (existing && ((existing.account_id && existing.account_id !== account?.id) || existing.media_id !== media.id)) {
      throw new HttpError(409, 'SESSION_CONFLICT', 'That playback session belongs to another viewer or media.');
    }
    const L = TELEMETRY_LIMITS;
    const elapsedS = Math.max(0, (this.clock() - issuedAt) / 1000);
    const heights = parseJson(media.resolutions, []).filter(Number.isFinite);
    const ceiling = bitrateCeilingKbps(heights.length ? Math.max(...heights) : null);
    const seconds = clamp(body.secondsWatched, 0, Math.min(L.secondsWatched, elapsedS * L.maxSpeed + L.slackS));
    const bufferS = Math.min(L.bufferMaxS, L.bufferBaseS + elapsedS);
    const row = {
      seconds,
      startup: orNull(body.startupMs, 0, Math.min(L.startupMs, (elapsedS + L.slackS) * 1000)),
      rebufferCount: Math.round(clamp(body.rebufferCount, 0, L.rebufferCount)),
      rebufferSeconds: clamp(body.rebufferSeconds, 0, Math.min(L.rebufferSeconds, elapsedS + L.slackS)),
      bitrate: orNull(body.avgBitrateKbps, 0, Math.min(L.avgBitrateKbps, ceiling)),
      maxHeight: orNull(body.maxHeight, 0, L.maxHeight),
      dropped: Math.round(clamp(body.droppedFrames, 0, L.droppedFrames)),
      // kbps × 125 = bytes per second.
      bytes: Math.round(clamp(body.bytesEstimate, 0, Math.min(L.bytesEstimate, ceiling * 125 * (seconds + bufferS)))),
      errors: Math.round(clamp(body.errorCount, 0, L.errorCount)),
    };
    const startup = row.startup === null ? null : Math.round(row.startup);
    const maxHeight = row.maxHeight === null ? null : Math.round(row.maxHeight);
    if (existing) {
      this.db.run(
        `UPDATE playback_sessions SET account_id = COALESCE(account_id, ?), updated_at = ?, seconds_watched = ?, startup_ms = COALESCE(startup_ms, ?),
           rebuffer_count = ?, rebuffer_seconds = ?, avg_bitrate_kbps = ?, max_height = ?, dropped_frames = ?, bytes_estimate = ?, error_count = ?
         WHERE id = ?`,
        account?.id ?? null, ts, row.seconds, startup, row.rebufferCount, row.rebufferSeconds, row.bitrate,
        maxHeight, row.dropped, row.bytes, row.errors, body.sessionId,
      );
    } else {
      this.db.run(
        `INSERT INTO playback_sessions (id, media_id, title_id, episode_id, account_id, started_at, updated_at, seconds_watched, startup_ms,
           rebuffer_count, rebuffer_seconds, avg_bitrate_kbps, max_height, dropped_frames, bytes_estimate, error_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        body.sessionId, media.id, media.title_id, media.episode_id || null, account?.id ?? null, new Date(issuedAt).toISOString(), ts, row.seconds,
        startup, row.rebufferCount, row.rebufferSeconds, row.bitrate, maxHeight, row.dropped, row.bytes, row.errors,
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

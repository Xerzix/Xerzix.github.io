// Per-viewing-session measurements and progress saving.
//
// Telemetry (server mode only) is objective: what this player measured — startup time,
// rebuffering, the measured bitrate of what was played, dropped frames, bytes and errors.
// The server issues the viewing-session id when loading starts; totals are sent every 60 s
// and when the viewer leaves, and never mixed with members' subjective quality reports.
// The latest measurements are also kept in sessionStorage so a member can choose to attach
// them to a quality report ("Attach playback diagnostics from this device").
import { api } from '../api/client.js';
import { clampDelta, uaSummary } from './helpers.js';

export const DIAGNOSTICS_KEY = 'lumina.player.diagnostics';
const FLUSH_MS = 60_000;
const MAX_ERROR_REPORTS = 10;

/** Fire-and-forget request that survives page unload (pagehide). Server mode only. */
export function keepaliveJson(method, path, body) {
  try {
    fetch(path, {
      method,
      keepalive: true,
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Lumina-Request': '1' },
      body: JSON.stringify(body),
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

export class Telemetry {
  constructor({ mode, media, titleId, episodeId }) {
    this.enabled = mode === 'server' && !!media?.id && !!titleId;
    this.reportErrors = mode === 'server' && !!titleId;
    this.sessionId = null; // issued by the server (see open())
    this.ids = { mediaId: media?.id, titleId, episodeId: episodeId || undefined };
    this.loadStart = performance.now();
    this.startupMs = null;
    this.secondsWatched = 0;
    this.rebufferCount = 0;
    this.rebufferSeconds = 0;
    this.rebufferStart = null;
    this.bitrateKbpsSeconds = 0;
    this.bitrateSeconds = 0;
    this.maxHeight = 0;
    this.frames = { baseDropped: null, baseTotal: null, dropped: 0, total: 0 };
    this.bytes = 0;
    this.errorCount = 0;
    this.errorCodes = [];
    this.errorsSent = 0;
    this.lastSnapshot = '';
    this.timer = this.enabled ? setInterval(() => this.flush(), FLUSH_MS) : null;
    if (this.enabled) this.open();
  }

  /** Asks the server for a viewing session. Without one, nothing is reported. */
  open() {
    Promise.resolve(api.request?.('POST', '/api/playback/sessions/open', { body: this.ids }))
      .then((res) => {
        if (res?.sessionId) this.sessionId = res.sessionId;
        else this.disable();
      })
      .catch(() => this.disable());
  }

  disable() {
    this.enabled = false;
    clearInterval(this.timer);
    this.timer = null;
  }

  /** Autoplay was blocked: measure startup from the viewer's own play press instead. */
  restartStartupClock() {
    if (this.startupMs === null) this.loadStart = performance.now();
  }

  onPlaying() {
    if (this.startupMs === null) this.startupMs = Math.round(performance.now() - this.loadStart);
    this.endRebuffer();
  }

  /** A `waiting` event after playback started that was not caused by a seek. */
  onStall() {
    if (this.startupMs === null || this.rebufferStart !== null) return;
    this.rebufferStart = performance.now();
  }

  endRebuffer() {
    if (this.rebufferStart === null) return;
    const s = (performance.now() - this.rebufferStart) / 1000;
    this.rebufferStart = null;
    if (s >= 0.1) {
      this.rebufferCount++;
      this.rebufferSeconds += s;
    }
  }

  /**
   * Seconds of content actually played, with the height in use and the measured bitrate of
   * that rendition (downloaded bytes over media duration; null when it was not measured).
   */
  addWatched(delta, { bitrate, height } = {}) {
    if (!(delta > 0)) return;
    this.secondsWatched += delta;
    if (bitrate > 0) {
      this.bitrateKbpsSeconds += (bitrate / 1000) * delta;
      this.bitrateSeconds += delta;
    }
    if (height > this.maxHeight) this.maxHeight = height;
  }

  sampleFrames(video) {
    const q = video.getVideoPlaybackQuality?.();
    if (!q) return;
    const f = this.frames;
    if (f.baseDropped === null || q.totalVideoFrames < f.baseTotal) {
      // First sample, or the element was reset (source switch): re-base but keep totals.
      f.accDropped = f.dropped;
      f.accTotal = f.total;
      f.baseDropped = q.droppedVideoFrames;
      f.baseTotal = q.totalVideoFrames;
    }
    f.dropped = (f.accDropped || 0) + q.droppedVideoFrames - f.baseDropped;
    f.total = (f.accTotal || 0) + q.totalVideoFrames - f.baseTotal;
  }

  setBytes(n) {
    if (Number.isFinite(n) && n > this.bytes) this.bytes = n;
  }

  get avgBitrateKbps() {
    return this.bitrateSeconds > 0 ? this.bitrateKbpsSeconds / this.bitrateSeconds : null;
  }

  recordError(err, context = {}) {
    this.errorCount++;
    this.errorCodes.push(String(err?.code || err?.type || 'unknown').slice(0, 64));
    if (this.errorCodes.length > 5) this.errorCodes.shift();
    if (!this.reportErrors || this.errorsSent >= MAX_ERROR_REPORTS) return;
    this.errorsSent++;
    const code = String(err?.code || err?.type || 'unknown').replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 64) || 'unknown';
    api.quality.error({
      mediaId: this.ids.mediaId,
      titleId: this.ids.titleId,
      episodeId: this.ids.episodeId,
      code,
      message: String(err?.message || '').slice(0, 500) || undefined,
      fatal: !!(context.fatal ?? err?.fatal),
      details: {
        type: err?.type,
        source: context.source,
        host: context.host,
        httpStatus: err?.httpStatus || undefined,
        position: Number.isFinite(context.position) ? Math.round(context.position) : undefined,
        height: context.height || undefined,
        fallbackIndex: context.fallbackIndex ?? undefined,
        online: typeof navigator !== 'undefined' ? navigator.onLine : undefined,
      },
    })?.catch?.(() => {});
  }

  payload() {
    const bitrate = this.avgBitrateKbps;
    return {
      sessionId: this.sessionId,
      ...this.ids,
      secondsWatched: Math.round(this.secondsWatched * 10) / 10,
      startupMs: this.startupMs ?? undefined,
      rebufferCount: this.rebufferCount,
      rebufferSeconds: Math.round(this.rebufferSeconds * 10) / 10,
      avgBitrateKbps: bitrate ? Math.round(bitrate) : undefined,
      maxHeight: this.maxHeight || undefined,
      droppedFrames: Math.max(0, this.frames.dropped),
      bytesEstimate: Math.round(this.bytes),
      errorCount: this.errorCount,
    };
  }

  flush({ keepalive = false } = {}) {
    if (!this.enabled || !this.sessionId) return;
    if (this.startupMs === null && !this.errorCount && !this.secondsWatched) return;
    const body = this.payload();
    const snapshot = JSON.stringify(body);
    if (snapshot === this.lastSnapshot) return;
    this.lastSnapshot = snapshot;
    if (keepalive) keepaliveJson('POST', '/api/playback/sessions', body);
    else {
      api.quality.session(body)?.catch?.((err) => {
        // The session expired or was refused: stop reporting rather than retrying forever.
        if (err?.code === 'SESSION_NOT_FOUND' || err?.code === 'SESSION_CONFLICT') this.disable();
      });
    }
  }

  /** Stores the latest measurements for the optional report attachment. */
  saveDiagnostics(extra = {}) {
    const bitrate = this.avgBitrateKbps;
    const d = {
      capturedAt: new Date().toISOString(),
      titleId: this.ids.titleId,
      episodeId: this.ids.episodeId,
      startupMs: this.startupMs ?? undefined,
      rebufferCount: this.rebufferCount,
      rebufferSeconds: Math.round(this.rebufferSeconds * 10) / 10,
      avgBitrateKbps: bitrate ? Math.round(bitrate) : undefined,
      droppedFrames: Math.max(0, this.frames.dropped),
      totalFrames: Math.max(0, this.frames.total),
      maxHeight: this.maxHeight || undefined,
      errors: [...this.errorCodes],
      userAgent: uaSummary(navigator.userAgent),
      ...extra,
    };
    try {
      sessionStorage.setItem(DIAGNOSTICS_KEY, JSON.stringify(d));
    } catch {
      /* storage unavailable */
    }
  }

  stop({ keepalive = false } = {}) {
    clearInterval(this.timer);
    this.timer = null;
    this.endRebuffer();
    this.flush({ keepalive });
  }
}

/** Reads the measurements the player stored (null when none). */
export function readDiagnostics() {
  try {
    return JSON.parse(sessionStorage.getItem(DIAGNOSTICS_KEY) || 'null');
  } catch {
    return null;
  }
}

/**
 * Saves the profile's position. `watchedDelta` is the content time actually played since
 * the previous successful save (capped at 120 s by the API).
 */
export class ProgressSaver {
  constructor({ mode, playback, profile, trailer }) {
    this.mode = mode;
    this.enabled = !!profile && !trailer && profile.preferences?.playback?.saveProgress !== false;
    this.titleId = playback.titleId;
    this.episodeId = playback.episode?.id || null;
    this.durationHint = playback.media?.durationS || null;
    this.pending = 0;
    this.lastPos = null;
    this.inflight = null;
    this.saves = 0;
  }

  addWatched(delta) {
    if (delta > 0) this.pending += delta;
  }

  body(position, duration) {
    const d = Number.isFinite(duration) && duration > 0 ? duration : this.durationHint;
    return {
      titleId: this.titleId,
      episodeId: this.episodeId || undefined,
      positionS: Math.max(0, Math.round(Math.min(position, d || position) * 10) / 10),
      durationS: d ? Math.round(d * 10) / 10 : undefined,
      watchedDelta: clampDelta(this.pending),
    };
  }

  /** Returns a promise (or undefined when nothing needed saving). */
  save(video, { reason = 'interval', keepalive = false } = {}) {
    if (!this.enabled) return undefined;
    const pos = video.ended && Number.isFinite(video.duration) ? video.duration : video.currentTime;
    if (!Number.isFinite(pos)) return undefined;
    const moved = this.lastPos === null ? pos >= 1 : Math.abs(pos - this.lastPos) >= 1;
    if (this.pending < 0.5 && !moved && reason !== 'ended') return undefined;
    const body = this.body(pos, video.duration);
    const sent = body.watchedDelta;
    this.pending = Math.max(0, this.pending - sent);
    this.lastPos = pos;
    this.saves++;
    if (keepalive && this.mode === 'server') {
      keepaliveJson('PUT', '/api/library/progress', body);
      return undefined;
    }
    this.inflight = Promise.resolve(api.library.saveProgress(body)).catch((err) => {
      // Put the unsent watch time back so the next save includes it.
      this.pending += sent;
      if (err?.status !== 422) console.warn('Progress not saved', err);
    });
    return this.inflight;
  }
}

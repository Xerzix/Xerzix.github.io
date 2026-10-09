// Source engines behind one small interface, so the player UI never cares how a stream is
// delivered:
//   HlsJsEngine       HLS through hls.js on Media Source Extensions (adaptive bitrate)
//   NativeHlsEngine   HLS handled by the browser itself (Safari, iOS)
//   ProgressiveEngine a single file, optionally with manually selectable variants
// Engines report only what the stream really contains: renditions come from the manifest's
// levels (or the declared progressive variants, or the decoded videoHeight), audio tracks
// from the manifest or the element. Nothing is inferred from catalog marketing data.
import { qualityOptions, capIndexForHeight, heightLabel, renditionClass, pickProgressiveVariant, initialQuality } from './helpers.js';

let hlsModule = null;
/** Lazily loads the vendored hls.js (ES module build, default export Hls). */
export function loadHls() {
  hlsModule ??= import('../vendor/hls.min.mjs').then((m) => m.default).catch((err) => {
    hlsModule = null;
    throw err;
  });
  return hlsModule;
}

export class PlaybackError extends Error {
  /** type: network | decode | unsupported | dash | source_unavailable | stalled | unknown */
  constructor(type, message, { code, httpStatus, fatal = true, details } = {}) {
    super(message);
    this.name = 'PlaybackError';
    this.type = type;
    this.code = code || type;
    this.httpStatus = httpStatus || null;
    this.fatal = fatal;
    this.details = details || null;
  }
}

const hostOf = (src) => {
  try {
    return new URL(src, location.href).host;
  } catch {
    return '';
  }
};

class BaseEngine {
  constructor(video, source, opts = {}) {
    this.video = video;
    this.source = source;
    this.opts = opts;
    this.handlers = new Map();
    this.bytesLoaded = 0;
    this.segmentRates = [];
    this.destroyed = false;
    this.host = hostOf(source.src);
  }

  on(event, fn) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(fn);
  }

  emit(event, data) {
    if (this.destroyed) return;
    for (const fn of this.handlers.get(event) || []) {
      try {
        fn(data);
      } catch (err) {
        console.error(err);
      }
    }
  }

  // Defaults, overridden per engine.
  get supportsAuto() { return false; }
  get isAuto() { return false; }
  qualities() { return []; }
  currentHeight() { return renditionClass(this.video.videoWidth, this.video.videoHeight); }
  selectedQualityId() { return null; }
  setQuality() {}
  setAutoCap() {}
  canLowerQuality() { return false; }
  lowerQuality() { return null; }
  audioTracks() { return []; }
  setAudioTrack() {}
  currentBitrate() { return null; }
  /** Measured bitrate (bits/s) of the rendition being played, or null when not measured. */
  playingBitrate() { return null; }
  bandwidthEstimate() { return null; }
  codecs() { return ''; }
  measuredBitrate() {
    if (!this.segmentRates.length) return null;
    return this.segmentRates.reduce((a, b) => a + b, 0) / this.segmentRates.length;
  }

  detachMedia() {
    const v = this.video;
    v.removeAttribute('src');
    try {
      v.load();
    } catch {
      /* ignore */
    }
  }

  destroy() {
    this.destroyed = true;
    this.handlers.clear();
  }
}

// ─────────────────────────────── hls.js ───────────────────────────────
export class HlsJsEngine extends BaseEngine {
  constructor(video, source, Hls, opts) {
    super(video, source, opts);
    this.Hls = Hls;
    this.type = 'hls.js';
    this.label = 'HLS (hls.js)';
    this.recover = { media: 0, network: 0 };
    this.manualId = null;
    this.capHeight = null;
    this.levelPayload = new Map(); // level index → { bits, seconds } of main fragments loaded
  }

  start({ startAt = null } = {}) {
    const { Hls } = this;
    // hls.js's player-size capping rewrites autoLevelCapping whenever the player resizes,
    // which would silently lift a Data Saver cap. With Data Saver on, the ≤480p cap set in
    // applyInitialQuality is the only cap (and it is stricter than any player size).
    const saver = initialQuality(this.opts.playbackPrefs || {}, []).capHeight;
    const hls = new Hls({
      capLevelToPlayerSize: !saver,
      startPosition: Number.isFinite(startAt) && startAt > 0 ? startAt : -1,
      maxBufferLength: 30,
      maxMaxBufferLength: 120,
      backBufferLength: 60,
      enableWorker: true,
      renderTextTracksNatively: true,
      testBandwidth: true,
    });
    this.hls = hls;
    hls.subtitleDisplay = false; // cues are drawn by Lumina's overlay (see subtitles.js)
    const E = Hls.Events;
    hls.on(E.MANIFEST_PARSED, () => {
      this.applyInitialQuality();
      this.emit('qualities');
      this.emit('audiotracks');
    });
    hls.on(E.LEVEL_SWITCHED, () => this.emit('quality'));
    hls.on(E.AUDIO_TRACKS_UPDATED, () => this.emit('audiotracks'));
    hls.on(E.AUDIO_TRACK_SWITCHED, () => this.emit('audiotracks'));
    hls.on(E.SUBTITLE_TRACKS_UPDATED, () => this.emit('texttracks'));
    hls.on(E.FRAG_LOADED, (_, data) => {
      const frag = data.frag;
      const loaded = frag?.stats?.loaded || frag?.stats?.total || 0;
      this.bytesLoaded += loaded;
      if (frag?.type === 'main' && frag.duration > 0 && loaded) {
        this.segmentRates.push((loaded * 8) / frag.duration);
        if (this.segmentRates.length > 6) this.segmentRates.shift();
        // Per rendition: bytes actually downloaded over the media time they cover.
        const lp = this.levelPayload.get(frag.level) || { bits: 0, seconds: 0 };
        lp.bits += loaded * 8;
        lp.seconds += frag.duration;
        this.levelPayload.set(frag.level, lp);
      }
    });
    hls.on(E.ERROR, (_, data) => this.onError(data));
    hls.attachMedia(this.video);
    hls.loadSource(this.source.src);
  }

  applyInitialQuality() {
    // Profile preference: 'auto' (ABR), 'data-saver' (ABR capped at 480p) or 'highest'.
    const pref = initialQuality(this.opts.playbackPrefs || {}, this.qualities());
    if (pref.capHeight) this.setAutoCap(pref.capHeight);
    if (pref.mode === 'manual' && pref.height) {
      const opt = this.qualities().find((o) => o.height === pref.height);
      if (opt) {
        this.manualId = opt.id;
        this.hls.startLevel = opt.levelIndex;
        this.hls.nextLevel = opt.levelIndex;
      }
    }
  }

  onError(data) {
    const { ErrorTypes } = this.Hls;
    if (!data.fatal) {
      this.emit('warning', { code: data.details, message: data.error?.message || data.details, httpStatus: data.response?.code });
      return;
    }
    // No amount of recovery helps when the browser cannot decode the stream's codecs:
    // report it at once so the player can try a fallback source.
    if (/IncompatibleCodecs/i.test(data.details || '')) {
      this.emit('error', new PlaybackError('unsupported', 'This browser cannot decode this stream’s video or audio format.', { code: data.details }));
      return;
    }
    if (data.type === ErrorTypes.MEDIA_ERROR && this.recover.media < 2 && this.hls.media) {
      this.recover.media++;
      if (this.recover.media === 2) this.hls.swapAudioCodec();
      this.hls.recoverMediaError();
      this.emit('warning', { code: data.details, message: 'Recovered from a media error', recovered: true });
      return;
    }
    const status = data.response?.code || data.networkDetails?.status || null;
    const isManifest = /manifest/i.test(data.details || '');
    if (data.type === ErrorTypes.NETWORK_ERROR && !isManifest && this.recover.network < 1 && !(status >= 400 && status < 500)) {
      this.recover.network++;
      this.hls.startLoad();
      this.emit('warning', { code: data.details, message: 'Retrying after a network error', recovered: true });
      return;
    }
    let type = 'unknown';
    if (data.type === ErrorTypes.NETWORK_ERROR) type = status === 404 || status === 410 || status === 403 ? 'source_unavailable' : 'network';
    else if (data.type === ErrorTypes.MEDIA_ERROR) type = /incompatible|codec/i.test(data.details || '') ? 'unsupported' : 'decode';
    if (typeof navigator !== 'undefined' && navigator.onLine === false) type = 'network';
    this.emit('error', new PlaybackError(type, data.error?.message || data.details || 'Playback failed', { code: data.details, httpStatus: status }));
  }

  get levels() {
    return (this.hls?.levels || []).map((l, index) => ({ index, width: l.width, height: l.height, bitrate: l.bitrate }));
  }

  get supportsAuto() { return true; }
  get isAuto() { return !!this.hls && this.hls.autoLevelEnabled && this.manualId === null; }

  qualities() {
    return qualityOptions(this.levels);
  }

  currentHeight() {
    const l = this.hls?.levels?.[this.hls.currentLevel];
    return l ? renditionClass(l.width, l.height) : super.currentHeight();
  }

  selectedQualityId() {
    return this.manualId || 'auto';
  }

  setQuality(id) {
    if (!this.hls) return;
    if (id === 'auto') {
      this.manualId = null;
      this.hls.nextLevel = -1;
      return;
    }
    const opt = this.qualities().find((o) => o.id === id);
    if (!opt) return;
    this.manualId = opt.id;
    this.hls.nextLevel = opt.levelIndex;
  }

  /** Caps adaptive selection to renditions no taller than maxHeight (data saver). */
  setAutoCap(maxHeight) {
    this.capHeight = maxHeight || null;
    if (this.hls) this.hls.autoLevelCapping = capIndexForHeight(this.levels, maxHeight);
  }

  canLowerQuality() {
    const h = this.currentHeight();
    return this.qualities().some((o) => o.height < h);
  }

  lowerQuality() {
    const h = this.currentHeight();
    const lower = this.qualities().find((o) => o.height < h);
    if (!lower) return null;
    this.setQuality(lower.id);
    return lower;
  }

  audioTracks() {
    const tracks = this.hls?.audioTracks || [];
    const current = this.hls?.audioTrack ?? -1;
    return tracks.map((t, i) => ({ id: i, lang: t.lang || '', label: t.name || t.lang || `Track ${i + 1}`, default: !!t.default, selected: i === current, switchable: tracks.length > 1, channels: t.channels || null }));
  }

  setAudioTrack(id) {
    if (this.hls && this.hls.audioTrack !== id) this.hls.audioTrack = id;
  }

  /** The playlist's declared peak BANDWIDTH for the current level (metadata, not measured). */
  currentBitrate() {
    return this.hls?.levels?.[this.hls.currentLevel]?.bitrate || null;
  }

  playingBitrate() {
    const lp = this.hls ? this.levelPayload.get(this.hls.currentLevel) : null;
    return lp && lp.seconds > 0 ? lp.bits / lp.seconds : null;
  }

  bandwidthEstimate() {
    const bw = this.hls?.bandwidthEstimate;
    return Number.isFinite(bw) && bw > 0 ? bw : null;
  }

  codecs() {
    const l = this.hls?.levels?.[this.hls.currentLevel];
    if (!l) return '';
    return [l.videoCodec, l.audioCodec].filter(Boolean).join(', ') || l.codecSet || '';
  }

  destroy() {
    super.destroy();
    try {
      this.hls?.destroy();
    } catch {
      /* ignore */
    }
    this.hls = null;
  }
}

// ─────────────────────────── Native HLS (Safari) ───────────────────────────
export class NativeHlsEngine extends BaseEngine {
  constructor(video, source, opts) {
    super(video, source, opts);
    this.type = 'native-hls';
    this.label = 'HLS (native)';
    this.onErr = () => this.emit('error', mediaElementError(this.video));
    this.onMeta = () => {
      this.emit('qualities');
      this.emit('audiotracks');
    };
    this.onResize = () => this.emit('quality');
  }

  start({ startAt = null } = {}) {
    const v = this.video;
    v.addEventListener('error', this.onErr);
    v.addEventListener('loadedmetadata', this.onMeta);
    v.addEventListener('resize', this.onResize);
    if (Number.isFinite(startAt) && startAt > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = startAt; }, { once: true });
    v.audioTracks?.addEventListener?.('change', this.onMeta);
    v.src = this.source.src;
  }

  // The browser adapts on its own; there is no API to pick a rendition, so only Auto exists.
  get supportsAuto() { return true; }
  get isAuto() { return true; }
  selectedQualityId() { return 'auto'; }

  audioTracks() {
    const list = this.video.audioTracks;
    if (!list || !list.length) return [];
    return [...list].map((t, i) => ({ id: i, lang: t.language || '', label: t.label || t.language || `Track ${i + 1}`, default: i === 0, selected: t.enabled, switchable: list.length > 1 }));
  }

  setAudioTrack(id) {
    const list = this.video.audioTracks;
    if (!list) return;
    [...list].forEach((t, i) => { t.enabled = i === id; });
  }

  destroy() {
    const v = this.video;
    v.removeEventListener('error', this.onErr);
    v.removeEventListener('loadedmetadata', this.onMeta);
    v.removeEventListener('resize', this.onResize);
    v.audioTracks?.removeEventListener?.('change', this.onMeta);
    super.destroy();
  }
}

// ─────────────────────────── Progressive files ───────────────────────────
export class ProgressiveEngine extends BaseEngine {
  constructor(video, source, opts) {
    super(video, source, opts);
    this.type = 'progressive';
    this.label = 'Progressive file';
    const seen = new Set();
    this.variants = (source.variants || [])
      .filter((v) => v && v.src && Number(v.height) > 0)
      .map((v) => ({ height: Number(v.height), src: v.src, bitrateKbps: v.bitrateKbps || null }))
      .sort((a, b) => b.height - a.height)
      .filter((v) => (seen.has(v.height) ? false : seen.add(v.height)));
    this.current = null;
    this.onErr = () => this.handleElementError();
    this.onMeta = () => {
      this.emit('qualities');
      this.emit('quality');
      this.emit('audiotracks');
    };
  }

  start({ startAt = null } = {}) {
    const v = this.video;
    v.addEventListener('error', this.onErr);
    v.addEventListener('loadedmetadata', this.onMeta);
    this.current = this.variants.length ? pickProgressiveVariant(this.variants, this.opts.playbackPrefs || {}, this.source.src) : null;
    if (Number.isFinite(startAt) && startAt > 0) v.addEventListener('loadedmetadata', () => { v.currentTime = startAt; }, { once: true });
    v.src = this.current?.src || this.source.src;
  }

  async handleElementError() {
    const err = mediaElementError(this.video);
    // "Not supported" is also what a missing file looks like; check same-origin sources.
    if (err.type === 'unsupported' || err.type === 'network') {
      const src = this.video.currentSrc || this.current?.src || this.source.src;
      try {
        const url = new URL(src, location.href);
        if (url.origin === location.origin) {
          const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
          if (res.status === 404 || res.status === 410 || res.status === 403) {
            this.emit('error', new PlaybackError('source_unavailable', `HTTP ${res.status}`, { code: `HTTP_${res.status}`, httpStatus: res.status }));
            return;
          }
        }
      } catch {
        /* fall through with the element's own error */
      }
    }
    this.emit('error', err);
  }

  qualities() {
    if (this.variants.length) return this.variants.map((v) => ({ id: `v${v.height}`, height: v.height, label: heightLabel(v.height), bitrate: v.bitrateKbps ? v.bitrateKbps * 1000 : 0 }));
    const h = renditionClass(this.video.videoWidth, this.video.videoHeight);
    return h ? [{ id: 'source', height: h, label: `Source (${heightLabel(h)})`, source: true }] : [];
  }

  selectedQualityId() {
    if (this.current) return `v${this.current.height}`;
    return 'source';
  }

  currentHeight() {
    return renditionClass(this.video.videoWidth, this.video.videoHeight) || this.current?.height || 0;
  }

  /** Switches variant, keeping position, speed and play/pause state. */
  setQuality(id) {
    const next = this.variants.find((v) => `v${v.height}` === id);
    if (!next || next === this.current) return;
    const v = this.video;
    const time = v.currentTime;
    const wasPlaying = !v.paused && !v.ended;
    const rate = v.playbackRate;
    this.current = next;
    v.addEventListener('loadedmetadata', () => {
      v.currentTime = time;
      v.playbackRate = rate;
      if (wasPlaying) v.play().catch(() => {});
      this.emit('quality');
    }, { once: true });
    v.src = next.src;
  }

  canLowerQuality() {
    return !!this.current && this.variants.some((x) => x.height < this.current.height);
  }

  lowerQuality() {
    if (!this.current) return null;
    const lower = this.variants.find((x) => x.height < this.current.height);
    if (!lower) return null;
    this.setQuality(`v${lower.height}`);
    return { id: `v${lower.height}`, height: lower.height, label: heightLabel(lower.height) };
  }

  audioTracks() {
    const list = this.video.audioTracks;
    if (!list || !list.length) return [];
    return [...list].map((t, i) => ({ id: i, lang: t.language || '', label: t.label || t.language || `Track ${i + 1}`, default: i === 0, selected: t.enabled, switchable: list.length > 1 }));
  }

  setAudioTrack(id) {
    const list = this.video.audioTracks;
    if (list) [...list].forEach((t, i) => { t.enabled = i === id; });
  }

  currentBitrate() {
    return this.current?.bitrateKbps ? this.current.bitrateKbps * 1000 : null;
  }

  destroy() {
    const v = this.video;
    v.removeEventListener('error', this.onErr);
    v.removeEventListener('loadedmetadata', this.onMeta);
    super.destroy();
  }
}

/** Maps HTMLMediaElement.error to a PlaybackError. */
export function mediaElementError(video) {
  const e = video.error;
  const code = e?.code;
  const message = e?.message || 'The video could not be played.';
  if (code === 1) return new PlaybackError('unknown', 'Playback was aborted.', { code: 'MEDIA_ERR_ABORTED' });
  if (code === 2) return new PlaybackError('network', message, { code: 'MEDIA_ERR_NETWORK' });
  if (code === 3) return new PlaybackError('decode', message, { code: 'MEDIA_ERR_DECODE' });
  if (code === 4) return new PlaybackError('unsupported', message, { code: 'MEDIA_ERR_SRC_NOT_SUPPORTED' });
  return new PlaybackError('unknown', message, { code: 'MEDIA_ERR_UNKNOWN' });
}

export const canPlayNativeHls = (video) => !!video.canPlayType('application/vnd.apple.mpegurl');

/**
 * Creates (but does not start) the engine for a source { kind, src, variants }.
 * Throws PlaybackError('dash' | 'unsupported') when this browser/build cannot play it.
 */
export async function createEngine(video, source, opts = {}) {
  if (!source?.src) throw new PlaybackError('source_unavailable', 'No video source was provided.', { code: 'NO_SOURCE' });
  if (source.kind === 'dash') throw new PlaybackError('dash', 'DASH playback is not enabled in this build.', { code: 'DASH_DISABLED' });
  if (source.kind === 'hls') {
    let Hls = null;
    try {
      Hls = await loadHls();
    } catch (err) {
      console.warn('hls.js failed to load', err);
    }
    if (Hls?.isSupported?.()) return new HlsJsEngine(video, source, Hls, opts);
    if (canPlayNativeHls(video)) return new NativeHlsEngine(video, source, opts);
    throw new PlaybackError('unsupported', 'This browser cannot play HLS streams.', { code: 'HLS_UNSUPPORTED' });
  }
  if (source.kind === 'progressive') return new ProgressiveEngine(video, source, opts);
  throw new PlaybackError('unsupported', `Unknown source type "${source.kind}".`, { code: 'UNKNOWN_KIND' });
}

// Pure helpers for the Lumina player: rendition labels, quality preferences, subtitle
// styling and cue parsing, resume rules, track selection and error wording. Nothing here
// touches the DOM, so it is unit-tested in Node (tests/unit/player-helpers.test.js).

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
export const RESUME_MIN_S = 15;
export const RESUME_MAX_RATIO = 0.95;
export const DATA_SAVER_MAX_HEIGHT = 480;
export const SEEK_STEP_S = 10;
export const MAX_WATCHED_DELTA_S = 120; // the library API rejects larger deltas

// Standard ladder heights. A rendition is labelled by the class it belongs to, so a
// 1920×800 "scope" encode is 1080p and a 3840×1600 encode is 2160p (4K), as every major
// service labels them. A 4K label therefore always means a ≥3840-wide / 2160-class rendition.
const LADDER = [4320, 2160, 1440, 1080, 720, 576, 540, 480, 432, 360, 288, 240, 180, 144];

/** Resolution class of a rendition from its real dimensions. */
export function renditionClass(width, height) {
  if (!height || height <= 0) return 0;
  let h = height;
  if (width && width / height > 16 / 9 + 0.02) h = (width * 9) / 16;
  for (const std of LADDER) if (Math.abs(h - std) / std <= 0.04) return std;
  return Math.round(h);
}

/** "4K · 2160p", "1080p", "720p" … */
export function heightLabel(height) {
  if (!height) return 'Unknown';
  if (height >= 4320) return `8K · ${height}p`;
  if (height >= 2160) return `4K · ${height}p`;
  return `${height}p`;
}

/** Short badge text: "4K", "HD", "SD". */
export function heightBadge(height) {
  if (height >= 2160) return '4K';
  if (height >= 720) return 'HD';
  return height ? 'SD' : '';
}

/**
 * Collapses hls.js levels (or any [{index, width, height, bitrate}]) into one menu option per
 * resolution class, keeping the highest-bitrate level of each class, highest first.
 * Levels without a height (audio-only) are ignored: they are not a picture quality.
 */
export function qualityOptions(levels = []) {
  const byHeight = new Map();
  levels.forEach((l, i) => {
    const index = l.index ?? i;
    const height = renditionClass(l.width, l.height);
    if (!height) return;
    const prev = byHeight.get(height);
    if (!prev || (l.bitrate || 0) > prev.bitrate) byHeight.set(height, { id: `h${height}`, height, label: heightLabel(height), levelIndex: index, bitrate: l.bitrate || 0 });
  });
  return [...byHeight.values()].sort((a, b) => b.height - a.height);
}

/** Level index to use as hls.js autoLevelCapping for a maximum height (-1 = no cap). */
export function capIndexForHeight(levels = [], maxHeight) {
  if (!maxHeight) return -1;
  let best = -1;
  let bestRate = -1;
  let lowest = -1;
  let lowestH = Infinity;
  levels.forEach((l, i) => {
    const h = renditionClass(l.width, l.height);
    if (!h) return;
    if (h < lowestH) {
      lowestH = h;
      lowest = l.index ?? i;
    }
    if (h <= maxHeight && (l.bitrate || 0) > bestRate) {
      best = l.index ?? i;
      bestRate = l.bitrate || 0;
    }
  });
  return best >= 0 ? best : lowest;
}

/**
 * Initial quality from profile preferences.
 *   defaultQuality: 'auto' | 'data-saver' | 'highest'; dataSaver: boolean
 * Returns { mode: 'auto'|'manual', height?, capHeight? }.
 */
export function initialQuality(playbackPrefs = {}, options = []) {
  const saver = playbackPrefs.dataSaver === true || playbackPrefs.defaultQuality === 'data-saver';
  if (playbackPrefs.defaultQuality === 'highest' && !saver && options.length) return { mode: 'manual', height: options[0].height };
  if (saver) return { mode: 'auto', capHeight: DATA_SAVER_MAX_HEIGHT };
  return { mode: 'auto' };
}

/** For sources without adaptive bitrate (progressive variants): which variant to start on. */
export function pickProgressiveVariant(variants = [], playbackPrefs = {}, defaultSrc = null) {
  if (!variants.length) return null;
  const sorted = [...variants].sort((a, b) => b.height - a.height);
  const saver = playbackPrefs.dataSaver === true || playbackPrefs.defaultQuality === 'data-saver';
  if (saver) return sorted.find((v) => v.height <= DATA_SAVER_MAX_HEIGHT) || sorted[sorted.length - 1];
  if (playbackPrefs.defaultQuality === 'highest') return sorted[0];
  return sorted.find((v) => v.src === defaultSrc) || sorted[0];
}

/** "Auto · 1080p" while adaptive; "Auto" before the first level is known. */
export function autoLabel(height, { capped = false } = {}) {
  const base = capped ? 'Auto (Data saver)' : 'Auto';
  return height ? `${base} · ${heightLabel(height)}` : base;
}

// ── Subtitles ──────────────────────────────────────────────
export const SUBTITLE_SIZES = { small: 0.78, medium: 1, large: 1.28, xlarge: 1.6 };
export const SUBTITLE_BACKGROUNDS = ['none', 'shadow', 'box'];
export const SUBTITLE_POSITIONS = ['bottom', 'raised', 'top'];
export const SUBTITLE_COLORS = ['#F8F5F2', '#FFE27A', '#9EE6FF', '#B8F5A3', '#FFB3C6'];
export const DEFAULT_SUBTITLE_STYLE = { size: 'medium', color: '#F8F5F2', background: 'shadow', position: 'bottom' };

/** Normalises subtitle preferences and derives the CSS custom properties the overlay uses. */
export function subtitleStyle(prefs = {}) {
  const size = Object.hasOwn(SUBTITLE_SIZES, prefs.size) ? prefs.size : DEFAULT_SUBTITLE_STYLE.size;
  const color = /^#[0-9a-f]{6}$/i.test(prefs.color || '') ? prefs.color.toUpperCase() : DEFAULT_SUBTITLE_STYLE.color;
  const background = SUBTITLE_BACKGROUNDS.includes(prefs.background) ? prefs.background : DEFAULT_SUBTITLE_STYLE.background;
  const position = SUBTITLE_POSITIONS.includes(prefs.position) ? prefs.position : DEFAULT_SUBTITLE_STYLE.position;
  return {
    size,
    color,
    background,
    position,
    vars: { '--sub-scale': String(SUBTITLE_SIZES[size]), '--sub-color': color },
  };
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '‎', rlm: '‏', '#39': "'" };

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, name) => {
    const key = name.toLowerCase();
    if (ENTITIES[key] !== undefined) return ENTITIES[key];
    if (key.startsWith('#x')) return safeChar(parseInt(key.slice(2), 16), m);
    if (key.startsWith('#')) return safeChar(parseInt(key.slice(1), 10), m);
    return m;
  });
}

function safeChar(code, fallback) {
  try {
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Parses WebVTT cue text into lines of styled segments without ever producing HTML:
 *   "<i>Hi</i> &amp; bye\nnext" → [[{text:'Hi', italic:true}, {text:' & bye'}], [{text:'next'}]]
 * Supports <b>, <i>, <u>, <v Speaker> (speaker kept as segment.voice), <c.*>, <lang>, and
 * drops <ruby>/<rt> annotations and timestamp tags.
 */
export function parseCueText(text = '') {
  const lines = [];
  let line = [];
  const state = { bold: 0, italic: 0, underline: 0, voice: [], rt: 0 };
  const push = (t) => {
    if (!t || state.rt) return;
    const parts = decodeEntities(t).split('\n');
    parts.forEach((p, i) => {
      if (i > 0) {
        lines.push(line);
        line = [];
      }
      if (p) line.push({ text: p, bold: state.bold > 0, italic: state.italic > 0, underline: state.underline > 0, voice: state.voice.at(-1) || null });
    });
  };
  const re = /<(\/?)([a-z]+|\d[\d:.]*)([^>]*)>/gi;
  let last = 0;
  let m;
  const str = String(text).replace(/\r\n?/g, '\n');
  while ((m = re.exec(str))) {
    push(str.slice(last, m.index));
    last = re.lastIndex;
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    const delta = closing ? -1 : 1;
    if (tag === 'b') state.bold = Math.max(0, state.bold + delta);
    else if (tag === 'i') state.italic = Math.max(0, state.italic + delta);
    else if (tag === 'u') state.underline = Math.max(0, state.underline + delta);
    else if (tag === 'rt') state.rt = Math.max(0, state.rt + delta);
    else if (tag === 'v') {
      if (closing) state.voice.pop();
      else state.voice.push(m[3].trim().slice(0, 60) || null);
    }
    // c, lang, ruby, timestamps: no visual effect of their own.
  }
  push(str.slice(last));
  lines.push(line);
  return lines.filter((l, i) => l.length || (i > 0 && i < lines.length - 1));
}

// ── Resume & progress ──────────────────────────────────────
/**
 * Where to start. Resume only when the saved/requested position is past the first 15 s and
 * before the last 5 % of the title (duration may be unknown until metadata loads).
 */
export function resumePosition(requested, duration) {
  const t = Number(requested);
  if (!Number.isFinite(t) || t <= RESUME_MIN_S) return null;
  if (Number.isFinite(duration) && duration > 0 && t >= duration * RESUME_MAX_RATIO) return null;
  return t;
}

/** Parses the `t` query parameter: "754", "754.5", "12:34" or "1:02:03". */
export function parseTimeParam(value) {
  if (value === null || value === undefined || value === '') return null;
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d+(:\d{1,2}){1,2}$/.test(s)) return s.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  return null;
}

/**
 * Seconds actually played between two timeupdate samples. Jumps (seeks) and stalls do not
 * count; the gap allowance scales with playback speed.
 */
export function playedDelta(prev, curr, rate = 1, maxGapS = 2.5) {
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return 0;
  const d = curr - prev;
  return d > 0 && d <= maxGapS * Math.max(1, rate) ? d : 0;
}

export const clampDelta = (s) => Math.max(0, Math.min(MAX_WATCHED_DELTA_S, Math.round((s || 0) * 10) / 10));

/** Seconds at which the credits (and the next-episode card) begin. */
export function creditsAt({ creditsStart, durationS } = {}, duration) {
  const d = Number.isFinite(duration) && duration > 0 ? duration : durationS;
  if (Number.isFinite(creditsStart) && creditsStart > 0 && (!d || creditsStart < d)) return creditsStart;
  if (!d || d < 30) return d ? Math.max(0, d - 3) : null;
  return Math.max(d - 20, d * 0.9);
}

export function inIntro(time, { introStart, introEnd } = {}) {
  if (!Number.isFinite(introStart) || !Number.isFinite(introEnd) || introEnd <= introStart) return false;
  return time >= introStart && time < introEnd - 0.5;
}

// ── Track selection ────────────────────────────────────────
const primary = (lang) => String(lang || '').toLowerCase().split(/[-_]/)[0];
export const langMatches = (a, b) => !!a && !!b && primary(a) === primary(b);

/** Packager-generated rendition names ("audio_0", "stereo", "Track 2") that mean nothing to viewers. */
export function isGenericTrackName(name) {
  return /^\s*(?:(?:audio|aud|track|stream|sound|a)[\s_-]*\d*|stereo|mono|main|default|und|\d+)\s*$/i.test(String(name ?? ''));
}

/** Index of the audio track to use: preferred language, then the default flag, then 0. */
export function pickAudioTrack(tracks = [], { preferred } = {}) {
  if (!tracks.length) return -1;
  if (preferred) {
    const exact = tracks.findIndex((t) => String(t.lang || '').toLowerCase() === String(preferred).toLowerCase());
    if (exact >= 0) return exact;
    const loose = tracks.findIndex((t) => langMatches(t.lang, preferred));
    if (loose >= 0) return loose;
  }
  const def = tracks.findIndex((t) => t.default);
  return def >= 0 ? def : 0;
}

/**
 * Index of the subtitle track to switch on automatically, or -1 for off. Only when the
 * profile asks for subtitles by default; matches the subtitle language, else the UI language.
 * Prefers plain subtitles over captions (SDH) when both exist for the language.
 */
export function pickSubtitleTrack(tracks = [], { subtitlesDefault = false, subtitleLanguage, uiLanguage } = {}) {
  if (!subtitlesDefault || !tracks.length) return -1;
  for (const lang of [subtitleLanguage, uiLanguage].filter(Boolean)) {
    const matches = tracks.map((t, i) => ({ t, i })).filter(({ t }) => langMatches(t.lang, lang));
    if (matches.length) return (matches.find(({ t }) => t.kind !== 'captions') || matches[0]).i;
  }
  return -1;
}

// ── Formatting ─────────────────────────────────────────────
export function formatBitrate(bps) {
  if (!Number.isFinite(bps) || bps <= 0) return '—';
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} Mbps`;
  return `${Math.round(bps / 1e3)} kbps`;
}

export function episodeLabel(ep) {
  if (!ep) return '';
  return `S${ep.seasonNumber}:E${ep.number}${ep.name ? ` · ${ep.name}` : ''}`;
}

/** "Chrome 140 on macOS" from a user-agent string (for the quality report form). */
export function uaSummary(ua = '') {
  const s = String(ua);
  let browser = 'Browser';
  let m;
  if ((m = s.match(/Edg(?:A|iOS)?\/(\d+)/))) browser = `Edge ${m[1]}`;
  else if ((m = s.match(/OPR\/(\d+)/))) browser = `Opera ${m[1]}`;
  else if ((m = s.match(/SamsungBrowser\/(\d+)/))) browser = `Samsung Internet ${m[1]}`;
  else if ((m = s.match(/(?:Firefox|FxiOS)\/(\d+)/))) browser = `Firefox ${m[1]}`;
  else if ((m = s.match(/(?:Chrome|CriOS)\/(\d+)/))) browser = `${/HeadlessChrome/.test(s) ? 'Headless Chrome' : 'Chrome'} ${m[1]}`;
  else if ((m = s.match(/Version\/(\d+)(?:\.\d+)*.*Safari/))) browser = `Safari ${m[1]}`;
  let os = '';
  if (/iPhone|iPad|iPod/.test(s)) os = /iPad/.test(s) ? 'iPadOS' : 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/CrOS/.test(s)) os = 'ChromeOS';
  else if (/Windows/.test(s)) os = 'Windows';
  else if (/Mac OS X|Macintosh/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';
  return os ? `${browser} on ${os}` : browser;
}

// ── Errors ─────────────────────────────────────────────────
/**
 * Human wording for every failure the player can meet. `kind` is a player error type or an
 * API error code. Returns { title, message, retry }.
 */
export function describeError(kind) {
  switch (kind) {
    case 'network':
    case 'NETWORK':
      return { title: 'Connection lost', message: 'We could not reach the video. Check your connection, then try again.', retry: true };
    case 'decode':
      return { title: 'This video could not be decoded', message: 'Your device had trouble decoding this stream. Trying again often helps; if it keeps happening, let us know.', retry: true };
    case 'unsupported':
      return { title: 'Format not supported', message: 'This browser cannot play this video format. Try another browser or device.', retry: false };
    case 'dash':
      return { title: 'Format not supported', message: 'DASH playback is not enabled in this build of Lumina.', retry: false };
    case 'source_unavailable':
      return { title: 'Video unavailable', message: 'The video file for this title could not be found on the server right now.', retry: true };
    case 'stalled':
      return { title: 'Playback stalled', message: 'The video stopped loading. Your connection may be too slow for this stream right now.', retry: true };
    case 'ENTITLEMENT_REQUIRED':
      return { title: 'Not included in your plan', message: 'This title is not included in your current plan.', retry: false };
    case 'MEDIA_UNAVAILABLE':
      return { title: 'Not available to stream yet', message: 'No playable video is available for this title yet.', retry: false };
    case 'PROFILE_RESTRICTED':
      return { title: 'Restricted on this profile', message: 'This title is outside the maturity setting for this profile.', retry: false };
    case 'NOT_FOUND':
      return { title: 'Title not found', message: 'This title is not in the Lumina catalog.', retry: false };
    case 'UNAUTHENTICATED':
      return { title: 'Sign in to watch', message: 'This Lumina server asks viewers to sign in before playing.', retry: false };
    default:
      return { title: 'Something went wrong', message: 'Playback failed unexpectedly. Please try again.', retry: true };
  }
}

// ── Watch parties ──────────────────────────────────────────
/** Where the party timeline is now, given the last state and the server/client clock offset. */
export function partyPosition(state, clientNowMs, offsetMs = 0) {
  if (!state) return 0;
  const base = Number(state.position) || 0;
  if (!state.playing) return base;
  const updated = Date.parse(state.updatedAt);
  if (!Number.isFinite(updated)) return base;
  return Math.max(0, base + (clientNowMs + offsetMs - updated) / 1000);
}

export const PARTY_DRIFT_S = 1.5;
export const needsResync = (current, expected, threshold = PARTY_DRIFT_S) => Math.abs((current || 0) - (expected || 0)) > threshold;

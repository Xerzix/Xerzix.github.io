// Media verification: reads an HLS master playlist (or probes a progressive file) and
// reports what the media really contains — renditions, codecs, audio and subtitle tracks.
// Nothing is marked verified unless the manifest or file was actually read.
//
// parseHlsManifest() is pure (no I/O) and shared with scripts/verify-media.mjs.
// verifyMedia() does the I/O; every environment detail (web root, storage root, allowed
// origins, fetch, probe) is injected so it stays testable and free of import side effects.
import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { safeJoin } from '../../lib/static.js';

export const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
export const FETCH_TIMEOUT_MS = 10_000;

export class VerifyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// ───────────────────────────── Parsing ─────────────────────────────

/** Parses an HLS attribute list: KEY=VALUE,KEY="quoted, value",… */
export function parseAttributes(input) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(input))) {
    let value = m[2];
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    out[m[1]] = value;
  }
  return out;
}

const VIDEO_CODECS = [
  [/^(avc1|avc3)\b/i, 'H.264'],
  [/^(hvc1|hev1)\b/i, 'HEVC'],
  [/^(dvh1|dvhe|dva1|dvav)\b/i, 'Dolby Vision'],
  [/^av01\b/i, 'AV1'],
  [/^(vp09|vp9)\b/i, 'VP9'],
  [/^(vp08|vp8)\b/i, 'VP8'],
];
const AUDIO_CODECS = [
  [/^mp4a\.40\.34$|^mp4a\.6b$/i, 'MP3'],
  [/^mp4a\b/i, 'AAC'],
  [/^ec-3\b|^ec3\b/i, 'Dolby Digital Plus'],
  [/^ac-3\b|^ac3\b/i, 'Dolby Digital'],
  [/^ac-4\b/i, 'Dolby AC-4'],
  [/^opus\b/i, 'Opus'],
  [/^flac\b|^fLaC\b/, 'FLAC'],
];

function classifyCodec(codec) {
  const c = codec.trim();
  for (const [re, name] of VIDEO_CODECS) if (re.test(c)) return { type: 'video', name };
  for (const [re, name] of AUDIO_CODECS) if (re.test(c)) return { type: 'audio', name };
  if (/^(wvtt|stpp)/i.test(c)) return { type: 'text', name: c };
  return { type: 'unknown', name: c };
}

function channelLayout(channels) {
  if (!channels) return null;
  const [count, extra] = String(channels).split('/');
  if (extra && /JOC/i.test(extra)) return 'Dolby Atmos';
  switch (Number(count)) {
    case 1: return 'Mono';
    case 2: return 'Stereo';
    case 6: return '5.1';
    case 8: return '7.1';
    default: return null;
  }
}

function lowerLang(code) {
  if (!code) return null;
  const [primary, ...rest] = String(code).trim().split(/[-_]/);
  if (!primary) return null;
  return [primary.toLowerCase(), ...rest.map((r) => (r.length === 2 ? r.toUpperCase() : r))].join('-');
}

const yes = (v) => String(v || '').toUpperCase() === 'YES';
const list = (v) => (v ? String(v).split(',').map((s) => s.trim()).filter(Boolean) : []);

/**
 * Parses an HLS playlist. Returns:
 * { type: 'master'|'media', variants: [{uri, bandwidth, averageBandwidth, width, height, codecs[], frameRate, videoRange, audioGroup, subtitlesGroup}],
 *   audio: [{groupId, lang, name, default, autoselect, channels, characteristics[], uri}],
 *   subtitles: [{groupId, lang, name, default, autoselect, forced, characteristics[], uri}],
 *   closedCaptions: [{groupId, lang, name, default, instreamId}],
 *   resolutions: number[] (distinct heights, desc), videoCodecs: string[], audioCodecs: string[],
 *   audioLayouts: string[], hdr: 'Dolby Vision'|'HDR10'|'HLG'|null, videoRangeDeclared: boolean,
 *   iFramePlaylists: number, segments: number, durationS: number|null, endList: boolean, targetDuration }
 * Throws VerifyError('NOT_HLS') when the text is not a playlist.
 */
export function parseHlsManifest(text) {
  if (typeof text !== 'string') throw new VerifyError('NOT_HLS', 'The manifest is empty.');
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).map((l) => l.trim());
  if (!lines[0] || !lines[0].startsWith('#EXTM3U')) throw new VerifyError('NOT_HLS', 'This file is not an HLS playlist (it does not start with #EXTM3U).');

  const variants = [];
  const renditions = [];
  let pendingVariant = null;
  let iFramePlaylists = 0;
  let segments = 0;
  let duration = 0;
  let endList = false;
  let targetDuration = null;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      pendingVariant = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      renditions.push(parseAttributes(line.slice('#EXT-X-MEDIA:'.length)));
    } else if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF:')) {
      iFramePlaylists++;
    } else if (line.startsWith('#EXTINF:')) {
      const d = Number.parseFloat(line.slice('#EXTINF:'.length));
      if (Number.isFinite(d) && d >= 0) duration += d;
      segments++;
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number.parseFloat(line.slice('#EXT-X-TARGETDURATION:'.length)) || null;
    } else if (line === '#EXT-X-ENDLIST') {
      endList = true;
    } else if (!line.startsWith('#')) {
      if (pendingVariant) {
        const a = pendingVariant;
        const [w, hgt] = (a.RESOLUTION || '').split(/x/i).map((n) => Number.parseInt(n, 10));
        variants.push({
          uri: line,
          bandwidth: Number.parseInt(a.BANDWIDTH, 10) || null,
          averageBandwidth: Number.parseInt(a['AVERAGE-BANDWIDTH'], 10) || null,
          width: Number.isFinite(w) ? w : null,
          height: Number.isFinite(hgt) ? hgt : null,
          codecs: list(a.CODECS),
          frameRate: a['FRAME-RATE'] ? Number.parseFloat(a['FRAME-RATE']) : null,
          videoRange: a['VIDEO-RANGE'] ? a['VIDEO-RANGE'].toUpperCase() : null,
          audioGroup: a.AUDIO || null,
          subtitlesGroup: a.SUBTITLES || null,
        });
        pendingVariant = null;
      }
    }
  }

  const byType = (t) => renditions.filter((r) => String(r.TYPE || '').toUpperCase() === t);
  const audio = byType('AUDIO').map((r) => ({
    groupId: r['GROUP-ID'] || null,
    lang: lowerLang(r.LANGUAGE),
    name: r.NAME || null,
    default: yes(r.DEFAULT),
    autoselect: yes(r.AUTOSELECT),
    channels: r.CHANNELS || null,
    characteristics: list(r.CHARACTERISTICS),
    uri: r.URI || null,
  }));
  const subtitles = byType('SUBTITLES').map((r) => ({
    groupId: r['GROUP-ID'] || null,
    lang: lowerLang(r.LANGUAGE),
    name: r.NAME || null,
    default: yes(r.DEFAULT),
    autoselect: yes(r.AUTOSELECT),
    forced: yes(r.FORCED),
    characteristics: list(r.CHARACTERISTICS),
    uri: r.URI || null,
  }));
  const closedCaptions = byType('CLOSED-CAPTIONS').map((r) => ({
    groupId: r['GROUP-ID'] || null,
    lang: lowerLang(r.LANGUAGE),
    name: r.NAME || null,
    default: yes(r.DEFAULT),
    instreamId: r['INSTREAM-ID'] || null,
  }));

  const resolutions = [...new Set(variants.map((v) => v.height).filter((h) => Number.isFinite(h) && h > 0))].sort((a, b) => b - a);
  const classified = variants.flatMap((v) => v.codecs.map(classifyCodec));
  const videoCodecs = [...new Set(classified.filter((c) => c.type === 'video').map((c) => c.name))];
  const audioCodecs = [...new Set(classified.filter((c) => c.type === 'audio').map((c) => c.name))];
  const audioLayouts = [...new Set(audio.map((a) => channelLayout(a.channels)).filter(Boolean))];

  const ranges = variants.map((v) => v.videoRange).filter(Boolean);
  let hdr = null;
  if (videoCodecs.includes('Dolby Vision')) hdr = 'Dolby Vision';
  else if (ranges.includes('PQ')) hdr = 'HDR10';
  else if (ranges.includes('HLG')) hdr = 'HLG';

  const isMaster = variants.length > 0;
  return {
    type: isMaster ? 'master' : 'media',
    variants,
    audio,
    subtitles,
    closedCaptions,
    resolutions,
    videoCodecs,
    audioCodecs,
    audioLayouts,
    hdr,
    videoRangeDeclared: ranges.length > 0 || videoCodecs.includes('Dolby Vision'),
    iFramePlaylists,
    segments,
    durationS: !isMaster && segments > 0 ? Math.round(duration * 1000) / 1000 : null,
    endList,
    targetDuration,
  };
}

// Packagers often emit placeholder rendition names (ffmpeg: NAME="audio_0").
const GENERATED_NAME = /^(audio|stream|subs?|subtitles?|text|a|s|cc)[_-]?\d+$/i;
const defaultLabel = (lang) => ({ zxx: 'No dialogue', und: 'Unknown language' }[lang] || lang || 'Unknown language');

/**
 * Track label: the manifest's NAME when it is a real name; otherwise the label already stored
 * for the same language and kind (curated by staff), and only then the language's name.
 */
function trackLabel(name, lang, kind, existing, fallback) {
  if (name && !GENERATED_NAME.test(name)) return name;
  const stored = existing.find((t) => (t.lang || 'und') === (lang || 'und') && (t.kind || kind) === kind && t.label);
  return stored ? stored.label : fallback;
}

/**
 * Maps a parsed master playlist onto Lumina media fields. Only facts the manifest declares
 * are returned; `undefined` means "leave the stored value alone". `existing` holds the tracks
 * stored today ({ audioTracks, subtitleTracks }) so curated labels survive placeholder names.
 */
export function manifestToMediaFields(parsed, labelFor = defaultLabel, existing = {}) {
  const storedAudio = Array.isArray(existing.audioTracks) ? existing.audioTracks : [];
  const storedSubs = (Array.isArray(existing.subtitleTracks) ? existing.subtitleTracks : []).filter((t) => t.inManifest);
  const out = { resolutions: parsed.resolutions, videoCodecs: parsed.videoCodecs };
  if (parsed.audio.length) {
    const seen = new Set();
    out.audioTracks = parsed.audio
      .filter((a) => {
        const key = `${a.lang}|${a.name}|${a.characteristics.join(',')}`;
        if (seen.has(key)) return false; // the same track repeated per audio group (bitrate ladders)
        seen.add(key);
        return true;
      })
      .map((a) => {
        const kind = a.characteristics.includes('public.accessibility.describes-video') ? 'description' : 'main';
        return { lang: a.lang || 'und', label: trackLabel(a.name, a.lang, kind, storedAudio, labelFor(a.lang)), kind, default: a.default };
      });
  }
  if (parsed.subtitles.length || parsed.closedCaptions.length) {
    const seen = new Set();
    out.subtitleTracks = [
      ...parsed.subtitles.map((s) => {
        const kind = s.characteristics.includes('public.accessibility.transcribes-spoken-dialog') ? 'captions' : 'subtitles';
        return {
          lang: s.lang || 'und',
          label: trackLabel(s.name, s.lang, kind, storedSubs, labelFor(s.lang)),
          kind,
          src: null,
          default: s.default,
          forced: s.forced || undefined,
          inManifest: true,
        };
      }),
      ...parsed.closedCaptions.map((c) => ({
        lang: c.lang || 'und',
        label: trackLabel(c.name, c.lang, 'captions', storedSubs.filter((t) => t.instreamId), `${labelFor(c.lang)} (CC)`),
        kind: 'captions',
        src: null,
        default: c.default,
        inManifest: true,
        instreamId: c.instreamId || undefined,
      })),
    ].filter((t) => {
      const key = `${t.lang}|${t.label}|${t.kind}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  const formats = [...parsed.audioCodecs, ...parsed.audioLayouts];
  if (formats.length) out.audioFormats = [...new Set(formats)];
  if (parsed.videoRangeDeclared) out.hdr = parsed.hdr;
  return out;
}

// ───────────────────────────── Loading ─────────────────────────────

/**
 * Fetches a remote text resource with an origin allowlist (checked on every redirect hop),
 * a timeout and a size cap. Returns { text, url }.
 */
export async function fetchLimited(url, { allowedOrigins, timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAX_MANIFEST_BYTES, fetchImpl = fetch } = {}) {
  let current = new URL(url);
  const signal = AbortSignal.timeout(timeoutMs);
  for (let hop = 0; hop < 5; hop++) {
    if (current.protocol !== 'https:' && current.protocol !== 'http:') throw new VerifyError('ORIGIN_NOT_ALLOWED', 'Only http(s) sources can be verified.');
    if (!allowedOrigins.includes(current.origin)) throw new VerifyError('ORIGIN_NOT_ALLOWED', `${current.origin} is not in MEDIA_ORIGINS, so the server will not fetch it.`);
    let res;
    try {
      res = await fetchImpl(current.href, { redirect: 'manual', signal, headers: { Accept: 'application/vnd.apple.mpegurl, application/x-mpegurl, */*;q=0.5' } });
    } catch (err) {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new VerifyError('TIMEOUT', `The host did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
      throw new VerifyError('NETWORK', `The server could not reach ${current.origin}.`);
    }
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const loc = res.headers.get('location');
      if (!loc) throw new VerifyError('HTTP_ERROR', 'The host sent a redirect without a location.');
      current = new URL(loc, current);
      continue;
    }
    if (!res.ok) throw new VerifyError('HTTP_ERROR', `The host answered HTTP ${res.status}.`);
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new VerifyError('TOO_LARGE', 'The manifest is larger than 2 MB.');
    const chunks = [];
    let total = 0;
    try {
      for await (const chunk of res.body) {
        total += chunk.length;
        if (total > maxBytes) throw new VerifyError('TOO_LARGE', 'The manifest is larger than 2 MB.');
        chunks.push(Buffer.from(chunk));
      }
    } catch (err) {
      if (err instanceof VerifyError) throw err;
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') throw new VerifyError('TIMEOUT', `The host did not answer within ${Math.round(timeoutMs / 1000)} seconds.`);
      throw new VerifyError('NETWORK', 'The download was interrupted.');
    }
    return { text: Buffer.concat(chunks).toString('utf8'), url: current.href };
  }
  throw new VerifyError('HTTP_ERROR', 'Too many redirects.');
}

async function readLocal(fullPath, maxBytes = MAX_MANIFEST_BYTES) {
  let info;
  try {
    info = await stat(fullPath);
  } catch {
    throw new VerifyError('NOT_FOUND', 'The file does not exist on this server.');
  }
  if (!info.isFile()) throw new VerifyError('NOT_FOUND', 'The path is not a file.');
  if (info.size > maxBytes) throw new VerifyError('TOO_LARGE', 'The manifest is larger than 2 MB.');
  return readFile(fullPath, 'utf8');
}

/**
 * Resolves a media location into something readable:
 *   { local: '/abs/path', ref } for media/… (web root) and storage:… (private storage),
 *   { remote: 'https://…', ref } for URLs.
 */
export function locate(source, { root, storageRoot }) {
  if (source.startsWith('storage:')) {
    const full = safeJoin(storageRoot, source.slice(8));
    if (!full) throw new VerifyError('BAD_SOURCE', 'The storage key is not valid.');
    return { local: full, base: source, scheme: 'storage' };
  }
  if (/^https?:\/\//i.test(source)) return { remote: source, base: source, scheme: 'remote' };
  if (!source.startsWith('media/')) throw new VerifyError('BAD_SOURCE', 'Only site paths under media/ are read from disk.');
  const full = safeJoin(root, source);
  if (!full) throw new VerifyError('BAD_SOURCE', 'The path is not valid.');
  return { local: full, base: source, scheme: 'site' };
}

/** Resolves a URI inside a manifest against the manifest's own location (same scheme only). */
export function resolveRelative(loc, uri, env) {
  if (/^https?:\/\//i.test(uri)) {
    if (loc.scheme !== 'remote') throw new VerifyError('BAD_SOURCE', 'A local manifest points at a remote rendition.');
    return { remote: uri, base: uri, scheme: 'remote' };
  }
  if (loc.scheme === 'remote') {
    const abs = new URL(uri, loc.remote).href;
    return { remote: abs, base: abs, scheme: 'remote' };
  }
  const baseKey = loc.scheme === 'storage' ? loc.base.slice(8) : loc.base;
  const joined = posix.normalize(posix.join(posix.dirname(baseKey), uri.split('?')[0]));
  if (joined.startsWith('..')) throw new VerifyError('BAD_SOURCE', 'The manifest points outside its folder.');
  return locate(loc.scheme === 'storage' ? `storage:${joined}` : joined, env);
}

async function loadText(loc, env) {
  if (loc.local) return readLocal(loc.local);
  const { text } = await fetchLimited(loc.remote, { allowedOrigins: env.allowedOrigins, fetchImpl: env.fetchImpl, timeoutMs: env.timeoutMs || FETCH_TIMEOUT_MS });
  return text;
}

/** Reduces whatever the probe module returns to the few facts verification needs. */
export function summarizeProbe(p) {
  if (!p || typeof p !== 'object') return null;
  const streams = Array.isArray(p.streams) ? p.streams : [];
  const typeOf = (s) => s.codec_type || s.type || s.kind;
  const video = p.video || streams.find((s) => typeOf(s) === 'video') || null;
  const audios = Array.isArray(p.audioTracks) && p.audioTracks.length ? p.audioTracks
    : Array.isArray(p.audio) ? p.audio : p.audio ? [p.audio] : streams.filter((s) => typeOf(s) === 'audio');
  const audio = audios[0] || null;
  const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Number(x) : null);
  return {
    height: num(p.height ?? video?.height),
    width: num(p.width ?? video?.width),
    videoCodec: String(p.videoCodec ?? video?.codec ?? video?.codec_name ?? '').toLowerCase() || null,
    audioCodec: String(p.audioCodec ?? audio?.codec ?? audio?.codec_name ?? '').toLowerCase() || null,
    durationS: num(p.durationS ?? p.duration ?? p.format?.duration),
    container: String(p.container ?? p.format?.format_name ?? p.format ?? '').toLowerCase() || null,
    audioLanguages: audios.map((a) => lowerLang(a.language ?? a.lang ?? a.tags?.language)).filter(Boolean),
    hdr: p.hdr || null,
    error: p.error || null,
  };
}

/** True when a probe describes an MP4 every browser can play (H.264 video + AAC or no audio). */
export function isBrowserPlayableMp4(probe, mime = '') {
  const s = summarizeProbe(probe);
  if (!s) return false;
  const mp4 = /mp4|mov|m4v|isom/.test(s.container || '') || /video\/mp4/i.test(mime);
  const h264 = /^(h264|avc|avc1)/.test(s.videoCodec || '');
  const aac = !s.audioCodec || /^(aac|mp4a)/.test(s.audioCodec);
  return mp4 && h264 && aac;
}

/** A stored JSON list (DB column text) or an array → array. */
function parseJsonList(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const CODEC_NAMES = { h264: 'H.264', avc1: 'H.264', avc3: 'H.264', hevc: 'HEVC', h265: 'HEVC', hvc1: 'HEVC', hev1: 'HEVC', av1: 'AV1', av01: 'AV1', vp9: 'VP9', vp09: 'VP9', vp8: 'VP8' };

/**
 * Verifies one media row. Returns { ok, message, fields, report } where `fields` holds the
 * values to store (only when ok). Never throws for expected failures.
 *   env: { root, storageRoot, allowedOrigins, fetchImpl?, timeoutMs?, loadProbe?: () => Promise<fn|null>, labelFor? }
 */
export async function verifyMedia(row, env) {
  const checkedAt = new Date().toISOString();
  const fail = (code, message, extra = {}) => ({ ok: false, message, fields: null, report: { ok: false, code, message, checkedAt, ...extra } });
  try {
    if (row.kind === 'hls') return await verifyHls(row, env, checkedAt);
    if (row.kind === 'progressive') return await verifyProgressive(row, env, checkedAt);
    return fail('UNSUPPORTED', 'DASH manifests are not verified by Lumina yet. Resolutions and tracks stay unverified.');
  } catch (err) {
    if (err instanceof VerifyError) return fail(err.code, err.message);
    return fail('ERROR', 'Verification failed unexpectedly. See the server log.', { detail: String(err?.message || err).slice(0, 200) });
  }
}

async function verifyHls(row, env, checkedAt) {
  const loc = locate(row.source, env);
  const text = await loadText(loc, env);
  const parsed = parseHlsManifest(text);
  const fields = {};
  const labelFor = env.labelFor || defaultLabel;
  // Only a finished (#EXT-X-ENDLIST) playlist has a meaningful total duration.
  let durationS = parsed.endList ? parsed.durationS : null;
  let note = null;
  if (parsed.type === 'master') {
    Object.assign(fields, manifestToMediaFields(parsed, labelFor, {
      audioTracks: parseJsonList(row.audio_tracks ?? row.audioTracks),
      subtitleTracks: parseJsonList(row.subtitle_tracks ?? row.subtitleTracks),
    }));
    // Measure the real duration from the first rendition's media playlist when possible.
    const first = parsed.variants[0];
    try {
      const sub = parseHlsManifest(await loadText(resolveRelative(loc, first.uri, env), env));
      if (sub.endList && sub.durationS) durationS = sub.durationS;
    } catch {
      note = 'The first rendition playlist could not be read, so the duration was not measured.';
    }
  } else {
    fields.resolutions = [];
    note = 'This is a single-rendition media playlist: it does not declare a resolution, so no quality is claimed.';
  }
  if (durationS) fields.durationS = durationS;
  const report = {
    ok: true,
    checkedAt,
    kind: 'hls',
    playlist: parsed.type,
    renditions: parsed.variants.map((v) => ({ height: v.height, width: v.width, bandwidth: v.bandwidth, codecs: v.codecs, videoRange: v.videoRange })),
    // `label` is what Lumina shows viewers: the manifest NAME unless it is a packager placeholder.
    audio: parsed.audio.map((a) => ({ lang: a.lang, name: a.name, label: a.name && !GENERATED_NAME.test(a.name) ? a.name : labelFor(a.lang), channels: a.channels, default: a.default })),
    subtitles: [...parsed.subtitles, ...parsed.closedCaptions].map((s) => ({ lang: s.lang, name: s.name, label: s.name && !GENERATED_NAME.test(s.name) ? s.name : labelFor(s.lang), default: s.default })),
    iFramePlaylists: parsed.iFramePlaylists,
    durationS: durationS || null,
    note,
  };
  const parts = [];
  if (fields.resolutions.length) parts.push(`${fields.resolutions.length} rendition${fields.resolutions.length === 1 ? '' : 's'} (${fields.resolutions.map((h) => `${h}p`).join(', ')})`);
  if (fields.audioTracks) parts.push(`${fields.audioTracks.length} audio track${fields.audioTracks.length === 1 ? '' : 's'}`);
  if (fields.subtitleTracks) parts.push(`${fields.subtitleTracks.length} subtitle track${fields.subtitleTracks.length === 1 ? '' : 's'}`);
  return { ok: true, message: parts.length ? `Verified: ${parts.join(', ')}.` : `Verified the playlist. ${note || ''}`.trim(), fields, report };
}

async function verifyProgressive(row, env, checkedAt) {
  const loc = locate(row.source, env);
  if (!loc.local) {
    return {
      ok: false,
      message: 'Remote progressive files cannot be verified by the server (it would have to download the whole file). Resolution and tracks stay unverified.',
      fields: null,
      report: { ok: false, code: 'REMOTE_PROGRESSIVE', message: 'Remote progressive file — not verifiable.', checkedAt },
    };
  }
  const probeFile = env.loadProbe ? await env.loadProbe() : null;
  if (!probeFile) {
    return { ok: false, message: 'Probe unavailable: the media probe module (server/services/media/probe.js) is not installed, so this file cannot be verified.', fields: null, report: { ok: false, code: 'PROBE_UNAVAILABLE', message: 'Probe unavailable.', checkedAt } };
  }
  try {
    await stat(loc.local);
  } catch {
    throw new VerifyError('NOT_FOUND', 'The file does not exist on this server.');
  }
  const probes = [];
  const main = summarizeProbe(await probeFile(loc.local));
  if (!main || (!main.height && !main.durationS)) throw new VerifyError('PROBE_FAILED', `The probe could not read this file${main?.error ? `: ${main.error}` : '.'}`);
  probes.push(main);
  const variants = parseJsonList(row.variants);
  for (const v of variants) {
    try {
      const vl = locate(v.src, env);
      if (vl.local) {
        const s = summarizeProbe(await probeFile(vl.local));
        if (s) probes.push(s);
      }
    } catch {
      /* unreadable variants simply are not counted */
    }
  }
  const heights = [...new Set(probes.map((p) => p.height).filter(Boolean))].sort((a, b) => b - a);
  const codecs = [...new Set(probes.map((p) => CODEC_NAMES[p.videoCodec] || p.videoCodec).filter(Boolean))];
  const fields = { resolutions: heights, videoCodecs: codecs };
  if (main.durationS) fields.durationS = main.durationS;
  if (main.audioCodec) fields.audioFormats = [/^(aac|mp4a)/.test(main.audioCodec) ? 'AAC' : main.audioCodec.toUpperCase()];
  if (main.hdr) fields.hdr = main.hdr;
  return {
    ok: true,
    message: heights.length ? `Verified: ${heights.map((h) => `${h}p`).join(', ')}${codecs.length ? ` · ${codecs.join(', ')}` : ''}.` : 'Probed the file, but it reports no video resolution.',
    fields,
    report: { ok: true, checkedAt, kind: 'progressive', probes, durationS: main.durationS || null },
  };
}

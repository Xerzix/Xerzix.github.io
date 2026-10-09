// HLS transcoding with ffmpeg (spawned; no dependencies).
//   planLadder({ width, height })          → rungs that never exceed the source
//   transcodeToHls({ input, outDir, … })   → H.264 High video ladder + one AAC stereo audio group, verified
//   parseMasterPlaylist(text)              → variants and renditions of a master playlist (pure)
//   parseMediaPlaylist(text)               → segments of a media playlist (pure)
// One ffmpeg pass encodes every video rung (aligned keyframes, so players can switch at any
// segment boundary) and the audio once, as a separate rendition shared by all rungs through a
// single EXT-X-MEDIA audio group. The master playlist is written by Lumina, not by ffmpeg:
// every variant listed in it has been checked on disk (complete playlist, every segment
// present, and the resolution, profile and level read back from the H.264 SPS of its first
// segment). BANDWIDTH is the measured peak segment bitrate of the video plus the audio,
// AVERAGE-BANDWIDTH the measured mean.
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { inspectTsSegment } from './probe.js';

export const LADDER_RUNGS = [2160, 1440, 1080, 720, 480, 360];

// Target video bitrates (kbps) for H.264 at up to 30 fps; audio is AAC-LC stereo.
const RUNG_RATES = {
  2160: { videoKbps: 16000, audioKbps: 192 },
  1440: { videoKbps: 9000, audioKbps: 160 },
  1080: { videoKbps: 5000, audioKbps: 128 },
  720: { videoKbps: 2800, audioKbps: 128 },
  480: { videoKbps: 1400, audioKbps: 96 },
  360: { videoKbps: 800, audioKbps: 96 },
};

const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const evenDown = (n) => Math.max(2, Math.floor(n / 2) * 2);

/**
 * Plans the rendition ladder for a source. Only rungs at or below the source height are
 * used (never upscale); a source shorter than the smallest rung gets a single rung at its
 * own height. Widths keep the source aspect ratio and are even.
 */
export function planLadder({ width, height } = {}) {
  if (!Number.isFinite(height) || height <= 0) throw new Error('planLadder needs the source height.');
  const aspect = Number.isFinite(width) && width > 0 ? width / height : 16 / 9;
  const heights = LADDER_RUNGS.filter((r) => r <= height);
  if (!heights.length) heights.push(evenDown(height));
  return heights.map((h) => {
    const rate = RUNG_RATES[h] || {
      videoKbps: Math.max(250, Math.round(RUNG_RATES[360].videoKbps * (h / 360) ** 2)),
      audioKbps: 96,
    };
    return { height: h, width: Math.min(even(h * aspect), width > 0 ? evenDown(width) : Infinity), ...rate };
  });
}

// H.264 level limits (Annex A): [level, level_idc, MaxMBPS, MaxFS, MaxBR (×1000 bit/s)]
const H264_LEVELS = [
  ['3.0', 30, 40500, 1620, 10000], ['3.1', 31, 108000, 3600, 14000], ['3.2', 32, 216000, 5120, 20000],
  ['4.0', 40, 245760, 8192, 20000], ['4.1', 41, 245760, 8192, 50000], ['4.2', 42, 522240, 8704, 50000],
  ['5.0', 50, 589824, 22080, 135000], ['5.1', 51, 983040, 36864, 240000], ['5.2', 52, 2073600, 36864, 240000],
];

/** Smallest H.264 level (High profile) that fits the frame size, frame rate and peak rate. */
export function h264Level({ width, height, fps = 30, maxKbps = 0 }) {
  const fs = Math.ceil(width / 16) * Math.ceil(height / 16);
  const mbps = fs * Math.max(1, fps);
  for (const [name, , maxMbps, maxFs, maxBr] of H264_LEVELS) {
    if (fs <= maxFs && mbps <= maxMbps && maxKbps <= maxBr * 1.25) return name;
  }
  return '5.2';
}

// ───────────────────────── Playlists (pure) ─────────────────────────

/** Parses an HLS attribute list, honouring quoted strings that contain commas. */
export function parseAttributes(text) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1) : m[2];
  return out;
}

/**
 * Parses a master playlist.
 * → { version, independentSegments, variants: [{ uri, bandwidth, averageBandwidth, width, height, codecs, frameRate, audio }], media: [{…attributes}] }
 */
export function parseMasterPlaylist(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist (missing #EXTM3U).');
  const out = { version: null, independentSegments: false, variants: [], media: [] };
  let pending = null;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-VERSION:')) out.version = Number(line.slice(15));
    else if (line === '#EXT-X-INDEPENDENT-SEGMENTS') out.independentSegments = true;
    else if (line.startsWith('#EXT-X-MEDIA:')) out.media.push(parseAttributes(line.slice(13)));
    else if (line.startsWith('#EXT-X-STREAM-INF:')) pending = parseAttributes(line.slice(18));
    else if (!line.startsWith('#') && pending) {
      const [w, h] = (pending.RESOLUTION || '').split('x').map(Number);
      out.variants.push({
        uri: line,
        bandwidth: Number(pending.BANDWIDTH) || null,
        averageBandwidth: Number(pending['AVERAGE-BANDWIDTH']) || null,
        width: w || null,
        height: h || null,
        codecs: pending.CODECS || null,
        frameRate: Number(pending['FRAME-RATE']) || null,
        audio: pending.AUDIO || null,
      });
      pending = null;
    }
  }
  return out;
}

/** Parses a media playlist → { targetDuration, playlistType, endList, segments: [{ uri, duration }] }. */
export function parseMediaPlaylist(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist (missing #EXTM3U).');
  const out = { targetDuration: null, playlistType: null, endList: false, segments: [] };
  let duration = null;
  for (const line of lines.slice(1)) {
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) out.targetDuration = Number(line.slice(22));
    else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) out.playlistType = line.slice(21);
    else if (line === '#EXT-X-ENDLIST') out.endList = true;
    else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8));
    else if (!line.startsWith('#') && duration !== null) {
      out.segments.push({ uri: line, duration });
      duration = null;
    }
  }
  return out;
}

// ───────────────────────── ffmpeg ─────────────────────────

/**
 * Clockwise display rotation (0, 90, 180 or 270) from a stream's `ffmpeg -i` block: the
 * display matrix ("rotation of -90.00 degrees", counter-clockwise) or a legacy `rotate` tag.
 */
export function displayRotation(block) {
  const matrix = /rotation of (-?[\d.]+) degrees/.exec(block);
  const tag = /^\s*rotate\s*:\s*(-?\d+)/m.exec(block);
  const cw = matrix ? -Number(matrix[1]) : tag ? Number(tag[1]) : 0;
  return Number.isFinite(cw) ? ((Math.round(cw / 90) * 90) % 360 + 360) % 360 : 0;
}

/** Reads duration, frame rate, displayed dimensions and audio presence from `ffmpeg -i` (no ffprobe needed). */
export async function inspectWithFfmpeg(ffmpegPath, input) {
  const stderr = await new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', input], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), 60_000);
    proc.stderr.on('data', (d) => {
      if (err.length < 200_000) err += d;
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', () => {
      clearTimeout(timer);
      resolve(err);
    });
  });
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const videoMatch = /Stream #\d+:\d+[^\n]*?: Video: ([^\n]*)/.exec(stderr);
  const videoLine = videoMatch?.[1] || '';
  const dims = /(?:^|[ ,])(\d{2,5})x(\d{2,5})(?:[ ,\[]|$)/.exec(videoLine);
  const fps = /([\d.]+) fps/.exec(videoLine) || /([\d.]+) tbr/.exec(videoLine);
  // The video stream's own block (metadata and side data) runs until the next stream.
  const block = videoMatch ? stderr.slice(videoMatch.index + videoMatch[0].length).split(/\n\s*Stream #/)[0] : '';
  const rotation = displayRotation(block);
  const turned = rotation === 90 || rotation === 270;
  const w = dims ? Number(dims[1]) : null;
  const ht = dims ? Number(dims[2]) : null;
  return {
    durationS: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : null,
    // ffmpeg turns rotated video upright while decoding, so plan from the displayed size.
    width: turned ? ht : w,
    height: turned ? w : ht,
    rotation,
    fps: fps ? Number(fps[1]) || null : null,
    hasVideo: !!videoLine,
    hasAudio: /Stream #\d+:\d+[^\n]*?: Audio: /.test(stderr),
  };
}

function runFfmpeg(ffmpegPath, args, { durationS, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let buf = '';
    let outS = 0;
    let lastEmit = 0;
    const onAbort = () => proc.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const [k, v] = line.split('=');
        if (k === 'out_time_us' || k === 'out_time_ms') outS = Math.max(outS, Number(v) / 1e6 || 0);
        if (k === 'progress' && onProgress) {
          const now = Date.now();
          if (v === 'end' || now - lastEmit > 500) {
            lastEmit = now;
            const ratio = v === 'end' ? 1 : durationS ? Math.min(0.99, outS / durationS) : null;
            try {
              onProgress({ ratio, outTimeS: outS });
            } catch {
              /* progress callbacks must not break transcoding */
            }
          }
        }
      }
    });
    proc.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-6000);
    });
    proc.on('error', (e) => {
      signal?.removeEventListener('abort', onAbort);
      reject(e);
    });
    proc.on('close', (code, sig) => {
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) return reject(Object.assign(new Error('Transcoding was cancelled.'), { name: 'AbortError' }));
      if (code === 0) return resolve();
      const last = stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      reject(new Error(`ffmpeg failed (${sig || `exit ${code}`}): ${last || 'no output'}`));
    });
  });
}

/** Directory (and HLS rendition name) of the shared audio rendition. */
export const AUDIO_DIR = 'audio';
/** GROUP-ID of the single audio group every variant refers to. */
export const AUDIO_GROUP = 'aud';
const AAC_LC = 'mp4a.40.2';

/** The audio bitrate for a ladder: one rendition serves every rung, so use the richest rung's rate. */
export function audioBitrate(ladder) {
  return Math.max(96, ...ladder.map((r) => r.audioKbps || 0));
}

/**
 * Builds the ffmpeg argument list for one pass that encodes every video rung and, when the
 * source has audio, one AAC stereo rendition. Output: `<outDir>/v<i>/` per rung and
 * `<outDir>/audio/`, each with index.m3u8 and MPEG-TS segments.
 */
export function buildHlsArgs({ input, outDir, ladder, fps, segmentSeconds, hasAudio, audioKbps = audioBitrate(ladder), preset = 'veryfast' }) {
  const gop = Math.max(1, Math.round((fps || 30) * segmentSeconds));
  const args = ['-hide_banner', '-nostdin', '-y', '-loglevel', 'error', '-nostats', '-progress', 'pipe:1', '-i', input];
  ladder.forEach(() => args.push('-map', '0:v:0'));
  if (hasAudio) args.push('-map', '0:a:0');
  args.push('-c:v', 'libx264', '-preset', preset, '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0');
  if (!fps) args.push('-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`);
  ladder.forEach((r, i) => {
    const maxKbps = Math.round(r.videoKbps * 1.07);
    args.push(
      // The width follows the decoded (upright) picture, so the aspect ratio is always kept.
      `-filter:v:${i}`, `scale=-2:${r.height}:flags=bicubic,setsar=1`,
      `-b:v:${i}`, `${r.videoKbps}k`, `-maxrate:v:${i}`, `${maxKbps}k`, `-bufsize:v:${i}`, `${r.videoKbps * 2}k`,
      `-level:v:${i}`, h264Level({ width: r.width, height: r.height, fps: fps || 30, maxKbps }),
    );
  });
  if (hasAudio) args.push('-c:a', 'aac', '-ac', '2', '-ar', '48000', '-b:a:0', `${audioKbps}k`);
  const streams = ladder.map((_, i) => (hasAudio ? `v:${i},agroup:${AUDIO_GROUP},name:v${i}` : `v:${i},name:v${i}`));
  if (hasAudio) streams.push(`a:0,agroup:${AUDIO_GROUP},name:${AUDIO_DIR}`);
  args.push(
    '-f', 'hls', '-hls_time', String(segmentSeconds), '-hls_playlist_type', 'vod', '-hls_segment_type', 'mpegts',
    '-hls_flags', 'independent_segments', '-hls_segment_filename', join(outDir, '%v', 'seg_%05d.ts'),
    '-var_stream_map', streams.join(' '),
    join(outDir, '%v', 'index.m3u8'),
  );
  return args;
}

/**
 * Checks that a rendition directory holds a complete VOD playlist whose segments all exist,
 * and measures it. Returns { playlist, totalBytes, totalS, peakBps, firstSegment } or null.
 */
async function measurePlaylist(dir) {
  let playlist;
  try {
    playlist = parseMediaPlaylist(await readFile(join(dir, 'index.m3u8'), 'utf8'));
  } catch {
    return null;
  }
  if (!playlist.endList || !playlist.segments.length) return null;
  let totalBytes = 0;
  let totalS = 0;
  let peakBps = 0;
  for (const seg of playlist.segments) {
    if (!/^[\w.-]+$/.test(seg.uri)) return null;
    let size;
    try {
      size = (await stat(join(dir, seg.uri))).size;
    } catch {
      return null;
    }
    if (!size) return null;
    totalBytes += size;
    totalS += seg.duration;
    if (seg.duration > 0) peakBps = Math.max(peakBps, (size * 8) / seg.duration);
  }
  return { playlist, totalBytes, totalS, peakBps, firstSegment: join(dir, playlist.segments[0].uri) };
}

const averageBps = (m) => (m.totalS ? (m.totalBytes * 8) / m.totalS : m.peakBps);

/** Checks one video rendition and reads its real size and codec back from the H.264 SPS. */
async function verifyRendition(dir) {
  const m = await measurePlaylist(dir);
  if (!m) return null;
  const { sps } = inspectTsSegment(await readFile(m.firstSegment));
  if (!sps || !sps.width || !sps.height) return null;
  return {
    width: sps.width,
    height: sps.height,
    videoCodecs: sps.codecs,
    peakBps: m.peakBps,
    averageBps: averageBps(m),
    durationS: Math.round(m.totalS * 1000) / 1000,
    segments: m.playlist.segments.length,
  };
}

/** Checks the shared audio rendition (complete playlist, every segment a transport stream). */
async function verifyAudio(dir) {
  const m = await measurePlaylist(dir);
  if (!m) return null;
  try {
    inspectTsSegment(await readFile(m.firstSegment), { maxPackets: 64 });
  } catch {
    return null;
  }
  return { peakBps: m.peakBps, averageBps: averageBps(m), durationS: Math.round(m.totalS * 1000) / 1000, segments: m.playlist.segments.length };
}

function languageLabel(lang) {
  if (lang === 'zxx') return 'No dialogue';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
  } catch {
    return lang;
  }
}

const quoted = (s) => String(s).replace(/["\r\n]/g, '');

/**
 * Transcodes `input` into an HLS ladder under `outDir` and returns what was verified:
 *   { masterPath, renditions: [{ height, width, bandwidth, averageBandwidth, codecs, playlist }], durationS,
 *     hasAudio, fps, audio: { playlist, groupId, language, name, channels, codecs, bandwidth, averageBandwidth } | null }
 * `ladder` defaults to planLadder(source); rungs taller than the source are dropped.
 * `audioLanguage` (BCP 47, e.g. "ja"; "zxx" = no dialogue) is declared on the audio rendition only
 * when given — Lumina never guesses a language. `onProgress({ ratio, outTimeS })` is called
 * about twice a second. `signal` cancels.
 */
export async function transcodeToHls({
  input, outDir, ladder, ffmpegPath, segmentSeconds = 4, audio = true, audioLanguage = null, onProgress, signal, preset = 'veryfast',
} = {}) {
  if (!ffmpegPath) throw new Error('Transcoding requires ffmpeg on the host (FFMPEG_PATH) or a cloud transcoder');
  if (!input || !outDir) throw new Error('transcodeToHls needs input and outDir.');
  const src = await inspectWithFfmpeg(ffmpegPath, input);
  if (!src.hasVideo || !src.height) throw new Error('The source has no readable video stream.');
  const plan = (ladder?.length ? ladder : planLadder(src)).filter((r) => r.height <= src.height);
  if (!plan.length) throw new Error('Every requested rendition is taller than the source; refusing to upscale.');
  const hasAudio = audio && src.hasAudio;

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });
  await Promise.all([...plan.map((_, i) => `v${i}`), ...(hasAudio ? [AUDIO_DIR] : [])].map((d) => mkdir(join(outDir, d), { recursive: true })));
  const args = buildHlsArgs({ input, outDir, ladder: plan, fps: src.fps, segmentSeconds, hasAudio, preset });
  await runFfmpeg(ffmpegPath, args, { durationS: src.durationS, onProgress, signal });

  let audioInfo = null;
  if (hasAudio) {
    audioInfo = await verifyAudio(join(outDir, AUDIO_DIR));
    if (!audioInfo) throw new Error('Transcoding finished but the audio rendition is incomplete.');
  }

  // Verify each video rendition, then give it a readable directory name ("720p").
  const verified = [];
  for (let i = 0; i < plan.length; i++) {
    const dir = join(outDir, `v${i}`);
    const r = await verifyRendition(dir);
    if (!r || verified.some((v) => v.height === r.height)) {
      await rm(dir, { recursive: true, force: true });
      continue;
    }
    const name = `${r.height}p`;
    await rename(dir, join(outDir, name));
    verified.push({ ...r, playlist: `${name}/index.m3u8` });
  }
  // Remove anything ffmpeg left behind that is not part of a verified rendition.
  const keep = new Set([...verified.map((v) => v.playlist.split('/')[0]), ...(audioInfo ? [AUDIO_DIR] : [])]);
  for (const entry of await readdir(outDir)) {
    if (!keep.has(entry)) await rm(join(outDir, entry), { recursive: true, force: true });
  }
  if (!verified.length) throw new Error('Transcoding finished but produced no playable renditions.');

  verified.sort((a, b) => b.height - a.height);
  const lang = typeof audioLanguage === 'string' && /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(audioLanguage) && audioLanguage !== 'und' ? audioLanguage : null;
  const audioName = lang ? languageLabel(lang) : 'Original audio';
  const frameRate = src.fps ? `,FRAME-RATE=${src.fps.toFixed(3)}` : '';
  const master = ['#EXTM3U', '#EXT-X-VERSION:6', '#EXT-X-INDEPENDENT-SEGMENTS'];
  if (audioInfo) {
    master.push(`#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="${AUDIO_GROUP}",NAME="${quoted(audioName)}",${lang ? `LANGUAGE="${lang}",` : ''}DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="${AUDIO_DIR}/index.m3u8"`);
  }
  for (const r of verified) {
    const bandwidth = Math.ceil(r.peakBps + (audioInfo?.peakBps || 0));
    const average = Math.ceil(r.averageBps + (audioInfo?.averageBps || 0));
    const codecs = audioInfo ? `${r.videoCodecs},${AAC_LC}` : r.videoCodecs;
    master.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},AVERAGE-BANDWIDTH=${average},RESOLUTION=${r.width}x${r.height}${frameRate},CODECS="${codecs}"${audioInfo ? `,AUDIO="${AUDIO_GROUP}"` : ''}`,
      r.playlist,
    );
  }
  const masterPath = join(outDir, 'master.m3u8');
  await writeFile(masterPath, `${master.join('\n')}\n`);

  // Read the master back: report exactly the renditions it lists and that exist.
  const parsed = parseMasterPlaylist(await readFile(masterPath, 'utf8'));
  const renditions = [];
  for (const v of parsed.variants) {
    if (!verified.some((x) => x.playlist === v.uri)) continue;
    renditions.push({ height: v.height, width: v.width, bandwidth: v.bandwidth, averageBandwidth: v.averageBandwidth, codecs: v.codecs, playlist: v.uri });
  }
  const audioEntry = parsed.media.find((m) => m.TYPE === 'AUDIO' && m['GROUP-ID'] === AUDIO_GROUP);
  return {
    masterPath,
    renditions,
    durationS: verified[0].durationS || src.durationS,
    hasAudio: !!audioEntry,
    fps: src.fps,
    audio: audioEntry
      ? {
        playlist: audioEntry.URI,
        groupId: AUDIO_GROUP,
        language: audioEntry.LANGUAGE || null,
        name: audioEntry.NAME,
        channels: Number(audioEntry.CHANNELS) || null,
        codecs: AAC_LC,
        bandwidth: Math.ceil(audioInfo.peakBps),
        averageBandwidth: Math.ceil(audioInfo.averageBps),
      }
      : null,
  };
}

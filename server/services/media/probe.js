// Media inspection without trusting names or declared types.
//   sniffType(buffer)          → what the bytes are (magic numbers), or null
//   probeFile(path, opts)      → container, duration, dimensions, codecs and tracks
//   parseMp4(buffer)           → pure-JS MP4/MOV box parser (used when ffprobe is absent)
//   imageSize(buffer)          → PNG / JPEG / WebP dimensions
//   parseH264Sps(nal)          → profile, level and coded size from an H.264 SPS
//   inspectTsSegment(buffer)   → H.264 facts read from an MPEG-TS segment (HLS verification)
// Uses ffprobe (JSON output) only when a path is configured, and falls back to the pure-JS
// parsers if it is missing, crashes or times out.
import { spawn } from 'node:child_process';
import { open, stat } from 'node:fs/promises';

// ───────────────────────── Types ─────────────────────────

export const FILE_TYPES = {
  mp4: { mime: 'video/mp4', kind: 'video', ext: 'mp4' },
  mov: { mime: 'video/quicktime', kind: 'video', ext: 'mov' },
  mkv: { mime: 'video/x-matroska', kind: 'video', ext: 'mkv' },
  webm: { mime: 'video/webm', kind: 'video', ext: 'webm' },
  ts: { mime: 'video/mp2t', kind: 'video', ext: 'ts' },
  png: { mime: 'image/png', kind: 'image', ext: 'png' },
  jpeg: { mime: 'image/jpeg', kind: 'image', ext: 'jpg' },
  webp: { mime: 'image/webp', kind: 'image', ext: 'webp' },
  pdf: { mime: 'application/pdf', kind: 'document', ext: 'pdf' },
  vtt: { mime: 'text/vtt', kind: 'subtitle', ext: 'vtt' },
  srt: { mime: 'application/x-subrip', kind: 'subtitle', ext: 'srt' },
  text: { mime: 'text/plain', kind: 'text', ext: 'txt' },
};

const toBuffer = (input) => (Buffer.isBuffer(input) ? input : Buffer.from(input.buffer ?? input, input.byteOffset ?? 0, input.byteLength ?? input.length));

const QUICKTIME_TOP_LEVEL = new Set(['moov', 'mdat', 'wide', 'free', 'skip', 'pnot']);

/** Decodes a (possibly truncated) prefix as strict UTF-8. Returns null when it is not text. */
export function decodeUtf8(buf, { complete = false } = {}) {
  let b = buf;
  if (!complete) {
    // A prefix may end in the middle of a multi-byte sequence; drop that tail.
    let cut = 0;
    for (let i = b.length - 1; i >= 0 && i >= b.length - 4; i--) {
      const c = b[i];
      if ((c & 0xc0) === 0x80) continue; // continuation byte
      if (c >= 0xc0) {
        const need = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2;
        if (b.length - i < need) cut = b.length - i;
      }
      break;
    }
    if (cut) b = b.subarray(0, b.length - cut);
  }
  if (b.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(b);
  } catch {
    return null;
  }
}

const SRT_RE = /^\s*\d+[ \t]*\r?\n[ \t]*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}[ \t]*-->[ \t]*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}/;

/** Classifies text as WebVTT, SubRip or plain UTF-8 text. */
export function classifyText(text) {
  const t = text.replace(/^﻿/, '');
  if (/^WEBVTT(?:[ \t\r\n]|$)/.test(t)) return 'vtt';
  if (SRT_RE.test(t)) return 'srt';
  return 'text';
}

/**
 * Identifies a file from its first bytes (64 KiB is plenty). Returns
 * `{ type, mime, kind, ext }` or null for unknown binary data.
 */
export function sniffType(input) {
  const b = toBuffer(input);
  const out = (type) => ({ type, ...FILE_TYPES[type] });
  if (b.length >= 8 && b[0] === 0x89 && b.toString('latin1', 1, 4) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return out('png');
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return out('jpeg');
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return out('webp');
  if (b.length >= 5 && b.toString('latin1', 0, 5) === '%PDF-') return out('pdf');
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    // EBML header: the DocType element (0x4282) says "webm" or "matroska".
    const head = b.toString('latin1', 0, Math.min(b.length, 128));
    return out(head.includes('webm') ? 'webm' : 'mkv');
  }
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    return out(brand === 'qt  ' ? 'mov' : 'mp4');
  }
  if (b.length >= 8 && QUICKTIME_TOP_LEVEL.has(b.toString('latin1', 4, 8)) && b.readUInt32BE(0) >= 8) return out('mov');
  // MPEG transport stream: a 0x47 sync byte every 188 bytes (or 192 for M2TS/BDAV).
  if (b.length >= 376 && b[0] === 0x47 && b[188] === 0x47 && (b.length < 565 || b[376] === 0x47)) return out('ts');
  if (b.length >= 388 && b[4] === 0x47 && b[196] === 0x47 && (b.length < 581 || b[388] === 0x47)) return out('ts');
  const text = decodeUtf8(b);
  if (text !== null && b.length) return out(classifyText(text));
  return null;
}

// ───────────────────────── Languages & codecs ─────────────────────────

const ISO639_2_TO_1 = {
  eng: 'en', jpn: 'ja', fra: 'fr', fre: 'fr', deu: 'de', ger: 'de', spa: 'es', ita: 'it', por: 'pt', rus: 'ru',
  zho: 'zh', chi: 'zh', kor: 'ko', nld: 'nl', dut: 'nl', swe: 'sv', nor: 'no', nob: 'nb', nno: 'nn', dan: 'da',
  fin: 'fi', pol: 'pl', tur: 'tr', ara: 'ar', hin: 'hi', heb: 'he', ell: 'el', gre: 'el', ces: 'cs', cze: 'cs',
  hun: 'hu', ron: 'ro', rum: 'ro', ukr: 'uk', tha: 'th', vie: 'vi', ind: 'id', msa: 'ms', may: 'ms', fas: 'fa',
  per: 'fa', cat: 'ca', eus: 'eu', baq: 'eu', glg: 'gl', isl: 'is', ice: 'is', gle: 'ga', cym: 'cy', wel: 'cy',
  hrv: 'hr', srp: 'sr', slk: 'sk', slo: 'sk', slv: 'sl', bul: 'bg', lit: 'lt', lav: 'lv', est: 'et', tam: 'ta',
  tel: 'te', ben: 'bn', urd: 'ur', fil: 'fil', tgl: 'tl', swa: 'sw', afr: 'af', zxx: 'zxx', mul: 'mul',
};

/** ISO 639-2 ("eng") → ISO 639-1 ("en") where one exists. Unknown/empty → "und". */
export function normalizeLang(code) {
  if (!code || typeof code !== 'string') return 'und';
  const c = code.trim().toLowerCase();
  if (!c || c === 'und' || c === 'unk') return 'und';
  if (/^[a-z]{2}(-[a-z0-9]{2,8})?$/i.test(c)) return c;
  return ISO639_2_TO_1[c] || (/^[a-z]{3}$/.test(c) ? c : 'und');
}

const FOURCC = {
  avc1: 'h264', avc3: 'h264', hvc1: 'hevc', hev1: 'hevc', dvh1: 'hevc', dvhe: 'hevc', av01: 'av1', vp09: 'vp9', vp08: 'vp8',
  mp4v: 'mpeg4', jpeg: 'mjpeg', mjpa: 'mjpeg', apch: 'prores', apcn: 'prores', apcs: 'prores', apco: 'prores', ap4h: 'prores',
  ap4x: 'prores', 'dvc ': 'dvvideo', dvcp: 'dvvideo', 'raw ': 'rawvideo', mp4a: 'aac', 'ac-3': 'ac3', 'ec-3': 'eac3',
  'ac-4': 'ac4', Opus: 'opus', fLaC: 'flac', alac: 'alac', lpcm: 'pcm', sowt: 'pcm', twos: 'pcm', in24: 'pcm', in32: 'pcm',
  '.mp3': 'mp3', tx3g: 'mov_text', text: 'mov_text', wvtt: 'webvtt', stpp: 'ttml', c608: 'eia_608', c708: 'eia_708',
};

const codecName = (fourcc) => FOURCC[fourcc] || fourcc.replace(/[^\x20-\x7e]/g, '').trim() || null;

// ───────────────────────── MP4 / MOV ─────────────────────────

function* boxes(b, start, end) {
  let pos = start;
  while (pos + 8 <= end) {
    let size = b.readUInt32BE(pos);
    const type = b.toString('latin1', pos + 4, pos + 8);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return;
      size = Number(b.readBigUInt64BE(pos + 8));
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header) return; // corrupt
    const boxEnd = pos + size;
    yield { type, start: pos, data: pos + header, end: Math.min(boxEnd, end), truncated: boxEnd > end };
    if (boxEnd > end) return;
    pos = boxEnd;
  }
}

const child = (b, box, type) => {
  for (const c of boxes(b, box.data, box.end)) if (c.type === type) return c;
  return null;
};

function macLangOrIso(v) {
  if (v < 0x400 || v === 0x7fff) return 'und'; // QuickTime Macintosh language code or unspecified
  const s = String.fromCharCode(((v >> 10) & 31) + 0x60, ((v >> 5) & 31) + 0x60, (v & 31) + 0x60);
  return /^[a-z]{3}$/.test(s) ? normalizeLang(s) : 'und';
}

/** AAC channel count from an esds box's AudioSpecificConfig (the sample entry often says 2). */
function aacChannels(b, esds) {
  let p = esds.data + 4; // version + flags
  const readDescriptor = () => {
    if (p + 2 > esds.end) return null;
    const tag = b[p++];
    let size = 0;
    for (let i = 0; i < 4 && p < esds.end; i++) {
      const c = b[p++];
      size = (size << 7) | (c & 0x7f);
      if (!(c & 0x80)) break;
    }
    return { tag, size, start: p };
  };
  const es = readDescriptor();
  if (!es || es.tag !== 0x03) return null;
  const flags = b[p + 2];
  p += 3;
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + b[p];
  if (flags & 0x20) p += 2;
  const dc = readDescriptor();
  if (!dc || dc.tag !== 0x04) return null;
  p += 13;
  const dsi = readDescriptor();
  if (!dsi || dsi.tag !== 0x05 || p + 2 > esds.end) return null;
  const r = new BitReader(b.subarray(p, Math.min(esds.end, p + dsi.size)));
  try {
    let aot = r.bits(5);
    if (aot === 31) aot = 32 + r.bits(6);
    if (r.bits(4) === 15) r.bits(24);
    const config = r.bits(4);
    return config >= 1 && config <= 6 ? config : config === 7 ? 8 : null;
  } catch {
    return null;
  }
}

function soundEntryChannels(b, entry, entryEnd) {
  const version = b.readUInt16BE(entry + 16);
  const childStart = entry + 36 + (version === 1 ? 16 : version === 2 ? 36 : 0);
  for (const c of boxes(b, childStart, entryEnd)) {
    const esds = c.type === 'esds' ? c : c.type === 'wave' ? child(b, c, 'esds') : null;
    if (esds) return aacChannels(b, esds);
  }
  return null;
}

function parseTrak(b, trak) {
  const t = { handler: null, codec: null, fourcc: null, lang: 'und', durationS: null, width: null, height: null, rotation: 0, channels: null, sampleRate: null };
  const tkhd = child(b, trak, 'tkhd');
  if (tkhd && tkhd.end - tkhd.data >= 84) {
    const v = b[tkhd.data];
    const off = tkhd.data + (v === 1 ? 88 : 76);
    if (off + 8 <= tkhd.end) {
      t.width = Math.round(b.readUInt32BE(off) / 65536) || null;
      t.height = Math.round(b.readUInt32BE(off + 4) / 65536) || null;
      // The display matrix (a b u / c d v / x y w) sits just before the size; phones record
      // portrait video as a landscape frame plus a quarter-turn here.
      const m = off - 36;
      const a = b.readInt32BE(m) / 65536;
      const bb = b.readInt32BE(m + 4) / 65536;
      if (a || bb) t.rotation = quarterTurns((Math.atan2(bb, a) * 180) / Math.PI);
    }
  }
  const mdia = child(b, trak, 'mdia');
  if (!mdia) return t;
  const mdhd = child(b, mdia, 'mdhd');
  if (mdhd) {
    const v = b[mdhd.data];
    try {
      const timescale = v === 1 ? b.readUInt32BE(mdhd.data + 20) : b.readUInt32BE(mdhd.data + 12);
      const duration = v === 1 ? Number(b.readBigUInt64BE(mdhd.data + 24)) : b.readUInt32BE(mdhd.data + 16);
      if (timescale) t.durationS = duration / timescale;
      t.lang = macLangOrIso(b.readUInt16BE(mdhd.data + (v === 1 ? 32 : 20)));
    } catch {
      /* truncated mdhd */
    }
  }
  const hdlr = child(b, mdia, 'hdlr');
  if (hdlr && hdlr.data + 12 <= hdlr.end) t.handler = b.toString('latin1', hdlr.data + 8, hdlr.data + 12);
  const minf = child(b, mdia, 'minf');
  const stbl = minf && child(b, minf, 'stbl');
  const stsd = stbl && child(b, stbl, 'stsd');
  if (stsd && stsd.data + 16 <= stsd.end) {
    const entry = stsd.data + 8;
    t.fourcc = b.toString('latin1', entry + 4, entry + 8);
    t.codec = codecName(t.fourcc);
    if (t.handler === 'vide' && entry + 36 <= stsd.end) {
      t.width ||= b.readUInt16BE(entry + 32) || null;
      t.height ||= b.readUInt16BE(entry + 34) || null;
    }
    if (t.handler === 'soun' && entry + 36 <= stsd.end) {
      t.channels = b.readUInt16BE(entry + 24) || null;
      t.sampleRate = b.readUInt16BE(entry + 32) || null;
      if (t.fourcc === 'mp4a') {
        try {
          t.channels = soundEntryChannels(b, entry, Math.min(stsd.end, entry + b.readUInt32BE(entry))) || t.channels;
        } catch {
          /* keep the sample-entry value */
        }
      }
    }
  }
  return t;
}

/**
 * Parses the top-level boxes of an MP4/MOV file held in `buffer` (ftyp + moov are enough;
 * a truncated mdat is fine). Pure: no I/O.
 */
export function parseMp4(input) {
  const b = toBuffer(input);
  const out = {
    container: null, brand: null, compatibleBrands: [], durationS: null, width: null, height: null, videoCodec: null,
    audioCodec: null, audioTracks: [], subtitleTracks: [], tracks: [], fragmented: false, hasMoov: false,
  };
  for (const box of boxes(b, 0, b.length)) {
    if (box.type === 'ftyp' && box.end - box.data >= 8) {
      out.brand = b.toString('latin1', box.data, box.data + 4);
      for (let p = box.data + 8; p + 4 <= box.end; p += 4) out.compatibleBrands.push(b.toString('latin1', p, p + 4));
    } else if (box.type === 'moov' && !box.truncated) {
      out.hasMoov = true;
      let movieDuration = null;
      for (const c of boxes(b, box.data, box.end)) {
        if (c.type === 'mvhd') {
          const v = b[c.data];
          try {
            const timescale = v === 1 ? b.readUInt32BE(c.data + 20) : b.readUInt32BE(c.data + 12);
            const duration = v === 1 ? Number(b.readBigUInt64BE(c.data + 24)) : b.readUInt32BE(c.data + 16);
            if (timescale && duration && duration !== 0xffffffff) movieDuration = duration / timescale;
          } catch {
            /* truncated */
          }
        } else if (c.type === 'mvex') {
          out.fragmented = true;
          const mehd = child(b, c, 'mehd');
          if (mehd && !movieDuration) out.fragmentDuration = b[mehd.data] === 1 ? Number(b.readBigUInt64BE(mehd.data + 4)) : b.readUInt32BE(mehd.data + 4);
        } else if (c.type === 'trak') {
          out.tracks.push(parseTrak(b, c));
        }
      }
      const trackMax = Math.max(0, ...out.tracks.map((t) => t.durationS || 0));
      out.durationS = movieDuration || trackMax || null;
    }
  }
  if (out.brand || out.hasMoov) out.container = out.brand && out.brand !== 'qt  ' ? 'mp4' : 'mov';
  const video = out.tracks.find((t) => t.handler === 'vide');
  if (video) {
    Object.assign(out, displayed(video.width, video.height, video.rotation));
    out.videoCodec = video.codec;
  }
  const audio = out.tracks.filter((t) => t.handler === 'soun');
  out.audioCodec = audio[0]?.codec ?? null;
  out.audioTracks = audio.map((t) => ({ lang: t.lang, channels: t.channels, codec: t.codec }));
  out.subtitleTracks = out.tracks.filter((t) => ['subt', 'text', 'sbtl', 'clcp'].includes(t.handler)).map((t) => ({ lang: t.lang, codec: t.codec }));
  if (out.durationS) out.durationS = Math.round(out.durationS * 1000) / 1000;
  return out;
}

/** Reads only the ftyp and moov boxes of a (possibly huge) MP4/MOV file. */
async function readMp4Header(path, size) {
  const fh = await open(path, 'r');
  try {
    const parts = [];
    const hdr = Buffer.alloc(16);
    let pos = 0;
    for (let i = 0; i < 10_000 && pos + 8 <= size; i++) {
      const { bytesRead } = await fh.read(hdr, 0, 16, pos);
      if (bytesRead < 8) break;
      let boxSize = hdr.readUInt32BE(0);
      const type = hdr.toString('latin1', 4, 8);
      if (boxSize === 1 && bytesRead >= 16) boxSize = Number(hdr.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - pos;
      if (boxSize < 8) break;
      if ((type === 'ftyp' || type === 'moov') && boxSize <= 128 * 1024 * 1024) {
        const buf = Buffer.alloc(Math.min(boxSize, size - pos));
        await fh.read(buf, 0, buf.length, pos);
        parts.push(buf);
        if (type === 'moov') break;
      }
      pos += boxSize;
    }
    return Buffer.concat(parts);
  } finally {
    await fh.close();
  }
}

// ───────────────────────── Images ─────────────────────────

/** Width and height of a PNG, JPEG or WebP image from its first bytes, or null. */
export function imageSize(input) {
  const b = toBuffer(input);
  const type = sniffType(b.subarray(0, 64))?.type;
  try {
    if (type === 'png' && b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR') return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    if (type === 'webp' && b.length >= 30) {
      const chunk = b.toString('latin1', 12, 16);
      if (chunk === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
    }
    if (type === 'jpeg') {
      let p = 2;
      while (p + 9 < b.length) {
        if (b[p] !== 0xff) {
          p++;
          continue;
        }
        const marker = b[p + 1];
        if (marker === 0xff) {
          p++;
          continue;
        }
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
          p += 2;
          continue;
        }
        const len = b.readUInt16BE(p + 2);
        if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
          return { width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5) };
        }
        p += 2 + len;
      }
    }
  } catch {
    /* truncated header */
  }
  return null;
}

// ───────────────────────── H.264 (HLS verification) ─────────────────────────

class BitReader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }
  bit() {
    if (this.pos >= this.buf.length * 8) throw new Error('SPS truncated');
    const v = (this.buf[this.pos >> 3] >> (7 - (this.pos & 7))) & 1;
    this.pos++;
    return v;
  }
  bits(n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 2 + this.bit();
    return v;
  }
  ue() {
    let zeros = 0;
    while (this.bit() === 0) {
      zeros++;
      if (zeros > 31) throw new Error('Invalid Exp-Golomb code');
    }
    return 2 ** zeros - 1 + this.bits(zeros);
  }
  se() {
    const k = this.ue();
    return k % 2 ? (k + 1) / 2 : -k / 2;
  }
}

/** Removes emulation-prevention bytes (00 00 03 → 00 00) from a NAL unit. */
export function unescapeRbsp(nal) {
  const out = [];
  let zeros = 0;
  for (const byte of nal) {
    if (zeros >= 2 && byte === 3) {
      zeros = 0;
      continue;
    }
    out.push(byte);
    zeros = byte === 0 ? zeros + 1 : 0;
  }
  return Buffer.from(out);
}

const HIGH_PROFILES = new Set([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135]);

/**
 * Parses an H.264 sequence parameter set. `nal` starts at the NAL header byte (0x67…).
 * Returns { profileIdc, constraintFlags, levelIdc, width, height, codecs } where codecs is the
 * RFC 6381 string ("avc1.64001f").
 */
export function parseH264Sps(input) {
  const nal = unescapeRbsp(toBuffer(input).subarray(0, 256));
  if ((nal[0] & 0x1f) !== 7) throw new Error('Not an SPS NAL unit');
  const r = new BitReader(nal.subarray(1));
  const profileIdc = r.bits(8);
  const constraintFlags = r.bits(8);
  const levelIdc = r.bits(8);
  r.ue(); // seq_parameter_set_id
  let chromaFormatIdc = 1;
  let separateColourPlane = 0;
  if (HIGH_PROFILES.has(profileIdc)) {
    chromaFormatIdc = r.ue();
    if (chromaFormatIdc === 3) separateColourPlane = r.bit();
    r.ue(); // bit_depth_luma_minus8
    r.ue(); // bit_depth_chroma_minus8
    r.bit(); // qpprime_y_zero_transform_bypass_flag
    if (r.bit()) {
      const lists = chromaFormatIdc !== 3 ? 8 : 12;
      for (let i = 0; i < lists; i++) {
        if (!r.bit()) continue;
        const size = i < 6 ? 16 : 64;
        let last = 8;
        let next = 8;
        for (let j = 0; j < size; j++) {
          if (next !== 0) next = (last + r.se() + 256) % 256;
          last = next === 0 ? last : next;
        }
      }
    }
  }
  r.ue(); // log2_max_frame_num_minus4
  const pocType = r.ue();
  if (pocType === 0) r.ue();
  else if (pocType === 1) {
    r.bit();
    r.se();
    r.se();
    const n = r.ue();
    for (let i = 0; i < n; i++) r.se();
  }
  r.ue(); // max_num_ref_frames
  r.bit(); // gaps_in_frame_num_value_allowed_flag
  const widthMbs = r.ue() + 1;
  const heightMapUnits = r.ue() + 1;
  const frameMbsOnly = r.bit();
  if (!frameMbsOnly) r.bit();
  r.bit(); // direct_8x8_inference_flag
  let crop = [0, 0, 0, 0];
  if (r.bit()) crop = [r.ue(), r.ue(), r.ue(), r.ue()];
  const chroma = separateColourPlane ? 0 : chromaFormatIdc;
  const subW = chroma === 1 || chroma === 2 ? 2 : 1;
  const subH = chroma === 1 ? 2 : 1;
  const cropUnitX = chroma === 0 ? 1 : subW;
  const cropUnitY = (chroma === 0 ? 1 : subH) * (2 - frameMbsOnly);
  const width = widthMbs * 16 - (crop[0] + crop[1]) * cropUnitX;
  const height = (2 - frameMbsOnly) * heightMapUnits * 16 - (crop[2] + crop[3]) * cropUnitY;
  const hex = (n) => n.toString(16).padStart(2, '0');
  return { profileIdc, constraintFlags, levelIdc, width, height, codecs: `avc1.${hex(profileIdc)}${hex(constraintFlags)}${hex(levelIdc)}` };
}

/** Finds the first SPS in an Annex-B byte stream. */
export function findSps(buf) {
  for (let i = 0; i + 4 < buf.length; i++) {
    if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1 && (buf[i + 3] & 0x9f) === 0x07) return buf.subarray(i + 3);
  }
  return null;
}

/**
 * Reads an MPEG-TS segment and returns the H.264 facts of its first video SPS:
 * { packets, sps: {…parseH264Sps} | null }. Throws when the data is not a transport stream.
 */
export function inspectTsSegment(input, { maxPackets = 4000 } = {}) {
  const b = toBuffer(input);
  if (b.length < 188 || b[0] !== 0x47) throw new Error('Not an MPEG-TS segment');
  const byPid = new Map();
  let packets = 0;
  for (let p = 0; p + 188 <= b.length && packets < maxPackets; p += 188, packets++) {
    if (b[p] !== 0x47) throw new Error(`Lost MPEG-TS sync at byte ${p}`);
    const pid = ((b[p + 1] & 0x1f) << 8) | b[p + 2];
    const afc = (b[p + 3] >> 4) & 3;
    let start = p + 4;
    if (afc & 2) start += 1 + b[p + 4];
    if (!(afc & 1) || start >= p + 188) continue;
    if (!byPid.has(pid)) byPid.set(pid, []);
    byPid.get(pid).push(b.subarray(start, p + 188));
  }
  for (const [pid, chunks] of byPid) {
    if (pid === 0 || pid === 0x1fff) continue;
    const sps = findSps(Buffer.concat(chunks));
    if (sps) {
      try {
        return { packets, sps: parseH264Sps(sps) };
      } catch {
        /* keep looking */
      }
    }
  }
  return { packets, sps: null };
}

// ───────────────────────── ffprobe ─────────────────────────

function run(cmd, args, { timeoutMs = 60_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out = [];
    let size = 0;
    let err = '';
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    proc.stdout.on('data', (d) => {
      size += d.length;
      if (size <= maxBytes) out.push(d);
    });
    proc.stderr.on('data', (d) => {
      err = (err + d).slice(-4000);
    });
    proc.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'));
      else {
        const e = new Error(`${cmd.split('/').pop()} failed (${signal || `exit ${code}`}): ${err.trim().split('\n').pop() || 'no output'}`);
        e.exitCode = signal ? null : code; // a non-zero exit means ffprobe ran and could not read the input
        reject(e);
      }
    });
  });
}

const parseRate = (r) => {
  if (!r || r === '0/0') return null;
  const [a, b] = String(r).split('/').map(Number);
  const v = b ? a / b : a;
  return Number.isFinite(v) && v > 0 ? Math.round(v * 1000) / 1000 : null;
};

/** Normalises a rotation to clockwise degrees in [0, 360), to the nearest quarter turn. */
function quarterTurns(deg) {
  if (!Number.isFinite(deg)) return 0;
  return ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
}

/**
 * Clockwise display rotation of an ffprobe video stream: the display matrix side data
 * (counter-clockwise degrees, newer ffmpeg) or the legacy `rotate` tag (clockwise).
 */
export function ffprobeRotation(stream) {
  const matrix = (stream?.side_data_list || []).find((d) => d && Number.isFinite(Number(d.rotation)) && (d.side_data_type === 'Display Matrix' || 'displaymatrix' in d));
  if (matrix) return quarterTurns(-Number(matrix.rotation));
  if (stream?.tags?.rotate !== undefined) return quarterTurns(Number(stream.tags.rotate));
  return 0;
}

/** Width and height as the picture is displayed (swapped for a quarter-turn rotation). */
function displayed(width, height, rotation) {
  const turned = rotation === 90 || rotation === 270;
  return turned ? { width: height, height: width, rotation, codedWidth: width, codedHeight: height } : { width, height, rotation };
}

function fromFfprobe(json, sniffed) {
  const streams = json.streams || [];
  const format = json.format || {};
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.filter((s) => s.codec_type === 'audio');
  const subs = streams.filter((s) => s.codec_type === 'subtitle');
  const formatName = String(format.format_name || '');
  let container = sniffed || formatName.split(',')[0] || null;
  if (formatName === 'mpegts') container = 'ts';
  const duration = Number(format.duration) || Math.max(0, ...streams.map((s) => Number(s.duration) || 0)) || null;
  const transfer = video?.color_transfer;
  return {
    container,
    durationS: duration ? Math.round(duration * 1000) / 1000 : null,
    ...displayed(video?.width ?? null, video?.height ?? null, video ? ffprobeRotation(video) : 0),
    videoCodec: video?.codec_name ?? null,
    audioCodec: audio[0]?.codec_name ?? null,
    audioTracks: audio.map((s) => ({ lang: normalizeLang(s.tags?.language), channels: s.channels ?? null, codec: s.codec_name ?? null })),
    subtitleTracks: subs.map((s) => ({ lang: normalizeLang(s.tags?.language), codec: s.codec_name ?? null })),
    bitrateKbps: format.bit_rate ? Math.round(Number(format.bit_rate) / 1000) : null,
    fps: parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate),
    hdr: transfer === 'smpte2084' ? 'HDR10' : transfer === 'arib-std-b67' ? 'HLG' : null,
    source: 'ffprobe',
  };
}

/**
 * Removes server paths from a tool's message (it is stored with the file and shown to its
 * owner): each [path, label] pair is replaced by its label, and any other absolute path by "…".
 */
export function redactPaths(message, replacements = []) {
  let out = String(message || '');
  for (const [path, label] of replacements) if (path) out = out.split(path).join(label);
  return out.replace(/(?:[A-Za-z]:)?(?:[\\/][\w.@+-]+){2,}/g, '…');
}

async function readHead(path, bytes) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

/**
 * Inspects a media file.
 * → { container, durationS, width, height, videoCodec, audioCodec, audioTracks: [{lang, channels, codec}],
 *     subtitleTracks: [{lang, codec}], bitrateKbps, source: 'ffprobe'|'mp4-parser'|'basic', …extras }
 * Never throws for unreadable media; it returns what could be established plus `error`.
 */
export async function probeFile(path, { ffprobePath = '', timeoutMs = 60_000 } = {}) {
  const info = await stat(path);
  const head = await readHead(path, 256 * 1024);
  const sniffed = sniffType(head);
  const base = {
    container: sniffed?.type ?? null, durationS: null, width: null, height: null, videoCodec: null, audioCodec: null,
    audioTracks: [], subtitleTracks: [], bitrateKbps: null, sizeBytes: info.size,
  };
  let ffprobeError = null;
  let ffprobeUnreadable = false;
  if (ffprobePath && sniffed?.kind === 'video') {
    try {
      const text = await run(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs });
      return { ...base, ...fromFfprobe(JSON.parse(text), sniffed?.type) };
    } catch (err) {
      ffprobeError = redactPaths(err.message, [[path, 'the file'], [ffprobePath, 'ffprobe']]).slice(0, 300);
      // ffprobe ran to completion and said no: the file is not readable media (as opposed to
      // ffprobe missing, crashing on a signal or timing out, which says nothing about the file).
      ffprobeUnreadable = Number.isInteger(err.exitCode) && err.exitCode !== 0;
    }
  }
  const extra = ffprobeError ? { ffprobeError, ...(ffprobeUnreadable ? { ffprobeUnreadable } : {}) } : {};
  if (sniffed?.type === 'mp4' || sniffed?.type === 'mov') {
    try {
      const parsed = parseMp4(await readMp4Header(path, info.size));
      if (parsed.hasMoov) {
        const bitrateKbps = parsed.durationS ? Math.round((info.size * 8) / parsed.durationS / 1000) : null;
        const { container, durationS, width, height, videoCodec, audioCodec, audioTracks, subtitleTracks, fragmented, rotation, codedWidth, codedHeight } = parsed;
        const turned = codedWidth ? { codedWidth, codedHeight } : {};
        return { ...base, container: container || sniffed.type, durationS, width, height, rotation: rotation || 0, ...turned, videoCodec, audioCodec, audioTracks, subtitleTracks, bitrateKbps, fragmented, source: 'mp4-parser', ...extra };
      }
      return { ...base, source: 'basic', error: 'No movie header (moov) was found.', ...extra };
    } catch (err) {
      return { ...base, source: 'basic', error: `MP4 parse failed: ${err.message}`, ...extra };
    }
  }
  if (sniffed?.kind === 'image') {
    const dims = imageSize(head);
    return { ...base, width: dims?.width ?? null, height: dims?.height ?? null, source: 'basic', ...extra };
  }
  return { ...base, source: 'basic', ...extra };
}

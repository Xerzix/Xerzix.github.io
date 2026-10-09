import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  classifyText, ffprobeRotation, imageSize, inspectTsSegment, normalizeLang, parseH264Sps, parseMp4, probeFile, redactPaths, sniffType, unescapeRbsp,
} from '../../server/services/media/probe.js';

// ── Minimal ISO-BMFF builder ──
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, version, ...parts) => box(type, Buffer.from([version, 0, 0, 0]), ...parts);
const lang = (code) => ((code.charCodeAt(0) - 0x60) << 10) | ((code.charCodeAt(1) - 0x60) << 5) | (code.charCodeAt(2) - 0x60);

const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
/** tkhd display matrix for a clockwise rotation (0, 90, 180 or 270 degrees). */
function matrix(deg) {
  const r = (deg * Math.PI) / 180;
  const a = Math.round(Math.cos(r)) * 65536;
  const b = Math.round(Math.sin(r)) * 65536;
  return Buffer.concat([i32(a), i32(b), u32(0), i32(-b), i32(a), u32(0), u32(0), u32(0), u32(0x40000000)]);
}
function tkhd(w, h, rotation = null) {
  return full('tkhd', 0, u32(0), u32(0), u32(1), u32(0), u32(0), Buffer.alloc(16), rotation === null ? Buffer.alloc(36) : matrix(rotation), u32(w * 65536), u32(h * 65536));
}
function trak({ handler, entry, w = 0, h = 0, language = 'und', timescale = 1000, duration = 0, v1 = false, rotation = null }) {
  const mdhd = v1
    ? full('mdhd', 1, Buffer.alloc(8), Buffer.alloc(8), u32(timescale), Buffer.from([0, 0, 0, 0, ...u32(duration)]), u16(lang(language)), u16(0))
    : full('mdhd', 0, u32(0), u32(0), u32(timescale), u32(duration), u16(lang(language)), u16(0));
  const hdlr = full('hdlr', 0, u32(0), Buffer.from(handler), Buffer.alloc(12), Buffer.from('h\0'));
  return box('trak', tkhd(w, h, rotation), box('mdia', mdhd, hdlr, box('minf', box('stbl', full('stsd', 0, u32(1), entry)))));
}
const videoEntry = (fourcc, w, h) => box(fourcc, Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(w), u16(h), Buffer.alloc(50));
function aacEntry(channelConfig) {
  // AudioSpecificConfig: AAC-LC (2), 48 kHz (index 3), channel configuration.
  const asc = [(2 << 3) | (3 >> 1), ((3 & 1) << 7) | (channelConfig << 3)];
  const dsi = [0x05, asc.length, ...asc];
  const dcd = [0x04, 13 + dsi.length, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...dsi];
  const es = [0x03, 3 + dcd.length, 0, 1, 0, ...dcd];
  return box('mp4a', Buffer.alloc(6), u16(1), Buffer.alloc(8), u16(2), u16(16), u16(0), u16(0), u32(48000 * 65536), full('esds', 0, Buffer.from(es)));
}
function movie({ brand = 'isom', moovLast = false, v1 = false } = {}) {
  const moov = box('moov',
    v1 ? full('mvhd', 1, Buffer.alloc(16), u32(600), Buffer.from([0, 0, 0, 0, ...u32(600 * 95)]), Buffer.alloc(80))
      : full('mvhd', 0, u32(0), u32(0), u32(1000), u32(95_500), Buffer.alloc(80)),
    trak({ handler: 'vide', entry: videoEntry('avc1', 1920, 1080), w: 1920, h: 1080, language: 'und', duration: 95_500 }),
    trak({ handler: 'soun', entry: aacEntry(6), language: 'jpn', timescale: 48000, duration: 48000 * 95, v1 }),
    trak({ handler: 'soun', entry: aacEntry(2), language: 'eng', timescale: 48000, duration: 48000 * 95 }),
    trak({ handler: 'sbtl', entry: box('tx3g', Buffer.alloc(40)), language: 'fra' }));
  const ftyp = box('ftyp', Buffer.from(brand), u32(0), Buffer.from(brand), Buffer.from('mp41'));
  const mdat = box('mdat', Buffer.alloc(4096, 7));
  return moovLast ? Buffer.concat([ftyp, mdat, moov]) : Buffer.concat([ftyp, moov, mdat]);
}

test('sniffType identifies files by content, not by name', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
  assert.equal(sniffType(png).type, 'png');
  assert.equal(sniffType(png).mime, 'image/png');
  assert.equal(sniffType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16])).type, 'jpeg');
  assert.equal(sniffType(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 ', 'latin1')).type, 'webp');
  assert.equal(sniffType(Buffer.from('%PDF-1.7\n')).type, 'pdf');
  assert.equal(sniffType(Buffer.from('%PDX-1.7\n')).type, 'text');
  const ebml = (doc) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0x82, 0x84]), Buffer.from(doc)]);
  assert.equal(sniffType(ebml('webm')).type, 'webm');
  assert.equal(sniffType(ebml('matroska')).type, 'mkv');
  assert.equal(sniffType(movie()).type, 'mp4');
  assert.equal(sniffType(movie({ brand: 'qt  ' })).type, 'mov');
  assert.equal(sniffType(Buffer.concat([box('wide', Buffer.alloc(0)), box('mdat', Buffer.alloc(10))])).type, 'mov');
  const ts = Buffer.alloc(188 * 4, 0xff);
  for (let i = 0; i < 4; i++) ts[i * 188] = 0x47;
  assert.equal(sniffType(ts).type, 'ts');
  const m2ts = Buffer.alloc(192 * 4, 0xff);
  for (let i = 0; i < 4; i++) m2ts[i * 192 + 4] = 0x47;
  assert.equal(sniffType(m2ts).type, 'ts');
  ts[376] = 0;
  assert.notEqual(sniffType(ts)?.type, 'ts', 'a broken sync pattern is not a transport stream');
  assert.equal(sniffType(Buffer.from('﻿WEBVTT - Title\n\n00:01.000 --> 00:02.000\nHi')).type, 'vtt');
  assert.equal(sniffType(Buffer.from('WEBVTTX\n')).type, 'text');
  assert.equal(sniffType(Buffer.from('1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\n')).type, 'srt');
  assert.equal(sniffType(Buffer.from('Just some notes about the film.')).type, 'text');
  // A prefix cut in the middle of a multi-byte character is still text.
  assert.equal(sniffType(Buffer.from('こんにちは').subarray(0, 7)).type, 'text');
  assert.equal(sniffType(Buffer.from([0x00, 0x01, 0x02, 0xfe, 0xff, 0x00, 0x10])), null);
  assert.equal(sniffType(Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1')), null, 'executables are unknown binary');
  assert.equal(sniffType(new Uint8Array(Buffer.from('%PDF-1.4'))).type, 'pdf', 'accepts Uint8Array');
  assert.equal(classifyText('WEBVTT'), 'vtt');
});

test('parseMp4 reads duration, dimensions, codecs, languages and channels', () => {
  const info = parseMp4(movie());
  assert.equal(info.container, 'mp4');
  assert.equal(info.brand, 'isom');
  assert.equal(info.durationS, 95.5);
  assert.equal(info.width, 1920);
  assert.equal(info.height, 1080);
  assert.equal(info.videoCodec, 'h264');
  assert.equal(info.audioCodec, 'aac');
  assert.deepEqual(info.audioTracks, [{ lang: 'ja', channels: 6, codec: 'aac' }, { lang: 'en', channels: 2, codec: 'aac' }]);
  assert.deepEqual(info.subtitleTracks, [{ lang: 'fr', codec: 'mov_text' }]);
  assert.equal(parseMp4(movie({ brand: 'qt  ' })).container, 'mov');
  const v1 = parseMp4(movie({ v1: true }));
  assert.equal(v1.durationS, 95, 'version-1 mvhd');
  assert.equal(v1.audioTracks[0].lang, 'ja', 'version-1 mdhd');
  // moov after mdat, and a truncated buffer, are both handled.
  assert.equal(parseMp4(movie({ moovLast: true })).height, 1080);
  const truncated = parseMp4(movie({ moovLast: true }).subarray(0, 2000));
  assert.equal(truncated.hasMoov, false);
  assert.equal(truncated.videoCodec, null);
  const hevc = Buffer.concat([box('ftyp', Buffer.from('isom'), u32(0)), box('moov', trak({ handler: 'vide', entry: videoEntry('hvc1', 3840, 2160), w: 3840, h: 2160 }))]);
  assert.deepEqual([parseMp4(hevc).videoCodec, parseMp4(hevc).width, parseMp4(hevc).height], ['hevc', 3840, 2160]);
  assert.equal(parseMp4(Buffer.from('not an mp4 at all')).container, null);
});

test('probeFile uses the MP4 parser without ffprobe, and falls back when ffprobe fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-probe-'));
  try {
    const file = join(dir, 'movie.mp4');
    writeFileSync(file, movie({ moovLast: true }));
    const p = await probeFile(file);
    assert.equal(p.source, 'mp4-parser');
    assert.equal(p.container, 'mp4');
    assert.deepEqual([p.width, p.height, p.durationS, p.videoCodec], [1920, 1080, 95.5, 'h264']);
    assert.equal(p.audioTracks.length, 2);
    assert.ok(p.bitrateKbps >= 0);
    const broken = await probeFile(file, { ffprobePath: join(dir, 'no-such-ffprobe') });
    assert.equal(broken.source, 'mp4-parser');
    assert.ok(broken.ffprobeError);
    const mkv = join(dir, 'movie.mkv');
    writeFileSync(mkv, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x82, 0x88]), Buffer.from('matroska'), Buffer.alloc(100)]));
    assert.deepEqual(await probeFile(mkv).then((r) => [r.container, r.source]), ['mkv', 'basic']);
    const png = join(dir, 'poster.png');
    writeFileSync(png, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(640), u32(960), Buffer.alloc(8)]));
    assert.deepEqual(await probeFile(png).then((r) => [r.container, r.width, r.height]), ['png', 640, 960]);
    if (process.env.FFPROBE_PATH) {
      const real = await probeFile(file, { ffprobePath: process.env.FFPROBE_PATH });
      assert.ok(['ffprobe', 'mp4-parser'].includes(real.source));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('imageSize reads PNG, JPEG and WebP headers', () => {
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), u32(13), Buffer.from('IHDR'), u32(2000), u32(3000), Buffer.alloc(8)]);
  assert.deepEqual(imageSize(png), { width: 2000, height: 3000 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03, 0x01, 0x22, 0x00]);
  assert.deepEqual(imageSize(jpeg), { width: 1280, height: 720 });
  const webp = Buffer.concat([Buffer.from('RIFF'), u32(0), Buffer.from('WEBPVP8X'), u32(10), Buffer.from([0, 0, 0, 0]), Buffer.from([0x7f, 0x07, 0x00, 0x37, 0x04, 0x00])]);
  assert.deepEqual(imageSize(webp), { width: 1920, height: 1080 });
  assert.equal(imageSize(Buffer.from('nope')), null);
});

// SPS NAL units produced by libx264 (High profile) for the HLS ladder.
const SPS_720 = Buffer.from('67640028acd9405005bb011000000300100000030320f1831960', 'hex');
const SPS_480 = Buffer.from('6764001facd940d83de6fff050005011000003000100000300320f183196', 'hex');

test('parseH264Sps returns profile, level, RFC 6381 codecs and the cropped size', () => {
  assert.deepEqual(parseH264Sps(SPS_720), { profileIdc: 100, constraintFlags: 0, levelIdc: 40, width: 1280, height: 720, codecs: 'avc1.640028' });
  const s480 = parseH264Sps(SPS_480);
  assert.deepEqual([s480.width, s480.height, s480.codecs], [854, 480, 'avc1.64001f']);
  assert.throws(() => parseH264Sps(Buffer.from([0x68, 0xee])), /Not an SPS/);
  assert.deepEqual([...unescapeRbsp(Buffer.from([0, 0, 3, 1, 0, 0, 3, 0]))], [0, 0, 1, 0, 0, 0]);
});

test('inspectTsSegment finds the SPS inside transport stream packets', () => {
  const packet = (pid, payload, start) => {
    const p = Buffer.alloc(188, 0xff);
    p[0] = 0x47;
    p[1] = (start ? 0x40 : 0) | (pid >> 8);
    p[2] = pid & 0xff;
    p[3] = 0x10;
    payload.copy(p, 4, 0, Math.min(payload.length, 184));
    return p;
  };
  const pes = Buffer.concat([Buffer.from([0, 0, 1, 0xe0, 0, 0, 0x80, 0x80, 5, 0x21, 0, 1, 0, 1]), Buffer.from([0, 0, 0, 1, 9, 0xf0]), Buffer.from([0, 0, 0, 1]), SPS_480]);
  const seg = Buffer.concat([packet(0, Buffer.from([0, 0, 0xb0]), true), packet(0x100, pes.subarray(0, 20), true), packet(0x100, pes.subarray(20), false)]);
  const info = inspectTsSegment(seg);
  assert.equal(info.packets, 3);
  assert.deepEqual([info.sps.width, info.sps.height, info.sps.codecs], [854, 480, 'avc1.64001f']);
  assert.throws(() => inspectTsSegment(Buffer.from('hello')), /MPEG-TS/);
});

test('normalizeLang maps ISO 639-2 to 639-1 and keeps unknowns honest', () => {
  assert.equal(normalizeLang('eng'), 'en');
  assert.equal(normalizeLang('JPN'), 'ja');
  assert.equal(normalizeLang('ger'), 'de');
  assert.equal(normalizeLang('en-GB'), 'en-gb');
  assert.equal(normalizeLang(''), 'und');
  assert.equal(normalizeLang(undefined), 'und');
  assert.equal(normalizeLang('und'), 'und');
  assert.equal(normalizeLang('haw'), 'haw');
  assert.equal(normalizeLang('12'), 'und');
});

test('rotated phone video reports the displayed size (MP4 matrix and ffprobe side data)', () => {
  const clip = (rotation) => Buffer.concat([
    box('ftyp', Buffer.from('isom'), u32(0)),
    box('moov', full('mvhd', 0, u32(0), u32(0), u32(1000), u32(2000), Buffer.alloc(80)),
      trak({ handler: 'vide', entry: videoEntry('avc1', 1280, 720), w: 1280, h: 720, duration: 2000, rotation })),
  ]);
  for (const deg of [90, 270]) {
    const info = parseMp4(clip(deg));
    assert.deepEqual([info.width, info.height, info.rotation, info.codedWidth, info.codedHeight], [720, 1280, deg, 1280, 720], `${deg}°`);
  }
  for (const deg of [0, 180]) {
    const info = parseMp4(clip(deg));
    assert.deepEqual([info.width, info.height, info.rotation], [1280, 720, deg], `${deg}°`);
    assert.equal(info.codedWidth, undefined);
  }
  assert.equal(parseMp4(clip(null)).rotation, 0, 'an all-zero matrix is treated as upright');
  // ffprobe: the display matrix is counter-clockwise; the legacy rotate tag is clockwise.
  assert.equal(ffprobeRotation({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }] }), 90);
  assert.equal(ffprobeRotation({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 90 }] }), 270);
  assert.equal(ffprobeRotation({ side_data_list: [{ side_data_type: 'Display Matrix', rotation: 180 }] }), 180);
  assert.equal(ffprobeRotation({ tags: { rotate: '90' } }), 90);
  assert.equal(ffprobeRotation({}), 0);
});

test('redactPaths keeps server paths out of messages shown to creators', () => {
  const input = '/srv/lumina/var/storage/uploads/upl_abc.part';
  assert.equal(
    redactPaths(`ffprobe failed (exit 1): ${input}: Invalid data found when processing input`, [[input, 'the file']]),
    'ffprobe failed (exit 1): the file: Invalid data found when processing input',
  );
  assert.equal(redactPaths('spawn /opt/tools/bin/ffprobe ENOENT', [['/opt/tools/bin/ffprobe', 'ffprobe']]), 'spawn ffprobe ENOENT');
  assert.equal(redactPaths('could not open /var/lib/other/thing.mkv here'), 'could not open … here');
  assert.equal(redactPaths('exit 1: Invalid data'), 'exit 1: Invalid data');
});

const FFPROBE = process.env.FFPROBE_PATH || (spawnSync('ffprobe', ['-version'], { stdio: 'ignore' }).status === 0 ? 'ffprobe' : '');
test('probeFile flags files ffprobe cannot read, without leaking their path', { skip: !FFPROBE && 'ffprobe not available (set FFPROBE_PATH)' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-probe-'));
  try {
    const junk = join(dir, 'upl_junk.part');
    writeFileSync(junk, Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), randomBytes(50_000)]));
    const p = await probeFile(junk, { ffprobePath: FFPROBE });
    assert.equal(p.source, 'basic');
    assert.equal(p.ffprobeUnreadable, true);
    assert.ok(p.ffprobeError);
    assert.equal(p.ffprobeError.includes(dir), false);
    // A missing ffprobe says nothing about the file: not flagged as unreadable.
    const missing = await probeFile(junk, { ffprobePath: join(dir, 'no-such-ffprobe') });
    assert.equal(missing.ffprobeUnreadable, undefined);
    assert.equal(missing.ffprobeError.includes(dir), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

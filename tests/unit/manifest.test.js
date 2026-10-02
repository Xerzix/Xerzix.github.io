import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  fetchLimited, isBrowserPlayableMp4, manifestToMediaFields, parseAttributes, parseHlsManifest, summarizeProbe, verifyMedia,
} from '../../server/services/admin/media-verify.js';

const MASTER = `#EXTM3U
#EXT-X-VERSION:6
#EXT-X-INDEPENDENT-SEGMENTS

#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="2",URI="audio/en/prog.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="ja",NAME="日本語",DEFAULT=NO,AUTOSELECT=YES,CHANNELS="2",URI="audio/ja/prog.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ec3",LANGUAGE="en",NAME="English",DEFAULT=YES,CHANNELS="16/JOC",URI="audio/en-atmos/prog.m3u8"
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="en",NAME="English (Audio description)",CHARACTERISTICS="public.accessibility.describes-video",URI="audio/ad/prog.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="subs/en.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="es-ES",NAME="Español",FORCED=NO,URI="subs/es.m3u8"
#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="en",NAME="English SDH",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound",URI="subs/en-sdh.m3u8"
#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",LANGUAGE="en",NAME="English CC",INSTREAM-ID="CC1"

#EXT-X-STREAM-INF:BANDWIDTH=15000000,AVERAGE-BANDWIDTH=12000000,RESOLUTION=3840x2160,CODECS="hvc1.2.4.L153.B0,mp4a.40.2",FRAME-RATE=24.000,VIDEO-RANGE=PQ,AUDIO="aac",SUBTITLES="subs",CLOSED-CAPTIONS="cc"
2160p/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",FRAME-RATE=24,VIDEO-RANGE=SDR,AUDIO="aac",SUBTITLES="subs"
1080p/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6400000,RESOLUTION=1920x1080,CODECS="avc1.640028,ec-3",AUDIO="ec3",SUBTITLES="subs"
1080p-atmos/prog.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="aac",SUBTITLES="subs"
720p/prog.m3u8
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=300000,RESOLUTION=1920x1080,CODECS="avc1.640028",URI="1080p/iframes.m3u8"
`;

const MEDIA_PLAYLIST = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:6.000,
seg0.ts
#EXTINF:6.000,
seg1.ts
#EXTINF:3.5,
seg2.ts
#EXT-X-ENDLIST
`;

test('parseAttributes keeps quoted commas and unquoted values', () => {
  const a = parseAttributes('BANDWIDTH=1280000,CODECS="avc1.4d401f,mp4a.40.2",RESOLUTION=1280x720,NAME="A, B"');
  assert.deepEqual(a, { BANDWIDTH: '1280000', CODECS: 'avc1.4d401f,mp4a.40.2', RESOLUTION: '1280x720', NAME: 'A, B' });
});

test('parses a master playlist: renditions, codecs, HDR and I-frame lines', () => {
  const p = parseHlsManifest(MASTER);
  assert.equal(p.type, 'master');
  assert.equal(p.variants.length, 4, 'I-frame playlists are not renditions');
  assert.equal(p.iFramePlaylists, 1);
  assert.deepEqual(p.resolutions, [2160, 1080, 720]);
  assert.deepEqual(p.variants[0].codecs, ['hvc1.2.4.L153.B0', 'mp4a.40.2']);
  assert.equal(p.variants[0].width, 3840);
  assert.equal(p.variants[0].bandwidth, 15000000);
  assert.equal(p.variants[0].averageBandwidth, 12000000);
  assert.equal(p.variants[0].frameRate, 24);
  assert.equal(p.variants[0].audioGroup, 'aac');
  assert.equal(p.variants[0].uri, '2160p/prog.m3u8');
  assert.deepEqual(p.videoCodecs.sort(), ['H.264', 'HEVC']);
  assert.deepEqual(p.audioCodecs.sort(), ['AAC', 'Dolby Digital Plus']);
  assert.equal(p.hdr, 'HDR10');
  assert.equal(p.videoRangeDeclared, true);
  assert.equal(p.durationS, null);
});

test('parses audio and subtitle groups with languages, names and defaults', () => {
  const p = parseHlsManifest(MASTER);
  assert.equal(p.audio.length, 4);
  assert.deepEqual(p.audio.map((a) => a.lang), ['en', 'ja', 'en', 'en']);
  assert.equal(p.audio[0].default, true);
  assert.equal(p.audio[1].default, false);
  assert.equal(p.audio[1].name, '日本語');
  assert.equal(p.audio[2].channels, '16/JOC');
  assert.deepEqual(p.audio[3].characteristics, ['public.accessibility.describes-video']);
  assert.equal(p.subtitles.length, 3);
  assert.equal(p.subtitles[1].lang, 'es-ES');
  assert.equal(p.subtitles[0].default, true);
  assert.equal(p.closedCaptions.length, 1);
  assert.equal(p.closedCaptions[0].instreamId, 'CC1');
  assert.ok(p.audioLayouts.includes('Stereo'));
  assert.ok(p.audioLayouts.includes('Dolby Atmos'));
});

test('maps declared tracks onto Lumina media fields (deduplicated across groups)', () => {
  const f = manifestToMediaFields(parseHlsManifest(MASTER), (l) => `lang:${l}`);
  assert.deepEqual(f.resolutions, [2160, 1080, 720]);
  assert.deepEqual(f.audioTracks, [
    { lang: 'en', label: 'English', kind: 'main', default: true },
    { lang: 'ja', label: '日本語', kind: 'main', default: false },
    { lang: 'en', label: 'English (Audio description)', kind: 'description', default: false },
  ]);
  const subs = f.subtitleTracks.map((s) => [s.lang, s.label, s.kind, s.inManifest]);
  assert.deepEqual(subs, [
    ['en', 'English', 'subtitles', true],
    ['es-ES', 'Español', 'subtitles', true],
    ['en', 'English SDH', 'captions', true],
    ['en', 'English CC', 'captions', true],
  ]);
  assert.equal(f.subtitleTracks[0].src, null);
  assert.equal(f.hdr, 'HDR10');
  assert.ok(f.audioFormats.includes('Dolby Digital Plus'));
});

test('no audio or subtitle declarations → tracks are left untouched', () => {
  const text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1280x720\nmid.m3u8\n';
  const p = parseHlsManifest(text);
  const f = manifestToMediaFields(p);
  assert.deepEqual(f.resolutions, [720, 360]);
  assert.equal(f.audioTracks, undefined);
  assert.equal(f.subtitleTracks, undefined);
  assert.equal(f.audioFormats, undefined);
  assert.equal(f.hdr, undefined, 'HDR is not claimed or cleared when the manifest does not declare VIDEO-RANGE');
});

test('media playlists report duration; live playlists are flagged', () => {
  const p = parseHlsManifest(MEDIA_PLAYLIST);
  assert.equal(p.type, 'media');
  assert.equal(p.segments, 3);
  assert.equal(p.durationS, 15.5);
  assert.equal(p.endList, true);
  assert.equal(p.targetDuration, 6);
  assert.deepEqual(p.resolutions, []);
  const live = parseHlsManifest(MEDIA_PLAYLIST.replace('#EXT-X-ENDLIST\n', ''));
  assert.equal(live.endList, false);
});

test('handles CRLF line endings, BOM and Dolby Vision codecs', () => {
  const text = '﻿#EXTM3U\r\n#EXT-X-STREAM-INF:BANDWIDTH=9000000,RESOLUTION=3840x2160,CODECS="dvh1.05.06,ec-3"\r\ndv.m3u8\r\n';
  const p = parseHlsManifest(text);
  assert.deepEqual(p.resolutions, [2160]);
  assert.equal(p.hdr, 'Dolby Vision');
  assert.equal(p.variants[0].uri, 'dv.m3u8');
});

test('rejects files that are not playlists', () => {
  assert.throws(() => parseHlsManifest('<html>nope</html>'), { code: 'NOT_HLS' });
  assert.throws(() => parseHlsManifest(''), { code: 'NOT_HLS' });
  assert.throws(() => parseHlsManifest(undefined), { code: 'NOT_HLS' });
});

test('verifyMedia reads a local master playlist and its first rendition for the duration', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-verify-'));
  try {
    mkdirSync(join(dir, 'media', 'x', '720p'), { recursive: true });
    mkdirSync(join(dir, 'media', 'x', '2160p'), { recursive: true });
    writeFileSync(join(dir, 'media', 'x', 'master.m3u8'), MASTER);
    writeFileSync(join(dir, 'media', 'x', '2160p', 'prog.m3u8'), MEDIA_PLAYLIST);
    const env = { root: dir, storageRoot: join(dir, 'storage'), allowedOrigins: [] };
    const r = await verifyMedia({ kind: 'hls', source: 'media/x/master.m3u8', variants: '[]' }, env);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual(r.fields.resolutions, [2160, 1080, 720]);
    assert.equal(r.fields.durationS, 15.5);
    assert.match(r.message, /3 renditions/);

    const missing = await verifyMedia({ kind: 'hls', source: 'media/none/master.m3u8', variants: '[]' }, env);
    assert.equal(missing.ok, false);
    assert.equal(missing.report.code, 'NOT_FOUND');
    assert.equal(missing.fields, null);

    const escape = await verifyMedia({ kind: 'hls', source: 'server/config.js', variants: '[]' }, env);
    assert.equal(escape.ok, false);
    assert.equal(escape.report.code, 'BAD_SOURCE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verifyMedia refuses remote progressive files and origins outside the allowlist', async () => {
  const env = { root: tmpdir(), storageRoot: tmpdir(), allowedOrigins: ['https://allowed.example'] };
  const remote = await verifyMedia({ kind: 'progressive', source: 'https://allowed.example/film.mp4', variants: '[]' }, env);
  assert.equal(remote.ok, false);
  assert.equal(remote.report.code, 'REMOTE_PROGRESSIVE');
  let called = false;
  const blocked = await verifyMedia({ kind: 'hls', source: 'https://evil.example/x.m3u8', variants: '[]' }, { ...env, fetchImpl: () => { called = true; } });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.report.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(called, false, 'nothing is fetched from origins outside MEDIA_ORIGINS');
  const noProbe = await verifyMedia({ kind: 'progressive', source: 'media/film.mp4', variants: '[]' }, { ...env, loadProbe: async () => null });
  assert.equal(noProbe.report.code, 'PROBE_UNAVAILABLE');
});

test('fetchLimited follows redirects only within the allowlist and caps the size', async () => {
  const responses = {
    'https://a.example/m.m3u8': new Response(null, { status: 302, headers: { location: 'https://b.example/m.m3u8' } }),
  };
  const fake = async (url) => responses[url] || new Response('#EXTM3U\n');
  await assert.rejects(fetchLimited('https://a.example/m.m3u8', { allowedOrigins: ['https://a.example'], fetchImpl: fake }), { code: 'ORIGIN_NOT_ALLOWED' });
  const big = async () => new Response('x'.repeat(3 * 1024 * 1024));
  await assert.rejects(fetchLimited('https://a.example/big.m3u8', { allowedOrigins: ['https://a.example'], fetchImpl: big }), { code: 'TOO_LARGE' });
  const ok = await fetchLimited('https://a.example/ok.m3u8', { allowedOrigins: ['https://a.example'], fetchImpl: async () => new Response('#EXTM3U\n') });
  assert.equal(ok.text, '#EXTM3U\n');
});

test('probe summaries accept ffprobe-style and flat shapes', () => {
  const ff = summarizeProbe({ format: { format_name: 'mov,mp4,m4a', duration: '596.4' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } }] });
  assert.equal(ff.height, 1080);
  assert.equal(ff.videoCodec, 'h264');
  assert.equal(ff.audioCodec, 'aac');
  assert.equal(ff.durationS, 596.4);
  assert.equal(isBrowserPlayableMp4({ format: { format_name: 'mov,mp4,m4a' }, streams: [{ codec_type: 'video', codec_name: 'h264' }, { codec_type: 'audio', codec_name: 'aac' }] }), true);
  assert.equal(isBrowserPlayableMp4({ container: 'matroska', videoCodec: 'hevc' }, 'video/x-matroska'), false);
  assert.equal(isBrowserPlayableMp4({ videoCodec: 'h264', audioCodec: 'aac' }, 'video/mp4'), true);
  assert.equal(summarizeProbe(null), null);
});

test('real ffmpeg 7 ladders in media/originals parse and verify (skipped when not generated)', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const root = join(import.meta.dirname, '..', '..');
  const master = join(root, 'media', 'originals', 'hanami', 'master.m3u8');
  if (!existsSync(master)) return t.skip('media/originals not generated (npm run media:sample)');
  const p = parseHlsManifest(readFileSync(master, 'utf8'));
  assert.equal(p.type, 'master');
  assert.ok(p.resolutions.length >= 2);
  assert.deepEqual(p.resolutions, [...p.resolutions].sort((a, b) => b - a));
  const f = manifestToMediaFields(p);
  // ffmpeg names renditions "audio_0"; the label falls back to the language (zxx = no dialogue).
  assert.equal(f.audioTracks[0].label, 'No dialogue');
  assert.equal(f.subtitleTracks, undefined, 'side-loaded WebVTT tracks are not declared in the manifest');
  const r = await verifyMedia({ kind: 'hls', source: 'media/originals/hanami/master.m3u8', variants: '[]' }, { root, storageRoot: tmpdir(), allowedOrigins: [] });
  assert.equal(r.ok, true, r.message);
  assert.ok(r.fields.durationS > 0);
  assert.equal(r.report.audio[0].name, 'audio_0', 'the report keeps the raw manifest NAME');
  assert.equal(r.report.audio[0].label, 'No dialogue', 'and shows the label viewers will see');
});

// ───────────── scripts/verify-media.mjs (npm run media:verify) ─────────────

test('verify-media: collectEntries lists film, trailer and episode media in catalog order', async () => {
  const { collectEntries } = await import('../../scripts/verify-media.mjs');
  const seed = {
    titles: [
      { id: 'film', title: 'Film', media: { kind: 'hls', source: 'media/a/master.m3u8' }, trailer: { kind: 'progressive', source: 'media/a/t.mp4' } },
      { id: 'show', title: 'Show', seasons: [{ number: 1, episodes: [{ id: 'show-s1e1', number: 1, media: { kind: 'hls', source: 'media/b/master.m3u8' } }, { number: 2 }] }] },
    ],
  };
  const entries = collectEntries(seed);
  assert.deepEqual(entries.map((e) => e.id), ['film', 'film#trailer', 'show-s1e1']);
  assert.equal(entries[2].label, 'Show S1 E1');
  assert.equal(entries[1].holder[entries[1].key], seed.titles[0].trailer, 'holder[key] points at the stored object');
});

test('verify-media: planSeedUpdate never marks a failed check verified; --strict withdraws an old claim', async () => {
  const { planSeedUpdate } = await import('../../scripts/verify-media.mjs');
  const failed = { ok: false, message: 'HTTP 403', fields: null, report: { ok: false, code: 'HTTP_ERROR' } };
  const fresh = { kind: 'hls', source: 'https://x.example/m.m3u8', resolutions: [] };
  const a = planSeedUpdate(fresh, failed);
  assert.equal(a.media.verified, undefined);
  assert.deepEqual(a.changes, []);
  assert.notEqual(a.media, fresh, 'the input object is never mutated');

  const earlier = { kind: 'hls', source: 'media/x/master.m3u8', resolutions: [1080], verified: true, verifiedAt: '2026-01-01T00:00:00.000Z' };
  assert.deepEqual(planSeedUpdate(earlier, failed).media, earlier, 'without --strict an earlier verification is kept as it was');
  const strict = planSeedUpdate(earlier, failed, { strict: true });
  assert.equal(strict.media.verified, false);
  assert.equal(strict.media.verifiedAt, undefined);
  assert.deepEqual(strict.media.resolutions, []);
  assert.deepEqual(strict.changes.sort(), ['resolutions', 'verified']);
});

test('verify-media: planSeedUpdate stores only what the manifest declares and keeps side-loaded subtitles', async () => {
  const { planSeedUpdate, describe: describeResult } = await import('../../scripts/verify-media.mjs');
  const parsed = parseHlsManifest(MASTER);
  const fields = { ...manifestToMediaFields(parsed), durationS: 15.5 };
  const result = { ok: true, message: 'Verified', fields, report: { renditions: parsed.variants.map((v) => ({ codecs: v.codecs })) } };
  const media = {
    kind: 'hls',
    source: 'media/x/master.m3u8',
    resolutions: [],
    audioFormats: ['AAC'],
    subtitleTracks: [{ lang: 'fr', label: 'Français', kind: 'subtitles', src: 'media/x/fr.vtt' }, { lang: 'en', label: 'Old', kind: 'subtitles', src: null, inManifest: true }],
  };
  const plan = planSeedUpdate(media, result, { now: '2026-10-02T00:00:00.000Z' });
  assert.equal(plan.media.verified, true);
  assert.equal(plan.media.verifiedAt, '2026-10-02T00:00:00.000Z');
  assert.deepEqual(plan.media.resolutions, [2160, 1080, 720]);
  assert.deepEqual(plan.media.videoCodecs, ['hvc1.2.4.L153.B0', 'avc1.640028', 'avc1.64001f'], 'raw CODECS strings, video only');
  assert.equal(plan.media.hdr, 'HDR10');
  assert.equal(plan.media.durationS, 15.5);
  assert.deepEqual(plan.media.audioFormats, ['AAC'], 'curated audio formats are not overwritten');
  assert.equal(plan.media.subtitleTracks[0].src, 'media/x/fr.vtt', 'side-loaded WebVTT stays first');
  assert.ok(!plan.media.subtitleTracks.some((t) => t.label === 'Old'), 'manifest-declared tracks are replaced');
  assert.ok(plan.media.subtitleTracks.slice(1).every((t) => t.inManifest && !('src' in t)));
  assert.ok(plan.changes.includes('resolutions') && plan.changes.includes('verified') && !plan.changes.includes('verifiedAt'));
  assert.match(describeResult(result), /^2160p \(4K\), 1080p, 720p · 3 audio · 4 subtitles in manifest · 16 s · HDR10$/, 'the English track repeated per audio group counts once');
});

test('verify-media: main() reads same-site manifests from disk, never fetches other origins, and --write records only what it read', async (t) => {
  const { existsSync, readFileSync } = await import('node:fs');
  const root = join(import.meta.dirname, '..', '..');
  if (!existsSync(join(root, 'media', 'originals', 'hanami', 'master.m3u8'))) return t.skip('media/originals not generated (npm run media:sample)');
  const { main } = await import('../../scripts/verify-media.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'lumina-seed-'));
  const file = join(dir, 'catalog.seed.json');
  const seed = {
    titles: [
      { id: 'hanami', title: 'Hanami', media: { kind: 'hls', source: 'media/originals/hanami/master.m3u8', resolutions: [] } },
      { id: 'elsewhere', title: 'Elsewhere', media: { kind: 'hls', source: 'https://not-in-media-origins.example/m.m3u8', resolutions: [] } },
      { id: 'stale', title: 'Stale', media: { kind: 'hls', source: 'media/originals/missing/master.m3u8', resolutions: [1080], verified: true, verifiedAt: '2026-01-01T00:00:00.000Z' } },
      { id: 'file', title: 'File', media: { kind: 'progressive', source: 'media/file.mp4' } },
    ],
  };
  writeFileSync(file, JSON.stringify(seed));
  const lines = [];
  t.mock.method(console, 'log', (...args) => lines.push(args.join(' ')));
  const fetchMock = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('verify-media must not fetch an origin outside MEDIA_ORIGINS');
  });
  try {
    assert.equal(await main(['--seed', file]), 1, 'failures make the exit code non-zero');
    assert.equal(readFileSync(file, 'utf8'), JSON.stringify(seed), 'a dry run writes nothing');
    const out = lines.join('\n');
    assert.match(out, /OK\s+hanami\s.*2160p \(4K\)/);
    assert.match(out, /FAILED\s+elsewhere\s.*ORIGIN_NOT_ALLOWED/);
    assert.match(out, /FAILED\s+stale\s.*NOT_FOUND.*keeping the earlier verification/);
    assert.match(out, /SKIPPED\s+file\s/);
    assert.match(out, /Summary: 1 OK, 2 failed, 1 skipped\. Nothing was written/);

    await main(['--seed', file, '--write']);
    const written = JSON.parse(readFileSync(file, 'utf8')).titles;
    assert.equal(written[0].media.verified, true);
    assert.equal(written[0].media.resolutions[0], 2160);
    assert.ok(written[0].media.verifiedAt);
    assert.equal(written[1].media.verified, undefined, 'an unreadable manifest is never marked verified');
    assert.deepEqual(written[1].media.resolutions, []);
    assert.equal(written[2].media.verified, true, 'without --strict a failing entry keeps its earlier state');
    assert.deepEqual(written[3].media, seed.titles[3].media);

    await main(['--seed', file, '--write', '--strict', '--only', 'stale']);
    const strict = JSON.parse(readFileSync(file, 'utf8')).titles;
    assert.equal(strict[2].media.verified, false);
    assert.deepEqual(strict[2].media.resolutions, []);
    assert.equal(strict[0].media.verified, true, '--only leaves other entries alone');
    assert.equal(fetchMock.mock.callCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  audioBitrate, buildHlsArgs, displayRotation, h264Level, inspectWithFfmpeg, parseMasterPlaylist, parseMediaPlaylist, planLadder, transcodeToHls,
} from '../../server/services/media/transcoder.js';
import { inspectTsSegment } from '../../server/services/media/probe.js';

process.env.NODE_ENV = 'test';
// The integration tests run whenever ffmpeg is available: FFMPEG_PATH, or `ffmpeg` on PATH.
const onPath = (cmd) => (spawnSync(cmd, ['-version'], { stdio: 'ignore' }).status === 0 ? cmd : '');
const FFMPEG = process.env.FFMPEG_PATH || onPath('ffmpeg');
const noFfmpeg = !FFMPEG && 'ffmpeg not available (set FFMPEG_PATH)';

test('planLadder never upscales and always keeps the source rung', () => {
  const heights = (w, h) => planLadder({ width: w, height: h }).map((r) => r.height);
  assert.deepEqual(heights(1280, 720), [720, 480, 360]);
  assert.deepEqual(heights(1920, 1080), [1080, 720, 480, 360]);
  assert.deepEqual(heights(3840, 2160), [2160, 1440, 1080, 720, 480, 360]);
  assert.deepEqual(heights(1920, 1000), [720, 480, 360], 'a 1000-line source is not stretched to 1080');
  assert.deepEqual(heights(426, 240), [240], 'sources below 360 keep their own height');
  assert.deepEqual(heights(401, 301), [300]);
  for (const [w, h] of [[1280, 720], [1998, 1080], [720, 576], [1440, 1080], [3840, 1600]]) {
    for (const r of planLadder({ width: w, height: h })) {
      assert.ok(r.height <= h && r.width <= w, `${r.width}x${r.height} fits ${w}x${h}`);
      assert.equal(r.width % 2, 0);
      assert.equal(r.height % 2, 0);
      assert.ok(r.videoKbps > 0 && r.audioKbps > 0);
    }
  }
  const hd = planLadder({ width: 1920, height: 1080 });
  assert.deepEqual(hd.map((r) => r.width), [1920, 1280, 854, 640]);
  assert.ok(hd[0].videoKbps > hd[1].videoKbps && hd[1].videoKbps > hd[2].videoKbps);
  assert.equal(planLadder({ height: 1080 })[0].width, 1920, 'assumes 16:9 without a width');
  assert.throws(() => planLadder({ width: 100 }), /height/);
});

test('h264Level picks the smallest level that fits (5.1 for 2160p30)', () => {
  assert.equal(h264Level({ width: 3840, height: 2160, fps: 30, maxKbps: 17_120 }), '5.1');
  assert.equal(h264Level({ width: 3840, height: 2160, fps: 60 }), '5.2');
  assert.equal(h264Level({ width: 1920, height: 1080, fps: 30, maxKbps: 5_350 }), '4.0');
  assert.equal(h264Level({ width: 1920, height: 1080, fps: 60 }), '4.2');
  assert.equal(h264Level({ width: 1280, height: 720, fps: 25 }), '3.1');
  assert.equal(h264Level({ width: 640, height: 360, fps: 30 }), '3.0');
});

test('parseMasterPlaylist handles quoted attributes with commas', () => {
  const text = [
    '#EXTM3U',
    '#EXT-X-VERSION:6',
    '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",LANGUAGE="ja",NAME="日本語",DEFAULT=YES,URI="audio/ja.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=5400000,AVERAGE-BANDWIDTH=4900000,RESOLUTION=1920x1080,FRAME-RATE=23.976,CODECS="avc1.640028,mp4a.40.2",AUDIO="aud"',
    '1080p/index.m3u8',
    '',
    '#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.64001e,mp4a.40.2"',
    '360p/index.m3u8?token=a,b',
  ].join('\r\n');
  const m = parseMasterPlaylist(text);
  assert.equal(m.version, 6);
  assert.equal(m.independentSegments, true);
  assert.equal(m.media[0].NAME, '日本語');
  assert.equal(m.media[0].URI, 'audio/ja.m3u8');
  assert.deepEqual(m.variants[0], { uri: '1080p/index.m3u8', bandwidth: 5_400_000, averageBandwidth: 4_900_000, width: 1920, height: 1080, codecs: 'avc1.640028,mp4a.40.2', frameRate: 23.976, audio: 'aud' });
  assert.deepEqual([m.variants[1].height, m.variants[1].averageBandwidth, m.variants[1].uri], [360, null, '360p/index.m3u8?token=a,b']);
  assert.throws(() => parseMasterPlaylist('#EXT-X-VERSION:3'), /EXTM3U/);
  assert.equal(parseMasterPlaylist('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\n').variants.length, 0, 'a variant without a URI is not counted');
});

test('parseMediaPlaylist lists segments and the end marker', () => {
  const p = parseMediaPlaylist('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:4.000000,\nseg_00000.ts\n#EXTINF:1.5,\nseg_00001.ts\n#EXT-X-ENDLIST\n');
  assert.deepEqual(p, { targetDuration: 4, playlistType: 'VOD', endList: true, segments: [{ uri: 'seg_00000.ts', duration: 4 }, { uri: 'seg_00001.ts', duration: 1.5 }] });
});

test('ffmpeg arguments align keyframes and map every rung', () => {
  const ladder = planLadder({ width: 1920, height: 1080 });
  const args = buildHlsArgs({ input: 'in.mp4', outDir: '/out', ladder, fps: 25, segmentSeconds: 4, hasAudio: true });
  const after = (flag) => args[args.indexOf(flag) + 1];
  assert.equal(after('-g'), '100');
  assert.equal(after('-keyint_min'), '100');
  assert.equal(after('-sc_threshold'), '0');
  assert.equal(after('-profile:v'), 'high');
  // Every rung refers to one audio group; the audio is encoded once, as its own rendition.
  assert.equal(after('-var_stream_map'), 'v:0,agroup:aud,name:v0 v:1,agroup:aud,name:v1 v:2,agroup:aud,name:v2 v:3,agroup:aud,name:v3 a:0,agroup:aud,name:audio');
  assert.equal(after('-hls_playlist_type'), 'vod');
  assert.equal(after('-hls_segment_type'), 'mpegts');
  assert.equal(after('-ac'), '2');
  assert.equal(after('-b:a:0'), '128k');
  assert.ok(!args.includes('-b:a:1'));
  // The height is fixed and the width follows the decoded picture, so the aspect ratio is kept
  // (a rotated phone clip is decoded upright and must not be squeezed into a landscape box).
  assert.equal(after('-filter:v:0'), 'scale=-2:1080:flags=bicubic,setsar=1');
  assert.equal(after('-filter:v:3'), 'scale=-2:360:flags=bicubic,setsar=1');
  assert.equal(args.filter((a) => a === '0:a:0').length, 1);
  assert.equal(args.filter((a) => a === '0:v:0').length, 4);
  assert.equal(after('-hls_segment_filename'), '/out/%v/seg_%05d.ts');
  assert.equal(args.at(-1), '/out/%v/index.m3u8');
  const uhd = buildHlsArgs({ input: 'in.mp4', outDir: '/out', ladder: planLadder({ width: 3840, height: 2160 }), fps: 24, segmentSeconds: 4, hasAudio: false });
  assert.equal(uhd[uhd.indexOf('-level:v:0') + 1], '5.1');
  assert.equal(uhd[uhd.indexOf('-var_stream_map') + 1], 'v:0,name:v0 v:1,name:v1 v:2,name:v2 v:3,name:v3 v:4,name:v4 v:5,name:v5');
  assert.ok(!uhd.includes('0:a:0') && !uhd.includes('-c:a'));
  assert.equal(audioBitrate(planLadder({ width: 3840, height: 2160 })), 192, 'the shared audio uses the richest rung rate');
  assert.equal(audioBitrate(planLadder({ width: 640, height: 360 })), 96);
  assert.ok(buildHlsArgs({ input: 'x', outDir: '/o', ladder: ladder.slice(0, 1), fps: null, segmentSeconds: 6, hasAudio: false }).includes('expr:gte(t,n_forced*6)'));
});

test('transcoding requires ffmpeg and says so', async () => {
  await assert.rejects(transcodeToHls({ input: 'x', outDir: 'y', ffmpegPath: '' }), /requires ffmpeg on the host \(FFMPEG_PATH\)/);
});

function makeSource(dir, { size = '1280x720', audio = true, seconds = 2, name = 'src.mp4', lang = null } = {}) {
  const out = join(dir, name);
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=25`];
  if (audio) args.push('-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000');
  args.push('-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p');
  if (audio) args.push('-c:a', 'aac', '-shortest');
  if (audio && lang) args.push('-metadata:s:a:0', `language=${lang}`);
  args.push(out);
  execFileSync(FFMPEG, args);
  return out;
}

test('transcodes a 2 s 720p source into a verified 720p/480p/360p ladder without upscaling', { skip: noFfmpeg, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-hls-'));
  try {
    const input = makeSource(dir);
    const progress = [];
    const result = await transcodeToHls({ input, outDir: join(dir, 'hls'), ffmpegPath: FFMPEG, segmentSeconds: 1, audioLanguage: 'ja', onProgress: (p) => progress.push(p) });
    assert.deepEqual(result.renditions.map((r) => r.height), [720, 480, 360]);
    assert.ok(result.renditions.every((r) => r.height <= 720), 'no upscaled rung');
    assert.deepEqual(result.renditions.map((r) => r.width), [1280, 854, 640]);
    assert.ok(result.renditions.every((r) => /^avc1\.64[0-9a-f]{4},mp4a\.40\.2$/.test(r.codecs)));
    assert.ok(result.renditions[0].bandwidth > result.renditions[2].bandwidth);
    assert.ok(Math.abs(result.durationS - 2) < 0.2);
    assert.equal(result.hasAudio, true);
    assert.ok(progress.length > 0 && progress.at(-1).ratio === 1);

    const master = readFileSync(result.masterPath, 'utf8');
    const parsed = parseMasterPlaylist(master);
    assert.equal(parsed.variants.length, 3);
    // One audio group, declared once, with the language only because the caller supplied it.
    assert.equal(parsed.media.length, 1);
    assert.deepEqual(
      [parsed.media[0].TYPE, parsed.media[0]['GROUP-ID'], parsed.media[0].LANGUAGE, parsed.media[0].NAME, parsed.media[0].CHANNELS, parsed.media[0].URI],
      ['AUDIO', 'aud', 'ja', 'Japanese', '2', 'audio/index.m3u8'],
    );
    assert.deepEqual([result.audio.playlist, result.audio.language, result.audio.channels, result.audio.codecs], ['audio/index.m3u8', 'ja', 2, 'mp4a.40.2']);
    for (const v of parsed.variants) {
      assert.ok(v.bandwidth && v.width && v.height && v.codecs, 'RESOLUTION, BANDWIDTH and CODECS present');
      assert.equal(v.audio, 'aud');
      assert.ok(v.bandwidth > result.audio.bandwidth, 'BANDWIDTH includes the audio rendition');
      const media = parseMediaPlaylist(readFileSync(join(dir, 'hls', v.uri), 'utf8'));
      assert.equal(media.endList, true);
      assert.equal(media.playlistType, 'VOD');
      assert.ok(media.segments.length >= 1);
      for (const s of media.segments) assert.ok(existsSync(join(dir, 'hls', v.uri, '..', s.uri)));
      // The resolution in the master is what the encoded stream really contains.
      const { sps } = inspectTsSegment(readFileSync(join(dir, 'hls', v.uri, '..', media.segments[0].uri)));
      assert.deepEqual([sps.width, sps.height], [v.width, v.height]);
    }
    const audioPl = parseMediaPlaylist(readFileSync(join(dir, 'hls', 'audio', 'index.m3u8'), 'utf8'));
    assert.ok(audioPl.endList && audioPl.segments.length >= 1);
    assert.deepEqual(readdirSync(join(dir, 'hls')).sort(), ['360p', '480p', '720p', 'audio', 'master.m3u8']);

    // Asking for rungs above the source is refused rather than upscaled.
    const capped = await transcodeToHls({ input, outDir: join(dir, 'capped'), ffmpegPath: FFMPEG, ladder: planLadder({ width: 1920, height: 1080 }), audio: false });
    assert.deepEqual(capped.renditions.map((r) => r.height), [720, 480, 360]);
    assert.ok(capped.renditions.every((r) => !r.codecs.includes('mp4a')));
    assert.equal(capped.audio, null);
    assert.doesNotMatch(readFileSync(capped.masterPath, 'utf8'), /EXT-X-MEDIA|AUDIO=/);

    // Without a known language the audio rendition is named honestly and carries no LANGUAGE.
    const unnamed = await transcodeToHls({ input, outDir: join(dir, 'unnamed'), ffmpegPath: FFMPEG, ladder: planLadder({ width: 640, height: 360 }) });
    const um = parseMasterPlaylist(readFileSync(unnamed.masterPath, 'utf8')).media[0];
    assert.equal(um.NAME, 'Original audio');
    assert.equal(um.LANGUAGE, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sources without audio produce video-only renditions', { skip: noFfmpeg, timeout: 60_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-hls-'));
  try {
    const input = makeSource(dir, { size: '640x360', audio: false, name: 'silent.mov' });
    const r = await transcodeToHls({ input, outDir: join(dir, 'out'), ffmpegPath: FFMPEG });
    assert.equal(r.hasAudio, false);
    assert.deepEqual(r.renditions.map((x) => [x.height, x.codecs.includes('mp4a')]), [[360, false]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function workerHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-worker-'));
  const { config } = await import('../../server/config.js');
  config.storageDir = join(dir, 'storage');
  const { openDatabase } = await import('../../server/db/index.js');
  const { enqueueTranscode, jobStatus } = await import('../../server/services/media/queue.js');
  const { startWorker, FFMPEG_REQUIRED } = await import('../../server/services/media/worker.js');
  const db = openDatabase(join(dir, 'w.db'));
  const ts = new Date().toISOString();
  db.run(`INSERT INTO media (id, title_id, role, kind, source, status, created_at, updated_at) VALUES ('med_test', NULL, 'main', 'progressive', 'storage:incoming/src.mp4', 'ready', ?, ?)`, ts, ts);
  let invalidated = 0;
  const services = { catalog: { invalidate: () => invalidated++ } };
  return { dir, config, db, enqueueTranscode, jobStatus, startWorker, FFMPEG_REQUIRED, services, invalidations: () => invalidated };
}

test('queue + worker: without ffmpeg the job fails with an explanation', async () => {
  const h = await workerHarness();
  const worker = h.startWorker(h.db, h.services, { ffmpegPath: '', intervalMs: 60_000 });
  try {
    const q = h.enqueueTranscode(h.db, { mediaId: 'med_test', sourceKey: 'storage:incoming/src.mp4' });
    assert.equal(q.status, 'queued');
    assert.equal(h.enqueueTranscode(h.db, { mediaId: 'med_test', sourceKey: 'incoming/src.mp4' }).jobId, q.jobId, 'no duplicate job');
    assert.equal(h.db.get(`SELECT status FROM media WHERE id = 'med_test'`).status, 'processing');
    assert.throws(() => h.enqueueTranscode(h.db, { mediaId: 'med_test', sourceKey: '../../etc/passwd' }));
    assert.throws(() => h.enqueueTranscode(h.db, { mediaId: 'med_missing', sourceKey: 'a/b.mp4' }), /Unknown media/);
    await worker.runOnce();
    const job = h.jobStatus(h.db, 'med_test');
    assert.equal(job.status, 'failed');
    assert.equal(job.error, h.FFMPEG_REQUIRED);
    assert.equal(h.db.get(`SELECT status FROM media WHERE id = 'med_test'`).status, 'failed');
    assert.equal(await worker.runOnce(), null, 'idle when the queue is empty');
  } finally {
    await worker.stop();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('queue + worker: a transcode publishes verified renditions to the media row', { skip: noFfmpeg, timeout: 120_000 }, async () => {
  const h = await workerHarness();
  const worker = h.startWorker(h.db, h.services, { ffmpegPath: FFMPEG, intervalMs: 60_000 });
  try {
    const { mkdirSync, copyFileSync } = await import('node:fs');
    mkdirSync(join(h.config.storageDir, 'incoming'), { recursive: true });
    copyFileSync(makeSource(h.dir, { size: '854x480' }), join(h.config.storageDir, 'incoming', 'src.mp4'));
    h.enqueueTranscode(h.db, { mediaId: 'med_test', sourceKey: 'incoming/src.mp4' });
    await worker.runOnce();
    const job = h.jobStatus(h.db, 'med_test');
    assert.equal(job.status, 'done', job.error);
    assert.equal(job.progress, 1);
    const media = h.db.get(`SELECT * FROM media WHERE id = 'med_test'`);
    assert.equal(media.status, 'ready');
    assert.equal(media.kind, 'hls');
    assert.equal(media.source, 'storage:media/med_test/master.m3u8');
    assert.deepEqual(JSON.parse(media.resolutions), [480, 360]);
    assert.deepEqual(JSON.parse(media.video_codecs), ['H.264']);
    assert.deepEqual(JSON.parse(media.audio_formats), ['AAC', 'Stereo']);
    assert.deepEqual(JSON.parse(media.audio_tracks), [], 'the test source declares no language, so none is claimed');
    assert.ok(media.verified_at);
    assert.ok(Math.abs(media.duration_s - 2) < 0.2);
    assert.ok(existsSync(join(h.config.storageDir, 'media', 'med_test', 'master.m3u8')));
    assert.ok(existsSync(join(h.config.storageDir, 'media', 'med_test', '480p', 'index.m3u8')));
    assert.ok(existsSync(join(h.config.storageDir, 'media', 'med_test', 'audio', 'index.m3u8')));
    assert.ok(!readdirSync(join(h.config.storageDir, 'media')).some((d) => d.includes('.tmp-')), 'no temporary output left behind');
    assert.ok(h.invalidations() >= 1, 'catalog cache invalidated');

    // A source whose audio states its language: the rendition and the media row declare it.
    copyFileSync(makeSource(h.dir, { size: '640x360', lang: 'jpn', name: 'ja.mp4' }), join(h.config.storageDir, 'incoming', 'ja.mp4'));
    h.enqueueTranscode(h.db, { mediaId: 'med_test', sourceKey: 'incoming/ja.mp4' });
    await worker.runOnce();
    assert.equal(h.jobStatus(h.db, 'med_test').status, 'done');
    const again = h.db.get(`SELECT * FROM media WHERE id = 'med_test'`);
    assert.deepEqual(JSON.parse(again.resolutions), [360]);
    assert.deepEqual(JSON.parse(again.audio_tracks), [{ lang: 'ja', label: 'Japanese', kind: 'main', default: true }]);
    const master = parseMasterPlaylist(readFileSync(join(h.config.storageDir, 'media', 'med_test', 'master.m3u8'), 'utf8'));
    assert.equal(master.media[0].LANGUAGE, 'ja');
    assert.ok(!existsSync(join(h.config.storageDir, 'media', 'med_test', '480p')), 'the previous ladder was replaced');
  } finally {
    await worker.stop();
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  }
});

test('displayRotation reads the display matrix and the legacy rotate tag as clockwise turns', () => {
  assert.equal(displayRotation('      Side data:\n        displaymatrix: rotation of -90.00 degrees\n'), 90);
  assert.equal(displayRotation('      Side data:\n        displaymatrix: rotation of 90.00 degrees\n'), 270);
  assert.equal(displayRotation('    Metadata:\n      rotate          : 90\n'), 90);
  assert.equal(displayRotation('    Metadata:\n      handler_name    : VideoHandler\n'), 0);
});

test('a rotated phone clip is planned and encoded upright, never squashed', { skip: noFfmpeg, timeout: 120_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-rot-'));
  try {
    const flat = makeSource(dir, { size: '640x360', audio: false, seconds: 1, name: 'flat.mp4' });
    const rotated = join(dir, 'rotated.mp4');
    // Same frames, plus a display matrix saying "turn a quarter" (what phones record for portrait).
    execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-display_rotation', '90', '-i', flat, '-c', 'copy', rotated]);
    const src = await inspectWithFfmpeg(FFMPEG, rotated);
    assert.deepEqual([src.width, src.height, src.rotation], [360, 640, 270]);
    const result = await transcodeToHls({ input: rotated, outDir: join(dir, 'hls'), ffmpegPath: FFMPEG, segmentSeconds: 1 });
    assert.deepEqual(result.renditions.map((r) => r.height), [480, 360]);
    for (const r of result.renditions) {
      assert.ok(r.width < r.height, `${r.width}x${r.height} is portrait`);
      assert.ok(Math.abs(r.width / r.height - 360 / 640) < 0.02, `${r.width}x${r.height} keeps the 9:16 aspect ratio`);
    }
    const master = parseMasterPlaylist(readFileSync(result.masterPath, 'utf8'));
    assert.deepEqual(master.variants.map((v) => `${v.width}x${v.height}`), result.renditions.map((r) => `${r.width}x${r.height}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

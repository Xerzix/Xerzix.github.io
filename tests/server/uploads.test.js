import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { startTestServer } from '../helpers/server.js';

// ffmpeg-backed tests run whenever ffmpeg is available (FFMPEG_PATH or on PATH) and skip otherwise.
const FFMPEG = process.env.FFMPEG_PATH || (spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0 ? 'ffmpeg' : '');

let t;
let config;
before(async () => {
  t = await startTestServer();
  ({ config } = await import('../../server/config.js'));
  config.uploads.chunkMaxBytes = 64 * 1024; // small chunks so the protocol is exercised
});
after(async () => { await t.close(); });

// ── A tiny but structurally valid MP4 (ftyp + moov with one H.264 video track + mdat) ──
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, ...parts) => box(type, Buffer.from([0, 0, 0, 0]), ...parts);
function fakeMp4(payloadBytes = 150_000) {
  const tkhd = full('tkhd', u32(0), u32(0), u32(1), u32(0), u32(2000), Buffer.alloc(16), Buffer.alloc(36), u32(1280 << 16), u32(720 << 16));
  const mdhd = full('mdhd', u32(0), u32(0), u32(1000), u32(2000), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('VideoHandler\0'));
  const avc1 = box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(1280), u16(720), Buffer.alloc(50));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', full('stsd', u32(1), avc1)))));
  const moov = box('moov', full('mvhd', u32(0), u32(0), u32(1000), u32(2000), Buffer.alloc(80)), trak);
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomavc1')), moov, box('mdat', randomBytes(payloadBytes))]);
}
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  u32(13), Buffer.from('IHDR'), u32(1200), u32(1800), Buffer.from([8, 6, 0, 0, 0]), u32(0),
  u32(0), Buffer.from('IEND'), u32(0xae426082),
]);

async function creatorWithDraft() {
  const c = await t.userClient({ isCreator: true });
  const r = await c.post('/api/creators/submissions', { projectTitle: 'Upload test', contentType: 'short', description: 'A short film used to test uploads.' });
  return { c, sub: r.body.submission };
}

async function sendAll(c, id, data, chunk = 50_000) {
  let offset = 0;
  let res;
  while (offset < data.length) {
    const part = data.subarray(offset, offset + chunk);
    res = await c.request('PATCH', `/api/uploads/${id}`, part, { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) } });
    if (res.status !== 204) return res;
    assert.equal(Number(res.headers.get('upload-offset')), offset + part.length);
    offset += part.length;
  }
  return res;
}

const storageFiles = (dir) => {
  const root = join(config.storageDir, dir);
  return existsSync(root) ? readdirSync(root, { recursive: true }).map(String) : [];
};

test('happy path: chunked upload, validated by content, attached to the submission', async () => {
  const { c, sub } = await creatorWithDraft();
  const data = fakeMp4();
  const created = await c.post('/api/uploads', { filename: '../../Moss & Stone (final).MP4', size: data.length, mime: 'video/mp4', purpose: 'submission', submissionId: sub.id, role: 'feature' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  assert.equal(created.body.offset, 0);
  assert.equal(created.body.chunkSize, 64 * 1024);
  assert.equal((await c.get(`/api/creators/submissions/${sub.id}`)).body.submission.status, 'uploading');

  const id = created.body.id;
  // First half, then check HEAD and GET report the stored offset.
  const half = 100_000;
  await sendAll(c, id, data.subarray(0, half));
  const head = await c.request('HEAD', `/api/uploads/${id}`);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('upload-offset'), String(half));
  assert.equal(head.headers.get('upload-length'), String(data.length));
  const st = await c.get(`/api/uploads/${id}`);
  assert.deepEqual([st.body.offset, st.body.size, st.body.status], [half, data.length, 'in_progress']);

  // Resume from the server's offset.
  let offset = half;
  while (offset < data.length) {
    const part = data.subarray(offset, offset + 60_000);
    const r = await c.request('PATCH', `/api/uploads/${id}`, part, { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) } });
    assert.equal(r.status, 204, JSON.stringify(r.body));
    offset += part.length;
  }
  const done = await c.get(`/api/uploads/${id}`);
  assert.equal(done.body.status, 'complete');
  assert.match(done.body.fileId, /^sfl_/);

  const detail = await c.get(`/api/creators/submissions/${sub.id}`);
  assert.equal(detail.body.submission.status, 'draft', 'back to draft when nothing is uploading');
  const [file] = detail.body.files;
  assert.equal(file.role, 'feature');
  assert.equal(file.mime, 'video/mp4');
  assert.equal(file.sizeBytes, data.length);
  assert.equal(file.sha256, createHash('sha256').update(data).digest('hex'));
  assert.equal(file.scanStatus, 'not_configured');
  assert.equal(file.probe.width, 1280);
  assert.equal(file.probe.height, 720);
  assert.equal(file.probe.videoCodec, 'h264');
  assert.equal(file.probe.durationS, 2);
  assert.equal(file.originalName, '../../Moss & Stone (final).MP4');
  const row = t.db.get('SELECT storage_key FROM submission_files WHERE id = ?', file.id);
  assert.match(row.storage_key, new RegExp(`^submissions/${sub.id}/sfl_[0-9a-z]+-Moss-Stone-final\\.mp4$`));
  assert.ok(existsSync(join(config.storageDir, row.storage_key)));
  assert.ok(!storageFiles('uploads').includes(`${id}.part`), 'no partial file left behind');
  assert.ok(detail.body.events.some((e) => e.kind === 'file' && /Uploaded/.test(e.message)));

  // A completed upload cannot be written to or aborted.
  const more = await c.request('PATCH', `/api/uploads/${id}`, Buffer.from('x'), { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(data.length) } });
  assert.equal(more.status, 409);
  assert.equal((await c.del(`/api/uploads/${id}`)).body.error.code, 'UPLOAD_COMPLETE');

  // The same bytes again (under another name) are refused instead of attached twice.
  const again = await c.post('/api/uploads', { filename: 'copy.mp4', size: data.length, purpose: 'submission', submissionId: sub.id, role: 'trailer' });
  const dup = await sendAll(c, again.body.id, data);
  assert.equal(dup.status, 422);
  assert.equal(dup.body.error.code, 'DUPLICATE_FILE');
  assert.match(dup.body.error.message, /already attached .*Moss & Stone/);
  assert.equal((await c.get(`/api/creators/submissions/${sub.id}`)).body.files.length, 1);
  assert.ok(!storageFiles('uploads').includes(`${again.body.id}.part`));
});

test('an interrupted final check is run again by an empty PATCH at the final offset', async () => {
  const { c, sub } = await creatorWithDraft();
  const data = fakeMp4(40_000);
  const { body } = await c.post('/api/uploads', { filename: 'cut.mp4', size: data.length, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  const cut = data.length - 1_000;
  await sendAll(c, body.id, data.subarray(0, cut));
  // Simulate a server that stored the last bytes and then stopped before checking the file.
  appendFileSync(join(config.storageDir, 'uploads', `${body.id}.part`), data.subarray(cut));
  t.db.run('UPDATE uploads SET offset_bytes = ? WHERE id = ?', data.length, body.id);
  assert.equal((await c.get(`/api/uploads/${body.id}`)).body.status, 'processing');
  assert.equal((await c.get(`/api/creators/submissions/${sub.id}`)).body.submission.status, 'uploading');

  const patch = (offset, bytes) => c.request('PATCH', `/api/uploads/${body.id}`, bytes, { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) } });
  assert.equal((await patch(data.length, Buffer.from('x'))).status, 413, 'no bytes past the end');
  assert.equal((await patch(cut, Buffer.alloc(0))).body.error.code, 'OFFSET_MISMATCH');
  const again = await patch(data.length, Buffer.alloc(0));
  assert.equal(again.status, 204, JSON.stringify(again.body));
  assert.equal(again.headers.get('upload-offset'), String(data.length));
  const st = await c.get(`/api/uploads/${body.id}`);
  assert.equal(st.body.status, 'complete');
  const detail = (await c.get(`/api/creators/submissions/${sub.id}`)).body;
  assert.equal(detail.submission.status, 'draft');
  assert.equal(detail.files[0].sha256, createHash('sha256').update(data).digest('hex'), 'hashed from disk after the interruption');
  assert.equal((await patch(data.length, Buffer.alloc(0))).body.error.code, 'UPLOAD_NOT_ACTIVE', 'a finished upload is not checked twice');
});

test('offset mismatch is 409 and reports the server offset', async () => {
  const { c, sub } = await creatorWithDraft();
  const data = fakeMp4(20_000);
  const { body } = await c.post('/api/uploads', { filename: 'a.mp4', size: data.length, purpose: 'submission', submissionId: sub.id, role: 'trailer' });
  await sendAll(c, body.id, data.subarray(0, 10_000));
  const r = await c.request('PATCH', `/api/uploads/${body.id}`, data.subarray(5_000, 8_000), { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '5000' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.error.code, 'OFFSET_MISMATCH');
  assert.equal(r.body.error.offset, 10_000);
  assert.equal(r.headers.get('upload-offset'), '10000');
  const wrongType = await c.request('PATCH', `/api/uploads/${body.id}`, data.subarray(10_000, 11_000), { headers: { 'Content-Type': 'application/octet-stream', 'Upload-Offset': '10000' } });
  assert.equal(wrongType.status, 415);
  const noHeader = await c.request('PATCH', `/api/uploads/${body.id}`, data.subarray(10_000, 11_000), { headers: { 'Content-Type': 'application/offset+octet-stream' } });
  assert.equal(noHeader.status, 400);
  assert.equal((await c.get(`/api/uploads/${body.id}`)).body.offset, 10_000);
});

test('content is checked by magic bytes: a renamed text file is not an MP4', async () => {
  const { c, sub } = await creatorWithDraft();
  const fake = Buffer.from('This is definitely not a video, whatever the file name says.\n'.repeat(50));
  const { body } = await c.post('/api/uploads', { filename: 'movie.mp4', size: fake.length, mime: 'video/mp4', purpose: 'submission', submissionId: sub.id, role: 'feature' });
  const r = await sendAll(c, body.id, fake);
  assert.equal(r.status, 422);
  assert.equal(r.body.error.code, 'UPLOAD_REJECTED');
  const st = await c.get(`/api/uploads/${body.id}`);
  assert.equal(st.body.status, 'rejected');
  assert.match(st.body.error, /not a video file/);
  assert.ok(!storageFiles('uploads').includes(`${body.id}.part`), 'rejected bytes are deleted');
  assert.equal((await c.get(`/api/creators/submissions/${sub.id}`)).body.files.length, 0);

  // A PNG with a .mp4 name is rejected too; an ftyp header without a movie box is not a video.
  const { body: b2 } = await c.post('/api/uploads', { filename: 'movie.mp4', size: PNG.length, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  assert.equal((await sendAll(c, b2.id, PNG)).status, 422);
  const hollow = Buffer.concat([box('ftyp', Buffer.from('isom'), u32(0)), box('mdat', randomBytes(2000))]);
  const { body: b3 } = await c.post('/api/uploads', { filename: 'hollow.mp4', size: hollow.length, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  const r3 = await sendAll(c, b3.id, hollow);
  assert.equal(r3.status, 422);
  assert.match(r3.body.error.message, /video stream/);
});

test('subtitles, posters and documents are validated for their role', async () => {
  const { c, sub } = await creatorWithDraft();
  const upload = async (filename, role, data) => {
    const { body, status } = await c.post('/api/uploads', { filename, size: data.length, purpose: 'submission', submissionId: sub.id, role });
    assert.equal(status, 200, JSON.stringify(body));
    return sendAll(c, body.id, data);
  };
  assert.equal((await upload('en.vtt', 'subtitle', Buffer.from('﻿WEBVTT\n\n00:00.000 --> 00:02.000\nHello\n'))).status, 204);
  assert.equal((await upload('ja.srt', 'subtitle', Buffer.from('1\n00:00:00,000 --> 00:00:02,000\nこんにちは\n'))).status, 204);
  assert.equal((await upload('bad.vtt', 'subtitle', Buffer.from([0x57, 0x45, 0x42, 0x56, 0x54, 0x54, 0x0a, 0xff, 0xfe, 0x00]))).status, 422);
  assert.equal((await upload('notes.vtt', 'subtitle', Buffer.from('just some notes'))).status, 422);
  assert.equal((await upload('poster.png', 'poster', PNG)).status, 204);
  assert.equal((await upload('rights.pdf', 'document', Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n%%EOF\n'))).status, 204);
  assert.equal((await upload('rights.pdf', 'document', PNG)).status, 422);
  const files = (await c.get(`/api/creators/submissions/${sub.id}`)).body.files;
  assert.deepEqual(files.map((f) => f.role).sort(), ['document', 'poster', 'subtitle', 'subtitle']);
  const poster = files.find((f) => f.role === 'poster');
  assert.deepEqual([poster.probe.width, poster.probe.height, poster.mime], [1200, 1800, 'image/png']);
  assert.equal(files.find((f) => f.originalName === 'en.vtt').probe.cues, 1);
});

test('size limits apply per role and per chunk', async () => {
  const { c, sub } = await creatorWithDraft();
  const big = await c.post('/api/uploads', { filename: 'poster.png', size: config.uploads.maxImageBytes + 1, purpose: 'submission', submissionId: sub.id, role: 'poster' });
  assert.equal(big.status, 413);
  assert.equal(big.body.error.code, 'FILE_TOO_LARGE');
  assert.equal((await c.post('/api/uploads', { filename: 'rights.pdf', size: config.uploads.maxDocumentBytes + 1, purpose: 'submission', submissionId: sub.id, role: 'document' })).status, 413);
  assert.equal((await c.post('/api/uploads', { filename: 'subs.vtt', size: 5 * 1024 * 1024 + 1, purpose: 'submission', submissionId: sub.id, role: 'subtitle' })).status, 413);
  assert.equal((await c.post('/api/uploads', { filename: 'film.mp4', size: config.uploads.maxBytes + 1, purpose: 'submission', submissionId: sub.id, role: 'feature' })).status, 413);
  assert.equal((await c.post('/api/uploads', { filename: 'setup.exe', size: 100, purpose: 'submission', submissionId: sub.id, role: 'feature' })).body.error.code, 'UNSUPPORTED_FILE_TYPE');
  assert.equal((await c.post('/api/uploads', { filename: 'x.mp4', size: 0, purpose: 'submission', submissionId: sub.id, role: 'feature' })).status, 422);

  const { body } = await c.post('/api/uploads', { filename: 'film.mp4', size: 200_000, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  const tooBig = await c.request('PATCH', `/api/uploads/${body.id}`, randomBytes(64 * 1024 + 1), { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' } });
  assert.equal(tooBig.status, 413);
  assert.equal(tooBig.body.error.code, 'CHUNK_TOO_LARGE');
  const { body: small } = await c.post('/api/uploads', { filename: 'film.mp4', size: 1000, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  const past = await c.request('PATCH', `/api/uploads/${small.id}`, randomBytes(1001), { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' } });
  assert.equal(past.status, 413);
  assert.equal((await c.get(`/api/uploads/${small.id}`)).body.offset, 0);
});

test('abort removes the partial file and restores the draft status', async () => {
  const { c, sub } = await creatorWithDraft();
  const data = fakeMp4(30_000);
  const { body } = await c.post('/api/uploads', { filename: 'a.mp4', size: data.length, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  await sendAll(c, body.id, data.subarray(0, 20_000));
  assert.ok(storageFiles('uploads').includes(`${body.id}.part`));
  assert.equal((await c.del(`/api/uploads/${body.id}`)).status, 204);
  assert.equal((await c.get(`/api/uploads/${body.id}`)).body.status, 'aborted');
  assert.ok(!storageFiles('uploads').includes(`${body.id}.part`));
  assert.equal((await c.get(`/api/creators/submissions/${sub.id}`)).body.submission.status, 'draft');
  const late = await c.request('PATCH', `/api/uploads/${body.id}`, data.subarray(20_000), { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '20000' } });
  assert.equal(late.status, 409);
  assert.equal(late.body.error.code, 'UPLOAD_NOT_ACTIVE');
});

test('uploads belong to their owner and to editable submissions only', async () => {
  const { c, sub } = await creatorWithDraft();
  const other = await t.userClient({ isCreator: true });
  const member = await t.userClient();
  const { body } = await c.post('/api/uploads', { filename: 'a.mp4', size: 1000, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  assert.equal((await other.get(`/api/uploads/${body.id}`)).status, 404);
  assert.equal((await other.request('HEAD', `/api/uploads/${body.id}`)).status, 404);
  assert.equal((await other.request('PATCH', `/api/uploads/${body.id}`, randomBytes(10), { headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': '0' } })).status, 404);
  assert.equal((await other.del(`/api/uploads/${body.id}`)).status, 404);
  assert.equal((await t.client().get(`/api/uploads/${body.id}`)).status, 401);
  assert.equal((await other.post('/api/uploads', { filename: 'a.mp4', size: 1000, purpose: 'submission', submissionId: sub.id, role: 'feature' })).status, 404);
  assert.equal((await member.post('/api/uploads', { filename: 'a.mp4', size: 1000, purpose: 'submission', submissionId: sub.id, role: 'feature' })).body.error.code, 'CREATOR_REQUIRED');
  t.db.run(`UPDATE submissions SET status = 'under_review' WHERE id = ?`, sub.id);
  assert.equal((await c.post('/api/uploads', { filename: 'b.mp4', size: 1000, purpose: 'submission', submissionId: sub.id, role: 'feature' })).body.error.code, 'SUBMISSION_LOCKED');
});

test('artwork uploads are staff-only and served publicly from /media/art', async () => {
  const member = await t.userClient({ isCreator: true });
  const input = { filename: 'poster.png', size: PNG.length, purpose: 'artwork', role: 'poster' };
  assert.equal((await member.post('/api/uploads', input)).status, 403);
  const notElevated = await t.userClient({ role: 'admin' });
  assert.equal((await notElevated.post('/api/uploads', input)).body.error.code, 'REAUTH_REQUIRED');
  const admin = await t.userClient({ role: 'admin', elevated: true });
  assert.equal((await admin.post('/api/uploads', { ...input, role: 'feature' })).status, 422);
  const { body } = await admin.post('/api/uploads', input);
  assert.equal((await sendAll(admin, body.id, PNG)).status, 204);
  const st = await admin.get(`/api/uploads/${body.id}`);
  assert.equal(st.body.status, 'complete');
  assert.equal(st.body.url, `/media/art/${body.id}.png`);
  assert.deepEqual([st.body.width, st.body.height], [1200, 1800]);
  const img = await fetch(t.base + st.body.url);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.match(img.headers.get('cache-control'), /max-age=31536000/);
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), PNG);
  assert.ok(t.db.get(`SELECT 1 FROM audit_log WHERE action = 'media.artwork_uploaded' AND target_id = ?`, body.id));
  for (const p of ['/media/art/nope.png', '/media/art/..%2F..%2Ftest.db', `/media/art/${body.id}.PNG`, '/media/private/public/art/x.png']) {
    assert.notEqual((await fetch(t.base + p)).status, 200, p);
  }
  // A non-image with an image role is rejected.
  const { body: b2 } = await admin.post('/api/uploads', { ...input, filename: 'x.png', size: 100 });
  assert.equal((await sendAll(admin, b2.id, randomBytes(100))).status, 422);
});

test('the malware scanner decides clean, infected and error', async () => {
  const run = async (exitCode) => {
    config.uploads.scanCommand = `"${process.execPath}" -e "process.exit(${exitCode})"`;
    const { c, sub } = await creatorWithDraft();
    const data = fakeMp4(5_000);
    const { body } = await c.post('/api/uploads', { filename: 'scan.mp4', size: data.length, purpose: 'submission', submissionId: sub.id, role: 'feature' });
    const r = await sendAll(c, body.id, data);
    return { r, c, sub, id: body.id };
  };
  try {
    const clean = await run(0);
    assert.equal(clean.r.status, 204);
    assert.equal((await clean.c.get(`/api/creators/submissions/${clean.sub.id}`)).body.files[0].scanStatus, 'clean');
    const infected = await run(1);
    assert.equal(infected.r.status, 422);
    assert.equal(infected.r.body.error.code, 'UPLOAD_INFECTED');
    assert.equal((await infected.c.get(`/api/creators/submissions/${infected.sub.id}`)).body.files.length, 0);
    assert.ok(t.db.get(`SELECT 1 FROM audit_log WHERE action = 'upload.infected' AND target_id = ?`, infected.id));
    const failed = await run(2);
    assert.equal(failed.r.status, 204);
    assert.equal((await failed.c.get(`/api/creators/submissions/${failed.sub.id}`)).body.files[0].scanStatus, 'error');
  } finally {
    config.uploads.scanCommand = '';
  }
});

test('stale uploads expire and their partial files are deleted', async () => {
  const { c, sub } = await creatorWithDraft();
  const { body } = await c.post('/api/uploads', { filename: 'slow.mp4', size: 50_000, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  await sendAll(c, body.id, randomBytes(10_000));
  t.db.run('UPDATE uploads SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), body.id);
  assert.ok(await t.services.uploads.expireStale() >= 1);
  assert.equal((await c.get(`/api/uploads/${body.id}`)).body.status, 'expired');
  assert.ok(!storageFiles('uploads').includes(`${body.id}.part`));
  assert.equal((await c.get(`/api/creators/submissions/${sub.id}`)).body.submission.status, 'draft');
});

test('a real encoded MP4 is probed (skipped without ffmpeg)', { skip: !FFMPEG && 'ffmpeg not available (set FFMPEG_PATH)' }, async () => {
  const { execFileSync } = await import('node:child_process');
  const src = join(t.dir, 'real.mp4');
  execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440', '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', src]);
  const { readFileSync } = await import('node:fs');
  const data = readFileSync(src);
  const { c, sub } = await creatorWithDraft();
  const { body } = await c.post('/api/uploads', { filename: 'real.mp4', size: data.length, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  assert.equal((await sendAll(c, body.id, data)).status, 204);
  const [file] = (await c.get(`/api/creators/submissions/${sub.id}`)).body.files;
  assert.deepEqual([file.probe.width, file.probe.height, file.probe.videoCodec, file.probe.audioCodec], [640, 360, 'h264', 'aac']);
  assert.ok(Math.abs(file.probe.durationS - 2) < 0.2);
});

// Playback telemetry (server-issued sessions), error logging, quality reports and the public
// quality summary.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer } from '../helpers/server.js';

let t;
let skew = 0; // simulated time since a session was issued
before(async () => {
  t = await startTestServer();
  t.services.telemetry.clock = () => Date.now() + skew;
});
after(async () => { await t.close(); });

const session = (over = {}) => ({
  mediaId: 'med_hanami',
  titleId: 'hanami',
  secondsWatched: 30,
  startupMs: 800,
  rebufferCount: 0,
  rebufferSeconds: 0,
  avgBitrateKbps: 2000,
  maxHeight: 1080,
  droppedFrames: 2,
  bytesEstimate: 5_000_000,
  errorCount: 0,
  ...over,
});

async function open(c, body) {
  const r = await c.post('/api/playback/sessions/open', { mediaId: body.mediaId, titleId: body.titleId, episodeId: body.episodeId });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.sessionId;
}

/** Opens a session, lets `afterS` seconds pass, then reports `body` into it. */
async function report(c, body, { afterS = 600 } = {}) {
  const sessionId = await open(c, body);
  skew += afterS * 1000;
  try {
    const r = await c.post('/api/playback/sessions', { ...body, sessionId });
    return { ...r, sessionId };
  } finally {
    skew -= afterS * 1000;
  }
}

test('playback sessions are issued by the server, upserted by that id and bounded by elapsed time', async () => {
  const c = t.client();
  const body = session({ titleId: 'sintel', mediaId: 'med_sintel' });
  const sessionId = await open(c, body);
  assert.match(sessionId, /^[A-Za-z0-9_-]{16}\.[0-9a-z]+\.[A-Za-z0-9_-]{27}$/);
  skew = 120_000;
  try {
    let r = await c.post('/api/playback/sessions', { ...body, sessionId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    r = await c.post('/api/playback/sessions', { ...body, sessionId, secondsWatched: 45, rebufferCount: 2, rebufferSeconds: 3.5, startupMs: 99_999 });
    assert.equal(r.status, 200);
  } finally {
    skew = 0;
  }
  const rows = t.db.all('SELECT * FROM playback_sessions WHERE id = ?', sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds_watched, 45);
  assert.equal(rows[0].rebuffer_count, 2);
  assert.equal(rows[0].startup_ms, 800, 'startup is measured once and never overwritten');
  assert.equal(rows[0].account_id, null);

  // Right after it was issued, a session cannot claim more watch time, buffering or startup
  // time than has passed, nor more bytes than its watch time and the renditions allow.
  const greedy = await report(c, session({ secondsWatched: 50_000, rebufferSeconds: 90, startupMs: 120_000, bytesEstimate: 1e12, avgBitrateKbps: 10_000_000 }), { afterS: 0 });
  assert.equal(greedy.status, 200);
  const g = t.db.get('SELECT * FROM playback_sessions WHERE id = ?', greedy.sessionId);
  assert.ok(g.seconds_watched <= 16, `watch time bounded by elapsed time, got ${g.seconds_watched}`);
  assert.ok(g.rebuffer_seconds <= 16, `buffering bounded by elapsed time, got ${g.rebuffer_seconds}`);
  assert.ok(g.startup_ms <= 16_000, `startup bounded by elapsed time, got ${g.startup_ms}`);
  assert.equal(g.avg_bitrate_kbps, 80_000, 'bitrate bounded by the highest verified rendition (2160p)');
  assert.ok(g.bytes_estimate <= 80_000 * 125 * (16 + 31), `bytes bounded by watch time, got ${g.bytes_estimate}`);

  // One claimed second of watching cannot add a terabyte to the usage estimate.
  const tiny = await report(c, session({ titleId: 'koyo-autumn-pavilion', mediaId: 'med_koyo-autumn-pavilion', secondsWatched: 1, bytesEstimate: 1e12 }), { afterS: 1 });
  const b = t.db.get('SELECT bytes_estimate FROM playback_sessions WHERE id = ?', tiny.sessionId).bytes_estimate;
  assert.ok(b <= 16_000 * 125 * 33, `1080p ladder: at most ~32 s at 16 Mb/s, got ${b}`);
});

test('playback sessions reject ids the server did not issue, other viewers, other media and expired ids', async () => {
  const u = await t.userClient();
  const body = session();
  const sessionId = await open(u, body);
  assert.equal((await u.post('/api/playback/sessions', { ...body, sessionId })).status, 200);
  assert.equal(t.db.get('SELECT account_id FROM playback_sessions WHERE id = ?', sessionId).account_id, u.accountId);

  const other = await t.userClient();
  const hijack = await other.post('/api/playback/sessions', { ...body, sessionId, secondsWatched: 1 });
  assert.equal(hijack.status, 404);
  assert.equal(hijack.body.error.code, 'SESSION_NOT_FOUND');
  const anon = await t.client().post('/api/playback/sessions', { ...body, sessionId });
  assert.equal(anon.status, 404, 'an account-bound session cannot be reported anonymously');

  // Self-made ids (the old client-generated UUIDs, or a forged signature) are refused.
  for (const forged of [randomUUID(), `${sessionId.slice(0, -4)}AAAA`, `AAAAAAAAAAAAAAAA.${Date.now().toString(36)}.${'A'.repeat(27)}`]) {
    const r = await u.post('/api/playback/sessions', { ...body, sessionId: forged });
    assert.equal(r.status, 404, forged);
    assert.equal(r.body.error.code, 'SESSION_NOT_FOUND');
  }
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM playback_sessions WHERE account_id = ?', u.accountId).n, 1);

  // Issued for other media.
  const wrongMedia = await u.post('/api/playback/sessions', session({ sessionId, mediaId: 'med_koyo-autumn-pavilion', titleId: 'koyo-autumn-pavilion' }));
  assert.equal(wrongMedia.status, 404);
  assert.equal((await u.post('/api/playback/sessions/open', { mediaId: 'med_sintel', titleId: 'hanami' })).status, 404);
  const bad = await u.post('/api/playback/sessions', session({ sessionId: 'x' }));
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.fields.sessionId);

  // Sessions expire 48 hours after they were issued.
  skew = 49 * 3600_000;
  try {
    const expired = await u.post('/api/playback/sessions', { ...body, sessionId });
    assert.equal(expired.status, 404);
  } finally {
    skew = 0;
  }
});

test('opening playback sessions is rate limited', async () => {
  const { limiter } = await import('../../server/lib/security.js');
  process.env.LUMINA_TEST_RATE_LIMITS = '1';
  limiter.reset();
  try {
    const c = t.client();
    let last;
    for (let i = 0; i < 31; i++) last = await c.post('/api/playback/sessions/open', { mediaId: 'med_hanami', titleId: 'hanami' });
    assert.equal(last.status, 429);
  } finally {
    delete process.env.LUMINA_TEST_RATE_LIMITS;
    limiter.reset();
  }
});

test('playback errors are recorded and rate limited', async () => {
  const c = t.client();
  const ok = await c.post('/api/playback/errors', {
    mediaId: 'med_sintel', titleId: 'sintel', code: 'manifestLoadError', message: 'HTTP 404', fatal: true,
    details: { type: 'source_unavailable', httpStatus: 404, secret: 'dropped' },
  });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = t.db.get(`SELECT * FROM playback_errors WHERE code = 'manifestLoadError'`);
  assert.equal(row.fatal, 1);
  assert.deepEqual(JSON.parse(row.details), { type: 'source_unavailable', httpStatus: 404 });
  assert.equal((await c.post('/api/playback/errors', { titleId: 'nope', code: 'x' })).status, 404);
  assert.equal((await c.post('/api/playback/errors', { titleId: 'sintel', code: 'has spaces' })).status, 422);

  const { limiter } = await import('../../server/lib/security.js');
  process.env.LUMINA_TEST_RATE_LIMITS = '1';
  limiter.reset();
  try {
    let last;
    for (let i = 0; i < 21; i++) last = await c.post('/api/playback/errors', { titleId: 'sintel', code: 'networkError', fatal: false });
    assert.equal(last.status, 429);
    assert.equal(last.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(last.headers.get('retry-after')) > 0);
  } finally {
    delete process.env.LUMINA_TEST_RATE_LIMITS;
    limiter.reset();
  }
});

test('quality reports require an account and validate their input', async () => {
  const anon = t.client();
  assert.equal((await anon.post('/api/quality-reports', { titleId: 'hanami', category: 'buffering' })).status, 401);
  const u = await t.userClient();
  const bad = await u.post('/api/quality-reports', { titleId: 'hanami', category: 'made_up' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.fields.category);
  assert.equal((await u.post('/api/quality-reports', { titleId: 'missing-title', category: 'buffering' })).status, 404);
  assert.equal((await u.post('/api/quality-reports', { titleId: 'garden-hours', episodeId: 'nope', category: 'buffering' })).status, 404);
  const good = await u.post('/api/quality-reports', {
    titleId: 'garden-hours', episodeId: 'garden-hours-s1e1', category: 'poor_quality', description: 'Blocky in dark scenes',
    device: 'Chrome 140 on macOS', connectionMbps: 45.5, selectedResolution: 'Auto · 720p',
    diagnostics: { startupMs: 900, rebufferCount: 1, resolution: '1280×720', sneaky: 'dropped' },
  });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  const row = t.db.get('SELECT * FROM quality_reports WHERE id = ?', good.body.report.id);
  assert.equal(row.account_id, u.accountId);
  assert.equal(row.episode_id, 'garden-hours-s1e1');
  assert.equal(row.media_id, 'med_garden-hours-s1e1');
  assert.deepEqual(JSON.parse(row.diagnostics), { startupMs: 900, rebufferCount: 1, resolution: '1280×720' });
  // At most three reports per title per member per day.
  await u.post('/api/quality-reports', { titleId: 'garden-hours', category: 'buffering' });
  await u.post('/api/quality-reports', { titleId: 'garden-hours', category: 'buffering' });
  const capped = await u.post('/api/quality-reports', { titleId: 'garden-hours', category: 'buffering' });
  assert.equal(capped.status, 429);
});

test('quality summary keeps measured and reported data apart, with sufficiency thresholds', async () => {
  const c = t.client();
  const koyo = (over) => session({ titleId: 'koyo-autumn-pavilion', mediaId: 'med_koyo-autumn-pavilion', ...over });
  const empty = await c.get('/api/titles/koyo-autumn-pavilion/quality');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.window, '90d');
  assert.deepEqual(empty.body.measured, { viewers: 0, sessions: 0, threshold: 10, rebufferRatio: null, avgBitrateKbps: null, errorRate: null, medianStartupMs: null, sufficient: false });
  assert.equal(empty.body.reports.sufficient, false);

  // Ten anonymous sessions with hostile numbers are recorded but never published.
  const hostile = { secondsWatched: 0, startupMs: 120_000, rebufferCount: 50, rebufferSeconds: 90, errorCount: 3, avgBitrateKbps: undefined };
  for (let i = 0; i < 10; i++) assert.equal((await report(c, koyo(hostile))).status, 200);
  let s = (await c.get('/api/titles/koyo-autumn-pavilion/quality')).body;
  assert.equal(s.measured.viewers, 0);
  assert.equal(s.measured.sessions, 0);
  assert.equal(s.measured.sufficient, false);

  // One member with twelve hostile sessions is still one member.
  const spammer = await t.userClient();
  for (let i = 0; i < 12; i++) assert.equal((await report(spammer, koyo(hostile))).status, 200);
  s = (await c.get('/api/titles/koyo-autumn-pavilion/quality')).body;
  assert.equal(s.measured.viewers, 1);
  assert.equal(s.measured.sessions, 12);
  assert.equal(s.measured.sufficient, false);
  assert.equal(s.measured.rebufferRatio, null);

  // Eight more members: nine in all, still not enough to publish numbers.
  const members = [];
  for (let i = 1; i <= 9; i++) members.push(await t.userClient());
  const measured = (i) => koyo({ startupMs: i * 100, secondsWatched: 60, rebufferSeconds: i === 1 ? 6 : 0, avgBitrateKbps: 1000, errorCount: i <= 2 ? 1 : 0 });
  for (let i = 1; i <= 8; i++) assert.equal((await report(members[i - 1], measured(i))).status, 200);
  s = (await c.get('/api/titles/koyo-autumn-pavilion/quality')).body;
  assert.equal(s.measured.viewers, 9);
  assert.equal(s.measured.sufficient, false);
  assert.equal(s.measured.rebufferRatio, null);
  // Reports never leak into measured numbers.
  const reporters = [];
  for (let i = 0; i < 4; i++) reporters.push(await t.userClient());
  for (const r of reporters) assert.equal((await r.post('/api/quality-reports', { titleId: 'koyo-autumn-pavilion', category: 'buffering' })).status, 200);
  s = (await c.get('/api/titles/koyo-autumn-pavilion/quality')).body;
  assert.equal(s.measured.viewers, 9);
  assert.equal(s.reports.count, 4);
  assert.equal(s.reports.distinctReporters, 4);
  assert.equal(s.reports.sufficient, false);
  assert.deepEqual(s.reports.categories, [], 'categories are withheld below the threshold');

  // The tenth member and fifth reporter cross the thresholds.
  assert.equal((await report(members[8], measured(9))).status, 200);
  const fifth = await t.userClient();
  await fifth.post('/api/quality-reports', { titleId: 'koyo-autumn-pavilion', category: 'audio_sync' });
  s = (await c.get('/api/titles/koyo-autumn-pavilion/quality')).body;
  assert.equal(s.measured.sufficient, true);
  assert.equal(s.measured.viewers, 10);
  assert.equal(s.measured.sessions, 21);
  // Each member counts once, so the member with twelve hostile sessions moves each figure by
  // at most a tenth: buffering (1 + 6/66 + 0 × 8) / 10, errors (1 + 1 + 1) / 10.
  assert.equal(s.measured.rebufferRatio, Math.round(((1 + 6 / 66) / 10) * 10000) / 10000);
  assert.equal(s.measured.errorRate, 0.3);
  assert.equal(s.measured.avgBitrateKbps, 1000);
  // Median across members of 100…900 ms and the spammer's 120 s.
  assert.equal(s.measured.medianStartupMs, 550);
  assert.equal(s.reports.sufficient, true);
  assert.equal(s.reports.distinctReporters, 5);
  assert.deepEqual(s.reports.categories, [{ category: 'buffering', count: 4 }, { category: 'audio_sync', count: 1 }]);
});

test('quality summary respects parental limits and unknown titles', async () => {
  const kid = await t.userClient({ maxAge: 7 });
  assert.equal((await kid.get('/api/titles/sintel/quality')).status, 403);
  assert.equal((await t.client().get('/api/titles/nope/quality')).status, 404);
});

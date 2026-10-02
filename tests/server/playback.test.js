// Playback telemetry, error logging, quality reports and the public quality summary.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startTestServer } from '../helpers/server.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

const session = (over = {}) => ({
  sessionId: randomUUID(),
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

test('playback sessions are upserted by the client session id and clamped', async () => {
  const c = t.client();
  const body = session({ titleId: 'sintel', mediaId: 'med_sintel' });
  let r = await c.post('/api/playback/sessions', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  r = await c.post('/api/playback/sessions', { ...body, secondsWatched: 45, rebufferCount: 2, rebufferSeconds: 3.5, startupMs: 99_999 });
  assert.equal(r.status, 200);
  const rows = t.db.all('SELECT * FROM playback_sessions WHERE id = ?', body.sessionId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seconds_watched, 45);
  assert.equal(rows[0].rebuffer_count, 2);
  assert.equal(rows[0].startup_ms, 800, 'startup is measured once and never overwritten');
  assert.equal(rows[0].account_id, null);

  // A fresh session cannot claim more watch time than wall-clock time allows.
  const greedy = session({ titleId: 'sintel', mediaId: 'med_sintel', secondsWatched: 50_000 });
  await c.post('/api/playback/sessions', greedy);
  const g = t.db.get('SELECT seconds_watched FROM playback_sessions WHERE id = ?', greedy.sessionId);
  assert.ok(g.seconds_watched <= 91, `clamped to wall clock, got ${g.seconds_watched}`);
});

test('playback sessions attach the account and reject hijacking and mismatched media', async () => {
  const u = await t.userClient();
  const body = session();
  assert.equal((await u.post('/api/playback/sessions', body)).status, 200);
  assert.equal(t.db.get('SELECT account_id FROM playback_sessions WHERE id = ?', body.sessionId).account_id, u.accountId);
  const other = await t.userClient();
  const hijack = await other.post('/api/playback/sessions', { ...body, secondsWatched: 1 });
  assert.equal(hijack.status, 409);
  assert.equal(hijack.body.error.code, 'SESSION_CONFLICT');
  const wrongMedia = await u.post('/api/playback/sessions', session({ mediaId: 'med_sintel' }));
  assert.equal(wrongMedia.status, 404);
  const bad = await u.post('/api/playback/sessions', session({ sessionId: 'x' }));
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.fields.sessionId);
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
  const empty = await c.get('/api/titles/koyo-autumn-pavilion/quality');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.window, '90d');
  assert.deepEqual(empty.body.measured, { sessions: 0, threshold: 10, rebufferRatio: null, avgBitrateKbps: null, errorRate: null, medianStartupMs: null, sufficient: false });
  assert.equal(empty.body.reports.sufficient, false);

  // Nine measured sessions: still not enough to publish numbers.
  for (let i = 1; i <= 9; i++) {
    await c.post('/api/playback/sessions', session({ titleId: 'koyo-autumn-pavilion', mediaId: 'med_koyo-autumn-pavilion', startupMs: i * 100, secondsWatched: 60, rebufferSeconds: i === 1 ? 6 : 0, avgBitrateKbps: 1000, errorCount: i <= 2 ? 1 : 0 }));
  }
  let s = (await c.get('/api/titles/koyo-autumn-pavilion/quality')).body;
  assert.equal(s.measured.sessions, 9);
  assert.equal(s.measured.sufficient, false);
  assert.equal(s.measured.rebufferRatio, null);
  // Reports never leak into measured numbers.
  const reporters = [];
  for (let i = 0; i < 4; i++) reporters.push(await t.userClient());
  for (const r of reporters) assert.equal((await r.post('/api/quality-reports', { titleId: 'koyo-autumn-pavilion', category: 'buffering' })).status, 200);
  s = (await c.get('/api/titles/koyo-autumn-pavilion/quality')).body;
  assert.equal(s.measured.sessions, 9);
  assert.equal(s.reports.count, 4);
  assert.equal(s.reports.distinctReporters, 4);
  assert.equal(s.reports.sufficient, false);
  assert.deepEqual(s.reports.categories, [], 'categories are withheld below the threshold');

  // The tenth session and fifth reporter cross the thresholds.
  await c.post('/api/playback/sessions', session({ titleId: 'koyo-autumn-pavilion', mediaId: 'med_koyo-autumn-pavilion', startupMs: 1000, secondsWatched: 60, avgBitrateKbps: 3000 }));
  const fifth = await t.userClient();
  await fifth.post('/api/quality-reports', { titleId: 'koyo-autumn-pavilion', category: 'audio_sync' });
  s = (await c.get('/api/titles/koyo-autumn-pavilion/quality')).body;
  assert.equal(s.measured.sufficient, true);
  assert.equal(s.measured.sessions, 10);
  assert.equal(s.measured.medianStartupMs, 550);
  assert.equal(s.measured.errorRate, 0.2);
  assert.equal(s.measured.avgBitrateKbps, 1200);
  assert.equal(s.measured.rebufferRatio, Math.round((6 / 606) * 10000) / 10000);
  assert.equal(s.reports.sufficient, true);
  assert.equal(s.reports.distinctReporters, 5);
  assert.deepEqual(s.reports.categories, [{ category: 'buffering', count: 4 }, { category: 'audio_sync', count: 1 }]);
});

test('quality summary respects parental limits and unknown titles', async () => {
  const kid = await t.userClient({ maxAge: 7 });
  assert.equal((await kid.get('/api/titles/sintel/quality')).status, 403);
  assert.equal((await t.client().get('/api/titles/nope/quality')).status, 404);
});

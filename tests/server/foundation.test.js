import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

test('health and anonymous session', async () => {
  const c = t.client();
  assert.equal((await c.get('/api/health')).body.service, 'lumina');
  const s = await c.get('/api/session');
  assert.equal(s.body.mode, 'server');
  assert.equal(s.body.account, null);
});

test('mutations without the CSRF header are rejected', async () => {
  const res = await fetch(`${t.base}/api/library/progress`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'CSRF_REJECTED');
});

test('cross-origin mutations are rejected', async () => {
  const res = await fetch(`${t.base}/api/library/progress`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Lumina-Request': '1', Origin: 'https://evil.example' }, body: '{}' });
  assert.equal(res.status, 403);
});

test('static allowlist hides server code, database and config', async () => {
  for (const p of ['/server/config.js', '/package.json', '/var/lumina.db', '/tests/helpers/server.js', '/.env', '/node_modules/hls.js/package.json']) {
    const res = await fetch(t.base + p);
    assert.equal(res.status, 404, p);
  }
  assert.equal((await fetch(`${t.base}/`)).status, 200);
});

test('security headers are present', async () => {
  const res = await fetch(`${t.base}/api/health`);
  assert.match(res.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
});

test('catalog search is typo tolerant and grounded in the catalog', async () => {
  const c = t.client();
  const r = await c.get('/api/search?q=sintl');
  assert.equal(r.body.items[0].id, 'sintel');
  const none = await c.get('/api/search?q=interstellar');
  assert.equal(none.body.total, 0);
});

test('filters combine', async () => {
  const c = t.client();
  const r = await c.get('/api/search?type=movie&genres=Animation&yearFrom=2008&yearTo=2010');
  assert.deepEqual(r.body.items.map((x) => x.id).sort(), ['big-buck-bunny', 'sintel']);
});

test('library requires a profile and saves resumable progress', async () => {
  const anon = t.client();
  assert.equal((await anon.put('/api/library/watchlist/sintel')).status, 401);
  const u = await t.userClient();
  assert.equal((await u.put('/api/library/watchlist/sintel')).status, 200);
  await u.put('/api/library/progress', { titleId: 'sintel', positionS: 321, durationS: 888, watchedDelta: 10 });
  const pb = await u.get('/api/playback/sintel');
  assert.equal(pb.body.resumeAt, 321);
  const sum = await u.get('/api/library/summary');
  assert.deepEqual(sum.body.watchlistIds, ['sintel']);
});

test('each profile keeps a separate library', async () => {
  const a = await t.userClient();
  const b = await t.userClient();
  await a.put('/api/library/watchlist/hanami');
  assert.deepEqual((await b.get('/api/library/summary')).body.watchlistIds, []);
});

test('parental limits hide titles above the profile maximum', async () => {
  const kid = await t.userClient({ maxAge: 7 });
  const r = await kid.get('/api/search?q=sintel');
  assert.equal(r.body.total, 0);
  assert.equal((await kid.get('/api/titles/sintel')).status, 403);
});

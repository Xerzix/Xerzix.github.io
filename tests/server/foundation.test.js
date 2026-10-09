import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { safeJoin } from '../../server/lib/static.js';
import { startTestServer } from '../helpers/server.js';

/** Sends a request with the path exactly as written (fetch would normalise it). */
function rawGet(base, path) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method: 'GET', agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}

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

test('static handler cannot be walked out of an allowed directory', async () => {
  const paths = [
    '/css/..%2fpackage.json', '/css/..%2Fpackage.json', '/css/..%2fserver%2fconfig.js', '/media/..%2fserver%2fapp.js',
    '/content/..%2fdocs%2fSECURITY.md', '/js/..%2f..%2fetc%2fpasswd', '/css/%2e%2e%2fpackage.json', '/data/..%5cpackage.json',
    '/assets/.%2f..%2fpackage.json', '/css/x%00.css', '/css/..%2fvar%2flumina.db',
  ];
  for (const p of paths) {
    const res = await rawGet(t.base, p);
    assert.ok(res.status === 404 || res.status === 400, `${p} -> ${res.status}`);
    assert.doesNotMatch(res.body, /"name":\s*"lumina"|export const config|SESSION_SECRET/, p);
  }
  // Legitimate nested public files still load.
  assert.equal((await rawGet(t.base, '/index.html')).status, 200);
  assert.equal((await rawGet(t.base, '/css/base.css')).status, 200);
});

test('safeJoin refuses dot segments before normalising', () => {
  assert.equal(safeJoin('/srv/root', 'css/../var/lumina.db'), null);
  assert.equal(safeJoin('/srv/root', '../etc/passwd'), null);
  assert.equal(safeJoin('/srv/root', 'a\\..\\b'), null);
  assert.equal(safeJoin('/srv/root', 'media/x/.hidden'), null);
  assert.equal(safeJoin('/srv/root', 'media/x\0y'), null);
  assert.equal(safeJoin('/srv/root', 'media/abc/master.m3u8'), '/srv/root/media/abc/master.m3u8');
});

test('malformed request targets get 400 instead of crashing the server', async () => {
  for (const p of ['//', '/%E0%A4%A', '/api/%', '/css/%ZZ.css', '/%00']) {
    const res = await rawGet(t.base, p);
    assert.equal(res.status, 400, p);
  }
  // The process is still serving.
  assert.equal((await fetch(`${t.base}/api/health`)).status, 200);
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

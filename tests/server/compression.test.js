import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { pickEncoding } from '../../server/lib/static.js';
import { startTestServer } from '../helpers/server.js';

/** GET without automatic decompression, so the raw encoded bytes can be checked. */
function rawGet(base, path, headers = {}) {
  const { hostname, port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname, port, path, method: 'GET', headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

test('pickEncoding prefers br, then gzip, and honours q=0', () => {
  assert.equal(pickEncoding('gzip, deflate, br'), 'br');
  assert.equal(pickEncoding('gzip'), 'gzip');
  assert.equal(pickEncoding('br;q=0, gzip;q=0.5'), 'gzip');
  assert.equal(pickEncoding('*'), 'br');
  assert.equal(pickEncoding('identity'), null);
  assert.equal(pickEncoding('gzip;q=0'), null);
  assert.equal(pickEncoding(''), null);
});

test('stylesheets are served with Brotli or gzip when accepted', async () => {
  const original = await readFile(new URL('../../css/player.css', import.meta.url));
  const br = await rawGet(t.base, '/css/player.css', { 'Accept-Encoding': 'gzip, br' });
  assert.equal(br.status, 200);
  assert.equal(br.headers['content-encoding'], 'br');
  assert.equal(br.headers.vary, 'Accept-Encoding');
  assert.ok(br.body.length < original.length / 3, `compressed to ${br.body.length} of ${original.length}`);
  assert.deepEqual(brotliDecompressSync(br.body), original);

  const gz = await rawGet(t.base, '/css/player.css', { 'Accept-Encoding': 'gzip' });
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.deepEqual(gunzipSync(gz.body), original);
  assert.notEqual(gz.headers.etag, br.headers.etag);

  const plain = await rawGet(t.base, '/css/player.css');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.equal(plain.headers.vary, 'Accept-Encoding');
  assert.deepEqual(plain.body, original);
});

test('conditional requests match the ETag of the encoding sent', async () => {
  const first = await rawGet(t.base, '/js/app.js', { 'Accept-Encoding': 'br' });
  assert.equal(first.headers['content-encoding'], 'br');
  const again = await rawGet(t.base, '/js/app.js', { 'Accept-Encoding': 'br', 'If-None-Match': first.headers.etag });
  assert.equal(again.status, 304);
  const otherEncoding = await rawGet(t.base, '/js/app.js', { 'Accept-Encoding': 'gzip', 'If-None-Match': first.headers.etag });
  assert.equal(otherEncoding.status, 200);
  assert.equal(otherEncoding.headers['content-encoding'], 'gzip');
});

test('range requests and binary assets are never compressed', async () => {
  const ranged = await rawGet(t.base, '/css/player.css', { 'Accept-Encoding': 'br', Range: 'bytes=0-99' });
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers['content-encoding'], undefined);
  assert.equal(ranged.body.length, 100);

  const font = await rawGet(t.base, '/assets/fonts/inter-latin-wght-normal.woff2', { 'Accept-Encoding': 'br' });
  assert.equal(font.status, 200);
  assert.equal(font.headers['content-encoding'], undefined);
  assert.equal(font.headers.vary, undefined);
});

test('large JSON responses are compressed; small ones are not', async () => {
  const big = await rawGet(t.base, '/api/home', { 'Accept-Encoding': 'br' });
  assert.equal(big.status, 200);
  assert.equal(big.headers['content-encoding'], 'br');
  assert.equal(big.headers.vary, 'Accept-Encoding');
  assert.ok(Array.isArray(JSON.parse(brotliDecompressSync(big.body)).rows ?? []));
  const plain = await rawGet(t.base, '/api/home');
  assert.equal(plain.headers['content-encoding'], undefined);
  assert.deepEqual(JSON.parse(plain.body), JSON.parse(brotliDecompressSync(big.body)));

  const small = await rawGet(t.base, '/api/health', { 'Accept-Encoding': 'br' });
  assert.equal(small.headers['content-encoding'], undefined);
});

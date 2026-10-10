// Real artwork from TMDB: title + year matching, cached metadata, the same-origin image cache,
// graceful failure when TMDB is down, and catalog-only titles that are never playable.
// TMDB is replaced by a local fake (API + image CDN) so the tests run offline.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from '../helpers/server.js';
import { normalizeTitle, pickMatch, scoreCandidate } from '../../server/services/artwork.js';
import { config } from '../../server/config.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0xff, 0xd9]);

// ── Fake TMDB ──
const MOVIES = {
  45745: { id: 45745, title: 'Sintel', original_title: 'Sintel', release_date: '2010-09-27', poster_path: '/sintelPoster01.jpg', backdrop_path: '/sintelBackdrop01.jpg', vote_count: 900 },
  10378: { id: 10378, title: 'Big Buck Bunny', original_title: 'Big Buck Bunny', release_date: '2008-05-10', poster_path: '/bunnyPoster001.jpg', backdrop_path: '/bunnyBackdrop01.jpg', vote_count: 800 },
  99001: { id: 99001, title: 'Sintel', original_title: 'Sintel', release_date: '2021-01-01', poster_path: '/otherSintel001.jpg', backdrop_path: null, vote_count: 3 },
  133701: { id: 133701, title: 'Tears of Steel', original_title: 'Tears of Steel', release_date: '2016-09-26', poster_path: '/wrongYearPost.jpg', backdrop_path: null, vote_count: 50 },
  555: { id: 555, title: 'Elephant Dreams', original_title: 'Elephant Dreams', release_date: '2006-03-24', poster_path: '/elephantWrong1.jpg', backdrop_path: null, vote_count: 5 },
};
const TV = {
  7000: { id: 7000, name: 'Lantern Garden', original_name: 'Lantern Garden', first_air_date: '2024-04-01', poster_path: '/lanternPoster1.jpg', backdrop_path: '/lanternBack001.jpg', vote_count: 40 },
};
const hits = { search: 0, details: 0, images: 0, imageFiles: [] };
let tmdbDown = false;
let cdnDown = false;

const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (url.pathname.startsWith('/t/p/')) {
    hits.images++;
    hits.imageFiles.push(url.pathname);
    if (cdnDown) return send(503, {});
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': JPEG.length });
    return res.end(JPEG);
  }
  if (tmdbDown) return send(503, { status_message: 'down' });
  if (req.headers.authorization !== 'Bearer test-token') return send(401, { status_message: 'bad token' });
  let m;
  if ((m = url.pathname.match(/^\/3\/search\/(movie|tv)$/))) {
    hits.search++;
    const q = normalizeTitle(url.searchParams.get('query'));
    const pool = Object.values(m[1] === 'movie' ? MOVIES : TV);
    // Like TMDB, a loose text search: anything sharing a word comes back.
    const words = q.split(' ');
    return send(200, { results: pool.filter((x) => words.some((w) => normalizeTitle(x.title || x.name).includes(w))) });
  }
  if ((m = url.pathname.match(/^\/3\/movie\/(\d+)$/))) {
    hits.details++;
    return MOVIES[m[1]] ? send(200, MOVIES[m[1]]) : send(404, {});
  }
  if ((m = url.pathname.match(/^\/3\/tv\/(\d+)\/season\/(\d+)$/))) {
    return send(200, { episodes: [{ episode_number: 1, still_path: '/lanternStill11.jpg' }, { episode_number: 2, still_path: null }] });
  }
  if ((m = url.pathname.match(/^\/3\/tv\/(\d+)$/))) {
    hits.details++;
    return TV[m[1]] ? send(200, TV[m[1]]) : send(404, {});
  }
  return send(404, {});
});

let t;
let admin;
const saved = { ...config.tmdb };

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  t = await startTestServer();
  Object.assign(config.tmdb, { token: '', apiKey: '', apiBase: `${base}/3`, imageBase: `${base}/t/p` });
  admin = await t.userClient({ role: 'admin', elevated: true });
});

after(async () => {
  Object.assign(config.tmdb, saved);
  await t?.close();
  await new Promise((r) => fake.close(r));
});

test('matching requires the same title and a year within one', () => {
  const sintel = { title: 'Sintel', year: 2010 };
  assert.ok(scoreCandidate(sintel, MOVIES[45745], 'movie') > scoreCandidate(sintel, { ...MOVIES[45745], release_date: '2011-01-01' }, 'movie'));
  assert.equal(scoreCandidate(sintel, MOVIES[99001], 'movie'), null, 'a different year rules a same-named film out');
  assert.equal(scoreCandidate({ title: 'Elephants Dream', year: 2006 }, MOVIES[555], 'movie'), null, 'a similar title is not the same title');
  assert.equal(scoreCandidate({ title: 'The Garden', year: 2020 }, { title: 'Garden', release_date: '2020-02-02' }, 'movie') !== null, true, 'a leading article is ignored');
  assert.equal(normalizeTitle('Kōyō: Autumn & Pavilion!'), 'koyo autumn and pavilion');
  assert.equal(pickMatch(sintel, [MOVIES[99001], MOVIES[45745]], 'movie').cand.id, 45745);
});

test('without a TMDB credential, sync explains what to configure and the catalog still works', async () => {
  const res = await admin.post('/api/admin/artwork/sync', {});
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'TMDB_NOT_CONFIGURED');
  assert.match(res.body.error.message, /TMDB_API_TOKEN/);
  const home = await t.client().get('/api/home');
  assert.equal(home.status, 200);
  const sintel = (await t.client().get('/api/titles/sintel')).body;
  assert.equal(sintel.poster, null, 'no invented artwork: the interface shows the Lumina fallback');
});

test('members cannot run a sync', async () => {
  const member = await t.userClient({});
  assert.equal((await member.post('/api/admin/artwork/sync', {})).status, 403);
});

test('sync matches titles by name and year, skips Lumina key art and refuses near misses', async () => {
  config.tmdb.token = 'test-token';
  const res = await admin.post('/api/admin/artwork/sync', {});
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const by = Object.fromEntries(res.body.results.map((r) => [r.id, r]));
  assert.equal(by.sintel.status, 'matched');
  assert.equal(by.sintel.tmdbId, 45745, 'the 2010 film, not the 2021 one');
  assert.equal(by['big-buck-bunny'].status, 'matched');
  assert.equal(by['tears-of-steel'].status, 'not_found', '2016 is too far from 2012');
  assert.equal(by['elephants-dream'].status, 'not_found', '“Elephant Dreams” is not “Elephants Dream”');
  assert.equal(by.hanami.status, 'skipped');
  assert.equal(by['garden-hours'].status, 'skipped');

  const sintel = (await t.client().get('/api/titles/sintel')).body;
  assert.equal(sintel.poster, 'media/artwork/tmdb/w500/sintelPoster01.jpg');
  assert.equal(sintel.backdrop, 'media/artwork/tmdb/w1280/sintelBackdrop01.jpg');
  assert.match(sintel.posterSrcset, /w185\/sintelPoster01\.jpg 185w, .*w780\/sintelPoster01\.jpg 780w$/);
  assert.deepEqual(sintel.artworkCredit, { provider: 'TMDB', url: 'https://www.themoviedb.org/movie/45745' });
  assert.equal(sintel.playable, true, 'artwork does not change playability');

  const tears = (await t.client().get('/api/titles/tears-of-steel')).body;
  assert.equal(tears.poster, null, 'an unmatched title keeps no artwork rather than a wrong poster');
  const hanami = (await t.client().get('/api/titles/hanami')).body;
  assert.equal(hanami.poster, 'assets/art/originals/hanami-poster-720.jpg');

  const status = (await admin.get('/api/admin/artwork')).body;
  assert.equal(status.configured, true);
  assert.equal(status.titles.find((x) => x.id === 'sintel').source, 'tmdb');
  const audit = t.db.get(`SELECT * FROM audit_log WHERE action = 'content.artwork_sync' ORDER BY created_at DESC LIMIT 1`);
  assert.ok(audit, 'the sync is audited');
});

test('metadata responses are cached: a second sync does not search again', async () => {
  const before = { ...hits };
  const res = await admin.post('/api/admin/artwork/sync', { ids: ['sintel', 'big-buck-bunny'] });
  assert.equal(res.status, 200);
  assert.equal(hits.search, before.search, 'no new search requests');
  assert.equal(hits.details, before.details, 'details came from metadata_cache');
});

test('images are served from Lumina’s own cache, fetched from the CDN once', async () => {
  const c = t.client();
  const first = await c.get('/media/artwork/tmdb/w342/sintelPoster01.jpg', { raw: true });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('content-type'), 'image/jpeg');
  assert.match(first.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), JPEG);
  const n = hits.images;
  const again = await c.get('/media/artwork/tmdb/w342/sintelPoster01.jpg', { raw: true });
  assert.equal(again.status, 200);
  await again.arrayBuffer();
  assert.equal(hits.images, n, 'second request served from disk');
});

test('the image cache is not an open proxy and rejects odd paths', async () => {
  const c = t.client();
  const n = hits.images;
  for (const path of ['/media/artwork/tmdb/w342/notInCatalog9.jpg', '/media/artwork/tmdb/original/sintelPoster01.jpg', '/media/artwork/tmdb/w342/..%2f..%2fvar.jpg', '/media/artwork/tmdb/w342/sintelPoster01.jpg.php']) {
    const res = await c.get(path, { raw: true });
    assert.ok([400, 404].includes(res.status), `${path} → ${res.status}`);
    await res.arrayBuffer();
  }
  assert.equal(hits.images, n, 'nothing unreferenced was fetched');
});

test('when TMDB or its image CDN is down, sync reports it and existing artwork stays', async () => {
  tmdbDown = true;
  cdnDown = true;
  try {
    const res = await admin.post('/api/admin/artwork/sync', { ids: ['tears-of-steel'], force: true });
    assert.equal(res.status, 200);
    assert.equal(res.body.results[0].status, 'error');
    assert.equal(res.body.results[0].code, 'TMDB_UNAVAILABLE');
    const sintel = (await t.client().get('/api/titles/sintel')).body;
    assert.equal(sintel.poster, 'media/artwork/tmdb/w500/sintelPoster01.jpg', 'earlier artwork untouched');
    // An image that was never cached cannot be fetched now: 404, and the page shows the fallback.
    const miss = await t.client().get('/media/artwork/tmdb/w780/sintelPoster01.jpg', { raw: true });
    assert.equal(miss.status, 404);
    await miss.arrayBuffer();
    // Already cached images keep working.
    const cached = await t.client().get('/media/artwork/tmdb/w342/sintelPoster01.jpg', { raw: true });
    assert.equal(cached.status, 200);
    await cached.arrayBuffer();
    assert.equal((await t.client().get('/api/home')).status, 200);
  } finally {
    tmdbDown = false;
    cdnDown = false;
  }
});

test('a pinned TMDB id that names a different work is refused', async () => {
  t.db.run('UPDATE titles SET tmdb_id = 555 WHERE id = ?', 'elephants-dream');
  const res = await admin.post('/api/admin/titles/elephants-dream/artwork', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'mismatch');
  assert.equal((await t.client().get('/api/titles/elephants-dream')).body.poster, null);
});

test('series sync stores episode stills without replacing Lumina stills', async () => {
  const ts = new Date().toISOString();
  t.db.run(`INSERT INTO titles (id, type, title, year, synopsis, status, added_at, updated_at, published_at, license, availability)
            VALUES ('lantern-garden', 'series', 'Lantern Garden', 2024, 'A test series.', 'published', ?, ?, ?, '{}', 'catalog')`, ts, ts, ts);
  t.db.run(`INSERT INTO episodes (id, title_id, season_number, number, name) VALUES ('lg-1', 'lantern-garden', 1, 1, 'One'), ('lg-2', 'lantern-garden', 1, 2, 'Two')`);
  const res = await admin.post('/api/admin/titles/lantern-garden/artwork', {});
  assert.equal(res.body.status, 'matched', JSON.stringify(res.body));
  assert.equal(res.body.tmdbType, 'tv');
  assert.equal(res.body.stills, 1);
  assert.equal(t.db.get(`SELECT still FROM episodes WHERE id = 'lg-1'`).still, 'media/artwork/tmdb/w300/lanternStill11.jpg');
  assert.equal(t.db.get(`SELECT still FROM episodes WHERE id = 'lg-2'`).still, null);
  const gh = t.db.all(`SELECT still FROM episodes WHERE title_id = 'garden-hours'`);
  assert.ok(gh.every((e) => e.still.startsWith('assets/art/')), 'Lumina episode stills kept');
});

test('catalog-only titles publish without media, are never playable and say so', async () => {
  const created = await admin.post('/api/admin/titles', {
    type: 'movie', title: 'Reference Film', year: 2001, synopsis: 'Listed for reference.', availability: 'catalog',
    poster: 'assets/art/originals/hanami-poster-720.jpg',
  });
  assert.ok(created.status < 300, JSON.stringify(created.body));
  const id = created.body.title?.id || created.body.id;
  const pub = await admin.post(`/api/admin/titles/${id}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  const d = (await t.client().get(`/api/titles/${id}`)).body;
  assert.equal(d.availability, 'catalog');
  assert.equal(d.playable, false);
  const play = await t.client().get(`/api/playback/${id}`);
  assert.equal(play.status, 404);
  assert.equal(play.body.error.code, 'NOT_STREAMING');

  // A streaming title still needs licensed, ready media to publish.
  const stream = await admin.post('/api/admin/titles', { type: 'movie', title: 'Needs Media', synopsis: 'x', poster: 'assets/art/originals/hanami-poster-720.jpg' });
  const sid = stream.body.title?.id || stream.body.id;
  const refused = await admin.post(`/api/admin/titles/${sid}/publish`);
  assert.equal(refused.status, 422);
  assert.ok(refused.body.error.missing.some((m) => m.field === 'media'));
});

test('staff artwork edits are kept by later syncs', async () => {
  const res = await admin.patch('/api/admin/titles/big-buck-bunny', { poster: 'assets/art/originals/hanami-poster-720.jpg' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const sync = await admin.post('/api/admin/artwork/sync', { ids: ['big-buck-bunny'], force: true });
  assert.equal(sync.body.results[0].status, 'skipped');
  assert.equal((await t.client().get('/api/titles/big-buck-bunny')).body.poster, 'assets/art/originals/hanami-poster-720.jpg');
});

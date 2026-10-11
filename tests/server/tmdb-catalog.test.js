// The live TMDB catalogue (/api/tmdb/*): search, trending, popular, top rated, genres, discover
// and details through the server, with the v3 API key kept server-side. TMDB is replaced by a
// local fake so the tests run offline; it checks the credential like TMDB does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startTestServer } from '../helpers/server.js';
import { config } from '../../server/config.js';

const KEY = 'fake-v3-key-for-tests';
const TOKEN = 'fake-v4-token-for-tests';

const movie = (id, title, extra = {}) => ({ id, title, original_title: title, release_date: '2010-09-27', overview: `${title} overview`, poster_path: `/p${id}.jpg`, backdrop_path: `/b${id}.jpg`, vote_average: 7.46, vote_count: 900, genre_ids: [16, 14], original_language: 'en', ...extra });
const show = (id, name, extra = {}) => ({ id, name, original_name: name, first_air_date: '2024-04-01', overview: `${name} overview`, poster_path: `/p${id}.jpg`, backdrop_path: null, vote_average: 8.12, vote_count: 40, genre_ids: [10765], ...extra });
const pageOf = (results, page = 1, totalPages = 3) => ({ page, results, total_pages: totalPages, total_results: totalPages * 20 });

const hits = { total: 0, byPath: new Map(), lastAuth: null };
let mode = 'ok'; // ok | down | busy | badkey

const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  hits.total++;
  hits.byPath.set(url.pathname, (hits.byPath.get(url.pathname) || 0) + 1);
  hits.lastAuth = { header: req.headers.authorization || null, apiKey: url.searchParams.get('api_key') };
  const send = (status, body, headers = {}) => {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  if (mode === 'down') return send(503, { status_message: 'down' });
  if (mode === 'busy') return send(429, { status_message: 'slow down' }, { 'Retry-After': '7' });
  const authed = url.searchParams.get('api_key') === KEY || req.headers.authorization === `Bearer ${TOKEN}`;
  if (mode === 'badkey' || !authed) return send(401, { status_code: 7, status_message: 'Invalid API key' });
  const page = Number(url.searchParams.get('page') || 1);
  const p = url.pathname;
  if (p === '/3/genre/movie/list') return send(200, { genres: [{ id: 16, name: 'Animation' }, { id: 14, name: 'Fantasy' }, { id: 28, name: 'Action' }] });
  if (p === '/3/genre/tv/list') return send(200, { genres: [{ id: 10765, name: 'Sci-Fi & Fantasy' }, { id: 16, name: 'Animation' }] });
  if (p === '/3/trending/all/week') {
    return send(200, pageOf([{ ...movie(1, 'Sintel'), media_type: 'movie' }, { ...show(2, 'Lantern Garden'), media_type: 'tv' }, { id: 3, name: 'A Person', media_type: 'person' }], page));
  }
  if (p === '/3/trending/movie/week') return send(200, pageOf([movie(1, 'Sintel')], page));
  if (p === '/3/movie/popular') return send(200, pageOf([movie(100 + page, `Popular ${page}`)], page, 99999));
  if (p === '/3/tv/popular') return send(200, pageOf([show(200 + page, `Show ${page}`)], page));
  if (p === '/3/movie/top_rated') return send(200, pageOf([movie(300, 'Top Film')], page));
  if (p === '/3/discover/movie') {
    return send(200, pageOf([movie(400, `Genre ${url.searchParams.get('with_genres')} by ${url.searchParams.get('sort_by')}`)], page));
  }
  if (p === '/3/search/multi') {
    const q = url.searchParams.get('query');
    return send(200, q === 'nothing' ? pageOf([], 1, 0) : pageOf([{ ...movie(1, 'Sintel'), media_type: 'movie' }], page, 2));
  }
  if (p === '/3/movie/1') {
    return send(200, {
      ...movie(1, 'Sintel'),
      tagline: 'A lonely girl and her dragon',
      runtime: 15,
      status: 'Released',
      genres: [{ id: 16, name: 'Animation' }],
      homepage: 'https://durian.blender.org/',
      production_countries: [{ iso_3166_1: 'NL' }],
      spoken_languages: [{ english_name: 'English' }],
      credits: {
        cast: [{ id: 9, name: 'Halina Reijn', character: 'Sintel', order: 0, profile_path: '/hr.jpg' }, { id: 10, name: 'Thom Hoffman', character: 'Shaman', order: 1, profile_path: null }],
        crew: [{ name: 'Colin Levy', job: 'Director' }, { name: 'Esther Wouda', job: 'Screenplay' }],
      },
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, certification: 'PG' }] }] },
      recommendations: { results: [movie(5, 'Big Buck Bunny')] },
    });
  }
  return send(404, { status_code: 34, status_message: 'The resource you requested could not be found.' });
});

let t;
let anon;
const saved = { ...config.tmdb };

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${fake.address().port}`;
  t = await startTestServer();
  Object.assign(config.tmdb, { token: '', apiKey: '', apiBase: `${base}/3`, imageBase: 'https://image.tmdb.org/t/p' });
  anon = t.client();
});

after(async () => {
  Object.assign(config.tmdb, saved);
  await t?.close();
  await new Promise((r) => fake.close(r));
});

const useKey = () => Object.assign(config.tmdb, { apiKey: KEY, token: '' });
const reset = () => {
  t.services.tmdb.cache.clear();
  mode = 'ok';
};

test('without a credential every data endpoint says how to configure it', async () => {
  const status = await anon.get('/api/tmdb/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.configured, false);
  assert.match(status.body.attribution, /not endorsed or certified by TMDB/);
  for (const path of ['/api/tmdb/trending', '/api/tmdb/movie/popular', '/api/tmdb/genres', '/api/tmdb/search?q=x', '/api/tmdb/movie/1']) {
    const res = await anon.get(path);
    assert.equal(res.status, 503, path);
    assert.equal(res.body.error.code, 'TMDB_NOT_CONFIGURED');
    assert.match(res.body.error.message, /TMDB_API_KEY/);
  }
  assert.equal(hits.total, 0, 'TMDB is not called without a credential');
});

test('a v3 key is sent as api_key by the server and never appears in a response', async () => {
  useKey();
  reset();
  const res = await anon.get('/api/tmdb/trending');
  assert.equal(res.status, 200);
  assert.equal(hits.lastAuth.apiKey, KEY);
  assert.equal(hits.lastAuth.header, null);
  assert.ok(!JSON.stringify(res.body).includes(KEY));
  assert.ok(!JSON.stringify(res.headers).includes(KEY));
  assert.equal((await anon.get('/api/tmdb/status')).body.configured, true);
});

test('a v4 token is preferred and sent as a Bearer header', async () => {
  Object.assign(config.tmdb, { apiKey: KEY, token: TOKEN });
  reset();
  const res = await anon.get('/api/tmdb/movie/top-rated');
  assert.equal(res.status, 200);
  assert.equal(hits.lastAuth.header, `Bearer ${TOKEN}`);
  assert.equal(hits.lastAuth.apiKey, null);
  useKey();
});

test('trending mixes films and series, drops people and names genres', async () => {
  useKey();
  reset();
  const res = await anon.get('/api/tmdb/trending');
  assert.deepEqual(res.body.items.map((i) => `${i.type}:${i.id}`), ['movie:1', 'tv:2']);
  const [film, series] = res.body.items;
  assert.equal(film.title, 'Sintel');
  assert.equal(film.year, 2010);
  assert.equal(film.releaseDate, '2010-09-27');
  assert.equal(film.rating, 7.5);
  assert.deepEqual(film.genres, ['Animation', 'Fantasy']);
  assert.equal(film.poster.src, 'https://image.tmdb.org/t/p/w342/p1.jpg');
  assert.match(film.poster.srcset, /w185\/p1\.jpg 185w/);
  assert.equal(film.backdrop.src, 'https://image.tmdb.org/t/p/w1280/b1.jpg');
  assert.equal(series.title, 'Lantern Garden');
  assert.equal(series.backdrop, null);
  assert.deepEqual(series.genres, ['Sci-Fi & Fantasy']);
  assert.equal(res.headers.get('cache-control'), 'public, max-age=300');

  const films = await anon.get('/api/tmdb/trending?type=movie&window=week');
  assert.deepEqual(films.body.items.map((i) => i.type), ['movie']);
});

test('lists page through TMDB, and total pages are capped at TMDB’s limit of 500', async () => {
  useKey();
  reset();
  const p1 = await anon.get('/api/tmdb/movie/popular');
  const p2 = await anon.get('/api/tmdb/movie/popular?page=2');
  assert.equal(p1.body.page, 1);
  assert.equal(p2.body.page, 2);
  assert.equal(p2.body.items[0].title, 'Popular 2');
  assert.equal(p1.body.totalPages, 500, '99,999 pages reported, 500 reachable');
  const tv = await anon.get('/api/tmdb/tv/popular?page=3');
  assert.equal(tv.body.items[0].type, 'tv');
  assert.equal((await anon.get('/api/tmdb/movie/popular?page=0')).status, 422);
  assert.equal((await anon.get('/api/tmdb/movie/popular?page=501')).status, 422);
  assert.equal((await anon.get('/api/tmdb/person/popular')).status, 422);
});

test('genres and discover-by-genre', async () => {
  useKey();
  reset();
  const genres = await anon.get('/api/tmdb/genres');
  assert.equal(genres.status, 200);
  assert.deepEqual(genres.body.movie.map((g) => g.name), ['Animation', 'Fantasy', 'Action']);
  assert.equal(genres.body.tv.length, 2);
  const byGenre = await anon.get('/api/tmdb/movie/discover?genre=28&sort=rating&page=2');
  assert.equal(byGenre.status, 200);
  assert.equal(byGenre.body.items[0].title, 'Genre 28 by vote_average.desc');
  assert.equal((await anon.get('/api/tmdb/movie/discover')).status, 422, 'a genre is required');
});

test('search returns paged results, an empty page for no matches, and validates the query', async () => {
  useKey();
  reset();
  const res = await anon.get('/api/tmdb/search?q=sintel&page=1');
  assert.equal(res.status, 200);
  assert.equal(res.body.items[0].title, 'Sintel');
  assert.equal(res.body.totalPages, 2);
  const none = await anon.get('/api/tmdb/search?q=nothing');
  assert.deepEqual(none.body.items, []);
  assert.equal(none.body.totalPages, 0);
  assert.equal((await anon.get('/api/tmdb/search')).status, 422);
  assert.equal((await anon.get(`/api/tmdb/search?q=${'x'.repeat(101)}`)).status, 422);
});

test('details carry poster, backdrop, overview, release date, cast, rating and recommendations', async () => {
  useKey();
  reset();
  const res = await anon.get('/api/tmdb/movie/1');
  assert.equal(res.status, 200);
  const d = res.body;
  assert.equal(d.title, 'Sintel');
  assert.equal(d.overview, 'Sintel overview');
  assert.equal(d.releaseDate, '2010-09-27');
  assert.equal(d.rating, 7.5);
  assert.equal(d.voteCount, 900);
  assert.equal(d.certification, 'PG');
  assert.equal(d.runtimeMin, 15);
  assert.deepEqual(d.directors, ['Colin Levy']);
  assert.deepEqual(d.writers, ['Esther Wouda']);
  assert.deepEqual(d.cast.map((c) => [c.name, c.character]), [['Halina Reijn', 'Sintel'], ['Thom Hoffman', 'Shaman']]);
  assert.equal(d.cast[0].profile.src, 'https://image.tmdb.org/t/p/w185/hr.jpg');
  assert.equal(d.cast[1].profile, null);
  assert.equal(d.poster.src, 'https://image.tmdb.org/t/p/w342/p1.jpg');
  assert.equal(d.tmdbUrl, 'https://www.themoviedb.org/movie/1');
  assert.equal(d.recommendations[0].title, 'Big Buck Bunny');
  assert.equal((await anon.get('/api/tmdb/movie/424242')).status, 404);
  assert.equal((await anon.get('/api/tmdb/movie/abc')).status, 404);
});

test('responses are cached, so repeat visits do not call TMDB again', async () => {
  useKey();
  reset();
  await anon.get('/api/tmdb/movie/popular?page=4');
  const before = hits.byPath.get('/3/movie/popular');
  await anon.get('/api/tmdb/movie/popular?page=4');
  await anon.get('/api/tmdb/movie/popular?page=4');
  assert.equal(hits.byPath.get('/3/movie/popular'), before);
});

test('TMDB failures become clear, retryable errors and are not cached', async () => {
  useKey();
  reset();
  mode = 'down';
  let res = await anon.get('/api/tmdb/tv/popular');
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'TMDB_UNAVAILABLE');

  mode = 'busy';
  res = await anon.get('/api/tmdb/tv/popular');
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'TMDB_BUSY');

  mode = 'badkey';
  res = await anon.get('/api/tmdb/tv/popular');
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'TMDB_AUTH_FAILED');
  assert.match(res.body.error.message, /TMDB_API_KEY/);
  assert.ok(!JSON.stringify(res.body).includes(KEY));

  mode = 'ok';
  res = await anon.get('/api/tmdb/tv/popular');
  assert.equal(res.status, 200, 'recovers as soon as TMDB does');

  // Unreachable host.
  const apiBase = config.tmdb.apiBase;
  config.tmdb.apiBase = 'http://127.0.0.1:9/3';
  t.services.tmdb.cache.clear();
  res = await anon.get('/api/tmdb/tv/popular');
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'TMDB_UNAVAILABLE');
  config.tmdb.apiBase = apiBase;
});

test('the page may load TMDB images, and nothing else from TMDB', async () => {
  const res = await anon.get('/', { raw: true });
  const csp = res.headers.get('content-security-policy');
  assert.match(csp, /img-src [^;]*https:\/\/image\.tmdb\.org/);
  assert.doesNotMatch(csp, /script-src [^;]*tmdb/);
  assert.doesNotMatch(csp, /connect-src [^;]*tmdb/);
});

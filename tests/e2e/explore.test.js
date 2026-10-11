// Explore, the live TMDB catalogue, in the browser: rows, infinite scrolling, live search, title
// pages, the TMDB credit, and friendly errors. TMDB's API is a local fake and its image CDN is
// intercepted, so nothing leaves the machine. The fake checks the API key like TMDB does.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { startApp, startBrowser, startStaticServer, newPage } from './helpers.js';
import { config } from '../../server/config.js';

const KEY = 'e2e-fake-v3-key';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

const film = (id, title, page = 1) => ({ id, title, original_title: title, release_date: `20${String(10 + (id % 10)).padStart(2, '0')}-05-0${1 + (id % 8)}`, overview: `${title} overview`, poster_path: `/poster${id}.jpg`, backdrop_path: `/back${id}.jpg`, vote_average: 7.2, vote_count: 100 + page, genre_ids: [16] });
const show = (id, name) => ({ id, name, original_name: name, first_air_date: '2024-04-01', overview: `${name} overview`, poster_path: `/poster${id}.jpg`, vote_average: 8.1, vote_count: 40, genre_ids: [18] });
const pageOf = (results, page, totalPages) => ({ page, results, total_pages: totalPages, total_results: totalPages * results.length });

let down = false;
const fake = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (down) return send(503, {});
  if (url.searchParams.get('api_key') !== KEY) return send(401, { status_message: 'Invalid API key' });
  const page = Number(url.searchParams.get('page') || 1);
  const p = url.pathname;
  if (p.startsWith('/3/genre/')) return send(200, { genres: [{ id: 16, name: 'Animation' }, { id: 18, name: 'Drama' }] });
  if (p === '/3/trending/all/week') return send(200, pageOf([{ ...film(1, 'Sintel'), media_type: 'movie' }, { ...show(2, 'Lantern Garden'), media_type: 'tv' }], page, 1));
  // Popular films: three pages of twenty, so scrolling has something to load.
  if (p === '/3/movie/popular') return send(200, pageOf(Array.from({ length: 20 }, (_, i) => film(1000 + (page - 1) * 20 + i, `Popular Film ${(page - 1) * 20 + i + 1}`, page)), page, 3));
  if (p === '/3/tv/popular' || p === '/3/tv/top_rated') return send(200, pageOf([show(2, 'Lantern Garden')], page, 1));
  if (p === '/3/movie/top_rated') return send(200, pageOf([film(1, 'Sintel')], page, 1));
  if (p === '/3/discover/movie') return send(200, pageOf([film(1, 'Sintel')], page, 1));
  if (p === '/3/search/multi') {
    const q = (url.searchParams.get('query') || '').toLowerCase();
    return send(200, q.includes('sintel') ? pageOf([{ ...film(1, 'Sintel'), media_type: 'movie' }], 1, 1) : pageOf([], 1, 0));
  }
  if (p === '/3/movie/1') {
    return send(200, {
      ...film(1, 'Sintel'),
      release_date: '2010-09-27',
      tagline: 'A lonely girl and her dragon',
      runtime: 15,
      genres: [{ id: 16, name: 'Animation' }],
      credits: { cast: [{ id: 9, name: 'Halina Reijn', character: 'Sintel', order: 0, profile_path: '/hr.jpg' }], crew: [{ name: 'Colin Levy', job: 'Director' }] },
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, certification: 'PG' }] }] },
      recommendations: { results: [film(5, 'Big Buck Bunny')] },
    });
  }
  return send(404, {});
});

let app;
let stat;
let browser;
const saved = { ...config.tmdb };

before(async () => {
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  app = await startApp();
  stat = await startStaticServer();
  browser = await startBrowser();
  Object.assign(config.tmdb, { apiKey: KEY, token: '', apiBase: `http://127.0.0.1:${fake.address().port}/3` });
});
after(async () => {
  Object.assign(config.tmdb, saved);
  await browser?.close();
  await stat?.close();
  await app?.close();
  await new Promise((r) => fake.close(r));
});

/** A page whose requests to TMDB's image CDN are answered locally, and which records every response body it reads. */
async function explorePage(opts = {}) {
  const page = await newPage(browser, { base: app.base, ...opts });
  page.imageHits = 0;
  await page.route('https://image.tmdb.org/**', (route) => {
    page.imageHits++;
    route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  page.bodies = [];
  page.on('response', async (res) => {
    if (!res.url().startsWith(app.base)) return;
    try {
      page.bodies.push(await res.text());
    } catch {
      /* redirects and aborted requests have no body */
    }
  });
  return page;
}

const reset = () => {
  down = false;
  app.services.tmdb.cache.clear();
};

test('Explore shows TMDB rows with real posters and the TMDB credit, and the key never reaches the browser', async () => {
  reset();
  const page = await explorePage();
  await page.goto(`${app.base}/#/explore`);
  await page.waitForSelector('[data-row="tmdb-trending"] .lm-tmdb-card');
  assert.equal(await page.locator('h1').first().textContent(), 'Explore the wider garden');
  const titles = await page.locator('[data-row="tmdb-trending"] .lm-card__title').allTextContents();
  assert.deepEqual(titles, ['Sintel', 'Lantern Garden']);
  const img = page.locator('[data-row="tmdb-trending"] .lm-tmdb-card img').first();
  assert.match(await img.getAttribute('src'), /^https:\/\/image\.tmdb\.org\/t\/p\/w342\/poster1\.jpg$/);
  // The 1-pixel test image decodes to a naturalWidth below 1 at srcset densities, so check the
  // load event instead: artImg() clears data-loading on load and swaps in the fallback on error.
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-row="tmdb-trending"] .lm-tmdb-card img');
    return el && el.isConnected && !el.hasAttribute('data-loading');
  });
  assert.equal(await page.locator('[data-row="tmdb-trending"] .lm-artfb').count(), 0, 'no fallback: the posters loaded (allowed by the page CSP)');
  assert.ok(page.imageHits > 0);
  assert.ok(await page.locator('.lm-tmdb-credit').isVisible());
  assert.match(await page.locator('.lm-tmdb-credit').textContent(), /not endorsed or certified by TMDB/);
  for (const id of ['tmdb-popular-movies', 'tmdb-popular-tv', 'tmdb-top-movies', 'tmdb-top-tv']) {
    assert.equal(await page.locator(`[data-row="${id}"]`).count(), 1, id);
  }
  assert.ok(page.bodies.length > 5);
  assert.ok(page.bodies.every((b) => !b.includes(KEY)), 'no response the browser received contains the TMDB key');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Popular films load more pages as you scroll, then stop at the end', async () => {
  reset();
  const page = await explorePage();
  await page.goto(`${app.base}/#/explore/movies`);
  await page.waitForSelector('.lm-tmdb-results .lm-tmdb-card');
  assert.equal(await page.locator('.lm-tmdb-results .lm-tmdb-card').count(), 20);
  assert.match(await page.locator('.lm-disc-count').textContent(), /Showing 20 of 60 films/);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForFunction(() => document.querySelectorAll('.lm-tmdb-results .lm-tmdb-card').length === 40);
  // The button is the keyboard route and the fallback.
  await page.getByRole('button', { name: 'Load more' }).click();
  await page.waitForFunction(() => document.querySelectorAll('.lm-tmdb-results .lm-tmdb-card').length === 60);
  await page.waitForFunction(() => /Showing all 60 films/.test(document.querySelector('.lm-disc-count')?.textContent || ''));
  assert.equal(await page.getByRole('button', { name: 'Load more' }).isVisible(), false);
  assert.equal(await page.locator('.lm-tmdb-card[data-tmdb="movie:1059"]').count(), 1, 'the last item of page 3');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Search shows live results as you type and says when nothing matches', async () => {
  reset();
  const page = await explorePage();
  await page.goto(`${app.base}/#/explore/search`);
  const box = page.getByRole('searchbox', { name: 'Search films and series on TMDB' });
  await box.fill('sintel');
  await page.waitForSelector('.lm-tmdb-results .lm-tmdb-card');
  assert.deepEqual(await page.locator('.lm-tmdb-results .lm-card__title').allTextContents(), ['Sintel']);
  assert.match(page.url(), /#\/explore\/search\?q=sintel$/);
  await box.fill('zzzz');
  await page.waitForSelector('text=Nothing on TMDB matches “zzzz”');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('A title page shows the poster, backdrop, overview, release date, cast, rating and recommendations', async () => {
  reset();
  const page = await explorePage();
  await page.goto(`${app.base}/#/explore/title/movie/1`);
  await page.waitForSelector('.lm-tmdb-detail');
  assert.equal(await page.locator('h1').textContent(), 'Sintel');
  assert.equal(await page.title(), 'Sintel · Lumina');
  assert.match(await page.locator('.lm-detail__poster img').getAttribute('src'), /image\.tmdb\.org\/t\/p\/w342\/poster1\.jpg/);
  assert.match(await page.locator('.lm-detail__backdrop img').getAttribute('src'), /image\.tmdb\.org\/t\/p\/w1280\/back1\.jpg/);
  assert.equal(await page.locator('.lm-detail__synopsis').textContent(), 'Sintel overview');
  assert.equal(await page.locator('.lm-detail__tagline').textContent(), 'A lonely girl and her dragon');
  const facts = await page.locator('.lm-facts').textContent();
  assert.match(facts, /Release date/);
  assert.match(facts, /2010/);
  assert.match(facts, /Colin Levy/);
  assert.match(facts, /7\.2 \/ 10/);
  assert.match(await page.locator('.lm-detail__hero .lm-tmdb-score').getAttribute('aria-label'), /TMDB rating 7\.2 out of 10/);
  assert.equal(await page.locator('.lm-tmdb-person__name').first().textContent(), 'Halina Reijn');
  assert.equal(await page.locator('.lm-tmdb-person__role').first().textContent(), 'Sintel');
  assert.equal(await page.locator('.lm-detail__hero .lm-badge--solid').textContent(), 'PG');
  await page.evaluate(() => document.querySelector('[data-row="tmdb-recommended"]')?.fill?.());
  assert.equal(await page.locator('[data-row="tmdb-recommended"] .lm-card__title').first().textContent(), 'Big Buck Bunny');
  assert.equal(await page.getByRole('link', { name: 'Play' }).count(), 0, 'TMDB titles are not playable');
  assert.equal(await page.getByRole('link', { name: 'Find on Lumina' }).getAttribute('href'), '#/search?q=Sintel');
  assert.ok(await page.locator('.lm-tmdb-credit').isVisible());
  // The genre tag leads to that genre's TMDB listing.
  await page.locator('.lm-detail__genre', { hasText: 'Animation' }).click();
  await page.waitForSelector('.lm-tmdb-results .lm-tmdb-card');
  assert.equal(await page.locator('h1').textContent(), 'Animation');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('When TMDB is down, pages explain it and recover with Try again', async () => {
  reset();
  down = true;
  const page = await explorePage();
  await page.goto(`${app.base}/#/explore/movies`);
  await page.waitForSelector('text=We couldn’t reach The Movie Database just now.');
  down = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await page.waitForSelector('.lm-tmdb-results .lm-tmdb-card');
  // Lumina's own catalogue is unaffected by a TMDB outage.
  down = true;
  app.services.tmdb.cache.clear();
  await page.goto(`${app.base}/#/movies`);
  await page.waitForSelector('.lm-grid .lm-card');
  await page.context().close();
  down = false;
});

test('Without a TMDB key, Explore says what to configure', async () => {
  reset();
  config.tmdb.apiKey = '';
  const page = await explorePage();
  await page.goto(`${app.base}/#/explore`);
  await page.waitForSelector('text=The TMDB catalogue is not set up yet');
  assert.match(await page.locator('.lm-empty').textContent(), /TMDB_API_KEY/);
  config.tmdb.apiKey = KEY;
  await page.context().close();
});

test('Preview mode (static hosting) explains that Explore needs the server; the nav links to it', async () => {
  const page = await newPage(browser, { base: stat.base });
  await page.goto(`${stat.base}/#/explore`);
  await page.waitForSelector('text=The TMDB catalogue needs the Lumina server');
  assert.equal(await page.locator('.lm-footer a[href="#/explore"]').count(), 1);
  await page.context().close();
});

test('Lumina search links to the same words on TMDB', async () => {
  reset();
  const page = await explorePage();
  await page.goto(`${app.base}/#/search?q=sintel`);
  const link = page.getByRole('link', { name: 'Search all films and series on TMDB' });
  await link.waitFor();
  assert.equal(await link.getAttribute('href'), '#/explore/search?q=sintel');
  await page.context().close();
});

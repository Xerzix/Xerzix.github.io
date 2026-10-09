// Discovery and library in a real browser: pagers that recover from a failed page, My List
// and history that stay accurate while you edit them, the title page's Play button and
// licence details, motion and touch-target settings, and Preview mode statistics.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { newPage, sessionCookie, startApp, startBrowser, startStaticServer } from './helpers.js';

let app;
let browser;
before(async () => {
  app = await startApp();
  browser = await startBrowser();
});
after(async () => {
  await browser?.close();
  await app?.close();
});

const unavailable = (route) => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'UNAVAILABLE', message: 'Temporarily unavailable.' } }) });

/** Adds copies of a film so the catalog has more than one page of films and search results. */
function cloneFilms(count) {
  const cols = 'type, title, original_title, tagline, synopsis, year, release_date, runtime_min, age_rating, rating_source, min_age, genres, tags, moods, keywords, countries, original_language, credits, awards, poster, backdrop, palette, license, status, featured, editorial_rank, added_at, updated_at, published_at';
  for (let i = 1; i <= count; i++) {
    app.db.run(`INSERT OR IGNORE INTO titles (id, ${cols}) SELECT 'bunny-copy-${i}', type, title || ' ${i}', original_title, tagline, synopsis, year, release_date, runtime_min, age_rating, rating_source, min_age, genres, tags, moods, keywords, countries, original_language, credits, awards, poster, backdrop, palette, license, status, featured, editorial_rank, added_at, updated_at, published_at FROM titles WHERE id = 'big-buck-bunny'`);
  }
  app.services.catalog.invalidate();
}

test('browse and search: a failed "Load more" is retried, never skipped', async () => {
  cloneFilms(30);
  const u = await app.userClient({ displayName: 'Aiko' });
  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(u)] });
  try {
    // Browse: page 2 fails once.
    const pages = [];
    let fail = true;
    await page.route(/\/api\/titles\?/, (route) => {
      const url = new URL(route.request().url());
      const p = url.searchParams.get('page');
      if (url.searchParams.get('pageSize') !== '24') return route.continue();
      pages.push(p);
      if (p === '2' && fail) {
        fail = false;
        return unavailable(route);
      }
      return route.continue();
    });
    await page.goto(`${app.base}/#/movies?sort=title`);
    const more = page.locator('.lm-disc-more button');
    await more.waitFor();
    const total = Number((await page.textContent('.lm-disc-count')).match(/of (\d+)/)[1]);
    assert.ok(total > 24 && total <= 48, `expected two pages of films, got ${total}`);
    await more.click();
    await page.waitForFunction(() => /Temporarily unavailable/.test(document.querySelector('.lm-disc-count')?.textContent || ''));
    assert.equal(await page.locator('.lm-disc .lm-grid > li').count(), 24);
    await more.click();
    await page.waitForFunction((n) => document.querySelectorAll('.lm-disc .lm-grid > li').length === n, total);
    assert.deepEqual(pages, ['1', '2', '2']);
    assert.match(await page.textContent('.lm-disc-count'), new RegExp(`Showing ${total} of ${total}`));
    assert.equal(await more.isVisible(), false);
    await page.unroute(/\/api\/titles\?/);

    // Search: page 2 fails once; the results already shown stay and the retry appends.
    const spages = [];
    let sfail = true;
    await page.route(/\/api\/search\?/, (route) => {
      const url = new URL(route.request().url());
      if (url.searchParams.get('pageSize') !== '24') return route.continue();
      const p = url.searchParams.get('page');
      spages.push(p);
      if (p === '2' && sfail) {
        sfail = false;
        return unavailable(route);
      }
      return route.continue();
    });
    await page.goto(`${app.base}/#/search?q=bunny`);
    const cards = page.locator('.lm-srch__results .lm-grid > li');
    await page.waitForFunction(() => document.querySelectorAll('.lm-srch__results .lm-grid > li').length === 24);
    const found = Number((await page.textContent('.lm-srch__status')).match(/(\d+) results/)[1]);
    assert.ok(found > 24);
    const smore = page.locator('.lm-srch__results .lm-disc-more button');
    await smore.click();
    await page.waitForFunction(() => /Temporarily unavailable/.test(document.querySelector('.lm-srch__results .lm-disc-count')?.textContent || ''));
    assert.equal(await cards.count(), 24, 'the first page stays on screen');
    assert.equal(await page.locator('.lm-srch__results .lm-empty, .lm-srch__results .lm-error').count(), 0);
    await smore.click();
    await page.waitForFunction((n) => document.querySelectorAll('.lm-srch__results .lm-grid > li').length === n, found);
    assert.equal(await page.locator('.lm-srch__results .lm-disc-more').isVisible(), false);
    assert.deepEqual(spages.filter(Boolean).slice(-3), ['1', '2', '2']);
    const ids = await cards.evaluateAll((els) => els.map((li) => li.querySelector('[data-title-id]')?.dataset.titleId));
    assert.equal(new Set(ids).size, ids.length, 'no title is listed twice');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('My List: Remove always removes, and the grid follows changes made elsewhere', async () => {
  const u = await app.userClient({ displayName: 'Ren' });
  assert.equal((await u.put('/api/library/watchlist/hanami')).status, 200);
  assert.equal((await u.put('/api/library/watchlist/sintel')).status, 200);
  const listed = () => app.db.all('SELECT title_id FROM watchlist WHERE profile_id = ? ORDER BY title_id', u.profileId).map((r) => r.title_id);
  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(u)] });
  try {
    await page.goto(`${app.base}/#/my-list`);
    await page.locator('.lm-lib__grid > li').first().waitFor();
    assert.equal(await page.locator('.lm-lib__grid [data-list-toggle]').count(), 0, 'one Remove control per item, not two');

    await page.click('button[aria-label="Remove Sintel from My List"]');
    await page.locator('.lm-toast', { hasText: 'Removed “Sintel” from My List.' }).waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.lm-lib__grid > li').length === 1);
    assert.deepEqual(listed(), ['hanami']);

    // Removed from somewhere else on the page (as the quick view does): the grid follows.
    await page.evaluate(async () => (await import('/js/core/session.js')).toggleList('hanami'));
    await page.locator('.lm-lib__tab .lm-empty', { hasText: 'Your list is empty' }).waitFor();
    assert.deepEqual(listed(), []);

    await page.reload();
    await page.locator('.lm-lib__tab .lm-empty').waitFor();
    assert.deepEqual(listed(), [], 'nothing came back');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('History: after removing an entry, "Load older history" still shows every remaining entry', async () => {
  const u = await app.userClient({ displayName: 'Sora' });
  const start = Date.now() - 3_600_000;
  const ids = ['sintel', 'hanami', 'big-buck-bunny', 'tears-of-steel', 'elephants-dream'];
  for (let i = 0; i < 55; i++) {
    const ts = new Date(start - i * 60_000).toISOString();
    app.db.run('INSERT INTO history (profile_id, title_id, episode_id, watched_at, updated_at, seconds) VALUES (?, ?, ?, ?, ?, ?)', u.profileId, ids[i % ids.length], '', ts, ts, 60 + i);
  }
  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(u)] });
  try {
    await page.goto(`${app.base}/#/my-list/history`);
    const rows = page.locator('.lm-hist__row');
    await page.waitForFunction(() => document.querySelectorAll('.lm-hist__row').length === 50);
    await rows.first().locator('[data-remove]').click();
    await page.waitForFunction(() => document.querySelectorAll('.lm-hist__row').length === 49);
    await page.click('button:has-text("Load older history")');
    await page.waitForFunction(() => document.querySelectorAll('.lm-hist__row').length === 54);
    const times = await page.locator('.lm-hist__row time').evaluateAll((els) => els.map((e) => e.getAttribute('datetime')));
    assert.equal(new Set(times).size, 54, 'no duplicates');
    const remaining = app.db.all('SELECT watched_at FROM history WHERE profile_id = ? ORDER BY watched_at DESC', u.profileId).map((r) => r.watched_at);
    assert.deepEqual(times, remaining);
    assert.equal(await page.locator('button:has-text("Load older history")').isVisible(), false);
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
  }
});

test('title page: Play continues a short episode, licence text, toggles and motion', async () => {
  const u = await app.userClient({ displayName: 'Mei' });
  // 8 seconds into a 12-second episode.
  assert.equal((await u.put('/api/library/progress', { titleId: 'garden-hours', episodeId: 'garden-hours-s1e1', positionS: 8, durationS: 12, watchedDelta: 8 })).status, 200);
  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(u)] });
  try {
    await page.goto(`${app.base}/#/title/garden-hours`);
    const play = page.locator('.lm-detail__actions a').first();
    await play.waitFor();
    assert.equal((await play.textContent()).trim(), 'Resume S1:E1');
    assert.match(await play.getAttribute('href'), /episode=garden-hours-s1e1$/);
    assert.doesNotMatch(await page.textContent('.lm-detail__resume'), /Up next/);
    assert.equal(await page.locator('.lm-episode.is-next .lm-episode__name').textContent(), '1. Dawn Petals');

    // "Mark series watched" names its action, so it is not also a pressed toggle.
    const watched = page.locator('.lm-detail__more button', { hasText: 'Mark series watched' });
    assert.equal(await watched.getAttribute('aria-pressed'), null);
    // Follow keeps its label; the pressed state carries whether you follow.
    const follow = page.locator('.lm-detail__more button', { hasText: 'Follow series' });
    assert.equal(await follow.getAttribute('aria-pressed'), 'false');
    await follow.click();
    await page.waitForFunction(() => [...document.querySelectorAll('.lm-detail__more button')].some((b) => b.textContent.trim() === 'Follow series' && b.getAttribute('aria-pressed') === 'true'));

    // The in-app "Reduce motion" setting stills the header even when the system allows motion.
    const animations = () => page.evaluate(() => ['.lm-detail__backdrop img', '.lm-detail__poster'].map((s) => getComputedStyle(document.querySelector(s)).animationName));
    const setMotion = (m) => page.evaluate((v) => {
      if (v) document.documentElement.dataset.motion = v;
      else delete document.documentElement.dataset.motion;
    }, m);
    assert.deepEqual(await animations(), ['lm-detail-push', 'lm-rise']);
    await setMotion('reduced');
    assert.deepEqual(await animations(), ['none', 'none']);
    // "Full" keeps the header moving even when the operating system asks for less motion;
    // "System" follows the operating system.
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setMotion('full');
    assert.deepEqual(await animations(), ['lm-detail-push', 'lm-rise']);
    await setMotion(null);
    assert.deepEqual(await animations(), ['none', 'none']);
  } finally {
    await page.context().close();
  }

  // Licence "source" is free text: plain text stays text and an unsafe value never breaks the page.
  const setSource = (source) => {
    const lic = JSON.parse(app.db.get("SELECT license FROM titles WHERE id = 'sintel'").license);
    app.db.run("UPDATE titles SET license = ? WHERE id = 'sintel'", JSON.stringify({ ...lic, source }));
    app.services.catalog.invalidate();
  };
  const p2 = await newPage(browser, { base: app.base, cookies: [sessionCookie(u)] });
  try {
    setSource('Blender Foundation archive');
    await p2.goto(`${app.base}/#/title/sintel`);
    await p2.locator('.lm-facts', { hasText: 'Original source: Blender Foundation archive' }).waitFor();
    assert.equal(await p2.locator('.lm-facts a', { hasText: 'Original source' }).count(), 0);

    setSource('javascript:alert(document.domain)');
    await p2.goto(`${app.base}/#/title/sintel?v=2`);
    await p2.locator('h1.lm-detail__title', { hasText: 'Sintel' }).waitFor();
    assert.equal(await p2.locator('.lm-facts a[href^="javascript"]').count(), 0);
    assert.deepEqual(p2.errors, []);
  } finally {
    setSource('https://durian.blender.org/');
    await p2.context().close();
  }
});

test('phone width: library and title controls are comfortable touch targets', async () => {
  const u = await app.userClient({ displayName: 'Yui' });
  await u.put('/api/library/watchlist/hanami');
  await u.put('/api/library/watchlist/sintel');
  await u.post('/api/library/watched', { titleId: 'sintel' });
  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(u)], viewport: { width: 390, height: 844 } });
  const small = (selector) => page.locator(selector).evaluateAll((els) => els
    .filter((e) => e.getClientRects().length)
    .map((e) => ({ name: e.getAttribute('aria-label') || e.textContent.trim(), w: Math.round(e.getBoundingClientRect().width), h: Math.round(e.getBoundingClientRect().height) }))
    .filter((r) => r.w < 40 || r.h < 40));
  try {
    await page.goto(`${app.base}/#/my-list`);
    await page.locator('.lm-lib__controls button').first().waitFor();
    assert.deepEqual(await small('.lm-lib__controls button, .lm-lib__toolbar .lm-segmented button'), []);
    await page.goto(`${app.base}/#/my-list/history`);
    await page.locator('.lm-hist__row').first().waitFor();
    assert.deepEqual(await small('.lm-hist__row button, .lm-lib__toolbar button'), []);
    await page.goto(`${app.base}/#/title/garden-hours`);
    await page.locator('.lm-detail__more button').first().waitFor();
    assert.deepEqual(await small('.lm-detail__more button, .lm-detail__more a, .lm-detail__section select'), []);
    await page.goto(`${app.base}/#/search?q=garden`);
    await page.locator('.lm-srch__results .lm-grid').waitFor();
    assert.deepEqual(await small('.lm-srch__toolbar button, .lm-srch__toolbar select'), []);
    const col = (await u.post('/api/collections', { name: 'Calm evenings' })).body.collection;
    assert.equal((await u.put(`/api/collections/${col.id}/items/sintel`)).status, 200);
    await page.goto(`${app.base}/#/collections/${col.id}`);
    await page.locator('.lm-coll .lm-segmented button').first().waitFor();
    assert.deepEqual(await small('.lm-coll button:not(.lm-card button)'), []);
  } finally {
    await page.context().close();
  }
});

test('Preview mode: statistics switch off for real, and a collection description can be cleared', async () => {
  const site = await startStaticServer();
  const page = await newPage(browser, { base: site.base });
  try {
    await page.goto(`${site.base}/#/title/sintel`);
    await page.click('.lm-detail__more button:has-text("Mark as watched")');
    await page.locator('.lm-detail__more button', { hasText: 'Mark unwatched' }).waitFor();

    await page.goto(`${site.base}/#/stats`);
    const sw = page.locator('.lm-stats__privacy [role="switch"]');
    await page.locator('.lm-stats__content .lm-stats__tiles, .lm-stats__content [class*="tile"]').first().waitFor();
    assert.equal(await sw.getAttribute('aria-checked'), 'true');
    await sw.click();
    await page.locator('.lm-stats__content', { hasText: 'Statistics are turned off' }).waitFor();
    assert.equal(await sw.getAttribute('aria-checked'), 'false');
    await page.reload();
    await page.locator('.lm-stats__content', { hasText: 'Statistics are turned off' }).waitFor();
    assert.equal(await page.locator('.lm-stats__privacy [role="switch"]').getAttribute('aria-checked'), 'false');

    // "Mark unwatched" also takes the title out of the statistics.
    await page.locator('.lm-stats__privacy [role="switch"]').click();
    await page.locator('.lm-stats__content', { hasText: 'Statistics are turned off' }).waitFor({ state: 'detached' });
    await page.goto(`${site.base}/#/title/sintel`);
    await page.click('.lm-detail__more button:has-text("Mark unwatched")');
    await page.locator('.lm-detail__more button', { hasText: 'Mark as watched' }).waitFor();
    const stats = await page.evaluate(async () => (await import('/js/api/client.js')).api.library.stats());
    assert.equal(stats.moviesWatched, 0);

    // Collection description: set it, then clear it.
    await page.goto(`${site.base}/#/my-list/collections`);
    await page.click('button:has-text("New collection")');
    await page.fill('input[name=name]', 'Preview picks');
    await page.fill('textarea[name=description]', 'Some words');
    await page.click('button:has-text("Create collection")');
    await page.locator('.lm-coll__desc', { hasText: 'Some words' }).waitFor();
    await page.locator('.lm-coll .lm-empty', { hasText: 'Choose Add titles' }).waitFor();
    await page.click('button:has-text("Edit")');
    await page.fill('textarea[name=description]', '');
    await page.click('.lm-modal button:has-text("Save")');
    await page.locator('.lm-toast', { hasText: 'Collection updated.' }).waitFor();
    assert.equal(await page.locator('.lm-coll__desc', { hasText: 'Some words' }).count(), 0);
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('lumina.local.library')).collections[0].description);
    assert.equal(saved, '');
    assert.deepEqual(page.errors, []);
  } finally {
    await page.context().close();
    await site.close();
  }
});

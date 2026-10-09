// Real title artwork in the interface: title-matched images where Lumina has them, the branded
// fallback (never a broken image) where it does not, non-blocking loading, and no Play button
// for catalog-only titles.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, startBrowser, startStaticServer, newPage } from './helpers.js';

let app;
let browser;
let stat;

before(async () => {
  app = await startApp();
  stat = await startStaticServer();
  browser = await startBrowser();
});
after(async () => {
  await browser?.close();
  await stat?.close();
  await app?.close();
});

const cardArt = (page, id) => page.locator(`.lm-row [data-title-id="${id}"] .lm-card__art`).first();

for (const mode of ['server', 'preview']) {
  test(`${mode}: every card shows its own title’s artwork or the Lumina fallback, never a broken image`, async () => {
    const base = mode === 'server' ? app.base : stat.base;
    const page = await newPage(browser, { base });
    await page.goto(`${base}/`);
    await page.waitForSelector('.lm-row [data-title-id] .lm-card__art img, .lm-row [data-title-id] .lm-card__art .lm-artfb');
    await page.evaluate(async () => {
      for (const row of document.querySelectorAll('.lm-row')) row.fill?.();
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 600));
    });
    // Lumina Originals: key art made from their own frames, matched by title id.
    for (const id of ['hanami', 'koyo-autumn-pavilion', 'garden-hours']) {
      const img = cardArt(page, id).locator('img');
      await img.evaluate((el) => (el.complete ? null : new Promise((r) => el.addEventListener('load', r, { once: true }))));
      const info = await img.evaluate((el) => ({ src: el.getAttribute('src'), w: el.naturalWidth, srcset: el.getAttribute('srcset') }));
      assert.match(info.src, new RegExp(`assets/art/originals/${id}-poster-720\\.jpg$`), id);
      assert.ok(info.w > 0, `${id} decoded`);
      assert.match(info.srcset, /360w, .*720w/);
    }
    // Open films without synced artwork: the branded fallback names the title.
    for (const [id, name] of [['sintel', 'Sintel'], ['big-buck-bunny', 'Big Buck Bunny']]) {
      const fb = cardArt(page, id).locator('.lm-artfb');
      assert.equal(await fb.count(), 1, `${id} fallback`);
      assert.equal(await fb.locator('.lm-artfb__title').textContent(), name);
      assert.equal(await cardArt(page, id).locator('img').count(), 0, 'no placeholder image');
    }
    // No broken image anywhere on the page.
    const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0 && !i.closest('[hidden]')).map((i) => i.src));
    assert.deepEqual(broken, []);
    assert.deepEqual(page.errors, []);
    await page.context().close();
  });
}

test('an image that fails to load is replaced by the fallback; slow artwork does not block the page', async () => {
  const page = await newPage(browser, { base: app.base });
  await page.route('**/assets/art/originals/koyo-autumn-pavilion-*', (r) => r.fulfill({ status: 404, body: '' }));
  // Hanami's artwork takes 4 s: navigation and controls must work meanwhile.
  await page.route('**/assets/art/originals/hanami-*', async (r) => {
    await new Promise((res) => setTimeout(res, 4000));
    await r.continue();
  });
  const t0 = Date.now();
  await page.goto(`${app.base}/#/title/koyo-autumn-pavilion`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.lm-detail__poster .lm-artfb');
  assert.equal(await page.locator('.lm-detail__poster img').count(), 0);
  await page.goto(`${app.base}/#/search?q=hanami`);
  await page.waitForSelector('[data-title-id="hanami"]');
  await page.click('a[href="#/my-list"]');
  await page.waitForFunction(() => location.hash.startsWith('#/my-list'));
  assert.ok(Date.now() - t0 < 4000, 'the interface responded while artwork was still loading');
  await page.context().close();
});

test('the title page credits synced artwork and catalog-only titles never offer Play', async () => {
  // A catalog-only title (metadata only) published by staff.
  const admin = await app.userClient({ role: 'admin', elevated: true });
  const created = await admin.post('/api/admin/titles', { type: 'movie', title: 'Paper Moon Garden', year: 1999, synopsis: 'Listed for reference.', availability: 'catalog', poster: 'assets/art/originals/hanami-poster-720.jpg' });
  const id = created.body.title?.id || created.body.id;
  assert.equal((await admin.post(`/api/admin/titles/${id}/publish`)).status, 200);
  const page = await newPage(browser, { base: app.base });
  await page.goto(`${app.base}/#/title/${id}`);
  await page.waitForSelector('.lm-detail__notice');
  assert.match(await page.locator('.lm-detail__notice').textContent(), /does not have this title available to stream/);
  assert.equal(await page.locator('.lm-detail__hero a[href^="#/watch/"]').count(), 0, 'no Play link');
  await page.goto(`${app.base}/#/search?q=paper%20moon`);
  await page.waitForSelector(`[data-title-id="${id}"]`);
  assert.equal(await page.locator(`[data-title-id="${id}"] button[aria-label^="Play"]`).count(), 0);
  assert.match(await page.locator(`[data-title-id="${id}"] .lm-card__link`).getAttribute('aria-label'), /not available to stream/);
  await page.context().close();
});

// Core experience: intro, home, navigation, Preview mode and reduced motion.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, startStaticServer, startBrowser, newPage } from './helpers.js';

let app;
let stat;
let browser;
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

test('intro plays on the first visit, is skippable and is remembered', async () => {
  const page = await newPage(browser, { base: app.base, skipIntro: false });
  await page.goto(app.base);
  await page.waitForSelector('.lm-intro');
  assert.ok(await page.isVisible('.lm-intro__skip'));
  await page.click('.lm-intro__skip');
  await page.waitForSelector('.lm-intro', { state: 'detached' });
  assert.equal(await page.evaluate(() => localStorage.getItem('lumina.introSeen')), '1');
  await page.reload();
  await page.waitForSelector('.lm-hero');
  assert.equal(await page.$('.lm-intro'), null);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('intro reaches the welcome screen with "Enter Lumina" and Esc skips', async () => {
  const page = await newPage(browser, { base: app.base, skipIntro: false });
  await page.goto(app.base);
  await page.waitForSelector('.lm-intro[data-stage="3"]', { timeout: 8000 });
  assert.match(await page.textContent('.lm-intro__welcome h1'), /WELCOME TO LUMINA/);
  assert.match(await page.textContent('.lm-intro__enter'), /Enter Lumina/);
  await page.keyboard.press('Escape');
  await page.waitForSelector('.lm-intro', { state: 'detached' });
  await page.context().close();
});

test('reduced motion jumps straight to the welcome screen', async () => {
  const page = await newPage(browser, { base: app.base, skipIntro: false, reducedMotion: 'reduce' });
  await page.goto(app.base);
  await page.waitForSelector('.lm-intro[data-stage="3"]', { timeout: 1500 });
  await page.click('.lm-intro__enter');
  await page.waitForSelector('.lm-intro', { state: 'detached' });
  await page.context().close();
});

test('home shows the featured banner, rows and working navigation', async () => {
  const page = await newPage(browser, { base: app.base });
  await page.goto(app.base);
  await page.waitForSelector('.lm-hero__title');
  const rows = await page.$$eval('.lm-row', (els) => els.map((e) => e.dataset.row));
  assert.ok(rows.includes('originals'), rows.join(','));
  assert.ok(rows.length >= 4);
  // Exactly one h1 on the page.
  assert.equal(await page.$$eval('h1', (h) => h.length), 1);
  // Primary navigation marks the current page.
  assert.equal(await page.getAttribute('.lm-nav a[data-nav="#/"]', 'aria-current'), 'page');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('header search suggests catalog titles as you type', async () => {
  const page = await newPage(browser, { base: app.base });
  await page.goto(app.base);
  await page.waitForSelector('.lm-hero__title');
  await page.click('.lm-search__toggle');
  await page.fill('.lm-search__input', 'sintl');
  await page.waitForSelector('.lm-suggestion[role="option"]');
  const first = await page.textContent('.lm-suggestion[role="option"] strong');
  assert.equal(first, 'Sintel');
  await page.context().close();
});

test('Preview mode (static hosting): banner, local My List, server-only features explained', async () => {
  const page = await newPage(browser, { base: stat.base });
  await page.goto(stat.base);
  await page.waitForSelector('.lm-preview-banner');
  assert.equal(await page.getAttribute('html', 'data-mode'), 'static');
  await page.waitForSelector('.lm-hero__title');
  // Add the featured title to My List from the banner; it persists on this device.
  const listBtn = page.locator('.lm-hero [data-list-toggle]');
  await listBtn.click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('lumina.local.library') || '{}').watchlist?.length === 1);
  // Account features show the "needs the Lumina server" panel instead of fake forms.
  await page.goto(`${stat.base}/#/login`);
  await page.waitForSelector('.lm-server-required');
  assert.match(await page.textContent('.lm-server-required h1'), /needs the Lumina server/);
  await page.context().close();
});

test('garden environment and particles respect the animation setting', async () => {
  const page = await newPage(browser, { base: app.base });
  await page.addInitScript(() => localStorage.setItem('lumina.appearance', JSON.stringify({ preset: 'moonlit-garden', environment: 'moonlit', animation: false })));
  await page.goto(app.base);
  await page.waitForSelector('.lm-hero__title');
  assert.equal(await page.getAttribute('html', 'data-environment'), 'moonlit');
  assert.equal(await page.getAttribute('html', 'data-animation'), 'off');
  assert.equal(await page.$eval('#lm-petals-back', (c) => getComputedStyle(c).display), 'none');
  await page.context().close();
});

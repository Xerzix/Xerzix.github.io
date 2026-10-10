// "Who's watching?", five identities, switching accounts (navigation menu and Settings), sign-out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, startBrowser, startStaticServer, newPage } from './helpers.js';

const PW = 'moonlight over the koi pond';
let app;
let browser;
let stat;

before(async () => {
  app = await startApp();
  const { limiter } = await import('../../server/lib/security.js');
  limiter.disabled = true;
  stat = await startStaticServer();
  browser = await startBrowser();
});
after(async () => {
  await browser?.close();
  await stat?.close();
  await app?.close();
});

/** Fills the "Add an identity → Create a new account" dialog. */
async function createIdentity(page, username) {
  await page.locator('.lm-who__slot--empty').first().click();
  await page.waitForSelector('dialog[open] input[name=username]');
  await page.fill('dialog[open] input[name=username]', username);
  await page.fill('dialog[open] input[name=email]', `${username}@example.com`);
  await page.fill('dialog[open] input[name=password]', PW);
  await page.check('dialog[open] input[name=acceptTerms]');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => location.hash === '#/');
}

const menuUser = (page) => page.locator('.lm-menu__who > div > span').first().textContent();

test('Lumina opens to “Who’s watching?” with exactly five slots; identities are created, unique and capped at five', async () => {
  const page = await newPage(browser, { base: app.base, skipWho: false });
  await page.goto(`${app.base}/`);
  await page.waitForSelector('.lm-who__grid');
  assert.equal(page.url().endsWith('#/whos-watching'), true);
  assert.equal(await page.locator('h1').textContent(), 'Who’s watching?');
  assert.equal(await page.locator('.lm-who__slot').count(), 5);
  assert.equal(await page.locator('.lm-who__slot--empty').count(), 5);

  const names = ['aiko', 'kenji', 'mei', 'sora', 'yuki'];
  for (const n of names) {
    await createIdentity(page, n);
    await page.goto(`${app.base}/#/whos-watching`);
    await page.waitForSelector('.lm-who__grid');
  }
  assert.equal(await page.locator('.lm-who__slot').count(), 5, 'still five slots');
  assert.equal(await page.locator('.lm-who__slot--empty').count(), 0, 'no sixth slot');
  const users = await page.locator('.lm-who__user').allTextContents();
  assert.deepEqual(users, names.map((n) => `@${n}`));
  const pics = await page.locator('.lm-who__avatar img').evaluateAll((imgs) => imgs.map((i) => i.getAttribute('src')));
  assert.equal(new Set(pics).size, 5, 'five different pictures');
  assert.match(await page.locator('.lm-who__status').textContent(), /maximum of five/);

  // A duplicate username is refused (case-insensitive) — try through the sign-up page.
  await page.goto(`${app.base}/#/whos-watching?manage=1`);
  await page.locator('.lm-who__remove').first().click();
  await page.click('dialog[open] .lm-btn--danger');
  await page.waitForFunction(() => document.querySelectorAll('.lm-who__slot--empty').length === 1 && !document.querySelector('dialog[open]'));
  await page.click('.lm-who__actions button:has-text("Done")');
  await page.waitForSelector('.lm-who__slot--empty:not([disabled])');
  await page.locator('.lm-who__slot--empty').click();
  await page.fill('dialog[open] input[name=username]', 'KENJI');
  await page.fill('dialog[open] input[name=email]', 'kenji2@example.com');
  await page.fill('dialog[open] input[name=password]', PW);
  await page.check('dialog[open] input[name=acceptTerms]');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => /already taken/.test(document.querySelector('dialog[open]')?.textContent || ''), null, { timeout: 8000 });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('switching account from the navigation menu changes the signed-in identity and its data', async () => {
  const page = await newPage(browser, { base: app.base, skipWho: false });
  await page.goto(`${app.base}/`);
  await page.waitForSelector('.lm-who__grid');
  await createIdentity(page, 'hana');
  // Hana adds a title to her list.
  await page.goto(`${app.base}/#/title/hanami`);
  await page.locator('.lm-detail__hero button[data-list-toggle]').first().click();
  await page.waitForFunction(() => document.querySelector('.lm-detail__hero button[data-list-toggle]')?.getAttribute('aria-pressed') === 'true');

  await page.goto(`${app.base}/#/whos-watching`);
  await createIdentity(page, 'ren');
  await page.click('.lm-profile-btn');
  assert.equal(await menuUser(page), '@ren');
  // Ren's list is empty.
  await page.goto(`${app.base}/#/my-list`);
  await page.waitForSelector('.lm-empty, .lm-grid');
  assert.equal(await page.locator('[data-title-id="hanami"]').count(), 0);

  // Switch to Hana from the navigation menu: her password is asked for.
  await page.click('.lm-profile-btn');
  await page.click('.lm-menu__item:has-text("Switch account")');
  await page.waitForSelector('dialog[open] .lm-switcher');
  await page.click('dialog[open] .lm-switcher__item:has-text("@hana")');
  await page.waitForSelector('dialog[open] input[name=password]');
  await page.fill('dialog[open] input[name=password]', 'wrong password!!');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForSelector('dialog[open] .lm-form-error:not(:empty)');
  await page.fill('dialog[open] input[name=password]', PW);
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => location.hash === '#/');
  await page.click('.lm-profile-btn');
  assert.equal(await menuUser(page), '@hana');
  const session = await page.evaluate(() => fetch('/api/session').then((r) => r.json()));
  assert.equal(session.account.username, 'hana', 'the server session is Hana’s');
  await page.goto(`${app.base}/#/my-list`);
  await page.waitForSelector('[data-title-id="hanami"]');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Settings → Account & profiles switches accounts; signing out locks private pages', async () => {
  const page = await newPage(browser, { base: app.base, skipWho: false });
  await page.goto(`${app.base}/`);
  await page.waitForSelector('.lm-who__grid');
  // "Keep me signed in" on the first identity: it switches back without a password.
  await page.locator('.lm-who__slot--empty').first().click();
  await page.fill('dialog[open] input[name=username]', 'nori');
  await page.fill('dialog[open] input[name=email]', 'nori@example.com');
  await page.fill('dialog[open] input[name=password]', PW);
  await page.check('dialog[open] input[name=remember]');
  await page.check('dialog[open] input[name=acceptTerms]');
  await page.click('dialog[open] button[type=submit]');
  await page.waitForFunction(() => location.hash === '#/');
  await page.goto(`${app.base}/#/whos-watching`);
  await createIdentity(page, 'taro');

  await page.goto(`${app.base}/#/settings/account`);
  await page.waitForSelector('.lm-acctid');
  assert.match(await page.locator('.lm-acctid__text').textContent(), /@taro/);
  assert.equal(await page.locator('.lm-acctid__roster li').count(), 2);
  await page.click('.lm-acctid__roster button[aria-label="Switch to nori"]');
  await page.waitForFunction(() => location.hash === '#/');
  const s = await page.evaluate(() => fetch('/api/session').then((r) => r.json()));
  assert.equal(s.account.username, 'nori', 'remembered identity switched without a password');

  // Sign out from the menu: back to "Who's watching?", and private pages need an identity.
  await page.click('.lm-profile-btn');
  await page.click('.lm-menu__item:has-text("Sign out")');
  await page.waitForFunction(() => location.hash === '#/whos-watching');
  const after = await page.evaluate(() => fetch('/api/session').then((r) => r.json()));
  assert.equal(after.account, null);
  const list = await page.evaluate(() => fetch('/api/library/watchlist').then((r) => r.status));
  assert.equal(list, 401);
  await page.goto(`${app.base}/#/account`);
  await page.waitForFunction(() => location.hash.startsWith('#/login'));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('keyboard: slots are reachable with Tab and arrow keys and open with Enter', async () => {
  const page = await newPage(browser, { base: app.base, skipWho: false, reducedMotion: 'reduce' });
  await page.goto(`${app.base}/#/whos-watching`);
  await page.waitForSelector('.lm-who__slot');
  await page.locator('.lm-who__slot').first().focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.slot), '1');
  await page.keyboard.press('Enter');
  await page.waitForSelector('dialog[open] input[name=username]');
  await page.keyboard.press('Escape');
  await page.context().close();
});

test('phone layout: five slots fit without horizontal scrolling', async () => {
  const page = await newPage(browser, { base: app.base, skipWho: false, viewport: { width: 390, height: 844 } });
  await page.goto(`${app.base}/#/whos-watching`);
  await page.waitForSelector('.lm-who__slot');
  assert.equal(await page.locator('.lm-who__slot').count(), 5);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await page.context().close();
});

test('Preview mode explains that separate accounts need the server and lets visitors continue', async () => {
  const page = await newPage(browser, { base: stat.base, skipWho: false });
  await page.goto(`${stat.base}/`);
  await page.waitForSelector('.lm-who__grid');
  assert.equal(await page.locator('.lm-who__slot').count(), 5);
  assert.equal(await page.locator('.lm-who__slot:not([disabled])').count(), 0);
  assert.match(await page.locator('.lm-who__status').textContent(), /Preview mode/);
  await page.click('.lm-who__guest');
  await page.waitForSelector('.lm-hero');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

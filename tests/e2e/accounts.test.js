// Accounts, profiles and appearance: sign-up, the five-profile limit, PIN-locked profiles,
// appearance presets that persist (on this device and on the profile), contrast warnings for
// custom colours, and Settings in Preview mode.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp, startStaticServer, startBrowser, newPage } from './helpers.js';

const PW = 'velvet lanterns at dusk';
const LIMIT_MESSAGE = 'This account already has 5 profiles, the maximum. Profiles belong to one account — they are not separate subscriptions or simultaneous streams. Delete a profile to create another.';
const { version } = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

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

let seq = 0;
const newEmail = () => `garden${++seq}.${Date.now().toString(36)}@example.com`;

/** Signs up through the form and waits for Home (the first profile is selected automatically). */
async function registerThroughUi(page, email, displayName = 'Aiko') {
  await page.goto(`${app.base}/#/register`);
  await page.waitForSelector('.lm-auth__panel form');
  await page.fill('input[name=displayName]', displayName);
  await page.fill('input[name=email]', email);
  await page.fill('input[name=password]', PW);
  await page.fill('input[name=confirm]', PW);
  await page.check('input[name=acceptTerms]');
  await page.click('.lm-auth__panel button[type=submit]');
  await page.waitForFunction(() => location.hash === '#/');
}

/** Calls the API from inside the page, with the page's session cookie. */
function apiFromPage(page, method, path, body) {
  return page.evaluate(async ([method, path, body]) => {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Lumina-Request': '1', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: res.status === 204 ? null : await res.json() };
  }, [method, path, body]);
}

const tileNames = (page) => page.$$eval('.lm-profile-tile:not(.lm-profile-tile--add) .lm-profile-tile__name', (els) => els.map((e) => e.textContent));

async function addProfileThroughEditor(page, name) {
  await page.click('.lm-profile-tile--add');
  await page.waitForSelector('dialog .lm-profile-form');
  await page.fill('dialog input[name=name]', name);
  await page.click('dialog .lm-modal__foot .lm-btn--primary');
  await page.waitForSelector('dialog .lm-profile-form', { state: 'detached' });
  await page.waitForFunction((n) => [...document.querySelectorAll('.lm-profile-tile__name')].some((e) => e.textContent === n), name);
}

test('sign-up leads to the profile picker; five profiles fill the account and the sixth is refused with the explanation', async () => {
  const page = await newPage(browser, { base: app.base, reducedMotion: 'reduce' });
  await registerThroughUi(page, newEmail());

  await page.goto(`${app.base}/#/profiles`);
  await page.waitForSelector('.lm-profile-tile');
  assert.equal(await page.textContent('h1'), 'Who’s watching?');
  assert.deepEqual(await tileNames(page), ['Aiko']);
  assert.match(await page.textContent('.lm-profile-tile--add'), /1 of 5/);

  for (const name of ['Kenji', 'Mei', 'Haru']) await addProfileThroughEditor(page, name);
  assert.deepEqual(await tileNames(page), ['Aiko', 'Kenji', 'Mei', 'Haru']);

  // Open the editor for a fifth profile, but let "another device" take the last place first:
  // the server refuses the save and the dialog explains the limit.
  await page.click('.lm-profile-tile--add');
  await page.waitForSelector('dialog .lm-profile-form');
  await page.fill('dialog input[name=name]', 'Sora');
  const elsewhere = await apiFromPage(page, 'POST', '/api/profiles', { name: 'Ren' });
  assert.equal(elsewhere.status, 200);
  await page.click('dialog .lm-modal__foot .lm-btn--primary');
  await page.waitForSelector('dialog .lm-profile-form .lm-notice');
  const refusal = await page.textContent('dialog .lm-profile-form .lm-notice');
  assert.ok(refusal.includes(LIMIT_MESSAGE), refusal);
  assert.match(refusal, /5 of 5 profiles/);

  const sixth = await apiFromPage(page, 'POST', '/api/profiles', { name: 'Sora' });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.error.code, 'PROFILE_LIMIT');
  assert.equal(sixth.body.error.message, LIMIT_MESSAGE);

  // Closing the dialog refreshes the picker: five profiles, creation disabled, the reason shown.
  await page.click('dialog .lm-modal__foot .lm-btn--ghost');
  await page.waitForSelector('.lm-profiles__note--limit');
  assert.deepEqual(await tileNames(page), ['Aiko', 'Kenji', 'Mei', 'Haru', 'Ren']);
  const note = await page.textContent('.lm-profiles__note--limit');
  assert.match(note, /5 of 5 profiles/);
  assert.ok(note.includes(LIMIT_MESSAGE), note);
  assert.equal(await page.getAttribute('.lm-profile-tile--add', 'aria-disabled'), 'true');

  // Trying again (the tile stays focusable and clickable for assistive technology) does not
  // open the editor; it repeats the explanation.
  await page.click('.lm-profile-tile--add', { force: true });
  await page.waitForSelector('.lm-toast:has-text("the maximum")');
  assert.ok((await page.textContent('.lm-toast:has-text("the maximum")')).includes(LIMIT_MESSAGE));
  assert.equal(await page.$('dialog .lm-profile-form'), null);
  const list = await apiFromPage(page, 'GET', '/api/profiles');
  assert.equal(list.body.profiles.length, 5);
  assert.ok(!list.body.profiles.some((p) => p.name === 'Sora'));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a PIN-locked profile asks for its PIN before switching', async () => {
  const page = await newPage(browser, { base: app.base, reducedMotion: 'reduce' });
  await registerThroughUi(page, newEmail());

  // Add a second profile and lock it from Manage profiles.
  await page.goto(`${app.base}/#/profiles/manage`);
  await page.waitForSelector('.lm-profile-tile');
  await addProfileThroughEditor(page, 'Kenji');
  await page.click('.lm-profile-tile[aria-label="Edit Kenji"]');
  await page.waitForSelector('dialog .lm-profile-form__pin');
  assert.match(await page.textContent('dialog .lm-profile-form__pin'), /No PIN/);
  assert.ok(!(await page.textContent('dialog .lm-profile-form__pin')).includes('null'));
  await page.click('dialog .lm-profile-form__pin .lm-btn');
  await page.waitForSelector('dialog form.lm-pin');
  const pinInputs = page.locator('dialog form.lm-pin .lm-pin__input');
  await pinInputs.nth(0).fill('2468');
  await pinInputs.nth(1).fill('2468');
  await page.click('dialog:has(form.lm-pin) .lm-modal__foot .lm-btn--primary');
  await page.waitForSelector('dialog form.lm-pin', { state: 'detached' });
  await page.waitForFunction(() => /PIN is needed/.test(document.querySelector('dialog .lm-profile-form__pin')?.textContent || ''));
  await page.click('dialog .lm-modal__foot .lm-btn--ghost');
  await page.waitForSelector('dialog .lm-profile-form', { state: 'detached' });

  await page.goto(`${app.base}/#/profiles`);
  await page.waitForSelector('.lm-profile-tile__lock');
  const locked = page.locator('.lm-profile-tile', { hasText: 'Kenji' });
  assert.match(await locked.getAttribute('aria-label'), /locked with a PIN/);
  await locked.click();

  // The PIN is asked for before anything changes.
  await page.waitForSelector('dialog .lm-pin__input');
  assert.match(await page.textContent('dialog .lm-modal__title, dialog h2'), /Enter Kenji’s PIN/);
  assert.equal(await page.getAttribute('dialog .lm-pin__input', 'inputmode'), 'numeric');
  assert.equal((await apiFromPage(page, 'GET', '/api/session')).body.profile.name, 'Aiko');

  await page.fill('dialog .lm-pin__input', '1111');
  await page.waitForFunction(() => /not correct/.test(document.querySelector('dialog .lm-pin__error')?.textContent || ''));
  assert.equal(await page.evaluate(() => location.hash), '#/profiles');
  assert.equal((await apiFromPage(page, 'GET', '/api/session')).body.profile.name, 'Aiko');

  await page.fill('dialog .lm-pin__input', '2468');
  await page.waitForFunction(() => location.hash === '#/');
  assert.equal((await apiFromPage(page, 'GET', '/api/session')).body.profile.name, 'Kenji');

  // Switching back to a profile without a PIN needs no prompt.
  await page.goto(`${app.base}/#/profiles`);
  await page.waitForSelector('.lm-profile-tile');
  await page.locator('.lm-profile-tile', { hasText: 'Aiko' }).click();
  await page.waitForFunction(() => location.hash === '#/');
  assert.equal((await apiFromPage(page, 'GET', '/api/session')).body.profile.name, 'Aiko');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('an appearance preset persists across reloads and, for a profile, on the server', async () => {
  const email = newEmail();
  const page = await newPage(browser, { base: app.base, reducedMotion: 'reduce' });
  await registerThroughUi(page, email);
  await page.goto(`${app.base}/#/settings/appearance`);
  await page.waitForSelector('.lm-preset-grid');
  await page.locator('.lm-preset', { hasText: 'Crimson Temple' }).click();
  await page.waitForSelector('.lm-savebar:not([hidden])');
  await page.click('.lm-savebar .lm-btn--primary');
  await page.waitForSelector('.lm-savebar[hidden]', { state: 'attached' });
  await page.waitForSelector('.lm-toast:has-text("Appearance saved to Aiko.")');

  const applied = () => page.evaluate(() => ({
    bg: document.documentElement.style.getPropertyValue('--lm-bg'),
    environment: document.documentElement.dataset.environment,
  }));
  assert.deepEqual(await applied(), { bg: '#0a0505', environment: 'lantern' });

  await page.reload();
  await page.waitForSelector('.lm-preset-grid');
  assert.deepEqual(await applied(), { bg: '#0a0505', environment: 'lantern' });
  assert.ok(await page.locator('.lm-preset', { hasText: 'Crimson Temple' }).locator('input').isChecked());
  const stored = await apiFromPage(page, 'GET', '/api/session');
  assert.equal(stored.body.profile.preferences.appearance.preset, 'crimson-temple');
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // A different browser has nothing stored locally; signing in brings the profile's theme.
  const fresh = await newPage(browser, { base: app.base, reducedMotion: 'reduce' });
  await fresh.goto(`${app.base}/#/login`);
  await fresh.waitForSelector('.lm-auth__panel form');
  assert.equal(await fresh.evaluate(() => document.documentElement.style.getPropertyValue('--lm-bg')), '#080808');
  await fresh.fill('input[name=email]', email);
  await fresh.fill('input[name=password]', PW);
  await fresh.click('.lm-auth__panel button[type=submit]');
  await fresh.waitForFunction(() => location.hash === '#/');
  await fresh.waitForFunction(() => document.documentElement.style.getPropertyValue('--lm-bg') === '#0a0505');
  await fresh.goto(`${app.base}/#/settings/appearance`);
  await fresh.waitForSelector('.lm-preset-grid');
  assert.ok(await fresh.locator('.lm-preset', { hasText: 'Crimson Temple' }).locator('input').isChecked());
  assert.equal(await fresh.getAttribute('html', 'data-environment'), 'lantern');
  assert.deepEqual(fresh.errors, []);
  await fresh.context().close();
});

test('a custom colour with poor contrast shows a readable warning; the fix and Discard restore readability', async () => {
  const page = await newPage(browser, { base: app.base, reducedMotion: 'reduce' });
  await page.goto(`${app.base}/#/settings/appearance`);
  await page.waitForSelector('.lm-preset-grid');
  await page.click('.lm-preset--custom');
  await page.waitForSelector('.lm-colour-grid');
  const textColour = page.locator('.lm-colour', { hasText: 'Text colour' }).locator('input.lm-input');
  await textColour.fill('#333333');
  await page.waitForSelector('.lm-contrast .lm-notice--danger');
  assert.match(await page.textContent('.lm-contrast'), /below the WCAG AA contrast guideline/);
  assert.ok((await page.$$('.lm-contrast__item[data-severity="fail"]')).length >= 1);
  // The page previews the unreadable palette…
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--lm-text') === '#333333');
  // …but the editor and its warning keep a legible palette.
  assert.equal(await page.$eval('.lm-custom-editor', (el) => getComputedStyle(el).color), 'rgb(248, 245, 242)');
  assert.ok(await page.isVisible('.lm-savebar'));

  await page.click('.lm-contrast .lm-btn--primary');
  await page.waitForSelector('.lm-contrast .lm-notice--ok');
  assert.equal((await page.$$('.lm-contrast__item[data-severity="fail"]')).length, 0);
  await page.waitForFunction(() => document.documentElement.style.getPropertyValue('--lm-text') !== '#333333');

  // Leaving with unsaved changes asks first, and discarding restores the saved theme.
  await page.click('.lm-settings__nav a[href="#/settings/playback"]');
  await page.waitForSelector('dialog .lm-modal__foot');
  assert.match(await page.textContent('dialog'), /Discard unsaved changes\?/);
  await page.locator('dialog .lm-modal__foot button', { hasText: 'Discard changes' }).click();
  await page.waitForFunction(() => location.hash === '#/settings/playback');
  await page.waitForSelector('.lm-settings-group');
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--lm-text')), '#f8f5f2');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Preview mode: Settings keeps preferences on the device; server-only parts explain themselves', async () => {
  const page = await newPage(browser, { base: stat.base, reducedMotion: 'reduce' });
  await page.goto(`${stat.base}/#/settings/appearance`);
  await page.waitForSelector('.lm-preset-grid');
  await page.locator('.lm-preset', { hasText: 'Moonlit Garden' }).click();
  await page.click('.lm-savebar .lm-btn--primary');
  await page.waitForSelector('.lm-toast:has-text("Appearance saved on this device.")');
  await page.reload();
  await page.waitForSelector('.lm-preset-grid');
  assert.ok(await page.locator('.lm-preset', { hasText: 'Moonlit Garden' }).locator('input').isChecked());
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--lm-bg')), '#05080d');
  assert.equal(await page.getAttribute('html', 'data-environment'), 'moonlit');

  // Device-local playback preferences work without a server.
  await page.goto(`${stat.base}/#/settings/playback`);
  await page.waitForSelector('.lm-switch[aria-label="Skip intros"]');
  await page.click('.lm-switch[aria-label="Skip intros"]');
  await page.waitForFunction(() => document.querySelector('.lm-settings__status')?.textContent === 'Saved');
  await page.reload();
  await page.waitForSelector('.lm-switch[aria-label="Skip intros"]');
  assert.equal(await page.getAttribute('.lm-switch[aria-label="Skip intros"]', 'aria-checked'), 'true');

  await page.goto(`${stat.base}/#/settings/notifications`);
  await page.waitForSelector('.lm-inline-server');
  assert.match(await page.textContent('.lm-inline-server h2'), /^Choosing notification preferences needs the Lumina server$/);
  assert.equal(await page.$$eval('h1', (els) => els.length), 1);

  await page.goto(`${stat.base}/#/settings/about`);
  await page.waitForSelector('.lm-about');
  assert.ok((await page.textContent('.lm-about')).includes(`Version ${version}`));

  for (const route of ['login', 'register', 'profiles', 'account']) {
    await page.goto(`${stat.base}/#/${route}`);
    await page.waitForSelector('.lm-server-required');
  }
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the profile picker and Settings fit a 390px phone without sideways scrolling', async () => {
  const page = await newPage(browser, { base: app.base, viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await registerThroughUi(page, newEmail());
  for (const [route, ready] of [['profiles', '.lm-profile-tile'], ['profiles/manage', '.lm-profile-tile'], ['settings/appearance', '.lm-preset-grid'], ['settings/language', '.lm-sub-preview'], ['settings/privacy', '.lm-row-toggles'], ['account', '.lm-account-section']]) {
    await page.goto(`${app.base}/#/${route}`);
    await page.waitForSelector(ready);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `${route} overflows by ${overflow}px`);
  }
  // The section navigation collapses to a select on phones.
  await page.goto(`${app.base}/#/settings/appearance`);
  await page.waitForSelector('.lm-settings__picker select');
  assert.ok(await page.isVisible('.lm-settings__picker select'));
  assert.ok(!(await page.isVisible('.lm-settings__nav')));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

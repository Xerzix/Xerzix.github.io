// Velvia Suggestions in the browser: the concierge page, the title-page and compare-page
// panels, in server mode and in Preview mode (static hosting, built-in engine in the page).
// Every suggested title must link to a real catalog title, and the provider shown must be
// the one that actually answered.
import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startApp, startStaticServer, startBrowser, newPage, sessionCookie } from './helpers.js';

const ENGINE = 'Built-in catalog engine';
const PREVIEW_CATALOG = JSON.parse(readFileSync(new URL('../../data/catalog.json', import.meta.url), 'utf8')).titles;

let app;
let stat;
let browser;
let config;
let savedVelvia;
let FALLBACK_NOTICE;
let serverIds;
before(async () => {
  app = await startApp();
  stat = await startStaticServer();
  browser = await startBrowser();
  ({ config } = await import('../../server/config.js'));
  ({ FALLBACK_NOTICE } = await import('../../server/services/velvia/index.js'));
  savedVelvia = { ...config.velvia };
  const r = await app.client().get('/api/titles?pageSize=100');
  serverIds = new Set(r.body.items.map((x) => x.id));
});
after(async () => {
  await browser?.close();
  await stat?.close();
  await app?.close();
});
afterEach(() => {
  app.services.velvia?.setProvider(null);
  Object.assign(config.velvia, savedVelvia);
});

/** Every link a recommendation card offers, as title ids. */
async function recLinks(page, scope) {
  return page.$$eval(`${scope} .lm-vrec`, (cards) => cards.map((c) => ({
    title: c.querySelector('.lm-vrec__title a')?.getAttribute('href'),
    details: c.querySelector('a[aria-label^="Details for"]')?.getAttribute('href'),
    play: c.querySelector('a[aria-label^="Play "]')?.getAttribute('href') ?? null,
  })));
}

const idFrom = (href, prefix) => {
  assert.ok(href?.startsWith(prefix), `${href} starts with ${prefix}`);
  return decodeURIComponent(href.slice(prefix.length).split('?')[0]);
};

function assertCatalogLinks(cards, ids) {
  assert.ok(cards.length > 0, 'at least one suggestion');
  for (const c of cards) {
    const id = idFrom(c.title, '#/title/');
    assert.ok(ids.has(id), `${id} is a catalog title`);
    assert.equal(idFrom(c.details, '#/title/'), id);
    if (c.play) assert.equal(idFrom(c.play, '#/watch/'), id);
  }
}

const velviaReplies = (page) => page.locator('.lm-velvia__log .lm-vmsg--velvia:not(.lm-vmsg--typing)');

/** Sends a message from the composer and waits for Velvia's answer. */
async function ask(page, text) {
  const before = await velviaReplies(page).count();
  await page.fill('.lm-velvia__input', text);
  await page.keyboard.press('Enter');
  await page.waitForFunction((n) => document.querySelectorAll('.lm-velvia__log .lm-vmsg--velvia:not(.lm-vmsg--typing)').length > n, before);
  return velviaReplies(page).last();
}

async function openVelvia(page, base, hash = '#/velvia') {
  await page.goto(`${base}/${hash}`);
  await page.waitForSelector('.lm-velvia__log .lm-vmsg--velvia');
}

// ───────────────────────── Server mode ─────────────────────────

test('server: the Velvia page answers from the catalog with the built-in engine', async () => {
  const page = await newPage(browser, { base: app.base });
  await openVelvia(page, app.base);
  assert.equal(await page.$$eval('h1', (x) => x.length), 1);
  assert.equal((await page.textContent('h1')).trim(), 'Velvia');
  assert.match(await page.textContent('.lm-velvia__sub'), /Suggestions from the Lumina catalog/);
  await page.waitForFunction((label) => document.querySelector('.lm-velvia__provider')?.textContent.includes(label), ENGINE);
  assert.match(await page.textContent('.lm-velvia__provider'), /Grounded in the Lumina catalog/);
  // Signed out: the history switch explains itself and cannot be turned on.
  assert.equal(await page.getAttribute('.lm-velvia__history .lm-switch', 'aria-checked'), 'false');
  assert.ok(await page.isDisabled('.lm-velvia__history .lm-switch'));
  assert.equal(await page.locator('.lm-velvia__log .lm-chip--velvia').count(), 10, 'the ten example questions');

  await page.click('.lm-chip--velvia >> text=Find a movie with excellent cinematography');
  const reply = velviaReplies(page).nth(1); // the intro is the first Velvia message
  await reply.locator('.lm-vrec').first().waitFor();
  assertCatalogLinks(await recLinks(page, '.lm-velvia__log .lm-vmsg--velvia:last-child'), serverIds);
  assert.equal(await reply.locator('.lm-notice').count(), 0, 'no fallback notice from the built-in engine');
  assert.match(await page.textContent('[aria-live="polite"].visually-hidden'), /^Velvia: /);
  assert.equal(await page.locator('.lm-velvia__log .lm-vmsg--user').count(), 1);

  // Compare two suggestions through the tray.
  const compare = reply.locator('.lm-vrec__actions button[aria-label^="Compare "]');
  await compare.nth(0).click();
  await compare.nth(1).click();
  await page.waitForSelector('.lm-velvia__tray:not([hidden])');
  assert.equal(await compare.nth(0).getAttribute('aria-pressed'), 'true');
  assert.equal((await compare.nth(0).textContent()).trim(), 'In compare');
  const side = await page.getAttribute('.lm-velvia__tray a.lm-btn--primary', 'href');
  const ids = idFrom(side, '#/compare?ids=').split(',');
  assert.equal(ids.length, 2);
  for (const id of ids) assert.ok(serverIds.has(id), id);
  await page.click('.lm-velvia__tray-actions button');
  await page.waitForSelector('.lm-vcompare table');
  assert.equal(await page.locator('.lm-vcompare thead th').count(), 2);

  // Removing a title from the tray releases its Compare button again.
  await page.locator('.lm-velvia__tray-remove').first().click();
  assert.equal(await page.locator('.lm-velvia__tray-items li').count(), 1);
  assert.equal(await compare.nth(0).getAttribute('aria-pressed'), 'false');
  assert.equal((await compare.nth(0).textContent()).trim(), 'Compare');
  assert.equal(await compare.nth(1).getAttribute('aria-pressed'), 'true');

  // A film that is not on Lumina gets an honest answer and clarifying chips, no picks.
  const unknown = await ask(page, 'Recommend something similar to Interstellar');
  assert.match(await unknown.textContent(), /“Interstellar” isn’t available on Lumina/);
  assert.equal(await unknown.locator('.lm-vrec').count(), 0);
  assert.match(await unknown.locator('.lm-vmsg__question').textContent(), /What did you enjoy most about Interstellar\?/);
  assert.ok(await unknown.locator('.lm-chip--velvia').count() >= 3);

  // Answering continues the thread and suggests real titles only.
  await unknown.locator('.lm-chip--velvia >> text=The big ideas and mysteries').click();
  await page.waitForFunction(() => document.querySelectorAll('.lm-velvia__log .lm-vmsg--user').length === 4);
  const traits = velviaReplies(page).last();
  await traits.locator('.lm-vrec').first().waitFor();
  assert.match(await traits.locator('.lm-vmsg__text').textContent(), /Interstellar/);
  assertCatalogLinks(await recLinks(page, '.lm-velvia__log .lm-vmsg--velvia:last-child'), serverIds);

  // The conversation survives a reload (sessionStorage) and "New conversation" clears it.
  await page.reload();
  await page.waitForSelector('.lm-velvia__log .lm-vmsg--user');
  assert.equal(await page.locator('.lm-velvia__log .lm-vmsg--user').count(), 4);
  await page.click('button:has-text("New conversation")');
  assert.equal(await page.locator('.lm-velvia__log .lm-vmsg--user').count(), 0);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('server: ?title= sets the context and ?q= asks straight away', async () => {
  const page = await newPage(browser, { base: app.base });
  await openVelvia(page, app.base, `#/velvia?title=sintel&q=${encodeURIComponent('Who are the cast and crew?')}`);
  await page.waitForSelector('.lm-velvia__context:not([hidden])');
  assert.match(await page.textContent('.lm-velvia__context'), /Asking about Sintel/);
  await page.waitForFunction(() => document.querySelectorAll('.lm-velvia__log .lm-vmsg--velvia:not(.lm-vmsg--typing)').length >= 2);
  const reply = await velviaReplies(page).last().textContent();
  assert.match(reply, /Colin Levy/, 'credits come from the catalog');
  assert.equal(new URL(page.url()).hash, '#/velvia', 'the query is removed so going back does not ask again');

  // "Ask about this" on a suggestion switches the context.
  const next = await ask(page, 'Something calm');
  await next.locator('.lm-vrec').first().waitFor();
  const name = (await next.locator('.lm-vrec__title a').first().textContent()).trim();
  await next.locator('.lm-vrec__actions button[aria-label^="Ask about this"]').first().click();
  await page.waitForFunction((n) => document.querySelector('.lm-velvia__context strong')?.textContent === n, name);
  await page.waitForFunction(() => document.querySelectorAll('.lm-velvia__log .lm-vmsg--user').length === 3);
  await page.click('.lm-velvia__context-clear');
  assert.ok(await page.locator('.lm-velvia__context').isHidden());
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('server: the title-page panel answers from the title’s catalog details', async () => {
  const page = await newPage(browser, { base: app.base });
  await page.goto(`${app.base}/#/title/sintel`);
  await page.waitForSelector('#velvia');
  assert.match(await page.textContent('#velvia h2'), /Ask Velvia about Sintel/);
  assert.equal(await page.locator('#velvia .lm-chip--velvia').count(), 8);

  await page.click('#velvia .lm-chip--velvia >> text=Soundtrack');
  await page.waitForSelector('#velvia .lm-vpanel__reply');
  assert.match(await page.textContent('#velvia .lm-vpanel__text'), /credited to Jan Morgenstern/);
  assert.match(await page.textContent('#velvia .lm-vpanel__provider'), new RegExp(`Grounded in the Lumina catalog · ${ENGINE}`));

  await page.click('#velvia .lm-chip--velvia >> text=Is it right for kids?');
  await page.waitForSelector('#velvia .lm-vmini');
  assert.match(await page.textContent('#velvia .lm-vpanel__text'), /rated TV-14/);
  const minis = await page.$$eval('#velvia .lm-vmini__title', (as) => as.map((a) => a.getAttribute('href')));
  const byId = new Map((await app.client().get('/api/titles?pageSize=100')).body.items.map((x) => [x.id, x]));
  for (const href of minis) {
    const id = idFrom(href, '#/title/');
    assert.ok(byId.has(id), id);
    assert.ok(byId.get(id).minAge <= 8, `${id} suits younger viewers`);
  }

  // Typed questions work too; "Continue with Velvia" carries the exchange and the context.
  await page.fill('#velvia .lm-vpanel__input', 'How long is it?');
  await page.press('#velvia .lm-vpanel__input', 'Enter');
  await page.waitForFunction(() => /runs 15 minutes/.test(document.querySelector('#velvia .lm-vpanel__text')?.textContent || ''));
  await page.click('#velvia .lm-vpanel__continue');
  await page.waitForSelector('.lm-velvia__context:not([hidden])');
  assert.match(await page.textContent('.lm-velvia__context'), /Asking about Sintel/);
  assert.equal(await page.locator('.lm-velvia__log .lm-vmsg--user').count(), 3);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('server: the compare-page panel chooses by the stated preference', async () => {
  const page = await newPage(browser, { base: app.base });
  await page.goto(`${app.base}/#/compare?ids=sintel,hanami,tears-of-steel`);
  await page.waitForSelector('.lm-vpanel--compare');
  await page.fill('.lm-vpanel--compare input', 'I prefer shorter, visually striking films');
  await page.click('.lm-vpanel--compare button[type=submit]');
  await page.waitForSelector('.lm-vpanel--compare .lm-vmini');
  assert.match(await page.textContent('.lm-vpanel--compare .lm-vpanel__text'), /I’d choose Hanami/);
  const ranked = await page.$$eval('.lm-vpanel--compare .lm-vmini__title', (as) => as.map((a) => a.getAttribute('href')));
  assert.deepEqual(ranked.map((h) => idFrom(h, '#/title/')).sort(), ['hanami', 'sintel', 'tears-of-steel']);
  assert.equal(idFrom(ranked[0], '#/title/'), 'hanami');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('server: a kids profile only ever sees titles within its age limit', async () => {
  const kid = await app.userClient({ maxAge: 7, displayName: 'Kai' });
  const visible = new Set((await kid.get('/api/titles?pageSize=100')).body.items.map((x) => x.id));
  assert.ok([...serverIds].some((id) => !visible.has(id)), 'the catalog has titles above the limit');
  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(kid)] });
  await openVelvia(page, app.base);
  // Signed in: the history switch is available and follows the profile's privacy default.
  assert.ok(!(await page.isDisabled('.lm-velvia__history .lm-switch')));
  assert.equal(await page.getAttribute('.lm-velvia__history .lm-switch', 'aria-checked'), 'true');
  for (const q of ['What should I watch tonight?', 'Find a movie with excellent cinematography', 'Recommend something like Tears of Steel']) {
    await ask(page, q);
    const cards = await recLinks(page, '.lm-velvia__log .lm-vmsg--velvia:last-child');
    for (const c of cards) assert.ok(visible.has(idFrom(c.title, '#/title/')), c.title);
  }
  // The switch is remembered for this profile in this tab.
  await page.click('.lm-velvia__history .lm-switch');
  await page.reload();
  await page.waitForSelector('.lm-velvia__log .lm-vmsg--velvia');
  assert.equal(await page.getAttribute('.lm-velvia__history .lm-switch', 'aria-checked'), 'false');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('server: the provider shown is the one that answered, and fallbacks say so', async () => {
  // A conversational provider that answers (with one invented id, which must be dropped).
  const calls = [];
  app.services.velvia.setProvider({
    name: 'anthropic',
    label: 'Anthropic Claude',
    model: 'test-model',
    available: async () => true,
    complete: async (req) => {
      calls.push(req);
      return { text: JSON.stringify({ reply: 'Hanami is a quiet place to begin.', recommendations: [{ titleId: 'interstellar', reason: 'Space' }, { titleId: 'hanami', reason: 'Calm and meditative · 1 min' }], clarifyingQuestion: '', suggestions: ['Something shorter'] }) };
    },
  });
  const page = await newPage(browser, { base: app.base });
  await openVelvia(page, app.base);
  const reply = await ask(page, 'Something calm');
  await reply.locator('.lm-vrec').first().waitFor();
  assert.equal(calls.length, 1);
  assert.match(await page.textContent('.lm-velvia__provider'), /Anthropic Claude/);
  const cards = await recLinks(page, '.lm-velvia__log .lm-vmsg--velvia:last-child');
  assert.deepEqual(cards.map((c) => idFrom(c.title, '#/title/')), ['hanami'], 'the invented id is dropped');
  assert.equal(await reply.locator('.lm-notice').count(), 0);

  // A configured provider that cannot run: the engine answers, with the notice, and the
  // provider note names the engine.
  app.services.velvia.setProvider(null);
  Object.assign(config.velvia, { provider: 'anthropic', apiKey: '', model: '' });
  await page.reload();
  await page.waitForSelector('.lm-velvia__log .lm-vmsg--velvia');
  await page.click('button:has-text("New conversation")');
  const fallback = await ask(page, 'Find a movie with excellent cinematography');
  await fallback.locator('.lm-vrec').first().waitFor();
  assert.equal((await fallback.locator('.lm-notice--warn').textContent()).trim(), FALLBACK_NOTICE);
  assert.match(await page.textContent('.lm-velvia__provider'), new RegExp(ENGINE));
  assertCatalogLinks(await recLinks(page, '.lm-velvia__log .lm-vmsg--velvia:last-child'), serverIds);

  // The title panel shows the same honesty.
  await page.goto(`${app.base}/#/title/hanami`);
  await page.waitForSelector('#velvia');
  await page.click('#velvia .lm-chip--velvia >> text=Themes');
  await page.waitForSelector('#velvia .lm-vpanel__reply');
  assert.equal((await page.textContent('#velvia .lm-notice--warn')).trim(), FALLBACK_NOTICE);
  assert.match(await page.textContent('#velvia .lm-vpanel__provider'), new RegExp(ENGINE));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('server: phone layout has no horizontal overflow', async () => {
  const page = await newPage(browser, { base: app.base, viewport: { width: 390, height: 844 } });
  await openVelvia(page, app.base);
  const reply = await ask(page, 'What should I watch tonight?');
  await reply.locator('.lm-vrec').first().waitFor();
  await reply.locator('.lm-vrec__actions button[aria-label^="Compare "]').nth(0).click();
  await reply.locator('.lm-vrec__actions button[aria-label^="Compare "]').nth(1).click();
  await page.waitForSelector('.lm-velvia__tray:not([hidden])');
  const overflow = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    return [...document.querySelectorAll('.lm-velvia *')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width && (r.right > w + 1 || r.left < -1) && !el.closest('.lm-vcompare');
    }).map((el) => el.className);
  });
  assert.deepEqual(overflow, []);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await page.context().close();
});

test('server: the history switch follows the profile’s privacy setting', async () => {
  const user = await app.userClient({ displayName: 'Mio' });
  const put = await user.put(`/api/profiles/${user.profileId}/preferences`, { preferences: { privacy: { useHistoryForRecommendations: false } } });
  assert.equal(put.status, 200);
  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(user)] });
  // A choice stored in this tab before the setting was turned off doesn't count.
  await page.addInitScript((pid) => sessionStorage.setItem(`lumina.velvia.history.${pid}`, 'true'), user.profileId);
  await openVelvia(page, app.base);
  const sw = '.lm-velvia__history .lm-switch';
  assert.ok(await page.isDisabled(sw), 'the switch cannot be turned on here');
  assert.equal(await page.getAttribute(sw, 'aria-checked'), 'false');
  assert.match(await page.textContent('#velvia-history-hint'), /Turned off in Settings › Privacy/);
  assert.equal(await page.getAttribute('#velvia-history-hint a', 'href'), '#/settings/privacy');
  const sent = page.waitForRequest((r) => r.url().endsWith('/api/velvia/chat'));
  await ask(page, 'Something calm');
  assert.equal(JSON.parse((await sent).postData()).options.useHistory, false);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('server: a panel answer is dropped, not announced, when the viewer leaves the page', async () => {
  const page = await newPage(browser, { base: app.base });
  let failed = 0;
  page.on('requestfailed', (r) => { if (r.url().endsWith('/api/velvia/chat')) failed += 1; });
  await page.route('**/api/velvia/chat', async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue().catch(() => {});
  });
  await page.goto(`${app.base}/#/title/sintel`);
  await page.waitForSelector('#velvia');
  await page.click('#velvia .lm-chip--velvia >> text=Soundtrack');
  await page.evaluate(() => { location.hash = '#/genres'; });
  await page.waitForFunction(() => !document.querySelector('#velvia'));
  await page.waitForTimeout(2500);
  assert.equal(failed, 1, 'the request was cancelled');
  const live = await page.evaluate(() => [...document.querySelectorAll('[aria-live]')].map((n) => n.textContent).join(' | '));
  assert.doesNotMatch(live, /Velvia:|Jan Morgenstern/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('server: on a phone every Velvia control is a 44px touch target and the compare tray stays compact', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, ignoreHTTPSErrors: true });
  await context.addInitScript(() => localStorage.setItem('lumina.introSeen', '1'));
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  const page = await context.newPage();
  await openVelvia(page, app.base);
  const reply = await ask(page, 'What should I watch tonight?');
  await reply.locator('.lm-vrec').first().waitFor();
  const compare = reply.locator('.lm-vrec__actions button[aria-label^="Compare "]');
  for (let i = 0; i < 3; i++) await compare.nth(i).tap();
  await reply.locator('.lm-vrec__actions button[aria-label^="Ask about this"]').first().tap();
  await page.waitForSelector('.lm-velvia__context:not([hidden])');
  const small = await page.evaluate(() => {
    const out = [];
    const sel = '.lm-vrec__actions .lm-btn, .lm-chip--velvia, .lm-velvia__tray-remove, .lm-velvia__context-clear, .lm-velvia__tray-actions .lm-btn';
    for (const el of document.querySelectorAll(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.width < 44 || r.height < 44)) out.push(`${el.className} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    // The switch keeps its look; its touch area reaches 44px.
    const swEl = document.querySelector('.lm-velvia__history .lm-switch');
    swEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    const sw = swEl.getBoundingClientRect();
    for (const [x, y] of [[sw.left + sw.width / 2, sw.top - 7], [sw.left + sw.width / 2, sw.bottom + 7]]) {
      if (!document.elementFromPoint(x, y)?.closest('.lm-switch')) out.push(`switch area misses ${Math.round(x)},${Math.round(y)}`);
    }
    return out;
  });
  assert.deepEqual(small, []);
  const tray = await page.locator('.lm-velvia__tray').boundingBox();
  assert.ok(tray.height <= 120, `the tray is ${Math.round(tray.height)}px tall`);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth));
  await context.close();
});

// ───────────────────────── Preview mode ─────────────────────────

test('Preview: the Velvia page and both panels run on the built-in engine in the page', async () => {
  const ids = new Set(PREVIEW_CATALOG.map((x) => x.id));
  const page = await newPage(browser, { base: stat.base });
  await openVelvia(page, stat.base);
  assert.equal(await page.getAttribute('html', 'data-mode'), 'static');
  await page.waitForFunction((label) => document.querySelector('.lm-velvia__provider')?.textContent.includes(label), ENGINE);

  await page.click('.lm-chip--velvia >> text=Something for a family movie night');
  await velviaReplies(page).last().locator('.lm-vrec').first().waitFor();
  const cards = await recLinks(page, '.lm-velvia__log .lm-vmsg--velvia:last-child');
  assertCatalogLinks(cards, ids);
  for (const c of cards) assert.ok(PREVIEW_CATALOG.find((x) => x.id === idFrom(c.title, '#/title/')).minAge <= 8);

  const unknown = await ask(page, 'Is Dune on Lumina?');
  assert.match(await unknown.textContent(), /“Dune” isn’t available on Lumina/);
  assert.equal(await unknown.locator('.lm-vrec').count(), 0);

  await page.goto(`${stat.base}/#/title/sintel`);
  await page.waitForSelector('#velvia');
  await page.click('#velvia .lm-chip--velvia >> text=Cast & crew');
  await page.waitForSelector('#velvia .lm-vpanel__reply');
  assert.match(await page.textContent('#velvia .lm-vpanel__text'), /Colin Levy/);
  assert.match(await page.textContent('#velvia .lm-vpanel__provider'), new RegExp(ENGINE));

  await page.goto(`${stat.base}/#/compare?ids=sintel,hanami`);
  await page.waitForSelector('.lm-vpanel--compare');
  await page.click('.lm-vpanel--compare button[type=submit]');
  await page.waitForSelector('.lm-vpanel--compare .lm-vpanel__reply');
  assert.match(await page.textContent('.lm-vpanel--compare .lm-vpanel__text'), /Here’s how Sintel and Hanami compare/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

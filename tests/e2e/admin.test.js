// Administration, notifications and legal pages in the browser: who may open the dashboard
// (members are refused before any staff data is requested; staff confirm their password
// first), the main dashboard sections, artwork upload in the title editor, the notification
// centre, and the legal drafts in Preview mode — including proof that markup in a legal
// document can never run script.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { startApp, startStaticServer, startBrowser, newPage, sessionCookie } from './helpers.js';

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

/** Opens admin.html as `client`, recording every /api/admin request the page makes. */
async function openAdmin(client, hash = '#/') {
  const page = await newPage(browser, { base: app.base, cookies: client ? [sessionCookie(client)] : [] });
  page.adminRequests = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname.startsWith('/api/admin')) page.adminRequests.push(r.url());
  });
  await page.goto(`${app.base}/admin.html${hash}`);
  return page;
}

test('a member opening admin.html sees Access denied and no staff data is requested', async () => {
  const member = await app.userClient({ email: 'member.e2e@example.com', displayName: 'Mina Member' });
  const page = await openAdmin(member, '#/users');
  await page.waitForSelector('.adm-gate h1');
  assert.match(await page.textContent('.adm-gate .lm-eyebrow'), /Access denied/);
  assert.match(await page.textContent('.adm-gate h1'), /This area is for Lumina staff/);
  assert.match(await page.textContent('.adm-gate'), /member\.e2e@example\.com/);
  await page.waitForTimeout(300);
  assert.deepEqual(page.adminRequests, [], 'no /api/admin request is made for a member');
  assert.equal(await page.$('.adm-sidebar'), null, 'the dashboard shell is not rendered');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('staff without a recent confirmation get the re-auth form, and confirming opens the Overview', async () => {
  const mod = await app.userClient({ role: 'moderator', elevated: false, email: 'mod.e2e@example.com', displayName: 'Mori Moderator', password: 'lantern garden path' });
  const page = await openAdmin(mod);
  await page.waitForSelector('.adm-reauth input[name="password"]');
  assert.match(await page.textContent('.adm-gate h1'), /Confirm it’s you/);
  assert.match(await page.textContent('.adm-reauth__who'), /mod\.e2e@example\.com/);
  assert.equal(await page.$('.adm-sidebar'), null, 'no dashboard before the password is confirmed');

  // An empty submit is caught in the browser; a wrong password is refused by the server.
  await page.click('.adm-reauth button[type="submit"]');
  assert.match(await page.locator('.adm-reauth .lm-field').first().textContent(), /Enter your password/);
  await page.fill('.adm-reauth input[name="password"]', 'not the password');
  await page.click('.adm-reauth button[type="submit"]');
  await page.waitForSelector('.adm-reauth__error:not([hidden])');
  assert.equal(await page.$('.adm-sidebar'), null);

  await page.fill('.adm-reauth input[name="password"]', 'lantern garden path');
  await page.click('.adm-reauth button[type="submit"]');
  await page.waitForSelector('.adm-stat');
  assert.match(await page.textContent('h1'), /^Good (morning|afternoon|evening), Mori$/);
  assert.match(await page.textContent('.adm-elev__text'), /^1[45]:\d\d$/, 'the elevation countdown shows the 15-minute window');
  assert.equal(await page.getAttribute('.adm-nav__link[data-path="/"]', 'aria-current'), 'page');
  const session = app.db.get('SELECT elevated_until FROM sessions WHERE account_id = ?', mod.accountId);
  assert.ok(session.elevated_until > new Date().toISOString(), 'the session is elevated on the server');
  // Moderators see admin-only sections as locked, and opening one requests nothing.
  assert.ok(await page.$('.adm-nav__link[data-path="/audit"] .adm-nav__lock'));
  const before = page.adminRequests.length;
  await page.click('.adm-nav__link[data-path="/audit"]');
  await page.waitForSelector('text=Administrators only');
  assert.ok(!page.adminRequests.slice(before).some((u) => u.includes('/api/admin/audit')));
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('an elevated admin can open Content, Users and the Audit log', async () => {
  const admin = await app.userClient({ role: 'admin', elevated: true, email: 'admin.e2e@example.com', displayName: 'Aki Admin' });
  // A real privileged action, so the audit log has something to show.
  const patch = await admin.patch('/api/admin/titles/hanami', { editorialRank: 3 });
  assert.equal(patch.status, 200);

  const page = await openAdmin(admin);
  await page.waitForSelector('.adm-stat');

  await page.click('.adm-nav__link[data-path="/content"]');
  await page.waitForSelector('.adm-table >> text=Hanami');
  assert.equal(await page.textContent('h1'), 'Content');
  assert.equal(await page.getAttribute('.adm-nav__link[data-path="/content"]', 'aria-current'), 'page');
  assert.match(await page.title(), /^Content · Lumina Admin$/);

  await page.click('.adm-nav__link[data-path="/users"]');
  await page.waitForSelector('.adm-table >> text=admin.e2e@example.com');
  assert.equal(await page.textContent('h1'), 'Users');
  await page.fill('input[name="q"]', 'admin.e2e');
  await page.waitForFunction(() => document.querySelectorAll('.adm-table tbody tr').length === 1);
  assert.match(page.url(), /#\/users\?q=admin\.e2e$/, 'filters are kept in the address');

  await page.click('.adm-nav__link[data-path="/audit"]');
  await page.waitForSelector('.adm-table >> text=content.title_update');
  assert.equal(await page.textContent('h1'), 'Audit log');
  const row = page.locator('.adm-table tbody tr', { hasText: 'content.title_update' }).first();
  assert.match(await row.textContent(), /admin\.e2e@example\.com/);
  assert.match(await row.textContent(), /title hanami/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

/** A small, valid PNG (solid colour) so the browser can decode the uploaded preview. */
function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

test('the title editor uploads poster artwork through the uploads API and saves its path', async () => {
  const admin = await app.userClient({ role: 'admin', elevated: true, email: 'art.e2e@example.com', displayName: 'Ayu Artwork' });
  const created = await admin.post('/api/admin/titles', { type: 'movie', title: 'Lantern Study' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.title.id;

  const page = await openAdmin(admin, `#/content/${id}`);
  await page.waitForSelector('.adm-artupload');
  const poster = page.locator('.adm-artupload input[type=file]').first();
  // Anything that is not an image is refused in the browser, without an upload or an edit.
  await poster.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') });
  await page.waitForSelector('.adm-artupload__status[data-tone="error"]');
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM uploads WHERE account_id = ?', admin.accountId).n, 0);
  assert.ok(await page.isDisabled('button:has-text("Save changes")'), 'choosing a file is not an edit');

  await poster.setInputFiles({ name: 'lantern-poster.png', mimeType: 'image/png', buffer: solidPng(40, 60, [120, 27, 50]) });
  await page.waitForSelector('.adm-artupload__status[data-tone="ok"]');
  assert.match(await page.textContent('.adm-artupload__status'), /Uploaded lantern-poster\.png \(40 × 60\)/);
  const path = await page.inputValue('input[name="poster"]');
  assert.match(path, /^media\/art\/upl_[0-9a-z]{20}\.png$/);
  await page.waitForFunction(() => document.querySelector('.adm-artpreview img')?.naturalWidth === 40);
  const upload = app.db.get('SELECT status, purpose, file_role FROM uploads WHERE account_id = ?', admin.accountId);
  assert.deepEqual({ ...upload }, { status: 'complete', purpose: 'artwork', file_role: 'poster' });
  assert.equal(app.db.get('SELECT poster FROM titles WHERE id = ?', id).poster, null, 'nothing changes until the title is saved');

  await page.click('button:has-text("Save changes")');
  await page.waitForFunction(() => document.querySelector('.adm-savebar__state')?.textContent === 'All changes saved');
  assert.equal(app.db.get('SELECT poster FROM titles WHERE id = ?', id).poster, path);
  assert.ok(app.db.get(`SELECT 1 FROM audit_log WHERE action = 'media.artwork_uploaded' AND actor_account_id = ?`, admin.accountId));
  const served = await fetch(`${app.base}/${path}`);
  assert.equal(served.status, 200);
  assert.equal(served.headers.get('content-type'), 'image/png');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Preview mode: /legal/terms renders the draft with a Draft badge and contents, and document scripts never run', async () => {
  const page = await newPage(browser, { base: stat.base });
  await page.goto(`${stat.base}/#/legal/terms`);
  await page.waitForSelector('.lm-legal-doc h2');
  assert.equal(await page.getAttribute('html', 'data-mode'), 'static');
  assert.equal(await page.textContent('h1'), 'Terms of Service');
  assert.equal(await page.$$eval('h1', (els) => els.length), 1);
  assert.equal(await page.textContent('.lm-page-header .lm-badge'), 'Draft');
  assert.match(await page.textContent('.lm-legal-doc .lm-notice'), /Draft for legal review — not yet in effect/);
  const toc = await page.$$eval('[data-legal-toc] nav a', (as) => as.map((a) => a.textContent));
  assert.ok(toc.length >= 10, `table of contents lists the sections (${toc.length})`);
  assert.equal(toc[0], '1. About these terms');
  // Contents links scroll within the page.
  await page.click('[data-legal-toc] nav a >> text=10. Suspension and termination');
  await page.waitForFunction(() => document.activeElement?.id === 'legal-suspension');
  assert.match(page.url(), /#\/legal\/terms\?s=suspension$/);
  assert.deepEqual(page.errors, []);
  await page.context().close();

  // The same page with hostile markup appended to the document: nothing in it may execute.
  const hostile = await newPage(browser, { base: stat.base });
  await hostile.route('**/content/legal/terms.html', async (route) => {
    const original = await route.fetch();
    const html = `${await original.text()}
      <h2 id="extra">Extra section</h2>
      <script>window.__legalPwned = 'script'</script>
      <img src="x" onerror="window.__legalPwned = 'img'">
      <p id="clicky" onclick="window.__legalPwned = 'onclick'">Click me</p>
      <a id="jslink" href="javascript:window.__legalPwned = 'href'">Run</a>
      <a id="datalink" href="data:text/html,<script>alert(1)</script>">Data</a>
      <iframe srcdoc="<script>parent.__legalPwned = 'iframe'</script>"></iframe>
      <svg><script>window.__legalPwned = 'svg'</script></svg>
      <style>body { display: none }</style>
      <form action="https://evil.example"><button>Send</button></form>`;
    await route.fulfill({ status: 200, contentType: 'text/html', body: html });
  });
  await hostile.goto(`${stat.base}/#/legal/terms`);
  await hostile.waitForSelector('#legal-extra');
  await hostile.click('#legal-clicky');
  await hostile.click('#legal-jslink');
  await hostile.waitForTimeout(400);
  assert.equal(await hostile.evaluate(() => window.__legalPwned), undefined);
  const leftovers = await hostile.$$eval('.lm-legal-doc', ([doc]) => ({
    // (The only SVGs allowed are Lumina's own icons in the draft notices.)
    dangerous: [...doc.querySelectorAll('script, style, iframe, img, svg, form, button, [onclick], [onerror]')].filter((el) => !(el.localName === 'svg' && el.parentElement.classList.contains('lm-notice'))).length,
    jsHref: doc.querySelector('#legal-jslink')?.getAttribute('href') ?? null,
    jsTag: doc.querySelector('#legal-jslink')?.tagName ?? null,
    dataHref: [...doc.querySelectorAll('a')].some((a) => a.getAttribute('href')?.startsWith('data:')),
  }));
  assert.deepEqual(leftovers, { dangerous: 0, jsHref: null, jsTag: 'SPAN', dataHref: false });
  assert.equal(await hostile.evaluate(() => getComputedStyle(document.body).display), 'block');
  assert.deepEqual(hostile.errors, []);
  await hostile.context().close();
});

test('the notification centre lists a notification created with notify(), and mark-all-read clears the unread count', async () => {
  const { notify } = await import('../../server/services/notifications.js');
  const member = await app.userClient({ email: 'notify.e2e@example.com', displayName: 'Nao Viewer' });
  const id = notify(app.db, {
    accountId: member.accountId,
    type: 'new_episode',
    title: 'New episode of “Garden Hours”',
    body: 'S2 · E2 — Lantern Walk',
    link: '#/title/garden-hours',
    dedupeKey: 'e2e:new_episode:garden-hours-s2e2',
  });
  assert.ok(id, 'notify() created the notification');

  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(member)] });
  await page.goto(`${app.base}/#/notifications`);
  const item = page.locator('li.lm-notif', { hasText: 'New episode of “Garden Hours”' });
  await item.waitFor();
  assert.match(await item.textContent(), /S2 · E2 — Lantern Walk/);
  assert.match(await item.textContent(), /New episode/);
  assert.ok(await item.evaluate((li) => li.classList.contains('is-unread')));
  assert.equal(await item.locator('a', { hasText: 'Open' }).getAttribute('href'), '#/title/garden-hours');
  await page.waitForSelector('.lm-count-badge:not([hidden])');
  assert.equal(await page.textContent('.lm-count-badge'), '1');
  assert.match(await page.textContent('.lm-page'), /1 unread notification/);

  await page.click('button:has-text("Mark all as read")');
  await page.waitForSelector('.lm-count-badge', { state: 'hidden' });
  await page.waitForFunction(() => !document.querySelector('li.lm-notif.is-unread'));
  assert.match(await page.textContent('.lm-page'), /No unread notifications/);
  assert.ok(await page.isDisabled('button:has-text("Mark all as read")'));
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read_at IS NULL', member.accountId).n, 0);
  // The unread filter now shows the caught-up state.
  await page.click('.lm-segmented button:has-text("Unread")');
  await page.waitForSelector('text=You’re all caught up');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

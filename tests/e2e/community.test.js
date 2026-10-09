// Community and creators in the browser: writing a review with the spoiler flag, marking another
// review helpful and reporting one; then a creator application, the submission wizard with a
// resumable upload (one part is lost on the network and retried) and the rights attestation,
// ending with the submission waiting for a person on the Lumina team. Also checks that these
// areas explain themselves in Preview mode instead of pretending to work.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startApp, startStaticServer, startBrowser, newPage, sessionCookie } from './helpers.js';

let app;
let stat;
let browser;
let config;
let tmp;
before(async () => {
  app = await startApp();
  stat = await startStaticServer();
  browser = await startBrowser();
  ({ config } = await import('../../server/config.js'));
  tmp = mkdtempSync(join(tmpdir(), 'lumina-e2e-community-'));
});
after(async () => {
  await browser?.close();
  await stat?.close();
  await app?.close();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const TITLE = 'hanami';

/** Opens a title page signed in as `client` and waits for the reviews panel to load. */
async function openReviews(client, viewport) {
  const page = await newPage(browser, { base: app.base, viewport, cookies: client ? [sessionCookie(client)] : [] });
  await page.goto(`${app.base}/#/title/${TITLE}`);
  await page.waitForSelector('#reviews');
  await page.locator('#reviews').scrollIntoViewIfNeeded();
  await page.waitForSelector('#reviews .lm-reviews__list[aria-busy="false"]', { state: 'attached' });
  return page;
}

const reviewCard = (page, author) => page.locator('#reviews article.lm-review', { has: page.locator('.lm-review__name', { hasText: new RegExp(`^${author}$`) }) });

test('write a review with a spoiler flag, mark another helpful and report one', async () => {
  const ren = await app.userClient({ displayName: 'Ren' });
  const mika = await app.userClient({ displayName: 'Mika' });
  const aiko = await app.userClient({ displayName: 'Aiko' });
  assert.equal((await ren.post(`/api/titles/${TITLE}/reviews`, { rating: 5, body: 'The lanterns are lit one by one in the background; patient and beautiful work.' })).status, 200);
  assert.equal((await mika.post(`/api/titles/${TITLE}/reviews`, { rating: 3, body: 'The final shot changes everything you saw before it, and the last lantern goes out.', containsSpoilers: true })).status, 200);

  const page = await openReviews(aiko);
  // Others' spoiler reviews stay blurred until revealed.
  const mikaCard = reviewCard(page, 'Mika');
  assert.equal(await mikaCard.locator('.lm-spoiler.is-hidden').count(), 1);
  assert.equal(await mikaCard.locator('.lm-review__text').getAttribute('aria-hidden'), 'true');
  await mikaCard.getByRole('button', { name: 'Reveal' }).click();
  assert.equal(await mikaCard.locator('.lm-spoiler.is-hidden').count(), 0);

  // Compose: 4 stars, text, spoiler flag.
  const form = page.locator('#reviews form.lm-reviews__form');
  await form.locator('.lm-star-input label:nth-of-type(4)').click();
  await form.locator('textarea[name="body"]').fill('Quiet and luminous. The score sits so low you feel it more than hear it — and the ending surprised me.');
  await form.locator('input[name="containsSpoilers"]').check();
  await form.getByRole('button', { name: 'Post review' }).click();
  const mine = page.locator('#reviews .lm-reviews__mine');
  await mine.waitFor();
  assert.match(await mine.textContent(), /Aiko \(you\)/);
  assert.match(await mine.textContent(), /Spoilers/);
  const row = app.db.get('SELECT rating, contains_spoilers, status FROM reviews WHERE title_id = ? AND account_id = ?', TITLE, aiko.accountId);
  assert.deepEqual({ ...row }, { rating: 4, contains_spoilers: 1, status: 'visible' });

  // Helpful on Ren's review: pressed state and the server's count.
  const helpful = reviewCard(page, 'Ren').locator('.lm-review__helpful');
  // The button updates optimistically, so wait for the server to answer before reading the database.
  const voted = page.waitForResponse((r) => /\/api\/reviews\/[^/]+\/helpful$/.test(r.url()) && r.request().method() === 'PUT');
  await helpful.click();
  assert.equal((await voted).status(), 200);
  await page.waitForFunction(() => [...document.querySelectorAll('#reviews .lm-review__helpful')].some((b) => b.getAttribute('aria-pressed') === 'true' && /Helpful · 1/.test(b.textContent)));
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM review_votes WHERE account_id = ?', aiko.accountId).n, 1);

  // Report Mika's review through the menu and the reason dialog.
  const card = reviewCard(page, 'Mika');
  await card.locator('.lm-review__menu-btn').click();
  await card.getByRole('menuitem', { name: 'Report review' }).click();
  const dialog = page.locator('dialog.lm-modal[open]');
  await dialog.waitFor();
  await dialog.locator('input[type="radio"][value="spoilers"]').check();
  await dialog.locator('textarea[name="details"]').fill('The ending is described in detail.');
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await page.waitForSelector('#lm-toasts .lm-toast--success');
  const report = app.db.get(`SELECT target_type, reason, details, status FROM reports WHERE reporter_account_id = ?`, aiko.accountId);
  assert.deepEqual({ ...report }, { target_type: 'review', reason: 'spoilers', details: 'The ending is described in detail.', status: 'open' });

  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('signed-out visitors see the reviews and a prompt to sign in', async () => {
  const page = await openReviews(null, { width: 390, height: 844 });
  await page.waitForSelector('#reviews .lm-reviews__prompt');
  assert.equal(await page.locator('#reviews form.lm-reviews__form').count(), 0);
  assert.ok(await page.locator('#reviews .lm-review').count() >= 1);
  // No horizontal overflow on a phone.
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  await page.context().close();
});

// A small but structurally valid MP4: ftyp + moov (one H.264 video track) + mdat.
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16BE(n); return b; };
const box = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([u32(8 + body.length), Buffer.from(type, 'latin1'), body]); };
const full = (type, ...parts) => box(type, Buffer.from([0, 0, 0, 0]), ...parts);
function smallMp4(payloadBytes) {
  const tkhd = full('tkhd', u32(0), u32(0), u32(1), u32(0), u32(2000), Buffer.alloc(16), Buffer.alloc(36), u32(1280 << 16), u32(720 << 16));
  const mdhd = full('mdhd', u32(0), u32(0), u32(1000), u32(2000), u16(0x55c4), u16(0));
  const hdlr = full('hdlr', u32(0), Buffer.from('vide'), Buffer.alloc(12), Buffer.from('VideoHandler\0'));
  const avc1 = box('avc1', Buffer.alloc(6), u16(1), Buffer.alloc(16), u16(1280), u16(720), Buffer.alloc(50));
  const trak = box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', box('stbl', full('stsd', u32(1), avc1)))));
  const moov = box('moov', full('mvhd', u32(0), u32(0), u32(1000), u32(2000), Buffer.alloc(80)), trak);
  return Buffer.concat([box('ftyp', Buffer.from('isom'), u32(512), Buffer.from('isomavc1')), moov, box('mdat', randomBytes(payloadBytes))]);
}

test('creator: apply, then a submission with a resumable upload and rights, sent for human review', async () => {
  const kenji = await app.userClient({ displayName: 'Kenji' });
  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(kenji)] });

  // 1. Apply on the Creators page.
  await page.goto(`${app.base}/#/creators`);
  const apply = page.locator('#apply');
  await apply.locator('input[name="legalName"]').waitFor();
  await apply.locator('input[name="legalName"]').fill('Kenji Watanabe');
  await apply.locator('input[name="contactEmail"]').fill('kenji@example.com');
  await apply.locator('input[name="country"]').fill('jp');
  await apply.locator('textarea[name="bio"]').fill('Documentary filmmaker from Kyoto; my shorts about craft and gardens have screened at small festivals.');
  await apply.getByRole('button', { name: 'Send application' }).click();
  await apply.locator('.lm-badge', { hasText: 'Waiting for review' }).waitFor();
  const application = app.db.get('SELECT id, status, country FROM creator_applications WHERE account_id = ?', kenji.accountId);
  assert.equal(application.status, 'pending');
  assert.equal(application.country, 'JP');

  // A person on the Lumina team approves the application (the admin API does exactly this).
  app.db.run(`UPDATE creator_applications SET status = 'approved', reviewed_at = ? WHERE id = ?`, new Date().toISOString(), application.id);
  app.db.run('UPDATE accounts SET is_creator = 1 WHERE id = ?', kenji.accountId);

  // 2. Dashboard → new draft.
  await page.goto(`${app.base}/#/creators/dashboard`);
  await page.getByRole('button', { name: 'New submission' }).first().click();
  const dialog = page.locator('dialog.lm-modal[open]');
  await dialog.locator('input[name="projectTitle"]').fill('Moss and Stone');
  await dialog.locator('select[name="contentType"]').selectOption('documentary');
  await dialog.locator('textarea[name="description"]').fill('Three seasons with the gardeners who keep a moss garden alive in Kyoto.');
  await dialog.getByRole('button', { name: 'Create draft' }).click();
  await page.waitForFunction(() => /^#\/creators\/submissions\/sub_/.test(location.hash));
  const submissionId = /submissions\/(sub_[0-9a-z]+)/.exec(page.url())[1];

  // Step 1: project details.
  await page.locator('input[name="runtimeMin"]').fill('24');
  await page.locator('select[name="language"]').selectOption('ja');
  await page.getByRole('button', { name: 'Save details' }).click();
  await page.waitForSelector('.lm-stepper__item.is-done');
  assert.equal(app.db.get('SELECT runtime_min, language FROM submissions WHERE id = ?', submissionId).language, 'ja');

  // Step 2: a resumable upload in several parts; one part is lost on the network and retried.
  config.uploads.chunkMaxBytes = 64 * 1024;
  const video = smallMp4(220_000);
  const file = join(tmp, 'moss-and-stone.mp4');
  writeFileSync(file, video);
  let patches = 0;
  let dropped = 0;
  await page.route(/\/api\/uploads\/upl_[0-9a-z]+$/, async (route) => {
    if (route.request().method() === 'PATCH' && ++patches === 2) {
      dropped++;
      return route.abort('connectionreset');
    }
    return route.continue();
  });
  await page.getByRole('button', { name: /Next: files/ }).click();
  await page.waitForSelector('.lm-dropzone');
  assert.equal(await page.locator('.lm-role-picker input[value="feature"]').isChecked(), true);
  await page.setInputFiles('.lm-uploader input[type="file"]', file);
  // While it runs, the device remembers the upload so it can resume after a reload.
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('lumina.uploads.resume') || '[]')).length === 1);
  await page.waitForSelector('.lm-upload[data-state="done"]', { timeout: 30_000 });
  assert.equal(dropped, 1);
  assert.ok(patches >= 5, `expected several parts, saw ${patches} PATCH requests`);
  assert.equal(await page.evaluate(() => (JSON.parse(localStorage.getItem('lumina.uploads.resume') || '[]')).length), 0);
  const stored = app.db.get('SELECT role, sha256, size_bytes, scan_status FROM submission_files WHERE submission_id = ?', submissionId);
  assert.equal(stored.role, 'feature');
  assert.equal(stored.size_bytes, video.length);
  assert.equal(stored.sha256, createHash('sha256').update(video).digest('hex'));
  assert.equal(stored.scan_status, 'not_configured');
  await page.locator('.lm-file-list .lm-file__name', { hasText: 'moss-and-stone.mp4' }).waitFor();

  // Step 3: rights and ownership, with the attestation.
  await page.getByRole('button', { name: /Next: rights/ }).click();
  await page.locator('input[name="rights.copyrightOwner"]').fill('Kenji Watanabe');
  await page.locator('input[name="distributionRights"][value="owner"]').check();
  await page.locator('input[name="musicCleared"][value="yes"]').check();
  await page.locator('input[name="footageCleared"][value="not_applicable"]').check();
  // The attestation links the creator agreement.
  assert.equal(await page.locator('.lm-attest a').getAttribute('href'), '#/legal/creator-agreement');
  await page.locator('.lm-attest input[name="confirm"]').check();
  await page.getByRole('button', { name: 'Confirm rights' }).click();
  await page.locator('h2', { hasText: 'Review & submit' }).waitFor();
  const attested = app.db.get('SELECT rights, attested_at FROM submissions WHERE id = ?', submissionId);
  assert.ok(attested.attested_at);
  assert.equal(JSON.parse(attested.rights).territories[0], 'WW');

  // Step 4: submit → waits for a person; nothing is published.
  const submit = page.getByRole('button', { name: 'Submit for review' });
  assert.equal(await submit.isEnabled(), true);
  await submit.click();
  await page.locator('.lm-submission__head .lm-status[data-status="submitted"]').waitFor();
  assert.match(await page.locator('.lm-submission').textContent(), /Waiting for a person on the Lumina team to review it/);
  const sub = app.db.get('SELECT status, submitted_at, title_id FROM submissions WHERE id = ?', submissionId);
  assert.equal(sub.status, 'submitted');
  assert.ok(sub.submitted_at);
  assert.equal(sub.title_id, null);
  assert.equal(app.db.get('SELECT COUNT(*) AS n FROM titles WHERE submission_id = ?', submissionId).n, 0);
  assert.ok(await page.locator('.lm-timeline__item', { hasText: 'Submitted for review.' }).count());

  assert.deepEqual(page.errors.filter((e) => !/NETWORK|Failed to fetch/i.test(e)), []);
  await page.context().close();
});

test('creator: a title awaiting publication links to its submission; a response waits for running uploads, each listed once', async () => {
  const hoshi = await app.userClient({ displayName: 'Studio Hoshi', isCreator: true });
  const { submission } = (await hoshi.post('/api/creators/submissions', { projectTitle: 'Night Garden', contentType: 'short' })).body;
  // An editor turned the submission into a draft title, then asked for a new master.
  const ts = new Date().toISOString();
  const draftId = `night-garden-${Date.now()}`;
  app.db.run(`INSERT INTO titles (id, type, title, status, added_at, updated_at, creator_account_id) VALUES (?, 'movie', 'Night Garden', 'draft', ?, ?, ?)`, draftId, ts, ts, hoshi.accountId);
  app.db.run(`UPDATE submissions SET title_id = ?, status = 'info_required', status_reason = 'Please upload a new master.' WHERE id = ?`, draftId, submission.id);
  // An upload started on another device (not remembered in this browser).
  const other = (await hoshi.post('/api/uploads', { filename: 'from-laptop.mp4', size: 9_000_000, purpose: 'submission', submissionId: submission.id, role: 'trailer' })).body;
  assert.ok(other.id);

  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(hoshi)] });
  await page.goto(`${app.base}/#/creators/dashboard`);
  const tile = page.locator('.lm-studio-title', { hasText: 'Night Garden' });
  await tile.waitFor();
  // A draft title has no page members (or its creator) can open yet: it links to the submission.
  assert.equal(await tile.locator('a.lm-studio-title__name').getAttribute('href'), `#/creators/submissions/${submission.id}`);
  assert.match(await tile.textContent(), /Awaiting publication/);
  await tile.locator('a.lm-studio-title__name').click();
  await page.locator('.lm-submission__request').waitFor();

  // Start a new master upload and hold its first part on the network.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let first = true;
  await page.route(/\/api\/uploads\/upl_[0-9a-z]+$/, async (route) => {
    if (route.request().method() === 'PATCH' && first) {
      first = false;
      await held;
    }
    return route.continue();
  });
  await page.goto(`${app.base}/#/creators/submissions/${submission.id}?step=files`);
  await page.waitForSelector('.lm-uploader');
  const file = join(tmp, 'night-garden-master.mp4');
  writeFileSync(file, smallMp4(150_000));
  await page.setInputFiles('.lm-uploader input[type="file"]', file);
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('lumina.uploads.resume') || '[]')).length === 1);
  // The upload running here is listed by the uploader only; "Unfinished uploads" shows the other one.
  const unfinished = () => page.$$eval('.lm-submission__block', (blocks) => blocks.filter((b) => /Unfinished uploads/.test(b.textContent)).flatMap((b) => [...b.querySelectorAll('.lm-file__name')].map((e) => e.textContent)));
  await page.waitForFunction(() => [...document.querySelectorAll('.lm-file__name')].some((e) => e.textContent === 'from-laptop.mp4'));
  assert.deepEqual(await unfinished(), ['from-laptop.mp4']);

  // Responding now would lock the files, so the form waits.
  const banner = page.locator('.lm-submission__request');
  await banner.locator('textarea').fill('A new master is on its way.');
  await banner.getByRole('button', { name: 'Send response' }).click();
  await banner.locator('[role="alert"]', { hasText: 'upload is still running' }).waitFor();
  assert.equal(app.db.get('SELECT status FROM submissions WHERE id = ?', submission.id).status, 'info_required');

  release();
  await page.waitForSelector('.lm-upload[data-state="done"]', { timeout: 30_000 });
  await page.locator('.lm-file-list .lm-file__name', { hasText: 'night-garden-master.mp4' }).waitFor();
  // The upload from the other device is still open: the server refuses too, and says so.
  await banner.locator('textarea').fill('A new master is attached.');
  await banner.getByRole('button', { name: 'Send response' }).click();
  await banner.locator('[role="alert"]', { hasText: 'before you send your response' }).waitFor();
  assert.equal(app.db.get('SELECT status FROM submissions WHERE id = ?', submission.id).status, 'info_required');

  // Discard it, then the response goes through.
  await page.locator('.lm-submission__block', { hasText: 'Unfinished uploads' }).getByRole('button', { name: 'Discard' }).click();
  await page.waitForFunction(() => ![...document.querySelectorAll('.lm-file__name')].some((e) => e.textContent === 'from-laptop.mp4'));
  await banner.locator('textarea').fill('A new master is attached.');
  await banner.getByRole('button', { name: 'Send response' }).click();
  await page.waitForFunction((id) => document.querySelector('.lm-submission__head .lm-status')?.dataset.status === 'submitted', submission.id);
  assert.equal(app.db.get('SELECT status FROM submissions WHERE id = ?', submission.id).status, 'submitted');
  assert.equal(app.db.get(`SELECT COUNT(*) AS n FROM submission_files WHERE submission_id = ? AND original_name = 'night-garden-master.mp4'`, submission.id).n, 1);

  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('keyboard: Report and Block dialogs hand focus back; validation errors are announced; a shared collection can be reported', async () => {
  const title = 'sintel';
  const hana = await app.userClient({ displayName: 'Hana' });
  const kenji = await app.userClient({ displayName: 'Kenji' });
  const viewer = await app.userClient({ displayName: 'Sora' });
  assert.equal((await hana.post(`/api/titles/${title}/reviews`, { rating: 4, body: 'The dragon’s flight over the snowfield is breathtaking.' })).status, 200);
  assert.equal((await kenji.post(`/api/titles/${title}/reviews`, { rating: 3, body: 'Short and sad; the last scene stays with you for days.' })).status, 200);

  const page = await newPage(browser, { base: app.base, cookies: [sessionCookie(viewer)] });
  await page.goto(`${app.base}/#/title/${title}`);
  await page.waitForSelector('#reviews .lm-review__menu-btn');
  const focused = () => page.evaluate(() => {
    const a = document.activeElement;
    return { tag: a?.tagName, label: a?.getAttribute('aria-label') || a?.textContent?.trim().slice(0, 60) || '' };
  });
  const trigger = reviewCard(page, 'Hana').locator('.lm-review__menu-btn');

  // Report dialog opened from the menu and closed with Escape: focus is back on the menu button.
  await trigger.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('dialog.lm-modal[open]').waitFor();
  await page.keyboard.press('Escape');
  await page.locator('dialog.lm-modal[open]').waitFor({ state: 'detached' }).catch(() => {});
  await page.waitForFunction(() => document.activeElement?.classList.contains('lm-review__menu-btn'));
  assert.deepEqual(await focused(), { tag: 'BUTTON', label: 'More actions for Hana’s review' });

  // Block confirmation, cancelled: the same.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).waitFor();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement?.classList.contains('lm-review__menu-btn'));
  assert.equal((await focused()).label, 'More actions for Hana’s review');

  // Block confirmed: Hana's review leaves the list and focus continues in the list, not at the top of the page.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.locator('dialog[open]').getByRole('button', { name: 'Block' }).click();
  await reviewCard(page, 'Hana').waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.activeElement && document.activeElement !== document.body && document.activeElement.closest('#reviews'));

  // Posting without a rating: the error is an alert tied to the star group.
  const form = page.locator('#reviews form.lm-reviews__form');
  await form.getByRole('button', { name: 'Post review' }).click();
  const ratingError = await page.evaluate(() => {
    const stars = document.querySelector('#reviews .lm-reviews__form .lm-star-input');
    const err = document.getElementById(stars?.getAttribute('aria-describedby') || '');
    return { text: err?.textContent, role: err?.getAttribute('role'), hidden: err?.hidden };
  });
  assert.deepEqual(ratingError, { text: 'Choose a rating from 1 to 5 stars.', role: 'alert', hidden: false });

  // An empty reply: the textarea is invalid and described by the message, which is an alert.
  await reviewCard(page, 'Kenji').locator('button[aria-controls^="thread"]').click();
  await page.locator('#reviews .lm-reply-form').waitFor();
  await page.locator('#reviews .lm-reply-form button[type=submit]').click();
  const replyError = await page.evaluate(() => {
    const ta = document.querySelector('#reviews .lm-reply-form textarea');
    const err = (ta.getAttribute('aria-describedby') || '').split(' ').map((id) => document.getElementById(id)).find((e) => e?.classList.contains('lm-error-text'));
    return { invalid: ta.getAttribute('aria-invalid'), text: err?.textContent, role: err?.getAttribute('role') };
  });
  assert.deepEqual(replyError, { invalid: 'true', text: 'Write a reply first.', role: 'alert' });

  // A shared collection can be reported from its page (by share token: the page never sees its id).
  const { collection } = (await kenji.post('/api/collections', { name: 'Kenji’s picks', description: '' })).body;
  const shared = (await kenji.patch(`/api/collections/${collection.id}`, { visibility: 'unlisted' })).body.collection;
  await page.goto(`${app.base}/#/shared/${shared.shareToken}`);
  await page.getByRole('button', { name: 'Report this collection' }).click();
  const dialog = page.locator('dialog.lm-modal[open]');
  await dialog.locator('input[type="radio"][value="spam"]').check();
  await dialog.getByRole('button', { name: 'Send report' }).click();
  await page.waitForSelector('#lm-toasts .lm-toast--success');
  const report = app.db.get(`SELECT target_type, target_id, reason FROM reports WHERE reporter_account_id = ? AND target_type = 'collection'`, viewer.accountId);
  assert.deepEqual({ ...report }, { target_type: 'collection', target_id: collection.id, reason: 'spam' });

  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Preview mode explains that reviews and creator tools need the Lumina server', async () => {
  const page = await newPage(browser, { base: stat.base });
  await page.goto(`${stat.base}/#/title/${TITLE}`);
  await page.waitForSelector('#reviews .lm-reviews__preview');
  assert.match(await page.textContent('#reviews .lm-reviews__preview'), /Reviews live on the Lumina server/);
  assert.equal(await page.locator('#reviews form').count(), 0);

  // The Creators page still informs, but does not offer an application it cannot send.
  await page.goto(`${stat.base}/#/creators`);
  await page.waitForSelector('#apply .lm-notice');
  assert.match(await page.textContent('#apply'), /Preview mode/);
  assert.equal(await page.locator('#apply form').count(), 0);
  assert.ok(await page.locator('.lm-steps__item').count() === 6);

  await page.goto(`${stat.base}/#/creators/dashboard`);
  await page.waitForSelector('.lm-server-required');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

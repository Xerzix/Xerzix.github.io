// Player end to end. Server mode unless noted: the Lumina Originals' HLS ladders and their
// quality menus, quality switching, subtitles, keyboard shortcuts, intro/next episode, resume,
// the error overlay and backup sources, Preview mode, and a watch party seen from two browsers.
//
// Codecs: the Originals are H.264/AAC. Chromium builds without proprietary codecs cannot
// decode H.264 through Media Source Extensions. In such a browser each Original's master
// playlist is answered with an equivalent VP9/Opus master that declares exactly the renditions
// the real master declares (read from the file on disk) and points at the test-pattern rungs
// in media/test-fixtures/hls (true 640×360 … 3840×2160 VP9 encodes). Catalog data, sidecar
// subtitles and the player are the real thing. A browser that decodes H.264 plays the real
// Original files untouched.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';
import { startApp, startStaticServer, newPage, sessionCookie } from './helpers.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const ORIGINAL_MASTER = /\/media\/originals\/([^/]+)\/master\.m3u8(\?.*)?$/;
const VP9_RUNGS = {
  360: { res: '640x360', bw: 140000, codec: 'vp09.00.30.08' },
  480: { res: '854x480', bw: 170000, codec: 'vp09.00.30.08' },
  720: { res: '1280x720', bw: 200000, codec: 'vp09.00.31.08' },
  1080: { res: '1920x1080', bw: 280000, codec: 'vp09.00.40.08' },
  2160: { res: '3840x2160', bw: 340000, codec: 'vp09.00.50.08' },
};

/** Heights declared by a master playlist, in playlist order. */
const ladderOf = (text) => [...text.matchAll(/#EXT-X-STREAM-INF:[^\n]*RESOLUTION=\d+x(\d+)/g)].map((m) => Number(m[1]));

/** VP9/Opus master with the same rendition ladder as a real Original master. */
function vp9MasterLike(realText) {
  const out = ['#EXTM3U', '#EXT-X-VERSION:7', '#EXT-X-INDEPENDENT-SEGMENTS',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="audio_0",LANGUAGE="zxx",DEFAULT=YES,AUTOSELECT=YES,CHANNELS="1",URI="/media/test-fixtures/hls/audio_en/index.m3u8"'];
  for (const height of ladderOf(realText)) {
    const r = VP9_RUNGS[height];
    if (!r) throw new Error(`No VP9 test rung for ${height}p`);
    out.push(`#EXT-X-STREAM-INF:BANDWIDTH=${r.bw},RESOLUTION=${r.res},FRAME-RATE=24.000,CODECS="${r.codec},opus",AUDIO="aud"`, `/media/test-fixtures/hls/v${height}/index.m3u8`);
  }
  return `${out.join('\n')}\n`;
}

const realMaster = (id) => readFileSync(`${ROOT}media/originals/${id}/master.m3u8`, 'utf8');

let app;
let stat;
let browser;
let mirror = false;

before(async () => {
  app = await startApp();
  stat = await startStaticServer();
  // A viewer reaches the player by clicking Play, which lets the browser autoplay with sound.
  // Tests open the watch page directly, so the browser is told to allow it.
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
  const probe = await browser.newPage();
  const avc = await probe.evaluate(() => typeof MediaSource !== 'undefined'
    && MediaSource.isTypeSupported('video/mp4; codecs="avc1.640033"')
    && MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"'));
  await probe.close();
  mirror = !avc;
  // Resume needs media longer than the 15 s resume threshold: point Tears of Steel (a remote
  // stream, unreachable in CI) at the 20 s fixture ladder (VP9 360/720/1080p, English and
  // Japanese audio renditions, an HLS subtitle track).
  app.db.run(
    `UPDATE media SET kind = 'hls', source = 'media/test-fixtures/hls/master.m3u8', fallbacks = '[]', variants = '[]',
       audio_tracks = '[]', subtitle_tracks = '[]', duration_s = 20, resolutions = '[1080,720,360]'
     WHERE title_id = 'tears-of-steel' AND role = 'main'`,
  );
});

after(async () => {
  await browser?.close();
  await stat?.close();
  await app?.close();
});

async function open(path, { base = app.base, user = null, viewport } = {}) {
  const page = await newPage(browser, { base, viewport, cookies: user ? [sessionCookie(user)] : [] });
  if (mirror) {
    await page.route(ORIGINAL_MASTER, (route) => {
      const id = ORIGINAL_MASTER.exec(new URL(route.request().url()).pathname)[1];
      route.fulfill({ status: 200, contentType: 'application/vnd.apple.mpegurl', body: vp9MasterLike(realMaster(id)) });
    });
  }
  if (path) await page.goto(base + path);
  return page;
}

const video = (page) => page.evaluate(() => {
  const v = document.querySelector('.lm-player video');
  return v && { t: v.currentTime, paused: v.paused, ended: v.ended, muted: v.muted, volume: v.volume, height: v.videoHeight, width: v.videoWidth, duration: v.duration };
});

const waitPlaying = (page, minT = 0.3, timeout = 15000) => page.waitForFunction((t) => {
  const v = document.querySelector('.lm-player video');
  return v && !v.paused && v.currentTime > t;
}, minT, { timeout });

/** Shows the auto-hiding controls (a real mouse movement over the player). */
async function wake(page) {
  const box = await page.locator('.lm-player').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3);
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 3 + 8);
}

/** Opens a player menu and returns its radio items once at least `min` are present. */
async function openMenu(page, trigger, min = 1) {
  await wake(page);
  await page.click(trigger);
  await page.waitForFunction((n) => document.querySelectorAll('.lm-player__menu:not([hidden]) [role="menuitemradio"]').length >= n, min, { timeout: 15000 });
  return menuItems(page);
}

const menuItems = (page) => page.$$eval('.lm-player__menu:not([hidden]) [role="menuitemradio"]', (els) => els.map((e) => ({
  label: e.querySelector('.lm-player__mi-label').firstChild.textContent,
  checked: e.getAttribute('aria-checked') === 'true',
  group: e.closest('[role="group"]')?.querySelector('.lm-player__mlabel')?.textContent || null,
})));

const pickItem = (page, label) => page.click(`.lm-player__menu:not([hidden]) [role="menuitemradio"]:has(.lm-player__mi-label:text-is("${label}"))`);

/** Waits until the decoded picture has the given height; replays from the start if it ends first. */
async function waitForHeight(page, height, timeout = 20000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const v = await video(page);
    if (v.height === height && !v.paused) return;
    if (v.ended || v.t > v.duration - 1.5) await page.keyboard.press('0');
    await page.waitForTimeout(250);
  }
  assert.fail(`picture never reached ${height}p (now ${(await video(page)).height}p)`);
}

const QUALITY = '.lm-player__btn--text';
const AUDIO_SUBS = '.lm-player__bar [aria-label="Audio & subtitles"]';

test('Hanami plays from its local HLS ladder and the quality menu offers 4K', async () => {
  assert.deepEqual(ladderOf(realMaster('hanami')), [2160, 1080, 720, 480, 360], 'Hanami master ladder');
  const user = await app.userClient({ displayName: 'Aiko' });
  const page = await open('/#/watch/hanami', { user });
  await waitPlaying(page);
  assert.equal(await page.getAttribute('.lm-player', 'data-engine'), 'hls.js');
  assert.equal(await page.textContent('.lm-player__title'), 'Hanami');

  const items = await openMenu(page, QUALITY, 6);
  assert.match(items[0].label, /^Auto/);
  assert.ok(items[0].checked, 'Auto is selected by default');
  assert.deepEqual(items.slice(1).map((i) => i.label), ['4K · 2160p', '1080p', '720p', '480p', '360p']);

  // Manual switches land on the real renditions: the decoded picture changes size.
  await pickItem(page, '360p');
  assert.equal(await page.textContent(`${QUALITY} .lm-player__quality-text`), '360p');
  await waitForHeight(page, 360);
  await openMenu(page, QUALITY, 6);
  await pickItem(page, '4K · 2160p');
  assert.equal(await page.textContent(`${QUALITY} .lm-player__quality-text`), '4K');
  await waitForHeight(page, 2160);
  assert.equal((await video(page)).width, 3840);
  const after = await openMenu(page, QUALITY, 6);
  assert.deepEqual(after.filter((i) => i.checked).map((i) => i.label), ['4K · 2160p']);
  await pickItem(page, after[0].label);
  assert.match(await page.textContent(`${QUALITY} .lm-player__quality-text`), /^Auto/);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Garden Hours and Koyo top out at 1080p; intro skip and the next-episode card work', async () => {
  for (const id of ['garden-hours-s1e1', 'koyo-autumn-pavilion']) assert.equal(Math.max(...ladderOf(realMaster(id))), 1080, `${id} ladder`);
  const user = await app.userClient({ displayName: 'Ren' });
  const page = await open('/#/watch/koyo-autumn-pavilion', { user });
  await waitPlaying(page);
  let labels = (await openMenu(page, QUALITY, 5)).map((i) => i.label);
  assert.deepEqual(labels.slice(1), ['1080p', '720p', '480p', '360p']);
  assert.ok(!labels.some((l) => /4K|2160/.test(l)), labels.join(', '));

  await page.goto(`${app.base}/#/watch/garden-hours?episode=garden-hours-s1e1`);
  await page.waitForFunction(() => document.querySelector('.lm-player__subtitle')?.textContent.startsWith('S1:E1'));
  // Intro (0–3 s): the Skip intro button is offered and S skips it.
  await page.waitForSelector('.lm-player__skip:not([hidden]):has-text("Skip intro")', { timeout: 8000 });
  await page.keyboard.press('s');
  await page.waitForFunction(() => document.querySelector('.lm-player video').currentTime >= 2.9);
  assert.ok(await page.isHidden('.lm-player__skip:has-text("Skip intro")'));
  labels = (await openMenu(page, QUALITY, 5)).map((i) => i.label);
  assert.deepEqual(labels.slice(1), ['1080p', '720p', '480p', '360p']);
  await page.keyboard.press('Escape');

  // Credits: the next-episode card appears; Play now loads S1:E2 in place.
  await page.keyboard.press('8');
  await page.waitForSelector('.lm-player__next', { timeout: 8000 });
  assert.match(await page.textContent('.lm-player__next'), /Next episode.*Moonrise/s);
  await page.click('.lm-player__next button:has-text("Play now")');
  await page.waitForFunction(() => document.querySelector('.lm-player__subtitle')?.textContent.startsWith('S1:E2'));
  assert.match(page.url(), /episode=garden-hours-s1e2/);
  await waitPlaying(page, 0.2);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('English and Japanese subtitles are offered and rendered in the styled overlay', async () => {
  const user = await app.userClient({ displayName: 'Mei' });
  const page = await open('/#/watch/hanami', { user });
  await waitPlaying(page);
  const items = await openMenu(page, AUDIO_SUBS, 3);
  assert.deepEqual(items.filter((i) => i.group === 'Audio').map((i) => [i.label, i.checked]), [['Original score (no dialogue)', true]]);
  assert.deepEqual(items.filter((i) => i.group === 'Subtitles').map((i) => i.label), ['Off', 'English', '日本語 (Japanese)']);

  await pickItem(page, 'English');
  await page.keyboard.press('4'); // 40 %: inside the first cue (5.5–9 s)
  const cue = page.locator('.lm-subs .lm-subs__cue');
  await cue.filter({ hasText: 'The first petals of the season.' }).waitFor({ timeout: 8000 });
  const style = await cue.first().evaluate((el) => {
    const cs = getComputedStyle(el.querySelector('.lm-subs__line') || el);
    const r = el.getBoundingClientRect();
    return { color: cs.color, visible: r.width > 0 && r.height > 0 };
  });
  assert.ok(style.visible);
  assert.equal(style.color, 'rgb(248, 245, 242)'); // default "warm white" style

  await openMenu(page, AUDIO_SUBS, 3);
  await pickItem(page, '日本語 (Japanese)');
  await page.keyboard.press('4');
  await cue.filter({ hasText: '今年最初の花びら。' }).waitFor({ timeout: 8000 });
  // C toggles captions off and back on.
  await page.keyboard.press('c');
  await page.waitForFunction(() => !document.querySelector('.lm-subs .lm-subs__cue'));
  await page.keyboard.press('c');
  await cue.first().waitFor({ timeout: 8000 });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('keyboard shortcuts: space/k, arrows, m and f', async () => {
  const user = await app.userClient({ displayName: 'Sora' });
  const page = await open('/#/watch/hanami', { user });
  await waitPlaying(page, 0.5);
  await page.keyboard.press(' ');
  await page.waitForFunction(() => document.querySelector('.lm-player video').paused);
  assert.equal(await page.getAttribute('.lm-player', 'data-state'), 'paused');
  await page.keyboard.press('k');
  await waitPlaying(page, 0.5);
  await page.keyboard.press('k');
  await page.waitForFunction(() => document.querySelector('.lm-player video').paused);

  const t0 = (await video(page)).t;
  await page.keyboard.press('ArrowRight');
  assert.ok(Math.abs((await video(page)).t - (t0 + 10)) < 0.6, 'ArrowRight jumps 10 s');
  await page.keyboard.press('ArrowLeft');
  assert.ok(Math.abs((await video(page)).t - t0) < 0.6, 'ArrowLeft jumps back 10 s');

  await page.keyboard.press('ArrowDown');
  assert.ok(Math.abs((await video(page)).volume - 0.95) < 0.011);
  await page.keyboard.press('ArrowUp');
  assert.ok(Math.abs((await video(page)).volume - 1) < 0.011);
  await page.keyboard.press('m');
  assert.equal((await video(page)).muted, true);
  await page.waitForSelector('.lm-player__volgroup button[aria-label="Unmute (m)"]');
  await page.keyboard.press('m');
  assert.equal((await video(page)).muted, false);

  await page.keyboard.press('f');
  await page.waitForFunction(() => document.fullscreenElement?.classList.contains('lm-player'));
  // The player mirrors the state from its fullscreenchange handler, which can run a frame later.
  await page.waitForSelector('.lm-player[data-fullscreen="true"]');
  await page.keyboard.press('f');
  await page.waitForFunction(() => !document.fullscreenElement);

  await page.keyboard.press('?');
  await page.waitForSelector('.lm-player__dialog:has-text("Keyboard shortcuts")');
  await page.keyboard.press('Escape');
  await page.waitForSelector('.lm-player__dialog', { state: 'detached' });
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('the resume position survives a reload; audio renditions are switchable', async () => {
  const user = await app.userClient({ displayName: 'Hana' });
  const page = await open('/#/watch/tears-of-steel', { user });
  await waitPlaying(page);

  // Only the stream's real audio renditions are listed, and switching works.
  const items = await openMenu(page, AUDIO_SUBS, 4);
  assert.deepEqual(items.filter((i) => i.group === 'Audio').map((i) => i.label), ['English', '日本語']);
  assert.deepEqual(items.filter((i) => i.group === 'Subtitles').map((i) => i.label), ['Off', 'English (HLS)']);
  await pickItem(page, '日本語');
  await openMenu(page, AUDIO_SUBS, 4);
  await page.waitForFunction(() => [...document.querySelectorAll('.lm-player__menu:not([hidden]) [role="menuitemradio"][aria-checked="true"]')]
    .some((e) => e.querySelector('.lm-player__mi-label').firstChild.textContent === '日本語'));
  await page.keyboard.press('Escape');

  await page.keyboard.press('8'); // 16 s of 20
  await page.waitForFunction(() => document.querySelector('.lm-player video').currentTime >= 15.9);
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/library/progress') && r.request().method() === 'PUT');
  await page.keyboard.press('k');
  const res = await saved;
  assert.equal(res.status(), 200);
  const at = (await res.json()).positionS;
  assert.ok(at >= 15.9 && at < 19, `saved ${at}`);

  await page.reload();
  await page.waitForSelector('.lm-player__resume:not([hidden])');
  assert.match(await page.textContent('.lm-player__resume'), /Resumed at 0:16/);
  await page.waitForFunction((t) => Math.abs(document.querySelector('.lm-player video').currentTime - t) < 1.5, at);
  await page.click('.lm-player__resume-btn');
  await page.waitForFunction(() => document.querySelector('.lm-player video').currentTime < 3);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('a missing source shows the error overlay; Try again recovers', async () => {
  const page = await open(null);
  const missing = (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'Not found' });
  await page.route(ORIGINAL_MASTER, missing);
  await page.goto(`${app.base}/#/watch/hanami`);
  await page.waitForSelector('.lm-player__error:not([hidden])');
  assert.equal(await page.getAttribute('.lm-player', 'data-state'), 'error');
  assert.equal(await page.textContent('.lm-player__error h2'), 'Video unavailable');
  const actions = await page.$$eval('.lm-player__error-actions .lm-btn', (els) => els.map((e) => e.textContent));
  assert.deepEqual(actions, ['Try again', 'Back', 'Report a problem']);
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), 'Try again');

  await page.unroute(ORIGINAL_MASTER, missing);
  await page.click('.lm-player__error button:has-text("Try again")');
  await waitPlaying(page);
  assert.ok(await page.isHidden('.lm-player__error'));
  await page.context().close();
});

test('on a fatal error the catalog’s backup source is used', async () => {
  // Big Buck Bunny: HLS from an external host (blocked here) with a progressive fallback.
  const page = await open(null);
  const webm = readFileSync(`${ROOT}media/test-fixtures/progressive/p360.webm`);
  await page.route('**/BigBuckBunny.mp4', (route) => route.fulfill({ status: 200, contentType: 'video/webm', body: webm }));
  await page.goto(`${app.base}/#/watch/big-buck-bunny`);
  await page.waitForSelector('.lm-player__toast:has-text("Switched to a backup source")', { timeout: 15000 });
  await waitPlaying(page);
  assert.equal(await page.getAttribute('.lm-player', 'data-engine'), 'progressive');
  // A single progressive file: its real resolution, no Auto.
  const items = await openMenu(page, QUALITY, 1);
  assert.deepEqual(items.map((i) => [i.label, i.checked]), [['Source (360p)', true]]);
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('Preview mode plays from data/catalog.json; watch parties explain they need the server', async () => {
  const page = await open('/#/watch/hanami', { base: stat.base });
  await waitPlaying(page);
  assert.equal(await page.getAttribute('.lm-player', 'data-engine'), 'hls.js');
  assert.equal(await page.$$eval('.lm-player__extras button', (b) => b.length), 0, 'no watch-party button in Preview mode');
  const labels = (await openMenu(page, QUALITY, 6)).map((i) => i.label);
  assert.ok(labels.includes('4K · 2160p'), labels.join(', '));
  await page.keyboard.press('Escape');
  await page.keyboard.press('k');
  await page.waitForFunction(() => document.querySelector('.lm-player video').paused);
  await page.goto(`${stat.base}/#/party/ABC234`);
  await page.waitForSelector('.lm-server-required h1:has-text("Watch parties needs the Lumina server")');
  assert.deepEqual(page.errors, []);
  await page.context().close();
});

test('watch party: two browsers stay in sync, chat, hand over control and end', async () => {
  const hostUser = await app.userClient({ displayName: 'Aiko' });
  const guestUser = await app.userClient({ displayName: 'Kenji' });
  const host = await open('/#/watch/hanami', { user: hostUser });
  await host.waitForSelector('.lm-player__extras button');
  await wake(host);
  await host.click('.lm-player__extras button:has-text("Start watch party")');
  await host.waitForURL(/#\/party\/[A-HJ-NP-Z2-9]{6}$/);
  const code = host.url().split('/').pop();
  await host.waitForSelector('.lm-party__member');
  await host.waitForFunction(() => document.querySelector('.lm-player video')?.readyState >= 1);

  const guest = await open(`/#/party/${code}`, { user: guestUser });
  await guest.waitForSelector(`.lm-party-gate:has-text("Watch party · ${code}")`);
  assert.match(await guest.textContent('.lm-party-gate'), /Hosted by Aiko/);
  await guest.click('.lm-party-gate button:has-text("Join the party")');
  await guest.waitForSelector('.lm-party .lm-player.is-locked');
  await host.waitForFunction(() => document.querySelectorAll('.lm-party__member').length === 2);
  assert.match(await host.textContent('.lm-party__members'), /Kenji/);

  // The host presses play; the guest follows on the shared timeline.
  await host.click('.lm-player__bar button[aria-label^="Play"]');
  await waitPlaying(guest, 0.3);
  await host.keyboard.press('5');
  await expectInSync(host, guest);

  // The host pauses; the guest pauses at the same place and cannot take over.
  await host.keyboard.press('k');
  await guest.waitForFunction(() => document.querySelector('.lm-player video').paused, null, { timeout: 5000 });
  await expectInSync(host, guest);
  await guest.keyboard.press('k');
  await guest.waitForSelector('.lm-player__toast:has-text("The host is controlling playback")');
  assert.equal((await video(guest)).paused, true);

  // Chat reaches everyone.
  await guest.fill('.lm-party__form input', 'Konnichiwa 🌸');
  await guest.press('.lm-party__form input', 'Enter');
  await host.waitForSelector('.lm-party__msg-text:text-is("Konnichiwa 🌸")');
  assert.match(await host.textContent('.lm-party__msg:has-text("Konnichiwa") .lm-party__msg-author'), /Kenji/);

  // The host lets guests control playback; the guest's play reaches the host.
  await host.click('.lm-party__toggle [role="switch"]');
  await guest.waitForSelector('.lm-party .lm-player:not(.is-locked)');
  await guest.click('.lm-player__bar button[aria-label^="Play"]');
  await waitPlaying(host, 0, 5000);

  // Ending the party sends everyone to the ended screen.
  await host.click('.lm-party__footer button:has-text("End party")');
  await host.click('dialog[open] button:has-text("End party")');
  await host.waitForURL(/#\/title\/hanami$/);
  await guest.waitForSelector('.lm-party-gate h1:text-is("This watch party has ended")');
  assert.ok(await guest.isVisible('a:has-text("Keep watching on your own")'));
  assert.deepEqual(host.errors, []);
  assert.deepEqual(guest.errors, []);
  await host.context().close();
  await guest.context().close();
});

/** Both players within the 1.5 s party drift tolerance (polls while corrections land). */
async function expectInSync(a, b, timeout = 6000) {
  const until = Date.now() + timeout;
  let last;
  while (Date.now() < until) {
    const [x, y] = await Promise.all([video(a), video(b)]);
    last = { a: x.t, b: y.t };
    if (Math.abs(x.t - y.t) < 1.5 && x.paused === y.paused) return;
    await a.waitForTimeout(200);
  }
  assert.fail(`players drifted apart: ${JSON.stringify(last)}`);
}

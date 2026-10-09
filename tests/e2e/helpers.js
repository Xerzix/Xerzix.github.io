// E2E harness: a Lumina server on a temp database (server mode) and a plain static file
// server over the repository (Preview mode, like GitHub Pages), plus a Chromium browser.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';
import { startTestServer } from '../helpers/server.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.woff2': 'font/woff2', '.m3u8': 'application/vnd.apple.mpegurl', '.ts': 'video/mp2t', '.vtt': 'text/vtt' };

export async function startStaticServer() {
  const server = createServer((req, res) => {
    let p = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    if (p.endsWith('/')) p += 'index.html';
    const file = join(ROOT, p);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404, { 'Content-Type': 'text/html' }).end('<h1>404</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export async function startBrowser() {
  return chromium.launch();
}

/**
 * New page. options: { skipIntro = true, viewport, reducedMotion, cookies: [{name, value}], base }
 * Collects console errors and page errors in page.errors.
 */
export async function newPage(browser, { base, skipIntro = true, skipWho = true, viewport = { width: 1440, height: 900 }, reducedMotion = 'no-preference', cookies = [] } = {}) {
  const context = await browser.newContext({ viewport, ignoreHTTPSErrors: true, reducedMotion });
  if (skipIntro) await context.addInitScript(() => localStorage.setItem('lumina.introSeen', '1'));
  // "Who's watching?" opens each browser session; most tests start past it.
  if (skipWho) await context.addInitScript(() => sessionStorage.setItem('lumina.identityChosen', '1'));
  if (cookies.length) await context.addCookies(cookies.map((c) => ({ ...c, url: base })));
  // External media/font hosts are unreachable in CI sandboxes; fail them fast.
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  const page = await context.newPage();
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' && !/Failed to load resource|net::ERR_FAILED/.test(m.text())) page.errors.push(m.text());
  });
  return page;
}

/** Server-mode app + helpers from tests/helpers/server.js. */
export async function startApp() {
  return startTestServer();
}

/** Cookie for a user created with t.userClient(). */
export function sessionCookie(client) {
  return { name: 'lumina_sid', value: client.jar.get('lumina_sid') };
}

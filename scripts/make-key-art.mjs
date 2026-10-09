#!/usr/bin/env node
// Key art for Lumina Originals whose own title card does not fit a 2:3 poster crop.
//
// Every Original's backdrop is a real frame from the film (assets/art/originals/*-backdrop-*.jpg),
// and Hanami's and Kōyō's posters are 2:3 crops of the films' own title-card frames. Garden
// Hours' title card is too wide for a portrait crop, so its poster sets the series title in
// the same typeface (Cormorant Garamond) over a real frame from episode 1, exactly as the
// series' own title card does.
//
// Usage: node scripts/make-key-art.mjs   (needs Playwright's Chromium; writes the JPEGs below)
// Frames were taken from media/originals/<id>/1080p (e.g. `ffmpeg -ss 9 -i <segments> -frames:v 1`).
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const file = (p) => pathToFileURL(new URL(p, ROOT).pathname).href;

const POSTERS = [
  {
    out: 'assets/art/originals/garden-hours-poster',
    frame: 'assets/art/originals/garden-hours-backdrop-1920.jpg',
    eyebrow: 'A Lumina Original Series',
    lines: ['Garden', 'Hours'],
    sub: 'Slow television from the Lumina gardens',
  },
];

const page = (p) => `<!doctype html><meta charset="utf-8"><style>
@font-face { font-family: C; font-weight: 600; src: url(${file('assets/fonts/cormorant-garamond-latin-600-normal.woff2')}); }
@font-face { font-family: I; font-weight: 600; src: url(${file('assets/fonts/inter-latin-600-normal.woff2')}); }
html, body { margin: 0; width: 360px; height: 540px; background: #080808; overflow: hidden; }
.bg { position: absolute; inset: 0; background: url(${file(p.frame)}) center / auto 100% no-repeat; }
.shade { position: absolute; inset: 0; background: radial-gradient(ellipse at 50% 42%, rgba(8,8,8,0) 0, rgba(8,8,8,.35) 70%), linear-gradient(180deg, rgba(8,8,8,.15), rgba(8,8,8,0) 30%, rgba(8,8,8,.55) 100%); }
.t { position: absolute; left: 0; right: 0; top: 168px; text-align: center; color: #F8F5F2; }
.eyebrow { font: 600 8.5px/1 I, sans-serif; letter-spacing: .32em; text-transform: uppercase; color: #C6A46A; margin-bottom: 16px; }
.title { font: 600 46px/.98 C, serif; letter-spacing: .16em; text-transform: uppercase; text-shadow: 0 0 18px rgba(181,43,73,.35), 0 2px 10px rgba(0,0,0,.6); }
.sub { margin-top: 16px; font: 600 13px/1.3 C, serif; letter-spacing: .06em; color: #e9e2dc; }
</style><div class="bg"></div><div class="shade"></div>
<div class="t"><div class="eyebrow">${p.eyebrow}</div><div class="title">${p.lines.join('<br>')}</div><div class="sub">${p.sub}</div></div>`;

const browser = await chromium.launch();
for (const p of POSTERS) {
  for (const [scale, w] of [[2, 720], [1, 360]]) {
    const ctx = await browser.newContext({ viewport: { width: 360, height: 540 }, deviceScaleFactor: scale });
    const tab = await ctx.newPage();
    // A file:// page may load the frame and fonts; setContent's about:blank may not.
    const html = new URL('var/key-art.html', ROOT).pathname;
    mkdirSync(new URL('var/', ROOT).pathname, { recursive: true });
    writeFileSync(html, page(p));
    await tab.goto(pathToFileURL(html).href, { waitUntil: 'load' });
    await tab.evaluate(() => document.fonts.ready);
    await tab.screenshot({ path: new URL(`${p.out}-${w}.jpg`, ROOT).pathname, type: 'jpeg', quality: 86 });
    await ctx.close();
  }
  console.log(`wrote ${p.out}-{720,360}.jpg`);
}
await browser.close();

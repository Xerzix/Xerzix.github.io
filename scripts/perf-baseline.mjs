// Page-load baseline: LCP, CLS, FCP, a click-to-paint interaction and bytes transferred
// for the home page and a title page, at desktop and phone sizes, measured in Playwright's
// Chromium with PerformanceObserver. The phone profile uses Lighthouse's mobile throttling
// (4× CPU slowdown, 150 ms RTT, 1.6 Mbps down / 750 kbps up).
//
//   node --disable-warning=ExperimentalWarning scripts/perf-baseline.mjs            boots a seeded test server
//   node … scripts/perf-baseline.mjs --base http://127.0.0.1:8080                  measure a running server
//   node … scripts/perf-baseline.mjs --runs 5 --json                                more runs, JSON output
//   node … scripts/perf-baseline.mjs --reduced-motion                               with prefers-reduced-motion
//
// Each figure is the median of the runs. This is a lab measurement on whatever machine runs
// the script, not field data from real devices; record the machine with the numbers.
import { cpus } from 'node:os';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const RUNS = Math.max(1, Number(opt('runs', 3)) || 3);
const JSON_OUT = args.includes('--json');
// --reduced-motion: measure with prefers-reduced-motion (the falling petals and garden stop).
const REDUCED = args.includes('--reduced-motion');

const PROFILES = [
  { id: 'desktop', label: 'Desktop 1440×900, no throttling', viewport: { width: 1440, height: 900 }, cpu: 1, network: null },
  {
    id: 'mobile',
    label: 'Phone 390×844, 4× CPU, 150 ms RTT, 1.6 Mbps',
    viewport: { width: 390, height: 844 },
    cpu: 4,
    network: { offline: false, latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
    mobile: true,
  },
];
const PAGES = [
  // The click opens the Browse menu (desktop) or the menu drawer (phone).
  { id: 'home', path: '/#/', click: '.lm-nav__more > button, .lm-menu-toggle' },
  { id: 'title', path: '/#/title/sintel', click: '[data-list-toggle]' },
];

// Runs in the page before any script: collects LCP, CLS, FCP and event timings.
function observe() {
  const m = { lcp: 0, cls: 0, fcp: 0, events: [] };
  window.__lmPerf = m;
  const po = (type, fn, extra = {}) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(fn)).observe({ type, buffered: true, ...extra });
    } catch {
      /* unsupported entry type */
    }
  };
  po('largest-contentful-paint', (e) => { m.lcp = e.startTime; m.lcpElement = e.element ? `${e.element.tagName.toLowerCase()}${e.element.className ? `.${String(e.element.className).split(' ')[0]}` : ''}` : ''; });
  po('layout-shift', (e) => { if (!e.hadRecentInput) m.cls += e.value; });
  po('paint', (e) => { if (e.name === 'first-contentful-paint') m.fcp = e.startTime; });
  // Only real interactions count (as for INP): hover events have no interactionId.
  po('event', (e) => { if (e.interactionId) m.events.push(e.duration); }, { durationThreshold: 16 });
}

async function measure(browser, base, profile, pg) {
  const context = await browser.newContext({ viewport: profile.viewport, ignoreHTTPSErrors: true, reducedMotion: REDUCED ? 'reduce' : 'no-preference', isMobile: !!profile.mobile, hasTouch: !!profile.mobile, deviceScaleFactor: profile.mobile ? 3 : 1 });
  await context.addInitScript(() => localStorage.setItem('lumina.introSeen', '1'));
  await context.addInitScript(observe);
  // External hosts (fonts, remote media) are not part of the measurement.
  const origin = new URL(base).origin;
  await context.route((url) => url.origin !== origin, (route) => route.abort());
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (profile.network) await cdp.send('Network.emulateNetworkConditions', profile.network);
  if (profile.cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  let bytes = 0;
  cdp.on('Network.loadingFinished', (e) => { bytes += e.encodedDataLength || 0; });

  await page.goto(base + pg.path, { waitUntil: 'load', timeout: 120_000 });
  await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  // One interaction, then let it paint.
  const target = page.locator(pg.click).filter({ visible: true }).first();
  let clicked = false;
  if (await target.count()) {
    clicked = await target.click().then(() => true, () => false);
    await page.waitForTimeout(800);
  }
  const m = await page.evaluate(() => ({ ...window.__lmPerf }));
  await context.close();
  return { lcp: m.lcp, cls: m.cls, fcp: m.fcp, interaction: !clicked ? null : m.events.length ? Math.max(...m.events) : 0, bytes, lcpElement: m.lcpElement };
}

const median = (xs) => {
  const v = xs.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  return v.length ? v[Math.floor((v.length - 1) / 2)] : null;
};

async function main() {
  let base = opt('base', '');
  let server = null;
  if (!base) {
    const { startTestServer } = await import('../tests/helpers/server.js');
    server = await startTestServer();
    base = server.base;
  }
  const browser = await chromium.launch();
  const results = [];
  try {
    for (const profile of PROFILES) {
      for (const pg of PAGES) {
        const runs = [];
        for (let i = 0; i < RUNS; i++) runs.push(await measure(browser, base, profile, pg));
        results.push({
          profile: profile.id,
          conditions: profile.label,
          page: pg.id,
          runs: RUNS,
          lcpMs: Math.round(median(runs.map((r) => r.lcp))),
          cls: Number(median(runs.map((r) => r.cls)).toFixed(3)),
          fcpMs: Math.round(median(runs.map((r) => r.fcp))),
          interactionMs: median(runs.map((r) => r.interaction)),
          transferKB: Math.round(median(runs.map((r) => r.bytes)) / 1024),
          lcpElement: runs[runs.length - 1].lcpElement,
        });
      }
    }
  } finally {
    await browser.close();
    await server?.close();
  }
  const machine = { cpu: cpus()[0]?.model || 'unknown', cores: cpus().length, chromium: chromium.name(), node: process.version, date: new Date().toISOString().slice(0, 10) };
  if (JSON_OUT) {
    console.log(JSON.stringify({ machine, results }, null, 2));
    return;
  }
  console.log(`Machine: ${machine.cpu} × ${machine.cores}, Node ${machine.node}, ${machine.date}. Median of ${RUNS} runs, cache disabled${REDUCED ? ', reduced motion' : ''}.`);
  console.log('| Page | Conditions | LCP | CLS | FCP | Click → paint | Transferred |');
  console.log('|---|---|---|---|---|---|---|');
  for (const r of results) {
    console.log(`| ${r.page} | ${r.conditions} | ${r.lcpMs} ms | ${r.cls} | ${r.fcpMs} ms | ${r.interactionMs === null ? 'not measured' : r.interactionMs === 0 ? '< 16 ms' : `${Math.round(r.interactionMs)} ms`} | ${r.transferKB} KB |`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

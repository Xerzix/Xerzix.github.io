// Produces the Lumina Originals: renders each piece frame-by-frame from the garden scene in
// headless Chromium, scores it with a generated pentatonic ambience, encodes a mezzanine
// master and then an HLS adaptive-bitrate ladder that never upscales (only Hanami is
// rendered at 3840×2160, so only Hanami gets a 2160p rung). Finally it reads the produced
// master playlists and writes the *verified* renditions back into the seed catalog.
//
//   FFMPEG_PATH=/path/to/ffmpeg node scripts/make-sample-media.mjs [--only hanami] [--keep]
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FPS = 24;
const args = process.argv.slice(2);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const WORK = join(process.env.LUMINA_RENDER_DIR || tmpdir(), 'lumina-render');
mkdirSync(WORK, { recursive: true });

// Bitrate caps (kbps). Flat, painterly animation compresses very well at these rates.
const RUNGS = {
  2160: { maxrate: 4200 },
  1080: { maxrate: 2000 },
  720: { maxrate: 1100 },
  480: { maxrate: 600 },
  360: { maxrate: 350 },
};

const cardTitle = ({ jp, title, eyebrow, sub }) => `<div class="inner">${jp ? `<span class="jp">${jp}</span>` : ''}<span class="display">${title}</span>${sub ? `<span class="sub">${sub}</span>` : ''}${eyebrow ? `<span class="eyebrow">${eyebrow}</span>` : ''}</div>`;
const credit = '<div class="credit">Lumina Studio</div>';

const episode = (id, environment, seasonEp, name, lines) => ({
  id,
  environment,
  duration: 12,
  scale: 1,
  height: 1080,
  emerge: 0,
  fadeIn: 1,
  fadeOut: 1,
  intensity: 0.85,
  introStart: 0,
  introEnd: 3,
  creditsStart: 9.5,
  cards: [
    { html: cardTitle({ title: 'GARDEN HOURS', sub: name, eyebrow: seasonEp }), at: [0.2, 0.9, 2.2, 2.9] },
    { html: credit, at: [9.6, 10.1, 11.2, 11.8] },
  ],
  subtitles: lines,
  gusts: [5],
  still: 6,
});

const PIECES = [
  {
    id: 'hanami',
    environment: 'sakura',
    duration: 16,
    scale: 2, // 1920×1080 viewport at device scale 2 → a true 3840×2160 render
    height: 2160,
    emerge: 4,
    fadeIn: 2.5,
    fadeOut: 1.5,
    intensity: 0.9,
    cards: [{ html: cardTitle({ jp: '花見', title: 'HANAMI', eyebrow: 'A Lumina Original' }), at: [5.5, 7.5, 11.5, 13] }],
    subtitles: [
      [5.5, 9, 'The first petals of the season.', '今年最初の花びら。'],
      [9.5, 13, 'A temple wakes in the dusk.', '夕暮れに目覚める寺。'],
    ],
    gusts: [6.5],
    still: 8,
  },
  {
    id: 'koyo-autumn-pavilion',
    environment: 'autumn',
    duration: 14,
    scale: 1,
    height: 1080,
    emerge: 2,
    fadeIn: 2,
    fadeOut: 1.5,
    intensity: 0.8,
    cards: [{ html: cardTitle({ jp: '紅葉', title: 'KŌYŌ', sub: 'Autumn Pavilion' }), at: [3, 4.5, 8.5, 10] }],
    subtitles: [
      [3.5, 7, 'Maple leaves turn to gold.', '紅葉が金色に染まる。'],
      [7.5, 11, 'The pavilion waits by the lake.', '湖畔にたたずむ東屋。'],
    ],
    gusts: [4],
    still: 7,
  },
  episode('garden-hours-s1e1', 'sakura', 'Season 1 · Episode 1', 'Dawn Petals', [[3.5, 6.5, 'First light on the temple roof.', '寺の屋根に朝の光。'], [6.8, 9.3, 'Petals settle on the pond.', '花びらが池に舞い落ちる。']]),
  episode('garden-hours-s1e2', 'moonlit', 'Season 1 · Episode 2', 'Moonrise', [[3.5, 6.5, 'The moon clears the ridge.', '月が尾根を越える。'], [6.8, 9.3, 'Fireflies over still water.', '静かな水面に蛍。']]),
  episode('garden-hours-s2e1', 'snow', 'Season 2 · Episode 1', 'First Snow', [[3.5, 6.5, 'The first snow of winter.', '冬の初雪。'], [6.8, 9.3, 'Stone lanterns wear white caps.', '石灯籠に白い帽子。']]),
  episode('garden-hours-s2e2', 'lantern', 'Season 2 · Episode 2', 'Lantern Walk', [[3.5, 6.5, 'Lanterns wake along the path.', '小道に灯籠がともる。'], [6.8, 9.3, 'Embers rise into the night.', '火の粉が夜空に昇る。']]),
];

// ── Helpers ───────────────────────────────────────────────
function run(cmd, argv, { input } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, argv, { stdio: [input ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => {
      err += d;
      if (err.length > 20000) err = err.slice(-20000);
    });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${err.slice(-3000)}`))));
    if (input) {
      p.stdin.on('error', () => {}); // surfaced through the exit code + stderr instead
      input(p.stdin).catch(reject);
    }
  });
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
function staticServer() {
  const server = createServer((req, res) => {
    const path = normalize(decodeURIComponent(new URL(req.url, 'http://x').pathname)).replace(/^(\.\.[/\\])+/, '');
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const vttTime = (s) => {
  const h = String(Math.floor(s / 3600)).padStart(2, '0');
  const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const sec = (s % 60).toFixed(3).padStart(6, '0');
  return `${h}:${m}:${sec}`;
};

/** A gentle pentatonic chime score with a low drone, generated entirely by ffmpeg filters. */
async function makeScore(piece, out) {
  const notes = [293.66, 329.63, 392.0, 440.0, 493.88, 587.33, 659.25];
  let seed = [...piece.id].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
  const inputs = [];
  const labels = [];
  let t = 1.2;
  let i = 0;
  while (t < piece.duration - 2) {
    const f = notes[Math.floor(rnd() * notes.length)];
    const delay = Math.round(t * 1000);
    inputs.push(`sine=f=${f}:d=3.2:sample_rate=48000,afade=t=in:d=0.02,afade=t=out:st=0.05:d=3.1,volume=0.16,adelay=${delay}|${delay}[n${i}]`);
    labels.push(`[n${i}]`);
    t += 0.9 + rnd() * 1.6;
    i++;
  }
  const drone = `sine=f=146.83:d=${piece.duration}:sample_rate=48000,volume=0.05[d0];sine=f=220:d=${piece.duration}:sample_rate=48000,volume=0.03[d1]`;
  const graph = `${inputs.join(';')};${drone};[d0][d1]${labels.join('')}amix=inputs=${labels.length + 2}:normalize=0,aecho=0.8:0.6:280|520:0.28|0.18,lowpass=f=5200,afade=t=in:d=1.5,afade=t=out:st=${piece.duration - 2}:d=2,pan=stereo|c0=c0|c1=c0,apad=whole_dur=${piece.duration},atrim=0:${piece.duration}[out]`;
  await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-filter_complex', graph, '-map', '[out]', '-ar', '48000', out]);
}

async function renderMaster(browser, base, piece, out) {
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: piece.scale });
  const page = await context.newPage();
  page.on('pageerror', (e) => console.error('  page error:', e.message));
  await page.goto(`${base}/scripts/render/render.html`);
  await page.waitForFunction(() => window.lumina);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate((spec) => window.lumina.setup(spec), { ...piece, cards: piece.cards.map(({ html, at }) => ({ html, at })) });
  const audio = join(WORK, `${piece.id}.wav`);
  await makeScore(piece, audio);
  const frames = Math.round(piece.duration * FPS);
  const started = Date.now();
  await run(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-i', audio,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '12', '-tune', 'animation', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-shortest', out,
  ], {
    input: async (stdin) => {
      for (let f = 0; f < frames; f++) {
        await page.evaluate((t) => window.lumina.frame(t), f / FPS);
        const buf = await page.screenshot({ type: 'jpeg', quality: 93 });
        if (stdin.destroyed) return;
        if (!stdin.write(buf)) {
          await new Promise((r) => {
            const done = () => {
              stdin.off('drain', done);
              stdin.off('close', done);
              r();
            };
            stdin.on('drain', done);
            stdin.on('close', done);
          });
        }
        if (f % 48 === 0) process.stdout.write(`  ${piece.id}: frame ${f}/${frames}\r`);
      }
      stdin.end();
    },
  });
  console.log(`  ${piece.id}: rendered ${frames} frames in ${((Date.now() - started) / 1000).toFixed(0)} s`);
  await context.close();
}

async function encodeLadder(piece, master, outDir) {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const heights = Object.keys(RUNGS).map(Number).filter((h) => h <= piece.height).sort((a, b) => b - a);
  const split = `[0:v]split=${heights.length}${heights.map((_, i) => `[s${i}]`).join('')};${heights.map((h, i) => `[s${i}]scale=-2:${h}:flags=lanczos[o${i}]`).join(';')}`;
  const argv = ['-y', '-hide_banner', '-loglevel', 'error', '-i', master, '-filter_complex', split];
  heights.forEach((h, i) => {
    argv.push('-map', `[o${i}]`, `-c:v:${i}`, 'libx264', `-maxrate:v:${i}`, `${RUNGS[h].maxrate}k`, `-bufsize:v:${i}`, `${RUNGS[h].maxrate * 2}k`);
    if (h >= 2160) argv.push(`-level:v:${i}`, '5.1');
  });
  argv.push('-map', '0:a', '-c:a', 'aac', '-b:a', '128k', '-ac', '2');
  argv.push(
    '-crf', '26', '-preset', 'slow', '-tune', 'animation', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-g', String(FPS * 2), '-keyint_min', String(FPS * 2), '-sc_threshold', '0',
    '-f', 'hls', '-hls_time', '4', '-hls_playlist_type', 'vod', '-hls_flags', 'independent_segments',
    '-hls_segment_type', 'mpegts', '-hls_segment_filename', join(outDir, '%v', 'seg_%03d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', ['a:0,agroup:score,default:yes,language:zxx,name:audio', ...heights.map((h, i) => `v:${i},agroup:score,name:${h}p`)].join(' '),
    join(outDir, '%v', 'index.m3u8'),
  );
  await run(FFMPEG, argv);
}

/** Reads the produced master playlist: the only source of truth for what exists. */
function readMaster(path) {
  const text = readFileSync(path, 'utf8');
  const variants = [...text.matchAll(/#EXT-X-STREAM-INF:([^\n]+)/g)].map((m) => {
    const attrs = m[1];
    const res = /RESOLUTION=(\d+)x(\d+)/.exec(attrs);
    return { width: res ? +res[1] : null, height: res ? +res[2] : null, bandwidth: +(/BANDWIDTH=(\d+)/.exec(attrs)?.[1] || 0), codecs: /CODECS="([^"]+)"/.exec(attrs)?.[1] || null };
  });
  return { variants, heights: [...new Set(variants.map((v) => v.height).filter(Boolean))].sort((a, b) => b - a) };
}

function writeSubtitles(piece, outDir) {
  mkdirSync(join(outDir, 'subs'), { recursive: true });
  for (const [lang, idx] of [['en', 2], ['ja', 3]]) {
    const body = piece.subtitles.map((c, i) => `${i + 1}\n${vttTime(c[0])} --> ${vttTime(c[1])}\n${c[idx]}\n`).join('\n');
    writeFileSync(join(outDir, 'subs', `${lang}.vtt`), `WEBVTT\n\n${body}`);
  }
}

// ── Main ──────────────────────────────────────────────────
const server = await staticServer();
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
const seedPath = join(ROOT, 'data', 'seed', 'catalog.seed.json');
const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
const findMedia = (id) => {
  for (const t of seed.titles) {
    if (t.id === id) return { holder: t, key: 'media', title: t };
    for (const s of t.seasons || []) for (const e of s.episodes || []) if (e.id === id) return { holder: e, key: 'media', title: t, episode: e };
  }
  return null;
};

try {
  for (const piece of PIECES) {
    if (only && piece.id !== only) continue;
    console.log(`Rendering ${piece.id} (${piece.height}p source, ${piece.duration} s)…`);
    const master = join(WORK, `${piece.id}-master.mp4`);
    await renderMaster(browser, base, piece, master);
    const outDir = join(ROOT, 'media', 'originals', piece.id);
    await encodeLadder(piece, master, outDir);
    writeSubtitles(piece, outDir);
    const { variants, heights } = readMaster(join(outDir, 'master.m3u8'));
    // Episode still / originals frame for artwork
    if (piece.still !== undefined) {
      const stillOut = join(ROOT, 'assets', 'art', `${piece.id}-still.jpg`);
      await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(piece.still), '-i', master, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', stillOut]);
    }
    const bytes = readdirSync(outDir, { recursive: true }).map((f) => join(outDir, f)).filter((f) => statSync(f).isFile()).reduce((a, f) => a + statSync(f).size, 0);
    console.log(`  ${piece.id}: ladder ${heights.map((h) => `${h}p`).join(' / ')} — ${(bytes / 1048576).toFixed(1)} MB`);

    const ref = findMedia(piece.id);
    if (!ref) throw new Error(`No seed entry for ${piece.id}`);
    ref.holder.media = {
      kind: 'hls',
      source: `media/originals/${piece.id}/master.m3u8`,
      resolutions: heights,
      verified: true,
      verifiedAt: new Date().toISOString(),
      videoCodecs: [...new Set(variants.map((v) => v.codecs?.split(',')[0]).filter(Boolean))],
      audioFormats: ['AAC Stereo'],
      audioTracks: [{ lang: 'zxx', label: 'Original score (no dialogue)', kind: 'main', default: true }],
      subtitleTracks: [
        { lang: 'en', label: 'English', kind: 'subtitles', src: `media/originals/${piece.id}/subs/en.vtt` },
        { lang: 'ja', label: '日本語 (Japanese)', kind: 'subtitles', src: `media/originals/${piece.id}/subs/ja.vtt` },
      ],
      durationS: piece.duration,
      ...(piece.introEnd !== undefined ? { introStart: piece.introStart, introEnd: piece.introEnd, creditsStart: piece.creditsStart } : {}),
    };
    if (ref.episode) ref.episode.still = `assets/art/${piece.id}-still.jpg`;
    writeFileSync(seedPath, `${JSON.stringify(seed, null, 2)}\n`);
  }
} finally {
  await browser.close();
  server.close();
}
console.log('Done. Seed catalog updated with verified renditions. Run `npm run catalog:export` with a fresh DATABASE_PATH to refresh data/catalog.json.');

// Verifies every HLS media entry in the seed catalog against its real master playlist and
// reports, per entry, what the manifest actually contains. With --write it records those
// facts in data/seed/catalog.seed.json. Nothing is ever marked verified unless its manifest
// was read: same-site paths (media/…) are read from disk, remote URLs are fetched only from
// origins in MEDIA_ORIGINS (10 s timeout, 2 MB cap), and a manifest that cannot be read is
// reported as FAILED and left untouched.
//
//   npm run media:verify                         check and report (no changes)
//   npm run media:verify -- --write              also update the seed catalog
//   npm run media:verify -- --only hanami        one title or episode id
//   npm run media:verify -- --strict --write     clear "verified" on entries that fail now
//   npm run media:verify -- --timeout 20         seconds per remote request (default 10)
//   npm run media:verify -- --seed other.json    a different catalog file in the seed format
//
// The seed only populates empty databases. On a running server, use Verify on the admin
// dashboard's Media page; afterwards refresh the Preview snapshot with `npm run catalog:export`.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FETCH_TIMEOUT_MS, verifyMedia } from '../server/services/admin/media-verify.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const SEED_PATH = join(ROOT, 'data', 'seed', 'catalog.seed.json');

const VIDEO_CODEC = /^(avc1|avc3|hvc1|hev1|dvh1|dvhe|dva1|dvav|av01|vp09|vp08)\b/i;

/**
 * Every media entry in the seed, in catalog order:
 * [{ id, label, holder, key, media }] where holder[key] === media.
 */
export function collectEntries(seed) {
  const out = [];
  for (const t of seed.titles || []) {
    if (t.media) out.push({ id: t.id, label: t.title, holder: t, key: 'media', media: t.media });
    if (t.trailer) out.push({ id: `${t.id}#trailer`, label: `${t.title} (trailer)`, holder: t, key: 'trailer', media: t.trailer });
    for (const s of t.seasons || []) {
      for (const e of s.episodes || []) {
        if (e.media) out.push({ id: e.id || `${t.id}-s${s.number}e${e.number}`, label: `${t.title} S${s.number} E${e.number}`, holder: e, key: 'media', media: e.media });
      }
    }
  }
  return out;
}

/** Raw video CODECS strings (e.g. avc1.640033), as the seed records them. */
function rawVideoCodecs(report) {
  const codecs = (report?.renditions || []).flatMap((r) => r.codecs || []).filter((c) => VIDEO_CODEC.test(c));
  return [...new Set(codecs)];
}

/**
 * Decides what to store for one entry. Pure: returns { media, changes } where `media` is the
 * new seed object (the input is never mutated) and `changes` names the fields that differ.
 *   result: what verifyMedia() returned for the entry
 *   options: { strict, now }
 */
export function planSeedUpdate(media, result, { strict = false, now = new Date().toISOString() } = {}) {
  const next = { ...media };
  if (!result.ok) {
    // Never claim what could not be read. Only --strict withdraws an earlier verification.
    if (strict && media.verified) {
      next.verified = false;
      delete next.verifiedAt;
      next.resolutions = [];
    }
  } else {
    const f = result.fields;
    next.resolutions = f.resolutions;
    const codecs = rawVideoCodecs(result.report);
    if (codecs.length) next.videoCodecs = codecs;
    if (f.audioTracks) next.audioTracks = f.audioTracks;
    if (f.subtitleTracks) {
      // Side-loaded WebVTT files stay; tracks the manifest declares are replaced.
      const sideLoaded = (media.subtitleTracks || []).filter((t) => t.src && !t.inManifest);
      next.subtitleTracks = [...sideLoaded, ...f.subtitleTracks.map(({ src, ...t }) => t)];
    }
    if (f.audioFormats && !(media.audioFormats || []).length) next.audioFormats = f.audioFormats;
    if (f.hdr !== undefined) {
      if (f.hdr) next.hdr = f.hdr;
      else delete next.hdr;
    }
    if (f.durationS) next.durationS = Math.round(f.durationS * 1000) / 1000;
    next.verified = true;
    next.verifiedAt = now;
  }
  const changes = [...new Set([...Object.keys(media), ...Object.keys(next)])]
    .filter((k) => k !== 'verifiedAt' && JSON.stringify(media[k]) !== JSON.stringify(next[k]));
  return { media: next, changes };
}

/** One summary line describing a successful verification. */
export function describe(result) {
  const f = result.fields || {};
  const parts = [];
  parts.push(f.resolutions?.length ? f.resolutions.map((h) => (h >= 2160 ? `${h}p (4K)` : `${h}p`)).join(', ') : 'no resolution declared');
  if (f.audioTracks) parts.push(`${f.audioTracks.length} audio`);
  if (f.subtitleTracks) parts.push(`${f.subtitleTracks.length} subtitle${f.subtitleTracks.length === 1 ? '' : 's'} in manifest`);
  if (f.durationS) parts.push(`${Math.round(f.durationS)} s`);
  if (f.hdr) parts.push(f.hdr);
  return parts.join(' · ');
}

function parseArgs(argv) {
  const opts = { write: false, strict: false, only: null, timeoutS: FETCH_TIMEOUT_MS / 1000, seed: SEED_PATH, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') opts.write = true;
    else if (a === '--strict') opts.strict = true;
    else if (a === '--only') opts.only = argv[++i] || null;
    else if (a === '--timeout') opts.timeoutS = Math.max(1, Math.min(120, Number(argv[++i]) || opts.timeoutS));
    else if (a === '--seed') opts.seed = resolve(argv[++i] || SEED_PATH);
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`Unknown option: ${a}`);
  }
  return opts;
}

const pad = (s, n) => (s.length >= n ? `${s.slice(0, n - 1)}…` : s.padEnd(n));

/**
 * Runs `fn` over items with at most `limit` in flight. Returns one promise per item, created
 * up front, so callers can await them in input order while later items are still running.
 */
function pool(items, limit, fn) {
  const slots = items.map(() => {
    let resolve;
    const promise = new Promise((r) => {
      resolve = r;
    });
    return { promise, resolve };
  });
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        slots[i].resolve(await fn(items[i], i));
      } catch (err) {
        slots[i].resolve({ ok: false, message: err?.message || String(err), fields: null, report: { ok: false, code: 'ERROR', message: err?.message || String(err) } });
      }
    }
  };
  const done = Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return { results: slots.map((s) => s.promise), done };
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    console.log('Usage: npm run media:verify -- [--write] [--strict] [--only <id>] [--timeout <seconds>] [--seed <file>]');
    return 0;
  }
  // Loaded here so importing this module (tests) has no configuration side effects.
  const { config } = await import('../server/config.js');
  const { allowedMediaOrigins, languageLabel } = await import('../server/services/admin/common.js');
  const env = {
    root: ROOT,
    storageRoot: config.storageDir,
    allowedOrigins: allowedMediaOrigins(),
    labelFor: languageLabel,
    timeoutMs: opts.timeoutS * 1000,
    // Progressive files are not verified here (remote ones cannot be, local ones need a probe).
    loadProbe: async () => null,
  };

  const rel = relative(process.cwd(), opts.seed);
  const seedName = rel && !rel.startsWith('..') ? rel : opts.seed;
  const seed = JSON.parse(readFileSync(opts.seed, 'utf8'));
  let entries = collectEntries(seed);
  if (opts.only) entries = entries.filter((e) => e.id === opts.only || e.id.startsWith(`${opts.only}-`) || e.holder.id === opts.only);
  if (!entries.length) {
    console.error(opts.only ? `No media entry matches "${opts.only}".` : 'The seed catalog has no media entries.');
    return 1;
  }
  const hls = entries.filter((e) => e.media.kind === 'hls');
  console.log(`Verifying ${hls.length} HLS media entr${hls.length === 1 ? 'y' : 'ies'} from ${seedName}${opts.write ? '' : ' (dry run)'}`);
  console.log(`Remote manifests are fetched only from: ${env.allowedOrigins.join(', ') || '(no origins — MEDIA_ORIGINS is empty)'}\n`);

  const now = new Date().toISOString();
  const tally = { ok: 0, failed: 0, skipped: 0, updated: 0 };
  const { results, done } = pool(entries, 4, (e) => (e.media.kind === 'hls'
    ? verifyMedia({ kind: 'hls', source: e.media.source, audioTracks: e.media.audioTracks, subtitleTracks: e.media.subtitleTracks }, env)
    : Promise.resolve(null)));

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const result = await results[i];
    const head = `${pad(e.id, 30)} ${pad(e.media.source, 58)}`;
    if (!result) {
      tally.skipped++;
      console.log(`  SKIPPED  ${head} ${e.media.kind} — only HLS manifests are verified; resolution stays unverified`);
      continue;
    }
    if (result.ok) {
      tally.ok++;
      console.log(`  OK       ${head} ${describe(result)}`);
    } else {
      tally.failed++;
      const kept = e.media.verified ? (opts.strict ? ' — verification withdrawn (--strict)' : ` — keeping the earlier verification from ${e.media.verifiedAt || 'an unknown date'}`) : '';
      console.log(`  FAILED   ${head} ${result.report?.code || 'ERROR'}: ${result.message}${kept}`);
    }
    if (result.report?.note) console.log(`           ${result.report.note}`);
    if (opts.write) {
      const plan = planSeedUpdate(e.media, result, { strict: opts.strict, now });
      if (plan.changes.length || result.ok) {
        e.holder[e.key] = plan.media;
        if (plan.changes.length) {
          tally.updated++;
          console.log(`           updated: ${plan.changes.join(', ')}`);
        }
      }
    }
  }
  await done;

  if (opts.write) {
    writeFileSync(opts.seed, `${JSON.stringify(seed, null, 2)}\n`);
    console.log(`\nWrote ${seedName} (${tally.updated} entr${tally.updated === 1 ? 'y' : 'ies'} changed, verification dates refreshed for ${tally.ok}).`);
    console.log('New databases pick this up when seeded. Refresh the Preview snapshot with `npm run catalog:export`.');
  }
  console.log(`\nSummary: ${tally.ok} OK, ${tally.failed} failed, ${tally.skipped} skipped.${opts.write ? '' : ' Nothing was written (use --write).'}`);
  return tally.failed ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => {
    process.exitCode = code;
  }, (err) => {
    console.error(err.message);
    process.exitCode = 2;
  });
}

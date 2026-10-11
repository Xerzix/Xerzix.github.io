// Keeps index.html's <link rel="modulepreload"> list equal to the static import graph of the
// app shell and the home view. Without it the browser discovers modules one import level at a
// time, which costs a round trip per level (about a second on a throttled phone).
//
//   node scripts/module-preload.mjs           rewrite the list in index.html
//   node scripts/module-preload.mjs --check   exit 1 if the list is out of date
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRIES = ['js/main.js', 'js/views/home.js'];
const START = '<!-- modulepreload:start (npm run preload:sync) -->';
const END = '<!-- modulepreload:end -->';

// Static `import … from '…'`, `import '…'` and `export … from '…'`; dynamic import() is skipped.
const STATIC_IMPORT = /^\s*(?:import|export)\s+(?:[^'"`;]*?\s+from\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm;

/** Every module reachable through static imports from the entries, in discovery order. */
export function staticGraph(entries = ENTRIES, root = ROOT) {
  const seen = new Set();
  const visit = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = readFileSync(join(root, rel), 'utf8');
    for (const m of src.matchAll(STATIC_IMPORT)) visit(relative(root, resolve(root, dirname(rel), m[1])).split('\\').join('/'));
  };
  entries.forEach(visit);
  return [...seen];
}

export function preloadBlock(modules = staticGraph()) {
  return [START, ...modules.filter((m) => m !== 'js/main.js').map((m) => `  <link rel="modulepreload" href="${m}">`), `  ${END}`].join('\n');
}

export function currentBlock(html) {
  const a = html.indexOf(START);
  const b = html.indexOf(END);
  return a < 0 || b < 0 ? null : html.slice(a, b + END.length);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = join(ROOT, 'index.html');
  const html = readFileSync(file, 'utf8');
  const want = preloadBlock();
  const have = currentBlock(html);
  if (process.argv.includes('--check')) {
    if (have !== want) {
      console.error('index.html modulepreload list is out of date: run npm run preload:sync');
      process.exit(1);
    }
  } else {
    if (!have) throw new Error(`index.html has no ${START} marker`);
    writeFileSync(file, html.replace(have, want));
    console.log(`index.html: ${want.split('\n').length - 2} modules preloaded`);
  }
}

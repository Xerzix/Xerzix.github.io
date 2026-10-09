// Static guards for the XSS and CSP rules in docs/ARCHITECTURE.md.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
function files(dir, ext) {
  const out = [];
  for (const f of readdirSync(join(ROOT, dir))) {
    const p = join(ROOT, dir, f);
    if (statSync(p).isDirectory()) out.push(...files(join(dir, f), ext));
    else if (f.endsWith(ext)) out.push(join(dir, f));
  }
  return out;
}

// Files allowed to write HTML: the trusted legal-document importer (sanitised) and the
// offline render page used by scripts (not part of the site).
const ALLOW_HTML = new Set(['js/views/legal.js']);

test('no innerHTML / outerHTML / insertAdjacentHTML / document.write in app code', () => {
  const offenders = [];
  for (const f of [...files('js', '.js'), ...files('js', '.mjs')].filter((f) => !f.startsWith('js/vendor/'))) {
    if (ALLOW_HTML.has(f)) continue;
    const src = readFileSync(join(ROOT, f), 'utf8');
    if (/\.(innerHTML|outerHTML)\s*[+]?=|insertAdjacentHTML|document\.write\(/.test(src)) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
});

test('HTML entry points have no inline scripts or inline event handlers (CSP script-src self)', () => {
  for (const f of ['index.html', 'admin.html']) {
    let src;
    try {
      src = readFileSync(join(ROOT, f), 'utf8');
    } catch {
      continue;
    }
    assert.ok(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(src), `${f} has an inline <script>`);
    assert.ok(!/\son[a-z]+=/i.test(src), `${f} has an inline event handler`);
  }
});

test('no third-party API keys or tokens committed to client code', () => {
  for (const f of files('js', '.js').filter((f) => !f.startsWith('js/vendor/'))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    assert.ok(!/eyJhbGciOi|apikey=|sk-ant-|Bearer [A-Za-z0-9._-]{20,}/.test(src), f);
  }
});

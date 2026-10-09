// Native DOM insertion methods (replaceChildren, append, prepend, before, after, replaceWith)
// turn null into the text "null". Conditional children must go through h()/append()/replace()
// from js/core/dom.js, which skip null, false and undefined.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
function files(dir) {
  const out = [];
  for (const f of readdirSync(join(ROOT, dir))) {
    const p = join(ROOT, dir, f);
    if (statSync(p).isDirectory()) out.push(...files(join(dir, f)));
    else if (/\.m?js$/.test(f)) out.push(join(dir, f));
  }
  return out;
}

// The argument text of a call that starts at `open` (the index of its "("), or null.
function callArgs(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return null;
}

// Top-level slices of the argument list (nested calls/arrays/objects are kept whole).
function topLevel(args) {
  let depth = 0;
  let out = '';
  for (const c of args) {
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (depth === 0) out += c;
  }
  return out;
}

test('native DOM insertion methods are never handed a possible null child', () => {
  const offenders = [];
  for (const f of files('js').filter((f) => !f.startsWith('js/vendor/'))) {
    const src = readFileSync(join(ROOT, f), 'utf8');
    for (const m of src.matchAll(/\.(replaceChildren|append|prepend|before|after|replaceWith)\(/g)) {
      const args = callArgs(src, m.index + m[0].length - 1);
      if (args == null) continue;
      const flat = topLevel(args);
      if (/:\s*(?:null|undefined|false)\s*(?:,|$)|(?:^|,)\s*null\s*(?:,|$)/.test(flat)) {
        offenders.push(`${f}:${src.slice(0, m.index).split('\n').length} .${m[1]}()`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

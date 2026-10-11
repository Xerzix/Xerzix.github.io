import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { currentBlock, preloadBlock, staticGraph } from '../../scripts/module-preload.mjs';

test('index.html preloads exactly the static module graph of the shell and home view', () => {
  const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
  assert.equal(currentBlock(html), preloadBlock(), 'run npm run preload:sync');
});

test('the graph follows static imports only', () => {
  const graph = staticGraph();
  assert.equal(graph[0], 'js/main.js');
  for (const m of ['js/app.js', 'js/core/router.js', 'js/views/home.js', 'js/ui/hero.js']) assert.ok(graph.includes(m), m);
  // Loaded with import() on demand, so never preloaded.
  for (const m of ['js/views/title.js', 'js/player/player.js', 'js/api/static-backend.js']) assert.ok(!graph.includes(m), m);
});

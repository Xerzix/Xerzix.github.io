import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeHome } from '../../js/core/home-rows.js';

const now = Date.parse('2026-09-29T12:00:00Z');
const T = (o) => ({ genres: [], tags: [], moods: [], keywords: [], directors: [], cast: [], countries: [], awards: [], editorialRank: 100, type: 'movie', addedAt: '2026-09-28T00:00:00Z', ...o });
const titles = [
  T({ id: 'a', title: 'A', genres: ['Drama'], featured: true, editorialRank: 1 }),
  T({ id: 'b', title: 'B', genres: ['Drama'], moods: ['emotional'] }),
  T({ id: 'c', title: 'C', genres: ['Comedy'], type: 'series' }),
  T({ id: 'd', title: 'D', genres: ['Documentary'], countries: ['JP'], originalLanguage: 'ja' }),
];

test('rows without genuine content are omitted', () => {
  const home = composeHome(titles, { now });
  const rowIds = home.rows.map((r) => r.id);
  for (const absent of ['continue', 'trending-movies', 'trending-tv', 'top-rated', 'discussed', 'award-winning', 'watchlist', 'because', 'recommended']) {
    assert.ok(!rowIds.includes(absent), `${absent} should be omitted`);
  }
  assert.ok(rowIds.includes('selects'));
  assert.ok(rowIds.includes('japanese'));
  assert.ok(rowIds.includes('documentaries'));
  assert.deepEqual(home.featured.map((t) => t.id), ['a']);
});

test('continue watching orders by most recent activity', () => {
  const home = composeHome(titles, {
    now,
    progress: [
      { titleId: 'a', positionS: 100, durationS: 1000, completed: false, updatedAt: '2026-09-27T00:00:00Z' },
      { titleId: 'b', positionS: 300, durationS: 1000, completed: false, updatedAt: '2026-09-28T00:00:00Z' },
      { titleId: 'd', positionS: 990, durationS: 1000, completed: false, updatedAt: '2026-09-29T00:00:00Z' },
    ],
  });
  const row = home.rows.find((r) => r.id === 'continue');
  assert.deepEqual(row.items.map((i) => i.title.id), ['b', 'a']);
});

test('trending requires real activity; top rated needs a minimum number of ratings', () => {
  const t2 = titles.map((t) => (t.id === 'b' ? { ...t, memberRating: { average: 5, count: 2 } } : t));
  let home = composeHome(t2, { now, activity: { a: 5, c: 1 } });
  assert.deepEqual(home.rows.find((r) => r.id === 'trending-movies').items.map((i) => i.title.id), ['a']);
  assert.ok(!home.rows.find((r) => r.id === 'trending-tv'));
  assert.ok(!home.rows.find((r) => r.id === 'top-rated'));
  home = composeHome(t2.map((t) => (t.id === 'b' ? { ...t, memberRating: { average: 5, count: 3 } } : t)), { now });
  assert.ok(home.rows.find((r) => r.id === 'top-rated'));
});

test('history-based rows respect the privacy switch', () => {
  const signals = { now, history: [{ titleId: 'a', watchedAt: '2026-09-28T00:00:00Z' }] };
  const on = composeHome(titles, signals);
  assert.ok(on.rows.find((r) => r.id === 'because'));
  assert.ok(on.rows.find((r) => r.id === 'recommended'));
  const off = composeHome(titles, { ...signals, useHistory: false });
  assert.ok(!off.rows.find((r) => r.id === 'because'));
  assert.ok(!off.rows.find((r) => r.id === 'recommended'));
});

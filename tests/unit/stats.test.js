import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStats, lastMonths, monthKey } from '../../js/core/stats.js';

const NOW = Date.parse('2026-09-15T12:00:00Z');

const titles = [
  { id: 'm1', type: 'movie', title: 'Movie One', genres: ['Drama', 'Fantasy'] },
  { id: 'm2', type: 'movie', title: 'Movie Two', genres: ['Comedy'] },
  {
    id: 's1', type: 'series', title: 'Series One', genres: ['Nature'], episodeCount: 2,
    seasons: [{ number: 1, episodes: [{ id: 's1e1' }, { id: 's1e2' }] }],
    credits: { cast: [] }, license: { name: 'x' },
  },
  { id: 's2', type: 'series', title: 'Series Two', genres: ['Nature', 'Drama'], episodeCount: 3 },
];

test('empty history yields zeroes and twelve empty months', () => {
  const s = computeStats([], titles, { now: NOW });
  assert.equal(s.enabled, true);
  assert.equal(s.totalSeconds, 0);
  assert.equal(s.titlesWatched, 0);
  assert.equal(s.episodesWatched, 0);
  assert.equal(s.moviesWatched, 0);
  assert.deepEqual(s.completedSeries, []);
  assert.deepEqual(s.topGenres, []);
  assert.deepEqual(s.recent, []);
  assert.deepEqual(s.favorites, []);
  assert.equal(s.monthly.length, 12);
  assert.equal(s.monthly[11].month, '2026-09');
  assert.equal(s.monthly[0].month, '2025-10');
  assert.ok(s.monthly.every((m) => m.seconds === 0));
  assert.equal(s.firstWatchedAt, null);
});

test('totals, distinct counts, genres, recent and favourites', () => {
  const history = [
    { titleId: 'm1', episodeId: '', watchedAt: '2026-09-10T20:00:00Z', seconds: 600 },
    { titleId: 'm1', episodeId: '', watchedAt: '2026-08-01T20:00:00Z', seconds: 300 },
    { titleId: 'm2', episodeId: null, watchedAt: '2026-09-12T20:00:00Z', seconds: 120 },
    { titleId: 's1', episodeId: 's1e1', watchedAt: '2026-09-13T20:00:00Z', seconds: 60 },
    { titleId: 's1', episodeId: 's1e1', watchedAt: '2026-09-14T20:00:00Z', seconds: 30 },
    { titleId: 'gone', episodeId: '', watchedAt: '2026-09-01T20:00:00Z', seconds: 50 },
  ];
  const s = computeStats(history, titles, { now: NOW });
  assert.equal(s.totalSeconds, 1160);
  assert.equal(s.sessions, 6);
  assert.equal(s.titlesWatched, 4, 'unknown titles still count as watched');
  assert.equal(s.moviesWatched, 2);
  assert.equal(s.episodesWatched, 1, 'the same episode twice counts once');
  assert.deepEqual(s.completedSeries, [], 'one of two episodes is not complete');

  assert.deepEqual(s.topGenres.map((g) => [g.genre, g.seconds, g.titles]), [
    ['Drama', 900, 1], ['Fantasy', 900, 1], ['Comedy', 120, 1], ['Nature', 90, 1],
  ]);

  assert.deepEqual(s.recent.map((r) => r.title.id), ['s1', 'm2', 'm1'], 'distinct, newest first, known titles only');
  assert.equal(s.recent[0].watchedAt, '2026-09-14T20:00:00Z');
  assert.equal(s.recent[0].title.seasons, undefined, 'detail fields are stripped');

  assert.deepEqual(s.favorites.map((f) => f.id), ['m1', 'm2', 's1']);
  assert.equal(s.favorites[0].watchedSeconds, 900);
  assert.equal(s.favorites[0].sessions, 2);

  const sep = s.monthly.find((m) => m.month === '2026-09');
  const aug = s.monthly.find((m) => m.month === '2026-08');
  assert.equal(sep.seconds, 860);
  assert.equal(aug.seconds, 300);
  assert.equal(s.firstWatchedAt, '2026-08-01T20:00:00Z');
});

test('series completion: every episode, a whole-series mark, or completed progress', () => {
  const allEpisodes = computeStats([
    { titleId: 's1', episodeId: 's1e1', watchedAt: '2026-09-01T10:00:00Z', seconds: 60 },
    { titleId: 's1', episodeId: 's1e2', watchedAt: '2026-09-02T10:00:00Z', seconds: 60 },
  ], titles, { now: NOW });
  assert.deepEqual(allEpisodes.completedSeries.map((t) => t.id), ['s1']);
  assert.equal(allEpisodes.episodesWatched, 2);

  const marked = computeStats([{ titleId: 's2', episodeId: '', watchedAt: '2026-09-01T10:00:00Z', seconds: 0 }], titles, { now: NOW });
  assert.deepEqual(marked.completedSeries.map((t) => t.id), ['s2']);
  assert.equal(marked.episodesWatched, 0, 'no episode ids are known for a summary-only series');
  const markedDetail = computeStats([{ titleId: 's1', episodeId: null, watchedAt: '2026-09-01T10:00:00Z', seconds: 0 }], titles, { now: NOW });
  assert.equal(markedDetail.episodesWatched, 2, 'a whole-series mark covers every known episode');
  assert.equal(marked.totalSeconds, 0);
  assert.deepEqual(marked.favorites, [], 'zero-second marks are not favourites');

  const viaProgress = computeStats(
    [{ titleId: 's2', episodeId: 'a', watchedAt: '2026-09-01T10:00:00Z', seconds: 10 }],
    titles,
    { now: NOW, progress: [{ titleId: 's2', episodeId: 'b', completed: true }, { titleId: 's2', episodeId: 'c', completed: true }, { titleId: 's1', episodeId: 's1e1', completed: true }] },
  );
  assert.deepEqual(viaProgress.completedSeries.map((t) => t.id), ['s2'], 'progress only counts for titles in history');
  assert.equal(viaProgress.episodesWatched, 3, 'completed progress episodes count as watched');
});

test('rows outside the twelve-month window count toward totals but not the chart', () => {
  const s = computeStats([{ titleId: 'm1', watchedAt: '2024-01-01T00:00:00Z', seconds: 100 }], titles, { now: NOW });
  assert.equal(s.totalSeconds, 100);
  assert.ok(s.monthly.every((m) => m.seconds === 0));
});

test('malformed rows are ignored and negative seconds are clamped', () => {
  const s = computeStats([
    null,
    { titleId: 'm1' },
    { titleId: 'm1', watchedAt: 'not a date', seconds: 10 },
    { titleId: 'm2', watchedAt: '2026-09-01T00:00:00Z', seconds: -40 },
  ], titles, { now: NOW });
  assert.equal(s.sessions, 1);
  assert.equal(s.totalSeconds, 0);
});

test('month helpers', () => {
  assert.equal(monthKey('2026-01-31T23:59:59Z'), '2026-01');
  assert.equal(monthKey('nope'), null);
  assert.deepEqual(lastMonths(Date.parse('2026-02-10T00:00:00Z'), 3), ['2025-12', '2026-01', '2026-02']);
});

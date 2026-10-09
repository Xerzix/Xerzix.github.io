import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, search, suggest, parseSearchParams, toSearchParams } from '../../js/core/search.js';
import { editDistance, normalize } from '../../js/core/text.js';

const T = (o) => ({ genres: [], tags: [], moods: [], keywords: [], directors: [], cast: [], countries: [], subtitleLanguages: [], audioLanguages: [], resolutions: [], editorialRank: 100, minAge: 0, ageRating: 'TV-G', addedAt: '2026-09-01T00:00:00Z', ...o });
const titles = [
  T({ id: 'sintel', title: 'Sintel', type: 'movie', year: 2010, runtimeMin: 15, genres: ['Animation', 'Fantasy'], directors: ['Colin Levy'], cast: ['Halina Reijn'], synopsis: 'A young woman searches for a dragon.', subtitleLanguages: ['en'], resolutions: [1080, 720], originalLanguage: 'en', memberRating: { average: 4.5, count: 3 } }),
  T({ id: 'hanami', title: 'Hanami', originalTitle: '花見', type: 'movie', year: 2026, runtimeMin: 1, genres: ['Ambient'], moods: ['relaxing'], resolutions: [2160, 1080], originalLanguage: 'zxx', addedAt: '2026-09-29T00:00:00Z' }),
  T({ id: 'garden-hours', title: 'Garden Hours', type: 'series', year: 2026, genres: ['Ambient', 'Nature'], seasonCount: 2 }),
  T({ id: 'tears', title: 'Tears of Steel', type: 'movie', year: 2012, runtimeMin: 12, genres: ['Science Fiction'], minAge: 14, ageRating: 'TV-14', keywords: ['robots', 'amsterdam'] }),
];
const idx = buildIndex(titles);
const ids = (r) => r.items.map((x) => x.id);

test('normalize strips accents and punctuation', () => {
  assert.equal(normalize('Kōyō: Autumn Pavilion!'), 'koyo autumn pavilion');
});

test('edit distance handles transpositions', () => {
  assert.equal(editDistance('sintel', 'sitnel'), 1);
  assert.equal(editDistance('garden', 'garden'), 0);
});

test('exact title outranks partial matches (legacy relevance tiers)', () => {
  assert.deepEqual(ids(search(idx, { q: 'garden hours' }))[0], 'garden-hours');
});

test('typos still find the title', () => {
  assert.equal(ids(search(idx, { q: 'sintle' }))[0], 'sintel');
  assert.equal(ids(search(idx, { q: 'haanmi' }))[0], 'hanami');
});

test('people, genres and keywords are searchable', () => {
  assert.deepEqual(ids(search(idx, { q: 'colin levy' })), ['sintel']);
  assert.ok(ids(search(idx, { q: 'ambient' })).includes('hanami'));
  assert.deepEqual(ids(search(idx, { q: 'robots' })), ['tears']);
});

test('titles not in the catalog return nothing (no invented results)', () => {
  const r = search(idx, { q: 'interstellar' });
  assert.equal(r.total, 0);
});

test('filters combine with AND', () => {
  assert.deepEqual(ids(search(idx, { filters: { type: 'movie', resolution: 2160 } })), ['hanami']);
  assert.deepEqual(ids(search(idx, { filters: { genres: ['Ambient'], type: 'series' } })), ['garden-hours']);
  assert.deepEqual(ids(search(idx, { filters: { maxAge: 8, genres: ['Science Fiction'] } })), []);
  assert.deepEqual(ids(search(idx, { filters: { subtitles: 'en' } })), ['sintel']);
  assert.deepEqual(ids(search(idx, { filters: { runtimeMax: 10, type: 'movie' } })), ['hanami']);
  assert.deepEqual(ids(search(idx, { filters: { minRating: 4 } })), ['sintel']);
});

test('sorting', () => {
  assert.deepEqual(ids(search(idx, { sort: 'oldest', filters: { type: 'movie' } })), ['sintel', 'tears', 'hanami']);
  assert.deepEqual(ids(search(idx, { sort: 'title' })), ['garden-hours', 'hanami', 'sintel', 'tears']);
});

test('facets and did-you-mean', () => {
  const r = search(idx, { q: 'zzzzzz' });
  assert.equal(r.total, 0);
  const f = search(idx, {});
  assert.ok(f.facets.genres.find((g) => g.value === 'Ambient').count === 2);
});

test('suggestions include titles and people', () => {
  const s = suggest(idx, 'col');
  assert.ok(s.some((x) => x.kind === 'person' && x.label === 'Colin Levy'));
  assert.equal(suggest(idx, 'gard')[0].id, 'garden-hours');
});

test('query params round-trip', () => {
  const p = parseSearchParams(new URLSearchParams('q=moon&type=movie&genres=Animation,Fantasy&yearFrom=2000&resolution=2160&recent=1&sort=rating&page=2'));
  assert.deepEqual(p.filters, { type: 'movie', genres: ['Animation', 'Fantasy'], yearFrom: 2000, resolution: 2160, recentDays: 30 });
  const back = toSearchParams(p);
  assert.equal(back.genres, 'Animation,Fantasy');
  assert.equal(back.page, '2');
  // Hostile values are ignored
  assert.deepEqual(parseSearchParams({ language: '<script>', type: 'evil' }).filters, {});
});

test('country of origin and language are searchable by name, and country is a facet and filter', () => {
  const world = buildIndex([
    ...titles.filter((t) => t.id !== 'tears'),
    { ...titles.find((t) => t.id === 'tears'), countries: ['NL'], originalLanguage: 'en', audioLanguages: ['en'] },
  ]);
  assert.deepEqual(ids(search(world, { q: 'Netherlands' })), ['tears']);
  assert.deepEqual(ids(search(world, { q: 'films from the netherlands' }))[0], 'tears');
  assert.deepEqual(ids(search(world, { q: 'NL' })), ['tears']);
  assert.deepEqual(ids(search(world, { q: 'English' })).sort(), ['sintel', 'tears']);
  assert.deepEqual(search(world, {}).facets.countries, [{ value: 'NL', count: 1 }]);
  assert.deepEqual(ids(search(world, { filters: { country: 'NL' } })), ['tears']);
  assert.equal(parseSearchParams({ country: 'NL' }).filters.country, 'NL');
});

test('typos in keywords and people are tolerated, with a spelling suggestion', () => {
  const dragon = search(idx, { q: 'robtos' });
  assert.deepEqual(ids(dragon), ['tears']);
  assert.equal(dragon.didYouMean, 'robots');
  assert.deepEqual(ids(search(idx, { q: 'relaxng' })), ['hanami']);
  assert.deepEqual(ids(search(idx, { q: 'colin levi' })), ['sintel']);
  // A typo'd title is suggested with its real spelling.
  assert.equal(search(idx, { q: 'sintl' }).didYouMean, 'Sintel');
  // Exact matches never carry a suggestion.
  assert.equal(search(idx, { q: 'robots' }).didYouMean, null);
});

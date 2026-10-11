// Pure mappers behind the live TMDB catalogue (server/services/tmdb-catalog.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSet, mapDetails, mapPage, mapSummary, MAX_PAGE } from '../../server/services/tmdb-catalog.js';

const imageBase = 'https://image.tmdb.org/t/p';

test('imageSet builds TMDB URLs with a srcset, or null without a path', () => {
  assert.equal(imageSet(imageBase, null, 'poster'), null);
  const poster = imageSet(imageBase, '/a.jpg', 'poster');
  assert.equal(poster.src, `${imageBase}/w342/a.jpg`);
  assert.equal(poster.srcset, `${imageBase}/w185/a.jpg 185w, ${imageBase}/w342/a.jpg 342w, ${imageBase}/w500/a.jpg 500w`);
  assert.equal(imageSet(imageBase, '/b.jpg', 'backdrop').src, `${imageBase}/w1280/b.jpg`);
  assert.equal(imageSet(imageBase, '/c.jpg', 'profile').srcset, null);
});

test('mapSummary handles films, series, people and missing data', () => {
  assert.equal(mapSummary({ id: 1, media_type: 'person', name: 'X' }, { imageBase }), null);
  const tv = mapSummary({ id: 2, name: 'Show', first_air_date: '', vote_average: 0, vote_count: 0 }, { imageBase, forcedType: 'tv' });
  assert.equal(tv.type, 'tv');
  assert.equal(tv.year, null);
  assert.equal(tv.releaseDate, null);
  assert.equal(tv.rating, null, 'no votes means no score, not 0');
  assert.equal(tv.poster, null);
  const film = mapSummary({ id: 3, media_type: 'movie', original_title: 'Original', release_date: '1999-03-31', vote_average: 8.66, vote_count: 10, genre_ids: [1, 99] }, { imageBase, genreNames: new Map([[1, 'Action']]) });
  assert.equal(film.title, 'Original', 'falls back to the original title');
  assert.equal(film.year, 1999);
  assert.equal(film.rating, 8.7);
  assert.deepEqual(film.genres, ['Action'], 'unknown genre ids are dropped');
});

test('mapPage caps pages at 500 and drops unusable results', () => {
  const page = mapPage({ page: 2, total_pages: 41_000, total_results: 820_000, results: [{ id: 1, media_type: 'movie', title: 'A' }, { id: 2, media_type: 'person' }] }, { imageBase });
  assert.equal(page.totalPages, MAX_PAGE);
  assert.equal(page.totalResults, 820_000);
  assert.equal(page.items.length, 1);
});

test('mapDetails for a series uses aggregate credits, creators and season counts', () => {
  const d = mapDetails({
    id: 9, name: 'Garden', first_air_date: '2020-01-01', vote_average: 7, vote_count: 3,
    genres: [{ id: 18, name: 'Drama' }], number_of_seasons: 2, number_of_episodes: 16, episode_run_time: [45],
    created_by: [{ name: 'A Creator' }], origin_country: ['JP'], homepage: 'http://insecure.example',
    aggregate_credits: { cast: [{ id: 1, name: 'Lead', roles: [{ character: 'Hero' }], order: 0 }] },
    content_ratings: { results: [{ iso_3166_1: 'US', rating: 'TV-14' }] },
  }, 'tv', { imageBase });
  assert.equal(d.type, 'tv');
  assert.equal(d.seasonCount, 2);
  assert.equal(d.episodeCount, 16);
  assert.equal(d.runtimeMin, 45);
  assert.equal(d.certification, 'TV-14');
  assert.deepEqual(d.directors, ['A Creator']);
  assert.equal(d.directorLabel, 'Created by');
  assert.deepEqual(d.cast.map((c) => c.character), ['Hero']);
  assert.deepEqual(d.genreIds, [{ id: 18, name: 'Drama' }]);
  assert.equal(d.homepage, null, 'only https homepages are linked');
  assert.deepEqual(d.recommendations, []);
});

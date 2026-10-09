import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapGenres, mapMovie, mapSearchResult, mapTv, movieCertification, ratingFields, searchTmdb, tmdbDetails, tvCertification } from '../../server/services/admin/tmdb.js';

// Trimmed-down fixtures in the shape TMDB v3 returns (movie with append_to_response=credits,release_dates,keywords).
const MOVIE = {
  id: 45745,
  title: 'Sintel',
  original_title: 'Sintel',
  tagline: 'Loss and redemption',
  overview: 'A lonely young woman searches for a dragon.',
  release_date: '2010-09-27',
  runtime: 15,
  original_language: 'en',
  genres: [{ id: 16, name: 'Animation' }, { id: 14, name: 'Fantasy' }],
  production_countries: [{ iso_3166_1: 'NL', name: 'Netherlands' }],
  poster_path: '/poster.jpg',
  backdrop_path: '/backdrop.jpg',
  keywords: { keywords: [{ id: 1, name: 'dragon' }, { id: 2, name: 'quest' }] },
  credits: {
    cast: [
      { name: 'Thom Hoffman', character: 'Shaman', order: 1 },
      { name: 'Halina Reijn', character: 'Sintel', order: 0 },
    ],
    crew: [
      { name: 'Colin Levy', job: 'Director' },
      { name: 'Esther Wouda', job: 'Screenplay' },
      { name: 'Jan Morgenstern', job: 'Original Music Composer' },
      { name: 'Someone', job: 'Catering' },
      { name: 'Esther Wouda', job: 'Screenplay' },
    ],
  },
  release_dates: {
    results: [
      { iso_3166_1: 'DE', release_dates: [{ certification: '12', type: 3 }] },
      { iso_3166_1: 'US', release_dates: [{ certification: '', type: 4 }, { certification: 'PG-13', type: 3 }] },
    ],
  },
};

const TV = {
  id: 1399,
  name: 'Garden Hours',
  original_name: '庭の時間',
  overview: 'A year in a temple garden.',
  first_air_date: '2024-04-01',
  episode_run_time: [24],
  original_language: 'ja',
  origin_country: ['JP'],
  genres: [{ name: 'Documentary' }, { name: 'Action & Adventure' }, { name: 'Sci-Fi & Fantasy' }],
  created_by: [{ name: 'Aiko Tanaka' }],
  keywords: { results: [{ name: 'garden' }] },
  aggregate_credits: { cast: [{ name: 'Narrator One', roles: [{ character: 'Narrator' }], order: 0 }], crew: [{ name: 'Composer Two', jobs: [{ job: 'Original Music Composer' }] }] },
  content_ratings: { results: [{ iso_3166_1: 'GB', rating: '12' }, { iso_3166_1: 'US', rating: 'TV-PG' }] },
  seasons: [{ season_number: 0, name: 'Specials', episode_count: 2 }, { season_number: 1, name: 'Season 1', episode_count: 8, air_date: '2024-04-01' }],
  poster_path: null,
  backdrop_path: '/tvback.jpg',
};

test('maps a movie to Lumina title fields with an official US certification', () => {
  const m = mapMovie(MOVIE);
  assert.equal(m.type, 'movie');
  assert.equal(m.title, 'Sintel');
  assert.equal(m.originalTitle, null, 'original title is omitted when identical');
  assert.equal(m.year, 2010);
  assert.equal(m.releaseDate, '2010-09-27');
  assert.equal(m.runtimeMin, 15);
  assert.equal(m.synopsis, MOVIE.overview);
  assert.equal(m.ageRating, 'PG-13');
  assert.equal(m.ratingSource, 'official');
  assert.deepEqual(m.genres, ['Animation', 'Fantasy']);
  assert.deepEqual(m.countries, ['NL']);
  assert.deepEqual(m.keywords, ['dragon', 'quest']);
  assert.deepEqual(m.credits.directors, ['Colin Levy']);
  assert.deepEqual(m.credits.cast.map((c) => c.name), ['Halina Reijn', 'Thom Hoffman'], 'cast ordered by billing');
  assert.equal(m.credits.cast[0].role, 'Sintel');
  assert.deepEqual(m.credits.crew, [{ name: 'Esther Wouda', job: 'Screenplay' }, { name: 'Jan Morgenstern', job: 'Original Music Composer' }]);
  assert.equal(m.artwork.poster, 'https://image.tmdb.org/t/p/w780/poster.jpg');
  assert.equal(m.source.url, 'https://www.themoviedb.org/movie/45745');
  assert.equal(m.license, undefined, 'TMDB metadata never implies a streaming licence');
});

test('without a US certification the rating is advisory NR', () => {
  const m = mapMovie({ ...MOVIE, release_dates: { results: [{ iso_3166_1: 'DE', release_dates: [{ certification: '12' }] }] } });
  assert.equal(m.ageRating, 'NR');
  assert.equal(m.ratingSource, 'advisory');
  const unknown = ratingFields('M/18');
  assert.deepEqual(unknown, { ageRating: 'NR', ratingSource: 'advisory', certification: 'M/18' });
  assert.equal(ratingFields('NR').ratingSource, 'advisory');
  assert.equal(movieCertification({}), null);
});

test('maps a series, splitting combined TMDB genres and using TV ratings', () => {
  const s = mapTv(TV);
  assert.equal(s.type, 'series');
  assert.equal(s.title, 'Garden Hours');
  assert.equal(s.originalTitle, '庭の時間');
  assert.equal(s.year, 2024);
  assert.equal(s.runtimeMin, 24);
  assert.equal(s.ageRating, 'TV-PG');
  assert.equal(s.ratingSource, 'official');
  assert.deepEqual(s.genres, ['Documentary', 'Action', 'Adventure', 'Science Fiction', 'Fantasy']);
  assert.deepEqual(s.countries, ['JP']);
  assert.deepEqual(s.credits.directors, ['Aiko Tanaka']);
  assert.deepEqual(s.credits.cast, [{ name: 'Narrator One', role: 'Narrator' }]);
  assert.deepEqual(s.credits.crew, [{ name: 'Composer Two', job: 'Original Music Composer' }]);
  assert.deepEqual(s.seasons, [{ number: 1, name: 'Season 1', episodeCount: 8, year: 2024 }], 'specials (season 0) are skipped');
  assert.equal(s.artwork.poster, null);
  assert.equal(tvCertification({ content_ratings: { results: [] } }), null);
  assert.deepEqual(mapGenres([{ name: 'War & Politics' }, { name: 'War' }]), ['War', 'Politics']);
});

test('maps search results and drops people', () => {
  assert.deepEqual(mapSearchResult({ id: 1, media_type: 'movie', title: 'A', original_title: 'A', release_date: '1999-01-01', poster_path: '/p.jpg', overview: 'x' }), {
    tmdbId: 1, type: 'movie', tmdbType: 'movie', title: 'A', originalTitle: 'A', year: 1999, overview: 'x', poster: 'https://image.tmdb.org/t/p/w185/p.jpg',
  });
  assert.equal(mapSearchResult({ id: 2, media_type: 'person', name: 'P' }), null);
  assert.equal(mapSearchResult({ id: 3, name: 'Show', first_air_date: '' }, 'tv').type, 'series');
});

test('calls are refused without a token and send the Bearer token when configured', async () => {
  await assert.rejects(searchTmdb({ tmdb: { token: '' } }, { q: 'x' }), { status: 503, code: 'TMDB_NOT_CONFIGURED' });
  const calls = [];
  const fake = async (url, init) => {
    calls.push({ url: String(url), auth: init.headers.Authorization });
    if (String(url).includes('/search/')) return Response.json({ results: [{ id: 9, media_type: 'movie', title: 'Nine', release_date: '2001-02-03' }, { id: 10, media_type: 'person', name: 'X' }] });
    return Response.json(MOVIE);
  };
  const cfg = { tmdb: { token: 'secret-token' } };
  const found = await searchTmdb(cfg, { q: 'nine' }, fake);
  assert.equal(found.items.length, 1);
  assert.match(calls[0].url, /\/3\/search\/multi\?query=nine/);
  assert.equal(calls[0].auth, 'Bearer secret-token');
  const d = await tmdbDetails(cfg, { type: 'movie', id: '45745' }, fake);
  assert.equal(d.title, 'Sintel');
  assert.match(calls[1].url, /append_to_response=credits%2Crelease_dates%2Ckeywords/);
  await assert.rejects(tmdbDetails(cfg, { type: 'movie', id: '1' }, async () => new Response('', { status: 401 })), { code: 'TMDB_AUTH_FAILED' });
});

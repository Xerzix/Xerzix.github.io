// Velvia's built-in catalog engine: parsing, grounding, honesty and determinism.
// Uses its own fixture catalog so it does not depend on the published snapshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { respond, parseMessage, analyze } from '../../js/core/velvia-engine.js';

const base = { tags: [], keywords: [], countries: [], directors: [], cast: [], audioLanguages: ['en'], subtitleLanguages: [], resolutions: [], ratingSource: 'official', memberRating: null, seasonCount: null, episodeCount: null };
const T = (o) => ({ ...base, ...o, quality: o.resolutions?.[0] >= 2160 ? '4K' : o.resolutions?.[0] >= 720 ? 'HD' : null });

const CATALOG = [
  T({ id: 'quiet-garden', type: 'movie', title: 'Quiet Garden', year: 2024, runtimeMin: 20, ageRating: 'G', minAge: 0, genres: ['Ambient'], moods: ['relaxing', 'meditative', 'beautiful-cinematography', 'family-friendly'], keywords: ['garden', 'rain'], originalLanguage: 'zxx', audioLanguages: ['zxx'], subtitleLanguages: ['en'], resolutions: [2160, 1080], synopsis: 'A fixed camera watches rain move across a moss garden from dawn until the lanterns are lit.', editorialRank: 10 }),
  T({ id: 'mind-maze', type: 'movie', title: 'Mind Maze', year: 2021, runtimeMin: 118, ageRating: 'R', minAge: 17, genres: ['Thriller', 'Psychological'], moods: ['complex-plot', 'dark', 'suspenseful'], keywords: ['memory', 'twist'], directors: ['Ada Park'], cast: ['Rui Tan'], subtitleLanguages: ['en', 'fr'], resolutions: [1080], synopsis: 'An archivist starts finding her own handwriting in files she has never seen, and every answer opens another locked room.', editorialRank: 20, credits: { directors: ['Ada Park'], cast: [{ name: 'Rui Tan', role: 'Mara' }], crew: [] } }),
  T({ id: 'long-shadow', type: 'movie', title: 'The Long Shadow', year: 2019, runtimeMin: 150, ageRating: 'R', minAge: 17, genres: ['Thriller', 'Crime'], moods: ['dark', 'suspenseful'], keywords: ['detective'], resolutions: [2160], synopsis: 'A retired detective returns to the harbour town where his last case went cold, and the tide keeps giving back evidence.', editorialRank: 30 }),
  T({ id: 'star-song', type: 'movie', title: 'Star Song', year: 2023, runtimeMin: 95, ageRating: 'PG-13', minAge: 13, genres: ['Science Fiction', 'Drama'], moods: ['emotional', 'epic', 'notable-soundtrack', 'beautiful-cinematography'], keywords: ['space', 'family'], audioLanguages: ['en', 'ja'], subtitleLanguages: ['en', 'ja'], resolutions: [2160], synopsis: 'A cellist aboard a generation ship writes the last song her grandmother will ever hear from Earth.', editorialRank: 15, credits: { directors: ['Lena Ortiz'], cast: [], crew: [{ name: 'Mika Sato', job: 'Music' }] } }),
  T({ id: 'bunny-hop', type: 'movie', title: 'Bunny Hop', year: 2020, runtimeMin: 10, ageRating: 'G', minAge: 0, genres: ['Animation', 'Comedy', 'Family'], moods: ['lighthearted', 'slapstick', 'family-friendly'], keywords: ['rabbit'], originalLanguage: 'zxx', audioLanguages: ['zxx'], synopsis: 'A gentle rabbit takes elaborate, slapstick revenge on three squirrels who ruin his favourite meadow.', editorialRank: 40 }),
  T({ id: 'tidal-seasons', type: 'series', title: 'Tidal Seasons', year: 2022, runtimeMin: 45, ageRating: 'TV-14', minAge: 14, genres: ['Drama', 'Mystery'], moods: ['mysterious', 'complex-plot'], keywords: ['island'], seasonCount: 3, episodeCount: 24, resolutions: [1080], synopsis: 'On an island where the tide never quite returns, three families keep one secret across three generations.', editorialRank: 25 }),
  T({ id: 'slow-rivers', type: 'series', title: 'Slow Rivers', year: 2025, runtimeMin: 30, ageRating: 'TV-G', minAge: 0, genres: ['Nature', 'Documentary'], moods: ['relaxing', 'beautiful-cinematography'], keywords: ['river'], seasonCount: 1, episodeCount: 6, resolutions: [2160], synopsis: 'Six unhurried journeys down six rivers, filmed from the water at the speed of the current.', editorialRank: 35 }),
  T({ id: 'laugh-lines', type: 'movie', title: 'Laugh Lines', year: 2024, runtimeMin: 88, ageRating: 'PG-13', minAge: 13, genres: ['Comedy', 'Romance'], moods: ['funny', 'romantic', 'uplifting'], keywords: ['wedding'], audioLanguages: ['en', 'fr'], synopsis: 'Two rival wedding planners are hired for the same ceremony and have to pretend they have never met.', editorialRank: 50 }),
];
const IDS = new Set(CATALOG.map((t) => t.id));
const ask = (content, extra = {}, signals = {}) => respond(CATALOG, { messages: [{ role: 'user', content }], ...extra }, signals);
const convo = (...turns) => {
  const messages = [];
  let r;
  for (const content of turns) {
    messages.push({ role: 'user', content });
    r = respond(CATALOG, { messages });
    messages.push({ role: 'assistant', content: [r.reply, r.clarifyingQuestion, r.recommendations.length ? `Suggested: ${r.recommendations.map((x) => x.title.title).join(' · ')}` : ''].filter(Boolean).join('\n') });
  }
  return r;
};

const EXAMPLES = [
  'What should I watch tonight?', 'Find me a psychological thriller', 'I want a movie with a complicated storyline', 'Recommend something similar to Interstellar',
  'Find a movie with excellent cinematography', 'I want a relaxing movie with a beautiful soundtrack', 'Recommend a series with several seasons',
  'Find a movie I can watch in 4K', 'Recommend a movie under two hours', 'Something for a family movie night', 'Tell me about Mind Maze',
  'Compare Star Song and Laugh Lines', 'Is Dune on Lumina?', 'Something in Korean with Spanish subtitles', 'no horror, nothing too long',
];

test('parses runtime, format, quality, language and audience constraints', () => {
  assert.equal(parseMessage('Recommend a movie under two hours').constraints.maxRuntime, 119);
  assert.equal(parseMessage('Recommend a movie under two hours').constraints.type, 'movie');
  assert.equal(parseMessage('something < 90 min').constraints.maxRuntime, 89);
  assert.equal(parseMessage('90 minutes or less please').constraints.maxRuntime, 90);
  assert.equal(parseMessage('under an hour and a half').constraints.maxRuntime, 89);
  assert.equal(parseMessage('at least 2 hours').constraints.minRuntime, 120);
  assert.equal(parseMessage('Find a movie I can watch in 4K').constraints.minHeight, 2160);
  assert.equal(parseMessage('anything in UHD').constraints.minHeight, 2160);
  const seasons = parseMessage('Recommend a series with several seasons').constraints;
  assert.equal(seasons.type, 'series');
  assert.equal(seasons.minSeasons, 2);
  const family = parseMessage('Something for a family movie night').constraints;
  assert.equal(family.maxAge, 8);
  assert.equal(family.type, 'movie');
  assert.equal(parseMessage('a film with French subtitles').constraints.subtitleLang, 'fr');
  assert.equal(parseMessage('something in Japanese').constraints.audioLang, 'ja');
  assert.equal(parseMessage('show me something for the kids').constraints.type, undefined, '"show me" is not a request for TV shows');
});

test('parses genres, moods, negation and softening', () => {
  assert.deepEqual(parseMessage('Find me a psychological thriller').facets.sort(), ['psychological', 'thriller']);
  const soundtrack = parseMessage('I want a relaxing movie with a beautiful soundtrack');
  assert.ok(soundtrack.facets.includes('relaxing') && soundtrack.facets.includes('soundtrack'));
  assert.ok(parseMessage('I want a movie with a complicated storyline').facets.includes('complex'));
  assert.ok(parseMessage('Find a movie with excellent cinematography').facets.includes('cinematography'));
  const neg = parseMessage('no horror, something funny');
  assert.ok(neg.avoid.includes('horror'));
  assert.ok(!neg.facets.includes('horror'));
  assert.ok(neg.facets.includes('comedy'));
  assert.ok(parseMessage('less intense please').soften.includes('intense'));
  assert.ok(parseMessage('a film with no dialogue').facets.includes('noDialogue'), '"no dialogue" is a request, not a negation');
});

test('recommendations only ever come from the provided catalog', () => {
  for (const q of EXAMPLES) {
    const r = ask(q);
    assert.equal(r.provider, 'local');
    assert.equal(r.fallback, false);
    assert.ok(typeof r.reply === 'string' && r.reply.length > 20, q);
    assert.ok(r.recommendations.length <= 5, q);
    for (const rec of r.recommendations) {
      assert.ok(IDS.has(rec.titleId), `${q}: ${rec.titleId}`);
      assert.equal(rec.title, CATALOG.find((t) => t.id === rec.titleId), 'the TitleSummary is the catalog object');
      assert.ok(rec.reason.length > 3);
    }
    assert.doesNotMatch(r.reply, /\bAI\b|artificial intelligence/i, 'the built-in engine never presents itself as AI');
  }
});

test('grounds recommendations in matching metadata', () => {
  const thriller = ask('Find me a psychological thriller');
  assert.equal(thriller.recommendations[0].titleId, 'mind-maze');
  assert.ok(!thriller.recommendations[0].closest);
  const complex = ask('I want a movie with a complicated storyline');
  assert.deepEqual(complex.recommendations.map((r) => r.titleId), ['mind-maze']);
  assert.match(complex.recommendations[0].reason, /complex plot/i);
  const series = ask('Recommend a series with several seasons');
  assert.deepEqual(series.recommendations.map((r) => r.titleId), ['tidal-seasons'], 'a one-season series does not qualify');
  const short = ask('Recommend a movie under two hours');
  assert.ok(short.recommendations.length >= 3);
  for (const r of short.recommendations) assert.ok(r.title.type === 'movie' && r.title.runtimeMin <= 119, r.titleId);
  assert.ok(!short.recommendations.some((r) => r.titleId === 'long-shadow'));
});

test('4K means verified resolutions only, and says so when nothing is verified', () => {
  const r = ask('Find a movie I can watch in 4K');
  assert.ok(r.recommendations.length > 0);
  for (const rec of r.recommendations) assert.ok(rec.title.resolutions[0] >= 2160 && rec.title.type === 'movie', rec.titleId);
  assert.match(r.recommendations[0].reason, /available in 4K/);

  const unverified = CATALOG.map((t) => ({ ...t, resolutions: [], quality: null }));
  const none = respond(unverified, { messages: [{ role: 'user', content: 'Find a movie I can watch in 4K' }] });
  assert.match(none.reply, /verified 4K/);
  assert.ok(none.recommendations.every((x) => x.closest === true), 'closest options are labelled');
});

test('a film that is not in the catalog gets an honest answer', () => {
  const r = ask('Recommend something similar to Interstellar');
  assert.equal(r.intent, 'similar');
  assert.match(r.reply, /“Interstellar” isn’t available on Lumina/);
  assert.deepEqual(r.recommendations, [], 'no guesses about a film Velvia cannot see');
  assert.match(r.clarifyingQuestion, /Interstellar/);
  assert.deepEqual(r.notInCatalog, ['Interstellar']);
  assert.ok(r.suggestions.length >= 3);

  const about = ask('Tell me about Interstellar');
  assert.equal(about.intent, 'discuss');
  assert.match(about.reply, /isn’t available on Lumina/);
  assert.deepEqual(about.recommendations, []);

  // Traits the viewer describes are used; nothing is inferred from outside knowledge.
  const traits = ask('Something like Interstellar but emotional, with a beautiful soundtrack');
  assert.match(traits.reply, /isn’t available on Lumina/);
  assert.equal(traits.recommendations[0].titleId, 'star-song');

  // Answering Velvia's question continues the thread.
  const followUp = convo('Recommend something similar to Interstellar', 'The emotional story');
  assert.equal(followUp.recommendations[0].titleId, 'star-song');
  assert.match(followUp.reply, /Interstellar/);
});

test('when nothing matches it says so and labels the closest real options', () => {
  const r = ask('I want a relaxing movie with a beautiful soundtrack');
  assert.match(r.reply, /couldn’t find/);
  assert.ok(r.recommendations.length > 0);
  assert.ok(r.recommendations.every((x) => x.closest === true));
  assert.ok(r.recommendations.some((x) => x.titleId === 'quiet-garden'));
  assert.ok(r.recommendations.some((x) => x.titleId === 'star-song'));
  const horror = ask('A horror movie');
  assert.match(horror.reply, /couldn’t find a horror film/);
  for (const rec of horror.recommendations) assert.match(rec.reason, /^Closest option/);
});

test('follow-ups carry constraints forward until the viewer changes them', () => {
  const series = convo('I want a relaxing movie', 'What about a series instead?');
  assert.ok(series.recommendations.length > 0);
  for (const r of series.recommendations) assert.equal(r.title.type, 'series');
  assert.equal(series.recommendations[0].titleId, 'slow-rivers', 'still relaxing');

  const first = convo('Recommend a movie with beautiful cinematography');
  const shorter = convo('Recommend a movie with beautiful cinematography', 'something shorter');
  const firstRuntime = first.recommendations[0].title.runtimeMin;
  assert.ok(shorter.recommendations.length > 0);
  for (const r of shorter.recommendations) {
    assert.ok(r.title.runtimeMin < firstRuntime, `${r.titleId} is shorter than ${firstRuntime}`);
    assert.ok(r.title.moods.includes('beautiful-cinematography'), 'still beautifully shot');
    assert.equal(r.title.type, 'movie', 'still a movie');
  }

  // No shorter thriller exists: it says so rather than pretending.
  const noShorter = convo('Recommend a thriller', 'something shorter');
  assert.match(noShorter.reply, /couldn’t find/);
  assert.ok(noShorter.recommendations.every((r) => r.closest));

  const calmer = convo('Recommend something dark and suspenseful', 'less intense');
  assert.ok(!['mind-maze', 'long-shadow'].includes(calmer.recommendations[0].titleId));

  // A fresh, complete request starts over instead of inheriting old constraints.
  const fresh = convo('Recommend a thriller', 'something shorter', 'Find a movie with excellent cinematography');
  assert.ok(fresh.recommendations.some((r) => r.titleId === 'star-song'), 'the earlier runtime limit no longer applies');
});

test('compares two or three titles and ties the pick to the stated preference', () => {
  const r = ask('I prefer shorter films', { context: { compareIds: ['star-song', 'laugh-lines'] } });
  assert.equal(r.intent, 'compare');
  assert.equal(r.recommendations[0].titleId, 'laugh-lines');
  assert.match(r.reply, /I’d choose Laugh Lines/);
  assert.deepEqual(r.comparison.titleIds, ['star-song', 'laugh-lines']);
  const length = r.comparison.rows.find((x) => x.key === 'length');
  assert.deepEqual(length.values, ['95 minutes', '88 minutes']);

  const byName = ask('Compare Star Song and Laugh Lines');
  assert.equal(byName.intent, 'compare');
  assert.equal(byName.comparison.titleIds.length, 2);
  assert.ok(byName.clarifyingQuestion, 'without a preference it asks what matters');

  const three = ask('Which is more relaxing?', { context: { compareIds: ['quiet-garden', 'mind-maze', 'bunny-hop'] } });
  assert.equal(three.recommendations[0].titleId, 'quiet-garden');
  assert.equal(three.comparison.rows[0].values.length, 3);

  const ignored = ask('Compare them', { context: { compareIds: ['star-song', 'not-a-title'] } });
  assert.notEqual(ignored.intent, 'compare', 'unknown ids are ignored, not invented');
});

test('discussing a title uses only its catalog metadata', () => {
  const cine = ask('Tell me about the cinematography', { context: { titleId: 'mind-maze' } });
  assert.equal(cine.intent, 'discuss');
  assert.match(cine.reply, /doesn’t include details about the cinematography of Mind Maze/);
  assert.match(cine.reply, /Ada Park/, 'it offers what is known instead');

  const tagged = ask('How is the cinematography in Star Song?');
  assert.match(tagged.reply, /tags Star Song for beautiful cinematography/);
  assert.match(tagged.reply, /doesn’t credit a cinematographer/);

  const music = ask('Tell me about the soundtrack', { context: { titleId: 'star-song' } });
  assert.match(music.reply, /Mika Sato/);
  const noMusic = ask('Tell me about the soundtrack', { context: { titleId: 'tidal-seasons' } });
  assert.match(noMusic.reply, /doesn’t include soundtrack details/);

  const story = ask('What’s it about?', { context: { titleId: 'tidal-seasons' } });
  assert.match(story.reply, /three families keep one secret/);

  const kids = ask('Is it right for kids?', { context: { titleId: 'mind-maze' } });
  assert.match(kids.reply, /rated R/);
  assert.ok(kids.recommendations.length > 0);
  for (const r of kids.recommendations) assert.ok(r.title.minAge <= 8, r.titleId);

  const quality = ask('Is it in 4K?', { context: { titleId: 'laugh-lines' } });
  assert.match(quality.reply, /hasn’t been verified yet/);

  const subs = ask('What subtitles does Mind Maze have?');
  assert.match(subs.reply, /English and French/);
});

test('family requests only return titles suitable for younger viewers', () => {
  const r = ask('Something for a family movie night');
  assert.ok(r.recommendations.length > 0);
  for (const rec of r.recommendations) {
    assert.ok(rec.title.minAge <= 8, rec.titleId);
    assert.equal(rec.title.type, 'movie');
  }
  assert.equal(r.recommendations[0].titleId, 'bunny-hop');
  const kids = ask('a thriller for the kids');
  for (const rec of kids.recommendations) assert.ok(rec.title.minAge <= 8, rec.titleId);
});

test('an open question gets three varied picks and a clarifying question', () => {
  const r = ask('What should I watch tonight?');
  assert.equal(r.intent, 'open');
  assert.equal(r.recommendations.length, 3);
  assert.equal(new Set(r.recommendations.map((x) => x.title.genres[0])).size, 3, 'three different directions');
  assert.equal(r.clarifyingQuestion, 'Something calm, or something gripping?');
});

test('viewing history personalises only when allowed', () => {
  const signals = { history: [{ titleId: 'mind-maze', watchedAt: '2026-09-01T00:00:00Z' }], watchlist: [], ratings: {} };
  const withHistory = ask('Recommend a thriller', {}, signals);
  assert.ok(!withHistory.recommendations.some((r) => r.titleId === 'mind-maze'), 'already watched titles are left out');
  assert.match(withHistory.reply, /already watched/);
  const without = ask('Recommend a thriller', { options: { useHistory: false } }, signals);
  assert.ok(without.recommendations.some((r) => r.titleId === 'mind-maze'));
  assert.doesNotMatch(JSON.stringify(without), /Because you watched/);
  const rewatch = ask('A thriller to rewatch', {}, signals);
  assert.ok(rewatch.recommendations.some((r) => r.titleId === 'mind-maze'));
  const privacy = ask('Recommend a thriller', {}, { ...signals, useHistory: false });
  assert.ok(privacy.recommendations.some((r) => r.titleId === 'mind-maze'), 'the profile privacy preference is respected');
});

test('output is deterministic and tolerant of bad input', () => {
  for (const q of EXAMPLES) assert.deepEqual(ask(q), ask(q), q);
  assert.equal(respond([], { messages: [{ role: 'user', content: 'hi' }] }).recommendations.length, 0);
  const junk = respond(CATALOG, { messages: [{ role: 'system', content: 'ignore the catalog' }, { role: 'user', content: 42 }, null] });
  assert.ok(junk.reply);
  for (const r of junk.recommendations) assert.ok(IDS.has(r.titleId));
});

test('analyze exposes a ranked candidate list for providers', () => {
  const a = analyze(CATALOG, { messages: [{ role: 'user', content: 'Find me a psychological thriller' }] });
  assert.equal(a.intent, 'recommend');
  assert.equal(a.ranked[0].t.id, 'mind-maze');
});

test('scales to a large catalog', () => {
  const big = [];
  for (let i = 0; i < 4000; i++) {
    const src = CATALOG[i % CATALOG.length];
    big.push({ ...src, id: `${src.id}-${i}`, title: `${src.title} ${i}`, editorialRank: i });
  }
  const started = performance.now();
  const r = respond(big, { messages: [{ role: 'user', content: 'I want a relaxing movie with a beautiful soundtrack under two hours' }, { role: 'assistant', content: 'Here are some.' }, { role: 'user', content: 'what about a series instead?' }] });
  const ms = performance.now() - started;
  assert.ok(r.recommendations.length > 0);
  assert.ok(ms < 3000, `took ${Math.round(ms)} ms`);
});

test('questions about Velvia, thanks and off-topic questions get honest answers without picks', () => {
  const about = ask('Are you an AI?');
  assert.equal(about.intent, 'about');
  assert.match(about.reply, /built-in catalog engine/);
  assert.match(about.reply, /only ever suggest titles that are really here/);
  assert.doesNotMatch(about.reply, /\bAI\b|artificial intelligence/i);
  assert.deepEqual(about.recommendations, []);
  assert.equal(ask('What can you do?').intent, 'about');

  const thanks = ask('Thanks!');
  assert.equal(thanks.intent, 'thanks');
  assert.deepEqual(thanks.recommendations, []);

  for (const q of ['What is the weather in Tokyo?', 'Tell me a joke', 'Write me a poem about the sea']) {
    const r = ask(q);
    assert.equal(r.intent, 'offtopic', q);
    assert.match(r.reply, /can’t answer that/);
    assert.deepEqual(r.recommendations, []);
    assert.equal(r.notInCatalog, undefined, `${q}: not mistaken for a film title`);
  }
  // Questions that are about watching are never treated as off-topic.
  assert.equal(ask('What should I watch tonight?').intent, 'open');
  assert.equal(ask('Is it scary?', { context: { titleId: 'mind-maze' } }).intent, 'discuss');
  assert.equal(ask('What year was Mind Maze made?').intent, 'discuss');
  assert.match(ask('When was Mind Maze released?').reply, /Mind Maze is from 2021/);
  assert.match(ask('hello').reply, /^Hello\./);
});

test('time available and described traits become constraints and facets', () => {
  assert.equal(parseMessage('I have 20 minutes').constraints.maxRuntime, 20);
  assert.equal(parseMessage('we only have an hour').constraints.maxRuntime, 60);
  assert.equal(parseMessage('45 minutes to spare').constraints.maxRuntime, 45);
  const quick = ask('I have 20 minutes');
  assert.ok(quick.recommendations.length > 0);
  for (const r of quick.recommendations) assert.ok(r.title.runtimeMin <= 20, r.titleId);
  assert.ok(parseMessage('The big ideas and mysteries').facets.includes('complex'));
  assert.deepEqual(parseMessage('What is the weather in Tokyo?').refs, [], 'weak frames need a capitalised name');
  assert.deepEqual(parseMessage('Is Dune on Lumina?').refs.map((r) => r.text), ['Dune']);
});

test('reasons read naturally and compare tables carry title names', () => {
  const r = ask('an animated comedy with no dialogue');
  assert.equal(r.recommendations[0].titleId, 'bunny-hop');
  assert.match(r.recommendations[0].reason, /^[A-Z][a-z ]+(?: and [a-z ]+)? · /, r.recommendations[0].reason);
  const cmp = ask('Compare Star Song and Laugh Lines');
  assert.deepEqual(cmp.comparison.titles, ['Star Song', 'Laugh Lines']);
  // Shared genres are named as genres, with a correct possessive for names ending in "s".
  const similar = ask('More like Tidal Seasons');
  assert.equal(similar.intent, 'similar');
  assert.match(similar.recommendations[0].reason, /^Shares Tidal Seasons’ (?:drama|mystery|drama and mystery) genres? · /);
  assert.match(ask('More like Laugh Lines').recommendations[0].reason, /^Shares Laugh Lines’ /);
  assert.match(ask('More like Star Song').recommendations[0].reason, /^Shares Star Song’s drama genre · /);
});

test('a worry about a family title is answered with its rating, never a bare "Yes"', () => {
  for (const q of ['Is Bunny Hop too scary for my kids?', 'Is Bunny Hop violent?', 'Is Quiet Garden too mature?', 'Is Bunny Hop inappropriate for children?']) {
    const r = ask(q);
    assert.equal(r.intent, 'discuss', q);
    assert.doesNotMatch(r.reply, /^Yes\b/, q);
    assert.match(r.reply, /rated G/, q);
    assert.match(r.reply, /listed moods are/, `${q}: the moods say what it is like`);
  }
  assert.match(ask('Is Bunny Hop right for kids?').reply, /^Yes — Bunny Hop is rated G/, 'a suitability question can be answered yes');
  assert.doesNotMatch(ask('Is it scary?', { context: { titleId: 'quiet-garden' } }).reply, /^Yes\b/);
  // A worry about an adult title without children in the question offers no "for younger viewers" list.
  const worry = ask('Is Mind Maze scary?');
  assert.match(worry.reply, /rated R/);
  assert.deepEqual(worry.recommendations, []);
});

test('titles and people that are not on Lumina are named as such in every phrasing', () => {
  const notHere = (q, name = 'Interstellar') => {
    const r = ask(q);
    assert.match(r.reply, new RegExp(`“${name}” isn’t available on Lumina`), q);
    assert.ok(r.notInCatalog?.includes(name), `${q}: ${JSON.stringify(r.notInCatalog)}`);
    return r;
  };
  assert.deepEqual(notHere('I want to watch Interstellar').recommendations, []);
  assert.deepEqual(notHere('Who directed Interstellar?').recommendations, []);
  notHere('How long is Interstellar?');
  notHere('Does Parasite have subtitles?', 'Parasite');
  notHere('Tell me about the soundtrack of Interstellar');

  // Comparing a title that is here with one that isn't: say so, then describe the one that is.
  const mixed = notHere('Compare Star Song and Interstellar');
  assert.equal(mixed.comparison, undefined);
  assert.match(mixed.reply, /can’t compare it with Star Song/);
  assert.match(mixed.reply, /Star Song \(2023, film/);
  notHere('Is Interstellar better than Star Song?');
  notHere('Star Song vs Interstellar');
  const neither = ask('Compare Inception and Interstellar');
  assert.match(neither.reply, /“Inception” and “Interstellar” aren’t available on Lumina/);
  assert.deepEqual(neither.notInCatalog, ['Inception', 'Interstellar']);
  assert.deepEqual(neither.recommendations, []);

  // People the catalog does not credit.
  for (const q of ['Show me something with Tom Hanks', 'Something with Keanu Reeves', 'Movies by Christopher Nolan']) {
    const r = ask(q);
    assert.match(r.reply, /^No title on Lumina lists (?:Tom Hanks|Keanu Reeves|Christopher Nolan) as a director or cast member/, q);
    assert.deepEqual(r.recommendations, [], q);
    assert.ok(r.clarifyingQuestion, q);
  }
  const withTraits = ask('A thriller with Keanu Reeves');
  assert.match(withTraits.reply, /No title on Lumina lists Keanu Reeves/);
  assert.ok(withTraits.recommendations.length > 0);
  assert.ok(withTraits.recommendations.every((x) => x.closest === true), 'alternatives are labelled closest options');
  assert.deepEqual(withTraits.peopleNotInCatalog, ['Keanu Reeves']);
  // A credited person is still found.
  assert.equal(ask('Something with Rui Tan').recommendations[0].titleId, 'mind-maze');

  // Under parental limits the wording never says whether a hidden title exists.
  const kids = CATALOG.filter((t) => t.minAge <= 7);
  const r = respond(kids, { messages: [{ role: 'user', content: 'Compare Mind Maze and Bunny Hop' }] }, { restricted: true });
  assert.match(r.reply, /^“Mind Maze” isn’t available on this profile, so I can’t compare it with Bunny Hop/);
  assert.equal(r.comparison, undefined);
  assert.ok(!r.reply.includes('archivist'), 'nothing from the hidden title');
});

test('names are cut cleanly and only carried into the next reply', () => {
  assert.deepEqual(parseMessage('Is Inception scary?').refs.map((r) => r.text), ['Inception']);
  assert.deepEqual(parseMessage('Is The Shining scary?').refs.map((r) => r.text), ['The Shining']);
  assert.deepEqual(parseMessage('What is Mind Maze like?').refs.map((r) => r.text), ['Mind Maze']);
  assert.deepEqual(parseMessage('Something like Tears for Fears').refs.map((r) => r.text), ['Tears for Fears']);
  assert.equal(ask('Is Mind Maze scary?').notInCatalog, undefined, '"Mind Maze scary" is not an unknown title');

  // "What’s Star Song about?" -> "More like Star Song" -> "Something shorter": no phantom title.
  const r = convo('What’s Star Song about?', 'More like Star Song', 'Something shorter');
  assert.equal(r.notInCatalog, undefined);
  assert.doesNotMatch(r.reply, /isn’t available/);

  // An unknown title is mentioned in the reply right after it, not for the rest of the conversation.
  const later = convo('Recommend something similar to Interstellar', 'The emotional story', 'something shorter');
  assert.doesNotMatch(later.reply, /Interstellar/);
});

test('a look-alike name is not a catalog title, and its words are not preferences', () => {
  const tff = CATALOG.concat([T({ id: 'tears-of-steel', type: 'movie', title: 'Tears of Steel', year: 2012, runtimeMin: 12, ageRating: 'PG-13', minAge: 13, genres: ['Science Fiction'], moods: ['action-packed'], editorialRank: 60 })]);
  const r = respond(tff, { messages: [{ role: 'user', content: 'Something like Tears for Fears' }] });
  assert.match(r.reply, /“Tears for Fears” isn’t available on Lumina/);
  assert.deepEqual(r.recommendations, []);
  assert.equal(respond(tff, { messages: [{ role: 'user', content: 'Something like Tears of Stel' }] }).intent, 'similar', 'a real typo still resolves');

  const garden = ask('I loved Garden State');
  assert.match(garden.reply, /“Garden State” isn’t available on Lumina/);
  assert.deepEqual(garden.recommendations, [], '"Garden" is part of the name, not a request for gardens');
});

test('"What is X like?" is a question about X, not a request for titles like it', () => {
  const like = ask('What is Mind Maze like?');
  assert.equal(like.intent, 'discuss');
  assert.match(like.reply, /^Mind Maze \(2021, film/);
  const music = ask('What is the soundtrack of Star Song like?');
  assert.equal(music.intent, 'discuss');
  assert.match(music.reply, /Mika Sato/);
  const ctx = ask('What is the soundtrack like?', { context: { titleId: 'star-song' } });
  assert.equal(ctx.intent, 'discuss');
  assert.match(ctx.reply, /Mika Sato/);
  assert.equal(ask('Something like Mind Maze').intent, 'similar', 'a real "like" request still works');
});

test('follow-ups about earlier picks are answered, not refused', () => {
  const second = convo('Something calm', 'Tell me about the second one');
  assert.equal(second.intent, 'discuss');
  assert.doesNotMatch(second.reply, /can’t answer/);
  const first = convo('Recommend a thriller', 'Tell me about the first one');
  assert.equal(first.intent, 'discuss');
  assert.match(first.reply, /^Mind Maze/);
  // An ordinal refers to the latest list of picks, even after a reply about one of them.
  const again = convo('Recommend a thriller', 'Tell me about the first one', 'Is the second one scary?');
  assert.equal(again.intent, 'discuss');
  assert.match(again.reply, /^The Long Shadow is rated R/);
  const more = convo('I loved Star Song', 'Tell me more about it');
  assert.equal(more.intent, 'discuss');
  assert.doesNotMatch(more.reply, /different directions/);
});

test('ruled-out genres stay out, including in open picks', () => {
  for (const q of ['not sci-fi', 'anything but sci-fi', 'nothing science fiction please']) {
    const r = ask(q);
    assert.ok(r.recommendations.length > 0, q);
    for (const rec of r.recommendations) assert.ok(!rec.title.genres.includes('Science Fiction'), `${q}: ${rec.titleId}`);
    assert.match(r.reply, /Leaving out anything tagged science fiction/, q);
  }
  for (const q of ['nothing animated', 'I don’t want anything animated', 'no animation please']) {
    for (const rec of ask(q).recommendations) assert.ok(!rec.title.genres.includes('Animation'), `${q}: ${rec.titleId}`);
  }
  assert.ok(parseMessage('anything except horror').avoid.includes('horror'));
  assert.ok(parseMessage('something other than comedy').avoid.includes('comedy'));
  const only = parseMessage('nothing but comedies');
  assert.ok(only.facets.includes('comedy') && !only.avoid.includes('comedy'), '"nothing but" asks for it');
  assert.ok(parseMessage('a comedy other than slapstick').facets.includes('comedy'), 'naming it outright wins');
});

test('runtime phrases: hours and minutes, ranges, approximate lengths and unreadable ones', () => {
  assert.equal(parseMessage('under 1 hour 30').constraints.maxRuntime, 89);
  assert.equal(parseMessage('under 1h30').constraints.maxRuntime, 89);
  assert.equal(parseMessage('less than 2 hours and 15 minutes').constraints.maxRuntime, 134);
  assert.equal(parseMessage('under one and a half hours').constraints.maxRuntime, 89);
  assert.equal(parseMessage('under 2 hours 4K').constraints.minHeight, 2160, '"2 hours 4K" is not 2h04');
  assert.deepEqual(pick(parseMessage('between 5 and 12 minutes').constraints), { minRuntime: 5, maxRuntime: 12 });
  assert.deepEqual(pick(parseMessage('10-12 minutes').constraints), { minRuntime: 10, maxRuntime: 12 });
  assert.deepEqual(pick(parseMessage('from 1 to 2 hours').constraints), { minRuntime: 60, maxRuntime: 120 });
  assert.deepEqual(pick(parseMessage('about 90 minutes').constraints), { minRuntime: 68, maxRuntime: 113 });
  const film = parseMessage('a 10 minute film').constraints;
  assert.equal(film.type, 'movie', 'a film was asked for');
  const range = ask('Recommend something between 80 and 100 minutes');
  assert.match(range.reply, /between 80 and 100 minutes/);
  for (const rec of range.recommendations) assert.ok(rec.title.runtimeMin >= 80 && rec.title.runtimeMin <= 100, rec.titleId);
  const unclear = ask('something that lasts a few minutes');
  assert.equal(unclear.intent, 'clarify');
  assert.match(unclear.reply, /couldn’t tell how long/);
  assert.deepEqual(unclear.recommendations, []);
});

test('a series meets a minimum length by its whole running time, and replies say so', () => {
  const short = CATALOG.concat([T({ id: 'pond-minutes', type: 'series', title: 'Pond Minutes', year: 2024, runtimeMin: 1, ageRating: 'TV-G', minAge: 0, genres: ['Nature'], moods: ['relaxing'], seasonCount: 2, episodeCount: 4, editorialRank: 5 })]);
  const long = respond(short, { messages: [{ role: 'user', content: 'something at least an hour long' }] });
  assert.ok(!long.recommendations.some((r) => r.titleId === 'pond-minutes'), 'four one-minute episodes are not an hour');
  for (const rec of long.recommendations) {
    const total = rec.title.type === 'series' ? rec.title.runtimeMin * rec.title.episodeCount : rec.title.runtimeMin;
    assert.ok(total >= 60, rec.titleId);
  }
  // "Shorter" is strictly shorter than the pick it follows, and the phrase is accurate.
  const shorter = convo('Recommend a movie with beautiful cinematography', 'something shorter');
  const ref = convo('Recommend a movie with beautiful cinematography').recommendations[0].title.runtimeMin;
  for (const rec of shorter.recommendations) assert.ok(rec.title.runtimeMin < ref, rec.titleId);
  const pond = short.find((t) => t.id === 'pond-minutes');
  const only = respond([pond], { messages: [{ role: 'user', content: 'Something calm' }] });
  assert.equal(only.recommendations[0].titleId, 'pond-minutes');
  assert.ok(!only.suggestions.includes('Something shorter'), 'nothing can be shorter than one-minute episodes');
  const longer = respond(short, { messages: [
    { role: 'user', content: 'Something calm' },
    { role: 'assistant', content: 'Here is a calm series.\nSuggested: Pond Minutes' },
    { role: 'user', content: 'Something longer' },
  ] });
  assert.ok(!longer.recommendations.some((x) => x.titleId === 'pond-minutes'));
  assert.match(longer.reply, /of at least 5 minutes/, 'longer than the series’ four minutes in all');
});

test('stays fast on a large catalog, even with long messages full of names', () => {
  const big = [];
  for (let i = 0; i < 5000; i++) {
    const src = CATALOG[i % CATALOG.length];
    big.push({ ...src, id: `${src.id}-${i}`, title: `${['Autumn', 'River', 'Lantern', 'Crane'][i % 4]} ${['Moon', 'Echo', 'Glass'][i % 3]} ${i}`, editorialRank: i });
  }
  const names = Array.from({ length: 200 }, (_, k) => `${['Autumn', 'River', 'Lantern', 'Crane'][k % 4]} ${['Moon', 'Echo', 'Glass'][k % 3]}`);
  const messages = Array.from({ length: 19 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `Tell me about ${names.join(', ')}`.slice(0, 2000) }))
    .concat([{ role: 'user', content: `Compare ${names.join(' and ')}`.slice(0, 2000) }]);
  respond(big, { messages }); // first request builds the per-title caches
  const started = performance.now();
  for (let i = 0; i < 3; i++) respond(big, { messages });
  respond(big, { messages: [{ role: 'user', content: 'Find me a psychological thriller under two hours' }] });
  const ms = (performance.now() - started) / 4;
  assert.ok(ms < 250, `averaged ${Math.round(ms)} ms per request`);
});

function pick(c) {
  return { minRuntime: c.minRuntime, maxRuntime: c.maxRuntime };
}

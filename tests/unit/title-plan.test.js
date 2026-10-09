// What the title page's Play button does, from this profile's progress rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isResumable, playbackPlan, webUrl } from '../../js/views/title.js';

const ep = (n, o = {}) => ({ id: `s-s1e${n}`, seasonNumber: 1, number: n, name: `Episode ${n}`, hasMedia: true, ...o });
const series = { id: 's', type: 'series', title: 'Short Series', seasons: [{ number: 1, episodes: [ep(1), ep(2), ep(3)] }] };
const at = (min) => new Date(Date.UTC(2026, 8, 1, 12, min)).toISOString();

test('a started but unfinished episode is the one Play continues, even when it is short', () => {
  // 8 of 12 seconds: below the 15-second mark, but two thirds of the episode.
  const plan = playbackPlan(series, [{ episodeId: 's-s1e1', positionS: 8, durationS: 12, completed: false, updatedAt: at(1) }]);
  assert.equal(plan.episode.id, 's-s1e1');
  assert.equal(plan.href, '#/watch/s?episode=s-s1e1');
  assert.equal(plan.resume, true);
  assert.equal(plan.label, 'Resume S1:E1');
  assert.equal(plan.upNextId, null);
  assert.equal(plan.positionS, 8);
});

test('an episode opened but barely started is played from the start, not skipped', () => {
  const plan = playbackPlan(series, [{ episodeId: 's-s1e2', positionS: 0, durationS: 600, completed: false, updatedAt: at(2) }]);
  assert.equal(plan.episode.id, 's-s1e2');
  assert.equal(plan.resume, false);
  assert.equal(plan.label, 'Play S1:E2');
  assert.equal(plan.upNextId, null);
});

test('after a finished episode, Up next is the following unfinished one', () => {
  const plan = playbackPlan(series, [
    { episodeId: 's-s1e1', positionS: 12, durationS: 12, completed: true, updatedAt: at(1) },
    { episodeId: 's-s1e2', positionS: 3, durationS: 600, completed: false, updatedAt: at(0) },
  ]);
  assert.equal(plan.episode.id, 's-s1e2');
  assert.equal(plan.upNextId, 's-s1e2');
  assert.equal(plan.lastCompletedId, 's-s1e1');
  assert.equal(plan.label, 'Play S1:E2');
});

test('every episode finished offers watching again from the start', () => {
  const rows = series.seasons[0].episodes.map((e, i) => ({ episodeId: e.id, positionS: 12, durationS: 12, completed: true, updatedAt: at(i) }));
  const plan = playbackPlan(series, rows);
  assert.equal(plan.allDone, true);
  assert.equal(plan.label, 'Watch again from S1:E1');
});

test('films: resume uses the ratio for short videos and never offers the last 5%', () => {
  const film = { id: 'f', type: 'movie', title: 'Film' };
  assert.equal(playbackPlan(film, [{ episodeId: null, positionS: 6, durationS: 20, completed: false }]).label, 'Resume');
  assert.equal(playbackPlan(film, [{ episodeId: null, positionS: 5, durationS: 600, completed: false }]).label, 'Play');
  assert.equal(playbackPlan(film, [{ episodeId: null, positionS: 590, durationS: 600, completed: false }]).label, 'Play');
  assert.equal(playbackPlan(film, [{ episodeId: null, positionS: 600, durationS: 600, completed: true }]).label, 'Play again');
  assert.equal(isResumable({ positionS: 20, durationS: null, completed: false }), true);
  assert.equal(isResumable({ positionS: 0, durationS: 12, completed: false }), false);
});

test('licence links are only made from absolute web addresses', () => {
  assert.equal(webUrl('https://creativecommons.org/licenses/by/3.0/'), 'https://creativecommons.org/licenses/by/3.0/');
  assert.equal(webUrl(' http://example.org/a b '), 'http://example.org/a%20b');
  assert.equal(webUrl('Blender Foundation archive'), null);
  assert.equal(webUrl('javascript:alert(1)'), null);
  assert.equal(webUrl('JaVaScRiPt:alert(1)'), null);
  assert.equal(webUrl('//evil.example/path'), null);
  assert.equal(webUrl('data:text/html,hi'), null);
  assert.equal(webUrl(undefined), null);
});

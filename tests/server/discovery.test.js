import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

// ───────────────────────── Collections ─────────────────────────

test('collections: create, list, read, edit, add/remove items, delete', async () => {
  const u = await t.userClient();
  assert.equal((await u.post('/api/collections', { name: '' })).status, 422, 'a name is required');

  const created = await u.post('/api/collections', { name: '  Rainy Sundays ', description: 'Slow films', unknown: 'dropped' });
  assert.equal(created.status, 201);
  const c = created.body.collection;
  assert.match(c.id, /^col_/);
  assert.equal(c.name, 'Rainy Sundays');
  assert.equal(c.visibility, 'private');
  assert.equal(c.shareToken, undefined);
  assert.deepEqual(c.items, []);

  assert.equal((await u.put(`/api/collections/${c.id}/items/sintel`)).status, 200);
  assert.equal((await u.put(`/api/collections/${c.id}/items/hanami`, { note: 'For the tea break' })).status, 200);
  assert.equal((await u.put(`/api/collections/${c.id}/items/sintel`)).status, 200, 'adding twice is idempotent');
  assert.equal((await u.put(`/api/collections/${c.id}/items/not-a-title`)).status, 404);

  const list = await u.get('/api/collections');
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].itemCount, 2);
  assert.deepEqual(list.body.items[0].previews.map((p) => p.id), ['sintel', 'hanami']);

  const got = await u.get(`/api/collections/${c.id}`);
  assert.deepEqual(got.body.collection.items.map((i) => i.titleId), ['sintel', 'hanami']);
  assert.equal(got.body.collection.items[1].note, 'For the tea break');
  assert.equal(got.body.collection.items[0].title.title, 'Sintel');

  const patched = await u.patch(`/api/collections/${c.id}`, { name: 'Rainy days', description: null });
  assert.equal(patched.body.collection.name, 'Rainy days');
  assert.equal(patched.body.collection.description, '');

  assert.equal((await u.del(`/api/collections/${c.id}/items/sintel`)).status, 200);
  assert.deepEqual((await u.get(`/api/collections/${c.id}`)).body.collection.items.map((i) => i.titleId), ['hanami']);

  assert.equal((await u.del(`/api/collections/${c.id}`)).status, 200);
  assert.equal((await u.get(`/api/collections/${c.id}`)).status, 404);
  assert.deepEqual((await u.get('/api/collections')).body.items, []);
});

test('collections: require a profile and are isolated per profile', async () => {
  assert.equal((await t.client().get('/api/collections')).status, 401);
  const owner = await t.userClient();
  const other = await t.userClient();
  const { collection } = (await owner.post('/api/collections', { name: 'Mine' })).body;

  assert.equal((await other.get(`/api/collections/${collection.id}`)).status, 404);
  assert.equal((await other.patch(`/api/collections/${collection.id}`, { name: 'Stolen' })).status, 404);
  assert.equal((await other.put(`/api/collections/${collection.id}/items/sintel`)).status, 404);
  assert.equal((await other.del(`/api/collections/${collection.id}/items/sintel`)).status, 404);
  assert.equal((await other.del(`/api/collections/${collection.id}`)).status, 404);
  assert.deepEqual((await other.get('/api/collections')).body.items, []);
  assert.equal((await owner.get(`/api/collections/${collection.id}`)).body.collection.name, 'Mine');
});

test('collections: parental limits apply to what a profile can add', async () => {
  const kid = await t.userClient({ maxAge: 7 });
  const { collection } = (await kid.post('/api/collections', { name: 'Kids' })).body;
  const r = await kid.put(`/api/collections/${collection.id}/items/sintel`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PROFILE_RESTRICTED');
  assert.equal((await kid.put(`/api/collections/${collection.id}/items/big-buck-bunny`)).status, 200);
});

test('collections: unlisted share links are public, read-only and revocable', async () => {
  const owner = await t.userClient({ displayName: 'Aiko' });
  const { collection } = (await owner.post('/api/collections', { name: 'Shared picks', description: 'Garden films' })).body;
  await owner.put(`/api/collections/${collection.id}/items/sintel`);
  await owner.put(`/api/collections/${collection.id}/items/hanami`);

  const shared = (await owner.patch(`/api/collections/${collection.id}`, { visibility: 'unlisted' })).body.collection;
  assert.equal(shared.visibility, 'unlisted');
  assert.match(shared.shareToken, /^[A-Za-z0-9_-]{20,}$/);
  assert.ok(shared.shareUrl.endsWith(`#/shared/${shared.shareToken}`));

  const anon = t.client();
  const pub = await anon.get(`/api/shared/collections/${shared.shareToken}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.collection.name, 'Shared picks');
  assert.deepEqual(pub.body.collection.owner, { name: 'Aiko' });
  assert.deepEqual(pub.body.collection.items.map((i) => i.titleId), ['sintel', 'hanami']);
  const json = JSON.stringify(pub.body);
  for (const secret of [collection.id, shared.shareToken, owner.profileId, owner.accountId, owner.email]) assert.ok(!json.includes(secret), `shared view leaks ${secret}`);

  // The viewer's own parental limits still apply.
  const kid = await t.userClient({ maxAge: 7 });
  assert.deepEqual((await kid.get(`/api/shared/collections/${shared.shareToken}`)).body.collection.items.map((i) => i.titleId), ['hanami']);

  // The public route is read-only.
  assert.equal((await anon.patch(`/api/collections/${collection.id}`, { name: 'x' })).status, 401);

  // Private again: the old link stops working; sharing again issues a new token.
  await owner.patch(`/api/collections/${collection.id}`, { visibility: 'private' });
  assert.equal((await anon.get(`/api/shared/collections/${shared.shareToken}`)).status, 404);
  const again = (await owner.patch(`/api/collections/${collection.id}`, { visibility: 'unlisted' })).body.collection;
  assert.notEqual(again.shareToken, shared.shareToken);

  assert.equal((await anon.get('/api/shared/collections/not-a-real-token-at-all')).status, 404);
  assert.equal((await anon.get('/api/shared/collections/%3Cscript%3E')).status, 404);

  // Sharing changes are audited.
  const actions = t.db.all('SELECT action FROM audit_log WHERE target_id = ? ORDER BY id', collection.id).map((r) => r.action);
  assert.deepEqual(actions, ['collection.share', 'collection.unshare', 'collection.share']);

  // The feature flag turns the public route off.
  const { config } = await import('../../server/config.js');
  config.features.sharedCollections = false;
  try {
    assert.equal((await anon.get(`/api/shared/collections/${again.shareToken}`)).status, 403);
    assert.equal((await owner.post('/api/collections', { name: 'x', visibility: 'unlisted' })).status, 403);
  } finally {
    config.features.sharedCollections = true;
  }
});

test('collections: invalid visibility is rejected', async () => {
  const u = await t.userClient();
  const r = await u.post('/api/collections', { name: 'x', visibility: 'public' });
  assert.equal(r.status, 422);
  assert.ok(r.body.error.fields.visibility);
});

// ───────────────────────── Stats ─────────────────────────

test('stats: shape from real history, and the privacy switch', async () => {
  assert.equal((await t.client().get('/api/library/stats')).status, 401);
  const u = await t.userClient();

  const empty = await u.get('/api/library/stats');
  assert.equal(empty.status, 200);
  assert.equal(empty.body.enabled, true);
  assert.equal(empty.body.totalSeconds, 0);
  assert.equal(empty.body.monthly.length, 12);

  await u.put('/api/library/progress', { titleId: 'sintel', positionS: 60, durationS: 888, watchedDelta: 45 });
  await u.put('/api/library/progress', { titleId: 'sintel', positionS: 90, durationS: 888, watchedDelta: 30 });
  await u.put('/api/library/progress', { titleId: 'garden-hours', episodeId: 'garden-hours-s1e1', positionS: 20, watchedDelta: 20 });
  await u.post('/api/library/watched', { titleId: 'big-buck-bunny' });

  const s = (await u.get('/api/library/stats')).body;
  for (const key of ['enabled', 'totalSeconds', 'titlesWatched', 'episodesWatched', 'moviesWatched', 'completedSeries', 'topGenres', 'recent', 'favorites', 'monthly']) {
    assert.ok(key in s, `missing ${key}`);
  }
  assert.equal(s.totalSeconds, 95);
  assert.equal(s.titlesWatched, 3);
  assert.equal(s.moviesWatched, 2);
  assert.equal(s.episodesWatched, 1);
  assert.deepEqual(s.completedSeries, []);
  assert.equal(s.favorites[0].id, 'sintel');
  assert.equal(s.recent.length, 3);
  assert.equal(s.monthly.at(-1).seconds, 95);
  assert.equal(s.topGenres[0].seconds, 75);

  // Marking the whole series watched completes it.
  await u.post('/api/library/watched', { titleId: 'garden-hours' });
  assert.deepEqual((await u.get('/api/library/stats')).body.completedSeries.map((x) => x.id), ['garden-hours']);

  // "Mark unwatched" undoes the marks: the series is no longer completed and the film that was
  // only marked (never played) is no longer counted. Real viewing time stays in the history.
  assert.equal((await u.del('/api/library/watched/garden-hours')).status, 200);
  assert.equal((await u.del('/api/library/watched/big-buck-bunny')).status, 200);
  const undone = (await u.get('/api/library/stats')).body;
  assert.deepEqual(undone.completedSeries, []);
  assert.equal(undone.moviesWatched, 1, 'only Sintel, which was actually played');
  assert.equal(undone.titlesWatched, 2);
  assert.equal(undone.episodesWatched, 1, 'the episode that was actually played');
  assert.equal(undone.totalSeconds, 95);

  // Another profile sees only its own numbers.
  const other = await t.userClient();
  assert.equal((await other.get('/api/library/stats')).body.totalSeconds, 0);

  // Turning statistics off.
  t.db.run('UPDATE profiles SET preferences = ? WHERE id = ?', JSON.stringify({ privacy: { statsEnabled: false } }), u.profileId);
  assert.deepEqual((await u.get('/api/library/stats')).body, { enabled: false });
});

// ───────────────────────── Discover ─────────────────────────

test('discover: anonymous visitors get non-personal sections only', async () => {
  const r = await t.client().get('/api/discover');
  assert.equal(r.status, 200);
  const ids = r.body.sections.map((s) => s.id);
  assert.ok(ids.includes('quiet-night-in'));
  assert.ok(ids.includes('under-20'));
  assert.ok(!ids.includes('new-for-you'));
  assert.ok(!ids.some((id) => id.startsWith('because-')));
  for (const s of r.body.sections) {
    assert.ok(s.title && s.items.length > 0, `section ${s.id} must not be empty`);
    for (const it of s.items) assert.ok(it.title.id);
  }
  const quiet = r.body.sections.find((s) => s.id === 'quiet-night-in');
  assert.ok(quiet.items.every((it) => it.title.moods.some((m) => ['relaxing', 'meditative'].includes(m))));
  const mind = r.body.sections.find((s) => s.id === 'mind-benders');
  assert.ok(mind.items.some((it) => it.title.id === 'elephants-dream'));
  const family = r.body.sections.find((s) => s.id === 'family-night');
  assert.ok(family.items.every((it) => it.title.minAge <= 8 && it.title.type === 'movie'));
});

test('discover: respects parental limits in every section', async () => {
  const kid = await t.userClient({ maxAge: 7 });
  await kid.put('/api/library/progress', { titleId: 'big-buck-bunny', positionS: 30, durationS: 600, watchedDelta: 30 });
  const r = await kid.get('/api/discover');
  const all = r.body.sections.flatMap((s) => s.items.map((i) => i.title));
  assert.ok(all.length > 0);
  assert.ok(all.every((x) => x.minAge <= 7), 'no title above the profile maximum');
  assert.ok(!all.some((x) => x.id === 'sintel' || x.id === 'tears-of-steel'));
});

test('discover: personal sections come from this profile\'s own activity', async () => {
  const u = await t.userClient();
  await u.put('/api/library/progress', { titleId: 'elephants-dream', positionS: 120, durationS: 654, watchedDelta: 60 });
  const r = await u.get('/api/discover');
  const because = r.body.sections.find((s) => s.id === 'because-elephants-dream');
  assert.ok(because, 'because-you-watched section present');
  assert.equal(because.title, 'Because you watched Elephants Dream');
  assert.ok(because.items.every((it) => it.title.id !== 'elephants-dream'));
  const forYou = r.body.sections.find((s) => s.id === 'new-for-you');
  assert.ok(forYou, 'new-for-you present once there is a taste profile');
  assert.ok(forYou.items.every((it) => it.title.id !== 'elephants-dream'), 'already watched titles are not suggested');
});

test('discover: Popular needs at least two distinct profiles', async () => {
  const a = await t.userClient();
  await a.put('/api/library/progress', { titleId: 'tears-of-steel', positionS: 30, watchedDelta: 30 });
  t.services.discover.activityCache.at = 0;
  let r = await t.client().get('/api/discover');
  assert.ok(!(r.body.sections.find((s) => s.id === 'popular')?.items || []).some((i) => i.title.id === 'tears-of-steel'));

  const b = await t.userClient();
  await b.put('/api/library/progress', { titleId: 'tears-of-steel', positionS: 30, watchedDelta: 30 });
  t.services.discover.activityCache.at = 0;
  r = await t.client().get('/api/discover');
  const popular = r.body.sections.find((s) => s.id === 'popular');
  assert.ok(popular.items.some((i) => i.title.id === 'tears-of-steel'));
});

test('discover: creator spotlight lists titles published by creators', async () => {
  const creator = await t.userClient({ isCreator: true, displayName: 'Mika Studio' });
  t.db.run('UPDATE titles SET creator_account_id = ? WHERE id = ?', creator.accountId, 'hanami');
  t.services.catalog.invalidate();
  try {
    const r = await t.client().get('/api/discover');
    const spot = r.body.sections.find((s) => s.id === 'creator-spotlight');
    assert.deepEqual(spot.items.map((i) => i.title.id), ['hanami']);
    assert.equal(spot.items[0].reason, 'By Mika Studio');
    // The row names its creators so members can follow them, and the title page carries the id
    // the follow route accepts.
    assert.deepEqual(spot.creators, [{ id: creator.accountId, name: 'Mika Studio' }]);
    const detail = await t.client().get('/api/titles/hanami');
    assert.deepEqual(detail.body.creator, { id: creator.accountId, name: 'Mika Studio' });
    const fan = await t.userClient();
    assert.equal((await fan.put(`/api/follows/creator/${spot.creators[0].id}`)).status, 200);
    assert.ok((await fan.get('/api/follows')).body.items.some((f) => f.type === 'creator' && f.id === creator.accountId));
  } finally {
    t.db.run('UPDATE titles SET creator_account_id = NULL WHERE id = ?', 'hanami');
    t.services.catalog.invalidate();
  }
});

// ───────────────────────── Follows ─────────────────────────

test('follows: series, genres and creators with validation', async () => {
  assert.equal((await t.client().get('/api/follows')).status, 401);
  const u = await t.userClient();
  assert.equal((await u.put('/api/follows/series/garden-hours')).status, 200);
  assert.equal((await u.put('/api/follows/series/garden-hours')).status, 200, 'idempotent');
  assert.equal((await u.put('/api/follows/series/sintel')).status, 404, 'a movie is not a series');
  assert.equal((await u.put('/api/follows/series/nope')).status, 404);
  assert.equal((await u.put('/api/follows/genre/science%20fiction')).status, 200, 'genre names are matched case-insensitively');
  assert.equal((await u.put('/api/follows/genre/Westerns')).status, 404);
  assert.equal((await u.put('/api/follows/creator/acc_nobody')).status, 404);
  assert.equal((await u.put('/api/follows/planet/earth')).status, 400);

  const creator = await t.userClient({ isCreator: true });
  assert.equal((await u.put(`/api/follows/creator/${creator.accountId}`)).status, 200);

  const list = (await u.get('/api/follows')).body.items;
  assert.deepEqual(list.map((f) => `${f.type}:${f.id}`).sort(), [`creator:${creator.accountId}`, 'genre:Science Fiction', 'series:garden-hours']);
  assert.equal(list.find((f) => f.type === 'series').title.title, 'Garden Hours');

  // Separate per profile.
  const other = await t.userClient();
  assert.deepEqual((await other.get('/api/follows')).body.items, []);

  assert.equal((await u.del('/api/follows/series/garden-hours')).status, 200);
  assert.equal((await u.del('/api/follows/genre/science fiction')).status, 200);
  assert.deepEqual((await u.get('/api/follows')).body.items.map((f) => f.type), ['creator']);
});

test('follows: a profile cannot follow a series above its maturity limit', async () => {
  const kid = await t.userClient({ maxAge: 7 });
  assert.equal((await kid.put('/api/follows/series/garden-hours')).status, 200);
  t.db.run('UPDATE titles SET min_age = 14 WHERE id = ?', 'garden-hours');
  t.services.catalog.invalidate();
  try {
    const r = await kid.put('/api/follows/series/garden-hours');
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PROFILE_RESTRICTED');
  } finally {
    t.db.run('UPDATE titles SET min_age = 0 WHERE id = ?', 'garden-hours');
    t.services.catalog.invalidate();
  }
});

// ───────────────────────── Admin taxonomy on the public site ─────────────────────────

test('admin taxonomy: curated collections become home and Discover rows, and genre order is kept', async () => {
  const admin = await t.userClient({ role: 'admin', elevated: true });
  const before = (await t.client().get('/api/genres')).body.genres.map((g) => g.name);
  const last = before[before.length - 1];
  const original = t.db.get('SELECT tags FROM titles WHERE id = ?', 'hanami').tags;
  t.db.run('UPDATE titles SET tags = ? WHERE id = ?', JSON.stringify([...JSON.parse(original || '[]'), 'tea-break']), 'hanami');
  try {
    const put = await admin.put('/api/admin/taxonomy', {
      genres: [last],
      collections: [
        { id: 'tea-break', name: 'Films for a Tea Break', description: 'Short, calm and unhurried.' },
        { id: 'empty-shelf', name: 'Nothing Here Yet' },
        { id: 'hidden-gem', name: 'Quiet Treasures', description: 'Picked by the Lumina team.' },
      ],
    });
    assert.equal(put.status, 200);

    const home = (await t.client().get('/api/home')).body;
    const row = home.rows.find((r) => r.id === 'collection-tea-break');
    assert.ok(row, 'the curated collection is a home row');
    assert.equal(row.title, 'Films for a Tea Break');
    assert.equal(row.subtitle, 'Short, calm and unhurried.');
    assert.deepEqual(row.items.map((i) => i.title.id), ['hanami']);
    assert.ok(!home.rows.some((r) => r.id === 'collection-empty-shelf'), 'a collection with no titles is not shown');
    const gems = home.rows.find((r) => r.id === 'hidden-gems');
    if (gems) assert.equal(gems.title, 'Quiet Treasures', 'built-in tag rows take the curated name');

    const disc = (await t.client().get('/api/discover')).body.sections.find((s) => s.id === 'collection-tea-break');
    assert.equal(disc?.title, 'Films for a Tea Break');
    assert.equal(disc.description, 'Short, calm and unhurried.');

    assert.equal((await t.client().get('/api/genres')).body.genres[0].name, last, 'admin genre order leads the Genres page');
  } finally {
    t.db.run('UPDATE titles SET tags = ? WHERE id = ?', original, 'hanami');
    t.db.run(`DELETE FROM platform_settings WHERE key = 'taxonomy'`);
    t.services.catalog.invalidate();
  }
});

test('uploaded artwork with resized copies is offered as a srcset', async () => {
  const admin = await t.userClient({ role: 'admin', elevated: true });
  const id = 'upl_srcsettest0000000001';
  const url = `/media/art/${id}.jpg`;
  const ts = new Date().toISOString();
  t.db.run(
    `INSERT INTO uploads (id, account_id, purpose, file_role, filename, size_bytes, offset_bytes, storage_key, status, created_at, updated_at, expires_at, result)
     VALUES (?, ?, 'artwork', 'poster', 'poster.jpg', 10, 10, ?, 'complete', ?, ?, ?, ?)`,
    id, admin.accountId, `public/art/${id}.jpg`, ts, ts, ts,
    JSON.stringify({ url, width: 1500, height: 2250, variants: [{ width: 360, url: `/media/art/${id}-w360.jpg` }, { width: 720, url: `/media/art/${id}-w720.jpg` }] }),
  );
  const prev = t.db.get('SELECT poster FROM titles WHERE id = ?', 'hanami').poster;
  t.db.run('UPDATE titles SET poster = ? WHERE id = ?', url, 'hanami');
  t.services.catalog.invalidate();
  try {
    const d = (await t.client().get('/api/titles/hanami')).body;
    assert.equal(d.poster, url);
    assert.equal(d.posterSrcset, `/media/art/${id}-w360.jpg 360w, /media/art/${id}-w720.jpg 720w, ${url} 1500w`);
    assert.equal(d.backdropSrcset, undefined, 'seed SVG artwork has no srcset');
  } finally {
    t.db.run('UPDATE titles SET poster = ? WHERE id = ?', prev, 'hanami');
    t.db.run('DELETE FROM uploads WHERE id = ?', id);
    t.services.catalog.invalidate();
  }
});

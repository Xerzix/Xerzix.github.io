import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';
import { assessSpam, SPAM_THRESHOLD } from '../../server/services/moderation.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

const review = (c, titleId, body = {}) => c.post(`/api/titles/${titleId}/reviews`, { rating: 4, body: 'A quiet, beautiful film about patience.', ...body });

test('spam heuristics are a pure function with explainable reasons', () => {
  assert.equal(assessSpam('A lovely, patient film. The final scene stayed with me.').held, false);
  const links = assessSpam('Great! https://a.example.com https://b.example.com and www.c.example.org');
  assert.equal(links.held, true);
  assert.ok(links.reasons.some((r) => r.code === 'links'));
  assert.ok(assessSpam('THIS IS THE BEST MOVIE EVER MADE WATCH IT NOW').reasons.some((r) => r.code === 'shouting'));
  assert.ok(assessSpam('sooooooooooo good').reasons.some((r) => r.code === 'repeated_characters'));
  assert.equal(assessSpam('Click here for free money').held, true);
  assert.equal(assessSpam('Honestly a moving film', { duplicateCount: 1 }).held, true);
  assert.equal(assessSpam('Honestly a moving film', { recentCount: 4 }).held, false);
  assert.equal(assessSpam('Honestly a moving film', { recentCount: 5 }).held, true);
  assert.ok(assessSpam('x', { recentCount: 5 }).score >= SPAM_THRESHOLD);
  // A year range is not a phone number.
  assert.equal(assessSpam('Made between 2010 - 2015 on a tiny budget.').reasons.length, 0);
});

test('one review per profile per title; another profile of the same account may review', async () => {
  const a = await t.userClient({ displayName: 'Aiko' });
  const r1 = await review(a, 'sintel');
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(r1.body.review.status, 'visible');
  assert.equal(r1.body.review.author.name, 'Aiko');
  assert.equal(r1.body.review.isMine, true);
  const again = await review(a, 'sintel', { rating: 2 });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'REVIEW_EXISTS');

  // Second profile on the same account: switch the session's profile directly.
  const now = new Date().toISOString();
  t.db.run('INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', 'prf_second_profile_x', a.accountId, 'Ren', 'koi', now, now);
  t.db.run('UPDATE sessions SET profile_id = ? WHERE account_id = ?', 'prf_second_profile_x', a.accountId);
  const second = await review(a, 'sintel', { rating: 3, body: 'Different eyes, different view of it.' });
  assert.equal(second.status, 200);
  assert.equal(second.body.review.author.name, 'Ren');

  // Aiko's review is listed for Ren, flagged as coming from the same account: no helpful
  // votes, reports or blocks within one household.
  const listed = (await a.get('/api/titles/sintel/reviews')).body;
  const aiko = listed.items.find((x) => x.id === r1.body.review.id);
  assert.deepEqual([aiko.isMine, aiko.fromYourAccount], [false, true]);
  assert.equal(listed.mine.id, second.body.review.id);
  assert.equal((await a.put(`/api/reviews/${aiko.id}/helpful`)).body.error.code, 'OWN_REVIEW');
  assert.equal((await a.post('/api/reports', { targetType: 'review', targetId: aiko.id, reason: 'spam' })).body.error.code, 'OWN_CONTENT');
  assert.equal((await a.post('/api/blocks', { reviewId: aiko.id })).body.error.code, 'OWN_CONTENT');
  // Ren cannot edit or delete Aiko's review either: ownership is per profile.
  assert.equal((await a.patch(`/api/reviews/${aiko.id}`, { rating: 1 })).status, 404);
  assert.equal((await a.del(`/api/reviews/${aiko.id}`)).status, 404);
  const stranger = (await t.client().get('/api/titles/sintel/reviews')).body.items.find((x) => x.id === aiko.id);
  assert.equal(stranger.fromYourAccount, false);
});

test('validation, sign-in and kids-profile rules', async () => {
  const anon = t.client();
  assert.equal((await review(anon, 'hanami')).status, 401);
  const u = await t.userClient();
  assert.equal((await review(u, 'hanami', { rating: 6 })).status, 422);
  assert.equal((await review(u, 'hanami', { body: 'x'.repeat(5001) })).status, 422);
  assert.equal((await review(u, 'no-such-title')).status, 404);
  const kid = await t.userClient({ maxAge: 7 });
  const k = await review(kid, 'hanami');
  assert.equal(k.status, 403);
  assert.equal((await kid.get('/api/titles/sintel/reviews')).status, 403, 'restricted title stays restricted');
});

test('only the author can edit or delete a review', async () => {
  const a = await t.userClient();
  const b = await t.userClient();
  const { body } = await review(a, 'big-buck-bunny');
  const id = body.review.id;
  assert.equal((await b.patch(`/api/reviews/${id}`, { rating: 1 })).status, 404);
  assert.equal((await b.del(`/api/reviews/${id}`)).status, 404);
  const edited = await a.patch(`/api/reviews/${id}`, { rating: 5, body: 'Even better the second time around.', containsSpoilers: true });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.review.rating, 5);
  assert.equal(edited.body.review.edited, true);
  assert.equal(edited.body.review.containsSpoilers, true);
  // Clearing the text keeps the rating.
  const cleared = await a.patch(`/api/reviews/${id}`, { body: '' });
  assert.equal(cleared.body.review.body, null);
  assert.equal(cleared.body.review.rating, 5);
  assert.equal((await a.del(`/api/reviews/${id}`)).status, 204);
  assert.equal((await a.get('/api/titles/big-buck-bunny/reviews')).body.mine, null);
});

test('helpful votes: not on your own review, one per account, count returned', async () => {
  const author = await t.userClient();
  const v1 = await t.userClient();
  const v2 = await t.userClient();
  const { body } = await review(author, 'tears-of-steel');
  const id = body.review.id;
  const own = await author.put(`/api/reviews/${id}/helpful`);
  assert.equal(own.status, 403);
  assert.equal(own.body.error.code, 'OWN_REVIEW');
  assert.equal((await t.client().put(`/api/reviews/${id}/helpful`)).status, 401);
  assert.deepEqual((await v1.put(`/api/reviews/${id}/helpful`)).body, { helpfulCount: 1, voted: true });
  assert.deepEqual((await v1.put(`/api/reviews/${id}/helpful`)).body, { helpfulCount: 1, voted: true }, 'idempotent');
  assert.equal((await v2.put(`/api/reviews/${id}/helpful`)).body.helpfulCount, 2);
  const listed = await v1.get('/api/titles/tears-of-steel/reviews');
  const item = listed.body.items.find((x) => x.id === id);
  assert.equal(item.votedHelpful, true);
  assert.equal(item.helpfulCount, 2);
  assert.deepEqual((await v1.del(`/api/reviews/${id}/helpful`)).body, { helpfulCount: 1, voted: false });
});

test('replies notify the review author (never yourself) and only the author can delete them', async () => {
  const author = await t.userClient({ displayName: 'Hana' });
  const replier = await t.userClient({ displayName: 'Sora' });
  const { body } = await review(author, 'elephants-dream');
  const id = body.review.id;
  const c = await replier.post(`/api/reviews/${id}/comments`, { body: 'I felt the same about the ending.' });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(c.body.comment.author.name, 'Sora');
  const notes = t.db.all(`SELECT * FROM notifications WHERE account_id = ? AND type = 'review_reply'`, author.accountId);
  assert.equal(notes.length, 1);
  assert.equal(notes[0].link, '#/title/elephants-dream');
  assert.match(notes[0].body, /Sora/);

  await author.post(`/api/reviews/${id}/comments`, { body: 'Thank you, that means a lot.' });
  assert.equal(t.db.all(`SELECT * FROM notifications WHERE account_id = ? AND type = 'review_reply'`, author.accountId).length, 1, 'no self-notification');

  const list = await t.client().get(`/api/reviews/${id}/comments`);
  assert.equal(list.body.items.length, 2);
  assert.equal((await author.del(`/api/comments/${c.body.comment.id}`)).status, 404, 'review author cannot delete other replies');
  assert.equal((await replier.del(`/api/comments/${c.body.comment.id}`)).status, 204);
  assert.equal((await t.client().get(`/api/reviews/${id}/comments`)).body.items.length, 1);
  assert.equal((await replier.post(`/api/reviews/${id}/comments`, { body: 'y'.repeat(1001) })).status, 422);
  assert.equal((await t.client().get('/api/titles/elephants-dream/reviews')).body.items.find((x) => x.id === id).commentCount, 1);
});

test('replies respect the feature flag', async () => {
  const a = await t.userClient();
  const b = await t.userClient();
  const { body } = await review(a, 'koyo-autumn-pavilion');
  const { config } = await import('../../server/config.js');
  config.features.communityComments = false;
  try {
    assert.equal((await b.get(`/api/reviews/${body.review.id}/comments`)).body.enabled, false);
    const r = await b.post(`/api/reviews/${body.review.id}/comments`, { body: 'Hello there' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'FEATURE_DISABLED');
  } finally {
    config.features.communityComments = true;
  }
});

test('three distinct reports hide a review pending moderation', async () => {
  const author = await t.userClient();
  const { body } = await review(author, 'hanami', { body: 'Contains something others find offensive.' });
  const id = body.review.id;
  const reporters = [await t.userClient(), await t.userClient(), await t.userClient()];
  assert.equal((await author.post('/api/reports', { targetType: 'review', targetId: id, reason: 'spam' })).body.error.code, 'OWN_CONTENT');
  const r1 = await reporters[0].post('/api/reports', { targetType: 'review', targetId: id, reason: 'harassment', details: 'Targets another member.' });
  assert.deepEqual(r1.body, { ok: true, autoHidden: false });
  const dup = await reporters[0].post('/api/reports', { targetType: 'review', targetId: id, reason: 'spam' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'ALREADY_REPORTED');
  assert.equal((await reporters[1].post('/api/reports', { targetType: 'review', targetId: id, reason: 'hate' })).body.autoHidden, false);
  assert.equal((await reporters[0].post('/api/reports', { targetType: 'review', targetId: id, reason: 'bogus' })).status, 422);
  assert.equal((await reporters[2].post('/api/reports', { targetType: 'review', targetId: id, reason: 'hate' })).body.autoHidden, true);
  assert.equal(t.db.get('SELECT status FROM reviews WHERE id = ?', id).status, 'hidden');
  assert.ok(t.db.get(`SELECT 1 FROM audit_log WHERE action = 'moderation.auto_hide' AND target_id = ?`, id));
  const pub = await t.client().get('/api/titles/hanami/reviews');
  assert.ok(!pub.body.items.some((x) => x.id === id));
  const mine = await author.get('/api/titles/hanami/reviews');
  assert.equal(mine.body.mine.status, 'hidden');
  assert.equal((await author.patch(`/api/reviews/${id}`, { rating: 1 })).body.error.code, 'REVIEW_LOCKED');
  assert.equal((await reporters[0].post('/api/reports', { targetType: 'review', targetId: 'rev_missing', reason: 'spam' })).status, 404);
});

test('spam is held as pending: the author sees it, nobody else does', async () => {
  const spammer = await t.userClient();
  const res = await review(spammer, 'garden-hours', { body: 'Best deals!!! https://x.example.com https://y.example.com www.z.example.net' });
  assert.equal(res.body.review.status, 'pending');
  const pub = await t.client().get('/api/titles/garden-hours/reviews');
  assert.ok(!pub.body.items.some((x) => x.id === res.body.review.id));
  assert.equal(pub.body.summary.count, 0, 'held ratings are not counted');
  const own = await spammer.get('/api/titles/garden-hours/reviews');
  assert.equal(own.body.mine.status, 'pending');
  assert.match(t.db.get('SELECT moderation_note FROM reviews WHERE id = ?', res.body.review.id).moderation_note, /spam filter/);
  // The automatic hold is on the audit trail, attributed to the filter rather than a person.
  const held = t.db.get(`SELECT * FROM audit_log WHERE action = 'moderation.auto_hold' AND target_id = ?`, res.body.review.id);
  assert.ok(held);
  assert.equal(held.actor_account_id, null);
  assert.equal(held.target_type, 'review');
  assert.deepEqual(JSON.parse(held.details).reasons, ['links']);
  // Editing it into a genuine review releases the automatic hold.
  const fixed = await spammer.patch(`/api/reviews/${res.body.review.id}`, { body: 'Gentle episodes, lovely sound design.' });
  assert.equal(fixed.body.review.status, 'visible');

  // Reusing the same text on another title is held.
  const copier = await t.userClient();
  await review(copier, 'sintel', { body: 'Copy pasted opinion for every title' });
  const second = await review(copier, 'tears-of-steel', { body: 'Copy  pasted OPINION for every title' });
  assert.equal(second.body.review.status, 'pending');

  // A burst of more than five written reviews in ten minutes is held.
  const burst = await t.userClient();
  const ids = ['sintel', 'big-buck-bunny', 'tears-of-steel', 'elephants-dream', 'hanami', 'koyo-autumn-pavilion'];
  const statuses = [];
  for (const [i, id] of ids.entries()) statuses.push((await review(burst, id, { body: `Thought number ${i}: ${'different words '.repeat(i + 1)}` })).body.review.status);
  assert.deepEqual(statuses, ['visible', 'visible', 'visible', 'visible', 'visible', 'pending']);

  // Held replies go to the moderation queue as an automatic report.
  const a = await t.userClient();
  const { body } = await review(a, 'koyo-autumn-pavilion', { body: 'Soft light, patient camera.' });
  const c = await spammer.post(`/api/reviews/${body.review.id}/comments`, { body: 'FREE MONEY click here https://spam.example.com' });
  assert.equal(c.body.comment.status, 'pending');
  assert.ok(t.db.get(`SELECT 1 FROM reports WHERE target_type = 'comment' AND target_id = ? AND reporter_account_id IS NULL`, c.body.comment.id));
  assert.ok(t.db.get(`SELECT 1 FROM audit_log WHERE action = 'moderation.auto_hold' AND target_type = 'comment' AND target_id = ?`, c.body.comment.id));
  assert.equal((await t.client().get(`/api/reviews/${body.review.id}/comments`)).body.items.length, 0);
  assert.equal((await spammer.get(`/api/reviews/${body.review.id}/comments`)).body.items.length, 1);
  assert.equal(t.db.all(`SELECT * FROM notifications WHERE account_id = ? AND type = 'review_reply'`, a.accountId).length, 0, 'held replies do not notify');
});

test('blocking an author hides their reviews and replies from you', async () => {
  const noisy = await t.userClient({ displayName: 'Noisy' });
  const me = await t.userClient();
  const other = await t.userClient();
  const { body } = await review(noisy, 'big-buck-bunny', { body: 'Rude and unhelpful commentary here.' });
  const { body: ob } = await review(other, 'big-buck-bunny', { body: 'Warm, funny and beautifully animated.' });
  await noisy.post(`/api/reviews/${ob.review.id}/comments`, { body: 'Nobody asked for your view.' });
  assert.equal((await noisy.post('/api/blocks', { reviewId: body.review.id })).body.error.code, 'OWN_CONTENT');
  const blocked = await me.post('/api/blocks', { reviewId: body.review.id });
  assert.equal(blocked.status, 200);
  assert.equal(blocked.body.block.name, 'Noisy');
  assert.match(blocked.body.block.id, /^blk_/);
  const list = await me.get('/api/titles/big-buck-bunny/reviews');
  assert.ok(!list.body.items.some((x) => x.id === body.review.id));
  assert.ok(list.body.items.some((x) => x.id === ob.review.id));
  assert.equal((await me.get(`/api/reviews/${ob.review.id}/comments`)).body.items.length, 0);
  assert.equal((await other.get(`/api/reviews/${ob.review.id}/comments`)).body.items.length, 1);
  const blocks = await me.get('/api/blocks');
  assert.equal(blocks.body.items.length, 1);
  assert.equal(JSON.stringify(blocks.body).includes(noisy.accountId), false, 'never exposes account ids');
  assert.equal((await other.del(`/api/blocks/${blocked.body.block.id}`)).status, 404);
  assert.equal((await me.del(`/api/blocks/${blocked.body.block.id}`)).status, 204);
  assert.ok((await me.get('/api/titles/big-buck-bunny/reviews')).body.items.some((x) => x.id === body.review.id));
});

test('summary math, sorting and paging over visible reviews', async () => {
  // Use a title nobody else in this file rates with text only through this test's own accounts.
  const ratings = [5, 4, 4, 2];
  const clients = [];
  for (const r of ratings) {
    const c = await t.userClient();
    clients.push(c);
    const res = await c.post('/api/titles/koyo-autumn-pavilion/reviews', { rating: r, body: `Rated ${r}: ${'thoughtful words '.repeat(r)}` });
    assert.equal(res.status, 200);
  }
  const ratingOnly = await t.userClient();
  await ratingOnly.post('/api/titles/koyo-autumn-pavilion/reviews', { rating: 1 });
  const res = await t.client().get('/api/titles/koyo-autumn-pavilion/reviews?sort=lowest&pageSize=2');
  const all = t.db.all(`SELECT rating FROM reviews WHERE title_id = 'koyo-autumn-pavilion' AND status = 'visible'`).map((r) => r.rating);
  const expectedAvg = Math.round((all.reduce((a, b) => a + b, 0) / all.length) * 10) / 10;
  assert.equal(res.body.summary.count, all.length);
  assert.equal(res.body.summary.average, expectedAvg);
  assert.equal(res.body.summary.distribution['1'], all.filter((x) => x === 1).length);
  assert.equal(res.body.summary.distribution['4'], all.filter((x) => x === 4).length);
  assert.equal(res.body.items.length, 2);
  assert.ok(res.body.items[0].rating <= res.body.items[1].rating);
  assert.ok(res.body.items.every((x) => x.body), 'rating-only entries are summarised, not listed');
  const highest = await t.client().get('/api/titles/koyo-autumn-pavilion/reviews?sort=highest');
  assert.equal(highest.body.items[0].rating, 5);
  // The catalog's member rating uses the same visible reviews.
  const title = await t.client().get('/api/titles/koyo-autumn-pavilion');
  assert.deepEqual(title.body.memberRating, { average: expectedAvg, count: all.length });
});

test('public listing is safe for anonymous visitors', async () => {
  const anon = t.client();
  const res = await anon.get('/api/titles/sintel/reviews');
  assert.equal(res.status, 200);
  assert.equal(res.body.mine, null);
  assert.ok(Array.isArray(res.body.items));
  assert.ok(res.body.items.every((x) => x.status === 'visible' && x.votedHelpful === false && x.isMine === false));
  for (const item of res.body.items) {
    assert.deepEqual(Object.keys(item.author).sort(), ['avatar', 'name']);
    assert.equal('account_id' in item || 'accountId' in item || 'profileId' in item, false);
  }
  assert.equal((await anon.get('/api/titles/not-a-title/reviews')).status, 404);
  assert.equal((await anon.get('/api/blocks')).status, 401);
});

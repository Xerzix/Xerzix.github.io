import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';
import { notify } from '../../server/services/notifications.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();
let seq = 0;
function announcement({ audience = 'all', starts = iso(-60_000), ends = null, title = `Announcement ${++seq}` } = {}) {
  const id = `ann_test${seq}${Math.random().toString(36).slice(2, 8)}`;
  t.db.run('INSERT INTO announcements (id, title, body, link, audience, starts_at, ends_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, title, 'Body text', '#/new', audience, starts, ends, iso());
  return id;
}

test('requires a signed-in account', async () => {
  const anon = t.client();
  assert.equal((await anon.get('/api/notifications')).status, 401);
  assert.equal((await anon.get('/api/notifications/unread-count')).status, 401);
  assert.equal((await anon.post('/api/notifications/read-all')).status, 401);
});

test('lists account notifications merged with active announcements, newest first', async () => {
  const user = await t.userClient({});
  notify(t.db, { accountId: user.accountId, type: 'submission_update', title: 'Older', link: '#/creators' });
  await new Promise((r) => setTimeout(r, 5));
  notify(t.db, { accountId: user.accountId, type: 'account_security', title: 'Newer' });
  const all = announcement({ title: 'For everyone' });
  announcement({ audience: 'creators', title: 'Creators only' });
  announcement({ starts: iso(3_600_000), title: 'Scheduled' });
  announcement({ starts: iso(-7_200_000), ends: iso(-3_600_000), title: 'Ended' });

  const r = await user.get('/api/notifications');
  assert.equal(r.status, 200);
  const titles = r.body.items.map((n) => n.title);
  assert.deepEqual(titles.filter((x) => ['Older', 'Newer', 'For everyone'].includes(x)).sort(), ['For everyone', 'Newer', 'Older']);
  assert.ok(!titles.includes('Creators only'), 'creator announcements are not shown to members');
  assert.ok(!titles.includes('Scheduled') && !titles.includes('Ended'), 'only active announcements are listed');
  assert.ok(titles.indexOf('Newer') < titles.indexOf('Older'));
  assert.equal(r.body.unread, 3);
  const ann = r.body.items.find((n) => n.id === all);
  assert.equal(ann.type, 'announcement');
  assert.equal(ann.readAt, null);

  const creator = await t.userClient({ isCreator: true });
  const c = await creator.get('/api/notifications');
  assert.ok(c.body.items.some((n) => n.title === 'Creators only'));
});

test('read, read-all, unread filter and delete (own notifications and announcements)', async () => {
  const user = await t.userClient({});
  const other = await t.userClient({});
  const a = notify(t.db, { accountId: user.accountId, type: 'account_security', title: 'A' });
  const b = notify(t.db, { accountId: user.accountId, type: 'account_security', title: 'B' });
  const theirs = notify(t.db, { accountId: other.accountId, type: 'account_security', title: 'Private' });
  const ann = announcement({ title: 'Read me' });

  const count0 = (await user.get('/api/notifications/unread-count')).body.unread;
  const read = await user.post(`/api/notifications/${a}/read`);
  assert.equal(read.status, 200);
  assert.equal(read.body.unread, count0 - 1);
  assert.equal((await user.post(`/api/notifications/${theirs}/read`)).status, 404, 'cannot touch another account');
  assert.equal((await user.del(`/api/notifications/${theirs}`)).status, 404);

  assert.equal((await user.post(`/api/notifications/${ann}/read`)).status, 200);
  assert.ok(t.db.get('SELECT read_at FROM announcement_reads WHERE account_id = ? AND announcement_id = ?', user.accountId, ann).read_at);

  const unreadOnly = await user.get('/api/notifications?unread=1');
  assert.ok(unreadOnly.body.items.every((n) => !n.readAt));
  assert.ok(unreadOnly.body.items.some((n) => n.id === b));

  const all = await user.post('/api/notifications/read-all');
  assert.equal(all.body.unread, 0);
  assert.equal((await user.get('/api/notifications/unread-count')).body.unread, 0);
  assert.equal(t.db.get('SELECT read_at FROM notifications WHERE id = ?', theirs).read_at, null);

  assert.equal((await user.del(`/api/notifications/${b}`)).status, 200);
  assert.equal(t.db.get('SELECT 1 AS x FROM notifications WHERE id = ?', b), undefined);
  assert.equal((await user.del(`/api/notifications/${ann}`)).status, 200);
  assert.ok(t.db.get('SELECT dismissed_at FROM announcement_reads WHERE account_id = ? AND announcement_id = ?', user.accountId, ann).dismissed_at);
  const after = await user.get('/api/notifications');
  assert.ok(!after.body.items.some((n) => n.id === ann), 'dismissed announcements disappear');
  // Still visible to others.
  assert.ok((await other.get('/api/notifications')).body.items.some((n) => n.id === ann));
});

test('preferences cover optional types only and suppress them in notify()', async () => {
  const user = await t.userClient({});
  const prefs = await user.get('/api/notifications/preferences');
  assert.deepEqual(Object.keys(prefs.body).sort(), ['announcements', 'creatorReleases', 'genreReleases', 'newEpisodes', 'reviewReplies']);
  assert.ok(Object.values(prefs.body).every((x) => x === true));

  const bad = await user.put('/api/notifications/preferences', { genreReleases: 'nope' });
  assert.equal(bad.status, 422);
  const put = await user.put('/api/notifications/preferences', { genreReleases: false, announcements: false, submissionUpdates: false });
  assert.equal(put.status, 200);
  assert.equal(put.body.genreReleases, false);
  assert.equal(put.body.submissionUpdates, undefined, 'mandatory types cannot be switched off');
  const settings = JSON.parse(t.db.get('SELECT settings FROM accounts WHERE id = ?', user.accountId).settings);
  assert.equal(settings.notifications.genreReleases, false);
  assert.equal(settings.notifications.submissionUpdates, undefined);

  assert.equal(notify(t.db, { accountId: user.accountId, type: 'genre_release', title: 'Suppressed' }), null);
  assert.ok(notify(t.db, { accountId: user.accountId, type: 'new_episode', title: 'Delivered' }));
  assert.ok(notify(t.db, { accountId: user.accountId, type: 'submission_update', title: 'Mandatory' }));

  announcement({ title: 'Hidden by preference' });
  const list = await user.get('/api/notifications');
  assert.ok(!list.body.items.some((n) => n.type === 'announcement'), 'announcements respect the preference');
  assert.deepEqual(list.body.items.map((n) => n.title).sort(), ['Delivered', 'Mandatory']);

  // Re-enabling keeps other stored settings intact.
  const back = await user.put('/api/notifications/preferences', { genreReleases: true });
  assert.equal(back.body.genreReleases, true);
  assert.equal(back.body.announcements, false);
});

test('announcements created by staff reach members through the list', async () => {
  const admin = await t.userClient({ role: 'admin', elevated: true });
  const member = await t.userClient({});
  const created = await admin.post('/api/admin/announcements', { title: 'Scheduled maintenance', body: 'Sunday 02:00–03:00 UTC.', audience: 'all' });
  assert.equal(created.status, 200);
  const list = await member.get('/api/notifications');
  const item = list.body.items.find((n) => n.id === created.body.announcement.id);
  assert.ok(item);
  assert.equal(item.title, 'Scheduled maintenance');
  assert.ok(list.body.unread >= 1);
});

test('pagination returns stable pages of 20', async () => {
  const user = await t.userClient({});
  for (let i = 0; i < 25; i++) notify(t.db, { accountId: user.accountId, type: 'account_security', title: `N${i}`, dedupeKey: `n${i}` });
  const p1 = await user.get('/api/notifications?page=1');
  const p2 = await user.get('/api/notifications?page=2');
  assert.equal(p1.body.items.length, 20);
  assert.ok(p2.body.items.length >= 5);
  const ids = new Set([...p1.body.items, ...p2.body.items].map((n) => n.id));
  assert.equal(ids.size, p1.body.items.length + p2.body.items.length, 'no duplicates across pages');
  assert.ok(p1.body.total >= 25);
});

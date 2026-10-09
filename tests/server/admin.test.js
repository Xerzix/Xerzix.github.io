import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startTestServer } from '../helpers/server.js';

let t;
let admin;
let moderator;
before(async () => {
  t = await startTestServer();
  admin = await t.userClient({ role: 'admin', elevated: true, displayName: 'Ada Admin' });
  moderator = await t.userClient({ role: 'moderator', elevated: true, displayName: 'Mo Moderator' });
});
after(async () => { await t.close(); });

const ts = () => new Date().toISOString();
const rid = (p) => `${p}_${Math.random().toString(36).slice(2, 12)}`;
const auditRows = (action, targetId) => t.db.all('SELECT * FROM audit_log WHERE action = ? AND (? IS NULL OR target_id = ?)', action, targetId ?? null, targetId ?? null);
const notificationsFor = (accountId, type) => t.db.all('SELECT * FROM notifications WHERE account_id = ? AND (? IS NULL OR type = ?)', accountId, type ?? null, type ?? null);

function follow(profileId, type, id) {
  t.db.run('INSERT OR IGNORE INTO follows (profile_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)', profileId, type, id, ts());
}

function writeStorage(key, content) {
  const full = join(t.dir, 'storage', key);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, content);
}

// ───────────────────────────── Access ─────────────────────────────

test('access matrix: anonymous, member, unelevated staff, moderator and admin', async () => {
  const anon = t.client();
  assert.equal((await anon.get('/api/admin/overview')).status, 401);

  const member = await t.userClient({ elevated: true });
  const m = await member.get('/api/admin/overview');
  assert.equal(m.status, 403);
  assert.equal(m.body.error.code, 'FORBIDDEN');
  assert.equal((await member.post('/api/admin/titles', { type: 'movie', title: 'Nope' })).status, 403);

  for (const role of ['moderator', 'admin']) {
    const c = await t.userClient({ role, elevated: false });
    const r = await c.get('/api/admin/overview');
    assert.equal(r.status, 403, role);
    assert.equal(r.body.error.code, 'REAUTH_REQUIRED', role);
  }

  const ok = await moderator.get('/api/admin/overview');
  assert.equal(ok.status, 200);
  assert.equal(typeof ok.body.titles.published, 'number');
  assert.equal(typeof ok.body.queues.openReports, 'number');

  const me = await moderator.get('/api/admin/me');
  assert.equal(me.body.account.role, 'moderator');
  assert.equal(me.body.permissions.admin, false);
  assert.ok(me.body.elevatedUntil > ts());
  assert.equal(me.body.account.password_hash, undefined);

  // Admin-only endpoints refuse moderators.
  assert.equal((await moderator.get('/api/admin/settings')).status, 403);
  assert.equal((await moderator.put('/api/admin/settings', { registrationOpen: false })).status, 403);
  assert.equal((await moderator.get('/api/admin/audit')).status, 403);
  assert.equal((await moderator.get('/api/admin/logs')).status, 403);
  assert.equal((await moderator.put('/api/admin/taxonomy', { genres: ['Drama'], collections: [] })).status, 403);
  assert.equal((await moderator.del('/api/admin/titles/sintel')).status, 403);
  assert.equal((await moderator.del('/api/admin/media/med_sintel')).status, 403);

  for (const p of ['/api/admin/settings', '/api/admin/audit', '/api/admin/logs', '/api/admin/health', '/api/admin/usage']) {
    assert.equal((await admin.get(p)).status, 200, p);
  }
});

test('mutations still require the CSRF header on admin routes', async () => {
  const res = await fetch(`${t.base}/api/admin/titles`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: `lumina_sid=${admin.jar.get('lumina_sid')}` }, body: '{}' });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.code, 'CSRF_REJECTED');
});

// ───────────────────────────── Content ─────────────────────────────

test('title validation, publish requirements, publish notifications and audit', async () => {
  const bad = await admin.post('/api/admin/titles', { type: 'movie', title: '', poster: 'javascript:alert(1)', palette: ['red'] });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.fields.title);
  assert.ok(bad.body.error.fields.poster);
  assert.ok(bad.body.error.fields['palette[0]']);

  const created = await moderator.post('/api/admin/titles', { type: 'movie', title: 'Moon Garden', ageRating: 'PG-13', genres: 'Drama, Fantasy' });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const id = created.body.title.id;
  assert.equal(id, 'moon-garden');
  assert.equal(created.body.title.status, 'draft');
  assert.equal(created.body.title.minAge, 13, 'min age is computed from the rating');
  assert.deepEqual(created.body.title.genres, ['Drama', 'Fantasy']);
  assert.equal(auditRows('content.title_create', id).length, 1);

  // Drafts are not in the public catalog.
  assert.equal((await t.client().get(`/api/titles/${id}`)).status, 404);

  const blocked = await moderator.post(`/api/admin/titles/${id}/publish`);
  assert.equal(blocked.status, 422);
  assert.equal(blocked.body.error.code, 'PUBLISH_REQUIREMENTS');
  assert.deepEqual(blocked.body.error.missing.map((m) => m.field).sort(), ['license', 'media', 'poster', 'synopsis']);

  const patched = await moderator.patch(`/api/admin/titles/${id}`, {
    synopsis: 'A quiet film about a moonlit garden.',
    poster: 'assets/art/sintel-poster.svg',
    license: { name: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/', attribution: '© Example Studio' },
    credits: { directors: ['A. Director'], cast: [{ name: 'Lead Actor', role: 'Gardener' }], crew: [] },
  });
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.body.publish.missing.map((m) => m.field), ['media']);
  assert.ok(auditRows('content.title_update', id)[0].details.includes('synopsis'));

  const badMedia = await moderator.post('/api/admin/media', { titleId: id, kind: 'hls', source: 'https://evil.example/x.m3u8' });
  assert.equal(badMedia.status, 422);
  assert.match(badMedia.body.error.fields.source, /MEDIA_ORIGINS/);
  const traversal = await moderator.post('/api/admin/media', { titleId: id, kind: 'hls', source: 'media/../server/config.js' });
  assert.equal(traversal.status, 422);

  const media = await moderator.post('/api/admin/media', {
    titleId: id, kind: 'hls', source: 'storage:media/moon/master.m3u8',
    audioTracks: [{ lang: 'en', label: 'English', default: true }],
  });
  assert.equal(media.status, 200, JSON.stringify(media.body));
  assert.equal(media.body.media.verified, false);
  const dup = await moderator.post('/api/admin/media', { titleId: id, kind: 'hls', source: 'storage:media/moon/other.m3u8' });
  assert.equal(dup.status, 409, 'a film has one main media entry');

  // Followers: an adult following Drama is notified; a kids profile (max age 7) is not.
  const fan = await t.userClient({});
  const kid = await t.userClient({ maxAge: 7 });
  follow(fan.profileId, 'genre', 'Drama');
  follow(kid.profileId, 'genre', 'Drama');

  const published = await moderator.post(`/api/admin/titles/${id}/publish`);
  assert.equal(published.status, 200, JSON.stringify(published.body));
  assert.equal(published.body.title.status, 'published');
  assert.equal(published.body.notified.genreRelease, 1);
  assert.equal(auditRows('content.title_publish', id).length, 1);
  const fanNote = notificationsFor(fan.accountId, 'genre_release');
  assert.equal(fanNote.length, 1);
  assert.equal(fanNote[0].link, `#/title/${id}`);
  assert.equal(notificationsFor(kid.accountId, 'genre_release').length, 0);

  // The catalog was invalidated: the title is public immediately.
  const pub = await t.client().get(`/api/titles/${id}`);
  assert.equal(pub.status, 200);
  assert.equal(pub.body.title, 'Moon Garden');

  // Republishing does not notify twice (dedupe).
  await moderator.post(`/api/admin/titles/${id}/unpublish`);
  assert.equal((await t.client().get(`/api/titles/${id}`)).status, 404);
  await moderator.post(`/api/admin/titles/${id}/publish`);
  assert.equal(notificationsFor(fan.accountId, 'genre_release').length, 1);

  // Deleting: admin only, and never while published.
  assert.equal((await moderator.del(`/api/admin/titles/${id}`)).status, 403);
  const whilePublished = await admin.del(`/api/admin/titles/${id}`);
  assert.equal(whilePublished.status, 409);
  await admin.post(`/api/admin/titles/${id}/unpublish`);
  assert.equal((await admin.del(`/api/admin/titles/${id}`)).status, 200);
  assert.equal((await admin.get(`/api/admin/titles/${id}`)).status, 404);
  assert.equal(auditRows('content.title_delete', id).length, 1);
});

test('series: seasons, episodes and new-episode notifications for followers', async () => {
  const s = await admin.post('/api/admin/titles', {
    type: 'series', title: 'Lantern Nights', synopsis: 'Stories told by lantern light.', poster: 'assets/art/x.svg', ageRating: 'TV-PG',
    license: { name: 'Licensed', attribution: 'Lantern Studio' }, genres: ['Mystery'],
  });
  const id = s.body.title.id;
  assert.equal((await admin.post(`/api/admin/titles/${id}/seasons`, { number: 1, name: 'Season One' })).status, 200);
  const ep1 = await admin.post(`/api/admin/titles/${id}/episodes`, { seasonNumber: 1, number: 1, name: 'The First Light' });
  assert.equal(ep1.status, 200);
  const e1 = ep1.body.episode.id;
  assert.equal(e1, `${id}-s1e1`);
  const dupEp = await admin.post(`/api/admin/titles/${id}/episodes`, { seasonNumber: 1, number: 1, name: 'Again' });
  assert.equal(dupEp.status, 422);

  const noEpisode = await admin.post('/api/admin/media', { titleId: id, kind: 'hls', source: 'storage:media/l1/master.m3u8' });
  assert.equal(noEpisode.status, 422);
  assert.ok(noEpisode.body.error.fields.episodeId);
  assert.equal((await admin.post('/api/admin/media', { titleId: id, episodeId: e1, kind: 'hls', source: 'storage:media/l1/master.m3u8' })).status, 200);
  assert.equal((await admin.post(`/api/admin/titles/${id}/publish`)).status, 200);

  const follower = await t.userClient({});
  follow(follower.profileId, 'series', id);
  const ep2 = await admin.post(`/api/admin/titles/${id}/episodes`, { seasonNumber: 1, number: 2, name: 'Paper Moons' });
  const created = await admin.post('/api/admin/media', { titleId: id, episodeId: ep2.body.episode.id, kind: 'hls', source: 'storage:media/l2/master.m3u8' });
  assert.equal(created.body.notified, 1);
  const n = notificationsFor(follower.accountId, 'new_episode');
  assert.equal(n.length, 1);
  assert.match(n[0].body, /S1 · E2/);

  const detail = await t.client().get(`/api/titles/${id}`);
  assert.equal(detail.body.seasons[0].episodes.length, 2);
  assert.equal((await moderator.del(`/api/admin/episodes/${e1}`)).status, 403, 'moderators cannot delete content');
});

test('verification reads a manifest from private storage and records real renditions', async () => {
  const title = await admin.post('/api/admin/titles', { type: 'movie', title: 'Verified Film' });
  const id = title.body.title.id;
  writeStorage('media/vf/master.m3u8', '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="a",LANGUAGE="fr",NAME="Français",DEFAULT=YES,URI="a/fr.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="a"\n1080/p.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.4d401e,mp4a.40.2",AUDIO="a"\n360/p.m3u8\n');
  writeStorage('media/vf/1080/p.m3u8', '#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4,\na.ts\n#EXTINF:2.5,\nb.ts\n#EXT-X-ENDLIST\n');
  const m = await admin.post('/api/admin/media', { titleId: id, kind: 'hls', source: 'storage:media/vf/master.m3u8', audioTracks: [{ lang: 'en', label: 'English' }] });
  const mediaId = m.body.media.id;
  const r = await moderator.post(`/api/admin/media/${mediaId}/verify`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true, r.body.message);
  assert.deepEqual(r.body.media.resolutions, [1080, 360]);
  assert.deepEqual(r.body.media.audioTracks, [{ lang: 'fr', label: 'Français', kind: 'main', default: true }], 'declared tracks replace guesses');
  assert.deepEqual(r.body.media.videoCodecs, ['H.264']);
  assert.equal(r.body.media.durationS, 6.5);
  assert.ok(r.body.media.verifiedAt);
  assert.equal(auditRows('media.verify', mediaId).length, 1);

  // Changing the source clears what was verified.
  const moved = await admin.patch(`/api/admin/media/${mediaId}`, { source: 'storage:media/vf/other.m3u8' });
  assert.equal(moved.body.verificationReset, true);
  assert.equal(moved.body.media.verified, false);
  assert.deepEqual(moved.body.media.resolutions, []);
  const failed = await admin.post(`/api/admin/media/${mediaId}/verify`);
  assert.equal(failed.body.ok, false);
  assert.equal(failed.body.media.verified, false, 'nothing is marked verified that could not be read');
  assert.equal(failed.body.report.code, 'NOT_FOUND');

  const refused = await admin.post(`/api/admin/media/${mediaId}/transcode`, { sourceKey: 'uploads/source.mov' });
  assert.equal(refused.status, 422, 'upload staging files are not media sources');
  const transcode = await admin.post(`/api/admin/media/${mediaId}/transcode`, { sourceKey: 'media/vf/source.mov' });
  assert.equal(transcode.status, 503);
  assert.equal(transcode.body.error.code, 'TRANSCODER_NOT_CONFIGURED');
});

test('TMDB endpoints report when no token is configured', async () => {
  const r = await admin.get('/api/admin/tmdb/search?q=sintel');
  assert.equal(r.status, 503);
  assert.equal(r.body.error.code, 'TMDB_NOT_CONFIGURED');
  assert.equal((await admin.get('/api/admin/tmdb/movie/45745')).status, 503);
});

// ───────────────────────────── Users ─────────────────────────────

test('role changes: admin only, never your own, never the last active admin', async () => {
  const member = await t.userClient({});
  const byMod = await moderator.patch(`/api/admin/users/${member.accountId}`, { role: 'moderator' });
  assert.equal(byMod.status, 403);
  assert.equal(byMod.body.error.code, 'ADMIN_REQUIRED');

  const self = await admin.patch(`/api/admin/users/${admin.accountId}`, { role: 'member' });
  assert.equal(self.status, 403);
  assert.equal(self.body.error.code, 'SELF_ACTION');
  const selfSuspend = await admin.patch(`/api/admin/users/${admin.accountId}`, { status: 'suspended' });
  assert.equal(selfSuspend.body.error.code, 'SELF_ACTION');

  const promoted = await admin.patch(`/api/admin/users/${member.accountId}`, { role: 'moderator' });
  assert.equal(promoted.status, 200);
  assert.equal(promoted.body.account.role, 'moderator');
  assert.equal(notificationsFor(member.accountId, 'account_security').length, 1);
  const a = auditRows('users.update', member.accountId);
  assert.equal(a.length, 1);
  assert.match(a[0].details, /"to":"moderator"/);

  // The last *active* admin cannot be demoted, even by another (lapsed-suspension) admin.
  const other = await t.userClient({ role: 'admin', elevated: true });
  const lapsed = await t.userClient({ role: 'admin', elevated: true });
  const past = new Date(Date.now() - 60_000).toISOString();
  const restore = t.db.all(`SELECT id FROM accounts WHERE role = 'admin' AND status = 'active' AND id != ?`, other.accountId);
  for (const r of restore) t.db.run(`UPDATE accounts SET status = 'suspended', suspended_until = ? WHERE id = ?`, past, r.id);
  const last = await lapsed.patch(`/api/admin/users/${other.accountId}`, { role: 'member' });
  assert.equal(last.status, 409);
  assert.equal(last.body.error.code, 'LAST_ADMIN');
  const lastSuspend = await lapsed.patch(`/api/admin/users/${other.accountId}`, { status: 'suspended' });
  assert.equal(lastSuspend.body.error.code, 'LAST_ADMIN');
  for (const r of restore) t.db.run(`UPDATE accounts SET status = 'active', suspended_until = NULL WHERE id = ?`, r.id);
  assert.equal((await lapsed.patch(`/api/admin/users/${other.accountId}`, { role: 'member' })).status, 200);

  const tooFew = await admin.patch(`/api/admin/users/${member.accountId}`, { maxProfiles: 0 });
  assert.equal(tooFew.status, 422);
});

test('suspension revokes sessions; moderators may suspend members only', async () => {
  const member = await t.userClient({});
  assert.equal((await member.get('/api/notifications')).status, 200);
  const until = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const r = await moderator.patch(`/api/admin/users/${member.accountId}`, { status: 'suspended', suspendedReason: 'Spam', suspendedUntil: until });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.account.status, 'suspended');
  assert.equal(r.body.sessions.length, 0);
  assert.equal((await member.get('/api/notifications')).status, 401, 'the suspended account is signed out');
  assert.equal(auditRows('moderation.account_suspend', member.accountId).length, 1);

  const staffTarget = await t.userClient({ role: 'moderator' });
  const denied = await moderator.patch(`/api/admin/users/${staffTarget.accountId}`, { status: 'suspended' });
  assert.equal(denied.status, 403);
  const moderatorRoleChange = await moderator.patch(`/api/admin/users/${member.accountId}`, { isCreator: true });
  assert.equal(moderatorRoleChange.status, 403);

  const reinstated = await moderator.patch(`/api/admin/users/${member.accountId}`, { status: 'active' });
  assert.equal(reinstated.body.account.status, 'active');
  assert.equal(reinstated.body.account.suspendedReason, null);

  const target = await t.userClient({});
  const revoke = await admin.post(`/api/admin/users/${target.accountId}/revoke-sessions`);
  assert.equal(revoke.body.revoked, 1);
  assert.equal((await target.get('/api/notifications')).status, 401);

  const list = await moderator.get('/api/admin/users?q=example.com&status=active');
  assert.equal(list.status, 200);
  assert.ok(list.body.items.every((u) => u.password_hash === undefined && u.passwordHash === undefined));
});

// ───────────────────────────── Moderation ─────────────────────────────

function insertReview(author, titleId, { rating = 1, body = 'Awful spam spam spam', status = 'visible' } = {}) {
  const id = rid('rev');
  t.db.run(
    `INSERT INTO reviews (id, title_id, account_id, profile_id, rating, body, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, titleId, author.accountId, author.profileId, rating, body, status, ts(), ts(),
  );
  return id;
}

function insertReport(reporter, type, targetId, reason = 'spam') {
  const id = rid('rpt');
  t.db.run('INSERT INTO reports (id, target_type, target_id, reporter_account_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, type, targetId, reporter.accountId, reason, 'Please look', ts());
  return id;
}

test('reports are grouped by target; hiding a review updates it and the rating immediately', async () => {
  const author = await t.userClient({ displayName: 'Loud Author' });
  const r1 = await t.userClient({});
  const r2 = await t.userClient({});
  const reviewId = insertReview(author, 'tears-of-steel', { rating: 1 });
  insertReview(r1, 'tears-of-steel', { rating: 5, body: 'Lovely' });
  // Reviews were inserted directly, so do what the community routes do after a write; then warm the cache.
  t.services.catalog.invalidateRatings();
  const beforeDetail = await t.client().get('/api/titles/tears-of-steel');
  assert.equal(beforeDetail.body.memberRating.count, 2);
  const reportId = insertReport(r1, 'review', reviewId, 'spam');
  insertReport(r2, 'review', reviewId, 'harassment');

  const q = await moderator.get('/api/admin/reports');
  const group = q.body.items.find((g) => g.targetId === reviewId);
  assert.ok(group);
  assert.equal(group.count, 2);
  assert.equal(group.target.body, 'Awful spam spam spam');
  assert.equal(group.target.author.name, 'Loud Author');
  assert.deepEqual(group.reasons.map((r) => r.reason).sort(), ['harassment', 'spam']);

  const res = await moderator.post(`/api/admin/reports/${reportId}/resolve`, { action: 'hide', note: 'Spam' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.resolved, 2, 'every open report about the item is resolved');
  assert.equal(t.db.get('SELECT status FROM reviews WHERE id = ?', reviewId).status, 'hidden');
  assert.equal(t.db.get(`SELECT COUNT(*) AS n FROM reports WHERE target_id = ? AND status = 'actioned'`, reviewId).n, 2);
  const after = await t.client().get('/api/titles/tears-of-steel');
  assert.deepEqual(after.body.memberRating, { average: 5, count: 1 }, 'ratings were invalidated');
  assert.equal(notificationsFor(author.accountId, 'moderation').length, 1);
  assert.equal(auditRows('moderation.report_resolve', reviewId).length, 1);

  // Spam-held reviews can be approved from the reviews list.
  const held = insertReview(r2, 'tears-of-steel', { rating: 4, body: 'Held for review', status: 'pending' });
  const pending = await moderator.get('/api/admin/reviews?status=pending');
  assert.ok(pending.body.items.some((x) => x.id === held));
  const approved = await moderator.patch(`/api/admin/reviews/${held}`, { status: 'visible' });
  assert.equal(approved.status, 200);
  const approvedDetail = await t.client().get('/api/titles/tears-of-steel');
  assert.equal(approvedDetail.body.memberRating.count, 2);

  const history = await moderator.get('/api/admin/moderation/history');
  assert.ok(history.body.items.some((h) => h.action === 'moderation.review_status' && h.targetId === held));
});

test('suspend_author hides the comment, suspends the author and signs them out', async () => {
  const author = await t.userClient({});
  const reporter = await t.userClient({});
  const reviewId = insertReview(reporter, 'hanami', { rating: 4, body: 'Nice' });
  const commentId = rid('cmt');
  t.db.run('INSERT INTO review_comments (id, review_id, account_id, profile_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', commentId, reviewId, author.accountId, author.profileId, 'abusive text', ts(), ts());
  const reportId = insertReport(reporter, 'comment', commentId, 'harassment');
  const r = await moderator.post(`/api/admin/reports/${reportId}/resolve`, { action: 'suspend_author', note: 'Harassment', suspendDays: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(t.db.get('SELECT status FROM review_comments WHERE id = ?', commentId).status, 'hidden');
  const acct = t.db.get('SELECT status, suspended_reason, suspended_until FROM accounts WHERE id = ?', author.accountId);
  assert.equal(acct.status, 'suspended');
  assert.equal(acct.suspended_reason, 'Harassment');
  assert.ok(acct.suspended_until > ts());
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', author.accountId).n, 0);

  // A moderator cannot suspend staff through a report either.
  const staffAuthor = await t.userClient({ role: 'admin' });
  const staffReview = insertReview(staffAuthor, 'hanami', { rating: 3, body: 'Staff review' });
  const staffReport = insertReport(reporter, 'review', staffReview);
  const denied = await moderator.post(`/api/admin/reports/${staffReport}/resolve`, { action: 'suspend_author' });
  assert.equal(denied.status, 403);
  const dismissed = await moderator.post(`/api/admin/reports/${staffReport}/resolve`, { action: 'dismiss', note: 'Fine' });
  assert.equal(dismissed.status, 200);
  assert.equal(t.db.get('SELECT status FROM reports WHERE id = ?', staffReport).status, 'dismissed');
  assert.equal(t.db.get('SELECT status FROM reviews WHERE id = ?', staffReview).status, 'visible');
});

// ───────────────────────────── Creators & submissions ─────────────────────────────

test('creator application approval grants creator access and notifies', async () => {
  const applicant = await t.userClient({});
  const id = rid('capp');
  t.db.run(`INSERT INTO creator_applications (id, account_id, legal_name, contact_email, bio, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`, id, applicant.accountId, 'Jo Filmmaker', 'jo@example.com', 'Short films.', ts(), ts());
  const list = await moderator.get('/api/admin/creator-applications');
  assert.ok(list.body.items.some((a) => a.id === id));
  const noNote = await moderator.post(`/api/admin/creator-applications/${id}/decision`, { decision: 'reject' });
  assert.equal(noNote.status, 422);
  const ok = await moderator.post(`/api/admin/creator-applications/${id}/decision`, { decision: 'approve', note: 'Welcome' });
  assert.equal(ok.status, 200);
  assert.equal(t.db.get('SELECT is_creator FROM accounts WHERE id = ?', applicant.accountId).is_creator, 1);
  assert.equal(notificationsFor(applicant.accountId, 'creator_application').length, 1);
  assert.equal(auditRows('creators.application_decision', id).length, 1);

  // A decision is final: rejecting the approved application would leave creator access in place.
  const again = await moderator.post(`/api/admin/creator-applications/${id}/decision`, { decision: 'reject', note: 'Changed our mind' });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'INVALID_TRANSITION');
  assert.equal(t.db.get('SELECT status FROM creator_applications WHERE id = ?', id).status, 'approved');
  assert.equal(notificationsFor(applicant.accountId, 'creator_application').length, 1);
});

async function makeSubmission({ status = 'submitted', probe = {}, mime = 'video/mp4' } = {}) {
  const creator = await t.userClient({ isCreator: true, displayName: 'Creator Cat' });
  const id = rid('sub');
  t.db.run(
    `INSERT INTO submissions (id, account_id, project_title, description, content_type, runtime_min, genres, language, release_year, country, rights, attested_at, attestation_ip, status, created_at, updated_at, submitted_at)
     VALUES (?, ?, ?, ?, 'short', 12, '["Drama"]', 'en', 2025, 'jp', ?, ?, '127.0.0.1', ?, ?, ?, ?)`,
    id, creator.accountId, `Paper Cranes ${id.slice(-4)}`, 'A short about folding cranes.',
    JSON.stringify({ copyrightOwner: 'Creator Cat', distributionRights: true, territories: ['Worldwide'], musicCleared: true, footageCleared: true }), ts(), status, ts(), ts(), ts(),
  );
  const fileId = rid('sfl');
  const key = `submissions/${id}/${fileId}.mp4`;
  writeStorage(key, 'FAKE-MP4-BYTES');
  t.db.run(
    `INSERT INTO submission_files (id, submission_id, role, original_name, mime, size_bytes, probe, scan_status, storage_key, created_at)
     VALUES (?, ?, 'feature', 'cranes.mp4', ?, 14, ?, 'not_configured', ?, ?)`,
    fileId, id, mime, JSON.stringify(probe), key, ts(),
  );
  return { creator, id, fileId, key };
}

test('submission transitions, events, creator notifications and internal notes', async () => {
  const { creator, id } = await makeSubmission();
  const skip = await moderator.post(`/api/admin/submissions/${id}/status`, { status: 'approved' });
  assert.equal(skip.status, 409);
  assert.equal(skip.body.error.code, 'INVALID_TRANSITION');

  const review = await moderator.post(`/api/admin/submissions/${id}/status`, { status: 'under_review' });
  assert.equal(review.status, 200);
  assert.equal(review.body.submission.status, 'under_review');
  assert.deepEqual(review.body.allowedTransitions.sort(), ['approved', 'info_required', 'rejected']);

  const noMessage = await moderator.post(`/api/admin/submissions/${id}/status`, { status: 'info_required' });
  assert.equal(noMessage.status, 422);
  const info = await moderator.post(`/api/admin/submissions/${id}/status`, { status: 'info_required', message: 'Please upload the music licence.', internalNote: 'Check the soundtrack credits' });
  assert.equal(info.status, 200);
  const events = info.body.events;
  assert.equal(events.find((e) => e.kind === 'info_request').visibleToCreator, true);
  assert.equal(events.find((e) => e.kind === 'comment').visibleToCreator, false, 'internal notes are hidden from the creator');
  assert.ok(notificationsFor(creator.accountId, 'submission_update').some((n) => /more information/.test(n.title)));

  const early = await moderator.post(`/api/admin/submissions/${id}/status`, { status: 'under_review' });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'AWAITING_CREATOR');
  t.db.run(`INSERT INTO submission_events (submission_id, actor_account_id, kind, message, created_at) VALUES (?, ?, 'info_response', 'Uploaded it', ?)`, id, creator.accountId, ts());
  assert.equal((await moderator.post(`/api/admin/submissions/${id}/status`, { status: 'under_review' })).status, 200);
  const approved = await moderator.post(`/api/admin/submissions/${id}/status`, { status: 'approved' });
  assert.equal(approved.body.submission.status, 'approved');
  assert.equal(auditRows('submissions.status', id).length, 4);

  const comment = await moderator.post(`/api/admin/submissions/${id}/comments`, { message: 'Internal only' });
  assert.equal(comment.body.events.at(-1).visibleToCreator, false);
});

test('submission files are served through short-lived signed URLs', async () => {
  const { id, fileId } = await makeSubmission();
  const r = await moderator.get(`/api/admin/submissions/${id}/files/${fileId}/url`);
  assert.equal(r.status, 200);
  assert.match(r.body.url, /^\/media\/private\/submissions\/.+\?exp=\d+&sig=/);
  const file = await fetch(t.base + r.body.url);
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'FAKE-MP4-BYTES');
  const tampered = await fetch(t.base + r.body.url.replace(/sig=[^&]+/, 'sig=forged'));
  assert.equal(tampered.status, 403);
  assert.equal(auditRows('submissions.file_access', fileId).length, 1);
  const wrong = await moderator.get(`/api/admin/submissions/${id}/files/sfl_nope/url`);
  assert.equal(wrong.status, 404);
});

test('publishing a submission creates a draft title; publishing the title completes the submission', async () => {
  const probe = { format: { format_name: 'mov,mp4,m4a', duration: '720' }, streams: [{ codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080 }, { codec_type: 'audio', codec_name: 'aac' }] };
  const { creator, id, key } = await makeSubmission({ status: 'approved', probe });
  assert.equal((await moderator.post(`/api/admin/submissions/${id}/publish`)).status, 403, 'admin only');
  const r = await admin.post(`/api/admin/submissions/${id}/publish`);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const titleId = r.body.titleId;
  assert.equal(r.body.media.length, 1);
  assert.equal(r.body.media[0].kind, 'progressive');
  assert.equal(r.body.media[0].status, 'ready');
  const row = t.db.get('SELECT * FROM titles WHERE id = ?', titleId);
  assert.equal(row.status, 'draft', 'nothing is published automatically');
  assert.equal(row.creator_account_id, creator.accountId);
  assert.equal(row.submission_id, id);
  const media = t.db.get('SELECT * FROM media WHERE title_id = ?', titleId);
  // Served from its own media/ folder, never from the submission folder (which also holds the
  // creator's documents): a viewer's directory-scoped signature must not open those.
  assert.equal(media.source, `storage:media/${media.id}/source.mp4`);
  assert.equal(media.resolutions, '[1080]');
  writeStorage(`submissions/${id}/sfl_doc-release-form.pdf`, '%PDF private');
  const { signedUrl } = await import('../../server/services/storage.js');
  const viewerUrl = signedUrl(media.source.slice(8));
  const played = await fetch(t.base + viewerUrl);
  assert.equal(played.status, 200);
  assert.equal(await played.text(), 'FAKE-MP4-BYTES');
  const sig = viewerUrl.slice(viewerUrl.indexOf('?'));
  assert.equal((await fetch(`${t.base}/media/private/submissions/${id}/sfl_doc-release-form.pdf${sig}`)).status, 403);
  assert.equal((await fetch(`${t.base}/media/private/${key}${sig}`)).status, 403);
  assert.equal((await admin.post(`/api/admin/submissions/${id}/publish`)).status, 409, 'only once');

  // Staff complete artwork and licence, then publish: the submission becomes "published".
  const follower = await t.userClient({});
  follow(follower.profileId, 'creator', creator.accountId);
  await admin.patch(`/api/admin/titles/${titleId}`, { poster: 'assets/art/x.svg', license: { name: 'Non-exclusive streaming licence', attribution: '© Creator Cat' }, ageRating: 'PG' });
  const pub = await admin.post(`/api/admin/titles/${titleId}/publish`);
  assert.equal(pub.status, 200, JSON.stringify(pub.body));
  assert.equal(t.db.get('SELECT status FROM submissions WHERE id = ?', id).status, 'published');
  assert.ok(notificationsFor(creator.accountId, 'submission_update').some((n) => /is live/.test(n.title)));
  assert.equal(notificationsFor(follower.accountId, 'creator_release').length, 1);
  const detail = await admin.get(`/api/admin/submissions/${id}`);
  assert.ok(detail.body.events.some((e) => e.toStatus === 'published' && e.visibleToCreator));
});

test('non-playable uploads without a transcoder are flagged, not published', async () => {
  const { id } = await makeSubmission({ status: 'approved', probe: { container: 'matroska', videoCodec: 'hevc', audioCodec: 'opus' }, mime: 'video/x-matroska' });
  const r = await admin.post(`/api/admin/submissions/${id}/publish`);
  assert.equal(r.status, 200);
  assert.equal(r.body.media[0].status, 'failed');
  assert.ok(r.body.warnings.some((w) => /transcod/i.test(w)));
});

test('media storage sources: only media/ or an approved submission linked to the title', async () => {
  const { id: subId, key } = await makeSubmission({ status: 'under_review' });
  const docKey = `submissions/${subId}/sfl_doc-contract.pdf`;
  writeStorage(docKey, '%PDF');
  t.db.run(`INSERT INTO submission_files (id, submission_id, role, original_name, mime, size_bytes, probe, scan_status, storage_key, created_at)
            VALUES (?, ?, 'document', 'contract.pdf', 'application/pdf', 4, '{}', 'not_configured', ?, ?)`, rid('sfl'), subId, docKey, ts());
  const draft = await admin.post('/api/admin/titles', { type: 'movie', title: 'Storage Rules' });
  const titleId = draft.body.title.id;
  const attempt = (source, role = 'trailer') => moderator.post('/api/admin/media', { titleId, role, kind: 'progressive', source });

  const unapproved = await attempt(`storage:${key}`);
  assert.equal(unapproved.status, 422);
  assert.match(unapproved.body.error.fields.source, /not been approved/);
  assert.equal((await attempt('storage:uploads/upl_x.part')).status, 422);
  assert.equal((await attempt('storage:public/art/x.png')).status, 422);

  // Approved, but linked to another title (or not yet linked): still refused.
  t.db.run(`UPDATE submissions SET status = 'approved' WHERE id = ?`, subId);
  assert.match((await attempt(`storage:${key}`)).body.error.fields.source, /another title/);
  t.db.run('UPDATE submissions SET title_id = ? WHERE id = ?', titleId, subId);
  assert.equal((await attempt(`storage:${docKey}`)).status, 422, 'documents are never media');
  assert.equal((await attempt(`storage:${key}`)).status, 200);
  assert.equal((await attempt('storage:media/storage-rules/master.m3u8', 'main')).status, 200);
  // Same rule on edits and on fallbacks.
  const m = t.db.get(`SELECT id FROM media WHERE title_id = ? AND role = 'main'`, titleId);
  t.db.run(`UPDATE submissions SET status = 'under_review' WHERE id = ?`, subId);
  assert.equal((await moderator.patch(`/api/admin/media/${m.id}`, { source: `storage:${key}` })).status, 422);
  assert.equal((await moderator.patch(`/api/admin/media/${m.id}`, { fallbacks: [{ src: `storage:${docKey}`, type: 'video/mp4' }] })).status, 422);
});

test('destructive edits cannot leave a published title with nothing playable', async () => {
  const s = await admin.post('/api/admin/titles', {
    type: 'series', title: 'Single Episode Show', synopsis: 'One episode.', poster: 'assets/art/x.svg',
    license: { name: 'Licensed', attribution: 'Studio' },
  });
  const id = s.body.title.id;
  const ep = await admin.post(`/api/admin/titles/${id}/episodes`, { seasonNumber: 1, number: 1, name: 'Only' });
  const media = await admin.post('/api/admin/media', { titleId: id, episodeId: ep.body.episode.id, kind: 'hls', source: 'storage:media/one/master.m3u8' });
  assert.equal((await admin.post(`/api/admin/titles/${id}/publish`)).status, 200);
  const season = t.db.get('SELECT id FROM seasons WHERE title_id = ?', id);

  for (const r of [
    await admin.del(`/api/admin/seasons/${season.id}`),
    await admin.del(`/api/admin/episodes/${ep.body.episode.id}`),
    await admin.del(`/api/admin/media/${media.body.media.id}`),
    await admin.patch(`/api/admin/media/${media.body.media.id}`, { status: 'failed' }),
  ]) {
    assert.equal(r.status, 409);
    assert.equal(r.body.error.code, 'TITLE_WOULD_BE_UNPLAYABLE');
  }
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM episodes WHERE title_id = ?', id).n, 1, 'rolled back');
  assert.equal(t.db.get('SELECT status FROM media WHERE id = ?', media.body.media.id).status, 'ready');

  // Unpublished, the same deletion is fine.
  await admin.post(`/api/admin/titles/${id}/unpublish`);
  assert.equal((await admin.del(`/api/admin/seasons/${season.id}`)).status, 200);
});

test('title ids never collide with dashboard routes; artwork must be loadable under the CSP', async () => {
  const named = await admin.post('/api/admin/titles', { type: 'movie', title: 'New' });
  assert.equal(named.status, 200);
  assert.notEqual(named.body.title.id, 'new');
  const explicit = await admin.post('/api/admin/titles', { type: 'movie', title: 'Another', id: 'new' });
  assert.equal(explicit.status, 422);
  assert.ok(explicit.body.error.fields.id);

  const id = named.body.title.id;
  for (const poster of ['http://example.com/p.jpg', 'https://image.tmdb.org/t/p/w780/abc.jpg', 'ftp://example.com/p.jpg']) {
    const r = await admin.patch(`/api/admin/titles/${id}`, { poster });
    assert.equal(r.status, 422, poster);
    assert.ok(r.body.error.fields.poster, poster);
  }
  assert.equal((await admin.patch(`/api/admin/titles/${id}`, { poster: 'https://test-streams.mux.dev/poster.jpg', backdrop: 'media/art/upl_abc.webp' })).status, 200);
});

test('a lapsed timed suspension reads as active and does not block unrelated edits', async () => {
  const member = await t.userClient({});
  t.db.run(`UPDATE accounts SET status = 'suspended', suspended_reason = 'Spam', suspended_until = ? WHERE id = ?`, new Date(Date.now() - 86_400_000).toISOString(), member.accountId);
  const detail = await admin.get(`/api/admin/users/${member.accountId}`);
  assert.equal(detail.body.account.status, 'active');
  assert.ok(detail.body.account.suspensionEndedAt);
  const suspended = await admin.get('/api/admin/users?status=suspended&pageSize=100');
  assert.ok(!suspended.body.items.some((u) => u.id === member.accountId));
  const r = await admin.patch(`/api/admin/users/${member.accountId}`, { maxProfiles: 3 });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = t.db.get('SELECT status, max_profiles, suspended_until FROM accounts WHERE id = ?', member.accountId);
  assert.deepEqual({ ...row }, { status: 'active', max_profiles: 3, suspended_until: null });
});

test('server logs never show mail bodies, tokens or secrets to staff', async () => {
  const { log } = await import('../../server/lib/log.js');
  log.info('mail (log transport)', { to: 'au***@example.test', subject: 'Reset your Lumina password', text: 'Open http://localhost/#/reset?token=SECRETTOKEN123 to continue' });
  log.warn('callback failed', { url: 'https://example.test/cb?sig=SIGVALUE99&x=1' });
  const found = await admin.get('/api/admin/logs?level=debug&q=SECRETTOKEN123');
  assert.equal(found.body.items.length, 0, 'a search cannot probe a redacted value');
  const mail = (await admin.get('/api/admin/logs?level=debug&q=Reset%20your')).body.items[0];
  assert.equal(mail.text, '[redacted]');
  const cb = (await admin.get('/api/admin/logs?level=debug&q=callback')).body.items[0];
  assert.equal(cb.url, 'https://example.test/cb?sig=[redacted]&x=1');
});

// ───────────────────────────── Platform ─────────────────────────────

test('settings are admin-only, stored and audited; announcements are audited', async () => {
  assert.equal((await moderator.get('/api/admin/settings')).status, 403);
  const { config } = await import('../../server/config.js');
  const { declareSettingConsumer, readPlatformSettings } = await import('../../server/services/admin/settings.js');
  const initial = await admin.get('/api/admin/settings');
  // Settings nobody has saved yet take their defaults (never null).
  assert.equal(initial.body.effective.registrationOpen, config.auth.allowRegistration);
  assert.equal(initial.body.effective.watchPartiesEnabled, config.features.watchParties);
  assert.equal(initial.body.effective.maintenanceMessage, null);
  assert.deepEqual(readPlatformSettings(t.db), initial.body.effective);
  // The dashboard says "enforced" only for settings a feature has declared it reads.
  const before = Object.fromEntries(initial.body.settings.map((x) => [x.key, x.enforced]));
  assert.ok(Object.values(before).every((x) => typeof x === 'boolean'));
  declareSettingConsumer('watchPartiesEnabled');
  const declared = await admin.get('/api/admin/settings');
  assert.equal(declared.body.settings.find((x) => x.key === 'watchPartiesEnabled').enforced, true);
  assert.throws(() => declareSettingConsumer('noSuchSetting'), /Unknown platform setting/);

  const put = await admin.put('/api/admin/settings', { maintenanceMessage: 'Maintenance Sunday 02:00 UTC', registrationOpen: false });
  assert.equal(put.status, 200);
  assert.equal(put.body.effective.registrationOpen, false);
  assert.equal(put.body.effective.maintenanceMessage, 'Maintenance Sunday 02:00 UTC');
  assert.equal(auditRows('platform.settings_update').length, 1);
  assert.deepEqual(Object.keys(JSON.parse(auditRows('platform.settings_update')[0].details).changed).sort(), ['maintenanceMessage', 'registrationOpen'], 'only real changes are audited');
  const bad = await admin.put('/api/admin/settings', { registrationOpen: 'maybe' });
  assert.equal(bad.status, 422);

  const ann = await moderator.post('/api/admin/announcements', { title: 'New originals', body: 'Two new Lumina Originals this week.', link: '#/new', audience: 'all' });
  assert.equal(ann.status, 200);
  const badLink = await moderator.post('/api/admin/announcements', { title: 'Bad', body: 'x', link: 'javascript:alert(1)' });
  assert.equal(badLink.status, 422);
  const list = await moderator.get('/api/admin/announcements');
  assert.equal(list.body.items[0].state, 'active');
  assert.equal((await moderator.del(`/api/admin/announcements/${ann.body.announcement.id}`)).status, 200);
  assert.equal(auditRows('platform.announcement_create').length, 1);
  assert.equal(auditRows('platform.announcement_delete').length, 1);

  const health = await moderator.get('/api/admin/health');
  assert.ok(health.body.database.tables.some((x) => x.name === 'titles' && x.rows > 0));
  assert.ok(health.body.integrations.some((i) => i.id === 'tmdb' && i.status === 'not_configured'));
  const usage = await moderator.get('/api/admin/usage');
  assert.equal(usage.body.label, 'Estimated from player telemetry');
  assert.equal(usage.body.daily.length, 30);

  const audit = await admin.get('/api/admin/audit?action=content.');
  assert.ok(audit.body.items.length > 0);
  assert.ok(audit.body.items.every((a) => a.action.startsWith('content.')));
});

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

const APPLICATION = {
  legalName: 'Mei Tanaka',
  contactEmail: 'mei@example.com',
  company: 'Lantern Pictures',
  website: 'https://lantern.example.com',
  country: 'jp',
  bio: 'Documentary filmmaker working on slow, observational films about gardens and craft.',
};

const RIGHTS = {
  copyrightOwner: 'Lantern Pictures KK',
  distributionRights: 'owner',
  territories: ['ww'],
  restrictions: 'None',
  musicCleared: 'yes',
  footageCleared: 'not_applicable',
  documentationNotes: 'Composer agreement attached.',
};

/** Attaches a completed file row directly (upload protocol is covered in uploads.test.js). */
function attachFile(submissionId, role = 'feature') {
  const id = `sfl_${Math.random().toString(36).slice(2, 12)}`;
  t.db.run(
    `INSERT INTO submission_files (id, submission_id, role, original_name, mime, size_bytes, sha256, probe, scan_status, storage_key, created_at)
     VALUES (?, ?, ?, 'film.mp4', 'video/mp4', 1000, 'abc', '{}', 'not_configured', ?, ?)`,
    id, submissionId, role, `submissions/${submissionId}/${id}-film.mp4`, new Date().toISOString(),
  );
  return id;
}

async function newSubmission(c, extra = {}) {
  const r = await c.post('/api/creators/submissions', {
    projectTitle: 'Moss and Stone',
    description: 'A year in the life of a moss garden in Kyoto, told through its gardeners.',
    contentType: 'documentary',
    runtimeMin: 74,
    genres: ['Documentary', 'Nature'],
    language: 'ja',
    releaseYear: 2025,
    country: 'jp',
    ...extra,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.submission;
}

test('applications: one open application per account, info requests re-open it', async () => {
  const u = await t.userClient();
  assert.deepEqual((await u.get('/api/creators/me')).body, { isCreator: false, application: null });
  assert.equal((await t.client().post('/api/creators/applications', APPLICATION)).status, 401);
  assert.equal((await u.post('/api/creators/applications', { ...APPLICATION, bio: 'short' })).status, 422);
  assert.equal((await u.post('/api/creators/applications', { ...APPLICATION, website: 'javascript:alert(1)' })).status, 422);
  const r = await u.post('/api/creators/applications', APPLICATION);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.application.status, 'pending');
  assert.equal(r.body.application.country, 'JP');
  const dup = await u.post('/api/creators/applications', APPLICATION);
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'APPLICATION_EXISTS');

  // A reviewer (admin API, simulated here) asks for more information.
  t.db.run(`UPDATE creator_applications SET status = 'info_required', reviewer_note = 'Please add a portfolio link.' WHERE id = ?`, r.body.application.id);
  const me = await u.get('/api/creators/me');
  assert.equal(me.body.application.reviewerNote, 'Please add a portfolio link.');
  const again = await u.post('/api/creators/applications', { ...APPLICATION, portfolio: 'https://vimeo.com/lantern' });
  assert.equal(again.status, 200);
  assert.equal(again.body.application.id, r.body.application.id);
  assert.equal(again.body.application.status, 'pending');
  assert.equal(again.body.application.portfolio, 'https://vimeo.com/lantern');
  assert.ok(t.db.get(`SELECT 1 FROM audit_log WHERE action = 'creator.application_submitted' AND actor_account_id = ?`, u.accountId));

  const creator = await t.userClient({ isCreator: true });
  assert.equal((await creator.post('/api/creators/applications', APPLICATION)).body.error.code, 'ALREADY_CREATOR');
});

test('submissions require creator access and stay private to their owner', async () => {
  const member = await t.userClient();
  assert.equal((await member.get('/api/creators/submissions')).status, 403);
  assert.equal((await member.post('/api/creators/submissions', { projectTitle: 'X', contentType: 'movie' })).body.error.code, 'CREATOR_REQUIRED');

  const a = await t.userClient({ isCreator: true });
  const b = await t.userClient({ isCreator: true });
  const sub = await newSubmission(a);
  assert.equal(sub.status, 'draft');
  assert.equal(sub.country, 'JP');
  assert.deepEqual(sub.genres, ['Documentary', 'Nature']);
  assert.equal((await b.get(`/api/creators/submissions/${sub.id}`)).status, 404);
  assert.equal((await b.patch(`/api/creators/submissions/${sub.id}`, { projectTitle: 'Stolen' })).status, 404);
  assert.equal((await b.post(`/api/creators/submissions/${sub.id}/attest`, { rights: RIGHTS, confirm: true })).status, 404);
  assert.equal((await b.post(`/api/creators/submissions/${sub.id}/submit`)).status, 404);
  assert.equal((await b.del(`/api/creators/submissions/${sub.id}`)).status, 404);
  assert.deepEqual((await b.get('/api/creators/submissions')).body.items, []);
  assert.equal((await a.get('/api/creators/submissions')).body.items.length, 1);

  const patched = await a.patch(`/api/creators/submissions/${sub.id}`, { projectTitle: 'Moss & Stone', trailerUrl: '', runtimeMin: 80 });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.submission.projectTitle, 'Moss & Stone');
  assert.equal(patched.body.submission.runtimeMin, 80);
  assert.equal(patched.body.submission.language, 'ja', 'fields not sent are untouched');
  assert.equal((await a.patch(`/api/creators/submissions/${sub.id}`, { contentType: 'podcast' })).status, 422);
});

test('attestation needs confirm === true and both clearances answered', async () => {
  const c = await t.userClient({ isCreator: true });
  const sub = await newSubmission(c);
  const url = `/api/creators/submissions/${sub.id}/attest`;
  const noConfirm = await c.post(url, { rights: RIGHTS, confirm: false });
  assert.equal(noConfirm.status, 422);
  assert.ok(noConfirm.body.error.fields.confirm);
  assert.equal((await c.post(url, { rights: RIGHTS })).status, 422);
  const { musicCleared, ...noMusic } = RIGHTS;
  const missing = await c.post(url, { rights: noMusic, confirm: true });
  assert.equal(missing.status, 422);
  assert.ok(missing.body.error.fields['rights.musicCleared']);
  assert.equal((await c.post(url, { rights: { ...RIGHTS, footageCleared: 'maybe' }, confirm: true })).status, 422);
  assert.equal((await c.post(url, { rights: { ...RIGHTS, territories: [] }, confirm: true })).status, 422);
  const ok = await c.post(url, { rights: RIGHTS, confirm: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.ok(ok.body.submission.attestedAt);
  assert.deepEqual(ok.body.submission.rights.territories, ['WW']);
  const row = t.db.get('SELECT attestation_ip, rights FROM submissions WHERE id = ?', sub.id);
  assert.ok(row.attestation_ip);
  assert.equal('attestationIp' in ok.body.submission, false);
  assert.ok(t.db.get(`SELECT 1 FROM audit_log WHERE action = 'creator.rights_attested' AND target_id = ?`, sub.id));
});

test('submit requires details, attestation and a finished main file; it never publishes', async () => {
  const c = await t.userClient({ isCreator: true });
  const sub = await newSubmission(c, { runtimeMin: null, description: 'Too short' });
  const first = await c.post(`/api/creators/submissions/${sub.id}/submit`);
  assert.equal(first.status, 422);
  assert.deepEqual(Object.keys(first.body.error.fields).sort(), ['description', 'files', 'rights', 'runtimeMin']);
  await c.patch(`/api/creators/submissions/${sub.id}`, { runtimeMin: 74, description: 'A year in the life of a moss garden in Kyoto.' });
  await c.post(`/api/creators/submissions/${sub.id}/attest`, { rights: RIGHTS, confirm: true });
  attachFile(sub.id, 'poster');
  const stillMissing = await c.post(`/api/creators/submissions/${sub.id}/submit`);
  assert.deepEqual(Object.keys(stillMissing.body.error.fields), ['files'], 'a poster is not a main file');
  attachFile(sub.id, 'feature');
  const sent = await c.post(`/api/creators/submissions/${sub.id}/submit`);
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  assert.equal(sent.body.submission.status, 'submitted');
  assert.ok(sent.body.submission.submittedAt);
  assert.equal(sent.body.submission.editable, false);
  assert.equal(sent.body.submission.titleId, null);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM titles WHERE submission_id = ?', sub.id).n, 0, 'nothing is published');
  assert.ok(t.db.get(`SELECT 1 FROM notifications WHERE account_id = ? AND type = 'submission_update'`, c.accountId));

  // Locked after submission.
  assert.equal((await c.patch(`/api/creators/submissions/${sub.id}`, { projectTitle: 'Changed' })).body.error.code, 'SUBMISSION_LOCKED');
  assert.equal((await c.post(`/api/creators/submissions/${sub.id}/submit`)).status, 409);
  assert.equal((await c.del(`/api/creators/submissions/${sub.id}`)).status, 409);
  const detail = await c.get(`/api/creators/submissions/${sub.id}`);
  assert.equal(detail.body.files.length, 2);
  assert.equal('storage_key' in detail.body.files[0] || 'storageKey' in detail.body.files[0], false);
  assert.deepEqual(detail.body.events.map((e) => e.kind), ['status', 'comment', 'status']);
  assert.equal(detail.body.events.at(-1).toStatus, 'submitted');
  assert.equal(detail.body.events.at(-1).by, 'you');
});

test('info requests: hidden staff notes stay hidden, the response returns it to submitted', async () => {
  const c = await t.userClient({ isCreator: true });
  const sub = await newSubmission(c);
  await c.post(`/api/creators/submissions/${sub.id}/attest`, { rights: RIGHTS, confirm: true });
  attachFile(sub.id, 'feature');
  await c.post(`/api/creators/submissions/${sub.id}/submit`);
  assert.equal((await c.post(`/api/creators/submissions/${sub.id}/respond`, { message: 'Hi' })).status, 409, 'nothing was asked yet');

  // The admin API (simulated) requests info and leaves an internal note.
  const ts = new Date().toISOString();
  t.db.run(`UPDATE submissions SET status = 'info_required', status_reason = 'Need the music licence.' WHERE id = ?`, sub.id);
  t.db.run(`INSERT INTO submission_events (submission_id, actor_account_id, kind, from_status, to_status, message, visible_to_creator, created_at) VALUES (?, 'acc_staff', 'info_request', 'submitted', 'info_required', 'Please upload the music licence.', 1, ?)`, sub.id, ts);
  t.db.run(`INSERT INTO submission_events (submission_id, actor_account_id, kind, message, visible_to_creator, created_at) VALUES (?, 'acc_staff', 'comment', 'Internal: check composer credits.', 0, ?)`, sub.id, ts);

  const detail = await c.get(`/api/creators/submissions/${sub.id}`);
  assert.equal(detail.body.submission.status, 'info_required');
  assert.equal(detail.body.submission.editable, true);
  assert.ok(detail.body.events.some((e) => e.kind === 'info_request' && e.by === 'lumina'));
  assert.ok(!JSON.stringify(detail.body.events).includes('Internal'), 'staff-only events are hidden');

  // While info is required the creator may still edit and add files.
  assert.equal((await c.patch(`/api/creators/submissions/${sub.id}`, { additionalInfo: 'Licence attached as PDF.' })).status, 200);
  assert.equal((await c.post(`/api/creators/submissions/${sub.id}/respond`, { message: '' })).status, 422);
  const resp = await c.post(`/api/creators/submissions/${sub.id}/respond`, { message: 'The licence PDF is now attached.' });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.submission.status, 'submitted');
  const events = (await c.get(`/api/creators/submissions/${sub.id}`)).body.events;
  const last = events.at(-1);
  assert.equal(last.kind, 'info_response');
  assert.equal(last.fromStatus, 'info_required');
  assert.equal(last.toStatus, 'submitted');
});

test('drafts can be deleted with their files; files can be removed while editable', async () => {
  const c = await t.userClient({ isCreator: true });
  const sub = await newSubmission(c);
  const fileId = attachFile(sub.id, 'poster');
  const other = await t.userClient({ isCreator: true });
  assert.equal((await other.del(`/api/creators/submissions/${sub.id}/files/${fileId}`)).status, 404);
  assert.equal((await c.del(`/api/creators/submissions/${sub.id}/files/${fileId}`)).status, 204);
  assert.equal((await c.del(`/api/creators/submissions/${sub.id}/files/${fileId}`)).status, 404);
  assert.ok((await c.get(`/api/creators/submissions/${sub.id}`)).body.events.some((e) => e.kind === 'file' && /Removed/.test(e.message)));
  assert.equal((await c.del(`/api/creators/submissions/${sub.id}`)).status, 204);
  assert.equal((await c.get(`/api/creators/submissions/${sub.id}`)).status, 404);
});

test('creator titles report honest stats from real activity', async () => {
  const c = await t.userClient({ isCreator: true });
  assert.deepEqual((await c.get('/api/creators/titles')).body.items, []);
  const sub = await newSubmission(c);
  // Publication happens through the admin API; simulate the link it creates.
  t.db.run(`UPDATE submissions SET status = 'published', title_id = 'hanami' WHERE id = ?`, sub.id);
  const viewer = await t.userClient();
  await viewer.put('/api/library/progress', { titleId: 'hanami', positionS: 30, durationS: 600, watchedDelta: 30 });
  await viewer.post('/api/titles/hanami/reviews', { rating: 4, body: 'Lovely and calm.' });
  const r = await c.get('/api/creators/titles');
  assert.equal(r.body.items.length, 1);
  const item = r.body.items[0];
  assert.equal(item.id, 'hanami');
  assert.equal(item.submissionId, sub.id);
  const viewers = t.db.get(`SELECT COUNT(DISTINCT profile_id) AS n FROM history WHERE title_id = 'hanami'`).n;
  assert.equal(item.stats.viewers, viewers);
  const visible = t.db.get(`SELECT COUNT(*) AS n, AVG(rating) AS a FROM reviews WHERE title_id = 'hanami' AND status = 'visible'`);
  assert.deepEqual(item.stats.memberRating, { average: Math.round(visible.a * 10) / 10, count: visible.n });
  assert.ok(item.stats.reviewCount >= 1);
  const other = await t.userClient({ isCreator: true });
  assert.deepEqual((await other.get('/api/creators/titles')).body.items, []);
});

test('a response to an information request waits for running uploads', async () => {
  const c = await t.userClient({ isCreator: true });
  const sub = await newSubmission(c);
  await c.post(`/api/creators/submissions/${sub.id}/attest`, { rights: RIGHTS, confirm: true });
  attachFile(sub.id, 'feature');
  await c.post(`/api/creators/submissions/${sub.id}/submit`);
  t.db.run(`UPDATE submissions SET status = 'info_required', status_reason = 'Please upload a new master.' WHERE id = ?`, sub.id);

  const up = await c.post('/api/uploads', { filename: 'new-master.mp4', size: 500_000, purpose: 'submission', submissionId: sub.id, role: 'feature' });
  assert.equal(up.status, 200);
  const early = await c.post(`/api/creators/submissions/${sub.id}/respond`, { message: 'The new master is uploading.' });
  assert.equal(early.status, 409);
  assert.equal(early.body.error.code, 'UPLOADS_IN_PROGRESS');
  assert.equal((await c.get(`/api/creators/submissions/${sub.id}`)).body.submission.status, 'info_required', 'still open for files');
  assert.equal((await c.del(`/api/uploads/${up.body.id}`)).status, 204);
  const resp = await c.post(`/api/creators/submissions/${sub.id}/respond`, { message: 'Sent without the new master after all.' });
  assert.equal(resp.status, 200);
  assert.equal(resp.body.submission.status, 'submitted');
});

// Identities: five separate accounts per device on "Who's watching?", unique usernames,
// secure switching (a real new session), independent data and sign-out.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';

let t;
before(async () => {
  t = await startTestServer();
  const { limiter } = await import('../../server/lib/security.js');
  limiter.disabled = true;
});
after(async () => { await t.close(); });

const PW = 'paper lanterns over water';
let seq = 0;
const uid = () => `${++seq}${Date.now().toString(36)}`;
const reg = (c, o = {}) => c.post('/api/auth/register', { username: `viewer${uid()}`, email: `v${uid()}@example.com`, password: PW, acceptTerms: true, ...o });

/** A browser: one cookie jar (device + session cookies). */
const browser = () => t.client();

test('usernames are required, validated and unique regardless of case', async () => {
  const c = browser();
  assert.equal((await reg(c, { username: undefined })).status, 422);
  const bad = await reg(c, { username: 'a b' });
  assert.equal(bad.status, 422);
  assert.ok(bad.body.error.fields.username);
  assert.equal((await reg(c, { username: 'admin' })).status, 422, 'reserved');
  const ok = await reg(browser(), { username: 'HanaSato' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.account.username, 'HanaSato');
  const dup = await reg(browser(), { username: 'hanasato' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'USERNAME_TAKEN');
  // The database itself refuses a duplicate, not only the API.
  assert.throws(() => t.db.run(`INSERT INTO accounts (id, username, email, display_name, password_hash, created_at, updated_at) VALUES ('acc_dupe', 'HANASATO', 'dupe@example.com', 'x', 'x', 'now', 'now')`), /UNIQUE/);
});

test('sign in with the username or the email; passwords are hashed', async () => {
  const c = browser();
  const r = await reg(c, { username: 'kenji.ito', email: 'kenji@example.com' });
  assert.equal(r.status, 200);
  const row = t.db.get('SELECT password_hash FROM accounts WHERE username = ?', 'kenji.ito');
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!row.password_hash.includes(PW));
  for (const identifier of ['kenji.ito', 'KENJI.ITO', 'kenji@example.com']) {
    const b = browser();
    const res = await b.post('/api/auth/login', { identifier, password: PW });
    assert.equal(res.status, 200, identifier);
    assert.equal(res.body.account.username, 'kenji.ito');
  }
  const wrong = await browser().post('/api/auth/login', { identifier: 'kenji.ito', password: 'not the password' });
  assert.equal(wrong.status, 401);
});

test('a device lists at most five identities; a sixth cannot be created or added, and nothing is deleted', async () => {
  const c = browser();
  const names = [];
  for (let i = 0; i < 5; i++) {
    const res = await reg(c);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    names.push(res.body.account.username);
  }
  const list = (await c.get('/api/identities')).body;
  assert.equal(list.identities.length, 5);
  assert.equal(list.freeSlots, 0);
  assert.deepEqual(list.identities.map((x) => x.username), names);
  assert.equal(new Set(list.identities.map((x) => x.avatar)).size, 5, 'each identity gets its own picture');
  assert.deepEqual(Object.keys(list.identities[0]).sort(), ['active', 'avatar', 'displayName', 'id', 'remembered', 'slot', 'suspended', 'username'], 'no private fields');

  const accountsBefore = t.db.get('SELECT COUNT(*) AS n FROM accounts').n;
  const sixth = await reg(c);
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.error.code, 'IDENTITY_LIMIT');
  assert.match(sixth.body.error.message, /Remove one/);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM accounts').n, accountsBefore, 'no account was created');

  // An existing account from elsewhere cannot be added either.
  const other = browser();
  const o = await reg(other, { username: `outsider${uid()}` });
  const login = await c.post('/api/auth/login', { identifier: o.body.account.username, password: PW });
  assert.equal(login.status, 409);
  assert.equal(login.body.error.code, 'IDENTITY_LIMIT');
  assert.equal((await c.get('/api/identities')).body.identities.length, 5, 'existing identities untouched');

  // The database enforces the five slots too.
  const device = t.db.get('SELECT device_id FROM device_identities LIMIT 1').device_id;
  assert.throws(() => t.db.run(`INSERT INTO device_identities (device_id, account_id, slot, added_at) VALUES (?, ?, 5, 'now')`, device, o.body.account.id), /CHECK/);
});

test('switching requires the password and creates a new authenticated session', async () => {
  const c = browser();
  const a = (await reg(c, { username: `alice${uid()}` })).body.account;
  const b = (await reg(c, { username: `bob${uid()}` })).body.account;
  // b is signed in now (last registered). Switching to a needs a's password.
  const tokenBefore = c.jar.get('lumina_sid');
  const noPw = await c.post('/api/identities/switch', { accountId: a.id });
  assert.equal(noPw.status, 401);
  assert.equal(noPw.body.error.code, 'PASSWORD_REQUIRED');
  const wrong = await c.post('/api/identities/switch', { accountId: a.id, password: 'wrong password!!' });
  assert.equal(wrong.status, 401);
  assert.equal((await c.get('/api/session')).body.account.id, b.id, 'still b after failures');

  const ok = await c.post('/api/identities/switch', { accountId: a.id, password: PW });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.account.id, a.id);
  assert.equal((await c.get('/api/session')).body.account.id, a.id);
  assert.notEqual(c.jar.get('lumina_sid'), tokenBefore, 'a new session token');
  // The previous session is gone on the server: its token no longer authenticates.
  const old = t.client();
  old.jar.set('lumina_sid', tokenBefore);
  assert.equal((await old.get('/api/session')).body.account, null);
  assert.ok(t.db.get(`SELECT 1 FROM audit_log WHERE action = 'auth.switch_identity' AND target_id = ?`, a.id));
});

test('“keep me signed in” lets an identity switch without a password until it signs out', async () => {
  const c = browser();
  const a = (await reg(c, { username: `rem${uid()}`, remember: true })).body.account;
  const b = (await reg(c, { username: `oth${uid()}` })).body.account;
  const list = (await c.get('/api/identities')).body.identities;
  assert.equal(list.find((x) => x.id === a.id).remembered, true);
  assert.equal(list.find((x) => x.id === b.id).remembered, false);
  const sw = await c.post('/api/identities/switch', { accountId: a.id });
  assert.equal(sw.status, 200);
  assert.equal(sw.body.account.id, a.id);
  // Signing out forgets it on this device: the password is needed again.
  assert.equal((await c.post('/api/auth/logout')).status, 204);
  assert.equal((await c.get('/api/identities')).body.identities.find((x) => x.id === a.id).remembered, false);
  assert.equal((await c.post('/api/identities/switch', { accountId: a.id })).status, 401);
});

test('each identity has its own watchlist, history and settings', async () => {
  const c = browser();
  const a = (await reg(c, { username: `wa${uid()}`, remember: true })).body.account;
  await c.put('/api/library/watchlist/hanami');
  await c.put('/api/library/progress', { titleId: 'hanami', positionS: 5, durationS: 16 });
  await c.put(`/api/profiles/${(await c.get('/api/session')).body.profile.id}/preferences`, { preferences: { appearance: { preset: 'golden-pavilion' } } });
  const b = (await reg(c, { username: `wb${uid()}`, remember: true })).body.account;
  assert.deepEqual((await c.get('/api/library/watchlist')).body.items, [], 'b starts empty');
  assert.equal((await c.get('/api/library/history')).body.items.length, 0);
  await c.put('/api/library/watchlist/sintel');
  assert.notEqual((await c.get('/api/session')).body.profile.preferences.appearance.preset, 'golden-pavilion');

  await c.post('/api/identities/switch', { accountId: a.id });
  assert.deepEqual((await c.get('/api/library/watchlist')).body.items.map((i) => i.titleId), ['hanami']);
  assert.equal((await c.get('/api/session')).body.profile.preferences.appearance.preset, 'golden-pavilion');
  await c.post('/api/identities/switch', { accountId: b.id });
  assert.deepEqual((await c.get('/api/library/watchlist')).body.items.map((i) => i.titleId), ['sintel']);
});

test('one identity cannot reach another’s private data by id, cookie or device tampering', async () => {
  const c = browser();
  const a = (await reg(c, { username: `pa${uid()}` })).body;
  const aProfile = a.profile.id;
  const b = (await reg(c, { username: `pb${uid()}` })).body;
  assert.equal(b.account.id !== a.account.id, true);
  // b (signed in) edits a's profile by id → refused.
  const edit = await c.patch(`/api/profiles/${aProfile}`, { name: 'Hacked' });
  assert.ok([403, 404].includes(edit.status), `PATCH other profile → ${edit.status}`);
  assert.ok([403, 404].includes((await c.put(`/api/profiles/${aProfile}/preferences`, { preferences: { appearance: { preset: 'minimal-black' } } })).status));
  assert.ok(!(await c.get('/api/profiles')).body.profiles.some((p) => p.id === aProfile));

  // Switching to an identity that is not on this device is refused, password or not.
  const stranger = (await reg(browser(), { username: `st${uid()}` })).body.account;
  const s = await c.post('/api/identities/switch', { accountId: stranger.id, password: PW });
  assert.equal(s.status, 404);
  assert.equal(s.body.error.code, 'IDENTITY_NOT_FOUND');

  // A forged device cookie sees nothing.
  const forged = t.client();
  forged.jar.set('lumina_device', 'not-a-real-device-token');
  assert.deepEqual((await forged.get('/api/identities')).body.identities, []);
});

test('signing out removes access to protected data', async () => {
  const c = browser();
  await reg(c, { username: `so${uid()}` });
  assert.equal((await c.get('/api/library/watchlist')).status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 204);
  assert.equal((await c.get('/api/library/watchlist')).status, 401);
  assert.equal((await c.get('/api/account/sessions')).status, 401);
  assert.equal((await c.get('/api/session')).body.account, null);
});

test('removing an identity from the device keeps the account', async () => {
  const c = browser();
  const a = (await reg(c, { username: `rm${uid()}` })).body.account;
  await reg(c, { username: `rn${uid()}` });
  const res = await c.del(`/api/identities/${a.id}`);
  assert.equal(res.status, 200);
  assert.ok(!res.body.identities.some((x) => x.id === a.id));
  assert.ok(t.db.get('SELECT 1 FROM accounts WHERE id = ?', a.id), 'account kept');
  assert.equal((await c.del(`/api/identities/${a.id}`)).status, 404);
});

test('pictures stay unique among a device’s identities; usernames can be changed but not duplicated', async () => {
  const c = browser();
  const first = (await reg(c, { username: `pic${uid()}`, avatar: 'velvet-lotus' })).body.account;
  assert.equal(first.avatar, 'velvet-lotus');
  const clash = await reg(c, { username: `pid${uid()}`, avatar: 'velvet-lotus' });
  assert.equal(clash.status, 422);
  assert.ok(clash.body.error.fields.avatar);
  const second = (await reg(c, { username: `pie${uid()}` })).body.account;
  assert.notEqual(second.avatar, 'velvet-lotus');
  assert.equal((await c.patch('/api/account', { avatar: 'velvet-lotus' })).status, 422, 'taken on this device');
  assert.equal((await c.patch('/api/account', { avatar: 'moonlit-ronin' })).body.account.avatar, 'moonlit-ronin');
  const taken = await c.patch('/api/account', { username: first.username.toUpperCase() });
  assert.equal(taken.status, 409);
  const renamed = await c.patch('/api/account', { username: `renamed${uid()}` });
  assert.equal(renamed.status, 200);
  assert.match(renamed.body.account.username, /^renamed/);
});

test('accounts from before usernames existed receive a unique one', async () => {
  const { backfillUsernames } = await import('../../server/services/identities.js');
  const ts = new Date().toISOString();
  t.db.run(`INSERT INTO accounts (id, email, display_name, password_hash, created_at, updated_at) VALUES ('acc_legacy1', 'hana.sato@example.org', 'Hana', 'x', ?, ?)`, ts, ts);
  t.db.run(`INSERT INTO accounts (id, email, display_name, password_hash, created_at, updated_at) VALUES ('acc_legacy2', 'hana.sato@example.net', 'Hana', 'x', ?, ?)`, ts, ts);
  backfillUsernames(t.db);
  const u1 = t.db.get(`SELECT username, avatar FROM accounts WHERE id = 'acc_legacy1'`);
  const u2 = t.db.get(`SELECT username FROM accounts WHERE id = 'acc_legacy2'`).username;
  assert.equal(u1.username, 'hana.sato');
  assert.equal(u2, 'hana.sato-2');
  assert.ok(u1.avatar);
});

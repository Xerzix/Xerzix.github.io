import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';

let t;
let devOutbox;
let totp;
let config;
let limiter;
before(async () => {
  t = await startTestServer();
  ({ devOutbox } = await import('../../server/services/mailer.js'));
  ({ totp } = await import('../../server/lib/crypto.js'));
  ({ config } = await import('../../server/config.js'));
  ({ limiter } = await import('../../server/lib/security.js'));
});
after(async () => { await t.close(); });

const PW = 'velvet lanterns at dusk';
let seq = 0;
const email = (p = 'user') => `${p}${++seq}.${Date.now().toString(36)}@example.com`;
const uname = () => `aiko${++seq}x${Date.now().toString(36)}`;
const register = (c, overrides = {}) => c.post('/api/auth/register', { username: uname(), email: email(), password: PW, displayName: 'Aiko', acceptTerms: true, ...overrides });
const lastMailTo = (to) => [...devOutbox()].reverse().find((m) => m.to === to);

test('register returns the session payload, creates the first profile and selects it', async () => {
  const c = t.client();
  const addr = email('Mixed.Case');
  const res = await register(c, { email: `  ${addr.toUpperCase()}  `, displayName: 'Aiko Tanaka' });
  assert.equal(res.status, 200);
  const session = await c.get('/api/session');
  assert.deepEqual(Object.keys(res.body).sort(), Object.keys(session.body).sort());
  assert.deepEqual(res.body, session.body);
  assert.equal(res.body.account.email, addr.toLowerCase());
  assert.equal(res.body.account.displayName, 'Aiko Tanaka');
  assert.equal(res.body.profile.name, 'Aiko Tanaka');
  assert.equal(res.body.profileCount, 1);
  assert.equal(res.body.limits.maxProfiles, 5);
  assert.equal(res.body.account.password_hash, undefined);
  const row = t.db.get('SELECT terms_accepted_at, password_hash FROM accounts WHERE email = ?', addr.toLowerCase());
  assert.ok(row.terms_accepted_at);
  assert.match(row.password_hash, /^scrypt\$/);
  assert.ok(!JSON.stringify(res.body).includes('scrypt'));
});

test('register validates the password policy, display name and terms', async () => {
  const c = t.client();
  const short = await register(c, { password: 'short' });
  assert.equal(short.status, 422);
  assert.match(short.body.error.fields.password, /at least 10/);
  const common = await register(c, { password: 'Password123!' });
  assert.equal(common.status, 422);
  assert.match(common.body.error.fields.password, /too common/);
  assert.equal((await register(c, { password: 'qwertyuiop' })).status, 422);
  const own = await register(c, { email: 'hanako.garden@example.com', password: 'my hanako.garden secret' });
  assert.match(own.body.error.fields.password, /email/);
  const long = await register(c, { password: 'x'.repeat(150) + 'y'.repeat(60) });
  assert.equal(long.status, 422);
  const all = await c.post('/api/auth/register', { email: 'nope', password: PW, displayName: 'x'.repeat(41), acceptTerms: false });
  assert.equal(all.status, 422);
  assert.ok(all.body.error.fields.email);
  assert.ok(all.body.error.fields.displayName);
  assert.ok(all.body.error.fields.acceptTerms);
  const noTerms = await c.post('/api/auth/register', { username: uname(), email: email(), password: PW, displayName: 'Aiko' });
  assert.equal(noTerms.status, 422);
  assert.ok(noTerms.body.error.fields.acceptTerms);
  // Consent must be an explicit JSON true, not a value that merely coerces to one.
  for (const acceptTerms of ['true', 1, '1', 'yes', {}]) {
    const coerced = await register(c, { acceptTerms });
    assert.equal(coerced.status, 422, `acceptTerms: ${JSON.stringify(acceptTerms)}`);
    assert.ok(coerced.body.error.fields.acceptTerms);
  }
  assert.equal((await c.get('/api/session')).body.account, null);
});

test('an email can only register once (case-insensitive)', async () => {
  const addr = email('dup');
  assert.equal((await register(t.client(), { email: addr })).status, 200);
  const again = await register(t.client(), { email: addr.toUpperCase() });
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'EMAIL_TAKEN');
});

test('registration can be switched off', async () => {
  config.auth.allowRegistration = false;
  try {
    const res = await register(t.client());
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'REGISTRATION_CLOSED');
  } finally {
    config.auth.allowRegistration = true;
  }
});

test('login: unknown email and wrong password fail identically; logout ends the session', async () => {
  const addr = email('login');
  await register(t.client(), { email: addr });
  const c = t.client();
  const unknown = await c.post('/api/auth/login', { email: email('ghost'), password: PW });
  const wrong = await c.post('/api/auth/login', { email: addr, password: 'not the right one at all' });
  assert.equal(unknown.status, 401);
  assert.equal(wrong.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
  assert.equal(unknown.body.error.code, 'INVALID_CREDENTIALS');

  const ok = await c.post('/api/auth/login', { email: `  ${addr.toUpperCase()} `, password: PW });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.email, addr);
  assert.deepEqual(ok.body, (await c.get('/api/session')).body);
  assert.ok(ok.body.profile, 'single profile without a PIN is preselected');
  const row = t.db.get('SELECT last_login_at, failed_logins FROM accounts WHERE email = ?', addr);
  assert.ok(row.last_login_at);
  assert.equal(row.failed_logins, 0);

  assert.equal((await c.post('/api/auth/logout')).status, 204);
  assert.equal((await c.get('/api/session')).body.account, null);
  assert.equal((await c.post('/api/auth/logout')).status, 401);
});

test('login replaces the browser’s previous session and skips profile preselection when there is a choice', async () => {
  const owner = await t.signUp(email('multi'), PW);
  await owner.post('/api/profiles', { name: 'Second', avatar: 'koi' });
  const c = t.client();
  const first = await c.post('/api/auth/login', { email: owner.email, password: PW });
  assert.equal(first.body.profile, null);
  const oldToken = c.jar.get('lumina_sid');
  const before = t.db.get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE email = ?)', owner.email).n;
  await c.post('/api/auth/login', { email: owner.email, password: PW });
  assert.notEqual(c.jar.get('lumina_sid'), oldToken);
  const after = t.db.get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = (SELECT id FROM accounts WHERE email = ?)', owner.email).n;
  assert.equal(after, before, 'the old session was removed, not kept alongside');
});

test('repeated failures lock the account, then it unlocks and counters reset', async () => {
  const addr = email('lock');
  await register(t.client(), { email: addr });
  const c = t.client();
  for (let i = 1; i < config.auth.maxFailedLogins; i++) {
    const r = await c.post('/api/auth/login', { email: addr, password: `wrong password ${i}` });
    assert.equal(r.status, 401);
  }
  const locking = await c.post('/api/auth/login', { email: addr, password: 'wrong password final' });
  assert.equal(locking.status, 423);
  assert.equal(locking.body.error.code, 'ACCOUNT_LOCKED');
  assert.ok(locking.body.error.retryAfter > 0);
  const stillLocked = await c.post('/api/auth/login', { email: addr, password: PW });
  assert.equal(stillLocked.status, 423, 'even the right password is refused while locked');
  assert.ok(t.db.get("SELECT 1 FROM audit_log WHERE action = 'auth.lockout'"));
  assert.ok(t.db.get("SELECT 1 FROM notifications n JOIN accounts a ON a.id = n.account_id WHERE a.email = ? AND n.type = 'account_security'", addr));

  t.db.run('UPDATE accounts SET locked_until = ? WHERE email = ?', new Date(Date.now() - 1000).toISOString(), addr);
  assert.equal((await c.post('/api/auth/login', { email: addr, password: 'wrong again' })).status, 401);
  assert.equal((await c.post('/api/auth/login', { email: addr, password: PW })).status, 200);
  const row = t.db.get('SELECT failed_logins, locked_until FROM accounts WHERE email = ?', addr);
  assert.equal(row.failed_logins, 0);
  assert.equal(row.locked_until, null);
});

test('parallel wrong passwords all count towards the lockout (no lost updates)', async () => {
  const addr = email('race');
  await register(t.client(), { email: addr });
  const attempts = config.auth.maxFailedLogins + 4;
  const results = await Promise.all(Array.from({ length: attempts }, (_, i) => t.client().post('/api/auth/login', { email: addr, password: `wrong password ${i}` })));
  const statuses = results.map((r) => r.status);
  assert.ok(statuses.every((s) => s === 401 || s === 423), JSON.stringify(statuses));
  const row = t.db.get('SELECT failed_logins, locked_until FROM accounts WHERE email = ?', addr);
  assert.ok(row.locked_until && row.locked_until > new Date().toISOString(), `locked after ${attempts} parallel failures: ${JSON.stringify(row)}`);
  assert.ok(t.db.get("SELECT 1 FROM notifications n JOIN accounts a ON a.id = n.account_id WHERE a.email = ? AND n.type = 'account_security'", addr), 'the owner is told');
  // The right password arriving alongside the guesses is refused too.
  assert.equal((await t.client().post('/api/auth/login', { email: addr, password: PW })).status, 423);
});

test('suspended accounts cannot sign in (only the password holder learns why)', async () => {
  const addr = email('susp');
  await register(t.client(), { email: addr });
  const until = new Date(Date.now() + 86_400_000).toISOString();
  t.db.run("UPDATE accounts SET status = 'suspended', suspended_reason = 'Spam reviews', suspended_until = ? WHERE email = ?", until, addr);
  const c = t.client();
  const wrong = await c.post('/api/auth/login', { email: addr, password: 'definitely wrong pw' });
  assert.equal(wrong.body.error.code, 'INVALID_CREDENTIALS');
  const res = await c.post('/api/auth/login', { email: addr, password: PW });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'ACCOUNT_SUSPENDED');
  assert.equal(res.body.error.reason, 'Spam reviews');
  assert.equal(res.body.error.until, until);
  t.db.run('UPDATE accounts SET suspended_until = NULL WHERE email = ?', addr);
  assert.equal((await c.post('/api/auth/login', { email: addr, password: PW })).body.error.code, 'ACCOUNT_SUSPENDED');
  t.db.run('UPDATE accounts SET suspended_until = ? WHERE email = ?', new Date(Date.now() - 1000).toISOString(), addr);
  assert.equal((await c.post('/api/auth/login', { email: addr, password: PW })).status, 200, 'an expired suspension no longer blocks');
});

test('two-factor authentication: setup needs elevation, then sign-in needs a code', async () => {
  const c = await t.signUp(email('totp'), PW);
  const setupCold = await c.post('/api/account/2fa/setup');
  assert.equal(setupCold.status, 403);
  assert.equal(setupCold.body.error.code, 'REAUTH_REQUIRED');

  const badElevate = await c.post('/api/auth/elevate', { password: 'not my password!' });
  assert.equal(badElevate.status, 403);
  assert.equal(badElevate.body.error.code, 'INVALID_PASSWORD');
  const elevate = await c.post('/api/auth/elevate', { password: PW });
  assert.equal(elevate.status, 200);
  assert.ok(Date.parse(elevate.body.elevatedUntil) > Date.now());
  assert.equal((await c.get('/api/session')).body.elevated, true);

  const setup = await c.post('/api/account/2fa/setup');
  assert.equal(setup.status, 200);
  const { secret, otpauthUrl } = setup.body;
  assert.match(secret, /^[A-Z2-7]{32}$/);
  assert.match(otpauthUrl, /^otpauth:\/\/totp\/Lumina/);
  const stored = t.db.get('SELECT totp_secret, totp_enabled FROM accounts WHERE email = ?', c.email);
  assert.equal(stored.totp_enabled, 0);
  assert.ok(!stored.totp_secret.includes(secret), 'secret is encrypted at rest');

  const wrongCode = await c.post('/api/account/2fa/enable', { code: totp(secret) === '000000' ? '111111' : '000000' });
  assert.equal(wrongCode.status, 422);
  const enable = await c.post('/api/account/2fa/enable', { code: totp(secret) });
  assert.equal(enable.status, 200);
  assert.equal(enable.body.account.totpEnabled, true);
  // Each code is accepted once. Clearing the stored step stands in for waiting for the next code.
  const nextCode = () => t.db.run('UPDATE accounts SET totp_last_step = NULL WHERE email = ?', c.email);
  nextCode();

  const d = t.client();
  const wrongPw = await d.post('/api/auth/login', { email: c.email, password: 'wrong password here' });
  assert.equal(wrongPw.body.error.code, 'INVALID_CREDENTIALS', 'TOTP is only asked for after the password is right');
  const need = await d.post('/api/auth/login', { email: c.email, password: PW });
  assert.equal(need.status, 401);
  assert.equal(need.body.error.code, 'TOTP_REQUIRED');
  const bad = await d.post('/api/auth/login', { email: c.email, password: PW, totp: '12345x' });
  assert.equal(bad.status, 401);
  assert.equal(bad.body.error.code, 'INVALID_TOTP');
  const code = totp(secret);
  const good = await d.post('/api/auth/login', { email: c.email, password: PW, totp: code });
  assert.equal(good.status, 200);
  assert.equal(good.body.account.totpEnabled, true);
  // A code that has been accepted once cannot be replayed (RFC 6238 §5.2).
  const replay = await t.client().post('/api/auth/login', { email: c.email, password: PW, totp: code });
  assert.equal(replay.status, 401);
  assert.equal(replay.body.error.code, 'INVALID_TOTP');
  assert.equal(replay.body.error.reused, true);
  nextCode();
  const racing = await Promise.all([1, 2, 3].map(() => t.client().post('/api/auth/login', { email: c.email, password: PW, totp: totp(secret) })));
  assert.equal(racing.filter((r) => r.status === 200).length, 1, 'parallel sign-ins with one code: only one succeeds');

  // Elevation now needs the code too, and also refuses a replayed one.
  assert.equal((await d.post('/api/auth/elevate', { password: PW })).body.error.code, 'TOTP_REQUIRED');
  nextCode();
  const elevateCode = totp(secret);
  assert.equal((await d.post('/api/auth/elevate', { password: PW, totp: elevateCode })).status, 200);
  assert.equal((await d.post('/api/auth/elevate', { password: PW, totp: elevateCode })).body.error.code, 'INVALID_TOTP');
  nextCode();

  assert.equal((await d.post('/api/account/2fa/disable', { password: PW, code: '000000' === totp(secret) ? '111111' : '000000' })).status, 403);
  assert.equal((await d.post('/api/account/2fa/disable', { password: 'wrong password here', code: totp(secret) })).status, 403);
  const off = await d.post('/api/account/2fa/disable', { password: PW, code: totp(secret) });
  assert.equal(off.status, 200);
  assert.equal(off.body.account.totpEnabled, false);
  assert.equal(t.db.get('SELECT totp_secret FROM accounts WHERE email = ?', c.email).totp_secret, null);
  assert.equal((await t.client().post('/api/auth/login', { email: c.email, password: PW })).status, 200);
});

test('forgot/reset: neutral answer, single-use token, every session revoked', async () => {
  const c = await t.signUp(email('reset'), PW);
  const other = t.client();
  await other.post('/api/auth/login', { email: c.email, password: PW });
  const before = devOutbox().length;

  const unknown = await t.client().post('/api/auth/forgot', { email: email('nobody') });
  assert.equal(unknown.status, 202);
  assert.equal(devOutbox().length, before, 'no mail for unknown addresses');

  const first = await t.client().post('/api/auth/forgot', { email: c.email.toUpperCase() });
  assert.equal(first.status, 202);
  assert.deepEqual(first.body, unknown.body, 'same response either way');
  const firstToken = new URL(lastMailTo(c.email).text.match(/https?:\/\/\S+/)[0].replace('/#/', '/')).searchParams.get('token');
  // A second request invalidates the first link.
  await t.client().post('/api/auth/forgot', { email: c.email });
  const mail = lastMailTo(c.email);
  assert.match(mail.subject, /Reset your Lumina password/);
  const link = mail.text.match(/https?:\/\/\S+/)[0];
  assert.ok(link.startsWith(`${config.publicUrl}/#/reset?token=`));
  const token = decodeURIComponent(link.split('token=')[1]);
  assert.notEqual(token, firstToken);
  assert.equal((await t.client().post('/api/auth/reset', { token: firstToken, password: 'a brand new passphrase' })).body.error.code, 'RESET_INVALID');
  assert.ok(!t.db.get('SELECT 1 FROM password_resets WHERE token_hash = ?', token), 'only the hash is stored');

  const weak = await t.client().post('/api/auth/reset', { token, password: 'password1234' });
  assert.equal(weak.status, 422);
  const ok = await t.client().post('/api/auth/reset', { token, password: 'a brand new passphrase' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/session')).body.account, null, 'existing sessions are revoked');
  assert.equal((await other.get('/api/session')).body.account, null);
  assert.equal((await t.client().post('/api/auth/reset', { token, password: 'another new passphrase' })).status, 400, 'tokens are single use');
  assert.equal((await t.client().post('/api/auth/login', { email: c.email, password: PW })).status, 401);
  assert.equal((await t.client().post('/api/auth/login', { email: c.email, password: 'a brand new passphrase' })).status, 200);
  assert.ok(t.db.get("SELECT 1 FROM notifications n JOIN accounts a ON a.id = n.account_id WHERE a.email = ? AND n.title LIKE 'Your password was reset%'", c.email));

  t.db.run("UPDATE password_resets SET used_at = NULL, expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal((await t.client().post('/api/auth/reset', { token, password: 'yet another passphrase' })).status, 400, 'expired tokens fail');
});

test('sessions list marks the current one; revocation is limited to your own sessions', async () => {
  const a1 = await t.signUp(email('sess'), PW);
  const a2 = t.client();
  await a2.post('/api/auth/login', { email: a1.email, password: PW }, { headers: { 'User-Agent': 'Lumina TV test' } });
  const list = await a1.get('/api/account/sessions');
  assert.equal(list.body.items.length, 2);
  assert.equal(list.body.items[0].current, true);
  assert.equal(list.body.items.filter((s) => s.current).length, 1);
  for (const s of list.body.items) assert.deepEqual(Object.keys(s).sort(), ['createdAt', 'current', 'id', 'ip', 'lastSeenAt', 'userAgent']);
  const otherSession = list.body.items.find((s) => !s.current);
  assert.equal(otherSession.userAgent, 'Lumina TV test');

  const stranger = await t.signUp(email('stranger'), PW);
  assert.equal((await stranger.del(`/api/account/sessions/${otherSession.id}`)).status, 404);
  assert.ok((await a2.get('/api/session')).body.account, 'still signed in');

  assert.equal((await a1.del(`/api/account/sessions/${otherSession.id}`)).status, 200);
  assert.equal((await a2.get('/api/session')).body.account, null);

  const a3 = t.client();
  await a3.post('/api/auth/login', { email: a1.email, password: PW });
  const a4 = t.client();
  await a4.post('/api/auth/login', { email: a1.email, password: PW });
  const all = await a1.del('/api/account/sessions');
  assert.equal(all.body.revoked, 2);
  assert.equal((await a3.get('/api/session')).body.account, null);
  assert.equal((await a4.get('/api/session')).body.account, null);
  assert.ok((await a1.get('/api/session')).body.account);

  const own = (await a1.get('/api/account/sessions')).body.items[0];
  assert.equal((await a1.del(`/api/account/sessions/${own.id}`)).status, 200);
  assert.equal((await a1.get('/api/session')).body.account, null, 'revoking the current session signs this browser out');
});

test('changing the password verifies the current one, applies the policy and revokes other sessions', async () => {
  const c = await t.signUp(email('pw'), PW);
  const other = t.client();
  await other.post('/api/auth/login', { email: c.email, password: PW });
  const wrong = await c.post('/api/account/password', { currentPassword: 'wrong current pw', newPassword: 'moss on temple stones' });
  assert.equal(wrong.status, 403);
  assert.ok(wrong.body.error.fields.currentPassword);
  const weak = await c.post('/api/account/password', { currentPassword: PW, newPassword: 'sunshine2024' });
  assert.equal(weak.status, 422);
  assert.ok(weak.body.error.fields.newPassword);
  const same = await c.post('/api/account/password', { currentPassword: PW, newPassword: PW });
  assert.equal(same.status, 422);
  const ok = await c.post('/api/account/password', { currentPassword: PW, newPassword: 'moss on temple stones' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.revokedSessions, 1);
  assert.ok((await c.get('/api/session')).body.account, 'this session stays signed in');
  assert.equal((await other.get('/api/session')).body.account, null);
  assert.equal((await t.client().post('/api/auth/login', { email: c.email, password: 'moss on temple stones' })).status, 200);
  assert.ok(t.db.get("SELECT 1 FROM audit_log WHERE action = 'account.password_change'"));
});

test('account details: display name, and email changes need the password and notify the old address', async () => {
  const c = await t.signUp(email('details'), PW);
  const taken = await t.signUp(email('taken'), PW);
  const name = await c.patch('/api/account', { displayName: 'Hana' });
  assert.equal(name.body.account.displayName, 'Hana');
  const newAddr = email('moved');
  const noPw = await c.patch('/api/account', { email: newAddr });
  assert.equal(noPw.status, 422);
  assert.ok(noPw.body.error.fields.currentPassword);
  assert.equal((await c.patch('/api/account', { email: newAddr, currentPassword: 'wrong password!!' })).status, 403);
  const dup = await c.patch('/api/account', { email: taken.email.toUpperCase(), currentPassword: PW });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'EMAIL_TAKEN');
  const ok = await c.patch('/api/account', { email: newAddr, currentPassword: PW });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.account.email, newAddr);
  assert.equal(ok.body.account.emailVerified, false);
  const notice = lastMailTo(c.email);
  assert.match(notice.subject, /email address was changed/);
  assert.ok(notice.text.includes(newAddr));
  assert.equal((await t.client().post('/api/auth/login', { email: newAddr, password: PW })).status, 200);
});

test('plan describes the free tier without payment details', async () => {
  const c = await t.signUp(email('plan'), PW);
  const res = await c.get('/api/account/plan');
  assert.deepEqual(res.body, { mode: 'free', plan: 'Lumina Free', billing: null, cancellable: false });
  assert.equal((await t.client().get('/api/account/plan')).status, 401);
});

test('export contains personal data and no secrets', async () => {
  const c = await t.signUp(email('export'), PW);
  await c.post('/api/auth/elevate', { password: PW });
  const { secret } = (await c.post('/api/account/2fa/setup')).body;
  await c.post('/api/account/2fa/enable', { code: totp(secret) });
  const { profile } = (await c.get('/api/session')).body;
  await c.put(`/api/profiles/${profile.id}/pin`, { pin: '4321' });
  await c.put('/api/library/watchlist/sintel');
  await c.put('/api/library/progress', { titleId: 'sintel', positionS: 100, durationS: 888, watchedDelta: 20 });
  await t.client().post('/api/auth/forgot', { email: c.email });

  const res = await c.get('/api/account/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="lumina-data-\d{4}-\d{2}-\d{2}\.json"/);
  const data = res.body;
  assert.equal(data.account.email, c.email);
  assert.equal(data.profiles.length, 1);
  assert.equal(data.profiles[0].hasPin, true);
  assert.deepEqual(data.watchlist.map((w) => w.titleId), ['sintel']);
  assert.equal(data.progress[0].positionS, 100);
  assert.ok(data.history.length >= 1);
  for (const key of ['collections', 'reviews', 'reviewComments', 'notifications', 'creatorApplications', 'submissions', 'sessions']) assert.ok(Array.isArray(data[key]), key);

  const text = JSON.stringify(data);
  const row = t.db.get('SELECT * FROM accounts WHERE email = ?', c.email);
  const prof = t.db.get('SELECT pin_hash FROM profiles WHERE id = ?', profile.id);
  for (const needle of ['password_hash', 'pin_hash', 'totp_secret', 'token_hash', 'passwordHash', 'pinHash', 'totpSecret', 'tokenHash', 'scrypt$', row.password_hash, row.totp_secret, prof.pin_hash, secret]) {
    assert.ok(!text.includes(needle), `export must not contain ${needle.slice(0, 20)}`);
  }
  for (const r of t.db.all('SELECT token_hash FROM password_resets WHERE account_id = ?', row.id)) assert.ok(!text.includes(r.token_hash));
  for (const s of t.db.all('SELECT token_hash FROM sessions WHERE account_id = ?', row.id)) assert.ok(!text.includes(s.token_hash));
});

test('deleting the account needs the password and DELETE, removes data and protects the last admin', async () => {
  const c = await t.signUp(email('delete'), PW);
  await c.put('/api/library/watchlist/sintel');
  const accountId = t.db.get('SELECT id FROM accounts WHERE email = ?', c.email).id;
  assert.equal((await c.del('/api/account', { password: PW, confirm: 'delete' })).status, 422);
  assert.equal((await c.del('/api/account', { password: 'wrong password!!', confirm: 'DELETE' })).status, 403);

  // Last active admin guard: this account becomes the only admin.
  const existingAdmins = t.db.all("SELECT id FROM accounts WHERE role = 'admin'");
  t.db.run("UPDATE accounts SET role = 'member' WHERE role = 'admin'");
  t.db.run("UPDATE accounts SET role = 'admin' WHERE id = ?", accountId);
  const guarded = await c.del('/api/account', { password: PW, confirm: 'DELETE' });
  assert.equal(guarded.status, 409);
  assert.equal(guarded.body.error.code, 'LAST_ADMIN');
  const second = await t.userClient({ role: 'admin' });
  const res = await c.del('/api/account', { password: PW, confirm: 'DELETE' });
  assert.equal(res.status, 204);
  t.db.run('DELETE FROM accounts WHERE id = ?', second.accountId);
  for (const a of existingAdmins) t.db.run("UPDATE accounts SET role = 'admin' WHERE id = ?", a.id);

  assert.equal(c.jar.has('lumina_sid'), false, 'session cookie cleared');
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM accounts WHERE id = ?', accountId).n, 0);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', accountId).n, 0);
  assert.equal(t.db.get('SELECT COUNT(*) AS n FROM sessions WHERE account_id = ?', accountId).n, 0);
  assert.equal(t.db.get("SELECT COUNT(*) AS n FROM watchlist WHERE profile_id NOT IN (SELECT id FROM profiles)").n, 0);
  assert.ok(t.db.get("SELECT 1 FROM audit_log WHERE action = 'account.delete' AND target_id = ?", accountId));
  assert.equal((await t.client().post('/api/auth/login', { email: c.email, password: PW })).status, 401);
});

test('account endpoints require sign-in', async () => {
  const anon = t.client();
  for (const [m, p] of [['get', '/api/account/sessions'], ['get', '/api/account/export'], ['patch', '/api/account'], ['post', '/api/account/password'], ['post', '/api/auth/elevate'], ['post', '/api/account/2fa/setup']]) {
    assert.equal((await anon[m](p, {})).status, 401, `${m} ${p}`);
  }
});

test('rate limits: sign-in per IP and registration per IP', async () => {
  process.env.LUMINA_TEST_RATE_LIMITS = '1';
  limiter.reset();
  try {
    const c = t.client();
    for (let i = 0; i < 10; i++) {
      assert.equal((await c.post('/api/auth/login', { email: `nobody${i}@example.com`, password: PW })).status, 401);
    }
    const limited = await c.post('/api/auth/login', { email: 'nobody@example.com', password: PW });
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error.code, 'RATE_LIMITED');
    assert.ok(Number(limited.headers.get('retry-after')) > 0);

    limiter.reset();
    for (let i = 0; i < 5; i++) assert.notEqual((await register(t.client(), { password: 'short' })).status, 429);
    assert.equal((await register(t.client())).status, 429);
  } finally {
    delete process.env.LUMINA_TEST_RATE_LIMITS;
    limiter.reset();
  }
});

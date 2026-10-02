import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';

let t;
let limiter;
before(async () => {
  t = await startTestServer();
  ({ limiter } = await import('../../server/lib/security.js'));
});
after(async () => { await t.close(); });

const PW = 'velvet lanterns at dusk';
let seq = 0;
const email = () => `prof${++seq}.${Date.now().toString(36)}@example.com`;
const profilesOf = async (c) => (await c.get('/api/profiles')).body;
const currentProfile = async (c) => (await c.get('/api/session')).body.profile;

test('lists profiles with the account maximum', async () => {
  const c = await t.signUp(email(), PW, 'Aiko');
  const res = await profilesOf(c);
  assert.equal(res.max, 5);
  assert.equal(res.profiles.length, 1);
  const [p] = res.profiles;
  assert.equal(p.name, 'Aiko');
  assert.equal(p.hasPin, false);
  assert.equal(p.pin_hash, undefined);
  assert.ok(p.preferences.appearance);
  assert.equal((await t.client().get('/api/profiles')).status, 401);
});

test('up to 5 profiles; the 6th is refused with PROFILE_LIMIT until one is deleted', async () => {
  const c = await t.signUp(email(), PW, 'Owner');
  const created = [];
  for (const name of ['Two', 'Three', 'Four', 'Five']) {
    const r = await c.post('/api/profiles', { name, avatar: 'koi' });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.profile.name, name);
    created.push(r.body.profile);
  }
  assert.equal((await profilesOf(c)).profiles.length, 5);
  const sixth = await c.post('/api/profiles', { name: 'Six', avatar: 'fox' });
  assert.equal(sixth.status, 409);
  assert.equal(sixth.body.error.code, 'PROFILE_LIMIT');
  assert.equal(sixth.body.error.max, 5);
  assert.match(sixth.body.error.message, /already has 5 profiles/);
  assert.match(sixth.body.error.message, /not separate subscriptions or simultaneous streams/);
  assert.match(sixth.body.error.message, /Delete a profile to create another/);
  assert.equal((await profilesOf(c)).profiles.length, 5);

  assert.equal((await c.del(`/api/profiles/${created[0].id}`)).status, 204);
  const again = await c.post('/api/profiles', { name: 'Six', avatar: 'fox' });
  assert.equal(again.status, 200);
  assert.equal((await profilesOf(c)).profiles.length, 5);
  assert.equal((await c.post('/api/profiles', { name: 'Seven' })).body.error.code, 'PROFILE_LIMIT');
});

test('the database trigger backs up the limit (per-account maximum)', async () => {
  const c = await t.signUp(email(), PW);
  t.db.run('UPDATE accounts SET max_profiles = 2 WHERE email = ?', c.email);
  assert.equal((await c.post('/api/profiles', { name: 'B' })).status, 200);
  const res = await c.post('/api/profiles', { name: 'C' });
  assert.equal(res.body.error.code, 'PROFILE_LIMIT');
  assert.equal(res.body.error.max, 2);
  // Direct insert past the limit is rejected by the trigger itself.
  const accountId = t.db.get('SELECT id FROM accounts WHERE email = ?', c.email).id;
  assert.throws(() => t.db.run("INSERT INTO profiles (id, account_id, name, created_at, updated_at) VALUES ('prf_x', ?, 'X', 'now', 'now')", accountId), /PROFILE_LIMIT/);
});

test('profile validation: names unique per account, avatars, maturity and languages', async () => {
  const c = await t.signUp(email(), PW, 'Mei');
  const dupe = await c.post('/api/profiles', { name: 'mei' });
  assert.equal(dupe.status, 409);
  assert.equal(dupe.body.error.code, 'PROFILE_NAME_TAKEN');
  const cases = [
    [{ name: '' }, 'name'],
    [{ name: 'x'.repeat(41) }, 'name'],
    [{ name: 'A', avatar: 'dragon' }, 'avatar'],
    [{ name: 'B', maxAge: 10 }, 'maxAge'],
    [{ name: 'C', isKids: true, maxAge: 14 }, 'maxAge'],
    [{ name: 'D', uiLanguage: 'fr' }, 'uiLanguage'],
    [{ name: 'E', audioLanguage: 'not a language' }, 'audioLanguage'],
  ];
  for (const [body, field] of cases) {
    const r = await c.post('/api/profiles', body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.ok(r.body.error.fields[field], `${field} for ${JSON.stringify(body)}`);
  }
  const kid = await c.post('/api/profiles', { name: 'Kid', avatar: 'fox', isKids: true });
  assert.equal(kid.body.profile.isKids, true);
  assert.equal(kid.body.profile.maxAge, 7, 'kids profiles default to the youngest preset');
  const teen = await c.post('/api/profiles', { name: 'Teen', avatar: 'wave', maxAge: 14, uiLanguage: 'ja', audioLanguage: 'ja', subtitleLanguage: 'en', subtitlesDefault: true, autoplayNext: false, autoplayPreviews: false });
  const p = teen.body.profile;
  assert.deepEqual([p.isKids, p.maxAge, p.uiLanguage, p.audioLanguage, p.subtitleLanguage, p.subtitlesDefault, p.autoplayNext, p.autoplayPreviews], [false, 14, 'ja', 'ja', 'en', true, false, false]);
  assert.equal(p.preferences.playback.autoplayNext, false, 'column and preference stay in step');

  const renamed = await c.patch(`/api/profiles/${p.id}`, { name: 'KID' });
  assert.equal(renamed.status, 409, 'names are unique ignoring case');
  const up = await c.patch(`/api/profiles/${p.id}`, { name: 'Teenager', avatar: 'moon', maxAge: null, autoplayNext: true });
  assert.equal(up.body.profile.name, 'Teenager');
  assert.equal(up.body.profile.maxAge, null);
  assert.equal(up.body.profile.preferences.playback.autoplayNext, true);
  const kidsOn = await c.patch(`/api/profiles/${p.id}`, { isKids: true });
  assert.equal(kidsOn.body.profile.maxAge, 7);
  assert.equal((await c.patch(`/api/profiles/${p.id}`, { maxAge: 14 })).status, 422, 'kids profiles stay at 13 or below');
});

test('PIN: select, edit and delete need it; changing it needs the current PIN', async () => {
  const c = await t.signUp(email(), PW, 'Parent');
  const parent = await currentProfile(c);
  const other = (await c.post('/api/profiles', { name: 'Other', avatar: 'crane' })).body.profile;
  assert.equal((await c.put(`/api/profiles/${other.id}/pin`, { pin: '12a4' })).status, 422);
  assert.equal((await c.put(`/api/profiles/${other.id}/pin`, { pin: '12345' })).status, 422);
  const set = await c.put(`/api/profiles/${other.id}/pin`, { pin: '2468' });
  assert.equal(set.status, 200);
  assert.equal(set.body.profile.hasPin, true);
  assert.match(t.db.get('SELECT pin_hash FROM profiles WHERE id = ?', other.id).pin_hash, /^scrypt\$/);

  const noPin = await c.post(`/api/profiles/${other.id}/select`, {});
  assert.equal(noPin.status, 403);
  assert.equal(noPin.body.error.code, 'PIN_REQUIRED');
  const badPin = await c.post(`/api/profiles/${other.id}/select`, { pin: '1111' });
  assert.equal(badPin.status, 403);
  assert.equal(badPin.body.error.code, 'PIN_INVALID');
  assert.equal((await currentProfile(c)).id, parent.id, 'still on the original profile');

  assert.equal((await c.patch(`/api/profiles/${other.id}`, { name: 'Renamed' })).body.error.code, 'PIN_REQUIRED');
  assert.equal((await c.patch(`/api/profiles/${other.id}`, { name: 'Renamed', pin: '0000' })).body.error.code, 'PIN_INVALID');
  assert.equal((await c.patch(`/api/profiles/${other.id}`, { name: 'Renamed', pin: '2468' })).status, 200);
  assert.equal((await c.put(`/api/profiles/${other.id}/preferences`, { preferences: { playback: { skipIntro: true } } })).body.error.code, 'PIN_REQUIRED');
  assert.equal((await c.del(`/api/profiles/${other.id}`, {})).body.error.code, 'PIN_REQUIRED');

  const sel = await c.post(`/api/profiles/${other.id}/select`, { pin: '2468' });
  assert.equal(sel.status, 200);
  assert.equal(sel.body.profile.id, other.id);
  assert.equal((await currentProfile(c)).id, other.id);
  // The active profile (entered with its PIN) may edit its everyday settings.
  assert.equal((await c.patch(`/api/profiles/${other.id}`, { avatar: 'bamboo' })).status, 200);
  assert.equal((await c.put(`/api/profiles/${other.id}/preferences`, { preferences: { playback: { skipIntro: true } } })).status, 200);
  // …but not its maturity settings, or its PIN, without the PIN.
  assert.equal((await c.patch(`/api/profiles/${other.id}`, { maxAge: 13 })).body.error.code, 'PIN_REQUIRED');
  assert.equal((await c.put(`/api/profiles/${other.id}/pin`, { pin: '1357' })).body.error.code, 'PIN_REQUIRED');
  assert.equal((await c.put(`/api/profiles/${other.id}/pin`, { pin: '1357', currentPin: '9999' })).body.error.code, 'PIN_INVALID');
  assert.equal((await c.put(`/api/profiles/${other.id}/pin`, { pin: '1357', currentPin: '2468' })).status, 200);
  const removed = await c.put(`/api/profiles/${other.id}/pin`, { pin: null, currentPin: '1357' });
  assert.equal(removed.body.profile.hasPin, false);
  assert.equal((await c.post(`/api/profiles/${parent.id}/select`, {})).status, 200);
});

test('a PIN that is supplied is always verified, even where it could have been left out', async () => {
  const c = await t.signUp(email(), PW, 'Parent');
  const parent = await currentProfile(c);
  await c.put(`/api/profiles/${parent.id}/pin`, { pin: '2468' });
  // The active profile may change everyday settings without its PIN…
  assert.equal((await c.patch(`/api/profiles/${parent.id}`, { avatar: 'moon' })).status, 200);
  // …but a wrong PIN is never waved through, so a client can use it to confirm the PIN.
  const wrong = await c.patch(`/api/profiles/${parent.id}`, { pin: '1111' });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'PIN_INVALID');
  assert.equal((await c.patch(`/api/profiles/${parent.id}`, { pin: '2468' })).status, 200);
  assert.equal((await c.put(`/api/profiles/${parent.id}/preferences`, { pin: '9999', preferences: { playback: { skipIntro: true } } })).body.error.code, 'PIN_INVALID');
  // The same holds while the account password has been re-entered (elevated).
  await c.post('/api/auth/elevate', { password: PW });
  assert.equal((await c.patch(`/api/profiles/${parent.id}`, { name: 'Renamed' })).status, 200);
  assert.equal((await c.patch(`/api/profiles/${parent.id}`, { name: 'Again', pin: '0000' })).body.error.code, 'PIN_INVALID');
  assert.equal((await c.put(`/api/profiles/${parent.id}/pin`, { pin: '1357', currentPin: '0000' })).body.error.code, 'PIN_INVALID');
  assert.equal((await c.put(`/api/profiles/${parent.id}/pin`, { pin: '1357' })).status, 200, 'elevated owners may reset a PIN without the old one');
});

test('forgotten PIN: re-entering the account password allows resetting it, not entering the profile', async () => {
  const c = await t.signUp(email(), PW);
  const other = (await c.post('/api/profiles', { name: 'Locked' })).body.profile;
  await c.put(`/api/profiles/${other.id}/pin`, { pin: '8642' });
  await c.post('/api/auth/elevate', { password: PW });
  assert.equal((await c.post(`/api/profiles/${other.id}/select`, {})).body.error.code, 'PIN_REQUIRED');
  const reset = await c.put(`/api/profiles/${other.id}/pin`, { pin: '1234' });
  assert.equal(reset.status, 200);
  assert.equal((await c.post(`/api/profiles/${other.id}/select`, { pin: '1234' })).status, 200);
});

test('the last profile cannot be deleted; deleting with a PIN works and clears the selection', async () => {
  const c = await t.signUp(email(), PW);
  const first = await currentProfile(c);
  const last = await c.del(`/api/profiles/${first.id}`, {});
  assert.equal(last.status, 409);
  assert.equal(last.body.error.code, 'LAST_PROFILE');
  const other = (await c.post('/api/profiles', { name: 'Spare' })).body.profile;
  await c.put(`/api/profiles/${other.id}/pin`, { pin: '5555' });
  await c.post(`/api/profiles/${other.id}/select`, { pin: '5555' });
  assert.equal((await c.del(`/api/profiles/${other.id}`, { pin: '5556' })).body.error.code, 'PIN_INVALID');
  assert.equal((await c.del(`/api/profiles/${other.id}`, { pin: '5555' })).status, 204);
  const s = (await c.get('/api/session')).body;
  assert.equal(s.profile, null, 'the deleted profile is no longer active');
  assert.equal(s.profileCount, 1);
  assert.ok(t.db.get("SELECT 1 FROM audit_log WHERE action = 'profile.delete' AND target_id = ?", other.id));
});

test('preferences: whitelisted deep merge with validation', async () => {
  const c = await t.signUp(email(), PW);
  const p = await currentProfile(c);
  const url = `/api/profiles/${p.id}/preferences`;
  const first = await c.put(url, {
    preferences: {
      appearance: { preset: 'crimson-temple', environment: 'lantern', petalIntensity: 0.3, density: 'compact', motion: 'reduced', evil: '<script>' },
      subtitles: { size: 'large', color: '#ffee00' },
      home: { hiddenRows: ['trending-tv', 'japanese', 'trending-tv'] },
      privacy: { statsEnabled: false },
      playback: { autoplayNext: false, skipIntro: true, defaultQuality: 'data-saver' },
      admin: { role: 'admin' },
    },
    role: 'admin',
  });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const prefs = first.body.profile.preferences;
  assert.equal(prefs.appearance.preset, 'crimson-temple');
  assert.equal(prefs.appearance.environment, 'lantern');
  assert.equal(prefs.appearance.motion, 'reduced');
  assert.equal(prefs.appearance.parallax, true, 'untouched keys keep their defaults');
  assert.equal(prefs.appearance.evil, undefined);
  assert.equal(prefs.admin, undefined);
  assert.equal(prefs.subtitles.size, 'large');
  assert.equal(prefs.subtitles.background, 'shadow');
  assert.deepEqual(prefs.home.hiddenRows, ['trending-tv', 'japanese']);
  assert.equal(prefs.privacy.statsEnabled, false);
  assert.equal(prefs.privacy.useHistoryForRecommendations, true);
  assert.equal(first.body.profile.autoplayNext, false, 'playback.autoplayNext updates the profile column too');
  const stored = JSON.parse(t.db.get('SELECT preferences FROM profiles WHERE id = ?', p.id).preferences);
  assert.equal(stored.appearance.evil, undefined);

  // A later patch merges instead of replacing.
  const second = await c.put(url, { preferences: { appearance: { preset: 'custom', custom: { bg: '#010203', text: '#FAFAFA' } }, home: { hiddenRows: [] } } });
  const a = second.body.profile.preferences.appearance;
  assert.equal(a.preset, 'custom');
  assert.deepEqual(a.custom, { bg: '#010203', text: '#FAFAFA' });
  assert.equal(a.environment, 'lantern');
  assert.equal(a.density, 'compact');
  assert.deepEqual(second.body.profile.preferences.home.hiddenRows, []);
  assert.equal((await c.put(url, { preferences: { appearance: { custom: null, preset: 'minimal-black' } } })).body.profile.preferences.appearance.custom, null);

  const invalid = [
    { appearance: { preset: 'neon' } },
    { appearance: { environment: 'volcano' } },
    { appearance: { custom: { accent: 'red' } } },
    { appearance: { custom: { accent: '#12345' } } },
    { appearance: { petalIntensity: 1.5 } },
    { appearance: { ambientLight: -0.1 } },
    { appearance: { density: 'huge' } },
    { appearance: { motion: 'sometimes' } },
    { appearance: { animation: 'yes please' } },
    { subtitles: { size: 'giant' } },
    { subtitles: { color: 'white' } },
    { subtitles: { background: 'blur' } },
    { subtitles: { position: 'left' } },
    { playback: { defaultQuality: '8k' } },
    { home: { hiddenRows: Array.from({ length: 31 }, (_, i) => `row-${i}`) } },
    { home: { hiddenRows: ['<img src=x>'] } },
    { privacy: { statsEnabled: 'maybe' } },
  ];
  for (const preferences of invalid) {
    const r = await c.put(url, { preferences });
    assert.equal(r.status, 422, JSON.stringify(preferences));
    assert.equal(r.body.error.code, 'VALIDATION_FAILED');
  }
  assert.equal((await c.put(url, {})).status, 422, 'preferences are required');
  const unchanged = (await currentProfile(c)).preferences.appearance;
  assert.equal(unchanged.preset, 'minimal-black');
});

test('cross-account isolation', async () => {
  const alice = await t.signUp(email(), PW, 'Alice');
  const bob = await t.signUp(email(), PW, 'Bob');
  const ap = await currentProfile(alice);
  const calls = [
    () => bob.patch(`/api/profiles/${ap.id}`, { name: 'Hacked' }),
    () => bob.del(`/api/profiles/${ap.id}`, {}),
    () => bob.post(`/api/profiles/${ap.id}/select`, {}),
    () => bob.put(`/api/profiles/${ap.id}/pin`, { pin: '1111' }),
    () => bob.put(`/api/profiles/${ap.id}/preferences`, { preferences: { playback: { skipIntro: true } } }),
  ];
  for (const call of calls) assert.equal((await call()).status, 404);
  assert.ok(!(await profilesOf(bob)).profiles.some((p) => p.id === ap.id));
  assert.equal((await currentProfile(alice)).name, 'Alice');
  assert.equal((await currentProfile(bob)).name, 'Bob');
});

test('parental controls: a kids session cannot add profiles or loosen its own limits', async () => {
  const parent = await t.userClient({ password: PW });
  const kidProfile = (await parent.post('/api/profiles', { name: 'Kid', avatar: 'fox', isKids: true, maxAge: 8 })).body.profile;
  await parent.put(`/api/profiles/${parent.profileId}/pin`, { pin: '7777' });
  assert.equal((await parent.post(`/api/profiles/${kidProfile.id}/select`, {})).status, 200);
  const blocked = [
    () => parent.post('/api/profiles', { name: 'Grown-up' }),
    () => parent.patch(`/api/profiles/${kidProfile.id}`, { isKids: false }),
    () => parent.patch(`/api/profiles/${kidProfile.id}`, { maxAge: 13 }),
    () => parent.patch(`/api/profiles/${parent.profileId}`, { name: 'Changed', pin: '7777' }),
    () => parent.put(`/api/profiles/${kidProfile.id}/pin`, { pin: '1234' }),
    () => parent.del(`/api/profiles/${parent.profileId}`, { pin: '7777' }),
  ];
  for (const call of blocked) {
    const r = await call();
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'PARENTAL_CONTROL');
  }
  // Everyday settings of its own profile are fine.
  assert.equal((await parent.patch(`/api/profiles/${kidProfile.id}`, { avatar: 'koi', subtitlesDefault: true })).status, 200);
  assert.equal((await parent.put(`/api/profiles/${kidProfile.id}/preferences`, { preferences: { appearance: { environment: 'snow' } } })).status, 200);
  // The adult profile stays locked behind its PIN.
  assert.equal((await parent.post(`/api/profiles/${parent.profileId}/select`, {})).body.error.code, 'PIN_REQUIRED');
  // A grown-up confirming the account password lifts the restriction.
  await parent.post('/api/auth/elevate', { password: PW });
  assert.equal((await parent.patch(`/api/profiles/${kidProfile.id}`, { maxAge: 13 })).status, 200);
});

test('PIN attempts are rate limited per profile', async () => {
  process.env.LUMINA_TEST_RATE_LIMITS = '1';
  limiter.reset();
  try {
    const c = await t.signUp(email(), PW);
    const other = (await c.post('/api/profiles', { name: 'Vault' })).body.profile;
    await c.put(`/api/profiles/${other.id}/pin`, { pin: '4040' });
    for (let i = 0; i < 5; i++) assert.equal((await c.post(`/api/profiles/${other.id}/select`, { pin: `100${i}` })).body.error.code, 'PIN_INVALID');
    const limited = await c.post(`/api/profiles/${other.id}/select`, { pin: '4040' });
    assert.equal(limited.status, 429);
    // Editing is not a way around the limit.
    assert.equal((await c.patch(`/api/profiles/${other.id}`, { name: 'X', pin: '4040' })).status, 429);
    limiter.reset();
    assert.equal((await c.post(`/api/profiles/${other.id}/select`, { pin: '4040' })).status, 200);
  } finally {
    delete process.env.LUMINA_TEST_RATE_LIMITS;
    limiter.reset();
  }
});

test('server-side catalogues match the browser (avatars, presets, environments, colours, languages)', async () => {
  const server = await import('../../server/services/profiles.js');
  const { AVATARS } = await import('../../js/ui/avatars.js');
  const { PRESETS, THEME_KEYS, DEFAULT_APPEARANCE } = await import('../../js/theme.js');
  const { ENVIRONMENTS } = await import('../../js/fx/garden.js');
  const { INTERFACE_LANGUAGES } = await import('../../js/core/i18n.js');
  const { MATURITY_PRESETS } = await import('../../js/core/ratings.js');
  assert.deepEqual(server.AVATAR_IDS, AVATARS.map((a) => a.id));
  assert.deepEqual(server.PRESET_IDS, PRESETS.map((p) => p.id));
  assert.deepEqual(server.ENVIRONMENT_IDS, ENVIRONMENTS.map((e) => e.id));
  assert.deepEqual(server.THEME_KEYS, THEME_KEYS);
  assert.deepEqual(server.UI_LANGUAGES, INTERFACE_LANGUAGES.map((l) => l.code));
  assert.deepEqual(server.MATURITY_AGES, MATURITY_PRESETS.map((m) => m.maxAge).filter((n) => n !== null));
  // Every appearance default is a value the preferences endpoint accepts.
  const c = await t.signUp(email(), PW);
  const p = await currentProfile(c);
  const { motion, ...rest } = DEFAULT_APPEARANCE;
  const res = await c.put(`/api/profiles/${p.id}/preferences`, { preferences: { appearance: { ...rest, motion, custom: PRESETS[3].colors } } });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

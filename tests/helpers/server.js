// Test harness: boots the Lumina app on an ephemeral port with a fresh SQLite file and
// returns a small client with a cookie jar. Use one harness per test file.
//
//   const t = await startTestServer();
//   const alice = t.client();
//   await alice.post('/api/auth/register', { email, password, displayName, acceptTerms: true });
//   const res = await alice.get('/api/session');   // -> { status, body, headers }
//   await t.close();
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';

process.env.NODE_ENV = 'test';
process.env.MAIL_TRANSPORT = 'log';

export async function startTestServer({ seed = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lumina-test-'));
  process.env.STORAGE_DIR = join(dir, 'storage');
  const { createApp } = await import('../../server/app.js');
  const { config } = await import('../../server/config.js');
  config.storageDir = join(dir, 'storage');
  const { app, db, services } = await createApp({ dbFile: join(dir, 'test.db'), seed });
  const server = createServer(app.handler());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  function client() {
    const jar = new Map();
    async function request(method, path, body, { headers = {}, raw = false } = {}) {
      const h = { 'X-Lumina-Request': '1', Accept: 'application/json', ...headers };
      if (jar.size) h.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
      let payload;
      if (body instanceof Uint8Array || Buffer.isBuffer(body)) payload = body;
      else if (body !== undefined) {
        h['Content-Type'] = 'application/json';
        payload = JSON.stringify(body);
      }
      const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' });
      for (const c of res.headers.getSetCookie?.() || []) {
        const [pair] = c.split(';');
        const [k, v] = pair.split('=');
        if (/Max-Age=0/i.test(c) || v === '') jar.delete(k);
        else jar.set(k, v);
      }
      if (raw) return res;
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        json = text;
      }
      return { status: res.status, body: json, headers: res.headers };
    }
    return {
      jar,
      request,
      get: (p, o) => request('GET', p, undefined, o),
      post: (p, b, o) => request('POST', p, b ?? {}, o),
      put: (p, b, o) => request('PUT', p, b ?? {}, o),
      patch: (p, b, o) => request('PATCH', p, b ?? {}, o),
      del: (p, b, o) => request('DELETE', p, b, o),
    };
  }

  /** Registers an account through the API and returns its signed-in client. */
  async function signUp(email = `user${Math.random().toString(36).slice(2, 8)}@example.com`, password = 'correct horse battery', displayName = 'Tester') {
    const c = client();
    const res = await c.post('/api/auth/register', { email, password, displayName, acceptTerms: true });
    if (res.status >= 300) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
    c.email = email;
    c.password = password;
    return c;
  }

  /** Promotes an account (by email) to a role directly in the database, then elevates it. */
  async function makeStaff(c, role = 'admin') {
    db.run('UPDATE accounts SET role = ? WHERE email = ?', role, c.email);
    const r = await c.post('/api/auth/elevate', { password: c.password });
    if (r.status >= 300) throw new Error(`elevate failed: ${r.status} ${JSON.stringify(r.body)}`);
    return c;
  }

  /**
   * Creates an account (+ one profile) directly in the database and returns a client whose
   * cookie jar holds a live session with that profile selected. Does not depend on the
   * auth routes, so every feature area can test independently.
   *   const admin = await t.userClient({ role: 'admin', elevated: true });
   *   const creator = await t.userClient({ isCreator: true });
   */
  async function userClient({ email, role = 'member', isCreator = false, elevated = false, profile = true, maxAge = null, displayName = 'Test User', password = 'correct horse battery' } = {}) {
    const { hashPassword, newId, randomToken, sha256 } = await import('../../server/lib/crypto.js');
    const now = new Date().toISOString();
    const accountId = newId('acc');
    email ||= `${accountId}@example.com`;
    db.run(
      `INSERT INTO accounts (id, email, display_name, password_hash, role, is_creator, created_at, updated_at, terms_accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      accountId, email, displayName, await hashPassword(password), role, isCreator ? 1 : 0, now, now, now,
    );
    let profileId = null;
    if (profile) {
      profileId = newId('prf');
      db.run('INSERT INTO profiles (id, account_id, name, avatar, max_age, is_kids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', profileId, accountId, displayName, 'sakura', maxAge, maxAge !== null ? 1 : 0, now, now);
    }
    const token = randomToken(32);
    const expires = new Date(Date.now() + 86_400_000).toISOString();
    const elevatedUntil = elevated ? new Date(Date.now() + 15 * 60_000).toISOString() : null;
    db.run(
      `INSERT INTO sessions (id, account_id, token_hash, profile_id, created_at, last_seen_at, expires_at, elevated_until, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'test', '127.0.0.1')`,
      newId('ses'), accountId, sha256(token), profileId, now, now, expires, elevatedUntil,
    );
    const c = client();
    c.jar.set('lumina_sid', token);
    Object.assign(c, { accountId, profileId, email, password });
    return c;
  }

  async function close() {
    await new Promise((r) => server.close(r));
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }

  return { base, app, db, services, client, signUp, makeStaff, userClient, close, dir };
}

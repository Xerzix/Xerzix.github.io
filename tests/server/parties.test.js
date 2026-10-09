// Watch parties: lifecycle, permissions, host promotion, chat limits and the SSE stream.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer } from '../helpers/server.js';
import { PartyService, CODE_PATTERN } from '../../server/services/parties.js';

let t;
before(async () => { t = await startTestServer(); });
after(async () => { await t.close(); });

/** Opens the SSE stream and returns a reader that yields parsed events. */
async function openEvents(client, code) {
  const ac = new AbortController();
  const res = await fetch(`${t.base}/api/parties/${code}/events`, { headers: { Cookie: `lumina_sid=${client.jar.get('lumina_sid')}`, Accept: 'text/event-stream' }, signal: ac.signal });
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const queue = [];
  async function next(timeoutMs = 2000) {
    const deadline = Date.now() + timeoutMs;
    while (!queue.length) {
      if (Date.now() > deadline) throw new Error('timed out waiting for an SSE event');
      const { value, done } = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r({ timeout: true }), Math.max(1, deadline - Date.now())))]);
      if (done) throw new Error('stream closed');
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let i;
      while ((i = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const ev = { event: 'message', data: '' };
        for (const line of block.split('\n')) {
          if (line.startsWith('event: ')) ev.event = line.slice(7);
          else if (line.startsWith('data: ')) ev.data += line.slice(6);
        }
        if (ev.data) queue.push({ event: ev.event, data: JSON.parse(ev.data) });
      }
    }
    return queue.shift();
  }
  async function until(event, pred = () => true, timeoutMs = 2000) {
    for (;;) {
      const ev = await next(timeoutMs);
      if (ev.event === event && pred(ev.data)) return ev;
    }
  }
  return { res, next, until, close: () => ac.abort() };
}

test('creating a party needs a profile and returns an unambiguous code', async () => {
  assert.equal((await t.client().post('/api/parties', { titleId: 'hanami' })).status, 401);
  const noProfile = await t.userClient({ profile: false });
  assert.equal((await noProfile.post('/api/parties', { titleId: 'hanami' })).status, 409);
  const host = await t.userClient({ displayName: 'Aiko' });
  const r = await host.post('/api/parties', { titleId: 'hanami' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.code, CODE_PATTERN);
  assert.equal(r.body.party.you.isHost, true);
  assert.equal(r.body.party.members.length, 1);
  assert.equal((await host.post('/api/parties', { titleId: 'does-not-exist' })).status, 404);
  // A series party starts on a concrete episode.
  const series = await host.post('/api/parties', { titleId: 'garden-hours' });
  assert.equal(series.body.party.episodeId, 'garden-hours-s1e1');
});

test('join, members privacy and control permissions', async () => {
  const host = await t.userClient({ displayName: 'Host Person' });
  const guest = await t.userClient({ displayName: 'Guest Person' });
  const { code } = (await host.post('/api/parties', { titleId: 'hanami' })).body;

  const peek = await guest.get(`/api/parties/${code.toLowerCase()}`);
  assert.equal(peek.status, 200, 'codes are case-insensitive');
  assert.equal(peek.body.party.you.isMember, false);
  // Non-members cannot read events, chat or control.
  assert.equal((await guest.post(`/api/parties/${code}/chat`, { text: 'hi' })).body.error.code, 'NOT_A_MEMBER');
  assert.equal((await guest.post(`/api/parties/${code}/control`, { action: 'play', position: 1 })).status, 403);
  assert.equal((await guest.get(`/api/parties/${code}/events`)).status, 403);

  const joined = await guest.post(`/api/parties/${code}/join`);
  assert.equal(joined.status, 200);
  assert.equal(joined.body.party.memberCount, 2);
  const json = JSON.stringify(joined.body);
  assert.ok(!json.includes(host.profileId) && !json.includes(host.accountId) && !json.includes(guest.profileId), 'members are identified by name and avatar only');
  assert.deepEqual(Object.keys(joined.body.party.members[0]).sort(), ['avatar', 'isHost', 'isYou', 'name', 'online']);

  const denied = await guest.post(`/api/parties/${code}/control`, { action: 'play', position: 3 });
  assert.equal(denied.status, 403);
  assert.equal(denied.body.error.code, 'CONTROL_NOT_ALLOWED');
  const played = await host.post(`/api/parties/${code}/control`, { action: 'play', position: 12.5 });
  assert.equal(played.status, 200);
  assert.equal(played.body.state.playing, true);
  assert.equal(played.body.state.position, 12.5);

  assert.equal((await guest.patch(`/api/parties/${code}`, { allowGuestControl: true })).body.error.code, 'HOST_ONLY');
  const opened = await host.patch(`/api/parties/${code}`, { allowGuestControl: true });
  assert.equal(opened.body.party.allowGuestControl, true);
  const paused = await guest.post(`/api/parties/${code}/control`, { action: 'pause', position: 20 });
  assert.equal(paused.status, 200);
  assert.equal(paused.body.state.playing, false);
  assert.equal((await guest.post(`/api/parties/${code}/control`, { action: 'jump' })).status, 422);
  // Only the host ends the party.
  assert.equal((await guest.del(`/api/parties/${code}`)).status, 403);
});

test('episode changes are validated against the party title', async () => {
  const host = await t.userClient();
  const { code } = (await host.post('/api/parties', { titleId: 'garden-hours' })).body;
  assert.equal((await host.post(`/api/parties/${code}/control`, { action: 'episode' })).status, 422);
  assert.equal((await host.post(`/api/parties/${code}/control`, { action: 'episode', episodeId: 'sintel' })).status, 404);
  const ok = await host.post(`/api/parties/${code}/control`, { action: 'episode', episodeId: 'garden-hours-s2e1' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.state.episodeId, 'garden-hours-s2e1');
  assert.equal(ok.body.state.position, 0);
});

test('parental limits apply when joining', async () => {
  const host = await t.userClient();
  const kid = await t.userClient({ maxAge: 7 });
  const { code } = (await host.post('/api/parties', { titleId: 'sintel' })).body;
  const r = await kid.post(`/api/parties/${code}/join`);
  assert.equal(r.status, 403);
  assert.equal(r.body.error.code, 'PROFILE_RESTRICTED');
});

test('the host leaving promotes the next member; the last member leaving ends the party', async () => {
  const host = await t.userClient({ displayName: 'First' });
  const second = await t.userClient({ displayName: 'Second' });
  const third = await t.userClient({ displayName: 'Third' });
  const { code } = (await host.post('/api/parties', { titleId: 'hanami' })).body;
  await second.post(`/api/parties/${code}/join`);
  await third.post(`/api/parties/${code}/join`);
  const left = await host.post(`/api/parties/${code}/leave`);
  assert.deepEqual(left.body, { ok: true, ended: false });
  const view = (await second.get(`/api/parties/${code}`)).body.party;
  assert.equal(view.you.isHost, true);
  assert.equal(view.host.name, 'Second');
  assert.equal((await third.get(`/api/parties/${code}`)).body.party.you.isHost, false);
  await second.post(`/api/parties/${code}/leave`);
  const last = await third.post(`/api/parties/${code}/leave`);
  assert.equal(last.body.ended, true);
  assert.equal((await third.get(`/api/parties/${code}`)).status, 404);
});

test('chat is text only, bounded and rate limited', async () => {
  const host = await t.userClient();
  const { code } = (await host.post('/api/parties', { titleId: 'hanami' })).body;
  const long = await host.post(`/api/parties/${code}/chat`, { text: 'x'.repeat(501) });
  assert.equal(long.status, 422);
  assert.equal((await host.post(`/api/parties/${code}/chat`, { text: '   ' })).status, 422);
  const msg = await host.post(`/api/parties/${code}/chat`, { text: '  <b>hello</b>\n\n\nworld  ' });
  assert.equal(msg.status, 200);
  assert.equal(msg.body.message.text, '<b>hello</b>\nworld', 'stored as plain text; the client renders it as text');
  assert.equal(msg.body.message.mine, true);
  for (let i = 0; i < 4; i++) assert.equal((await host.post(`/api/parties/${code}/chat`, { text: `m${i}` })).status, 200);
  const limited = await host.post(`/api/parties/${code}/chat`, { text: 'one too many' });
  assert.equal(limited.status, 429);
  assert.ok(limited.body.error.retryAfter >= 1);
});

test('events stream: SSE headers, initial state and live updates', async () => {
  const host = await t.userClient({ displayName: 'Streamer' });
  const guest = await t.userClient({ displayName: 'Viewer' });
  const { code } = (await host.post('/api/parties', { titleId: 'hanami' })).body;
  await guest.post(`/api/parties/${code}/join`);
  const stream = await openEvents(guest, code);
  try {
    assert.equal(stream.res.status, 200);
    assert.match(stream.res.headers.get('content-type'), /^text\/event-stream/);
    assert.match(stream.res.headers.get('cache-control'), /no-store/);
    const first = await stream.next();
    assert.equal(first.event, 'state');
    assert.equal(first.data.playing, false);
    assert.ok(first.data.serverTime);
    const members = await stream.until('members');
    assert.equal(members.data.you.isHost, false);
    assert.equal(members.data.you.canControl, false);

    await host.post(`/api/parties/${code}/control`, { action: 'play', position: 42 });
    const state = await stream.until('state', (d) => d.playing);
    assert.equal(state.data.position, 42);
    assert.equal(state.data.by, 'Streamer');

    await host.post(`/api/parties/${code}/chat`, { text: 'Enjoy the film' });
    const chat = await stream.until('chat', (d) => !d.system);
    assert.equal(chat.data.text, 'Enjoy the film');
    assert.deepEqual(chat.data.author, { name: 'Streamer', avatar: 'sakura', isHost: true });
    assert.equal(chat.data.mine, false);

    await host.del(`/api/parties/${code}`);
    const ended = await stream.until('ended');
    assert.equal(ended.data.reason, 'host_ended');
  } finally {
    stream.close();
  }
});

test('feature flag disables every party endpoint', async () => {
  const { config } = await import('../../server/config.js');
  const u = await t.userClient();
  config.features.watchParties = false;
  try {
    const r = await u.post('/api/parties', { titleId: 'hanami' });
    assert.equal(r.status, 403);
    assert.equal(r.body.error.code, 'FEATURE_DISABLED');
  } finally {
    config.features.watchParties = true;
  }
});

// ── Service-level behaviour that is slow or time-based over HTTP ──
const profile = (id, name = id) => ({ id, name, avatar: 'moon' });

test('service: member cap, idle expiry and disconnect grace', async () => {
  let now = 1_000_000;
  const svc = new PartyService({ limits: { maxMembers: 3, presenceGraceMs: 20 }, clock: () => now });
  try {
    const room = svc.create({ titleId: 'hanami', profile: profile('p1', 'One'), accountId: 'a1' });
    svc.join(room.code, profile('p2'), 'a2');
    svc.join(room.code, profile('p3'), 'a3');
    assert.throws(() => svc.join(room.code, profile('p4'), 'a4'), (e) => e.code === 'PARTY_FULL');
    svc.join(room.code, profile('p3'), 'a3'); // re-joining is idempotent

    // Host disconnects: after the grace period the next member is promoted.
    const events = [];
    const unsub = svc.subscribe(room.code, 'p1', { send: (e, d) => events.push([e, d]), close() {} });
    assert.equal(events[0][0], 'state');
    unsub();
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(room.hostId, 'p2');
    assert.equal(room.members.has('p1'), false);

    // Idle for more than four hours: the room is gone.
    now += 4 * 3600_000 + 1;
    assert.equal(svc.get(room.code), null);
  } finally {
    svc.stop();
  }
});

test('service: hosting is capped per account and codes avoid ambiguous characters', () => {
  const svc = new PartyService({ limits: { maxHostedPerAccount: 2 } });
  try {
    for (let i = 0; i < 2; i++) svc.create({ titleId: 'hanami', profile: profile(`h${i}`), accountId: 'same' });
    assert.throws(() => svc.create({ titleId: 'hanami', profile: profile('h9'), accountId: 'same' }), (e) => e.code === 'PARTY_LIMIT');
    for (let i = 0; i < 200; i++) assert.doesNotMatch(svc.newCode(), /[01OIL]/);
  } finally {
    svc.stop();
  }
});

// ── Kids profiles, invisible chat and event-stream limits ──

/** A further profile (optionally a kids profile) on an existing account, with its own session. */
async function profileClient(accountId, { name, kids = false }) {
  const { newId, randomToken, sha256 } = await import('../../server/lib/crypto.js');
  const ts = new Date().toISOString();
  const profileId = newId('prf');
  t.db.run('INSERT INTO profiles (id, account_id, name, avatar, max_age, is_kids, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', profileId, accountId, name, 'sakura', kids ? 7 : null, kids ? 1 : 0, ts, ts);
  const token = randomToken(32);
  t.db.run(
    `INSERT INTO sessions (id, account_id, token_hash, profile_id, created_at, last_seen_at, expires_at, elevated_until, user_agent, ip) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'test', '127.0.0.1')`,
    newId('ses'), accountId, sha256(token), profileId, ts, ts, new Date(Date.now() + 86_400_000).toISOString(),
  );
  const c = t.client();
  c.jar.set('lumina_sid', token);
  Object.assign(c, { accountId, profileId });
  return c;
}

/** Reads events up to and including the first one matching `pred`; returns them all. */
async function readUntil(stream, pred) {
  const out = [];
  for (;;) {
    const ev = await stream.next();
    out.push(ev);
    if (pred(ev)) return out;
  }
}
const systemSays = (re) => (e) => e.event === 'chat' && e.data.system && re.test(e.data.text);

test('kids profiles cannot start parties, join strangers or chat, and leave when a stranger becomes host', async () => {
  const kid = await t.userClient({ maxAge: 7, displayName: 'Kid' });
  const parent = await profileClient(kid.accountId, { name: 'Parent' });
  const stranger = await t.userClient({ displayName: 'Stranger' });

  const create = await kid.post('/api/parties', { titleId: 'hanami' });
  assert.equal(create.status, 403);
  assert.equal(create.body.error.code, 'PROFILE_RESTRICTED');

  // A stranger's party is closed to kids profiles.
  const strangerParty = (await stranger.post('/api/parties', { titleId: 'hanami' })).body.code;
  const refused = await kid.post(`/api/parties/${strangerParty}/join`);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'PROFILE_RESTRICTED');
  await stranger.del(`/api/parties/${strangerParty}`);

  // A party started on the kid's own account is open to them, without chat.
  const { code } = (await parent.post('/api/parties', { titleId: 'hanami' })).body;
  const joined = await kid.post(`/api/parties/${code}/join`);
  assert.equal(joined.status, 200, JSON.stringify(joined.body));
  assert.equal(joined.body.party.you.canChat, false);
  assert.equal((await stranger.post(`/api/parties/${code}/join`)).status, 200);
  assert.equal((await stranger.get(`/api/parties/${code}`)).body.party.you.canChat, true);
  assert.equal((await stranger.post(`/api/parties/${code}/chat`, { text: 'hi kid, what is your name?' })).status, 200);
  assert.equal((await parent.post(`/api/parties/${code}/chat`, { text: 'popcorn time' })).status, 200);
  const kidChat = await kid.post(`/api/parties/${code}/chat`, { text: 'hi! I am 7' });
  assert.equal(kidChat.status, 403);
  assert.equal(kidChat.body.error.code, 'PROFILE_RESTRICTED');

  // The kid's stream carries the room's system messages only — no member's text, neither in
  // the history nor live. (A settings change posts a system message that marks the end.)
  const stream = await openEvents(kid, code);
  try {
    await parent.patch(`/api/parties/${code}`, { allowGuestControl: true });
    let events = await readUntil(stream, systemSays(/Everyone can now control/));
    let chats = events.filter((e) => e.event === 'chat');
    assert.ok(chats.some((e) => e.data.history && /Stranger joined/.test(e.data.text)), 'system history still arrives');
    assert.ok(chats.every((e) => e.data.system), JSON.stringify(chats));
    await stranger.post(`/api/parties/${code}/chat`, { text: 'still there?' });
    await parent.patch(`/api/parties/${code}`, { allowGuestControl: false });
    events = await readUntil(stream, systemSays(/Only the host controls/));
    chats = events.filter((e) => e.event === 'chat');
    assert.ok(chats.every((e) => e.data.system), JSON.stringify(chats));

    // The parent leaves and the stranger becomes host: the kids profile is taken out.
    await parent.post(`/api/parties/${code}/leave`);
    const ended = await stream.until('ended');
    assert.equal(ended.data.reason, 'restricted');
  } finally {
    stream.close();
  }
  const after = (await kid.get(`/api/parties/${code}`)).body.party;
  assert.equal(after.you.isMember, false);
  assert.equal(after.host.name, 'Stranger');
  assert.equal((await kid.post(`/api/parties/${code}/join`)).status, 403);
});

test('chat refuses messages made only of invisible characters and strips hidden ones', async () => {
  const host = await t.userClient();
  const { code } = (await host.post('/api/parties', { titleId: 'hanami' })).body;
  for (const text of ['​​', '⁠ ﻿', '‮​', 'ㅤ', '́']) {
    const r = await host.post(`/api/parties/${code}/chat`, { text });
    assert.equal(r.status, 422, JSON.stringify(text));
  }
  const r = await host.post(`/api/parties/${code}/chat`, { text: 'he​llo ‮world' });
  assert.equal(r.status, 200);
  assert.equal(r.body.message.text, 'hello world');
  // Joiners inside emoji sequences are kept.
  const family = '\u{1F469}‍\u{1F467}';
  assert.equal((await host.post(`/api/parties/${code}/chat`, { text: family })).body.message.text, family);
});

test('event streams: a member keeps at most three, the server caps the total, opening is rate limited', async () => {
  // Service: a fourth stream replaces the member's oldest, which is told so and closed.
  const svc = new PartyService({ limits: { maxStreams: 4 } });
  try {
    const room = svc.create({ titleId: 'hanami', profile: profile('p1'), accountId: 'a1' });
    svc.join(room.code, profile('p2'), 'a2');
    const sinks = [];
    const unsubs = [];
    for (let i = 0; i < 4; i++) {
      const sink = { events: [], closed: false };
      sink.send = (e, d) => sink.events.push([e, d]);
      sink.close = () => { sink.closed = true; };
      sinks.push(sink);
      unsubs.push(svc.subscribe(room.code, 'p1', sink));
    }
    assert.equal(sinks[0].closed, true);
    assert.deepEqual(sinks[0].events.at(-1), ['replaced', { reason: 'too_many_streams' }]);
    assert.ok(sinks.slice(1).every((s) => !s.closed));
    assert.equal(room.subscribers.size, 3);
    unsubs[0](); // the replaced stream's close handler runs later
    assert.equal(room.members.get('p1').connections, 3);
    // Server-wide cap.
    svc.subscribe(room.code, 'p2', { send() {}, close() {} });
    assert.throws(() => svc.subscribe(room.code, 'p2', { send() {}, close() {} }), (e) => e.status === 503 && e.code === 'PARTY_CAPACITY');
  } finally {
    svc.stop();
  }

  // HTTP: at the cap the refusal is a normal JSON error, not a broken stream.
  const host = await t.userClient();
  const { code } = (await host.post('/api/parties', { titleId: 'hanami' })).body;
  const limits = t.services.parties.limits;
  const saved = limits.maxStreams;
  limits.maxStreams = 0;
  try {
    const busy = await host.get(`/api/parties/${code}/events`);
    assert.equal(busy.status, 503);
    assert.equal(busy.body.error.code, 'PARTY_CAPACITY');
  } finally {
    limits.maxStreams = saved;
  }

  // HTTP: opening streams is rate limited per account.
  const { limiter } = await import('../../server/lib/security.js');
  process.env.LUMINA_TEST_RATE_LIMITS = '1';
  limiter.reset();
  try {
    const statuses = [];
    for (let i = 0; i < 31; i++) {
      const ac = new AbortController();
      const res = await fetch(`${t.base}/api/parties/${code}/events`, { headers: { Cookie: `lumina_sid=${host.jar.get('lumina_sid')}` }, signal: ac.signal });
      statuses.push(res.status);
      ac.abort();
    }
    assert.deepEqual(statuses.slice(0, 30), Array(30).fill(200));
    assert.equal(statuses[30], 429);
  } finally {
    delete process.env.LUMINA_TEST_RATE_LIMITS;
    limiter.reset();
  }
});

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

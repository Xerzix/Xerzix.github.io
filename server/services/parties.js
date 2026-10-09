// Watch parties: small, invite-only rooms where members watch the same title in sync and chat.
//
// SINGLE INSTANCE ONLY. Rooms, members and Server-Sent-Event subscribers live in this
// process's memory and disappear on restart. To run several Lumina instances behind a load
// balancer, move room state to a shared store and fan events out through pub/sub — for
// example Redis: HSET party:<code> for state/members, PUBLISH party:<code> <event> on every
// change, and have each instance SUBSCRIBE and forward to its own SSE connections (sticky
// sessions are then unnecessary). The public API of this class is the seam to replace.
//
// Privacy: other members only ever see a member's profile name and avatar. Profile and
// account ids stay on the server.
//
// Kids profiles: user-to-user text is off on kids profiles across Lumina (see reviews.js), so
// a kids profile cannot start a party, can only join one hosted from its own account, cannot
// send chat and receives only the room's system messages. If hosting passes to someone from
// another account, kids profiles of the previous account are taken out of the room.
import { randomInt } from 'node:crypto';
import { HttpError, conflict, forbidden, notFound } from '../lib/errors.js';

// No 0/O, 1/I/L: codes are read aloud and typed from phones.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CODE_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;

export const PARTY_LIMITS = {
  codeLength: 6,
  maxMembers: 20,
  idleMs: 4 * 3600_000,
  maxRooms: 500,
  maxHostedPerAccount: 3,
  chatMaxLength: 500,
  chatBurst: 5, // messages …
  chatBurstWindowMs: 10_000, // … per 10 seconds
  chatPerMinute: 20,
  chatHistory: 50,
  presenceGraceMs: 45_000, // a member whose streams all closed is removed after this
  streamsPerMember: 3, // a fourth event stream replaces that member's oldest one
  maxStreams: 1000, // event streams open across all rooms (each holds a socket)
  sweepMs: 60_000,
};

// Removed from chat text: invisible characters that only hide or reorder what others see
// (zero-width space, word joiner, BOM, soft hyphen, bidirectional embeddings/overrides/isolates).
// Zero-width (non-)joiners stay: emoji sequences and several scripts need them.
const STRIP_CHARS = /[\u00AD\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/g;
// For the emptiness check only: format characters, combining marks and blank "letters".
const INVISIBLE = /[\p{Cf}\p{M}\u115F\u1160\u3164\uFFA0\u2800]/gu;

const restricted = (message) => forbidden(message, 'PROFILE_RESTRICTED');

export class PartyService {
  constructor({ limits = {}, clock = () => Date.now() } = {}) {
    this.limits = { ...PARTY_LIMITS, ...limits };
    this.clock = clock;
    this.rooms = new Map();
    this.timer = setInterval(() => this.sweep(), this.limits.sweepMs);
    this.timer.unref?.();
  }

  // ── Codes & lookup ─────────────────────────────────────────────
  newCode() {
    for (let attempt = 0; attempt < 50; attempt++) {
      let code = '';
      for (let i = 0; i < this.limits.codeLength; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new HttpError(503, 'PARTY_CAPACITY', 'Watch parties are busy right now. Please try again in a moment.');
  }

  static normalizeCode(code) {
    return String(code || '').trim().toUpperCase();
  }

  get(code) {
    const room = this.rooms.get(PartyService.normalizeCode(code));
    if (!room || room.ended) return null;
    if (this.clock() - room.lastActivity > this.limits.idleMs) {
      this.endRoom(room, 'expired');
      return null;
    }
    return room;
  }

  require(code) {
    const room = this.get(code);
    if (!room) throw notFound('This watch party has ended or the code is not valid.', 'PARTY_NOT_FOUND');
    return room;
  }

  isMember(room, profileId) {
    return room.members.has(profileId);
  }

  requireMember(room, profileId) {
    const m = room.members.get(profileId);
    if (!m) throw forbidden('Join this watch party first.', 'NOT_A_MEMBER');
    return m;
  }

  canControl(room, profileId) {
    return room.members.has(profileId) && (room.hostId === profileId || room.allowGuestControl);
  }

  // ── Lifecycle ─────────────────────────────────────────────────
  create({ titleId, episodeId = null, profile, accountId }) {
    if (profile.is_kids) throw restricted('Kids profiles cannot start watch parties. A grown-up on this account can start one and invite this profile.');
    this.sweep();
    if (this.rooms.size >= this.limits.maxRooms) throw new HttpError(503, 'PARTY_CAPACITY', 'Watch parties are busy right now. Please try again later.');
    let hosted = 0;
    for (const r of this.rooms.values()) if (r.members.get(r.hostId)?.accountId === accountId) hosted++;
    if (hosted >= this.limits.maxHostedPerAccount) {
      throw conflict('You are already hosting the maximum number of watch parties. End one to start another.', 'PARTY_LIMIT', { max: this.limits.maxHostedPerAccount });
    }
    const t = this.clock();
    const room = {
      code: this.newCode(),
      titleId,
      hostId: profile.id,
      allowGuestControl: false,
      state: { playing: false, position: 0, updatedAt: t, episodeId: episodeId || null },
      members: new Map(),
      subscribers: new Set(),
      chat: [],
      seq: 0,
      createdAt: t,
      lastActivity: t,
      ended: false,
    };
    this.addMember(room, profile, accountId);
    this.rooms.set(room.code, room);
    return room;
  }

  addMember(room, profile, accountId) {
    const t = this.clock();
    const m = {
      key: profile.id,
      accountId,
      name: String(profile.name || 'Guest').slice(0, 40),
      avatar: profile.avatar || 'sakura',
      isKids: !!profile.is_kids,
      joinedAt: t,
      connections: 0,
      graceTimer: null,
      chatTimes: [],
    };
    room.members.set(profile.id, m);
    return m;
  }

  join(code, profile, accountId) {
    const room = this.require(code);
    const existing = room.members.get(profile.id);
    if (existing) {
      existing.name = String(profile.name || existing.name).slice(0, 40);
      existing.avatar = profile.avatar || existing.avatar;
      return room;
    }
    if (profile.is_kids && room.members.get(room.hostId)?.accountId !== accountId) {
      throw restricted('Kids profiles can only join watch parties started on their own account.');
    }
    if (room.members.size >= this.limits.maxMembers) throw conflict(`This watch party is full (${this.limits.maxMembers} people).`, 'PARTY_FULL', { max: this.limits.maxMembers });
    const m = this.addMember(room, profile, accountId);
    this.touch(room);
    this.system(room, `${m.name} joined`);
    this.broadcastMembers(room);
    return room;
  }

  /** Removes a member. Returns { ended } — the room ends when its last member leaves. */
  leave(code, profileId, { reason = 'left' } = {}) {
    const room = this.get(code);
    if (!room) return { ended: true };
    const m = room.members.get(profileId);
    if (!m) return { ended: false };
    this.removeMember(room, m);
    if (!room.members.size) {
      this.endRoom(room, 'empty');
      return { ended: true };
    }
    this.touch(room);
    let promoted = null;
    if (room.hostId === profileId) {
      // Promote the longest-standing remaining member: preferably a grown-up from the same
      // account as the host who left, then any grown-up.
      const byAge = [...room.members.values()].sort((a, b) => a.joinedAt - b.joinedAt);
      promoted = byAge.find((x) => !x.isKids && x.accountId === m.accountId) || byAge.find((x) => !x.isKids) || byAge[0];
      room.hostId = promoted.key;
    }
    this.system(room, reason === 'disconnected' ? `${m.name} lost connection` : `${m.name} left`);
    if (promoted) {
      this.system(room, `${promoted.name} is now the host`);
      // Kids profiles stay only in rooms hosted from their own account.
      for (const kid of [...room.members.values()]) {
        if (kid.isKids && kid.accountId !== promoted.accountId) {
          this.removeMember(room, kid, { notify: 'restricted' });
          this.system(room, `${kid.name} left`);
        }
      }
    }
    this.broadcastMembers(room);
    return { ended: false, promoted: !!promoted };
  }

  /** Drops a member and closes their event streams (telling them why, when `notify` is set). */
  removeMember(room, m, { notify = null } = {}) {
    clearTimeout(m.graceTimer);
    room.members.delete(m.key);
    for (const sub of [...room.subscribers]) {
      if (sub.profileId === m.key) {
        room.subscribers.delete(sub);
        if (notify) sub.send('ended', { reason: notify });
        sub.close?.();
      }
    }
  }

  end(code, profileId) {
    const room = this.require(code);
    this.requireMember(room, profileId);
    if (room.hostId !== profileId) throw forbidden('Only the host can end the watch party.', 'HOST_ONLY');
    this.endRoom(room, 'host_ended');
  }

  endRoom(room, reason) {
    if (room.ended) return;
    room.ended = true;
    this.rooms.delete(room.code);
    for (const m of room.members.values()) clearTimeout(m.graceTimer);
    for (const sub of [...room.subscribers]) {
      sub.send('ended', { reason });
      sub.close?.();
    }
    room.subscribers.clear();
  }

  sweep() {
    const t = this.clock();
    for (const room of [...this.rooms.values()]) if (t - room.lastActivity > this.limits.idleMs) this.endRoom(room, 'expired');
  }

  touch(room) {
    room.lastActivity = this.clock();
  }

  stop() {
    clearInterval(this.timer);
    for (const room of [...this.rooms.values()]) this.endRoom(room, 'shutdown');
  }

  // ── Playback state ───────────────────────────────────────────
  /** Current position, extrapolated when playing. */
  positionNow(room) {
    const s = room.state;
    return s.playing ? s.position + (this.clock() - s.updatedAt) / 1000 : s.position;
  }

  control(code, profileId, { action, position, episodeId }) {
    const room = this.require(code);
    const m = this.requireMember(room, profileId);
    if (!this.canControl(room, profileId)) throw forbidden('The host is controlling playback in this party.', 'CONTROL_NOT_ALLOWED');
    const s = room.state;
    const pos = Number.isFinite(position) ? Math.max(0, position) : this.positionNow(room);
    switch (action) {
      case 'play':
        Object.assign(s, { playing: true, position: pos });
        break;
      case 'pause':
        Object.assign(s, { playing: false, position: pos });
        break;
      case 'seek':
        s.position = pos;
        break;
      case 'episode':
        Object.assign(s, { episodeId, position: Number.isFinite(position) ? Math.max(0, position) : 0 });
        break;
      default:
        throw new HttpError(422, 'VALIDATION_FAILED', 'Unknown action.', { fields: { action: 'Unknown action.' } });
    }
    s.updatedAt = this.clock();
    this.touch(room);
    this.broadcast(room, 'state', () => ({ ...this.stateDto(room), action, by: m.name }));
    return this.stateDto(room);
  }

  setSettings(code, profileId, { allowGuestControl }) {
    const room = this.require(code);
    this.requireMember(room, profileId);
    if (room.hostId !== profileId) throw forbidden('Only the host can change party settings.', 'HOST_ONLY');
    if (typeof allowGuestControl === 'boolean' && allowGuestControl !== room.allowGuestControl) {
      room.allowGuestControl = allowGuestControl;
      this.touch(room);
      this.system(room, allowGuestControl ? 'Everyone can now control playback' : 'Only the host controls playback now');
      this.broadcastMembers(room);
    }
    return room;
  }

  // ── Chat ─────────────────────────────────────────────────────
  chat(code, profileId, text) {
    const room = this.require(code);
    const m = this.requireMember(room, profileId);
    if (m.isKids) throw restricted('Chat is turned off on kids profiles.');
    const clean = String(text || '').replace(STRIP_CHARS, '').replace(/\s+/g, (ws) => (ws.includes('\n') ? '\n' : ' ')).trim();
    if (!clean.replace(INVISIBLE, '').trim()) throw new HttpError(422, 'VALIDATION_FAILED', 'Write a message first.', { fields: { text: 'Write a message first.' } });
    if (clean.length > this.limits.chatMaxLength) {
      throw new HttpError(422, 'VALIDATION_FAILED', `Messages can be at most ${this.limits.chatMaxLength} characters.`, { fields: { text: `At most ${this.limits.chatMaxLength} characters.` } });
    }
    const t = this.clock();
    m.chatTimes = m.chatTimes.filter((x) => t - x < 60_000);
    const burst = m.chatTimes.filter((x) => t - x < this.limits.chatBurstWindowMs);
    if (burst.length >= this.limits.chatBurst || m.chatTimes.length >= this.limits.chatPerMinute) {
      const oldest = burst.length >= this.limits.chatBurst ? burst[0] + this.limits.chatBurstWindowMs : m.chatTimes[0] + 60_000;
      throw new HttpError(429, 'RATE_LIMITED', 'You are sending messages too quickly. Take a breath and try again.', { retryAfter: Math.max(1, Math.ceil((oldest - t) / 1000)) });
    }
    m.chatTimes.push(t);
    const msg = { id: ++room.seq, text: clean, at: new Date(t).toISOString(), authorKey: m.key, author: { name: m.name, avatar: m.avatar }, system: false };
    this.pushChat(room, msg);
    this.touch(room);
    return this.chatDto(room, msg, profileId);
  }

  system(room, text) {
    this.pushChat(room, { id: ++room.seq, text, at: new Date(this.clock()).toISOString(), authorKey: null, author: null, system: true });
  }

  pushChat(room, msg) {
    room.chat.push(msg);
    if (room.chat.length > this.limits.chatHistory) room.chat.shift();
    this.broadcast(room, 'chat', (viewerId) => (this.mayRead(room, msg, viewerId) ? this.chatDto(room, msg, viewerId) : null));
  }

  /** Kids profiles see only the room's system messages. */
  mayRead(room, msg, viewerId) {
    return msg.system || !room.members.get(viewerId)?.isKids;
  }

  chatDto(room, msg, viewerId) {
    return {
      id: msg.id,
      text: msg.text,
      at: msg.at,
      system: msg.system,
      author: msg.author ? { ...msg.author, isHost: msg.authorKey === room.hostId } : null,
      mine: !!viewerId && msg.authorKey === viewerId,
    };
  }

  // ── Events (SSE) ─────────────────────────────────────────────
  /**
   * Adds a subscriber for a member. `sink` = { send(event, data), close() }.
   * Sends the current state, members and recent chat immediately. Returns unsubscribe().
   */
  /** Throws 503 when the server already holds `maxStreams` event streams (each keeps a socket). */
  assertStreamCapacity() {
    let open = 0;
    for (const r of this.rooms.values()) open += r.subscribers.size;
    if (open >= this.limits.maxStreams) throw new HttpError(503, 'PARTY_CAPACITY', 'Watch parties are busy right now. Please try again in a moment.', { retryAfter: 30 });
  }

  subscribe(code, profileId, sink) {
    const room = this.require(code);
    const m = this.requireMember(room, profileId);
    this.assertStreamCapacity();
    // One member may follow a party from a few tabs or devices; beyond that the oldest
    // stream is told it was replaced (so it does not reconnect) and closed.
    const own = [...room.subscribers].filter((x) => x.profileId === profileId);
    for (const old of own.slice(0, Math.max(0, own.length - this.limits.streamsPerMember + 1))) {
      room.subscribers.delete(old);
      try {
        old.send('replaced', { reason: 'too_many_streams' });
      } catch {
        /* already broken */
      }
      old.close?.();
    }
    const sub = { profileId, send: sink.send, close: sink.close };
    room.subscribers.add(sub);
    m.connections++;
    clearTimeout(m.graceTimer);
    m.graceTimer = null;
    sub.send('state', this.stateDto(room));
    sub.send('members', this.membersDto(room, profileId));
    for (const msg of room.chat) if (this.mayRead(room, msg, profileId)) sub.send('chat', { ...this.chatDto(room, msg, profileId), history: true });
    if (m.connections === 1) this.broadcastMembers(room);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      room.subscribers.delete(sub);
      const member = room.members.get(profileId);
      if (!member || room.ended) return;
      member.connections = Math.max(0, member.connections - 1);
      if (member.connections === 0) {
        this.broadcastMembers(room);
        member.graceTimer = setTimeout(() => {
          const still = room.members.get(profileId);
          if (still && still.connections === 0 && !room.ended) this.leave(room.code, profileId, { reason: 'disconnected' });
        }, this.limits.presenceGraceMs);
        member.graceTimer.unref?.();
      }
    };
  }

  broadcast(room, event, dataFor) {
    for (const sub of room.subscribers) {
      try {
        const data = dataFor(sub.profileId);
        if (data !== null) sub.send(event, data);
      } catch {
        /* a broken stream is cleaned up by its close handler */
      }
    }
  }

  broadcastMembers(room) {
    this.broadcast(room, 'members', (viewerId) => this.membersDto(room, viewerId));
  }

  // ── DTOs ─────────────────────────────────────────────────────
  stateDto(room) {
    const s = room.state;
    return {
      playing: s.playing,
      position: Math.round(s.position * 1000) / 1000,
      updatedAt: new Date(s.updatedAt).toISOString(),
      episodeId: s.episodeId,
      serverTime: new Date(this.clock()).toISOString(),
    };
  }

  membersDto(room, viewerId) {
    const host = room.members.get(room.hostId);
    return {
      members: [...room.members.values()]
        .sort((a, b) => (a.key === room.hostId ? -1 : b.key === room.hostId ? 1 : a.joinedAt - b.joinedAt))
        .map((m) => ({ name: m.name, avatar: m.avatar, isHost: m.key === room.hostId, online: m.connections > 0, isYou: m.key === viewerId })),
      host: host ? { name: host.name, avatar: host.avatar } : null,
      allowGuestControl: room.allowGuestControl,
      you: this.youDto(room, viewerId),
    };
  }

  youDto(room, viewerId) {
    const isMember = !!viewerId && room.members.has(viewerId);
    return {
      isMember,
      isHost: isMember && room.hostId === viewerId,
      canControl: isMember && this.canControl(room, viewerId),
      canChat: isMember && !room.members.get(viewerId).isKids,
    };
  }

  partyDto(room, viewerId) {
    const host = room.members.get(room.hostId);
    return {
      code: room.code,
      titleId: room.titleId,
      episodeId: room.state.episodeId,
      host: host ? { name: host.name, avatar: host.avatar } : null,
      state: this.stateDto(room),
      members: this.membersDto(room, viewerId).members,
      memberCount: room.members.size,
      maxMembers: this.limits.maxMembers,
      allowGuestControl: room.allowGuestControl,
      you: this.youDto(room, viewerId),
      createdAt: new Date(room.createdAt).toISOString(),
    };
  }
}

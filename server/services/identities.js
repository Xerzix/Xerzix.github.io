// "Who's watching?" — the identities used on this browser.
//
// An identity is a full Lumina account: its own unique username, password, sessions and data.
// A browser (a "device", recognised by an HttpOnly cookie holding a random token whose SHA-256
// is stored) remembers at most five identities. Switching identity always establishes a new
// authenticated session for the chosen account; it requires that account's password unless the
// member chose "Keep me signed in on this device" when signing in there (30 days, cleared by
// signing out). Nothing here lets one identity read another's data: the roster exposes only
// what the opening screen shows (username, display name, picture).
import { config } from '../config.js';
import { now } from '../db/index.js';
import { conflict } from '../lib/errors.js';
import { newId, randomToken, sha256 } from '../lib/crypto.js';
import { AVATAR_IDS, IDENTITY_AVATAR_IDS } from '../../js/core/avatar-ids.js';

export const MAX_IDENTITIES = 5;
export const DEVICE_COOKIE = 'lumina_device';
export const REMEMBER_DAYS = 30;
const DEVICE_COOKIE_DAYS = 400;

// 3–24 characters: letters, digits, dot, underscore, hyphen; starting and ending with a letter or digit.
export const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9._-]{1,22})[a-z0-9]$/i;
const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'help', 'lumina', 'velvia', 'staff', 'moderator', 'guest', 'null', 'undefined', 'me', 'you', 'account', 'accounts', 'profile', 'profiles', 'settings', 'api']);

export { AVATAR_IDS, IDENTITY_AVATAR_IDS };

export function usernameProblem(name) {
  if (typeof name !== 'string' || !name.trim()) return 'Choose a username.';
  const n = name.trim();
  if (n.length < 3 || n.length > 24) return 'Use 3–24 characters.';
  if (!USERNAME_PATTERN.test(n)) return 'Use letters, numbers, dots, hyphens and underscores, starting and ending with a letter or number.';
  if (/[._-]{2}/.test(n)) return 'Avoid two symbols in a row.';
  if (RESERVED.has(n.toLowerCase())) return 'That username is reserved. Choose another.';
  return null;
}

export const usernameTaken = () => conflict('That username is already taken. Choose another.', 'USERNAME_TAKEN', { fields: { username: 'That username is already taken.' } });

export function identityLimitMessage() {
  return `This device already shows ${MAX_IDENTITIES} identities on “Who’s watching?”, the maximum. Remove one from this device (Manage identities) to add another. Removing an identity only takes it off this screen; the account and its data are kept.`;
}
export const identityLimitError = () => conflict(identityLimitMessage(), 'IDENTITY_LIMIT', { max: MAX_IDENTITIES });

/** Turns free text into a username candidate ("Hana Sato" → "hana.sato"). */
export function usernameBase(text) {
  const base = String(text || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '.')
    .replace(/[._-]{2,}/g, '.')
    .replace(/^[._-]+|[._-]+$/g, '')
    .slice(0, 20)
    .replace(/[._-]+$/, '');
  return base.length >= 3 && !RESERVED.has(base) ? base : `member${base ? `.${base}` : ''}`.slice(0, 20).replace(/[._-]+$/, '');
}

/** A free username derived from `text` (adds -2, -3 … when taken). */
export function uniqueUsername(db, text) {
  const base = usernameBase(text);
  for (let i = 1; i < 10_000; i++) {
    const candidate = i === 1 ? base : `${base.slice(0, 24 - String(i).length - 1)}-${i}`;
    if (!db.get('SELECT 1 FROM accounts WHERE username = ? COLLATE NOCASE', candidate)) return candidate;
  }
  return `member-${randomToken(4).toLowerCase().replace(/[^a-z0-9]/g, '')}`;
}

/** Gives every account created before usernames existed a unique one (runs at startup). */
export function backfillUsernames(db) {
  const rows = db.all('SELECT id, email, display_name FROM accounts WHERE username IS NULL ORDER BY created_at');
  for (const r of rows) {
    const name = uniqueUsername(db, r.email?.split('@')[0] || r.display_name);
    db.run('UPDATE accounts SET username = ? WHERE id = ? AND username IS NULL', name, r.id);
  }
  db.run(`UPDATE accounts SET avatar = COALESCE((SELECT avatar FROM profiles p WHERE p.account_id = accounts.id ORDER BY created_at LIMIT 1), 'crimson-sakura') WHERE avatar IS NULL`);
  return rows.length;
}

const deviceCookieOpts = (maxAge) => ({ httpOnly: true, sameSite: 'Lax', secure: config.session.secureCookie, path: '/', maxAge });

export class IdentityService {
  constructor(db) {
    this.db = db;
  }

  /** This browser's device row (touched), or null. With `create`, makes one and sets the cookie. */
  device(ctx, { create = false } = {}) {
    const token = ctx.cookies?.[DEVICE_COOKIE];
    if (token && typeof token === 'string' && token.length <= 200) {
      const row = this.db.get('SELECT * FROM devices WHERE token_hash = ?', sha256(token));
      if (row) {
        if (Date.now() - Date.parse(row.last_seen_at) > 3600_000) this.db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now(), row.id);
        return row;
      }
    }
    if (!create) return null;
    const fresh = randomToken(32);
    const ts = now();
    const id = newId('dev');
    this.db.run('INSERT INTO devices (id, token_hash, user_agent, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)', id, sha256(fresh), String(ctx.header('user-agent') || '').slice(0, 300), ts, ts);
    ctx.setCookie(DEVICE_COOKIE, fresh, deviceCookieOpts(DEVICE_COOKIE_DAYS * 86_400));
    return this.db.get('SELECT * FROM devices WHERE id = ?', id);
  }

  entries(deviceId) {
    return this.db.all(
      `SELECT di.*, a.username, a.display_name, a.avatar, a.status
         FROM device_identities di JOIN accounts a ON a.id = di.account_id
        WHERE di.device_id = ? ORDER BY di.slot`,
      deviceId,
    );
  }

  entry(deviceId, accountId) {
    return this.db.get('SELECT * FROM device_identities WHERE device_id = ? AND account_id = ?', deviceId, accountId);
  }

  /** What "Who's watching?" may show about each identity on this device — nothing private. */
  list(ctx) {
    const device = this.device(ctx);
    const active = ctx.account?.id || null;
    const items = device ? this.entries(device.id).map((e) => ({
      id: e.account_id,
      slot: e.slot,
      username: e.username,
      displayName: e.display_name,
      avatar: e.avatar,
      active: e.account_id === active,
      remembered: !!(e.remember_until && e.remember_until > now()),
      suspended: e.status === 'suspended',
    })) : [];
    return { max: MAX_IDENTITIES, identities: items, freeSlots: MAX_IDENTITIES - items.length };
  }

  /** Throws IDENTITY_LIMIT when this device has five identities and `accountId` is not one of them. */
  assertRoom(ctx, accountId = null) {
    const device = this.device(ctx);
    if (!device) return;
    if (accountId && this.entry(device.id, accountId)) return;
    const n = this.db.get('SELECT COUNT(*) AS n FROM device_identities WHERE device_id = ?', device.id).n;
    if (n >= MAX_IDENTITIES) throw identityLimitError();
  }

  /** Adds (or refreshes) the identity on this device; `remember` keeps it signed in for 30 days. */
  add(ctx, accountId, { remember = false } = {}) {
    const device = this.device(ctx, { create: true });
    const ts = now();
    const until = remember ? new Date(Date.now() + REMEMBER_DAYS * 86_400_000).toISOString() : null;
    const existing = this.entry(device.id, accountId);
    if (existing) {
      this.db.run('UPDATE device_identities SET last_used_at = ?, remember_until = ? WHERE device_id = ? AND account_id = ?', ts, until, device.id, accountId);
      return existing.slot;
    }
    const used = new Set(this.db.all('SELECT slot FROM device_identities WHERE device_id = ?', device.id).map((r) => r.slot));
    const slot = [0, 1, 2, 3, 4].find((s) => !used.has(s));
    if (slot === undefined) throw identityLimitError();
    try {
      this.db.run('INSERT INTO device_identities (device_id, account_id, slot, remember_until, added_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?)', device.id, accountId, slot, until, ts, ts);
    } catch (err) {
      // A parallel sign-in took the last slot: the database refuses a sixth.
      if (/UNIQUE|CHECK/.test(err.message)) throw identityLimitError();
      throw err;
    }
    return slot;
  }

  /** Signing out on this device: the identity stays listed but needs its password again. */
  forget(ctx, accountId) {
    const device = this.device(ctx);
    if (device) this.db.run('UPDATE device_identities SET remember_until = NULL WHERE device_id = ? AND account_id = ?', device.id, accountId);
  }

  remove(ctx, accountId) {
    const device = this.device(ctx);
    if (!device) return false;
    return this.db.run('DELETE FROM device_identities WHERE device_id = ? AND account_id = ?', device.id, accountId).changes > 0;
  }

  isRemembered(entry) {
    return !!(entry?.remember_until && entry.remember_until > now());
  }

  /** Avatars already used by other identities on this device (each identity keeps its own). */
  avatarsInUse(ctx, exceptAccountId = null) {
    const device = this.device(ctx);
    if (!device) return new Set();
    return new Set(this.entries(device.id).filter((e) => e.account_id !== exceptAccountId).map((e) => e.avatar).filter(Boolean));
  }

  /** First of the five Lumina identity pictures not used on this device. */
  defaultAvatar(ctx) {
    const used = this.avatarsInUse(ctx);
    return IDENTITY_AVATAR_IDS.find((a) => !used.has(a)) || IDENTITY_AVATAR_IDS[0];
  }
}

// Session cookies, per-request session loading and the authorization guards used by routes.
import { config } from '../config.js';
import { now } from '../db/index.js';
import { forbidden, HttpError, unauthorized } from '../lib/errors.js';
import { newId, randomToken, sha256 } from '../lib/crypto.js';

const TOUCH_INTERVAL_MS = 5 * 60_000;

function cookieOpts(maxAgeS) {
  return { httpOnly: true, sameSite: 'Lax', secure: config.session.secureCookie, path: '/', maxAge: maxAgeS };
}

/** Creates a session row and sets the cookie. Returns the session id. */
export function createSession(db, ctx, accountId, { profileId = null } = {}) {
  const token = randomToken(32);
  const id = newId('ses');
  const ts = now();
  const expires = new Date(Date.now() + config.session.ttlDays * 86_400_000).toISOString();
  db.run(
    `INSERT INTO sessions (id, account_id, token_hash, profile_id, created_at, last_seen_at, expires_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, accountId, sha256(token), profileId, ts, ts, expires, String(ctx.header('user-agent') || '').slice(0, 300), ctx.ip,
  );
  ctx.setCookie(config.session.cookieName, token, cookieOpts(config.session.ttlDays * 86_400));
  return id;
}

export function destroySession(db, ctx) {
  if (ctx.session) db.run('DELETE FROM sessions WHERE id = ?', ctx.session.id);
  ctx.clearCookie(config.session.cookieName, cookieOpts(0));
  ctx.session = ctx.account = ctx.profile = null;
}

/** Global middleware: resolves the session cookie into ctx.session / ctx.account / ctx.profile. */
export function sessionMiddleware(db) {
  return (ctx) => {
    if (!ctx.path.startsWith('/api/') && !ctx.path.startsWith('/media/private/')) return;
    const token = ctx.cookies[config.session.cookieName];
    if (!token) return;
    const row = db.get(
      `SELECT s.id AS s_id, s.profile_id, s.expires_at, s.last_seen_at, s.elevated_until, s.created_at AS s_created,
              a.*
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = ?`,
      sha256(token),
    );
    const ts = now();
    if (!row || row.expires_at <= ts) {
      if (row) db.run('DELETE FROM sessions WHERE id = ?', row.s_id);
      ctx.clearCookie(config.session.cookieName, cookieOpts(0));
      return;
    }
    if (row.status === 'suspended' && (!row.suspended_until || row.suspended_until > ts)) {
      // Suspended accounts keep no usable session.
      db.run('DELETE FROM sessions WHERE id = ?', row.s_id);
      ctx.clearCookie(config.session.cookieName, cookieOpts(0));
      return;
    }
    const { s_id, profile_id, expires_at, last_seen_at, elevated_until, s_created, ...account } = row;
    ctx.session = { id: s_id, profileId: profile_id, expiresAt: expires_at, elevatedUntil: elevated_until, createdAt: s_created };
    ctx.account = account;
    if (profile_id) {
      ctx.profile = db.get('SELECT * FROM profiles WHERE id = ? AND account_id = ?', profile_id, account.id) || null;
    }
    if (Date.now() - Date.parse(last_seen_at) > TOUCH_INTERVAL_MS) {
      // Sliding expiry: extend on activity.
      const expires = new Date(Date.now() + config.session.ttlDays * 86_400_000).toISOString();
      db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ?, ip = ? WHERE id = ?', ts, expires, ctx.ip, s_id);
    }
  };
}

// ───────────── Guards (use as route handlers before the main handler) ─────────────

export function requireAuth(ctx) {
  if (!ctx.account) throw unauthorized();
}

/** Requires a signed-in account with an active profile selected. */
export function requireProfile(ctx) {
  requireAuth(ctx);
  if (!ctx.profile) throw new HttpError(409, 'PROFILE_REQUIRED', 'Choose a profile to continue.');
}

const ROLE_RANK = { member: 0, moderator: 1, admin: 2 };

export function requireRole(role) {
  return (ctx) => {
    requireAuth(ctx);
    if ((ROLE_RANK[ctx.account.role] ?? -1) < ROLE_RANK[role]) throw forbidden();
  };
}

export function requireCreator(ctx) {
  requireAuth(ctx);
  if (!ctx.account.is_creator) throw forbidden('Creator access is required. Apply on the Creators page.', 'CREATOR_REQUIRED');
}

/** Requires a recent password (and TOTP when enabled) re-entry — "sudo mode". */
export function requireElevated(ctx) {
  requireAuth(ctx);
  if (!ctx.session.elevatedUntil || ctx.session.elevatedUntil <= now()) {
    throw new HttpError(403, 'REAUTH_REQUIRED', 'Please confirm your password to continue.');
  }
  if (config.auth.adminRequire2fa && ROLE_RANK[ctx.account.role] > 0 && !ctx.account.totp_enabled) {
    throw new HttpError(403, 'TOTP_SETUP_REQUIRED', 'Two-factor authentication must be enabled for staff accounts.');
  }
}

/** Admin area: staff role + recent re-authentication. */
export const requireStaff = [requireRole('moderator'), requireElevated];
export const requireAdmin = [requireRole('admin'), requireElevated];

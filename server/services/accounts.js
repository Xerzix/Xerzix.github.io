// Accounts: registration, sign-in bookkeeping, password resets, sessions, personal-data
// export and deletion. Routes (server/routes/auth.js, account.js) handle HTTP concerns;
// this module owns the SQL. Secrets never leave this file except as hashes compared here.
import { config } from '../config.js';
import { now, parseJson } from '../db/index.js';
import { HttpError } from '../lib/errors.js';
import { decryptField, newId, randomToken, safeEqual, sha256, totp, verifyPassword } from '../lib/crypto.js';
import { log } from '../lib/log.js';
import { readPlatformSettings } from './admin/settings.js';
import { accountDto, profileDto } from './dto.js';
import { planSummary } from './entitlements.js';
import { notificationPrefs } from './notifications.js';

export const normalizeEmail = (email) => String(email || '').trim().toLowerCase();

const minutesFromNow = (m) => new Date(Date.now() + m * 60_000).toISOString();

/** True while the session is in "sudo mode" (recent password and TOTP re-entry). */
export function isElevated(ctx) {
  return !!(ctx.session?.elevatedUntil && ctx.session.elevatedUntil > now());
}

/** Verifies the signed-in account's password (constant time); 403 INVALID_PASSWORD on mismatch. */
export async function assertAccountPassword(account, password, field = 'password') {
  const ok = typeof password === 'string' && password.length > 0 && (await verifyPassword(password, account.password_hash));
  if (!ok) throw new HttpError(403, 'INVALID_PASSWORD', 'That password is not correct.', { fields: { [field]: 'That password is not correct.' } });
}

const TOTP_STEP_MS = 30_000;

/** The 30-second time step `code` belongs to (±1 step of clock drift), or null when it matches none. */
function totpStep(account, code) {
  if (!account.totp_secret) return null;
  const clean = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  let secret;
  try {
    secret = decryptField(account.totp_secret);
  } catch (err) {
    log.error('totp secret could not be decrypted', { account: account.id, err });
    return null;
  }
  const at = Date.now();
  for (let w = -1; w <= 1; w++) {
    const t = at + w * TOTP_STEP_MS;
    if (safeEqual(totp(secret, t), clean)) return Math.floor(t / TOTP_STEP_MS);
  }
  return null;
}

/**
 * Checks a TOTP code and records it as used, so the same code can never be accepted twice
 * (RFC 6238 §5.2). Returns 'ok', 'reused' (valid but already accepted once) or 'invalid'.
 * The conditional UPDATE is atomic, so two parallel requests with one code cannot both pass.
 */
export function consumeTotp(db, account, code) {
  const step = totpStep(account, code);
  if (step === null) return 'invalid';
  const accepted = db.run(
    'UPDATE accounts SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)',
    step, account.id, step,
  ).changes;
  return accepted ? 'ok' : 'reused';
}

/** The INVALID_TOTP error for a consumeTotp() result other than 'ok'. */
export function totpError(result, status, field) {
  const message = result === 'reused'
    ? 'That code has already been used. Wait for the next code from your authenticator app.'
    : 'That code did not match. Check your authenticator app and try again.';
  return new HttpError(status, 'INVALID_TOTP', message, { reused: result === 'reused', fields: { [field]: result === 'reused' ? 'That code was already used. Wait for the next one.' : 'That code did not match.' } });
}

/**
 * For re-authentication inside a signed-in session: requires a TOTP when 2FA is on.
 * (Sign-in itself uses 401 per the API; here the caller is authenticated, so 403.)
 */
export function assertTotp(db, account, code, field = 'totp') {
  if (!account.totp_enabled) return;
  if (!code) throw new HttpError(403, 'TOTP_REQUIRED', 'Enter the 6-digit code from your authenticator app.', { fields: { [field]: 'Enter the 6-digit code.' } });
  const result = consumeTotp(db, account, code);
  if (result !== 'ok') throw totpError(result, 403, field);
}

/**
 * The bootstrap payload. Kept identical to GET /api/session (server/routes/session.js) so
 * register and login can hand the client everything it needs in one response.
 */
export function sessionPayload(db, ctx) {
  const profileCount = ctx.account ? db.get('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', ctx.account.id).n : 0;
  const platform = readPlatformSettings(db);
  return {
    mode: 'server',
    account: accountDto(ctx.account),
    profile: profileDto(ctx.profile),
    profileCount,
    elevated: isElevated(ctx),
    plan: ctx.account ? planSummary(ctx.account) : null,
    features: {
      registration: platform.registrationOpen,
      reviewComments: config.features.communityComments,
      watchParties: platform.watchPartiesEnabled,
      sharedCollections: config.features.sharedCollections,
      requireSigninToPlay: config.features.requireSigninToPlay,
      velviaProvider: config.velvia.provider,
    },
    limits: { maxProfiles: ctx.account?.max_profiles ?? config.profiles.maxPerAccount },
    notice: platform.maintenanceMessage ? { message: platform.maintenanceMessage } : null,
  };
}

export class AccountService {
  constructor(db) {
    this.db = db;
  }

  byId(id) {
    return this.db.get('SELECT * FROM accounts WHERE id = ?', id);
  }

  byEmail(email) {
    return this.db.get('SELECT * FROM accounts WHERE email = ? COLLATE NOCASE', normalizeEmail(email));
  }

  /** Creates the account and its first profile. `passwordHash` is computed by the caller. */
  byUsername(username) {
    return this.db.get('SELECT * FROM accounts WHERE username = ? COLLATE NOCASE', String(username || '').trim());
  }

  /** By username, or by email when the identifier contains "@". */
  byIdentifier(identifier) {
    const id = String(identifier || '').trim();
    return id.includes('@') ? this.byEmail(id) : this.byUsername(id);
  }

  create({ email, passwordHash, displayName, username = null, avatar = 'crimson-sakura' }) {
    const ts = now();
    const accountId = newId('acc');
    const profileId = newId('prf');
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO accounts (id, username, email, display_name, password_hash, avatar, max_profiles, terms_accepted_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        accountId, username, normalizeEmail(email), displayName, passwordHash, avatar, Math.min(5, Math.max(1, config.profiles.maxPerAccount)), ts, ts, ts,
      );
      this.db.run(
        'INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        profileId, accountId, displayName, avatar, ts, ts,
      );
    });
    return { account: this.byId(accountId), profile: this.db.get('SELECT * FROM profiles WHERE id = ?', profileId) };
  }

  /**
   * Records a failed sign-in; locks the account once the limit is reached. Returns the lock
   * expiry or null. The count is incremented in the database in one statement (never from the
   * row read before the slow password check), so parallel wrong guesses all count.
   */
  recordFailedLogin(account) {
    const max = config.auth.maxFailedLogins;
    const until = minutesFromNow(config.auth.lockMinutes);
    // SQLite evaluates every SET expression against the old row, so both CASEs see the same count.
    const row = this.db.get(
      `UPDATE accounts
          SET failed_logins = CASE WHEN failed_logins + 1 >= ? THEN 0 ELSE failed_logins + 1 END,
              locked_until  = CASE WHEN failed_logins + 1 >= ? THEN ? ELSE locked_until END,
              updated_at = ?
        WHERE id = ?
        RETURNING locked_until`,
      max, max, until, now(), account.id,
    );
    return row?.locked_until === until ? until : null;
  }

  /** The lock expiry when the account is locked right now (read fresh, not from a cached row). */
  lockedUntil(accountId) {
    const row = this.db.get('SELECT locked_until FROM accounts WHERE id = ?', accountId);
    return row?.locked_until && row.locked_until > now() ? row.locked_until : null;
  }

  recordSuccessfulLogin(accountId) {
    const ts = now();
    this.db.run('UPDATE accounts SET failed_logins = 0, locked_until = NULL, last_login_at = ?, updated_at = ? WHERE id = ?', ts, ts, accountId);
  }

  /** The profile to preselect at sign-in: only when there is exactly one and it has no PIN. */
  autoProfile(accountId) {
    const rows = this.db.all('SELECT id, pin_hash FROM profiles WHERE account_id = ? LIMIT 2', accountId);
    return rows.length === 1 && !rows[0].pin_hash ? rows[0].id : null;
  }

  // ── Password resets ──
  /** Issues a reset token (only its SHA-256 is stored) and invalidates older unused ones. */
  createPasswordReset(accountId, ip) {
    const token = randomToken(32);
    const ts = now();
    this.db.tx(() => {
      this.db.run('UPDATE password_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL', ts, accountId);
      this.db.run(
        'INSERT INTO password_resets (id, account_id, token_hash, created_at, expires_at, ip) VALUES (?, ?, ?, ?, ?, ?)',
        newId('pwr'), accountId, sha256(token), ts, minutesFromNow(config.auth.resetTokenMinutes), ip || null,
      );
    });
    return token;
  }

  /** Returns the live reset row for a token, or undefined when unknown, used or expired. */
  findPasswordReset(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return undefined;
    return this.db.get('SELECT * FROM password_resets WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?', sha256(token), now());
  }

  /** Completes a reset: marks the token used, sets the password and ends every session. */
  completePasswordReset(reset, passwordHash) {
    const ts = now();
    return this.db.tx(() => {
      const used = this.db.run('UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL', ts, reset.id);
      if (!used.changes) return false;
      this.db.run('UPDATE password_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL', ts, reset.account_id);
      this.db.run('UPDATE accounts SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?', passwordHash, ts, reset.account_id);
      this.db.run('DELETE FROM sessions WHERE account_id = ?', reset.account_id);
      return true;
    });
  }

  /** Sets a new password and signs out every other session. */
  changePassword(accountId, passwordHash, keepSessionId) {
    const ts = now();
    return this.db.tx(() => {
      this.db.run('UPDATE accounts SET password_hash = ?, updated_at = ? WHERE id = ?', passwordHash, ts, accountId);
      this.db.run('UPDATE password_resets SET used_at = ? WHERE account_id = ? AND used_at IS NULL', ts, accountId);
      return this.db.run('DELETE FROM sessions WHERE account_id = ? AND id != ?', accountId, keepSessionId || '').changes;
    });
  }

  // ── Sessions ──
  sessions(accountId, currentId) {
    const rows = this.db.all(
      'SELECT id, user_agent, ip, created_at, last_seen_at FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_seen_at DESC',
      accountId, now(),
    );
    const items = rows.map((r) => ({ id: r.id, current: r.id === currentId, userAgent: r.user_agent || '', ip: r.ip || '', createdAt: r.created_at, lastSeenAt: r.last_seen_at }));
    return items.sort((a, b) => Number(b.current) - Number(a.current));
  }

  revokeSession(accountId, sessionId) {
    return this.db.run('DELETE FROM sessions WHERE id = ? AND account_id = ?', sessionId, accountId).changes > 0;
  }

  revokeOtherSessions(accountId, keepSessionId) {
    return this.db.run('DELETE FROM sessions WHERE account_id = ? AND id != ?', accountId, keepSessionId || '').changes;
  }

  elevate(sessionId, minutes = config.session.elevatedMinutes) {
    const until = minutesFromNow(minutes);
    this.db.run('UPDATE sessions SET elevated_until = ? WHERE id = ?', until, sessionId);
    return until;
  }

  // ── Deletion ──
  /** True when this account is the only active administrator (deleting it would orphan the platform). */
  isLastActiveAdmin(account) {
    if (account.role !== 'admin') return false;
    const others = this.db.get("SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND status = 'active' AND id != ?", account.id).n;
    return others === 0;
  }

  /** Deletes the account row; foreign keys cascade to profiles, library, reviews, sessions … */
  remove(accountId) {
    return this.db.run('DELETE FROM accounts WHERE id = ?', accountId).changes > 0;
  }

  // ── Export ──
  /** Everything Lumina stores about the account, without credentials or internal moderation fields. */
  exportData(account, currentSessionId) {
    const db = this.db;
    const rows = (sql, ...params) => {
      try {
        return db.all(sql, ...params);
      } catch (err) {
        if (/no such (table|column)/.test(err.message)) return [];
        throw err;
      }
    };
    const id = account.id;
    const profileIds = 'SELECT id FROM profiles WHERE account_id = ?';
    const collections = rows(
      `SELECT id, profile_id AS profileId, name, description, visibility, created_at AS createdAt, updated_at AS updatedAt
         FROM collections WHERE profile_id IN (${profileIds}) ORDER BY created_at`, id,
    );
    const items = rows(
      `SELECT collection_id AS collectionId, title_id AS titleId, position, note, added_at AS addedAt
         FROM collection_items WHERE collection_id IN (SELECT id FROM collections WHERE profile_id IN (${profileIds})) ORDER BY position`, id,
    );
    const submissions = rows(
      `SELECT id, project_title AS projectTitle, description, content_type AS contentType, runtime_min AS runtimeMin, genres, language,
              release_year AS releaseYear, country, trailer_url AS trailerUrl, additional_info AS additionalInfo, rights,
              attested_at AS attestedAt, status, status_reason AS statusReason, title_id AS titleId,
              created_at AS createdAt, updated_at AS updatedAt, submitted_at AS submittedAt
         FROM submissions WHERE account_id = ? ORDER BY created_at`, id,
    ).map((s) => ({ ...s, genres: parseJson(s.genres, []), rights: parseJson(s.rights, {}) }));
    const files = rows(
      `SELECT id, submission_id AS submissionId, role, label, original_name AS originalName, mime, size_bytes AS sizeBytes,
              sha256, scan_status AS scanStatus, created_at AS createdAt
         FROM submission_files WHERE submission_id IN (SELECT id FROM submissions WHERE account_id = ?)`, id,
    );
    return {
      format: 'lumina-personal-data/1',
      exportedAt: now(),
      notice: 'This file contains the personal data Lumina stores for your account. Passwords, PINs and two-factor secrets are stored only as one-way hashes or encrypted values and are never exported.',
      account: {
        ...accountDto(account),
        termsAcceptedAt: account.terms_accepted_at,
        lastLoginAt: account.last_login_at,
        notificationPreferences: notificationPrefs(account.settings),
      },
      plan: planSummary(account),
      sessions: this.sessions(id, currentSessionId).map(({ id: _id, ...s }) => s),
      profiles: rows('SELECT * FROM profiles WHERE account_id = ? ORDER BY created_at', id).map(profileDto),
      watchlist: rows(`SELECT profile_id AS profileId, title_id AS titleId, added_at AS addedAt, sort_order AS sortOrder FROM watchlist WHERE profile_id IN (${profileIds}) ORDER BY profile_id, sort_order`, id),
      progress: rows(
        `SELECT profile_id AS profileId, title_id AS titleId, NULLIF(episode_id, '') AS episodeId, position_s AS positionS, duration_s AS durationS,
                completed, updated_at AS updatedAt FROM progress WHERE profile_id IN (${profileIds}) ORDER BY updated_at DESC`, id,
      ).map((p) => ({ ...p, completed: !!p.completed })),
      history: rows(
        `SELECT profile_id AS profileId, title_id AS titleId, NULLIF(episode_id, '') AS episodeId, watched_at AS watchedAt, seconds
           FROM history WHERE profile_id IN (${profileIds}) ORDER BY watched_at DESC`, id,
      ),
      collections: collections.map((c) => ({ ...c, items: items.filter((i) => i.collectionId === c.id).map(({ collectionId, ...i }) => i) })),
      follows: rows(`SELECT profile_id AS profileId, target_type AS type, target_id AS targetId, created_at AS createdAt FROM follows WHERE profile_id IN (${profileIds})`, id),
      reviews: rows(
        `SELECT id, title_id AS titleId, profile_id AS profileId, rating, body, contains_spoilers AS containsSpoilers, status,
                helpful_count AS helpfulCount, created_at AS createdAt, updated_at AS updatedAt
           FROM reviews WHERE account_id = ? ORDER BY created_at`, id,
      ).map((r) => ({ ...r, containsSpoilers: !!r.containsSpoilers })),
      reviewComments: rows(
        `SELECT id, review_id AS reviewId, profile_id AS profileId, body, status, created_at AS createdAt, updated_at AS updatedAt
           FROM review_comments WHERE account_id = ? ORDER BY created_at`, id,
      ),
      helpfulVotes: rows('SELECT review_id AS reviewId, created_at AS createdAt FROM review_votes WHERE account_id = ?', id),
      reportsFiled: rows(
        `SELECT id, target_type AS targetType, target_id AS targetId, reason, details, status, created_at AS createdAt
           FROM reports WHERE reporter_account_id = ? ORDER BY created_at`, id,
      ),
      blockedAuthors: rows('SELECT created_at AS createdAt FROM blocks WHERE account_id = ?', id).length,
      notifications: rows(
        'SELECT id, type, title, body, link, created_at AS createdAt, read_at AS readAt FROM notifications WHERE account_id = ? ORDER BY created_at DESC', id,
      ),
      qualityReports: rows(
        `SELECT id, title_id AS titleId, episode_id AS episodeId, category, description, device, connection_mbps AS connectionMbps,
                selected_resolution AS selectedResolution, status, created_at AS createdAt
           FROM quality_reports WHERE account_id = ? ORDER BY created_at`, id,
      ),
      creatorApplications: rows(
        `SELECT id, legal_name AS legalName, contact_email AS contactEmail, company, website, portfolio, country, bio, status,
                reviewer_note AS reviewerNote, reviewed_at AS reviewedAt, created_at AS createdAt, updated_at AS updatedAt
           FROM creator_applications WHERE account_id = ? ORDER BY created_at`, id,
      ),
      submissions: submissions.map((s) => ({ ...s, files: files.filter((f) => f.submissionId === s.id).map(({ submissionId, ...f }) => f) })),
    };
  }
}

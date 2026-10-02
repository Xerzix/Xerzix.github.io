// Account administration: search, detail, role/status changes and session revocation.
// Rules: only admins change roles; nobody changes their own role or status; the last active
// administrator can be neither demoted nor suspended; moderators may suspend members only.
import { now, parseJson } from '../../db/index.js';
import { conflict, forbidden, notFound, validation } from '../../lib/errors.js';
import { v } from '../../lib/validate.js';
import { accountDto } from '../dto.js';
import { likeTerm, paging } from './common.js';
import { auditDto } from './moderation.js';

export const userPatchSchema = v.object({
  role: v.enum(['member', 'moderator', 'admin']).optional(),
  status: v.enum(['active', 'suspended']).optional(),
  suspendedReason: v.string().max(500).nullable().optional(),
  suspendedUntil: v.string().max(40).check((s) => !Number.isNaN(Date.parse(s)), 'Enter a valid date.').nullable().optional(),
  maxProfiles: v.int().min(1).max(5).optional(),
  isCreator: v.boolean().optional(),
});

export function adminAccountDto(a) {
  return {
    ...accountDto(a),
    suspendedReason: a.suspended_reason,
    suspendedUntil: a.suspended_until,
    lastLoginAt: a.last_login_at,
    updatedAt: a.updated_at,
    lockedUntil: a.locked_until,
  };
}

export function listUsers(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 25 });
  const where = [];
  const args = [];
  if (query.q) {
    const term = likeTerm(query.q);
    where.push(`(a.email LIKE ? ESCAPE '\\' OR a.display_name LIKE ? ESCAPE '\\' OR a.id = ?)`);
    args.push(term, term, String(query.q).trim());
  }
  if (['member', 'moderator', 'admin'].includes(query.role)) {
    where.push('a.role = ?');
    args.push(query.role);
  }
  if (query.role === 'staff') where.push(`a.role IN ('moderator', 'admin')`);
  if (['active', 'suspended'].includes(query.status)) {
    where.push('a.status = ?');
    args.push(query.status);
  }
  if (query.creator === '1') where.push('a.is_creator = 1');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM accounts a ${clause}`, ...args).n;
  const ts = now();
  const rows = db.all(
    `SELECT a.*,
            (SELECT COUNT(*) FROM profiles p WHERE p.account_id = a.id) AS profile_count,
            (SELECT COUNT(*) FROM sessions s WHERE s.account_id = a.id AND s.expires_at > ?) AS session_count
       FROM accounts a ${clause} ORDER BY a.created_at DESC LIMIT ? OFFSET ?`,
    ts, ...args, pageSize, offset,
  );
  const counts = {
    total: db.get('SELECT COUNT(*) AS n FROM accounts').n,
    staff: db.get(`SELECT COUNT(*) AS n FROM accounts WHERE role IN ('moderator', 'admin')`).n,
    suspended: db.get(`SELECT COUNT(*) AS n FROM accounts WHERE status = 'suspended'`).n,
    creators: db.get('SELECT COUNT(*) AS n FROM accounts WHERE is_creator = 1').n,
  };
  return {
    items: rows.map((r) => ({ ...adminAccountDto(r), profileCount: r.profile_count, activeSessions: r.session_count })),
    total,
    page,
    pageSize,
    counts,
  };
}

export function userDetail(db, id) {
  const a = db.get('SELECT * FROM accounts WHERE id = ?', id);
  if (!a) throw notFound('That account does not exist.');
  const ts = now();
  const profiles = db.all('SELECT id, name, avatar, is_kids, max_age, created_at FROM profiles WHERE account_id = ? ORDER BY created_at', id);
  const sessions = db.all('SELECT id, created_at, last_seen_at, expires_at, user_agent, ip, elevated_until FROM sessions WHERE account_id = ? AND expires_at > ? ORDER BY last_seen_at DESC', id, ts);
  const reviews = db.all(
    `SELECT r.id, r.title_id, t.title AS title_name, r.rating, r.body, r.status, r.created_at
       FROM reviews r LEFT JOIN titles t ON t.id = r.title_id WHERE r.account_id = ? ORDER BY r.created_at DESC LIMIT 20`, id,
  );
  const reviewCounts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM reviews WHERE account_id = ? GROUP BY status', id).map((r) => [r.status, r.n]));
  const submissions = db.all('SELECT id, project_title, content_type, status, updated_at FROM submissions WHERE account_id = ? ORDER BY updated_at DESC LIMIT 20', id);
  const application = db.get('SELECT id, status, legal_name, created_at, reviewed_at, reviewer_note FROM creator_applications WHERE account_id = ? ORDER BY created_at DESC LIMIT 1', id);
  const reportsAgainst = db.get(
    `SELECT COUNT(*) AS n FROM reports x
      WHERE (x.target_type = 'review' AND x.target_id IN (SELECT id FROM reviews WHERE account_id = ?))
         OR (x.target_type = 'comment' AND x.target_id IN (SELECT id FROM review_comments WHERE account_id = ?))`, id, id,
  ).n;
  const history = db.all(`SELECT * FROM audit_log WHERE target_type = 'account' AND target_id = ? ORDER BY id DESC LIMIT 20`, id);
  return {
    account: adminAccountDto(a),
    profiles: profiles.map((p) => ({ id: p.id, name: p.name, avatar: p.avatar, isKids: !!p.is_kids, maxAge: p.max_age, createdAt: p.created_at })),
    sessions: sessions.map((s) => ({ id: s.id, createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at, userAgent: s.user_agent, ip: s.ip, elevated: !!(s.elevated_until && s.elevated_until > ts) })),
    reviews: reviews.map((r) => ({ id: r.id, titleId: r.title_id, titleName: r.title_name, rating: r.rating, body: r.body, status: r.status, createdAt: r.created_at })),
    reviewCounts,
    submissions: submissions.map((s) => ({ id: s.id, projectTitle: s.project_title, contentType: s.content_type, status: s.status, updatedAt: s.updated_at })),
    creatorApplication: application ? { id: application.id, status: application.status, legalName: application.legal_name, createdAt: application.created_at, reviewedAt: application.reviewed_at, reviewerNote: application.reviewer_note } : null,
    reportsAgainst,
    notificationPrefs: parseJson(a.settings, {}).notifications || null,
    history: history.map(auditDto),
  };
}

function activeAdmins(db) {
  return db.get(`SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND status = 'active'`).n;
}

/**
 * Applies a PATCH from `actor` to account `id`. Returns { before, after, changes, sessionsRevoked }.
 * `changes` lists changed fields so the route can audit exactly what happened.
 */
export function updateUser(db, actor, id, patch) {
  const target = db.get('SELECT * FROM accounts WHERE id = ?', id);
  if (!target) throw notFound('That account does not exist.');
  const isAdmin = actor.role === 'admin';
  const self = target.id === actor.id;

  if (!isAdmin) {
    const disallowed = ['role', 'maxProfiles', 'isCreator'].filter((k) => patch[k] !== undefined);
    if (disallowed.length) throw forbidden('Only administrators can change roles, profile limits or creator access.', 'ADMIN_REQUIRED');
    if (target.role !== 'member') throw forbidden('Moderators can manage member accounts only.', 'INSUFFICIENT_ROLE');
  }
  if (self && (patch.role !== undefined && patch.role !== target.role)) throw forbidden('You cannot change your own role.', 'SELF_ACTION');
  if (self && patch.status !== undefined && patch.status !== target.status) throw forbidden('You cannot suspend or reinstate your own account.', 'SELF_ACTION');

  const demoting = patch.role !== undefined && target.role === 'admin' && patch.role !== 'admin';
  const suspending = patch.status === 'suspended' && target.status !== 'suspended';
  if ((demoting || (suspending && target.role === 'admin')) && target.status === 'active' && activeAdmins(db) <= 1) {
    throw conflict('This is the last active administrator. Promote another administrator first.', 'LAST_ADMIN');
  }
  if (patch.maxProfiles !== undefined) {
    const n = db.get('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', id).n;
    if (patch.maxProfiles < n) throw validation({ maxProfiles: `This account already has ${n} profiles. Delete profiles first or choose ${n} or more.` });
  }
  if (patch.suspendedUntil && Date.parse(patch.suspendedUntil) <= Date.now()) throw validation({ suspendedUntil: 'Choose a date in the future, or leave it empty for an indefinite suspension.' });

  const cols = {};
  const changes = {};
  const set = (col, key, value) => {
    if (value === undefined) return;
    if (target[col] === value) return;
    cols[col] = value;
    changes[key] = { from: target[col], to: value };
  };
  set('role', 'role', patch.role);
  set('status', 'status', patch.status);
  const nextStatus = patch.status ?? target.status;
  if (nextStatus === 'suspended') {
    set('suspended_reason', 'suspendedReason', patch.suspendedReason === undefined ? undefined : patch.suspendedReason);
    set('suspended_until', 'suspendedUntil', patch.suspendedUntil === undefined ? undefined : (patch.suspendedUntil ? new Date(patch.suspendedUntil).toISOString() : null));
  } else if (patch.status === 'active') {
    set('suspended_reason', 'suspendedReason', null);
    set('suspended_until', 'suspendedUntil', null);
  }
  set('max_profiles', 'maxProfiles', patch.maxProfiles);
  if (patch.isCreator !== undefined) set('is_creator', 'isCreator', patch.isCreator ? 1 : 0);

  let sessionsRevoked = 0;
  if (Object.keys(cols).length) {
    cols.updated_at = now();
    const keys = Object.keys(cols);
    db.tx(() => {
      db.run(`UPDATE accounts SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, ...keys.map((k) => cols[k]), id);
      // Suspension signs the account out everywhere; a role change drops elevated sessions.
      if (suspending) sessionsRevoked = db.run('DELETE FROM sessions WHERE account_id = ?', id).changes;
      else if (changes.role) db.run('UPDATE sessions SET elevated_until = NULL WHERE account_id = ?', id);
    });
  }
  const after = db.get('SELECT * FROM accounts WHERE id = ?', id);
  return { before: target, after, changes, sessionsRevoked, suspending };
}

/** Deletes every session of an account (the caller's own current session is kept). */
export function revokeSessions(db, actor, id, currentSessionId) {
  const target = db.get('SELECT id, role FROM accounts WHERE id = ?', id);
  if (!target) throw notFound('That account does not exist.');
  if (actor.role !== 'admin' && target.role !== 'member' && target.id !== actor.id) throw forbidden('Moderators can manage member accounts only.', 'INSUFFICIENT_ROLE');
  return db.run('DELETE FROM sessions WHERE account_id = ? AND id != ?', id, currentSessionId || '').changes;
}

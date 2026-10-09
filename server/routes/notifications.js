// Notification centre API. The list merges the account's own notifications with active
// platform announcements (audience "all", or "creators" for creator accounts); announcement
// read/dismiss state lives in announcement_reads. Preferences cover optional types only.
import { requireAuth } from '../auth/session.js';
import { now, parseJson, placeholders, toJson } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_TYPES, notificationPrefs } from '../services/notifications.js';
import { isRestricted, parentalGuard } from '../services/profiles.js';

/** Preference keys users may switch off (types marked optional). */
export const OPTIONAL_PREFS = [...new Set(Object.values(NOTIFICATION_TYPES).filter((t) => t.optional && t.pref).map((t) => t.pref))];

const PAGE_SIZE = 20;
const prefsSchema = v.object(Object.fromEntries(OPTIONAL_PREFS.map((k) => [k, v.boolean().optional()])));

function optionalPrefs(settingsJson) {
  const all = notificationPrefs(settingsJson);
  return Object.fromEntries(OPTIONAL_PREFS.map((k) => [k, all[k] ?? DEFAULT_NOTIFICATION_PREFS[k] ?? true]));
}

function notificationDto(n) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    data: parseJson(n.data, {}),
    createdAt: n.created_at,
    readAt: n.read_at,
  };
}

// Account-level notices a kids or maturity-limited profile never sees (or clears).
const GROWN_UP_TYPES = ['account_security', 'moderation', 'creator_application', 'submission_update'];

/**
 * Which of the account's notifications the active profile may see and change. Grown-up
 * profiles manage the whole account's notices. A restricted (kids or maturity-limited)
 * profile sees only what was sent to that profile — release notices are already filtered by
 * its age limit when they are sent — plus replies to its own reviews, never account,
 * moderation or creator notices, and never another profile's releases.
 */
function scope(ctx, alias = '') {
  const col = (c) => `${alias}${c}`;
  if (!isRestricted(ctx.profile)) return { sql: `${col('account_id')} = ?`, args: [ctx.account.id] };
  return {
    sql: `${col('account_id')} = ? AND ${col('type')} NOT IN (${placeholders(GROWN_UP_TYPES.length)})
          AND (${col('profile_id')} = ? OR (${col('profile_id')} IS NULL AND ${col('type')} = 'review_reply'
               AND json_extract(${col('data')}, '$.reviewId') IN (SELECT id FROM reviews WHERE profile_id = ?)))`,
    args: [ctx.account.id, ...GROWN_UP_TYPES, ctx.profile.id, ctx.profile.id],
  };
}

export default function register(app, { db }) {
  /** Announcements visible to this account right now (respecting audience, dismissals and prefs). */
  function activeAnnouncements(account, profile = null) {
    if (optionalPrefs(account.settings).announcements === false) return [];
    const ts = now();
    const audiences = account.is_creator && !isRestricted(profile) ? ['all', 'creators'] : ['all'];
    return db.all(
      `SELECT n.*, r.read_at, r.dismissed_at
         FROM announcements n LEFT JOIN announcement_reads r ON r.announcement_id = n.id AND r.account_id = ?
        WHERE n.starts_at <= ? AND (n.ends_at IS NULL OR n.ends_at > ?) AND n.audience IN (${placeholders(audiences.length)})
          AND r.dismissed_at IS NULL
        ORDER BY n.starts_at DESC LIMIT 50`,
      account.id, ts, ts, ...audiences,
    );
  }

  const announcementDto = (a) => ({
    id: a.id,
    type: 'announcement',
    title: a.title,
    body: a.body,
    link: a.link,
    data: { audience: a.audience },
    createdAt: a.starts_at,
    readAt: a.read_at || null,
    announcement: true,
  });

  function unreadCount(ctx) {
    const where = scope(ctx);
    const own = db.get(`SELECT COUNT(*) AS n FROM notifications WHERE ${where.sql} AND read_at IS NULL`, ...where.args).n;
    return own + activeAnnouncements(ctx.account, ctx.profile).filter((a) => !a.read_at).length;
  }

  function markAnnouncement(accountId, announcementId, column) {
    db.run(
      `INSERT INTO announcement_reads (account_id, announcement_id, ${column}) VALUES (?, ?, ?)
       ON CONFLICT (account_id, announcement_id) DO UPDATE SET ${column} = COALESCE(announcement_reads.${column}, excluded.${column})`,
      accountId, announcementId, now(),
    );
  }

  // Newest first, ties broken by id, so (createdAt, id) is a stable cursor.
  const newestFirst = (a, b) => (a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1) : a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

  /**
   * ?beforeAt=<createdAt>&beforeId=<id> returns the page after that item (a cursor, so rows
   * marked read or deleted on earlier pages never shift unseen rows past the reader);
   * ?page=N is kept for simple clients. `remaining` counts what is left after this page.
   */
  app.get('/api/notifications', requireAuth, (ctx) => {
    const account = ctx.account;
    const unreadOnly = ctx.query.unread === '1' || ctx.query.filter === 'unread';
    const readClause = unreadOnly ? 'AND read_at IS NULL' : '';
    const where = scope(ctx);
    const beforeAt = typeof ctx.query.beforeAt === 'string' && ctx.query.beforeAt.length <= 40 ? ctx.query.beforeAt : null;
    const beforeId = beforeAt && typeof ctx.query.beforeId === 'string' ? ctx.query.beforeId.slice(0, 80) : '';
    const page = beforeAt ? 1 : Math.max(1, Math.min(50, Number.parseInt(ctx.query.page, 10) || 1));
    const cursorSql = beforeAt ? 'AND (created_at < ? OR (created_at = ? AND id < ?))' : '';
    const cursorArgs = beforeAt ? [beforeAt, beforeAt, beforeId] : [];
    const after = (n) => !beforeAt || n.createdAt < beforeAt || (n.createdAt === beforeAt && n.id < beforeId);

    const ownTotal = db.get(`SELECT COUNT(*) AS n FROM notifications WHERE ${where.sql} ${readClause}`, ...where.args).n;
    const ownLeft = beforeAt ? db.get(`SELECT COUNT(*) AS n FROM notifications WHERE ${where.sql} ${readClause} ${cursorSql}`, ...where.args, ...cursorArgs).n : ownTotal;
    // Merge the newest (page × size) of each source, then slice the requested page.
    const own = db.all(
      `SELECT * FROM notifications WHERE ${where.sql} ${readClause} ${cursorSql} ORDER BY created_at DESC, id DESC LIMIT ?`,
      ...where.args, ...cursorArgs, page * PAGE_SIZE,
    ).map(notificationDto);
    const announcements = activeAnnouncements(account, ctx.profile).filter((a) => !unreadOnly || !a.read_at).map(announcementDto);
    const annLeft = announcements.filter(after);
    const merged = [...annLeft, ...own].sort(newestFirst);
    const items = merged.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    const remaining = Math.max(0, ownLeft + annLeft.length - (page - 1) * PAGE_SIZE - items.length);
    return { items, unread: unreadCount(ctx), total: ownTotal + announcements.length, remaining, page, pageSize: PAGE_SIZE };
  });

  app.get('/api/notifications/unread-count', requireAuth, (ctx) => ({ unread: unreadCount(ctx) }));

  app.get('/api/notifications/preferences', requireAuth, (ctx) => optionalPrefs(ctx.account.settings));

  app.put('/api/notifications/preferences', requireAuth, async (ctx) => {
    const input = v.parse(prefsSchema, await ctx.body());
    // Account-wide settings: a kids or maturity-limited profile needs a grown-up's password.
    parentalGuard(db, ctx, { message: 'Notification settings belong to the whole account, so a grown-up needs to change them. Switch to a grown-up profile, or confirm the account password to continue.' });
    const row = db.get('SELECT settings FROM accounts WHERE id = ?', ctx.account.id);
    const settings = parseJson(row?.settings, {});
    const current = { ...(settings.notifications || {}) };
    for (const [k, val] of Object.entries(input)) if (val !== undefined) current[k] = val;
    settings.notifications = current;
    db.run('UPDATE accounts SET settings = ?, updated_at = ? WHERE id = ?', toJson(settings), now(), ctx.account.id);
    return optionalPrefs(toJson(settings));
  });

  app.post('/api/notifications/read-all', requireAuth, (ctx) => {
    const ts = now();
    const where = scope(ctx);
    db.tx(() => {
      db.run(`UPDATE notifications SET read_at = ? WHERE ${where.sql} AND read_at IS NULL`, ts, ...where.args);
      for (const a of activeAnnouncements(ctx.account, ctx.profile)) if (!a.read_at) markAnnouncement(ctx.account.id, a.id, 'read_at');
    });
    return { ok: true, unread: unreadCount(ctx) };
  });

  app.post('/api/notifications/:id/read', requireAuth, (ctx) => {
    const id = ctx.params.id;
    const account = ctx.account;
    if (id.startsWith('ann_')) {
      if (!activeAnnouncements(account, ctx.profile).some((a) => a.id === id)) throw notFound('That notification does not exist.');
      markAnnouncement(account.id, id, 'read_at');
    } else {
      const where = scope(ctx);
      const r = db.run(`UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND ${where.sql}`, now(), id, ...where.args);
      if (!r.changes) throw notFound('That notification does not exist.');
    }
    return { ok: true, unread: unreadCount(ctx) };
  });

  app.delete('/api/notifications/:id', requireAuth, (ctx) => {
    const id = ctx.params.id;
    const account = ctx.account;
    if (id.startsWith('ann_')) {
      if (!activeAnnouncements(account, ctx.profile).some((a) => a.id === id)) throw notFound('That notification does not exist.');
      markAnnouncement(account.id, id, 'dismissed_at');
    } else {
      const where = scope(ctx);
      const r = db.run(`DELETE FROM notifications WHERE id = ? AND ${where.sql}`, id, ...where.args);
      if (!r.changes) throw notFound('That notification does not exist.');
    }
    return { ok: true, unread: unreadCount(ctx) };
  });
}

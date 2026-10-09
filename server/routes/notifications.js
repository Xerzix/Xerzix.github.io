// Notification centre API. The list merges the account's own notifications with active
// platform announcements (audience "all", or "creators" for creator accounts); announcement
// read/dismiss state lives in announcement_reads. Preferences cover optional types only.
import { requireAuth } from '../auth/session.js';
import { now, parseJson, placeholders, toJson } from '../db/index.js';
import { notFound } from '../lib/errors.js';
import { v } from '../lib/validate.js';
import { DEFAULT_NOTIFICATION_PREFS, NOTIFICATION_TYPES, notificationPrefs } from '../services/notifications.js';
import { parentalGuard } from '../services/profiles.js';

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

export default function register(app, { db }) {
  /** Announcements visible to this account right now (respecting audience, dismissals and prefs). */
  function activeAnnouncements(account) {
    if (optionalPrefs(account.settings).announcements === false) return [];
    const ts = now();
    const audiences = account.is_creator ? ['all', 'creators'] : ['all'];
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

  function unreadCount(account) {
    const own = db.get('SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? AND read_at IS NULL', account.id).n;
    return own + activeAnnouncements(account).filter((a) => !a.read_at).length;
  }

  function markAnnouncement(accountId, announcementId, column) {
    db.run(
      `INSERT INTO announcement_reads (account_id, announcement_id, ${column}) VALUES (?, ?, ?)
       ON CONFLICT (account_id, announcement_id) DO UPDATE SET ${column} = COALESCE(announcement_reads.${column}, excluded.${column})`,
      accountId, announcementId, now(),
    );
  }

  app.get('/api/notifications', requireAuth, (ctx) => {
    const account = ctx.account;
    const page = Math.max(1, Math.min(50, Number.parseInt(ctx.query.page, 10) || 1));
    const unreadOnly = ctx.query.unread === '1' || ctx.query.filter === 'unread';
    const readClause = unreadOnly ? 'AND read_at IS NULL' : '';
    const ownTotal = db.get(`SELECT COUNT(*) AS n FROM notifications WHERE account_id = ? ${readClause}`, account.id).n;
    // Merge the newest (page × size) of each source, then slice the requested page.
    const own = db.all(
      `SELECT * FROM notifications WHERE account_id = ? ${readClause} ORDER BY created_at DESC LIMIT ?`,
      account.id, page * PAGE_SIZE,
    ).map(notificationDto);
    const announcements = activeAnnouncements(account).filter((a) => !unreadOnly || !a.read_at).map(announcementDto);
    const merged = [...announcements, ...own].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const items = merged.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    return { items, unread: unreadCount(account), total: ownTotal + announcements.length, page, pageSize: PAGE_SIZE };
  });

  app.get('/api/notifications/unread-count', requireAuth, (ctx) => ({ unread: unreadCount(ctx.account) }));

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
    db.tx(() => {
      db.run('UPDATE notifications SET read_at = ? WHERE account_id = ? AND read_at IS NULL', ts, ctx.account.id);
      for (const a of activeAnnouncements(ctx.account)) if (!a.read_at) markAnnouncement(ctx.account.id, a.id, 'read_at');
    });
    return { ok: true, unread: 0 };
  });

  app.post('/api/notifications/:id/read', requireAuth, (ctx) => {
    const id = ctx.params.id;
    const account = ctx.account;
    if (id.startsWith('ann_')) {
      if (!activeAnnouncements(account).some((a) => a.id === id)) throw notFound('That notification does not exist.');
      markAnnouncement(account.id, id, 'read_at');
    } else {
      const r = db.run('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND account_id = ?', now(), id, account.id);
      if (!r.changes) throw notFound('That notification does not exist.');
    }
    return { ok: true, unread: unreadCount(account) };
  });

  app.delete('/api/notifications/:id', requireAuth, (ctx) => {
    const id = ctx.params.id;
    const account = ctx.account;
    if (id.startsWith('ann_')) {
      if (!activeAnnouncements(account).some((a) => a.id === id)) throw notFound('That notification does not exist.');
      markAnnouncement(account.id, id, 'dismissed_at');
    } else {
      const r = db.run('DELETE FROM notifications WHERE id = ? AND account_id = ?', id, account.id);
      if (!r.changes) throw notFound('That notification does not exist.');
    }
    return { ok: true, unread: unreadCount(account) };
  });
}

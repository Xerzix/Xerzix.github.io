// Moderation: the reports queue (grouped by reported item), review and comment status
// changes, and author suspensions. Every change is audited by the route under an action
// prefixed "moderation." so the moderation history can be read back from audit_log.
import { now, parseJson } from '../../db/index.js';
import { conflict, forbidden, notFound } from '../../lib/errors.js';
import { v } from '../../lib/validate.js';
import { notify } from '../notifications.js';
import { likeTerm, paging } from './common.js';

export const resolveSchema = v.object({
  action: v.enum(['dismiss', 'hide', 'remove', 'suspend_author']),
  note: v.string().max(1000).optional(),
  suspendDays: v.int().min(1).max(3650).nullable().optional(),
  messageToAuthor: v.string().max(1000).optional(),
});

export const reviewStatusSchema = v.object({
  status: v.enum(['visible', 'hidden', 'removed']),
  note: v.string().max(1000).optional(),
});

const REASON_LABELS = {
  spam: 'Spam', harassment: 'Harassment', hate: 'Hate', spoilers: 'Unmarked spoilers', sexual: 'Sexual content',
  violence: 'Violence', misinformation: 'Misinformation', copyright: 'Copyright', other: 'Other',
};

/** Loads a short preview of the reported item plus its author account id. */
export function targetPreview(db, type, id) {
  if (type === 'review') {
    const r = db.get(
      `SELECT r.*, p.name AS profile_name, a.display_name, a.email, a.role AS author_role, t.title AS title_name
         FROM reviews r LEFT JOIN profiles p ON p.id = r.profile_id JOIN accounts a ON a.id = r.account_id
         LEFT JOIN titles t ON t.id = r.title_id WHERE r.id = ?`, id,
    );
    if (!r) return { exists: false, type, id };
    return {
      exists: true, type, id,
      status: r.status,
      body: r.body || '',
      rating: r.rating,
      containsSpoilers: !!r.contains_spoilers,
      context: { titleId: r.title_id, titleName: r.title_name },
      author: { accountId: r.account_id, name: r.profile_name || r.display_name, email: r.email, role: r.author_role },
      createdAt: r.created_at,
    };
  }
  if (type === 'comment') {
    const c = db.get(
      `SELECT c.*, p.name AS profile_name, a.display_name, a.email, a.role AS author_role, r.title_id, t.title AS title_name
         FROM review_comments c JOIN accounts a ON a.id = c.account_id LEFT JOIN profiles p ON p.id = c.profile_id
         LEFT JOIN reviews r ON r.id = c.review_id LEFT JOIN titles t ON t.id = r.title_id WHERE c.id = ?`, id,
    );
    if (!c) return { exists: false, type, id };
    return {
      exists: true, type, id,
      status: c.status,
      body: c.body,
      context: { titleId: c.title_id, titleName: c.title_name, reviewId: c.review_id },
      author: { accountId: c.account_id, name: c.profile_name || c.display_name, email: c.email, role: c.author_role },
      createdAt: c.created_at,
    };
  }
  if (type === 'collection') {
    const c = db.get(
      `SELECT c.*, p.name AS profile_name, p.account_id, a.email, a.display_name, a.role AS author_role,
              (SELECT COUNT(*) FROM collection_items i WHERE i.collection_id = c.id) AS item_count
         FROM collections c JOIN profiles p ON p.id = c.profile_id JOIN accounts a ON a.id = p.account_id WHERE c.id = ?`, id,
    );
    if (!c) return { exists: false, type, id };
    return {
      exists: true, type, id,
      status: c.visibility === 'unlisted' ? 'shared' : 'private',
      body: [c.name, c.description].filter(Boolean).join(' — '),
      context: { collectionName: c.name, itemCount: c.item_count, visibility: c.visibility },
      author: { accountId: c.account_id, name: c.profile_name || c.display_name, email: c.email, role: c.author_role },
      createdAt: c.created_at,
    };
  }
  return { exists: false, type, id };
}

/** Reports grouped by target, newest activity first. */
export function listReportGroups(db, query) {
  const status = ['open', 'actioned', 'dismissed'].includes(query.status) ? query.status : query.status === 'all' ? null : 'open';
  const { page, pageSize, offset } = paging(query, { size: 20, max: 50 });
  const where = [];
  const args = [];
  if (status) {
    where.push('status = ?');
    args.push(status);
  }
  if (['review', 'comment', 'collection'].includes(query.type)) {
    where.push('target_type = ?');
    args.push(query.type);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM reports ${clause} GROUP BY target_type, target_id)`, ...args).n;
  const groups = db.all(
    `SELECT target_type, target_id, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at
       FROM reports ${clause} GROUP BY target_type, target_id ORDER BY n DESC, last_at DESC LIMIT ? OFFSET ?`,
    ...args, pageSize, offset,
  );
  const items = groups.map((g) => {
    const reports = db.all(
      `SELECT r.*, a.display_name AS reporter_name, a.email AS reporter_email, rb.display_name AS resolver_name
         FROM reports r LEFT JOIN accounts a ON a.id = r.reporter_account_id LEFT JOIN accounts rb ON rb.id = r.resolved_by
        WHERE r.target_type = ? AND r.target_id = ? ${status ? 'AND r.status = ?' : ''} ORDER BY r.created_at DESC LIMIT 50`,
      g.target_type, g.target_id, ...(status ? [status] : []),
    );
    const reasons = {};
    for (const r of reports) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
    return {
      key: `${g.target_type}:${g.target_id}`,
      targetType: g.target_type,
      targetId: g.target_id,
      count: g.n,
      firstReportedAt: g.first_at,
      lastReportedAt: g.last_at,
      reasons: Object.entries(reasons).map(([reason, count]) => ({ reason, label: REASON_LABELS[reason] || reason, count })).sort((a, b) => b.count - a.count),
      reports: reports.map((r) => ({
        id: r.id,
        reason: r.reason,
        reasonLabel: REASON_LABELS[r.reason] || r.reason,
        details: r.details,
        status: r.status,
        reporter: r.reporter_account_id ? { id: r.reporter_account_id, name: r.reporter_name, email: r.reporter_email } : null,
        createdAt: r.created_at,
        resolutionNote: r.resolution_note,
        resolvedBy: r.resolver_name || null,
        resolvedAt: r.resolved_at,
      })),
      target: targetPreview(db, g.target_type, g.target_id),
    };
  });
  const openCount = db.get(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM reports WHERE status = 'open' GROUP BY target_type, target_id)`).n;
  return { items, total, page, pageSize, openTargets: openCount };
}

const ROLE_RANK = { member: 0, moderator: 1, admin: 2 };

/** Moderators may act on members only; admins on anyone but themselves and the last admin. */
export function assertCanSuspend(db, actor, target) {
  if (!target) throw notFound('The author account no longer exists.');
  if (target.id === actor.id) throw forbidden('You cannot suspend your own account.', 'SELF_ACTION');
  if (actor.role !== 'admin' && (ROLE_RANK[target.role] ?? 0) > 0) throw forbidden('Moderators can suspend members only. Ask an administrator.', 'INSUFFICIENT_ROLE');
  if (target.role === 'admin' && target.status === 'active') {
    const admins = db.get(`SELECT COUNT(*) AS n FROM accounts WHERE role = 'admin' AND status = 'active'`).n;
    if (admins <= 1) throw conflict('This is the last active administrator.', 'LAST_ADMIN');
  }
}

/** Suspends an account and signs it out everywhere. `until` null = indefinite. */
export function suspendAccount(db, accountId, { reason, until }) {
  const ts = now();
  db.run(`UPDATE accounts SET status = 'suspended', suspended_reason = ?, suspended_until = ?, updated_at = ? WHERE id = ?`, reason || null, until || null, ts, accountId);
  return db.run('DELETE FROM sessions WHERE account_id = ?', accountId).changes;
}

function setTargetStatus(db, type, id, status, note) {
  const ts = now();
  if (type === 'review') {
    return db.run('UPDATE reviews SET status = ?, moderation_note = ?, updated_at = ? WHERE id = ?', status, note || null, ts, id).changes;
  }
  if (type === 'comment') {
    const c = db.get('SELECT review_id, status FROM review_comments WHERE id = ?', id);
    const changes = db.run('UPDATE review_comments SET status = ?, updated_at = ? WHERE id = ?', status, ts, id).changes;
    if (c) {
      db.run(`UPDATE reviews SET comment_count = (SELECT COUNT(*) FROM review_comments WHERE review_id = ? AND status = 'visible') WHERE id = ?`, c.review_id, c.review_id);
    }
    return changes;
  }
  if (type === 'collection') {
    // Collections have no status; hiding one withdraws its public share link.
    return db.run(`UPDATE collections SET visibility = 'private', share_token = NULL, updated_at = ? WHERE id = ?`, ts, id).changes;
  }
  return 0;
}

const WHAT = { review: 'review', comment: 'comment', collection: 'shared collection' };

/**
 * Resolves every open report about the same item as report `id`.
 * Returns { resolved, target, action, suspended?, sessionsRevoked?, ratingsChanged }.
 */
export function resolveReport(db, ctx, id, input) {
  const report = db.get('SELECT * FROM reports WHERE id = ?', id);
  if (!report) throw notFound('That report does not exist.');
  const target = targetPreview(db, report.target_type, report.target_id);
  const ts = now();
  const actor = ctx.account;
  let authorAccount = null;
  if (input.action === 'suspend_author') {
    authorAccount = target.author ? db.get('SELECT id, role, status FROM accounts WHERE id = ?', target.author.accountId) : null;
    assertCanSuspend(db, actor, authorAccount);
  }
  if (input.action !== 'dismiss' && !target.exists) throw conflict('The reported item no longer exists. Dismiss the report instead.', 'TARGET_GONE');

  const result = { action: input.action, target: { type: report.target_type, id: report.target_id }, ratingsChanged: false };
  db.tx(() => {
    const newStatus = input.action === 'dismiss' ? 'dismissed' : 'actioned';
    result.resolved = db.run(
      `UPDATE reports SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE target_type = ? AND target_id = ? AND status = 'open'`,
      newStatus, input.note || null, actor.id, ts, report.target_type, report.target_id,
    ).changes;
    if (!result.resolved) {
      // Acting again on an already-settled item: record the new decision on this report.
      db.run('UPDATE reports SET status = ?, resolution_note = ?, resolved_by = ?, resolved_at = ? WHERE id = ?', newStatus, input.note || null, actor.id, ts, id);
    }

    if (input.action === 'hide' || input.action === 'remove' || input.action === 'suspend_author') {
      const status = input.action === 'remove' ? 'removed' : 'hidden';
      const current = target.status;
      if (!(input.action === 'suspend_author' && current === 'removed')) setTargetStatus(db, report.target_type, report.target_id, status, input.note);
      result.targetStatus = report.target_type === 'collection' ? 'private' : status;
      result.ratingsChanged = report.target_type === 'review';
    }
    if (input.action === 'suspend_author') {
      const until = input.suspendDays ? new Date(Date.now() + input.suspendDays * 86_400_000).toISOString() : null;
      result.sessionsRevoked = suspendAccount(db, authorAccount.id, { reason: input.note || `Community guidelines (${report.reason})`, until });
      result.suspended = { accountId: authorAccount.id, until };
    }

    if (input.action !== 'dismiss' && target.author?.accountId) {
      const what = WHAT[report.target_type];
      const titles = {
        hide: `Your ${what} was hidden`,
        remove: `Your ${what} was removed`,
        suspend_author: 'Your account has been suspended',
      };
      const bodies = {
        hide: `A moderator hid your ${what} because it did not follow the Community Guidelines.`,
        remove: `A moderator removed your ${what} because it did not follow the Community Guidelines.`,
        suspend_author: result.suspended?.until
          ? `Your account is suspended until ${result.suspended.until.slice(0, 10)} for breaking the Community Guidelines.`
          : 'Your account is suspended for breaking the Community Guidelines.',
      };
      if (report.target_type === 'collection') {
        // Moderators never delete a collection: hiding or removing it turns off its share link.
        titles.hide = titles.remove = 'Your shared collection was made private';
        bodies.hide = bodies.remove = 'A moderator turned off the share link of your collection because it did not follow the Community Guidelines. The collection itself was not deleted.';
      }
      notify(db, {
        accountId: target.author.accountId,
        type: 'moderation',
        title: titles[input.action],
        body: [bodies[input.action], input.messageToAuthor].filter(Boolean).join(' ').slice(0, 1000),
        link: '#/legal/community',
        data: { targetType: report.target_type, targetId: report.target_id, action: input.action },
        dedupeKey: `moderation:${report.target_type}:${report.target_id}:${input.action}`,
      });
    }
  });
  return result;
}

export function listReviews(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 25 });
  const where = [];
  const args = [];
  if (['visible', 'pending', 'hidden', 'removed'].includes(query.status)) {
    where.push('r.status = ?');
    args.push(query.status);
  }
  if (query.titleId) {
    where.push('r.title_id = ?');
    args.push(query.titleId);
  }
  if (query.q) {
    const term = likeTerm(query.q);
    where.push(`(r.body LIKE ? ESCAPE '\\' OR t.title LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')`);
    args.push(term, term, term, term);
  }
  if (query.reported === '1') where.push(`EXISTS (SELECT 1 FROM reports x WHERE x.target_type = 'review' AND x.target_id = r.id AND x.status = 'open')`);
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM reviews r JOIN accounts a ON a.id = r.account_id LEFT JOIN profiles p ON p.id = r.profile_id LEFT JOIN titles t ON t.id = r.title_id ${clause}`;
  const total = db.get(`SELECT COUNT(*) AS n ${from}`, ...args).n;
  const rows = db.all(
    `SELECT r.*, a.email, a.display_name, a.status AS account_status, p.name AS profile_name, t.title AS title_name,
            (SELECT COUNT(*) FROM reports x WHERE x.target_type = 'review' AND x.target_id = r.id AND x.status = 'open') AS open_reports
       ${from} ORDER BY CASE r.status WHEN 'pending' THEN 0 ELSE 1 END, r.created_at DESC LIMIT ? OFFSET ?`,
    ...args, pageSize, offset,
  );
  const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM reviews GROUP BY status').map((r) => [r.status, r.n]));
  return {
    items: rows.map((r) => ({
      id: r.id,
      titleId: r.title_id,
      titleName: r.title_name,
      rating: r.rating,
      body: r.body,
      containsSpoilers: !!r.contains_spoilers,
      status: r.status,
      moderationNote: r.moderation_note,
      spamScore: r.spam_score,
      helpfulCount: r.helpful_count,
      commentCount: r.comment_count,
      openReports: r.open_reports,
      author: { accountId: r.account_id, name: r.profile_name || r.display_name, email: r.email, status: r.account_status },
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    })),
    total,
    page,
    pageSize,
    counts,
  };
}

/** Sets a review's status. Returns { before, after, authorId }. */
export function setReviewStatus(db, id, { status, note }) {
  const r = db.get('SELECT id, status, account_id, title_id FROM reviews WHERE id = ?', id);
  if (!r) throw notFound('That review does not exist.');
  db.tx(() => {
    setTargetStatus(db, 'review', id, status, note);
    // Approving or acting on a review settles any open reports about it.
    db.run(
      `UPDATE reports SET status = ?, resolution_note = COALESCE(resolution_note, ?), resolved_at = ? WHERE target_type = 'review' AND target_id = ? AND status = 'open'`,
      status === 'visible' ? 'dismissed' : 'actioned', note || null, now(), id,
    );
    if (status !== 'visible' && r.status !== status) {
      notify(db, {
        accountId: r.account_id,
        type: 'moderation',
        title: status === 'removed' ? 'Your review was removed' : 'Your review was hidden',
        body: 'A moderator reviewed your post and found that it did not follow the Community Guidelines.',
        link: '#/legal/community',
        data: { targetType: 'review', targetId: id, action: status },
        dedupeKey: `moderation:review:${id}:${status}`,
      });
    }
  });
  return { before: r.status, after: status, authorId: r.account_id, titleId: r.title_id };
}

export function setCommentStatus(db, id, { status, note }) {
  const c = db.get('SELECT id, status, account_id FROM review_comments WHERE id = ?', id);
  if (!c) throw notFound('That comment does not exist.');
  const next = status === 'visible' ? 'visible' : status;
  db.tx(() => {
    setTargetStatus(db, 'comment', id, next, note);
    db.run(
      `UPDATE reports SET status = ?, resolution_note = COALESCE(resolution_note, ?), resolved_at = ? WHERE target_type = 'comment' AND target_id = ? AND status = 'open'`,
      next === 'visible' ? 'dismissed' : 'actioned', note || null, now(), id,
    );
  });
  return { before: c.status, after: next, authorId: c.account_id };
}

export function moderationHistory(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 30 });
  const total = db.get(`SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE 'moderation.%'`).n;
  const rows = db.all(`SELECT * FROM audit_log WHERE action LIKE 'moderation.%' ORDER BY id DESC LIMIT ? OFFSET ?`, pageSize, offset);
  return { items: rows.map(auditDto), total, page, pageSize };
}

export function auditDto(r) {
  return {
    id: r.id,
    action: r.action,
    actor: r.actor_account_id ? { id: r.actor_account_id, email: r.actor_email } : null,
    targetType: r.target_type,
    targetId: r.target_id,
    details: parseJson(r.details, {}),
    ip: r.ip,
    createdAt: r.created_at,
  };
}


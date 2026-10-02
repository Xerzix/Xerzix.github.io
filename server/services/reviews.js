// Reviews, replies, helpful votes, reports and blocks.
// Ownership is enforced in SQL (…WHERE id = ? AND account_id = ? AND profile_id = ?): a member
// can only ever change or delete what their own profile wrote. Posts the spam filter holds
// stay 'pending' (visible to their author only) until a moderator decides.
import { allowedFor } from '../../js/core/ratings.js';
import { config as defaultConfig } from '../config.js';
import { now, placeholders } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { conflict, forbidden, HttpError, notFound } from '../lib/errors.js';
import { audit } from './audit.js';
import { assessSpam, BURST_WINDOW_MS, holdNote, normalizeForCompare } from './moderation.js';
import { notify } from './notifications.js';

export const REVIEW_BODY_MAX = 5000;
export const COMMENT_BODY_MAX = 1000;
export const AUTO_HIDE_REPORTS = 3;
export const REPORT_REASONS = ['spam', 'harassment', 'hate', 'spoilers', 'sexual', 'violence', 'misinformation', 'copyright', 'other'];
export const REVIEW_SORTS = ['helpful', 'newest', 'highest', 'lowest'];

const SORT_SQL = {
  helpful: 'r.helpful_count DESC, r.created_at DESC',
  newest: 'r.created_at DESC',
  highest: 'r.rating DESC, r.helpful_count DESC, r.created_at DESC',
  lowest: 'r.rating ASC, r.helpful_count DESC, r.created_at DESC',
};

const REVIEW_SELECT = `
  SELECT r.*, p.name AS author_name, p.avatar AS author_avatar,
         (SELECT COUNT(*) FROM review_comments c WHERE c.review_id = r.id AND c.status = 'visible') AS visible_comments
    FROM reviews r JOIN profiles p ON p.id = r.profile_id`;

const excerpt = (text, n) => (text.length > n ? `${text.slice(0, n - 1).trimEnd()}…` : text);
const isUniqueViolation = (err) => /UNIQUE constraint failed/i.test(err?.message || '');

export function reviewDto(row, { profileId = null, accountId = null, voted = false } = {}) {
  return {
    id: row.id,
    titleId: row.title_id,
    rating: row.rating,
    body: row.body ?? null,
    containsSpoilers: !!row.contains_spoilers,
    status: row.status,
    author: { name: row.author_name, avatar: row.author_avatar },
    isMine: !!profileId && row.profile_id === profileId,
    // Written by another profile of the viewer's own account: no helpful votes, reports or blocks.
    fromYourAccount: !!accountId && row.account_id === accountId,
    helpfulCount: row.helpful_count,
    votedHelpful: !!voted,
    commentCount: row.visible_comments ?? row.comment_count ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    edited: !!row.edited_at,
    editedAt: row.edited_at ?? null,
  };
}

export function commentDto(row, { profileId = null, accountId = null } = {}) {
  return {
    id: row.id,
    reviewId: row.review_id,
    body: row.body,
    status: row.status,
    author: { name: row.author_name || 'Lumina member', avatar: row.author_avatar || 'sakura' },
    isMine: !!accountId && row.account_id === accountId && (!row.profile_id || row.profile_id === profileId),
    createdAt: row.created_at,
  };
}

export class ReviewService {
  constructor(db, catalog, config = defaultConfig) {
    this.db = db;
    this.catalog = catalog;
    this.config = config;
  }

  /** A published title the viewer may see (parental limits apply), or 404/403. */
  titleFor(titleId, profile) {
    const t = this.catalog.load().byId.get(titleId);
    if (!t) throw notFound('That title is not in the Lumina catalog.');
    if (profile && !allowedFor({ maxAge: profile.max_age ?? null }, t.minAge)) {
      throw new HttpError(403, 'PROFILE_RESTRICTED', 'This title is outside the maturity setting for this profile.');
    }
    return t;
  }

  assertCanPost(ctx) {
    if (ctx.profile?.is_kids) throw forbidden('Reviews and replies are turned off on kids profiles.', 'PROFILE_RESTRICTED');
  }

  blockedClause(ctx, alias = 'r') {
    return ctx.account ? { sql: ` AND ${alias}.account_id NOT IN (SELECT blocked_account_id FROM blocks WHERE account_id = ?)`, params: [ctx.account.id] } : { sql: '', params: [] };
  }

  // ───────────── Reviews ─────────────

  summary(titleId) {
    const rows = this.db.all(`SELECT rating, COUNT(*) AS n FROM reviews WHERE title_id = ? AND status = 'visible' GROUP BY rating`, titleId);
    const distribution = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    let count = 0;
    let total = 0;
    for (const r of rows) {
      distribution[r.rating] = r.n;
      count += r.n;
      total += r.rating * r.n;
    }
    return { average: count ? Math.round((total / count) * 10) / 10 : null, count, distribution };
  }

  list(ctx, titleId, query = {}) {
    this.titleFor(titleId, ctx.profile);
    const sort = REVIEW_SORTS.includes(query.sort) ? query.sort : 'helpful';
    const page = Math.max(1, Math.min(10_000, Number.parseInt(query.page, 10) || 1));
    const pageSize = Math.max(1, Math.min(50, Number.parseInt(query.pageSize, 10) || 10));
    // Written reviews by other people; ratings without text count only in the summary, and
    // the viewer's own review is returned separately as `mine`.
    let where = `r.title_id = ? AND r.status = 'visible' AND r.body IS NOT NULL`;
    const params = [titleId];
    if (ctx.profile) {
      where += ' AND r.profile_id != ?';
      params.push(ctx.profile.id);
    }
    const blocked = this.blockedClause(ctx);
    where += blocked.sql;
    params.push(...blocked.params);
    const total = this.db.get(`SELECT COUNT(*) AS n FROM reviews r WHERE ${where}`, ...params).n;
    const rows = this.db.all(`${REVIEW_SELECT} WHERE ${where} ORDER BY ${SORT_SQL[sort]} LIMIT ? OFFSET ?`, ...params, pageSize, (page - 1) * pageSize);
    const voted = new Set();
    if (ctx.account && rows.length) {
      const ids = rows.map((r) => r.id);
      for (const v of this.db.all(`SELECT review_id FROM review_votes WHERE account_id = ? AND review_id IN (${placeholders(ids.length)})`, ctx.account.id, ...ids)) voted.add(v.review_id);
    }
    const profileId = ctx.profile?.id ?? null;
    const accountId = ctx.account?.id ?? null;
    const mineRow = profileId ? this.db.get(`${REVIEW_SELECT} WHERE r.title_id = ? AND r.profile_id = ?`, titleId, profileId) : null;
    return {
      items: rows.map((r) => reviewDto(r, { profileId, accountId, voted: voted.has(r.id) })),
      summary: this.summary(titleId),
      mine: mineRow ? reviewDto(mineRow, { profileId, accountId }) : null,
      total,
      page,
      pageSize,
      sort,
      commentsEnabled: !!this.config.features.communityComments,
    };
  }

  getOwn(ctx, id) {
    const row = this.db.get(`${REVIEW_SELECT} WHERE r.id = ? AND r.account_id = ? AND r.profile_id = ?`, id, ctx.account.id, ctx.profile.id);
    if (!row) throw notFound('We could not find that review.');
    return row;
  }

  spamForReview(accountId, titleId, body) {
    if (!body) return { score: 0, held: false, reasons: [] };
    const since = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
    const recentCount = this.db.get(`SELECT COUNT(*) AS n FROM reviews WHERE account_id = ? AND body IS NOT NULL AND created_at > ? AND title_id != ?`, accountId, since, titleId).n;
    const norm = normalizeForCompare(body);
    const duplicateCount = this.db.all(`SELECT body FROM reviews WHERE account_id = ? AND title_id != ? AND body IS NOT NULL ORDER BY created_at DESC LIMIT 200`, accountId, titleId)
      .filter((r) => normalizeForCompare(r.body) === norm).length;
    return assessSpam(body, { recentCount, duplicateCount });
  }

  /** Records an automatic spam hold in the audit log (the actor is the filter, not a person). */
  auditHold(ctx, targetType, targetId, spam) {
    audit(this.db, { account: null, ip: ctx.ip }, 'moderation.auto_hold', {
      targetType,
      targetId,
      details: { score: spam.score, reasons: spam.reasons.map((r) => r.code), author: ctx.account.id },
    });
  }

  create(ctx, titleId, input) {
    this.titleFor(titleId, ctx.profile);
    this.assertCanPost(ctx);
    const existing = this.db.get('SELECT id FROM reviews WHERE title_id = ? AND profile_id = ?', titleId, ctx.profile.id);
    if (existing) throw conflict('You have already reviewed this title. Edit your review instead.', 'REVIEW_EXISTS', { reviewId: existing.id });
    const body = input.body ?? null;
    const spam = this.spamForReview(ctx.account.id, titleId, body);
    const id = newId('rev');
    const ts = now();
    try {
      this.db.run(
        `INSERT INTO reviews (id, title_id, account_id, profile_id, rating, body, contains_spoilers, status, moderation_note, spam_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, titleId, ctx.account.id, ctx.profile.id, input.rating, body, input.containsSpoilers ? 1 : 0,
        spam.held ? 'pending' : 'visible', spam.held ? holdNote(spam) : null, spam.score, ts, ts,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('You have already reviewed this title. Edit your review instead.', 'REVIEW_EXISTS');
      throw err;
    }
    if (spam.held) this.auditHold(ctx, 'review', id, spam);
    this.catalog.invalidateRatings();
    return { review: reviewDto(this.getOwn(ctx, id), { profileId: ctx.profile.id, accountId: ctx.account.id }) };
  }

  update(ctx, id, input) {
    const row = this.getOwn(ctx, id);
    if (row.status === 'hidden' || row.status === 'removed') {
      throw conflict('A moderator has taken this review down, so it can no longer be edited. You can still delete it.', 'REVIEW_LOCKED');
    }
    const next = {
      rating: input.rating ?? row.rating,
      body: 'body' in input ? input.body ?? null : row.body,
      spoilers: input.containsSpoilers === undefined ? !!row.contains_spoilers : !!input.containsSpoilers,
    };
    if (next.rating === row.rating && next.body === row.body && next.spoilers === !!row.contains_spoilers) {
      return { review: reviewDto(row, { profileId: ctx.profile.id, accountId: ctx.account.id }) };
    }
    const spam = next.body !== row.body ? this.spamForReview(ctx.account.id, row.title_id, next.body) : { held: row.status === 'pending', score: row.spam_score };
    const status = spam.held ? 'pending' : 'visible';
    const note = spam.held ? (next.body !== row.body ? holdNote(spam) : row.moderation_note) : row.status === 'pending' ? null : row.moderation_note;
    const ts = now();
    const r = this.db.run(
      `UPDATE reviews SET rating = ?, body = ?, contains_spoilers = ?, status = ?, moderation_note = ?, spam_score = ?, edited_at = ?, updated_at = ?
        WHERE id = ? AND account_id = ? AND profile_id = ? AND status IN ('visible', 'pending')`,
      next.rating, next.body, next.spoilers ? 1 : 0, status, note, spam.score, ts, ts, id, ctx.account.id, ctx.profile.id,
    );
    if (!r.changes) throw notFound('We could not find that review.');
    if (spam.held && row.status !== 'pending') this.auditHold(ctx, 'review', id, spam);
    this.catalog.invalidateRatings();
    return { review: reviewDto(this.getOwn(ctx, id), { profileId: ctx.profile.id, accountId: ctx.account.id }) };
  }

  remove(ctx, id) {
    const r = this.db.run('DELETE FROM reviews WHERE id = ? AND account_id = ? AND profile_id = ?', id, ctx.account.id, ctx.profile.id);
    if (!r.changes) throw notFound('We could not find that review.');
    this.catalog.invalidateRatings();
  }

  vote(ctx, id, on) {
    const row = this.db.get(`SELECT id, account_id FROM reviews WHERE id = ? AND status = 'visible'`, id);
    if (!row) throw notFound('We could not find that review.');
    if (row.account_id === ctx.account.id) throw forbidden('You cannot mark your own review as helpful.', 'OWN_REVIEW');
    this.db.tx(() => {
      if (on) this.db.run('INSERT OR IGNORE INTO review_votes (review_id, account_id, created_at) VALUES (?, ?, ?)', id, ctx.account.id, now());
      else this.db.run('DELETE FROM review_votes WHERE review_id = ? AND account_id = ?', id, ctx.account.id);
      this.db.run('UPDATE reviews SET helpful_count = (SELECT COUNT(*) FROM review_votes WHERE review_id = ?) WHERE id = ?', id, id);
    });
    return { helpfulCount: this.db.get('SELECT helpful_count FROM reviews WHERE id = ?', id).helpful_count, voted: !!on };
  }

  // ───────────── Replies ─────────────

  commentsEnabled() {
    return !!this.config.features.communityComments;
  }

  /** A review whose replies the viewer may read or answer: visible, or their own. */
  reviewForReplies(ctx, reviewId) {
    const review = this.db.get('SELECT id, title_id, account_id, profile_id, status FROM reviews WHERE id = ?', reviewId);
    const own = review && ctx.account && review.account_id === ctx.account.id;
    if (!review || (review.status !== 'visible' && !own)) throw notFound('We could not find that review.');
    const title = this.titleFor(review.title_id, ctx.profile);
    return { review, title };
  }

  comments(ctx, reviewId) {
    if (!this.commentsEnabled()) return { items: [], enabled: false };
    this.reviewForReplies(ctx, reviewId);
    let where = `c.review_id = ? AND (c.status = 'visible'`;
    const params = [reviewId];
    if (ctx.account) {
      where += ` OR (c.status = 'pending' AND c.account_id = ?)`;
      params.push(ctx.account.id);
    }
    where += ')';
    const blocked = this.blockedClause(ctx, 'c');
    where += blocked.sql;
    params.push(...blocked.params);
    const rows = this.db.all(
      `SELECT c.*, p.name AS author_name, p.avatar AS author_avatar FROM review_comments c LEFT JOIN profiles p ON p.id = c.profile_id
        WHERE ${where} ORDER BY c.created_at ASC LIMIT 200`,
      ...params,
    );
    return { items: rows.map((r) => commentDto(r, { profileId: ctx.profile?.id, accountId: ctx.account?.id })), enabled: true };
  }

  recountComments(reviewId) {
    this.db.run(`UPDATE reviews SET comment_count = (SELECT COUNT(*) FROM review_comments WHERE review_id = ? AND status = 'visible') WHERE id = ?`, reviewId, reviewId);
  }

  addComment(ctx, reviewId, body) {
    if (!this.commentsEnabled()) throw forbidden('Replies are turned off on this Lumina server.', 'FEATURE_DISABLED');
    this.assertCanPost(ctx);
    const { review, title } = this.reviewForReplies(ctx, reviewId);
    if (review.status !== 'visible') throw conflict('Replies open once your review has been approved.', 'REVIEW_NOT_VISIBLE');
    const since = new Date(Date.now() - BURST_WINDOW_MS).toISOString();
    const recentCount = this.db.get('SELECT COUNT(*) AS n FROM review_comments WHERE account_id = ? AND created_at > ?', ctx.account.id, since).n;
    const norm = normalizeForCompare(body);
    const duplicateCount = this.db.all('SELECT body FROM review_comments WHERE account_id = ? AND review_id != ? ORDER BY created_at DESC LIMIT 200', ctx.account.id, reviewId)
      .filter((r) => normalizeForCompare(r.body) === norm).length;
    const spam = assessSpam(body, { recentCount, duplicateCount });
    const id = newId('cmt');
    const ts = now();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO review_comments (id, review_id, account_id, profile_id, body, status, moderation_note, spam_score, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, reviewId, ctx.account.id, ctx.profile.id, body, spam.held ? 'pending' : 'visible', spam.held ? holdNote(spam) : null, spam.score, ts, ts,
      );
      if (spam.held) {
        // Put held replies in front of moderators (reporter NULL = the automatic filter).
        this.db.run(
          `INSERT INTO reports (id, target_type, target_id, reporter_account_id, reason, details, status, created_at) VALUES (?, 'comment', ?, NULL, 'spam', ?, 'open', ?)`,
          newId('rpt'), id, holdNote(spam), ts,
        );
      }
      this.recountComments(reviewId);
    });
    if (spam.held) this.auditHold(ctx, 'comment', id, spam);
    const blockedByAuthor = this.db.get('SELECT 1 FROM blocks WHERE account_id = ? AND blocked_account_id = ?', review.account_id, ctx.account.id);
    if (!spam.held && review.account_id !== ctx.account.id && !blockedByAuthor) {
      notify(this.db, {
        accountId: review.account_id,
        type: 'review_reply',
        title: `New reply to your review of ${title.title}`,
        body: `${ctx.profile.name}: ${excerpt(body, 160)}`,
        link: `#/title/${title.id}`,
        data: { titleId: title.id, reviewId, commentId: id },
      });
    }
    const row = this.db.get(`SELECT c.*, p.name AS author_name, p.avatar AS author_avatar FROM review_comments c LEFT JOIN profiles p ON p.id = c.profile_id WHERE c.id = ?`, id);
    return { comment: commentDto(row, { profileId: ctx.profile.id, accountId: ctx.account.id }) };
  }

  removeComment(ctx, id) {
    const row = this.db.get('SELECT review_id FROM review_comments WHERE id = ? AND account_id = ? AND profile_id = ?', id, ctx.account.id, ctx.profile.id);
    if (!row) throw notFound('We could not find that reply.');
    this.db.tx(() => {
      this.db.run('DELETE FROM review_comments WHERE id = ? AND account_id = ? AND profile_id = ?', id, ctx.account.id, ctx.profile.id);
      this.recountComments(row.review_id);
    });
  }

  // ───────────── Reports ─────────────

  reportTarget(ctx, type, id) {
    if (type === 'review') {
      const r = this.db.get('SELECT id, account_id, status FROM reviews WHERE id = ?', id);
      if (r && (r.status === 'visible' || r.account_id === ctx.account.id)) return r;
    } else if (type === 'comment') {
      const c = this.db.get('SELECT id, account_id, status, review_id FROM review_comments WHERE id = ?', id);
      if (c && (c.status === 'visible' || c.account_id === ctx.account.id)) return c;
    } else if (type === 'collection') {
      const c = this.db.get(`SELECT c.id, p.account_id, c.visibility FROM collections c JOIN profiles p ON p.id = c.profile_id WHERE c.id = ?`, id);
      if (c && (c.visibility === 'unlisted' || c.account_id === ctx.account.id)) return c;
    }
    return null;
  }

  report(ctx, { targetType, targetId, reason, details }) {
    const target = this.reportTarget(ctx, targetType, targetId);
    if (!target) throw notFound('We could not find what you are reporting.');
    if (target.account_id === ctx.account.id) throw conflict('You cannot report your own post.', 'OWN_CONTENT');
    const ts = now();
    try {
      this.db.run(
        `INSERT INTO reports (id, target_type, target_id, reporter_account_id, reason, details, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
        newId('rpt'), targetType, targetId, ctx.account.id, reason, details ?? null, ts,
      );
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('You have already reported this. Our moderators will take a look.', 'ALREADY_REPORTED');
      throw err;
    }
    let autoHidden = false;
    if (targetType !== 'collection') {
      const open = this.db.get(
        `SELECT COUNT(DISTINCT reporter_account_id) AS n FROM reports WHERE target_type = ? AND target_id = ? AND status = 'open' AND reporter_account_id IS NOT NULL`,
        targetType, targetId,
      ).n;
      if (open >= AUTO_HIDE_REPORTS) autoHidden = this.autoHide(ctx, targetType, target, open);
    }
    return { ok: true, autoHidden };
  }

  /** Hides a post that several members reported, pending a moderator's decision. */
  autoHide(ctx, targetType, target, reportCount) {
    const table = targetType === 'review' ? 'reviews' : 'review_comments';
    const note = `Hidden automatically after ${reportCount} member reports; awaiting moderator review.`;
    const r = this.db.run(`UPDATE ${table} SET status = 'hidden', moderation_note = ?, updated_at = ? WHERE id = ? AND status = 'visible'`, note, now(), target.id);
    if (!r.changes) return false;
    if (targetType === 'review') this.catalog.invalidateRatings();
    else this.recountComments(target.review_id);
    audit(this.db, { account: null, ip: ctx.ip }, 'moderation.auto_hide', { targetType, targetId: target.id, details: { reports: reportCount, triggeredBy: ctx.account.id } });
    return true;
  }

  // ───────────── Blocks ─────────────

  block(ctx, reviewId) {
    const review = this.db.get('SELECT r.account_id, p.name FROM reviews r JOIN profiles p ON p.id = r.profile_id WHERE r.id = ?', reviewId);
    if (!review) throw notFound('We could not find that review.');
    if (review.account_id === ctx.account.id) throw conflict('You cannot block yourself.', 'OWN_CONTENT');
    const existing = this.db.get('SELECT id, label, created_at FROM blocks WHERE account_id = ? AND blocked_account_id = ?', ctx.account.id, review.account_id);
    if (existing?.id) return { block: { id: existing.id, name: existing.label || 'Lumina member', createdAt: existing.created_at } };
    const id = newId('blk');
    const ts = now();
    if (existing) this.db.run('UPDATE blocks SET id = ?, label = COALESCE(label, ?) WHERE account_id = ? AND blocked_account_id = ?', id, review.name, ctx.account.id, review.account_id);
    else this.db.run('INSERT INTO blocks (account_id, blocked_account_id, created_at, id, label) VALUES (?, ?, ?, ?, ?)', ctx.account.id, review.account_id, ts, id, review.name);
    return { block: { id, name: review.name, createdAt: existing?.created_at ?? ts } };
  }

  blocks(ctx) {
    // Rows created elsewhere without an id get one now, so they can be unblocked.
    for (const row of this.db.all('SELECT blocked_account_id FROM blocks WHERE account_id = ? AND id IS NULL', ctx.account.id)) {
      this.db.run('UPDATE blocks SET id = ? WHERE account_id = ? AND blocked_account_id = ?', newId('blk'), ctx.account.id, row.blocked_account_id);
    }
    const rows = this.db.all('SELECT id, label, created_at FROM blocks WHERE account_id = ? ORDER BY created_at DESC', ctx.account.id);
    return { items: rows.map((r) => ({ id: r.id, name: r.label || 'Lumina member', createdAt: r.created_at })) };
  }

  unblock(ctx, id) {
    const r = this.db.run('DELETE FROM blocks WHERE id = ? AND account_id = ?', id, ctx.account.id);
    if (!r.changes) throw notFound('We could not find that block.');
  }
}

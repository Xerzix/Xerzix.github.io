// Administrative audit trail: who did what, to what, and when. Write one entry for every
// privileged action (content, moderation, user management, settings, submissions).
import { now, toJson } from '../db/index.js';
import { log } from '../lib/log.js';

export function audit(db, ctx, action, { targetType = null, targetId = null, details = {} } = {}) {
  db.run(
    `INSERT INTO audit_log (actor_account_id, actor_email, action, target_type, target_id, details, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx?.account?.id ?? null, ctx?.account?.email ?? null, action, targetType, targetId, toJson(details), ctx?.ip ?? null, now(),
  );
  log.info('audit', { action, targetType, targetId, actor: ctx?.account?.id });
}

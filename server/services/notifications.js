// In-app notifications. Any slice may call notify(); it respects the recipient's
// preferences and de-duplicates by `dedupeKey` so repeated events never spam a user.
import { newId } from '../lib/crypto.js';
import { now, parseJson, toJson } from '../db/index.js';

/** Notification types and whether users may switch them off. */
export const NOTIFICATION_TYPES = {
  new_episode: { pref: 'newEpisodes', optional: true, label: 'New episodes of shows you follow' },
  genre_release: { pref: 'genreReleases', optional: true, label: 'New titles in genres you follow' },
  creator_release: { pref: 'creatorReleases', optional: true, label: 'New releases from creators you follow' },
  submission_update: { pref: 'submissionUpdates', optional: false, label: 'Changes to your submissions' },
  creator_application: { pref: 'submissionUpdates', optional: false, label: 'Creator application decisions' },
  review_reply: { pref: 'reviewReplies', optional: true, label: 'Replies to your reviews' },
  announcement: { pref: 'announcements', optional: true, label: 'Platform announcements' },
  account_security: { pref: null, optional: false, label: 'Account and security notices' },
  moderation: { pref: null, optional: false, label: 'Moderation decisions about your content' },
};

export const DEFAULT_NOTIFICATION_PREFS = {
  newEpisodes: true,
  genreReleases: true,
  creatorReleases: true,
  submissionUpdates: true,
  reviewReplies: true,
  announcements: true,
};

export function notificationPrefs(accountSettingsJson) {
  const settings = parseJson(accountSettingsJson, {});
  return { ...DEFAULT_NOTIFICATION_PREFS, ...(settings.notifications || {}) };
}

/**
 * Creates a notification unless the recipient opted out of that (optional) type.
 * Returns the id, or null when suppressed or duplicate.
 */
export function notify(db, { accountId, profileId = null, type, title, body = '', link = null, data = {}, dedupeKey = null }) {
  const meta = NOTIFICATION_TYPES[type];
  if (!meta) throw new Error(`Unknown notification type: ${type}`);
  const account = db.get('SELECT settings FROM accounts WHERE id = ?', accountId);
  if (!account) return null;
  if (meta.optional && meta.pref && notificationPrefs(account.settings)[meta.pref] === false) return null;
  const id = newId('ntf');
  const r = db.run(
    `INSERT OR IGNORE INTO notifications (id, account_id, profile_id, type, title, body, link, data, dedupe_key, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, accountId, profileId, type, title.slice(0, 200), body.slice(0, 1000), link, toJson(data), dedupeKey, now(),
  );
  return r.changes ? id : null;
}

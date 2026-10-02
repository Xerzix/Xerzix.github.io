// Platform settings stored in platform_settings (key → JSON value). Admins edit them in the
// dashboard; the features they control read them with readPlatformSettings(db) and declare
// that they do, once, when their routes register:
//
//   import { declareSettingConsumer, readPlatformSettings } from '../services/admin/settings.js';
//   declareSettingConsumer('registrationOpen');            // in register()
//   if (!readPlatformSettings(db).registrationOpen) throw forbidden('Registration is closed.');
//
// The dashboard shows a setting as "Enforced" only when some feature has declared it, so it
// never claims an effect that no code produces. Environment switches (ALLOW_REGISTRATION,
// FEATURE_*) remain hard limits: a setting can only narrow what the environment allows,
// never re-enable something the operator disabled.
import { config } from '../../config.js';
import { now, parseJson, toJson } from '../../db/index.js';

export const SETTING_DEFS = {
  maintenanceMessage: {
    label: 'Maintenance message',
    type: 'text',
    default: null,
    effect: 'A short notice shown to everyone at the top of Lumina, for example before planned downtime. Leave empty for none.',
  },
  registrationOpen: {
    label: 'New registrations open',
    type: 'boolean',
    default: () => config.auth.allowRegistration,
    env: 'ALLOW_REGISTRATION',
    effect: 'When off, nobody can create a new account; existing members can still sign in.',
  },
  reviewCommentsEnabled: {
    label: 'Comments on reviews',
    type: 'boolean',
    default: () => config.features.communityComments,
    env: 'FEATURE_REVIEW_COMMENTS',
    effect: 'When off, members cannot post new replies to reviews. Existing replies stay visible.',
  },
  watchPartiesEnabled: {
    label: 'Watch parties',
    type: 'boolean',
    default: () => config.features.watchParties,
    env: 'FEATURE_WATCH_PARTIES',
    effect: 'When off, members cannot start new watch parties.',
  },
};

const consumers = new Set();

/**
 * Called by a feature that enforces `key` (once, when its routes register). The dashboard
 * reports a setting as enforced only after this, so it never overstates what a switch does.
 */
export function declareSettingConsumer(key) {
  if (!Object.hasOwn(SETTING_DEFS, key)) throw new Error(`Unknown platform setting: ${key}`);
  consumers.add(key);
}

export function isSettingEnforced(key) {
  return consumers.has(key);
}

const envAllows = {
  registrationOpen: () => config.auth.allowRegistration,
  reviewCommentsEnabled: () => config.features.communityComments,
  watchPartiesEnabled: () => config.features.watchParties,
};

function defaultFor(key) {
  const d = SETTING_DEFS[key].default;
  return typeof d === 'function' ? d() : d;
}

export function getSetting(db, key, fallback = null) {
  const row = db.get('SELECT value FROM platform_settings WHERE key = ?', key);
  return row ? parseJson(row.value, fallback) : fallback;
}

export function setSetting(db, key, value, accountId = null) {
  db.run(
    `INSERT INTO platform_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key, toJson(value), now(), accountId,
  );
}

/** Effective values (environment limits applied). Safe to call on every request. */
export function readPlatformSettings(db) {
  const out = {};
  for (const key of Object.keys(SETTING_DEFS)) {
    const row = db.get('SELECT value FROM platform_settings WHERE key = ?', key);
    // A setting that was never saved takes its default (not null).
    let value = row ? parseJson(row.value, null) : defaultFor(key);
    if (envAllows[key] && !envAllows[key]()) value = false;
    out[key] = value;
  }
  return out;
}

/** Stored values plus metadata for the admin settings form. */
export function describeSettings(db) {
  return Object.entries(SETTING_DEFS).map(([key, def]) => {
    const row = db.get('SELECT value, updated_at, updated_by FROM platform_settings WHERE key = ?', key);
    const stored = row ? parseJson(row.value, null) : undefined;
    return {
      key,
      label: def.label,
      type: def.type,
      value: stored === undefined ? defaultFor(key) : stored,
      isDefault: stored === undefined,
      envLocked: envAllows[key] ? !envAllows[key]() : false,
      env: def.env || null,
      effect: def.effect,
      enforced: consumers.has(key),
      updatedAt: row?.updated_at || null,
    };
  });
}

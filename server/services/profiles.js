// Profiles: up to `accounts.max_profiles` (5) viewers per account, each with its own
// library, maturity limit, optional 4-digit PIN and preferences. Every query is scoped by
// account id so one account can never read or change another account's profiles.
import { now, parseJson, toJson } from '../db/index.js';
import { conflict, HttpError, notFound, validation } from '../lib/errors.js';
import { newId } from '../lib/crypto.js';
import { patterns, v } from '../lib/validate.js';
import { isElevated } from './accounts.js';
import { mergePreferences } from './dto.js';
import { AVATAR_IDS } from '../../js/core/avatar-ids.js';

// Mirrors of the browser-side catalogues (js/ui/avatars.js, js/theme.js, js/fx/garden.js,
// js/core/i18n.js, js/core/ratings.js). tests/server/profiles.test.js fails if they drift.
export { AVATAR_IDS } from '../../js/core/avatar-ids.js';
export const PRESET_IDS = ['velvet-garden', 'midnight-sakura', 'crimson-temple', 'moonlit-garden', 'golden-pavilion', 'minimal-black'];
export const ENVIRONMENT_IDS = ['sakura', 'moonlit', 'autumn', 'snow', 'lantern', 'none'];
export const THEME_KEYS = ['bg', 'bg2', 'surface', 'accent', 'accentStrong', 'button', 'text', 'text2', 'gold'];
export const UI_LANGUAGES = ['en', 'ja', 'es'];
export const MATURITY_AGES = [7, 8, 13, 14];
export const KIDS_MAX_AGE = 13;
export const KIDS_DEFAULT_AGE = 7;

export function profileLimitMessage(max) {
  return `This account already has ${max} profiles, the maximum. Profiles belong to one account — they are not separate subscriptions or simultaneous streams. Delete a profile to create another.`;
}

export const profileLimitError = (max) => conflict(profileLimitMessage(max), 'PROFILE_LIMIT', { max });
const nameTaken = () => conflict('You already have a profile with that name.', 'PROFILE_NAME_TAKEN', { fields: { name: 'You already have a profile with that name.' } });

// ── Names ──
/**
 * Normalises a person-facing name (profile names, account display names): NFC; removes
 * control characters (including newlines and tabs) and invisible format characters such as
 * zero-width spaces, BOMs and bidi overrides/isolates (U+202A–U+202E, U+2066–U+2069), keeping a
 * zero-width joiner only inside emoji sequences; collapses runs of whitespace; trims. This
 * stops look-alike duplicates ("Bob" + U+200B) and names that reorder or break the page.
 */
export function cleanName(value) {
  return String(value ?? '')
    .normalize('NFC')
    .replace(/\s+/gu, ' ') // newlines, tabs and other spaces become one space
    .replace(/[\p{Cc}\p{Cf}]/gu, (ch) => (ch === '\u200D' ? ch : ''))
    .replace(/(?<!\p{Extended_Pictographic}\uFE0F?)\u200D|\u200D(?!\p{Extended_Pictographic})/gu, '')
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** Cleans `data[key]` in place when present; 422 when nothing visible is left. */
export function cleanNameField(data, key, message = 'Use at least one visible character.') {
  if (data[key] === undefined) return;
  const clean = cleanName(data[key]);
  if (!clean) throw validation({ [key]: message });
  data[key] = clean;
}

// ── Schemas ──
const bool = () => v.boolean().optional();
const lang = () => v.string().max(16).pattern(patterns.lang, 'Choose a language from the list.').nullable().optional();
const hex = () => v.string().pattern(patterns.hexColor, 'Use a colour in the form #1a2b3c.').optional();
const unit = () => v.number().min(0).max(1).optional();

const profileFields = {
  name: v.string().min(1).max(40),
  avatar: v.enum(AVATAR_IDS).optional(),
  isKids: bool(),
  maxAge: v.int().nullable().optional().check((n) => MATURITY_AGES.includes(n), 'Choose one of the maturity settings.'),
  uiLanguage: v.enum(UI_LANGUAGES).optional(),
  audioLanguage: lang(),
  subtitleLanguage: lang(),
  subtitlesDefault: bool(),
  autoplayNext: bool(),
  autoplayPreviews: bool(),
};
export const createProfileSchema = v.object(profileFields);
export const updateProfileSchema = v.object({ ...profileFields, pin: v.string().optional() }).partial();

export const preferencesSchema = v.object({
  preferences: v.object({
    appearance: v.object({
      preset: v.enum([...PRESET_IDS, 'custom']).optional(),
      custom: v.object(Object.fromEntries(THEME_KEYS.map((k) => [k, hex()]))).nullable().optional(),
      environment: v.enum(ENVIRONMENT_IDS).optional(),
      animation: bool(),
      petalIntensity: unit(),
      ambientLight: unit(),
      parallax: bool(),
      density: v.enum(['compact', 'comfortable', 'spacious']).optional(),
      translucent: bool(),
      ambientMode: bool(),
      heroAutoRotate: bool(),
      motion: v.enum(['system', 'reduced', 'full']).optional(),
    }).optional(),
    subtitles: v.object({
      size: v.enum(['small', 'medium', 'large', 'xlarge']).optional(),
      color: hex(),
      background: v.enum(['none', 'shadow', 'box']).optional(),
      position: v.enum(['bottom', 'raised', 'top']).optional(),
    }).optional(),
    playback: v.object({
      autoplayNext: bool(),
      skipIntro: bool(),
      skipCredits: bool(),
      defaultQuality: v.enum(['auto', 'data-saver', 'highest']).optional(),
      saveProgress: bool(),
      dataSaver: bool(),
    }).optional(),
    home: v.object({
      hiddenRows: v.array(v.string().max(40).pattern(/^[a-z0-9][a-z0-9-]*$/, 'Unknown row.')).max(30).unique().optional(),
    }).optional(),
    privacy: v.object({
      useHistoryForRecommendations: bool(),
      statsEnabled: bool(),
    }).optional(),
  }),
});

/** Drops keys whose value is undefined (nested) so a merge never erases stored values. */
function compact(obj) {
  const out = {};
  for (const [k, val] of Object.entries(obj || {})) {
    if (val === undefined) continue;
    out[k] = val && typeof val === 'object' && !Array.isArray(val) ? compact(val) : val;
  }
  return out;
}

const COLUMN = {
  name: 'name', avatar: 'avatar', isKids: 'is_kids', maxAge: 'max_age', uiLanguage: 'ui_language', audioLanguage: 'audio_language',
  subtitleLanguage: 'subtitle_language', subtitlesDefault: 'subtitles_default', autoplayNext: 'autoplay_next', autoplayPreviews: 'autoplay_previews',
};

export class ProfileService {
  constructor(db) {
    this.db = db;
  }

  list(accountId) {
    return this.db.all('SELECT * FROM profiles WHERE account_id = ? ORDER BY created_at, rowid', accountId);
  }

  count(accountId) {
    return this.db.get('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', accountId).n;
  }

  /** The profile if it belongs to the account; 404 otherwise (never reveals other accounts' ids). */
  get(accountId, id) {
    const p = this.db.get('SELECT * FROM profiles WHERE id = ? AND account_id = ?', String(id || ''), accountId);
    if (!p) throw notFound('We could not find that profile.');
    return p;
  }

  nameInUse(accountId, name, exceptId = '') {
    return !!this.db.get('SELECT 1 FROM profiles WHERE account_id = ? AND name = ? COLLATE NOCASE AND id != ?', accountId, name, exceptId);
  }

  /** Applies the kids-profile rules: kids profiles are always limited to 13 or younger. */
  static maturity({ isKids, maxAge }, current = null) {
    const kids = isKids ?? !!current?.is_kids;
    let age = maxAge !== undefined ? maxAge : current ? current.max_age : null;
    if (kids) {
      if (maxAge === undefined && (age === null || age > KIDS_MAX_AGE)) age = KIDS_DEFAULT_AGE;
      if (age === null || age > KIDS_MAX_AGE) throw validation({ maxAge: 'Kids profiles can show titles rated up to 13 at most.' });
    }
    return { isKids: kids, maxAge: age };
  }

  create(account, data) {
    cleanNameField(data, 'name', 'Give the profile a name.');
    const max = account.max_profiles;
    if (this.count(account.id) >= max) throw profileLimitError(max);
    if (this.nameInUse(account.id, data.name)) throw nameTaken();
    const { isKids, maxAge } = ProfileService.maturity(data);
    const used = new Set(this.list(account.id).map((p) => p.avatar));
    const avatar = data.avatar || AVATAR_IDS.find((a) => !used.has(a)) || AVATAR_IDS[0];
    const id = newId('prf');
    const ts = now();
    const prefs = data.autoplayNext === undefined ? {} : { playback: { autoplayNext: data.autoplayNext } };
    try {
      this.db.run(
        `INSERT INTO profiles (id, account_id, name, avatar, is_kids, max_age, ui_language, audio_language, subtitle_language,
                               subtitles_default, autoplay_next, autoplay_previews, preferences, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, account.id, data.name, avatar, isKids ? 1 : 0, maxAge, data.uiLanguage || 'en', data.audioLanguage ?? null, data.subtitleLanguage ?? null,
        data.subtitlesDefault ? 1 : 0, data.autoplayNext === false ? 0 : 1, data.autoplayPreviews === false ? 0 : 1, toJson(prefs), ts, ts,
      );
    } catch (err) {
      // The trigger in 001_core.sql is the last line of defence against concurrent creates.
      if (/PROFILE_LIMIT/.test(err.message)) throw profileLimitError(max);
      if (/UNIQUE constraint failed: profiles\.account_id, profiles\.name/.test(err.message)) throw nameTaken();
      throw err;
    }
    return this.get(account.id, id);
  }

  update(accountId, profile, data) {
    cleanNameField(data, 'name', 'Give the profile a name.');
    const sets = [];
    const params = [];
    if (data.name !== undefined && data.name !== profile.name) {
      if (this.nameInUse(accountId, data.name, profile.id)) throw nameTaken();
    }
    const changes = { ...data };
    if (data.isKids !== undefined || data.maxAge !== undefined) Object.assign(changes, ProfileService.maturity(data, profile));
    for (const [key, col] of Object.entries(COLUMN)) {
      if (changes[key] === undefined) continue;
      const val = changes[key];
      sets.push(`${col} = ?`);
      params.push(typeof val === 'boolean' ? (val ? 1 : 0) : val);
    }
    let prefs = null;
    if (changes.autoplayNext !== undefined) {
      // Keep the column and preferences.playback.autoplayNext in step (players read either).
      prefs = mergePreferences(parseJson(profile.preferences, {}), { playback: { autoplayNext: changes.autoplayNext } });
      sets.push('preferences = ?');
      params.push(toJson(prefs));
    }
    if (!sets.length) return profile;
    sets.push('updated_at = ?');
    params.push(now());
    try {
      this.db.run(`UPDATE profiles SET ${sets.join(', ')} WHERE id = ? AND account_id = ?`, ...params, profile.id, accountId);
    } catch (err) {
      if (/UNIQUE constraint failed: profiles\.account_id, profiles\.name/.test(err.message)) throw nameTaken();
      throw err;
    }
    return this.get(accountId, profile.id);
  }

  remove(accountId, profile) {
    if (this.count(accountId) <= 1) throw conflict('Every account keeps at least one profile. Create another profile before deleting this one.', 'LAST_PROFILE');
    this.db.run('DELETE FROM profiles WHERE id = ? AND account_id = ?', profile.id, accountId);
  }

  setPinHash(accountId, profileId, pinHash) {
    this.db.run('UPDATE profiles SET pin_hash = ?, updated_at = ? WHERE id = ? AND account_id = ?', pinHash, now(), profileId, accountId);
    return this.get(accountId, profileId);
  }

  /** Deep-merges a validated preferences patch into the stored preferences. */
  updatePreferences(accountId, profile, patch) {
    const clean = compact(patch);
    const merged = mergePreferences(parseJson(profile.preferences, {}), clean);
    const sets = ['preferences = ?'];
    const params = [toJson(merged)];
    if (typeof clean.playback?.autoplayNext === 'boolean') {
      sets.push('autoplay_next = ?');
      params.push(clean.playback.autoplayNext ? 1 : 0);
    }
    this.db.run(`UPDATE profiles SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND account_id = ?`, ...params, now(), profile.id, accountId);
    return this.get(accountId, profile.id);
  }

  /**
   * Makes the profile the session's active one. Entering a restricted profile always starts
   * locked: any password confirmation the session had ends, so a grown-up's confirmation
   * never carries over to a child.
   */
  select(sessionId, profile) {
    if (isRestricted(profile)) this.db.run('UPDATE sessions SET profile_id = ?, elevated_until = NULL WHERE id = ?', profile.id, sessionId);
    else this.db.run('UPDATE sessions SET profile_id = ? WHERE id = ?', profile.id, sessionId);
  }
}

// ── Parental controls ──
/**
 * A restricted profile is a kids profile or any profile with a maturity limit. While one is
 * the session's active profile, the session may not loosen parental controls or manage the
 * account without a grown-up re-entering the account password.
 */
export const isRestricted = (p) => !!p && (!!p.is_kids || (p.max_age !== null && p.max_age !== undefined));

/** How long a password confirmation lasts while a restricted profile is active. */
export const PARENTAL_UNLOCK_MINUTES = 5;

const PARENTAL_MESSAGE = 'This profile has parental controls, so a grown-up needs to do this. Switch to a grown-up profile, or confirm the account password to continue.';

/**
 * Enforces parental controls for a restricted session. The action needs a recent account
 * password confirmation (POST /api/auth/elevate), and that confirmation covers one action
 * only: it is ended here, so a grown-up who unlocks a child's session for one change does not
 * leave it unlocked. The current request keeps ctx.session.elevatedUntil, so later checks in
 * the same request (e.g. skipping a forgotten PIN) still see the confirmation.
 * `consume: false` is for reads that should not use the confirmation up.
 */
export function parentalGuard(db, ctx, { consume = true, message = PARENTAL_MESSAGE } = {}) {
  if (!isRestricted(ctx.profile)) return;
  if (!isElevated(ctx)) throw new HttpError(403, 'PARENTAL_CONTROL', message);
  if (consume) db.run('UPDATE sessions SET elevated_until = NULL WHERE id = ?', ctx.session.id);
}

export function pinError(code, field = 'pin') {
  const required = code === 'PIN_REQUIRED';
  return new HttpError(403, code, required ? 'Enter the profile PIN to continue.' : 'That PIN is not correct.', {
    fields: { [field]: required ? 'Enter the 4-digit PIN.' : 'That PIN is not correct.' },
  });
}

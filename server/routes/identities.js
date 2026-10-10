// "Who's watching?" and account switching (/api/identities).
//
//   GET    /api/identities              the identities on this browser (public fields only)
//   POST   /api/identities/switch       {accountId, password?, totp?, remember?} → new session
//   DELETE /api/identities/:accountId   take an identity off this browser (account is kept)
//
// Switching ends this browser's current session and creates a new one for the chosen account,
// so every request afterwards is authorised as that account. The password is required unless
// the member chose "Keep me signed in on this device" there (and has not signed out since).
import { createSession, destroySession } from '../auth/session.js';
import { now } from '../db/index.js';
import { burnPasswordCheck, verifyPassword } from '../lib/crypto.js';
import { HttpError } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { rateLimit } from '../lib/security.js';
import { v } from '../lib/validate.js';
import { AccountService, consumeTotp, sessionPayload, totpError } from '../services/accounts.js';
import { audit } from '../services/audit.js';
import { IdentityService } from '../services/identities.js';

const MIN = 60_000;
const switchSchema = v.object({
  accountId: v.string().max(80),
  password: v.string().raw().max(1024).optional(),
  totp: v.string().max(16).optional(),
  remember: v.boolean().optional(),
});

function locked(until) {
  const retryAfter = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000));
  return new HttpError(423, 'ACCOUNT_LOCKED', `Too many unsuccessful sign-in attempts. For your security, this account is locked for ${Math.ceil(retryAfter / 60)} minutes.`, { retryAfter });
}

export default function register(app, { db, services }) {
  const accounts = (services.accounts ??= new AccountService(db));
  const identities = (services.identities ??= new IdentityService(db));

  app.get('/api/identities', rateLimit('identities', { max: 120, windowMs: MIN }), (ctx) => identities.list(ctx));

  app.post('/api/identities/switch', rateLimit('identity-switch', { max: 20, windowMs: 15 * MIN }), async (ctx) => {
    const body = v.parse(switchSchema, await ctx.body());
    const device = identities.device(ctx);
    const entry = device ? identities.entry(device.id, body.accountId) : null;
    // Only identities already listed on this browser can be switched to from here.
    if (!entry) throw new HttpError(404, 'IDENTITY_NOT_FOUND', 'That identity is not on this device. Sign in to add it.');
    rateLimit('identity-switch-account', { max: 10, windowMs: 15 * MIN, by: () => body.accountId })(ctx);
    const account = accounts.byId(body.accountId);
    if (!account) throw new HttpError(404, 'IDENTITY_NOT_FOUND', 'That identity no longer exists.');

    const remembered = identities.isRemembered(entry);
    if (!remembered || body.password) {
      if (!body.password) throw new HttpError(401, 'PASSWORD_REQUIRED', `Enter the password for ${account.username}.`, { username: account.username });
      if (account.locked_until && account.locked_until > now()) throw locked(account.locked_until);
      if (!(await verifyPassword(body.password, account.password_hash))) {
        const until = accounts.recordFailedLogin(account);
        if (until) throw locked(until);
        throw new HttpError(401, 'INVALID_CREDENTIALS', 'That password is not correct.', { fields: { password: 'That password is not correct.' } });
      }
      const lockedNow = accounts.lockedUntil(account.id);
      if (lockedNow) throw locked(lockedNow);
      if (account.totp_enabled) {
        if (!body.totp) throw new HttpError(401, 'TOTP_REQUIRED', 'Enter the 6-digit code from your authenticator app.');
        const result = consumeTotp(db, account, body.totp);
        if (result !== 'ok') {
          const until = accounts.recordFailedLogin(account);
          if (until) throw locked(until);
          throw totpError(result, 401, 'totp');
        }
      }
    } else {
      // Keep the timing of a remembered switch close to a password check.
      await burnPasswordCheck('remembered-device');
    }
    if (account.status === 'suspended' && (!account.suspended_until || account.suspended_until > now())) {
      throw new HttpError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. Contact support if you think this is a mistake.');
    }

    const previous = ctx.account?.id || null;
    accounts.recordSuccessfulLogin(account.id);
    // A brand-new session for the chosen account; the old one is ended, never reused.
    if (ctx.session) db.run('DELETE FROM sessions WHERE id = ?', ctx.session.id);
    const profileId = accounts.autoProfile(account.id);
    const sessionId = createSession(db, ctx, account.id, { profileId });
    ctx.session = { id: sessionId, profileId, elevatedUntil: null, createdAt: now() };
    ctx.account = accounts.byId(account.id);
    ctx.profile = profileId ? db.get('SELECT * FROM profiles WHERE id = ? AND account_id = ?', profileId, account.id) : null;
    // A password switch may (re)enable "keep me signed in"; a remembered one keeps its window.
    if (body.password) identities.add(ctx, account.id, { remember: !!body.remember });
    else db.run('UPDATE device_identities SET last_used_at = ? WHERE device_id = ? AND account_id = ?', now(), device.id, account.id);
    audit(db, ctx, 'auth.switch_identity', { targetType: 'account', targetId: account.id, details: { from: previous, remembered: remembered && !body.password } });
    log.info('identity switch', { to: account.id });
    return sessionPayload(db, ctx);
  });

  app.delete('/api/identities/:accountId', rateLimit('identity-remove', { max: 30, windowMs: 15 * MIN }), (ctx) => {
    const removed = identities.remove(ctx, ctx.params.accountId);
    if (!removed) throw new HttpError(404, 'IDENTITY_NOT_FOUND', 'That identity is not on this device.');
    // Removing the identity that is signed in here also signs it out here.
    if (ctx.account?.id === ctx.params.accountId) destroySession(db, ctx);
    return identities.list(ctx);
  });
}

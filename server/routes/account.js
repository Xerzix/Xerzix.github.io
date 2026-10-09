// The signed-in account: details, email and password changes, signed-in devices, two-factor
// authentication, plan, personal-data export and deletion. See docs/API.md → Auth & account.
import { destroySession, requireAuth } from '../auth/session.js';
import { now } from '../db/index.js';
import { encryptField, generateTotpSecret, hashPassword, otpauthUrl, verifyPassword } from '../lib/crypto.js';
import { conflict, forbidden, HttpError, notFound, validation } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { rateLimit } from '../lib/security.js';
import { patterns, v } from '../lib/validate.js';
import { AccountService, assertAccountPassword, consumeTotp, isElevated, normalizeEmail, totpError } from '../services/accounts.js';
import { audit } from '../services/audit.js';
import { accountDto } from '../services/dto.js';
import { planSummary } from '../services/entitlements.js';
import { sendMail } from '../services/mailer.js';
import { notify } from '../services/notifications.js';
import { assertPasswordPolicy, PASSWORD_MAX } from '../services/passwords.js';
import { cleanNameField, parentalGuard } from '../services/profiles.js';
import { AVATAR_IDS, IdentityService, usernameProblem, usernameTaken } from '../services/identities.js';

const MIN = 60_000;
const password = () => v.string().raw().max(1024);
/** Every endpoint that checks the account password shares one per-account budget. */
const passwordAttempts = rateLimit('account-password', { max: 10, windowMs: 15 * MIN, by: 'account' });

function securityNotice(db, account, title, body) {
  notify(db, { accountId: account.id, type: 'account_security', title, body, link: '#/account' });
  sendMail({ to: account.email, subject: `Lumina: ${title}`, text: `${body}\n\nIf this was not you, reset your password and contact support.\n\n— Lumina` })
    .catch((err) => log.error('security mail failed', { err }));
}

export default function register(app, { db, services, config }) {
  const accounts = (services.accounts ??= new AccountService(db));
  const identities = (services.identities ??= new IdentityService(db));
  const fresh = (ctx) => accounts.byId(ctx.account.id);
  // Account settings are the grown-ups' while a kids or maturity-limited profile is active.
  // Endpoints that take the account password in the same request need no extra check.
  const ADULTS_ONLY = 'Account settings are locked while this profile is active. Switch to a grown-up profile, or confirm the account password to continue.';
  const adultsOnly = (ctx) => parentalGuard(db, ctx, { message: ADULTS_ONLY });
  const adultsOnlyRead = (ctx) => parentalGuard(db, ctx, { message: ADULTS_ONLY, consume: false });

  // ── Details ──
  app.patch('/api/account', requireAuth, async (ctx) => {
    const body = v.parse(v.object({
      displayName: v.string().min(1).max(40).optional(),
      username: v.string().max(40).optional(),
      avatar: v.enum(AVATAR_IDS).optional(),
      email: v.string().email().optional(),
      currentPassword: password().optional(),
    }), await ctx.body());
    if (body.username !== undefined) {
      const problem = usernameProblem(body.username);
      if (problem) throw validation({ username: problem });
      body.username = body.username.trim();
    }
    cleanNameField(body, 'displayName');
    adultsOnly(ctx);
    const account = ctx.account;
    const ts = now();
    const email = body.email ? normalizeEmail(body.email) : null;
    if (email && email !== normalizeEmail(account.email)) {
      if (!body.currentPassword) throw validation({ currentPassword: 'Enter your current password to change your email address.' });
      passwordAttempts(ctx);
      await assertAccountPassword(account, body.currentPassword, 'currentPassword');
      if (accounts.byEmail(email)) throw conflict('Another account already uses that email address.', 'EMAIL_TAKEN', { fields: { email: 'Another account already uses that email address.' } });
      try {
        db.run('UPDATE accounts SET email = ?, email_verified_at = NULL, updated_at = ? WHERE id = ?', email, ts, account.id);
      } catch (err) {
        if (/UNIQUE constraint failed: accounts\.email/.test(err.message)) throw conflict('Another account already uses that email address.', 'EMAIL_TAKEN');
        throw err;
      }
      // Tell the old address, so a hijacked session cannot quietly take the account over.
      sendMail({
        to: account.email,
        subject: 'Your Lumina email address was changed',
        text: `The email address for your Lumina account was changed from ${account.email} to ${email}.\n\nIf you did not make this change, reset your password and contact support straight away.\n\n— Lumina`,
      }).catch((err) => log.error('email change mail failed', { err }));
      notify(db, { accountId: account.id, type: 'account_security', title: 'Your email address was changed', body: `Sign-in and account emails now go to ${email}.`, link: '#/account' });
      audit(db, ctx, 'account.email_change', { targetType: 'account', targetId: account.id, details: { from: account.email, to: email } });
    }
    if (body.displayName !== undefined && body.displayName !== account.display_name) {
      db.run('UPDATE accounts SET display_name = ?, updated_at = ? WHERE id = ?', body.displayName, ts, account.id);
    }
    if (body.username !== undefined && body.username !== account.username) {
      const other = accounts.byUsername(body.username);
      if (other && other.id !== account.id) throw usernameTaken();
      try {
        db.run('UPDATE accounts SET username = ?, updated_at = ? WHERE id = ?', body.username, ts, account.id);
      } catch (err) {
        if (/UNIQUE constraint failed: accounts\.username/.test(err.message)) throw usernameTaken();
        throw err;
      }
      audit(db, ctx, 'account.username_change', { targetType: 'account', targetId: account.id, details: { from: account.username, to: body.username } });
    }
    if (body.avatar !== undefined && body.avatar !== account.avatar) {
      if (identities.avatarsInUse(ctx, account.id).has(body.avatar)) throw validation({ avatar: 'Another identity on this device already uses this picture.' });
      db.run('UPDATE accounts SET avatar = ?, updated_at = ? WHERE id = ?', body.avatar, ts, account.id);
      // A single-profile account shows the same picture everywhere.
      if (db.get('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', account.id).n === 1) db.run('UPDATE profiles SET avatar = ?, updated_at = ? WHERE account_id = ?', body.avatar, ts, account.id);
    }
    return { account: accountDto(fresh(ctx)) };
  });

  // ── Password ──
  app.post('/api/account/password', requireAuth, passwordAttempts, async (ctx) => {
    const body = v.parse(v.object({ currentPassword: password(), newPassword: v.string().raw().max(PASSWORD_MAX) }), await ctx.body());
    await assertAccountPassword(ctx.account, body.currentPassword, 'currentPassword');
    assertPasswordPolicy(body.newPassword, { email: ctx.account.email, field: 'newPassword' });
    if (await verifyPassword(body.newPassword, ctx.account.password_hash)) {
      throw validation({ newPassword: 'Choose a password that is different from your current one.' });
    }
    const revoked = accounts.changePassword(ctx.account.id, await hashPassword(body.newPassword), ctx.session.id);
    audit(db, ctx, 'account.password_change', { targetType: 'account', targetId: ctx.account.id, details: { revokedSessions: revoked } });
    securityNotice(db, ctx.account, 'Your password was changed', `Your password was changed${revoked ? ` and ${revoked} other ${revoked === 1 ? 'device was' : 'devices were'} signed out` : ''}.`);
    return { ok: true, revokedSessions: revoked };
  });

  // ── Signed-in devices ──
  app.get('/api/account/sessions', requireAuth, adultsOnlyRead, (ctx) => ({ items: accounts.sessions(ctx.account.id, ctx.session.id) }));

  app.delete('/api/account/sessions/:id', requireAuth, adultsOnly, (ctx) => {
    const id = ctx.params.id;
    if (!accounts.revokeSession(ctx.account.id, id)) throw notFound('That session has already ended.');
    audit(db, ctx, 'account.session_revoke', { targetType: 'session', targetId: id });
    if (id === ctx.session.id) destroySession(db, ctx);
    return { ok: true };
  });

  app.delete('/api/account/sessions', requireAuth, adultsOnly, (ctx) => {
    const revoked = accounts.revokeOtherSessions(ctx.account.id, ctx.session.id);
    audit(db, ctx, 'account.sessions_revoke_others', { targetType: 'account', targetId: ctx.account.id, details: { revoked } });
    return { ok: true, revoked };
  });

  // ── Two-factor authentication (TOTP) ──
  app.post('/api/account/2fa/setup', requireAuth, (ctx) => {
    // Not requireElevated: that guard demands TOTP for staff when ADMIN_REQUIRE_2FA is set,
    // which would stop staff from ever setting it up.
    if (!isElevated(ctx)) throw new HttpError(403, 'REAUTH_REQUIRED', 'Please confirm your password to continue.');
    adultsOnly(ctx);
    if (ctx.account.totp_enabled) throw conflict('Two-factor authentication is already on. Turn it off first to set up a new authenticator.', 'TOTP_ALREADY_ENABLED');
    const secret = generateTotpSecret();
    db.run('UPDATE accounts SET totp_secret = ?, totp_enabled = 0, totp_last_step = NULL, updated_at = ? WHERE id = ?', encryptField(secret), now(), ctx.account.id);
    return { secret, otpauthUrl: otpauthUrl(secret, ctx.account.email) };
  });

  app.post('/api/account/2fa/enable', requireAuth, rateLimit('totp-enable', { max: 10, windowMs: 15 * MIN, by: 'account' }), async (ctx) => {
    const { code } = v.parse(v.object({ code: v.string().max(16) }), await ctx.body());
    const account = fresh(ctx);
    if (account.totp_enabled) throw conflict('Two-factor authentication is already on.', 'TOTP_ALREADY_ENABLED');
    if (!account.totp_secret) throw conflict('Start the set-up first to get a key for your authenticator app.', 'TOTP_SETUP_REQUIRED');
    const result = consumeTotp(db, account, code);
    if (result === 'reused') throw totpError(result, 422, 'code');
    if (result !== 'ok') {
      throw new HttpError(422, 'INVALID_TOTP', 'That code did not match. Check that the time on your device is correct and try again.', { fields: { code: 'That code did not match.' } });
    }
    db.run('UPDATE accounts SET totp_enabled = 1, updated_at = ? WHERE id = ?', now(), account.id);
    audit(db, ctx, 'account.2fa_enable', { targetType: 'account', targetId: account.id });
    securityNotice(db, account, 'Two-factor authentication is on', 'Signing in to Lumina now also needs a code from your authenticator app.');
    return { account: accountDto(fresh(ctx)) };
  });

  app.post('/api/account/2fa/disable', requireAuth, passwordAttempts, async (ctx) => {
    const body = v.parse(v.object({ password: password(), code: v.string().max(16) }), await ctx.body());
    const account = ctx.account;
    if (!account.totp_enabled) throw conflict('Two-factor authentication is not on.', 'TOTP_NOT_ENABLED');
    if (config.auth.adminRequire2fa && account.role !== 'member') {
      throw forbidden('Staff accounts must keep two-factor authentication on.', 'TOTP_REQUIRED_FOR_STAFF');
    }
    await assertAccountPassword(account, body.password);
    const result = patterns.totp.test(body.code.replace(/\s+/g, '')) ? consumeTotp(db, account, body.code) : 'invalid';
    if (result !== 'ok') throw totpError(result, 403, 'code');
    db.run('UPDATE accounts SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, updated_at = ? WHERE id = ?', now(), account.id);
    audit(db, ctx, 'account.2fa_disable', { targetType: 'account', targetId: account.id });
    securityNotice(db, account, 'Two-factor authentication was turned off', 'Signing in to Lumina now needs only your password.');
    return { account: accountDto(fresh(ctx)) };
  });

  // ── Plan ──
  app.get('/api/account/plan', requireAuth, (ctx) => planSummary(ctx.account));

  // ── Personal data ──
  app.get('/api/account/export', requireAuth, adultsOnly, rateLimit('account-export', { max: 10, windowMs: 60 * MIN, by: 'account' }), (ctx) => {
    const data = accounts.exportData(ctx.account, ctx.session.id);
    audit(db, ctx, 'account.export', { targetType: 'account', targetId: ctx.account.id });
    ctx.setHeader('Content-Disposition', `attachment; filename="lumina-data-${new Date().toISOString().slice(0, 10)}.json"`);
    return data;
  });

  app.delete('/api/account', requireAuth, passwordAttempts, async (ctx) => {
    const body = v.parse(v.object({ password: password(), confirm: v.string().max(20) }), await ctx.body());
    if (body.confirm !== 'DELETE') throw validation({ confirm: 'Type DELETE in capital letters to confirm.' });
    const account = ctx.account;
    await assertAccountPassword(account, body.password);
    if (accounts.isLastActiveAdmin(account)) {
      throw conflict('This is the only active administrator account. Make another account an administrator before deleting this one.', 'LAST_ADMIN');
    }
    audit(db, ctx, 'account.delete', { targetType: 'account', targetId: account.id });
    try {
      accounts.remove(account.id);
    } catch (err) {
      if (/FOREIGN KEY constraint failed/.test(err.message)) {
        log.error('account deletion blocked by a foreign key', { account: account.id, err });
        throw conflict('Some of your data could not be removed automatically. Please contact support to finish deleting your account.', 'DELETE_BLOCKED');
      }
      throw err;
    }
    sendMail({ to: account.email, subject: 'Your Lumina account was deleted', text: 'Your Lumina account and its profiles, lists, history, reviews and preferences have been deleted.\n\n— Lumina' })
      .catch((err) => log.error('deletion mail failed', { err }));
    destroySession(db, ctx);
  });
}

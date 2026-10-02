// Sign-up, sign-in (with lockout, suspension and TOTP), sign-out, password recovery and
// re-authentication ("sudo mode"). See docs/API.md → Auth & account.
import { createSession, destroySession, requireAuth } from '../auth/session.js';
import { now } from '../db/index.js';
import { burnPasswordCheck, hashPassword, verifyPassword } from '../lib/crypto.js';
import { conflict, forbidden, HttpError, validation } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { rateLimit } from '../lib/security.js';
import { v } from '../lib/validate.js';
import { AccountService, assertAccountPassword, assertTotp, normalizeEmail, sessionPayload, totpMatches } from '../services/accounts.js';
import { declareSettingConsumer, readPlatformSettings } from '../services/admin/settings.js';
import { audit } from '../services/audit.js';
import { sendMail } from '../services/mailer.js';
import { notify } from '../services/notifications.js';
import { assertPasswordPolicy, passwordProblem, PASSWORD_MAX } from '../services/passwords.js';

const MIN = 60_000;

const registerSchema = v.object({
  email: v.string().email(),
  password: v.string().raw().max(PASSWORD_MAX),
  displayName: v.string().min(1).max(40),
  acceptTerms: v.boolean(),
});
const loginSchema = v.object({
  email: v.string().max(254),
  password: v.string().raw().max(1024),
  totp: v.string().max(16).optional(),
});

const INVALID_CREDENTIALS = 'That email and password combination is not correct.';
const invalidCredentials = () => new HttpError(401, 'INVALID_CREDENTIALS', INVALID_CREDENTIALS);
const emailTaken = () => conflict('An account with that email already exists. Sign in instead, or reset your password.', 'EMAIL_TAKEN', {
  fields: { email: 'An account with that email already exists.' },
});
function locked(until) {
  const retryAfter = Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 1000));
  return new HttpError(423, 'ACCOUNT_LOCKED', `Too many unsuccessful sign-in attempts. For your security, this account is locked for ${Math.ceil(retryAfter / 60)} minutes.`, { retryAfter });
}

/** Records the new session on ctx so sessionPayload() describes it. */
function adoptSession(ctx, db, account, sessionId, profileId) {
  ctx.session = { id: sessionId, profileId, elevatedUntil: null, createdAt: now() };
  ctx.account = account;
  ctx.profile = profileId ? db.get('SELECT * FROM profiles WHERE id = ? AND account_id = ?', profileId, account.id) || null : null;
}

export default function register(app, { db, services, config }) {
  const accounts = (services.accounts ??= new AccountService(db));
  // The admin "New registrations open" switch (it can only narrow ALLOW_REGISTRATION).
  declareSettingConsumer('registrationOpen');

  // ── Register ──
  app.post('/api/auth/register', rateLimit('register', { max: 5, windowMs: 60 * MIN }), async (ctx) => {
    if (!readPlatformSettings(db).registrationOpen) throw forbidden('New registrations are closed on this Lumina server.', 'REGISTRATION_CLOSED');
    const raw = await ctx.body();
    // Collect every field problem at once so the form can show them together.
    const errors = {};
    let body = {};
    try {
      body = v.parse(registerSchema, raw);
    } catch (err) {
      if (err.code !== 'VALIDATION_FAILED') throw err;
      Object.assign(errors, err.extra.fields);
    }
    const email = normalizeEmail(typeof raw.email === 'string' ? raw.email : '');
    if (!errors.password && typeof raw.password === 'string') {
      const problem = passwordProblem(raw.password, { email });
      if (problem) errors.password = problem;
    }
    // Consent must be an explicit JSON `true`, not a value that merely coerces to one.
    if (raw.acceptTerms !== true) errors.acceptTerms = 'Please accept the Terms of Service and Privacy Policy to continue.';
    if (Object.keys(errors).length) throw validation(errors);

    // Enumeration trade-off: telling people "that email is taken" reveals that an account
    // exists. We accept that for a usable sign-up form (the alternative is an email
    // confirmation round-trip for every registration) and contain it with the 5/hour/IP
    // rate limit above. Sign-in and password recovery never reveal account existence.
    if (accounts.byEmail(email)) throw emailTaken();
    const passwordHash = await hashPassword(body.password);
    let created;
    try {
      created = accounts.create({ email, passwordHash, displayName: body.displayName });
    } catch (err) {
      if (/UNIQUE constraint failed: accounts\.email/.test(err.message)) throw emailTaken();
      throw err;
    }
    if (ctx.session) db.run('DELETE FROM sessions WHERE id = ?', ctx.session.id);
    const sessionId = createSession(db, ctx, created.account.id, { profileId: created.profile.id });
    adoptSession(ctx, db, created.account, sessionId, created.profile.id);
    audit(db, ctx, 'account.register', { targetType: 'account', targetId: created.account.id });
    return sessionPayload(db, ctx);
  });

  // ── Sign in ──
  app.post('/api/auth/login', rateLimit('login', { max: 10, windowMs: 15 * MIN }), async (ctx) => {
    const body = v.parse(loginSchema, await ctx.body());
    const email = normalizeEmail(body.email);
    rateLimit('login-email', { max: 10, windowMs: 15 * MIN, by: () => email })(ctx);

    const account = accounts.byEmail(email);
    if (!account) {
      // Same work and the same answer as a wrong password: no account enumeration.
      await burnPasswordCheck(body.password);
      throw invalidCredentials();
    }
    if (account.locked_until && account.locked_until > now()) throw locked(account.locked_until);

    if (!(await verifyPassword(body.password, account.password_hash))) {
      const until = accounts.recordFailedLogin(account);
      if (until) {
        audit(db, { account, ip: ctx.ip }, 'auth.lockout', { targetType: 'account', targetId: account.id, details: { minutes: config.auth.lockMinutes } });
        notify(db, {
          accountId: account.id,
          type: 'account_security',
          title: 'Sign-in paused after several failed attempts',
          body: `Someone entered the wrong password for your account ${config.auth.maxFailedLogins} times, so sign-in was paused for ${config.auth.lockMinutes} minutes. If this was not you, consider changing your password.`,
          link: '#/account',
          dedupeKey: `lockout:${until.slice(0, 16)}`,
        });
        throw locked(until);
      }
      throw invalidCredentials();
    }

    // Only reveal suspension to someone who knows the password.
    if (account.status === 'suspended' && (!account.suspended_until || account.suspended_until > now())) {
      throw new HttpError(403, 'ACCOUNT_SUSPENDED', account.suspended_until
        ? 'This account is suspended until the date shown. Contact support if you think this is a mistake.'
        : 'This account is suspended. Contact support if you think this is a mistake.', {
        reason: account.suspended_reason || null,
        until: account.suspended_until || null,
      });
    }

    if (account.totp_enabled) {
      if (!body.totp) throw new HttpError(401, 'TOTP_REQUIRED', 'Enter the 6-digit code from your authenticator app.');
      if (!totpMatches(account, body.totp)) {
        const until = accounts.recordFailedLogin(account);
        if (until) throw locked(until);
        throw new HttpError(401, 'INVALID_TOTP', 'That code did not match. Check your authenticator app and try again.', { fields: { totp: 'That code did not match.' } });
      }
    }

    accounts.recordSuccessfulLogin(account.id);
    // Never reuse a pre-existing session (fixation); drop whatever this browser had.
    if (ctx.session) db.run('DELETE FROM sessions WHERE id = ?', ctx.session.id);
    const profileId = accounts.autoProfile(account.id);
    const sessionId = createSession(db, ctx, account.id, { profileId });
    adoptSession(ctx, db, accounts.byId(account.id), sessionId, profileId);
    log.info('sign-in', { account: account.id });
    return sessionPayload(db, ctx);
  });

  // ── Sign out ──
  app.post('/api/auth/logout', requireAuth, (ctx) => {
    destroySession(db, ctx);
  });

  // ── Password recovery ──
  app.post('/api/auth/forgot', rateLimit('forgot', { max: 5, windowMs: 15 * MIN }), async (ctx) => {
    const { email } = v.parse(v.object({ email: v.string().email() }), await ctx.body());
    const norm = normalizeEmail(email);
    rateLimit('forgot-email', { max: 3, windowMs: 60 * MIN, by: () => norm })(ctx);
    const account = accounts.byEmail(norm);
    if (account) {
      const token = accounts.createPasswordReset(account.id, ctx.ip);
      const link = `${config.publicUrl}/#/reset?token=${encodeURIComponent(token)}`;
      // Not awaited: the response must not take longer when the account exists.
      sendMail({
        to: account.email,
        subject: 'Reset your Lumina password',
        text: [
          `Hello ${account.display_name || 'there'},`,
          '',
          'Someone (hopefully you) asked to reset the password for your Lumina account.',
          `Choose a new password here. The link works once and expires in ${config.auth.resetTokenMinutes} minutes:`,
          '',
          link,
          '',
          'If you did not ask for this, you can ignore this email. Your password will not change.',
          '',
          '— Lumina',
        ].join('\n'),
      }).catch((err) => log.error('password reset mail failed', { err }));
      audit(db, { account, ip: ctx.ip }, 'auth.password_reset_requested', { targetType: 'account', targetId: account.id });
    }
    ctx.json({ ok: true, message: 'If an account exists for that address, we have sent a link to reset its password.' }, 202);
  });

  app.post('/api/auth/reset', rateLimit('reset', { max: 10, windowMs: 15 * MIN }), async (ctx) => {
    const body = v.parse(v.object({ token: v.string().max(200), password: v.string().raw().max(PASSWORD_MAX) }), await ctx.body());
    const invalid = () => new HttpError(400, 'RESET_INVALID', 'This reset link is invalid, has already been used or has expired. Request a new one.');
    const reset = accounts.findPasswordReset(body.token);
    if (!reset) throw invalid();
    const account = accounts.byId(reset.account_id);
    if (!account) throw invalid();
    assertPasswordPolicy(body.password, { email: account.email });
    const passwordHash = await hashPassword(body.password);
    if (!accounts.completePasswordReset(reset, passwordHash)) throw invalid();
    // This browser's session (if it was this account's) is gone too; clear the cookie.
    if (ctx.account?.id === account.id) destroySession(db, ctx);
    const actx = { account, ip: ctx.ip };
    audit(db, actx, 'auth.password_reset', { targetType: 'account', targetId: account.id });
    notify(db, {
      accountId: account.id,
      type: 'account_security',
      title: 'Your password was reset',
      body: 'Your password was changed with a reset link and every device was signed out. If this was not you, reset your password again and contact support.',
      link: '#/account',
    });
    sendMail({ to: account.email, subject: 'Your Lumina password was changed', text: 'Your Lumina password was just changed using a reset link, and every device was signed out.\n\nIf this was not you, reset your password immediately and contact support.\n\n— Lumina' })
      .catch((err) => log.error('password changed mail failed', { err }));
    return { ok: true };
  });

  // ── Re-authentication ("sudo mode") for sensitive settings and staff areas ──
  app.post('/api/auth/elevate', requireAuth, rateLimit('elevate', { max: 10, windowMs: 15 * MIN, by: 'account' }), async (ctx) => {
    const body = v.parse(v.object({ password: v.string().raw().max(1024), totp: v.string().max(16).optional() }), await ctx.body());
    await assertAccountPassword(ctx.account, body.password);
    assertTotp(ctx.account, body.totp);
    const elevatedUntil = accounts.elevate(ctx.session.id);
    audit(db, ctx, 'auth.elevate', { targetType: 'session', targetId: ctx.session.id });
    return { elevatedUntil };
  });
}

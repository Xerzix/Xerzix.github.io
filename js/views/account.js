// Account (/account): details, password, signed-in devices, two-factor authentication, plan
// and personal data. Exports `reauth()` / `withReauth()` — the "confirm it's you" prompt
// used whenever the server answers REAUTH_REQUIRED (also used by the profile views).
import { h, newUid, announce } from '../core/dom.js';
import { api } from '../api/client.js';
import { bus } from '../core/bus.js';
import { session, refreshSession } from '../core/session.js';
import { date, relativeTime } from '../core/format.js';
import { applyFieldErrors, button, confirmDialog, errorState, field, linkButton, loading, notice, openModal, toast, toastError, withBusy } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { passwordField, strengthMeter } from './auth.js';

// ── Re-authentication ("sudo mode") ───────────────────────
/**
 * Asks for the account password (and a TOTP code when 2FA is on) and elevates the session.
 * Resolves true when confirmed, false when cancelled.
 */
export function reauth({ reason = 'For your security, please enter your password to continue.' } = {}) {
  const formId = newUid('reauth');
  const alert = h('div', { role: 'alert' });
  const pwF = passwordField();
  const needsCode = !!session.account?.totpEnabled;
  const codeF = field({ label: 'Authentication code', name: 'totp', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 8, hint: 'The 6-digit code from your authenticator app.' });
  codeF.control.classList.add('lm-code-input');
  codeF.hidden = !needsCode;
  const form = h('form', { id: formId, class: 'lm-form', novalidate: true }, h('p', { class: 'lm-muted' }, reason), alert, pwF, codeF);
  const confirm = button('Confirm', { variant: 'primary', type: 'submit', attrs: { form: formId } });
  let modal;
  const cancel = button('Cancel', { variant: 'ghost', onClick: () => modal.close(false) });
  modal = openModal({ title: 'Confirm it’s you', content: form, actions: [cancel, confirm] });
  setTimeout(() => pwF.control.focus(), 40);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.replaceChildren();
    const password = pwF.control.value;
    const totp = codeF.control.value.replace(/\s+/g, '') || undefined;
    if (!password) {
      pwF.setError('Enter your password.');
      return pwF.control.focus();
    }
    withBusy(confirm, async () => {
      try {
        await api.auth.elevate({ password, totp });
        session.elevated = true;
        modal.close(true);
      } catch (err) {
        if (err.code === 'TOTP_REQUIRED' || err.code === 'INVALID_TOTP') {
          codeF.hidden = false;
          codeF.setError(err.code === 'TOTP_REQUIRED' ? 'Enter the 6-digit code.' : err.extra?.reused ? 'That code was already used. Wait for the next one.' : 'That code did not match.');
          codeF.control.focus();
        } else if (err.code === 'INVALID_PASSWORD' || err.code === 'VALIDATION_FAILED') {
          applyFieldErrors(form, err);
          pwF.control.select();
        } else alert.replaceChildren(notice(err.message, { type: err.code === 'RATE_LIMITED' ? 'warn' : 'danger' }));
      }
    });
  });
  return modal.closed.then((v) => v === true);
}

/** Runs fn; if the server wants a recent password (or a grown-up), asks once and retries. */
export async function withReauth(fn, opts) {
  try {
    return await fn();
  } catch (err) {
    if (err?.code !== 'REAUTH_REQUIRED' && err?.code !== 'PARENTAL_CONTROL') throw err;
    if (!(await reauth(opts))) return undefined;
    return fn();
  } finally {
    syncParentalLock();
  }
}

// ── Parental controls ─────────────────────────────────────
/**
 * A kids profile, or any profile with a maturity limit. While one is active, changes to
 * profiles and to the account need a grown-up to confirm the account password, and each
 * confirmation covers one change (the server ends it after use).
 */
export function isRestrictedProfile(p) {
  return !!p && (!!p.isKids || (p.maxAge !== null && p.maxAge !== undefined));
}

/** After a change in a restricted session, re-reads whether the confirmation is still live. */
function syncParentalLock() {
  if (session.elevated && isRestrictedProfile(session.profile)) refreshSession().catch(() => {});
}

/** Ends a grown-up's confirmation now: re-entering a restricted profile always starts locked. */
export async function lockAgain() {
  if (session.profile) await api.profiles.select(session.profile.id, {});
  await refreshSession();
}

/** The reason shown in the password prompt when a restricted profile blocks a change. */
export function grownUpReason(what) {
  const name = session.profile?.name || 'this profile';
  return `${name} has parental controls. A grown-up can enter the account password to ${what}. It covers this one change.`;
}

// ── Helpers ───────────────────────────────────────────────
function section({ id, iconName, title, intro, danger }, ...body) {
  const headingId = newUid(id);
  return h('section', { class: ['lm-panel', 'lm-account-section', danger && 'lm-account-section--danger'], 'aria-labelledby': headingId, id: `account-${id}` },
    h('div', { class: 'lm-account-section__intro' },
      h('span', { class: 'lm-account-section__icon', 'aria-hidden': 'true' }, icon(iconName)),
      h('h2', { id: headingId }, title),
      intro ? h('p', null, intro) : null),
    h('div', { class: 'lm-account-section__body' }, ...body));
}

/** "Chrome on macOS" from a user-agent string (best effort, never shown raw if recognisable). */
export function describeAgent(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\/|Opera/.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  const mobile = /iPhone|Android.+Mobile|Mobile Safari/.test(ua);
  if (browser && os) return { label: `${browser} on ${os}`, mobile };
  if (browser || os) return { label: browser || os, mobile };
  return { label: ua ? ua.slice(0, 48) : 'Unknown device', mobile: false };
}

function downloadJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ── View ──────────────────────────────────────────────────
export default async function render(ctx) {
  ctx.setTitle('Account');
  const page = h('div', { class: 'lm-page lm-container lm-account' });
  const header = (text) => h('header', { class: 'lm-account__header' },
    h('span', { class: 'lm-eyebrow' }, 'Your Lumina'),
    h('h1', null, 'Account'),
    h('p', null, text));

  // While a kids or maturity-limited profile is active, account settings stay closed until a
  // grown-up confirms the account password (and close again with "Lock now").
  function drawLocked() {
    const p = session.profile;
    const unlock = button('Confirm the account password', { variant: 'primary', icon: 'lock' });
    unlock.addEventListener('click', async () => {
      if (await reauth({ reason: 'Enter the account password to open account settings. Each change made while this profile is active asks for it again.' })) {
        await refreshSession().catch(() => {});
        drawOpen();
      }
    });
    page.replaceChildren(
      header('Account settings belong to the grown-ups in this household.'),
      h('div', { class: 'lm-account__sections' },
        section({ id: 'locked', iconName: 'shield', title: 'Account settings are locked', intro: `${p.name} ${p.isKids ? 'is a kids profile' : 'has a maturity limit'}, so devices, passwords, data downloads and account changes need a grown-up.` },
          h('div', { class: 'lm-form-actions' }, unlock, linkButton('Switch profile', `#/profiles?next=${encodeURIComponent('/account')}`, { variant: 'glass', icon: 'users' })))));
  }

  function drawOpen() {
    const account = session.account;
    const restricted = isRestrictedProfile(session.profile);
    page.replaceChildren(
      header(`Signed in as ${account.email}. Member since ${date(account.createdAt, { year: 'numeric', month: 'long' })}.`),
      restricted ? parentalBanner(ctx, drawLocked) : null,
      h('div', { class: 'lm-account__sections' },
        detailsSection(),
        passwordSection(),
        sessionsSection(ctx),
        twoFactorSection(),
        planSection(),
        dataSection(ctx)));
  }

  if (isRestrictedProfile(session.profile) && !session.elevated) drawLocked();
  else drawOpen();
  return page;
}

/** Shown above the account sections while a restricted profile is active. */
function parentalBanner(ctx, onLock) {
  const box = h('div', { class: 'lm-account__parental' });
  const lock = button('Lock now', { variant: 'glass', size: 'sm', icon: 'lock' });
  lock.addEventListener('click', () => withBusy(lock, async () => {
    try {
      await lockAgain();
      announce('Account settings locked');
      onLock();
    } catch (err) {
      toastError(err);
    }
  }));
  const draw = () => {
    const text = session.elevated
      ? 'Unlocked for a grown-up. The confirmation covers one change and ends after 5 minutes.'
      : 'The confirmation has been used. The next change asks for the account password again.';
    box.replaceChildren(notice(h('div', null, h('p', null, text), h('div', { class: 'lm-parental-actions' }, lock)), { type: session.elevated ? 'info' : 'warn', title: 'Parental controls' }));
  };
  const off = bus.on('session:changed', draw);
  ctx.onDestroy(off);
  draw();
  return box;
}

function detailsSection() {
  const a = session.account;
  const alert = h('div', { role: 'alert' });
  const nameF = field({ label: 'Display name', name: 'displayName', value: a.displayName, maxlength: 40, required: true, autocomplete: 'nickname' });
  const emailF = field({ label: 'Email', name: 'email', type: 'email', value: a.email, required: true, autocomplete: 'email' });
  const pwF = passwordField({ label: 'Current password', name: 'currentPassword', hint: 'Needed to change your email. We’ll also let your current address know.' });
  pwF.hidden = true;
  emailF.control.addEventListener('input', () => {
    pwF.hidden = emailF.control.value.trim().toLowerCase() === session.account.email;
  });
  const save = button('Save changes', { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'lm-form', novalidate: true }, alert, nameF, emailF, pwF, h('div', { class: 'lm-form-actions' }, save));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.replaceChildren();
    const displayName = nameF.control.value.trim();
    const email = emailF.control.value.trim();
    const changingEmail = email.toLowerCase() !== session.account.email;
    nameF.setError(displayName ? '' : 'Enter a display name.');
    if (!displayName) return nameF.control.focus();
    if (changingEmail && !pwF.control.value) {
      pwF.setError('Enter your current password to change your email.');
      return pwF.control.focus();
    }
    withBusy(save, async () => {
      try {
        const body = { displayName };
        if (changingEmail) Object.assign(body, { email, currentPassword: pwF.control.value });
        const res = await withReauth(() => api.account.update(body), { reason: grownUpReason('change account details') });
        if (res === undefined) return;
        await refreshSession();
        pwF.control.value = '';
        pwF.hidden = true;
        applyFieldErrors(form, null);
        toast(changingEmail ? `Saved. Sign-in and account emails now go to ${email}.` : 'Account details saved.', { type: 'success' });
      } catch (err) {
        if (err.fields) applyFieldErrors(form, err);
        else alert.replaceChildren(notice(err.message, { type: 'danger' }));
      }
    });
  });
  return section({ id: 'details', iconName: 'user', title: 'Account details', intro: 'Your name and the email you sign in with.' }, form);
}

function passwordSection() {
  const alert = h('div', { role: 'alert' });
  const currentF = passwordField({ label: 'Current password', name: 'currentPassword' });
  const nextF = passwordField({ label: 'New password', name: 'newPassword', autocomplete: 'new-password' });
  nextF.querySelector('.lm-pw').after(strengthMeter(nextF.control));
  const confirmF = passwordField({ label: 'Confirm new password', name: 'confirm', autocomplete: 'new-password' });
  const save = button('Change password', { variant: 'primary', type: 'submit' });
  const form = h('form', { class: 'lm-form', novalidate: true }, alert, currentF, nextF, confirmF, h('div', { class: 'lm-form-actions' }, save));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.replaceChildren();
    const currentPassword = currentF.control.value;
    const newPassword = nextF.control.value;
    currentF.setError(currentPassword ? '' : 'Enter your current password.');
    nextF.setError(newPassword.length >= 10 ? '' : 'Use at least 10 characters.');
    confirmF.setError(confirmF.control.value === newPassword ? '' : 'The passwords do not match.');
    const bad = [currentF, nextF, confirmF].find((f) => f.classList.contains('has-error'));
    if (bad) return bad.control.focus();
    withBusy(save, async () => {
      try {
        const res = await api.account.changePassword({ currentPassword, newPassword });
        form.reset();
        nextF.control.dispatchEvent(new Event('input'));
        toast(res?.revokedSessions ? `Password changed. ${res.revokedSessions} other ${res.revokedSessions === 1 ? 'device was' : 'devices were'} signed out.` : 'Password changed.', { type: 'success' });
        document.dispatchEvent(new CustomEvent('lm:sessions-changed'));
      } catch (err) {
        if (err.fields) applyFieldErrors(form, err);
        else alert.replaceChildren(notice(err.message, { type: 'danger' }));
      }
    });
  });
  return section({ id: 'password', iconName: 'key', title: 'Change password', intro: 'Changing your password signs out every other device.' }, form);
}

function sessionsSection(ctx) {
  const list = h('div', null, loading('Loading devices…'));
  const signOutOthers = button('Sign out everywhere else', { variant: 'ghost', icon: 'logout' });
  signOutOthers.addEventListener('click', async () => {
    if (!(await confirmDialog({ title: 'Sign out other devices?', message: 'Every other browser and device signed in to your account will be signed out. This device stays signed in.', confirmLabel: 'Sign out others' }))) return;
    withBusy(signOutOthers, async () => {
      try {
        const res = await withReauth(() => api.account.revokeOtherSessions(), { reason: grownUpReason('sign out other devices') });
        if (res === undefined) return;
        toast(res?.revoked ? `Signed out ${res.revoked} other ${res.revoked === 1 ? 'device' : 'devices'}.` : 'No other devices were signed in.', { type: 'success' });
        load();
      } catch (err) {
        toastError(err);
      }
    });
  });

  async function load() {
    try {
      const { items } = await api.account.sessions();
      signOutOthers.hidden = items.length < 2;
      list.replaceChildren(h('ul', { class: 'lm-sessions', role: 'list' }, ...items.map((s) => row(s))));
    } catch (err) {
      if (err.code === 'PARENTAL_CONTROL') {
        // A restricted profile is active and the grown-up's confirmation has been used.
        const show = button('Show devices', { variant: 'glass', size: 'sm', icon: 'lock' });
        show.addEventListener('click', async () => {
          if (await reauth({ reason: grownUpReason('see the devices signed in to this account') })) load();
        });
        signOutOthers.hidden = true;
        list.replaceChildren(h('p', { class: 'lm-muted lm-small' }, 'The device list needs the account password while this profile is active. '), show);
        return;
      }
      list.replaceChildren(errorState(err, { retry: load }));
    }
  }

  function row(s) {
    const { label, mobile } = describeAgent(s.userAgent);
    const revoke = s.current ? null : button('Sign out', { variant: 'ghost', size: 'sm', attrs: { 'aria-label': `Sign out ${label}, last active ${relativeTime(s.lastSeenAt)}` } });
    revoke?.addEventListener('click', () => withBusy(revoke, async () => {
      try {
        const res = await withReauth(() => api.account.revokeSession(s.id), { reason: grownUpReason('sign out a device') });
        if (res === undefined) return;
        announce(`${label} signed out`);
        toast(`${label} was signed out.`, { type: 'success' });
        load();
      } catch (err) {
        toastError(err);
      }
    }));
    return h('li', { class: 'lm-session' },
      h('span', { class: 'lm-session__icon', 'aria-hidden': 'true' }, icon(mobile ? 'tv' : 'device')),
      h('div', { class: 'lm-session__text' },
        h('strong', null, label, s.current ? h('span', { class: 'lm-badge lm-badge--ok' }, 'This device') : null),
        h('span', null, [s.ip && `IP ${s.ip}`, s.current ? 'Active now' : `Last active ${relativeTime(s.lastSeenAt)}`, `Signed in ${date(s.createdAt)}`].filter(Boolean).join(' · '))),
      revoke);
  }

  const onChanged = () => load();
  document.addEventListener('lm:sessions-changed', onChanged);
  ctx.onDestroy(() => document.removeEventListener('lm:sessions-changed', onChanged));
  load();
  return section({ id: 'sessions', iconName: 'device', title: 'Where you’re signed in', intro: 'Browsers and devices with access to your account. Sign out any you don’t recognise.' },
    list, h('div', { class: 'lm-form-actions' }, signOutOthers));
}

function twoFactorSection() {
  const body = h('div', { class: 'lm-stack' });
  const draw = () => (session.account.totpEnabled ? enabledView() : disabledView());

  function disabledView() {
    const start = button('Set up two-factor authentication', { variant: 'primary', icon: 'shield' });
    start.addEventListener('click', () => withBusy(start, async () => {
      try {
        const setup = await withReauth(() => api.account.setup2fa(), { reason: 'Confirm your password to set up two-factor authentication.' });
        if (setup) setupView(setup);
      } catch (err) {
        toastError(err);
      }
    }));
    body.replaceChildren(
      h('span', { class: 'lm-status-pill' }, 'Off'),
      h('p', { class: 'lm-muted lm-small' }, 'Add a second step to signing in: a 6-digit code from an authenticator app such as 1Password, Google Authenticator, Microsoft Authenticator or Aegis.'),
      h('div', { class: 'lm-form-actions' }, start));
  }

  function setupView({ secret, otpauthUrl }) {
    const grouped = secret.match(/.{1,4}/g).join(' ');
    const copy = button('Copy key', { variant: 'glass', size: 'sm', icon: 'copy' });
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(secret);
        toast('Key copied.', { type: 'success', timeout: 2000 });
      } catch {
        toast('Copy was blocked by the browser — select the key and copy it manually.', { type: 'error' });
      }
    });
    const alert = h('div', { role: 'alert' });
    const codeF = field({ label: 'Code from your app', name: 'code', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 8, required: true });
    codeF.control.classList.add('lm-code-input');
    const verify = button('Turn on', { variant: 'primary', type: 'submit' });
    const cancel = button('Cancel', { variant: 'ghost', onClick: () => draw() });
    const form = h('form', { class: 'lm-form', novalidate: true }, alert, codeF, h('div', { class: 'lm-form-actions' }, verify, cancel));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const code = codeF.control.value.replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) {
        codeF.setError('Enter the 6-digit code.');
        return codeF.control.focus();
      }
      withBusy(verify, async () => {
        try {
          await api.account.enable2fa({ code });
          await refreshSession();
          toast('Two-factor authentication is on.', { type: 'success' });
          draw();
        } catch (err) {
          if (err.fields) applyFieldErrors(form, err);
          else alert.replaceChildren(notice(err.message, { type: 'danger' }));
        }
      });
    });
    body.replaceChildren(h('ol', { class: 'lm-totp-steps' },
      h('li', null, h('strong', null, 'Add Lumina to your authenticator app'),
        h('p', { class: 'lm-muted lm-small' }, 'On this device, open the link below. Elsewhere, choose “enter a setup key” in your app and type this key (time-based, 6 digits).'),
        h('div', { class: 'lm-totp-key' }, h('code', { 'aria-label': `Setup key ${secret.split('').join(' ')}` }, grouped), copy),
        h('p', { class: 'lm-small', style: { marginTop: '10px' } }, h('a', { class: 'lm-link', href: otpauthUrl }, 'Open in authenticator app'))),
      h('li', null, h('strong', null, 'Enter the code it shows'), form)));
    setTimeout(() => codeF.control.focus({ preventScroll: true }), 50);
  }

  function enabledView() {
    const off = button('Turn off', { variant: 'danger' });
    off.addEventListener('click', () => disableDialog());
    body.replaceChildren(
      h('span', { class: 'lm-status-pill lm-status-pill--on' }, 'On'),
      h('p', { class: 'lm-muted lm-small' }, 'Signing in needs your password and a code from your authenticator app. Keep your app backed up — if you lose it, you’ll need your password and a working code to turn this off.'),
      h('div', { class: 'lm-form-actions' }, off));
  }

  function disableDialog() {
    const formId = newUid('tfa-off');
    const alert = h('div', { role: 'alert' });
    const pwF = passwordField();
    const codeF = field({ label: 'Authentication code', name: 'code', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 8, required: true });
    codeF.control.classList.add('lm-code-input');
    const form = h('form', { id: formId, class: 'lm-form', novalidate: true }, h('p', { class: 'lm-muted' }, 'Your account will be protected by your password only.'), alert, pwF, codeF);
    let modal;
    const confirm = button('Turn off', { variant: 'danger', type: 'submit', attrs: { form: formId } });
    modal = openModal({ title: 'Turn off two-factor authentication?', content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), confirm] });
    setTimeout(() => pwF.control.focus(), 40);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      alert.replaceChildren();
      withBusy(confirm, async () => {
        try {
          await api.account.disable2fa({ password: pwF.control.value, code: codeF.control.value.replace(/\s+/g, '') });
          await refreshSession();
          modal.close();
          toast('Two-factor authentication is off.', { type: 'success' });
          draw();
        } catch (err) {
          if (err.fields) applyFieldErrors(form, err);
          else alert.replaceChildren(notice(err.message, { type: 'danger' }));
        }
      });
    });
  }

  draw();
  return section({ id: '2fa', iconName: 'shield', title: 'Two-factor authentication', intro: 'Protect your account even if someone learns your password.' }, body);
}

function planSection() {
  const body = h('div', null, loading('Loading plan…'));
  api.account.plan().then((plan) => {
    body.replaceChildren(h('div', { class: 'lm-plan' },
      h('div', null,
        h('span', { class: 'lm-eyebrow' }, 'Current plan'),
        h('h3', null, plan.plan || 'Lumina Free'),
        h('p', null, plan.billing ? 'Billing is managed by the payment provider.' : 'Every published title is included. No payment details are stored — Lumina doesn’t collect payments.')),
      h('span', { class: 'lm-badge lm-badge--4k' }, plan.mode === 'free' ? 'Free' : plan.mode)),
    h('p', { class: 'lm-muted lm-small' }, 'Profiles are part of your account — up to five people can have their own profile at no extra cost.'));
  }).catch((err) => body.replaceChildren(errorState(err)));
  return section({ id: 'plan', iconName: 'sparkle', title: 'Plan', intro: 'What your account includes.' }, body);
}

function dataSection(ctx) {
  const download = button('Download a copy', { variant: 'glass', icon: 'download' });
  download.addEventListener('click', () => withBusy(download, async () => {
    try {
      const data = await withReauth(() => api.account.exportData(), { reason: grownUpReason('download the account’s data') });
      if (data === undefined) return;
      downloadJson(data, `lumina-data-${new Date().toISOString().slice(0, 10)}.json`);
      toast('Your data is downloading as a JSON file.', { type: 'success' });
    } catch (err) {
      toastError(err);
    }
  }));
  const del = button('Delete account…', { variant: 'danger', icon: 'trash' });
  del.addEventListener('click', () => deleteDialog(ctx));
  return section({ id: 'data', iconName: 'download', title: 'Your data', intro: 'Take a copy of what Lumina stores about you, or delete your account.', danger: false },
    h('div', { class: 'lm-stack lm-stack--sm' },
      h('strong', null, 'Download your data'),
      h('p', { class: 'lm-muted lm-small' }, 'A JSON file with your account, profiles, lists, progress, history, collections, reviews, comments, notifications and creator submissions. Passwords, PINs and two-factor secrets are never included.'),
      h('div', null, download)),
    h('hr', { class: 'lm-divider' }),
    h('div', { class: 'lm-stack lm-stack--sm' },
      h('strong', null, 'Delete your account'),
      h('p', { class: 'lm-muted lm-small' }, 'Permanently removes your account and everything in it. This cannot be undone.'),
      h('div', null, del)));
}

function deleteDialog(ctx) {
  const formId = newUid('delete');
  const alert = h('div', { role: 'alert' });
  const pwF = passwordField();
  const confirmF = field({ label: 'Type DELETE to confirm', name: 'confirm', autocomplete: 'off', required: true });
  confirmF.control.setAttribute('autocapitalize', 'characters');
  confirmF.control.setAttribute('spellcheck', 'false');
  const form = h('form', { id: formId, class: 'lm-form', novalidate: true },
    notice('This permanently deletes:', { type: 'danger' }),
    h('ul', { class: 'lm-delete-list' },
      h('li', null, 'your account, sign-in details and every profile'),
      h('li', null, 'My List, collections, watch progress, history and preferences'),
      h('li', null, 'your reviews, comments, notifications and creator submissions')),
    h('p', { class: 'lm-muted lm-small' }, 'Consider downloading a copy of your data first. Lumina’s security log keeps its entries about this account — such as when it was registered, changed and deleted — with the account’s email address. See “How long we keep data” in the ',
      h('a', { class: 'lm-link', href: '#/legal/privacy' }, 'Privacy Policy'), '.'),
    alert, pwF, confirmF);
  let modal;
  const confirm = button('Delete my account', { variant: 'danger', type: 'submit', disabled: true, attrs: { form: formId } });
  confirmF.control.addEventListener('input', () => {
    confirm.disabled = confirmF.control.value !== 'DELETE';
  });
  modal = openModal({ title: 'Delete your account?', content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), confirm] });
  setTimeout(() => pwF.control.focus(), 40);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.replaceChildren();
    if (confirmF.control.value !== 'DELETE') {
      confirmF.setError('Type DELETE in capital letters.');
      return confirmF.control.focus();
    }
    withBusy(confirm, async () => {
      try {
        await api.account.remove({ password: pwF.control.value, confirm: 'DELETE' });
        modal.close();
        await refreshSession().catch(() => {});
        toast('Your account has been deleted. Thank you for visiting the garden.', { type: 'success', timeout: 6000 });
        ctx.navigate('/', { replace: true });
      } catch (err) {
        if (err.fields) applyFieldErrors(form, err);
        else alert.replaceChildren(notice(err.message, { type: 'danger' }));
      }
    }).then(() => {
      confirm.disabled = confirmF.control.value !== 'DELETE';
    });
  });
}

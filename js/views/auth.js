// Sign in, create an account, and password recovery (/login, /register, /forgot, /reset).
// One elegant panel over the garden. Also exports the password field, strength hint and
// `next` helpers used by the profile and account views.
import { h, newUid } from '../core/dom.js';
import { api } from '../api/client.js';
import { session, refreshSession } from '../core/session.js';
import { reload } from '../core/router.js';
import { date } from '../core/format.js';
import { applyFieldErrors, button, field, linkButton, notice, toast, toastError, withBusy } from '../ui/components.js';
import { icon, logoMark } from '../ui/icons.js';

const AUTH_PATHS = /^\/(login|register|forgot|reset)(\/|\?|$)/;

/** A safe in-app destination from a `next` query value (never another origin, never back to auth). */
export function safeNext(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('/') || s.startsWith('//') || s.includes('\\') || AUTH_PATHS.test(s)) return '/';
  return s;
}

/** After signing in: go to `next`, via the profile picker when no profile is active yet. */
export async function continueAfterAuth(navigate, next) {
  await refreshSession();
  if (session.profile) navigate(next, { replace: true });
  else navigate(`/profiles?next=${encodeURIComponent(next)}`, { replace: true });
}

// ── Password field with show/hide ─────────────────────────
export function passwordField({ label = 'Password', name = 'password', autocomplete = 'current-password', hint, required = true } = {}) {
  const f = field({ label, name, type: 'password', autocomplete, hint, required });
  const input = f.control;
  input.setAttribute('autocapitalize', 'none');
  input.setAttribute('spellcheck', 'false');
  const toggle = h('button', { type: 'button', class: 'lm-pw__toggle', 'aria-label': `Show ${label.toLowerCase()}`, 'aria-pressed': 'false', 'aria-controls': input.id }, icon('eye'));
  toggle.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    toggle.setAttribute('aria-pressed', String(show));
    toggle.replaceChildren(icon(show ? 'eyeOff' : 'eye'));
    input.focus({ preventScroll: true });
  });
  const wrap = h('div', { class: 'lm-pw' });
  input.replaceWith(wrap);
  wrap.append(input, toggle);
  return f;
}

// ── Strength hint (advisory; the server enforces the real policy) ──
const GUESSABLE = /(password|passw0rd|qwerty|asdfgh|zxcvbn|123456|654321|letmein|iloveyou|welcome|admin|lumina|abc123|111111|000000)/i;

export function passwordStrength(pw, email = '') {
  if (!pw) return { score: 0, text: 'Use 10 or more characters. A short phrase of a few words works well.' };
  if (pw.length < 10) return { score: 1, text: `Too short — ${10 - pw.length} more character${10 - pw.length === 1 ? '' : 's'} needed.` };
  const lower = pw.toLowerCase();
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 3 && lower.includes(local)) return { score: 1, text: 'Avoid using your email address in your password.' };
  if (/^(.)\1+$/.test(pw) || (GUESSABLE.test(pw) && pw.length < 18)) return { score: 1, text: 'Too easy to guess. Try a phrase that is unique to you.' };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  let score = 2;
  if (pw.length >= 14 || classes >= 3) score++;
  if (pw.length >= 20 || (pw.length >= 14 && classes >= 3)) score++;
  return { score, text: ['', 'Weak', 'Fair — longer is stronger.', 'Good password.', 'Strong password.'][score] };
}

export function strengthMeter(input, { emailInput } = {}) {
  const labelId = newUid('strength');
  const label = h('span', { class: 'lm-strength__label', id: labelId });
  const el = h('div', { class: 'lm-strength', 'data-score': '0' },
    h('div', { class: 'lm-strength__bars', 'aria-hidden': 'true' }, ...[0, 1, 2, 3].map(() => h('span', { class: 'lm-strength__bar' }))),
    label);
  input.setAttribute('aria-describedby', `${input.getAttribute('aria-describedby') || ''} ${labelId}`.trim());
  const update = () => {
    const { score, text } = passwordStrength(input.value, emailInput?.value);
    el.dataset.score = String(score);
    label.textContent = text;
  };
  input.addEventListener('input', update);
  emailInput?.addEventListener('input', update);
  update();
  return el;
}

// ── Shell ─────────────────────────────────────────────────
function shell() {
  const titleId = newUid('auth');
  const heading = h('h1', { id: titleId });
  const sub = h('p', { class: 'lm-auth__sub' });
  const body = h('div', { class: 'lm-auth__body' });
  const foot = h('div', { class: 'lm-auth__foot' });
  const panel = h('section', { class: 'lm-auth__panel', 'aria-labelledby': titleId },
    h('a', { class: 'lm-auth__brand', href: '#/', 'aria-label': 'Lumina home' },
      logoMark('lm-auth__mark'),
      h('span', { class: 'lm-auth__word', 'aria-hidden': 'true' }, 'LUMINA'),
      h('span', { class: 'lm-auth__kana', lang: 'ja', 'aria-hidden': 'true' }, 'ルミナ')),
    heading, sub, body, foot);
  const root = h('div', { class: 'lm-auth' }, panel);
  /** Swaps the panel content; moves focus to the heading (or `focus`) for keyboard and SR users. */
  root.show = ({ title, subtitle, content, footer, focus }) => {
    heading.textContent = title;
    sub.textContent = subtitle || '';
    sub.hidden = !subtitle;
    body.replaceChildren(...[content].flat().filter(Boolean));
    foot.replaceChildren(...[footer].flat().filter(Boolean));
    foot.hidden = !footer;
    if (root.isConnected) {
      requestAnimationFrame(() => {
        if (focus) focus.focus();
        else {
          heading.setAttribute('tabindex', '-1');
          heading.focus({ preventScroll: true });
        }
      });
    }
  };
  return root;
}

const alertRegion = () => h('div', { class: 'lm-auth__alert', role: 'alert' });
const minutes = (s) => Math.max(1, Math.ceil((Number(s) || 60) / 60));

function describeError(err) {
  switch (err?.code) {
    case 'INVALID_CREDENTIALS':
      return notice('That email and password combination is not correct.', { type: 'danger' });
    case 'ACCOUNT_LOCKED':
      return notice(h('span', null, `For your security, sign-in for this account is paused for ${minutes(err.retryAfter)} minute${minutes(err.retryAfter) === 1 ? '' : 's'} after several unsuccessful attempts. `, h('a', { href: '#/forgot' }, 'Reset your password'), ' if you have forgotten it.'), { type: 'warn', title: 'Too many attempts' });
    case 'ACCOUNT_SUSPENDED': {
      const reason = err.extra?.reason;
      const until = err.extra?.until;
      return notice(h('span', null,
        until ? `This account is suspended until ${date(until, { year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.` : 'This account is suspended.',
        reason ? ` Reason: ${reason}.` : '',
        ' If you think this is a mistake, ', h('a', { href: '#/legal/contact' }, 'contact support'), '.'), { type: 'danger', title: 'Account suspended' });
    }
    case 'RATE_LIMITED':
      return notice(`Too many attempts from this device. Please wait about ${minutes(err.retryAfter)} minute${minutes(err.retryAfter) === 1 ? '' : 's'} and try again.`, { type: 'warn' });
    case 'NETWORK':
      return notice(err.message, { type: 'warn' });
    default:
      return notice(err?.message || 'Something went wrong. Please try again.', { type: 'danger' });
  }
}

function termsError(msg) {
  return h('span', { class: 'lm-error-text', id: newUid('terms-err'), hidden: !msg }, msg || '');
}

// ── Views ─────────────────────────────────────────────────
export default async function render(ctx) {
  const next = safeNext(ctx.query.get('next'));
  const root = shell();
  const mode = ctx.path.slice(1);
  if ((mode === 'login' || mode === 'register') && session.account) signedIn(ctx, root, next);
  else if (mode === 'register') registerView(ctx, root, next);
  else if (mode === 'forgot') forgotView(ctx, root);
  else if (mode === 'reset') resetView(ctx, root);
  else loginView(ctx, root, next);
  return root;
}

function nextQuery(next) {
  return next && next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
}

function signedIn(ctx, root, next) {
  ctx.setTitle('Signed in');
  const signOut = button('Sign out', { variant: 'ghost', block: true });
  signOut.addEventListener('click', () => withBusy(signOut, async () => {
    try {
      await api.auth.logout();
      await refreshSession();
      reload();
    } catch (err) {
      toastError(err);
    }
  }));
  const go = button('Continue', { variant: 'primary', size: 'lg', block: true, iconRight: 'arrowRight', onClick: () => continueAfterAuth(ctx.navigate, next) });
  root.show({
    title: 'You’re signed in',
    subtitle: `Signed in as ${session.account.email}.`,
    content: h('div', { class: 'lm-stack' }, go, signOut),
  });
}

function loginView(ctx, root, next) {
  ctx.setTitle('Sign in');
  let credentials = null;
  const alert = alertRegion();
  const emailF = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'username', required: true, value: ctx.query.get('email') || '' });
  emailF.control.setAttribute('autocapitalize', 'none');
  emailF.control.setAttribute('spellcheck', 'false');
  const pwF = passwordField();
  const submit = button('Sign in', { variant: 'primary', size: 'lg', type: 'submit', block: true });
  const forgot = h('a', { class: 'lm-link lm-small', href: '#/forgot' }, 'Forgot your password?');
  const syncForgot = () => {
    const email = emailF.control.value.trim();
    forgot.setAttribute('href', email ? `#/forgot?email=${encodeURIComponent(email)}` : '#/forgot');
  };
  emailF.control.addEventListener('input', syncForgot);
  syncForgot();
  const form = h('form', { class: 'lm-form', novalidate: true }, alert, emailF, pwF, h('div', { class: 'lm-auth__row' }, forgot), submit);

  const signIn = async (body, { onTotp, onError }) => {
    try {
      await api.auth.login(body);
      await continueAfterAuth(ctx.navigate, next);
      toast(`Welcome back, ${session.account?.displayName || 'friend'}.`, { type: 'success', timeout: 2600 });
    } catch (err) {
      if (err.code === 'TOTP_REQUIRED') return onTotp();
      onError(err);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.replaceChildren();
    const email = emailF.control.value.trim();
    const password = pwF.control.value;
    emailF.setError(email ? '' : 'Enter your email address.');
    pwF.setError(password ? '' : 'Enter your password.');
    if (!email) return emailF.control.focus();
    if (!password) return pwF.control.focus();
    credentials = { email, password };
    withBusy(submit, () => signIn(credentials, {
      onTotp: () => totpStep(),
      onError: (err) => {
        if (err.code === 'VALIDATION_FAILED') applyFieldErrors(form, err);
        else alert.replaceChildren(describeError(err));
        if (err.code === 'INVALID_CREDENTIALS') {
          pwF.control.select();
          pwF.control.focus();
        }
      },
    }));
  });

  function totpStep() {
    const totpAlert = alertRegion();
    const codeF = field({ label: 'Authentication code', name: 'totp', autocomplete: 'one-time-code', inputmode: 'numeric', maxlength: 8, required: true, hint: 'Open your authenticator app and enter the 6-digit code for Lumina.' });
    codeF.control.classList.add('lm-code-input');
    const verify = button('Verify', { variant: 'primary', size: 'lg', type: 'submit', block: true });
    const back = button('Use a different account', { variant: 'ghost', block: true, onClick: () => showLogin() });
    const totpForm = h('form', { class: 'lm-form', novalidate: true }, totpAlert, codeF, verify, back);
    const submitCode = () => {
      const code = codeF.control.value.replace(/\s+/g, '');
      if (!/^\d{6}$/.test(code)) {
        codeF.setError('Enter the 6-digit code.');
        return codeF.control.focus();
      }
      codeF.setError('');
      totpAlert.replaceChildren();
      withBusy(verify, () => signIn({ ...credentials, totp: code }, {
        onTotp: () => codeF.setError('Enter the 6-digit code.'),
        onError: (err) => {
          if (err.code === 'INVALID_TOTP') {
            codeF.setError(err.extra?.reused
              ? 'That code has already been used. Wait for the next code in your authenticator app.'
              : 'That code did not match. Codes change every 30 seconds — try the current one.');
            codeF.control.select();
            codeF.control.focus();
          } else totpAlert.replaceChildren(describeError(err));
        },
      }));
    };
    totpForm.addEventListener('submit', (e) => {
      e.preventDefault();
      submitCode();
    });
    codeF.control.addEventListener('input', () => {
      if (/^\d{6}$/.test(codeF.control.value.replace(/\s+/g, ''))) submitCode();
    });
    root.show({ title: 'Two-step verification', subtitle: 'Your password was correct. One more step to keep your account safe.', content: totpForm, focus: codeF.control });
  }

  function showLogin() {
    root.show({
      title: 'Welcome back',
      subtitle: 'Sign in to continue to your garden of stories.',
      content: form,
      footer: h('p', null, 'New to Lumina? ', h('a', { href: `#/register${nextQuery(next)}` }, 'Create an account')),
      focus: credentials ? pwF.control : undefined,
    });
  }
  showLogin();
}

function registerView(ctx, root, next) {
  ctx.setTitle('Create account');
  if (session.features?.registration === false) {
    root.show({
      title: 'Registration is closed',
      subtitle: 'This Lumina server is not accepting new accounts right now.',
      content: linkButton('Sign in instead', `#/login${nextQuery(next)}`, { variant: 'primary', size: 'lg', className: 'lm-btn--block' }),
    });
    return;
  }
  const alert = alertRegion();
  const nameF = field({ label: 'Your name', name: 'displayName', autocomplete: 'nickname', required: true, maxlength: 40, hint: 'Shown on your first profile. You can change it later.' });
  const emailF = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true });
  emailF.control.setAttribute('autocapitalize', 'none');
  emailF.control.setAttribute('spellcheck', 'false');
  const pwF = passwordField({ autocomplete: 'new-password' });
  const meter = strengthMeter(pwF.control, { emailInput: emailF.control });
  pwF.querySelector('.lm-pw').after(meter);
  const confirmF = passwordField({ label: 'Confirm password', name: 'confirm', autocomplete: 'new-password' });
  const terms = h('input', { type: 'checkbox', name: 'acceptTerms', required: true });
  const termsErr = termsError('');
  terms.setAttribute('aria-describedby', termsErr.id);
  const newTab = h('span', { class: 'visually-hidden' }, ' (opens in a new tab)');
  const termsLabel = h('label', { class: 'lm-checkbox' }, terms, h('span', null,
    'I agree to the ', h('a', { href: '#/legal/terms', target: '_blank', rel: 'noopener' }, 'Terms of Service', newTab.cloneNode(true)),
    ' and have read the ', h('a', { href: '#/legal/privacy', target: '_blank', rel: 'noopener' }, 'Privacy Policy', newTab.cloneNode(true)), '.'));
  const submit = button('Create account', { variant: 'primary', size: 'lg', type: 'submit', block: true });
  const form = h('form', { class: 'lm-form', novalidate: true }, alert, nameF, emailF, pwF, confirmF, h('div', { class: 'lm-field' }, termsLabel, termsErr), submit,
    h('p', { class: 'lm-auth__fine' }, 'Lumina Free — no payment details are needed or stored.'));

  const setTermsError = (msg) => {
    termsErr.hidden = !msg;
    termsErr.textContent = msg || '';
    terms.setAttribute('aria-invalid', msg ? 'true' : 'false');
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.replaceChildren();
    const values = {
      displayName: nameF.control.value.trim(),
      email: emailF.control.value.trim(),
      password: pwF.control.value,
      acceptTerms: terms.checked,
    };
    const problems = [
      [nameF, values.displayName ? '' : 'Tell us what to call you.'],
      [emailF, /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(values.email) ? '' : 'Enter a valid email address.'],
      [pwF, values.password.length >= 10 ? '' : 'Use at least 10 characters.'],
      [confirmF, confirmF.control.value === values.password ? '' : 'The passwords do not match.'],
    ];
    for (const [f, msg] of problems) f.setError(msg);
    setTermsError(values.acceptTerms ? '' : 'Please accept the Terms of Service and Privacy Policy to continue.');
    const first = problems.find(([, msg]) => msg);
    if (first) return first[0].control.focus();
    if (!values.acceptTerms) return terms.focus();
    withBusy(submit, async () => {
      try {
        await api.auth.register(values);
        toast(`Welcome to Lumina, ${values.displayName}.`, { type: 'success' });
        await continueAfterAuth(ctx.navigate, next);
      } catch (err) {
        if (err.code === 'VALIDATION_FAILED' || err.code === 'EMAIL_TAKEN') {
          applyFieldErrors(form, err);
          if (err.fields?.acceptTerms) setTermsError(err.fields.acceptTerms);
          if (err.code === 'EMAIL_TAKEN') {
            alert.replaceChildren(notice(h('span', null, 'An account with that email already exists. ', h('a', { href: `#/login${nextQuery(next)}` }, 'Sign in'), ' or ', h('a', { href: '#/forgot' }, 'reset your password'), '.'), { type: 'warn' }));
          }
        } else alert.replaceChildren(describeError(err));
      }
    });
  });

  root.show({
    title: 'Create your account',
    subtitle: 'One account for your household — up to five profiles, each with its own list and recommendations.',
    content: form,
    footer: h('p', null, 'Already have an account? ', h('a', { href: `#/login${nextQuery(next)}` }, 'Sign in')),
  });
}

function forgotView(ctx, root) {
  ctx.setTitle('Reset password');
  const alert = alertRegion();
  const emailF = field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true, value: ctx.query.get('email') || '' });
  emailF.control.setAttribute('autocapitalize', 'none');
  const submit = button('Send reset link', { variant: 'primary', size: 'lg', type: 'submit', block: true });
  const form = h('form', { class: 'lm-form', novalidate: true }, alert, emailF, submit);
  const footer = h('p', null, 'Remembered it? ', h('a', { href: '#/login' }, 'Back to sign in'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.replaceChildren();
    const email = emailF.control.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      emailF.setError('Enter the email address you signed up with.');
      return emailF.control.focus();
    }
    emailF.setError('');
    withBusy(submit, async () => {
      try {
        await api.auth.forgot({ email });
        sent(email);
      } catch (err) {
        if (err.code === 'VALIDATION_FAILED') applyFieldErrors(form, err);
        else alert.replaceChildren(describeError(err));
      }
    });
  });

  function sent(email) {
    const again = button('Send another link', { variant: 'ghost', block: true, onClick: () => showForm() });
    root.show({
      title: 'Check your email',
      content: h('div', { class: 'lm-auth__done' },
        icon('mail'),
        h('p', null, 'If an account exists for ', h('strong', null, email), ', we’ve sent a link to reset its password. The link works once and expires in 60 minutes.'),
        h('p', { class: 'lm-auth__fine' }, 'Nothing after a few minutes? Check your spam folder or send another link. (Running your own Lumina server without a mail provider? Messages are written to the server log instead.)'),
        linkButton('Back to sign in', `#/login?email=${encodeURIComponent(email)}`, { variant: 'primary', size: 'lg', className: 'lm-btn--block' }),
        again),
    });
  }

  function showForm() {
    root.show({
      title: 'Forgot your password?',
      subtitle: 'Enter your email and we’ll send you a link to choose a new one.',
      content: form,
      footer,
    });
  }
  showForm();
}

function resetView(ctx, root) {
  ctx.setTitle('Choose a new password');
  const token = ctx.query.get('token') || '';
  const requestNew = linkButton('Request a new link', '#/forgot', { variant: 'primary', size: 'lg', className: 'lm-btn--block' });
  if (!token) {
    root.show({ title: 'This link is incomplete', subtitle: 'Password reset links come by email. Open the whole link from the message, or request a new one.', content: requestNew });
    return;
  }
  const alert = alertRegion();
  const pwF = passwordField({ label: 'New password', autocomplete: 'new-password' });
  pwF.querySelector('.lm-pw').after(strengthMeter(pwF.control));
  const confirmF = passwordField({ label: 'Confirm new password', name: 'confirm', autocomplete: 'new-password' });
  const submit = button('Change password', { variant: 'primary', size: 'lg', type: 'submit', block: true });
  const form = h('form', { class: 'lm-form', novalidate: true }, alert, pwF, confirmF, submit,
    h('p', { class: 'lm-auth__fine' }, 'For your security, every device signed in to your account will be signed out.'));

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    alert.replaceChildren();
    const password = pwF.control.value;
    pwF.setError(password.length >= 10 ? '' : 'Use at least 10 characters.');
    confirmF.setError(confirmF.control.value === password ? '' : 'The passwords do not match.');
    if (password.length < 10) return pwF.control.focus();
    if (confirmF.control.value !== password) return confirmF.control.focus();
    withBusy(submit, async () => {
      try {
        await api.auth.reset({ token, password });
        await refreshSession().catch(() => {});
        root.show({
          title: 'Password changed',
          content: h('div', { class: 'lm-auth__done' },
            icon('checkCircle'),
            h('p', null, 'Your new password is set, and every device has been signed out. Sign in again to continue.'),
            linkButton('Sign in', '#/login', { variant: 'primary', size: 'lg', className: 'lm-btn--block' })),
        });
      } catch (err) {
        if (err.code === 'VALIDATION_FAILED') applyFieldErrors(form, err);
        else if (err.code === 'RESET_INVALID') {
          alert.replaceChildren(notice(h('span', null, 'This reset link is invalid, has already been used or has expired. ', h('a', { href: '#/forgot' }, 'Request a new link'), '.'), { type: 'warn' }));
        } else alert.replaceChildren(describeError(err));
      }
    });
  });

  root.show({ title: 'Choose a new password', subtitle: 'Use at least 10 characters. A phrase of a few unrelated words is easy to remember and hard to guess.', content: form });
}

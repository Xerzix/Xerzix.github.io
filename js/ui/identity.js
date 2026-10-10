// Switching identity (separate Lumina accounts) from "Who's watching?", the navigation menu
// and Settings → Account & Profiles. A switch always asks the server for a new authenticated
// session for the chosen account (POST /api/identities/switch); the interface then reloads the
// session, so the watchlist, history, settings and recommendations shown are that account's.
import { h, newUid } from '../core/dom.js';
import { api, ApiError } from '../api/client.js';
import { refreshSession, session } from '../core/session.js';
import { currentRoute, navigate } from '../core/router.js';
import { store } from '../core/storage.js';
import { applyFieldErrors, button, checkbox, field, formValues, notice, openModal, toast, toastError, withBusy } from './components.js';
import { avatar, IDENTITY_AVATARS } from './avatars.js';
import { icon } from './icons.js';

const CHOSEN_KEY = 'identityChosen';

/** "Who's watching?" is shown once per browser session; this records that it was answered. */
export function markIdentityChosen() {
  try {
    sessionStorage.setItem(`lumina.${CHOSEN_KEY}`, '1');
  } catch {
    /* storage unavailable: the screen simply shows again next launch */
  }
}

export function identityChosen() {
  try {
    return sessionStorage.getItem(`lumina.${CHOSEN_KEY}`) === '1';
  } catch {
    return true;
  }
}

async function afterSwitch(next = '/') {
  await refreshSession();
  markIdentityChosen();
  toast(`Now watching as ${session.account?.username || session.account?.displayName || 'you'}.`, { type: 'success', timeout: 2800 });
  navigate(next || '/', { replace: true });
}

/** Leaves the player (which saves playback progress as it closes) before the account changes. */
async function leavePlayback() {
  const page = currentRoute()?.route?.page;
  if (page === 'watch' || page === 'party') {
    navigate('/', { replace: true });
    await new Promise((r) => setTimeout(r, 250));
  }
}

/**
 * Switches to an identity listed on this device. Remembered identities switch at once; the
 * others ask for their password (and a two-factor code when enabled).
 */
export async function switchToIdentity(identity, { next = '/' } = {}) {
  if (identity.active) {
    markIdentityChosen();
    navigate(next || '/', { replace: true });
    return true;
  }
  await leavePlayback();
  if (identity.remembered) {
    try {
      await api.identities.switch({ accountId: identity.id });
      await afterSwitch(next);
      return true;
    } catch (err) {
      if (!(err instanceof ApiError) || err.code !== 'PASSWORD_REQUIRED') {
        toastError(err);
        return false;
      }
    }
  }
  return identityPasswordDialog(identity, { next });
}

/** Password (+ code) prompt for one identity. Resolves true when the switch succeeded. */
export function identityPasswordDialog(identity, { next = '/' } = {}) {
  const pw = field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const code = field({ label: 'Two-factor code', name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8, hint: 'The 6-digit code from your authenticator app.' });
  code.hidden = true;
  const remember = checkbox('Keep me signed in on this device', { name: 'remember', description: 'For 30 days, or until you sign out. Leave unticked on shared devices.' });
  const status = h('p', { class: 'lm-form-error', role: 'alert' });
  const submit = button(`Continue as ${identity.username}`, { variant: 'primary', type: 'submit', block: true });
  const form = h('form', { class: 'lm-stack', novalidate: true },
    h('div', { class: 'lm-who-dialog__who' }, avatar(identity.avatar, { size: 72 }),
      h('div', null, h('strong', null, identity.displayName || identity.username), h('span', { class: 'lm-muted' }, `@${identity.username}`))),
    pw, code, remember, status, submit);
  let resolve;
  const done = new Promise((r) => (resolve = r));
  const modal = openModal({ title: 'Enter your password', content: form, size: 'sm', onClose: () => resolve(false) });
  setTimeout(() => pw.control.focus(), 40);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = formValues(form);
    status.textContent = '';
    withBusy(submit, async () => {
      try {
        await api.identities.switch({ accountId: identity.id, password: v.password, totp: v.totp || undefined, remember: !!v.remember });
        resolve(true);
        modal.close();
        await afterSwitch(next);
      } catch (err) {
        if (err.code === 'TOTP_REQUIRED') {
          code.hidden = false;
          code.control.focus();
          status.textContent = err.message;
          return;
        }
        applyFieldErrors(form, err);
        status.textContent = err.message;
        if (!err.fields) pw.control.select();
      }
    });
  });
  return done;
}

/** Avatar chooser for the five identity pictures; pictures used by other identities are unavailable. */
export function identityAvatarPicker({ name = 'avatar', value, taken = new Set() } = {}) {
  const legendId = newUid('av');
  const first = value || IDENTITY_AVATARS.find((a) => !taken.has(a.id))?.id || IDENTITY_AVATARS[0].id;
  return h('fieldset', { class: 'lm-who-avatars', 'aria-labelledby': legendId },
    h('legend', { id: legendId, class: 'lm-label' }, 'Picture'),
    h('div', { class: 'lm-who-avatars__row' }, ...IDENTITY_AVATARS.map((a) => {
      const used = taken.has(a.id) && a.id !== value;
      return h('label', { class: ['lm-who-avatars__opt', used && 'is-taken'], title: used ? `${a.name} — used by another identity on this device` : a.name },
        h('input', { type: 'radio', name, value: a.id, checked: a.id === first, disabled: used }),
        avatar(a.id, { size: 64 }),
        h('span', { class: 'lm-who-avatars__name' }, a.name),
        used ? h('span', { class: 'visually-hidden' }, ' (in use)') : null);
    })));
}

/**
 * Adds an identity to this device: create a new account, or sign in to an existing one.
 * Both end signed in as that identity.
 */
export function addIdentityDialog({ taken = new Set(), mode = 'create', next = '/' } = {}) {
  const tabs = h('div', { class: 'lm-segmented lm-who-dialog__tabs', role: 'tablist' });
  const panel = h('div');
  const tabBtn = (id, label) => h('button', { type: 'button', role: 'tab', class: 'lm-segmented__opt', 'aria-selected': String(mode === id), onClick: () => show(id) }, label);
  const createTab = tabBtn('create', 'Create a new account');
  const signinTab = tabBtn('signin', 'Sign in to an account');
  tabs.append(createTab, signinTab);

  const modal = openModal({ title: 'Add an identity', content: [h('p', { class: 'lm-muted lm-small' }, 'Each identity is a separate Lumina account with its own username, password, list, history and settings.'), tabs, panel], size: 'md' });

  function createForm() {
    const status = h('p', { class: 'lm-form-error', role: 'alert' });
    const submit = button('Create account', { variant: 'primary', type: 'submit', block: true });
    const form = h('form', { class: 'lm-stack', novalidate: true },
      field({ label: 'Username', name: 'username', autocomplete: 'username', required: true, maxlength: 24, hint: '3–24 letters, numbers, dots, hyphens or underscores. Unique across Lumina.' }),
      field({ label: 'Display name (optional)', name: 'displayName', maxlength: 40, hint: 'Shown on your reviews. Defaults to your username.' }),
      field({ label: 'Email', name: 'email', type: 'email', autocomplete: 'email', required: true, hint: 'For password resets and security notices only.' }),
      field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: 'At least 10 characters; a short phrase works well.' }),
      identityAvatarPicker({ taken }),
      checkbox('Keep me signed in on this device', { name: 'remember', description: 'Switch to this identity without a password for 30 days, or until you sign out.' }),
      checkbox(h('span', null, 'I accept the ', h('a', { class: 'lm-link', href: '#/legal/terms', target: '_blank' }, 'Terms of Service'), ' and the ', h('a', { class: 'lm-link', href: '#/legal/privacy', target: '_blank' }, 'Privacy Policy'), '.'), { name: 'acceptTerms' }),
      status, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = formValues(form);
      status.textContent = '';
      withBusy(submit, async () => {
        try {
          await api.auth.register({ username: v.username, displayName: v.displayName || undefined, email: v.email, password: v.password, avatar: v.avatar, remember: !!v.remember, acceptTerms: v.acceptTerms === true });
          modal.close();
          await afterSwitch(next);
        } catch (err) {
          applyFieldErrors(form, err);
          status.textContent = err.code === 'VALIDATION_FAILED' ? 'Check the highlighted fields.' : err.message;
        }
      });
    });
    return form;
  }

  function signinForm() {
    const status = h('p', { class: 'lm-form-error', role: 'alert' });
    const code = field({ label: 'Two-factor code', name: 'totp', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 8 });
    code.hidden = true;
    const submit = button('Sign in', { variant: 'primary', type: 'submit', block: true });
    const form = h('form', { class: 'lm-stack', novalidate: true },
      field({ label: 'Username or email', name: 'identifier', autocomplete: 'username', required: true }),
      field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
      code,
      checkbox('Keep me signed in on this device', { name: 'remember' }),
      h('a', { class: 'lm-link lm-small', href: '#/forgot' }, 'Forgot your password?'),
      status, submit);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const v = formValues(form);
      status.textContent = '';
      withBusy(submit, async () => {
        try {
          await api.auth.login({ identifier: v.identifier, password: v.password, totp: v.totp || undefined, remember: !!v.remember });
          modal.close();
          await afterSwitch(next);
        } catch (err) {
          if (err.code === 'TOTP_REQUIRED') {
            code.hidden = false;
            code.control.focus();
          }
          applyFieldErrors(form, err);
          status.textContent = err.message;
        }
      });
    });
    return form;
  }

  function show(id) {
    mode = id;
    createTab.setAttribute('aria-selected', String(id === 'create'));
    signinTab.setAttribute('aria-selected', String(id === 'signin'));
    panel.replaceChildren(id === 'create' ? createForm() : signinForm());
    setTimeout(() => panel.querySelector('input')?.focus(), 30);
  }
  show(mode);
  return modal;
}

/** The account switcher dialog (navigation menu, Settings): the five identities on this device. */
export async function openAccountSwitcher() {
  let data;
  try {
    data = await api.identities.list();
  } catch (err) {
    toastError(err);
    return;
  }
  let modal;
  const list = h('ul', { class: 'lm-switcher', role: 'list' });
  const render = () => {
    list.replaceChildren(...data.identities.map((it) => h('li', null,
      h('button', {
        type: 'button',
        class: ['lm-switcher__item', it.active && 'is-active'],
        'aria-current': it.active ? 'true' : undefined,
        onClick: async () => {
          modal.close();
          await switchToIdentity(it, { next: it.active ? currentRoute()?.ctx?.raw || '/' : '/' });
        },
      },
      avatar(it.avatar, { size: 48 }),
      h('span', { class: 'lm-switcher__text' }, h('strong', null, it.displayName || it.username), h('span', null, `@${it.username}`)),
      h('span', { class: 'lm-switcher__state' }, it.active ? 'Signed in' : it.remembered ? 'Ready' : h('span', { class: 'lm-cluster lm-cluster--sm' }, icon('lock'), 'Password')))),
    ));
    if (data.freeSlots > 0) {
      list.append(h('li', null, h('button', {
        type: 'button',
        class: 'lm-switcher__item lm-switcher__item--add',
        onClick: () => {
          modal.close();
          addIdentityDialog({ taken: new Set(data.identities.map((x) => x.avatar)) });
        },
      }, h('span', { class: 'lm-switcher__plus', 'aria-hidden': 'true' }, icon('plus')), h('span', { class: 'lm-switcher__text' }, h('strong', null, 'Add an identity'), h('span', null, `${data.freeSlots} of ${data.max} slots free`)))));
    }
  };
  render();
  const content = [
    data.preview ? notice('Switching accounts needs the Lumina server. This copy of Lumina is running in Preview mode on static hosting.', { type: 'warn' }) : null,
    data.identities.length ? null : h('p', { class: 'lm-muted' }, 'No identities on this device yet.'),
    list,
    h('p', { class: 'lm-hint' }, `This device can show up to ${data.max} identities. Each is a separate account with its own password.`),
  ].filter(Boolean);
  modal = openModal({
    title: 'Switch account',
    content,
    size: 'sm',
    actions: [h('a', { class: 'lm-btn lm-btn--ghost', href: '#/whos-watching?manage=1', onClick: () => modal.close() }, icon('users'), h('span', null, 'Manage identities'))],
  });
  setTimeout(() => list.querySelector('button')?.focus(), 40);
}

/** Signs out of the current identity on this device (it stays listed, password required next time). */
export async function signOutIdentity() {
  await leavePlayback();
  try {
    await api.auth.logout();
  } catch {
    /* already signed out */
  }
  await refreshSession();
  navigate('/whos-watching', { replace: true });
}

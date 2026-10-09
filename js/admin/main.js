// Entry point of the administration app (admin.html). Access is decided before any staff
// data is requested: Preview mode → needs the server; signed out → sign in; not staff →
// access denied; staff → confirm password when needed, then the dashboard.
import { h } from '../core/dom.js';
import { api, initApi, ApiError } from '../api/client.js';
import { icon, logoMark } from '../ui/icons.js';
import { adminApi } from './api.js';
import { reauthenticate, startAdmin, staff } from './shell.js';

const root = document.getElementById('adm-root');

function gate(...children) {
  root.replaceChildren(h('main', { id: 'adm-main', class: 'adm-gate', tabindex: '-1' },
    h('div', { class: 'adm-gate__card' },
      h('div', { class: 'adm-gate__brand' }, logoMark('adm-brand__mark'), h('span', { class: 'adm-brand__word' }, 'LUMINA'), h('span', { class: 'adm-brand__tag' }, 'Admin')),
      ...children)));
  root.querySelector('h1')?.focus?.();
}

const backLink = () => h('a', { class: 'lm-btn lm-btn--ghost', href: 'index.html' }, icon('arrowLeft'), h('span', null, 'Back to Lumina'));

async function boot() {
  const mode = await initApi();
  document.documentElement.dataset.mode = mode;
  if (mode !== 'server') {
    gate(
      h('span', { class: 'lm-eyebrow' }, 'Preview mode'),
      h('h1', { class: 'adm-h1', tabindex: '-1' }, 'The dashboard needs the Lumina server'),
      h('p', { class: 'lm-muted' }, 'This copy of Lumina is running on static hosting, which has no accounts, database or staff tools. Run the Lumina server (npm start) and open admin.html from it.'),
      h('div', { class: 'lm-cluster' }, backLink()));
    return;
  }

  let session;
  try {
    session = await api.session.get();
  } catch (err) {
    gate(h('h1', { class: 'adm-h1', tabindex: '-1' }, 'Lumina is unavailable'), h('p', { class: 'lm-muted' }, err.message), h('div', { class: 'lm-cluster' }, backLink()));
    return;
  }

  if (!session.account) {
    // The Lumina sign-in page returns to routes inside the main app only, so this page
    // re-checks the session when the tab regains focus instead of passing a `next` there.
    const retry = () => {
      if (document.visibilityState === 'visible') location.reload();
    };
    document.addEventListener('visibilitychange', retry);
    gate(
      h('span', { class: 'lm-eyebrow' }, 'Staff only'),
      h('h1', { class: 'adm-h1', tabindex: '-1' }, 'Sign in to continue'),
      h('p', { class: 'lm-muted' }, 'The administration dashboard is for Lumina moderators and administrators. Sign in with your staff account in Lumina (it opens in a new tab), then return to this tab — the dashboard opens by itself.'),
      h('div', { class: 'lm-cluster' },
        h('a', { class: 'lm-btn lm-btn--primary', href: 'index.html#/login', target: '_blank', rel: 'noopener' }, icon('login'), h('span', null, 'Sign in'), h('span', { class: 'visually-hidden' }, ' (opens in a new tab)')),
        backLink()));
    return;
  }

  const role = session.account.role;
  if (role !== 'admin' && role !== 'moderator') {
    // No staff data is requested for other accounts.
    gate(
      h('span', { class: 'lm-eyebrow' }, 'Access denied'),
      h('h1', { class: 'adm-h1', tabindex: '-1' }, 'This area is for Lumina staff'),
      h('p', { class: 'lm-muted' }, `You are signed in as ${session.account.email}, which does not have moderator or administrator access.`),
      h('div', { class: 'lm-cluster' }, backLink()));
    return;
  }

  staff.account = session.account;
  let me;
  for (;;) {
    try {
      me = await adminApi.me();
      break;
    } catch (err) {
      if (err instanceof ApiError && err.code === 'REAUTH_REQUIRED') {
        await reauthenticate({ container: root });
        continue;
      }
      if (err instanceof ApiError && err.code === 'TOTP_SETUP_REQUIRED') {
        gate(
          h('span', { class: 'lm-eyebrow' }, 'Two-factor required'),
          h('h1', { class: 'adm-h1', tabindex: '-1' }, 'Turn on two-factor authentication'),
          h('p', { class: 'lm-muted' }, 'This server requires staff accounts to use an authenticator app before opening the dashboard (ADMIN_REQUIRE_2FA).'),
          h('div', { class: 'lm-cluster' },
            h('a', { class: 'lm-btn lm-btn--primary', href: 'index.html#/account' }, icon('shield'), h('span', null, 'Set up two-factor')),
            backLink()));
        return;
      }
      gate(h('h1', { class: 'adm-h1', tabindex: '-1' }, 'The dashboard could not load'), h('p', { class: 'lm-muted' }, err.message), h('div', { class: 'lm-cluster' }, backLink()));
      return;
    }
  }
  await startAdmin(root, me);
}

boot().catch((err) => {
  console.error(err);
  root.textContent = 'The Lumina dashboard could not start. Please refresh the page.';
});

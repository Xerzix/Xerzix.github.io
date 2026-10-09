// Admin shell: sidebar navigation, top bar (staff identity, elevation countdown, back to
// Lumina), the re-authentication form and the route table. Views live in js/admin/views/.
import { h, announce } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { defineRoutes, startRouter } from '../core/router.js';
import { api } from '../api/client.js';
import { icon, logoMark } from '../ui/icons.js';
import { button, field, openModal, toast, withBusy } from '../ui/components.js';
import { adminApi, onReauthRequired, onTotpSetupRequired } from './api.js';

export const NAV = [
  { path: '/', label: 'Overview', icon: 'home', match: (p) => p === '/' },
  { path: '/content', label: 'Content', icon: 'film', match: (p) => p.startsWith('/content') },
  { path: '/media', label: 'Media', icon: 'layers', match: (p) => p.startsWith('/media') },
  { path: '/creators', label: 'Creators', icon: 'clapper', match: (p) => p.startsWith('/creators'), badge: 'creatorApplications' },
  { path: '/submissions', label: 'Submissions', icon: 'upload', match: (p) => p.startsWith('/submissions'), badge: 'submissionsAwaiting' },
  { path: '/moderation', label: 'Moderation', icon: 'flag', match: (p) => p.startsWith('/moderation'), badge: 'moderation' },
  { path: '/users', label: 'Users', icon: 'users', match: (p) => p.startsWith('/users') },
  { path: '/announcements', label: 'Announcements', icon: 'bell', match: (p) => p.startsWith('/announcements') },
  { path: '/health', label: 'Platform health', icon: 'chart', match: (p) => p.startsWith('/health') },
  { path: '/logs', label: 'Logs & errors', icon: 'alert', match: (p) => p.startsWith('/logs') },
  { path: '/audit', label: 'Audit log', icon: 'history', match: (p) => p.startsWith('/audit'), adminOnly: true },
  { path: '/settings', label: 'Settings', icon: 'settings', match: (p) => p.startsWith('/settings'), adminOnly: true },
];

const view = (name) => () => import(`./views/${name}.js`);
export const ROUTES = [
  { path: '/', load: view('overview'), title: 'Overview' },
  { path: '/content', load: view('content'), title: 'Content' },
  { path: '/content/new', load: view('title-editor'), title: 'New title' },
  { path: '/content/:id', load: view('title-editor'), title: 'Edit title' },
  { path: '/media', load: view('media'), title: 'Media' },
  { path: '/creators', load: view('creators'), title: 'Creators' },
  { path: '/submissions', load: view('submissions'), title: 'Submissions' },
  { path: '/submissions/:id', load: view('submission'), title: 'Submission' },
  { path: '/moderation', load: view('moderation'), title: 'Moderation' },
  { path: '/users', load: view('users'), title: 'Users' },
  { path: '/users/:id', load: view('user'), title: 'User' },
  { path: '/announcements', load: view('announcements'), title: 'Announcements' },
  { path: '/health', load: view('health'), title: 'Platform health' },
  { path: '/logs', load: view('logs'), title: 'Logs & errors' },
  { path: '/audit', load: view('audit'), title: 'Audit log', adminOnly: true },
  { path: '/settings', load: view('settings'), title: 'Settings', adminOnly: true },
  { path: '/404', load: view('not-found'), title: 'Not found' },
];

/** Shared state for views: the signed-in staff member and their permissions. */
export const staff = {
  account: null,
  permissions: {},
  elevatedUntil: null,
  clockOffset: 0,
  get isAdmin() {
    return this.account?.role === 'admin';
  },
};

// ───────────────────────────── Re-authentication ─────────────────────────────

/**
 * Password (+ TOTP) form that calls api.auth.elevate. Resolves true on success.
 * `container` renders it inline (first load); otherwise it opens in a dialog.
 */
export function reauthenticate({ container = null, reason } = {}) {
  return new Promise((resolve) => {
    const totpOn = !!staff.account?.totpEnabled;
    const password = field({ label: 'Password', name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const totp = totpOn ? field({ label: 'Authenticator code', name: 'totp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 6, pattern: '[0-9]{6}', required: true, hint: 'The 6-digit code from your authenticator app.' }) : null;
    const status = h('p', { class: 'adm-reauth__error', role: 'alert', hidden: true });
    const submit = button('Confirm', { variant: 'primary', type: 'submit', icon: 'lock' });
    let modal = null;
    let done = false;
    const form = h('form', { class: 'lm-form adm-reauth', novalidate: true },
      h('p', { class: 'lm-muted' }, reason || 'Staff tools need a recent confirmation of your password. It stays valid for 15 minutes.'),
      h('p', { class: 'adm-reauth__who' }, icon('user'), staff.account?.email || ''),
      password, totp, status,
      container ? h('div', { class: 'lm-cluster' }, submit, h('a', { class: 'lm-btn lm-btn--ghost', href: 'index.html' }, h('span', null, 'Back to Lumina'))) : null);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      status.hidden = true;
      const pw = password.control.value;
      const code = totp?.control.value.trim();
      password.setError(pw ? '' : 'Enter your password.');
      if (totp) totp.setError(/^\d{6}$/.test(code || '') ? '' : 'Enter the 6-digit code.');
      if (!pw || (totp && !/^\d{6}$/.test(code || ''))) return;
      await withBusy(submit, async () => {
        try {
          const r = await api.auth.elevate({ password: pw, ...(code ? { totp: code } : {}) });
          staff.elevatedUntil = r?.elevatedUntil || new Date(Date.now() + 15 * 60_000).toISOString();
          bus.emit('admin:elevated', staff.elevatedUntil);
          announce('Confirmed. Staff tools unlocked for 15 minutes.');
          done = true;
          if (modal) modal.close(true);
          resolve(true);
        } catch (err) {
          status.textContent = err.code === 'NOT_FOUND' ? 'Re-authentication is not available on this server yet.' : err.message;
          status.hidden = false;
          password.control.select();
        }
      });
    });
    if (container) {
      container.replaceChildren(h('div', { class: 'adm-gate' },
        h('div', { class: 'adm-gate__card' },
          h('span', { class: 'lm-eyebrow' }, 'Lumina administration'),
          h('h1', { class: 'adm-h1' }, 'Confirm it’s you'),
          form)));
      setTimeout(() => password.control.focus(), 30);
    } else {
      form.append(h('button', { type: 'submit', hidden: true, tabindex: '-1' }, 'Confirm'));
      const cancel = button('Cancel', { variant: 'ghost', onClick: () => modal.close(false) });
      submit.type = 'button';
      submit.addEventListener('click', () => form.requestSubmit());
      modal = openModal({ title: 'Confirm it’s you', content: form, actions: [cancel, submit], onClose: () => { if (!done) resolve(false); } });
      setTimeout(() => password.control.focus(), 30);
    }
  });
}

function explainTotp() {
  if (document.querySelector('.adm-totp-dialog')) return;
  const m = openModal({
    title: 'Two-factor authentication required',
    content: [
      h('p', null, 'This server requires staff accounts to use two-factor authentication (ADMIN_REQUIRE_2FA).'),
      h('p', { class: 'lm-muted' }, 'Turn it on in your account settings, then come back to the dashboard.'),
    ],
    actions: [h('a', { class: 'lm-btn lm-btn--primary', href: 'index.html#/account' }, h('span', null, 'Open account settings'))],
  });
  m.el.classList.add('adm-totp-dialog');
}

// ───────────────────────────── Shell ─────────────────────────────

function initials(name = '') {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
}

function elevationPill() {
  const text = h('span', { class: 'adm-elev__text' });
  const btn = h('button', { type: 'button', class: 'adm-elev', 'aria-live': 'off' }, icon('shield'), text);
  const sr = h('span', { class: 'visually-hidden', 'aria-live': 'polite' });
  let warned = false;
  const tick = () => {
    const left = staff.elevatedUntil ? Date.parse(staff.elevatedUntil) - (Date.now() + staff.clockOffset) : 0;
    btn.classList.toggle('is-warn', left > 0 && left < 120_000);
    btn.classList.toggle('is-expired', left <= 0);
    if (left <= 0) {
      text.textContent = 'Confirm password';
      btn.title = 'Your staff confirmation expired. Select to confirm your password again.';
      btn.setAttribute('aria-label', 'Staff confirmation expired. Confirm your password.');
    } else {
      const m = Math.floor(left / 60_000);
      const s = Math.floor((left % 60_000) / 1000);
      text.textContent = `${m}:${String(s).padStart(2, '0')}`;
      btn.title = 'Time left before you need to confirm your password again. Select to extend.';
      btn.setAttribute('aria-label', `Staff confirmation: ${m} minutes ${s} seconds left. Select to extend.`);
    }
    if (left > 0 && left < 120_000 && !warned) {
      warned = true;
      sr.textContent = 'Your staff confirmation ends in less than two minutes.';
    }
    if (left >= 120_000) warned = false;
  };
  btn.addEventListener('click', () => reauthenticate({ reason: 'Confirm your password to extend staff access for another 15 minutes.' }));
  bus.on('admin:elevated', tick);
  tick();
  setInterval(tick, 1000);
  return h('div', { class: 'adm-elev-wrap' }, h('span', { class: 'adm-elev__label' }, 'Elevated'), btn, sr);
}

export function mountShell(root) {
  const main = h('main', { id: 'adm-main', class: 'adm-main', tabindex: '-1' });
  const counts = {};
  const navLinks = NAV.map((n) => {
    const count = h('span', { class: 'adm-nav__count', hidden: true });
    const a = h('a', { class: 'adm-nav__link', href: `#${n.path}`, dataset: { path: n.path } },
      icon(n.icon), h('span', { class: 'adm-nav__label' }, n.label),
      n.adminOnly && !staff.isAdmin ? h('span', { class: 'adm-nav__lock', title: 'Administrators only' }, icon('lock'), h('span', { class: 'visually-hidden' }, ' (administrators only)')) : null,
      count);
    if (n.badge) counts[n.badge] = { el: count, link: a, label: n.label };
    return h('li', null, a);
  });
  const sidebar = h('aside', { class: 'adm-sidebar', id: 'adm-sidebar', 'aria-label': 'Administration' },
    h('a', { class: 'adm-brand', href: '#/' }, logoMark('adm-brand__mark'), h('span', { class: 'adm-brand__word' }, 'LUMINA'), h('span', { class: 'adm-brand__tag' }, 'Admin')),
    h('nav', { class: 'adm-nav', 'aria-label': 'Dashboard sections' }, h('ul', { role: 'list' }, ...navLinks)),
    h('div', { class: 'adm-sidebar__foot' },
      h('a', { class: 'adm-nav__link', href: 'index.html' }, icon('arrowLeft'), h('span', null, 'Back to Lumina'))));

  const toggle = h('button', { type: 'button', class: 'lm-icon-btn adm-navtoggle', 'aria-label': 'Open navigation', 'aria-controls': 'adm-sidebar', 'aria-expanded': 'false' }, icon('menu'));
  const scrim = h('button', { type: 'button', class: 'adm-scrim', tabindex: '-1', 'aria-hidden': 'true' });
  const setNav = (open) => {
    root.classList.toggle('nav-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
    if (open) sidebar.querySelector('.adm-nav__link')?.focus();
  };
  toggle.addEventListener('click', () => setNav(!root.classList.contains('nav-open')));
  scrim.addEventListener('click', () => setNav(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('nav-open')) {
      setNav(false);
      toggle.focus();
    }
  });

  const a = staff.account;
  const identity = h('div', { class: 'adm-identity' },
    h('span', { class: 'adm-identity__avatar', 'aria-hidden': 'true' }, initials(a.displayName || a.email)),
    h('span', { class: 'adm-identity__text' },
      h('strong', null, a.displayName || a.email),
      h('span', null, a.email)),
    h('span', { class: ['lm-badge', 'adm-badge', a.role === 'admin' ? 'lm-badge--accent' : 'lm-badge--solid'] }, a.role === 'admin' ? 'Admin' : 'Moderator'));

  const topbar = h('header', { class: 'adm-topbar' },
    toggle,
    h('span', { class: 'adm-topbar__crumb', id: 'adm-crumb' }),
    h('span', { class: 'lm-spacer' }),
    elevationPill(),
    identity,
    // The text is hidden at phone width, so the link keeps its name in aria-label.
    h('a', { class: 'lm-btn lm-btn--ghost lm-btn--sm adm-back-app', href: 'index.html', 'aria-label': 'Back to Lumina' }, icon('arrowLeft'), h('span', { 'aria-hidden': 'true' }, 'Back to Lumina')));

  root.replaceChildren(h('div', { class: 'adm-app' }, sidebar, scrim, h('div', { class: 'adm-col' }, topbar, main)));

  bus.on('route:changed', ({ path, route }) => {
    for (const link of sidebar.querySelectorAll('[data-path]')) {
      const n = NAV.find((x) => x.path === link.dataset.path);
      if (n?.match(path)) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    }
    document.getElementById('adm-crumb').textContent = route?.title || '';
    document.title = `${route?.title || 'Dashboard'} · Lumina Admin`;
    setNav(false);
  });

  // Queue counts in the sidebar (refreshed on navigation, at most once a minute).
  let last = 0;
  const refreshCounts = async (force) => {
    if (!force && Date.now() - last < 60_000) return;
    last = Date.now();
    try {
      const o = await adminApi.overview();
      const values = { creatorApplications: o.queues.creatorApplications, submissionsAwaiting: o.queues.submissionsAwaiting, moderation: o.queues.reportedItems + o.queues.pendingReviews };
      for (const [k, c] of Object.entries(counts)) {
        const n = values[k] || 0;
        c.el.hidden = !n;
        c.el.textContent = n > 99 ? '99+' : String(n);
        c.link.setAttribute('aria-label', n ? `${c.label}, ${n} waiting` : c.label);
      }
    } catch {
      /* counts are optional */
    }
  };
  bus.on('route:changed', () => refreshCounts(false));
  bus.on('admin:queues-changed', () => refreshCounts(true));
  return main;
}

/** Wires REAUTH / TOTP handling, then starts hash routing inside the shell. */
export async function startAdmin(root, me) {
  staff.account = me.account;
  staff.permissions = me.permissions || {};
  staff.elevatedUntil = me.elevatedUntil;
  staff.clockOffset = me.serverTime ? Date.parse(me.serverTime) - Date.now() : 0;
  onReauthRequired(() => reauthenticate({ reason: 'Your staff confirmation expired. Confirm your password to continue — your change will be retried.' }));
  onTotpSetupRequired(explainTotp);
  const main = mountShell(root);
  document.querySelector('[data-skip]')?.addEventListener('click', (e) => {
    e.preventDefault();
    main.focus();
  });
  defineRoutes(ROUTES);
  await startRouter({
    outlet: main,
    guard: async (route) => {
      if (route?.adminOnly && !staff.isAdmin) {
        const { adminOnlyNotice } = await import('./views/not-found.js');
        return adminOnlyNotice(route.title);
      }
      return undefined;
    },
  });
  if (!location.hash) history.replaceState(history.state, '', '#/');
  toast(`Signed in as ${me.account.displayName || me.account.email}`, { type: 'success', timeout: 2500 });
}

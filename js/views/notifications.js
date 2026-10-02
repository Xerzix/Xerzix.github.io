// Notification centre (#/notifications): the account's own notifications merged with active
// platform announcements, newest first. Server-only — the route is flagged `server: true`
// and requires a signed-in account, so Preview mode shows the "needs the Lumina server" panel.
// Every change here emits `notifications:changed` so the header bell refreshes its count.
import { h, announce } from '../core/dom.js';
import { api } from '../api/client.js';
import { bus } from '../core/bus.js';
import { plural, relativeTime } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, errorState, linkButton, loading, segmented, toast, toastError, withBusy } from '../ui/components.js';

/** How each notification type is labelled and illustrated (types: server/services/notifications.js). */
const TYPES = {
  new_episode: { label: 'New episode', icon: 'tv' },
  genre_release: { label: 'Genre you follow', icon: 'film' },
  creator_release: { label: 'Creator you follow', icon: 'clapper' },
  submission_update: { label: 'Your submission', icon: 'upload' },
  creator_application: { label: 'Creator application', icon: 'checkCircle' },
  review_reply: { label: 'Reply to your review', icon: 'message' },
  announcement: { label: 'Announcement', icon: 'bell' },
  account_security: { label: 'Account & security', icon: 'shield' },
  moderation: { label: 'Moderation', icon: 'flag' },
};
const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'unread', label: 'Unread' },
];
const PREFS_HREF = '#/settings/notifications';

/**
 * Where a notification may take you: an in-app route (#/…) or an https page (opened in a
 * new tab). Anything else is not linked.
 */
export function notificationTarget(link) {
  if (typeof link !== 'string' || !link) return null;
  if (link.startsWith('#/')) return /[\s<>"'`]/.test(link) ? null : { href: link, external: false };
  try {
    const url = new URL(link);
    return url.protocol === 'https:' ? { href: url.href, external: true } : null;
  } catch {
    return null;
  }
}

function fullDate(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export default async function render(ctx) {
  const state = {
    filter: ctx.query.get('filter') === 'unread' ? 'unread' : 'all',
    items: [],
    total: 0,
    unread: 0,
    pageSize: 20,
  };

  const fetchPage = (page, signal) => api.request('GET', '/api/notifications', {
    query: { page, unread: state.filter === 'unread' ? 1 : undefined },
    signal,
  });

  const changed = () => bus.emit('notifications:changed');

  // ── Page chrome ──
  const summary = h('p', { class: 'lm-small lm-muted', 'aria-live': 'polite', style: { margin: 0 } });
  const markAllBtn = button('Mark all as read', { variant: 'ghost', size: 'sm', icon: 'check', onClick: () => markAll() });
  const listHost = h('div', { 'aria-busy': 'true' }, loading('Loading your notifications…'));
  const moreHost = h('div', { class: 'lm-cluster', style: { justifyContent: 'center', marginTop: 'var(--lm-space-6)' } });
  const filterControl = segmented({
    label: 'Show',
    options: FILTERS,
    value: state.filter,
    onChange: (value) => {
      state.filter = value;
      const target = `#/notifications${value === 'unread' ? '?filter=unread' : ''}`;
      if (location.hash !== target) history.replaceState({ ...(history.state || {}) }, '', target);
      load();
    },
  });

  function paintSummary() {
    summary.textContent = state.unread ? plural(state.unread, 'unread notification') : 'No unread notifications';
    markAllBtn.disabled = state.unread === 0;
  }

  // ── Actions ──
  // `navigating`: the reader followed an in-app link, so this view is about to be replaced and
  // must not re-render under the click that is still being dispatched.
  async function markRead(n, { quiet = false, navigating = false } = {}) {
    if (n.readAt) return;
    n.readAt = new Date().toISOString();
    state.unread = Math.max(0, state.unread - 1);
    if (!navigating) paint();
    try {
      const res = await api.notifications.read(n.id);
      if (Number.isFinite(res?.unread)) state.unread = res.unread;
      if (!navigating) paintSummary();
      if (!quiet) announce(`Marked “${n.title}” as read`);
      changed();
    } catch (err) {
      n.readAt = null;
      state.unread += 1;
      if (!navigating) paint();
      toastError(err);
    }
  }

  async function markAll() {
    await withBusy(markAllBtn, async () => {
      try {
        await api.notifications.readAll();
      } catch (err) {
        toastError(err);
        return;
      }
      const ts = new Date().toISOString();
      for (const n of state.items) n.readAt ||= ts;
      state.unread = 0;
      if (state.filter === 'unread') {
        state.items = [];
        state.total = 0;
      }
      paint();
      announce('All notifications marked as read');
      toast('All notifications marked as read.', { type: 'success' });
      changed();
    });
    markAllBtn.disabled = true;
  }

  async function remove(n, row) {
    const index = state.items.indexOf(n);
    try {
      const res = await api.notifications.remove(n.id);
      if (Number.isFinite(res?.unread)) state.unread = res.unread;
      else if (!n.readAt) state.unread = Math.max(0, state.unread - 1);
    } catch (err) {
      toastError(err);
      return;
    }
    state.items = state.items.filter((x) => x !== n);
    state.total = Math.max(0, state.total - 1);
    row.remove();
    paint();
    announce(n.announcement ? 'Announcement dismissed' : 'Notification deleted');
    // Keep keyboard users in place: focus the next (or previous) notification's first control.
    const rows = listHost.querySelectorAll('li[data-id]');
    const next = rows[Math.min(index, rows.length - 1)];
    (next?.querySelector('a, button') || listHost.querySelector('a, button') || markAllBtn).focus();
    changed();
  }

  async function loadMore(btn) {
    await withBusy(btn, async () => {
      try {
        const page = Math.floor(state.items.length / state.pageSize) + 1;
        const res = await fetchPage(page);
        const known = new Set(state.items.map((n) => n.id));
        const fresh = res.items.filter((n) => !known.has(n.id));
        const firstNew = state.items.length;
        state.items.push(...fresh);
        state.total = res.total;
        state.unread = res.unread;
        paint();
        listHost.querySelectorAll('li[data-id]')[firstNew]?.querySelector('a, button')?.focus();
        announce(fresh.length ? `Loaded ${plural(fresh.length, 'more notification')}` : 'No more notifications');
      } catch (err) {
        toastError(err);
      }
    });
  }

  // ── Rendering ──
  function row(n) {
    const meta = TYPES[n.type] || { label: 'Notification', icon: 'bell' };
    const target = notificationTarget(n.link);
    const unread = !n.readAt;
    const actions = h('div', { class: 'lm-cluster lm-cluster--sm', style: { marginLeft: 'auto', flex: 'none' } });
    if (target) {
      actions.append(h('a', {
        class: 'lm-btn lm-btn--ghost lm-btn--sm',
        href: target.href,
        ...(target.external ? { target: '_blank', rel: 'noopener noreferrer' } : {}),
        'aria-label': `Open: ${n.title}${target.external ? ' (opens in a new tab)' : ''}`,
        onClick: () => markRead(n, { quiet: true, navigating: !target.external }),
      }, h('span', null, 'Open'), icon(target.external ? 'external' : 'arrowRight')));
    }
    if (unread) {
      actions.append(h('button', { type: 'button', class: 'lm-icon-btn', 'aria-label': `Mark “${n.title}” as read`, title: 'Mark as read', onClick: () => markRead(n) }, icon('check')));
    } else {
      // Holds the mark-as-read column so Open and Delete line up down the list.
      actions.append(h('span', { class: 'lm-icon-btn', 'aria-hidden': 'true', style: { visibility: 'hidden' } }));
    }
    const li = h('li', { class: ['lm-notif', unread && 'is-unread'], dataset: { id: n.id, type: n.type }, style: { flexWrap: 'wrap', alignItems: 'flex-start', padding: 'var(--lm-space-4)' } },
      // Unread rows get their dot from .lm-notif.is-unread::before; read rows keep the same
      // width empty so every type icon sits in one column.
      unread ? null : h('span', { 'aria-hidden': 'true', style: { flex: 'none', width: '8px' } }),
      h('span', {
        'aria-hidden': 'true',
        style: { display: 'inline-grid', placeItems: 'center', flex: 'none', width: '36px', height: '36px', borderRadius: '50%', background: 'var(--lm-surface-3)', color: unread ? 'var(--lm-gold)' : 'var(--lm-text-2)' },
      }, icon(meta.icon, { size: 18 })),
      h('div', { style: { flex: '1 1 220px', minWidth: 0 } },
        h('strong', { style: { fontSize: 'var(--lm-fs-md)' } }, unread ? h('span', { class: 'visually-hidden' }, 'Unread: ') : null, n.title),
        n.body ? h('p', { style: { margin: '4px 0 0', color: 'var(--lm-text-2)', overflowWrap: 'anywhere' } }, n.body) : null,
        h('p', { class: 'lm-xsmall', style: { margin: '6px 0 0', color: 'var(--lm-text-2)' } },
          meta.label, ' · ',
          h('time', { datetime: n.createdAt, title: fullDate(n.createdAt), style: { display: 'inline', fontSize: 'inherit', color: 'inherit' } }, relativeTime(n.createdAt)))),
      actions);
    actions.append(h('button', {
      type: 'button',
      class: 'lm-icon-btn',
      'aria-label': n.announcement ? `Dismiss announcement “${n.title}”` : `Delete “${n.title}”`,
      title: n.announcement ? 'Dismiss' : 'Delete',
      onClick: () => remove(n, li),
    }, icon(n.announcement ? 'close' : 'trash')));
    return li;
  }

  function paint() {
    paintSummary();
    listHost.removeAttribute('aria-busy');
    if (!state.items.length) {
      const unreadView = state.filter === 'unread';
      listHost.replaceChildren(emptyState({
        title: 'You’re all caught up',
        message: unreadView
          ? 'You have no unread notifications.'
          : 'New episodes and releases you follow, updates on your submissions and announcements from Lumina will appear here.',
        actions: [
          unreadView
            ? button('Show all notifications', { variant: 'ghost', onClick: () => filterControl.querySelector('button')?.click() })
            : linkButton('Notification preferences', PREFS_HREF, { variant: 'ghost', icon: 'settings' }),
        ],
      }));
      moreHost.replaceChildren();
      return;
    }
    listHost.replaceChildren(h('ul', { class: 'lm-stack lm-stack--sm', role: 'list', 'aria-label': 'Notifications', style: { listStyle: 'none', margin: 0, padding: 0 } },
      ...state.items.map(row)));
    const remaining = state.total - state.items.length;
    if (remaining > 0) {
      const more = button(`Load more (${remaining})`, { variant: 'ghost', icon: 'chevronDown' });
      more.addEventListener('click', () => loadMore(more));
      moreHost.replaceChildren(more);
    } else {
      moreHost.replaceChildren(h('p', { class: 'lm-small lm-muted' }, state.items.length > state.pageSize ? 'That’s everything.' : ''));
    }
  }

  async function load() {
    listHost.setAttribute('aria-busy', 'true');
    listHost.replaceChildren(loading('Loading your notifications…'));
    moreHost.replaceChildren();
    try {
      const res = await fetchPage(1, ctx.signal);
      state.items = res.items;
      state.total = res.total;
      state.unread = res.unread;
      state.pageSize = res.pageSize || state.pageSize;
      paint();
    } catch (err) {
      if (err?.name === 'AbortError') return;
      listHost.removeAttribute('aria-busy');
      listHost.replaceChildren(errorState(err, { retry: load }));
    }
  }

  await load();

  return h('div', { class: 'lm-page lm-container' },
    h('header', { class: 'lm-page-header' },
      h('div', null,
        h('span', { class: 'lm-eyebrow' }, 'Inbox'),
        h('h1', null, 'Notifications'),
        h('p', null, 'New episodes and releases you follow, updates on your submissions and creator application, and announcements from Lumina.')),
      h('div', { class: 'lm-cluster lm-cluster--sm' },
        markAllBtn,
        linkButton('Notification preferences', PREFS_HREF, { variant: 'ghost', size: 'sm', icon: 'settings' }))),
    h('div', { class: 'lm-cluster', style: { justifyContent: 'space-between', marginBottom: 'var(--lm-space-4)' } }, filterControl, summary),
    h('section', { class: 'lm-panel', 'aria-label': 'Your notifications', style: { padding: 'var(--lm-space-3)' } }, listHost),
    moreHost);
}

// Your library: My List (reorderable), Continue Watching, History and Collections.
// Works on the server (per profile) and in Preview mode (stored on this device).
import { h, announce, newUid } from '../core/dom.js';
import { api } from '../api/client.js';
import { bus } from '../core/bus.js';
import { refreshLibrary, session, toggleList } from '../core/session.js';
import { date, plural, runtime } from '../core/format.js';
import { navigate } from '../core/router.js';
import { titleCard } from '../ui/card.js';
import { icon } from '../ui/icons.js';
import {
  applyFieldErrors, button, confirmDialog, emptyState, field, formValues, linkButton, openModal, segmented, tabs, toast, toastError,
} from '../ui/components.js';

const TABS = [
  { id: 'list', label: 'My List', title: 'My List' },
  { id: 'continue', label: 'Continue Watching', title: 'Continue Watching' },
  { id: 'history', label: 'History', title: 'Viewing history' },
  { id: 'collections', label: 'Collections', title: 'Collections' },
];

function syncUrl(path) {
  const target = `#${path}`;
  if (location.hash !== target) history.replaceState({ ...(history.state || {}) }, '', target);
}

const enc = encodeURIComponent;

// ── My List ───────────────────────────────────────────────
async function listTab() {
  const { items } = await api.library.watchlist();
  let order = [...items];
  let sort = 'custom';
  const wrap = h('div', { class: 'lm-lib__tab' });
  const count = h('p', { class: 'lm-disc-count' });
  const grid = h('ul', { class: 'lm-grid lm-lib__grid', role: 'list' });
  const hint = h('p', { class: 'lm-hint lm-lib__hint' });

  const sorted = () => {
    if (sort === 'added') return [...order].sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt));
    if (sort === 'title') return [...order].sort((a, b) => a.title.title.localeCompare(b.title.title));
    return order;
  };

  async function move(titleId, dir) {
    const i = order.findIndex((x) => x.titleId === titleId);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= order.length) return;
    const before = order;
    order = [...order];
    [order[i], order[j]] = [order[j], order[i]];
    paint();
    const target = grid.querySelector(`[data-title-id="${CSS.escape(titleId)}"] [data-move="${dir}"]`);
    (target && !target.disabled ? target : grid.querySelector(`[data-title-id="${CSS.escape(titleId)}"] [data-move="${-dir}"]`))?.focus();
    announce(`Moved ${order[j].title.title} to position ${j + 1} of ${order.length}`);
    try {
      await api.library.reorderList(order.map((x) => x.titleId));
    } catch (err) {
      order = before;
      paint();
      toastError(err);
    }
  }

  async function remove(item) {
    const index = order.findIndex((x) => x.titleId === item.titleId);
    const before = order.map((x) => x.titleId);
    try {
      await toggleList(item.titleId);
    } catch (err) {
      toastError(err);
      return;
    }
    order = order.filter((x) => x.titleId !== item.titleId);
    paint();
    const buttons = grid.querySelectorAll('[data-remove]');
    (buttons[Math.min(index, buttons.length - 1)] || wrap.querySelector('a, button'))?.focus();
    toast(`Removed “${item.title.title}” from My List.`, {
      type: 'success',
      action: {
        label: 'Undo',
        onClick: async () => {
          try {
            await toggleList(item.titleId);
            await api.library.reorderList(before);
            order = [...order];
            order.splice(index, 0, item);
            paint();
          } catch (err) {
            toastError(err);
          }
        },
      },
    });
  }

  function paint() {
    if (!order.length) {
      wrap.replaceChildren(emptyState({
        title: 'Your list is empty',
        message: 'Save films and series with the + button on any title, and they will wait for you here.',
        actions: [linkButton('Browse movies', '#/movies', { variant: 'primary', icon: 'film' }), linkButton('Ask Velvia for ideas', '#/velvia', { variant: 'ghost', icon: 'sparkle' })],
      }));
      return;
    }
    count.textContent = plural(order.length, 'title');
    hint.textContent = sort === 'custom' ? 'Use Move earlier and Move later to arrange your list. The order is saved for this profile.' : 'Switch to Custom order to rearrange your list.';
    const list = sorted();
    grid.replaceChildren(...list.map((item, i) => h('li', { class: 'lm-lib__item', 'data-title-id': item.titleId },
      titleCard(item.title),
      h('div', { class: 'lm-lib__controls' },
        sort === 'custom' ? button('', { variant: 'ghost', size: 'sm', icon: 'chevronLeft', ariaLabel: `Move ${item.title.title} earlier`, disabled: i === 0, attrs: { 'data-move': '-1', title: 'Move earlier' }, onClick: () => move(item.titleId, -1) }) : null,
        sort === 'custom' ? button('', { variant: 'ghost', size: 'sm', icon: 'chevronRight', ariaLabel: `Move ${item.title.title} later`, disabled: i === list.length - 1, attrs: { 'data-move': '1', title: 'Move later' }, onClick: () => move(item.titleId, 1) }) : null,
        h('span', { class: 'lm-spacer' }),
        button('', { variant: 'ghost', size: 'sm', icon: 'trash', ariaLabel: `Remove ${item.title.title} from My List`, attrs: { 'data-remove': '', title: 'Remove from My List' }, onClick: () => remove(item) })))));
    if (!wrap.contains(grid)) {
      wrap.replaceChildren(
        h('div', { class: 'lm-lib__toolbar' },
          count,
          segmented({
            label: 'Sort My List',
            value: sort,
            options: [{ value: 'custom', label: 'Custom order' }, { value: 'added', label: 'Recently added' }, { value: 'title', label: 'Title' }],
            onChange: (v) => {
              sort = v;
              paint();
            },
          })),
        hint,
        grid);
    }
  }
  paint();
  return wrap;
}

// ── Continue Watching ─────────────────────────────────────
async function continueTab() {
  const { items } = await api.library.continueWatching();
  const wrap = h('div', { class: 'lm-lib__tab' });
  const empty = () => emptyState({
    title: 'Nothing in progress',
    message: 'Titles you start watching appear here so you can pick up where you left off.',
    actions: [linkButton('Find something to watch', '#/discover', { variant: 'primary', icon: 'compass' })],
  });
  if (!items.length) {
    wrap.append(empty());
    return wrap;
  }
  const grid = h('ul', { class: 'lm-grid lm-grid--landscape lm-lib__grid', role: 'list' });
  for (const item of items) {
    const t = item.title;
    const progress = item.durationS ? Math.min(1, item.positionS / item.durationS) : 0;
    const li = h('li', { class: 'lm-lib__item' },
      titleCard(t, { variant: 'landscape', progress, episode: item.episode, positionS: item.positionS, durationS: item.durationS }),
      h('div', { class: 'lm-lib__controls' },
        h('span', { class: 'lm-spacer' }),
        button('Remove from row', {
          variant: 'ghost',
          size: 'sm',
          icon: 'close',
          attrs: { 'aria-label': `Remove ${t.title} from Continue Watching. This clears your saved progress for it.`, title: 'Clears your saved progress for this title' },
          onClick: async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            try {
              await api.library.unmarkWatched(t.id);
              const next = li.nextElementSibling || li.previousElementSibling;
              li.remove();
              await refreshLibrary();
              bus.emit('library:refresh-home', {});
              if (!grid.children.length) wrap.replaceChildren(empty());
              else next?.querySelector('button')?.focus();
              toast(`Removed “${t.title}” from Continue Watching.`, { type: 'success', timeout: 2600 });
            } catch (err) {
              btn.disabled = false;
              toastError(err);
            }
          },
        })));
    grid.append(li);
  }
  wrap.append(h('div', { class: 'lm-lib__toolbar' }, h('p', { class: 'lm-disc-count' }, plural(items.length, 'title'))), grid);
  return wrap;
}

// ── History ───────────────────────────────────────────────
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return date(iso, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

async function historyTab(rerender) {
  let page = 1;
  let first = await api.library.history(page);
  let total = first.total;
  let loaded = first.items.length;
  const wrap = h('div', { class: 'lm-lib__tab' });
  if (!first.items.length) {
    wrap.append(emptyState({
      title: 'No viewing history',
      message: 'Everything you watch on this profile is listed here by day. You can remove single entries or clear it all at any time.',
      actions: [linkButton('Browse movies', '#/movies', { variant: 'primary', icon: 'film' })],
    }));
    return wrap;
  }
  const countEl = h('p', { class: 'lm-disc-count' });
  const paintCount = () => { countEl.textContent = plural(total, 'viewing session'); };
  paintCount();
  const days = h('div', { class: 'lm-hist' });
  const groups = new Map();

  const entry = (item) => {
    const t = item.title;
    const when = new Date(item.watchedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    const ep = item.episode ? `S${item.episode.seasonNumber}:E${item.episode.number} · ${item.episode.name}` : null;
    const watched = item.seconds > 0 ? `${runtime(item.seconds / 60)} watched` : 'Marked as watched';
    const li = h('li', { class: 'lm-hist__row' },
      h('a', { class: 'lm-hist__thumb', href: `#/title/${enc(t.id)}`, tabindex: '-1', 'aria-hidden': 'true', style: t.palette?.[0] ? { '--card-tint': t.palette[0] } : undefined },
        t.poster ? h('img', { src: t.poster, alt: '', loading: 'lazy', onError: (e) => e.currentTarget.remove() }) : null),
      h('div', { class: 'lm-hist__text' },
        h('a', { class: 'lm-hist__title', href: `#/title/${enc(t.id)}` }, t.title),
        ep ? h('span', { class: 'lm-hist__ep' }, ep) : null,
        h('span', { class: 'lm-hist__meta' }, h('time', { datetime: item.watchedAt }, when), ` · ${watched}`)),
      button('', {
        variant: 'ghost',
        size: 'sm',
        icon: 'close',
        ariaLabel: `Remove ${t.title}${ep ? ` ${ep}` : ''}, ${when}, from history`,
        attrs: { title: 'Remove from history', 'data-remove': '' },
        onClick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          try {
            await api.library.removeHistory(item.id);
            const group = li.parentElement;
            const all = [...days.querySelectorAll('[data-remove]')];
            const next = all[all.indexOf(btn) + 1] || all[all.indexOf(btn) - 1];
            li.remove();
            if (!group.children.length) group.closest('section')?.remove();
            total -= 1;
            loaded -= 1;
            paintCount();
            if (!total) rerender();
            else next?.focus();
            announce(`Removed ${t.title} from history`);
          } catch (err) {
            btn.disabled = false;
            toastError(err);
          }
        },
      }));
    return li;
  };

  const add = (items) => {
    for (const item of items) {
      const key = new Date(item.watchedAt).toDateString();
      if (!groups.has(key)) {
        const id = newUid('day');
        const list = h('ul', { class: 'lm-hist__list', role: 'list' });
        days.append(h('section', { class: 'lm-hist__day', 'aria-labelledby': id }, h('h3', { class: 'lm-hist__date', id }, dayLabel(item.watchedAt)), list));
        groups.set(key, list);
      }
      groups.get(key).append(entry(item));
    }
  };
  add(first.items);

  const more = button('Load older history', { variant: 'glass', icon: 'chevronDown' });
  more.hidden = loaded >= total;
  more.addEventListener('click', async () => {
    more.classList.add('is-busy');
    try {
      page += 1;
      first = await api.library.history(page);
      total = first.total;
      loaded += first.items.length;
      add(first.items);
      paintCount();
      more.hidden = loaded >= total || !first.items.length;
    } catch (err) {
      toastError(err);
    } finally {
      more.classList.remove('is-busy');
    }
  });

  const clearBtn = button('Clear all history', {
    variant: 'danger',
    size: 'sm',
    icon: 'trash',
    onClick: async () => {
      const ok = await confirmDialog({
        title: 'Clear all viewing history?',
        message: `This removes every entry from ${session.profile?.name ? `${session.profile.name}’s` : 'this profile’s'} history and all saved progress, so Continue Watching will be empty and recommendations will start fresh. This can’t be undone.`,
        confirmLabel: 'Clear history',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.library.clearHistory();
        await refreshLibrary();
        bus.emit('library:refresh-home', {});
        toast('Viewing history cleared.', { type: 'success' });
        rerender();
      } catch (err) {
        toastError(err);
      }
    },
  });

  wrap.append(
    h('div', { class: 'lm-lib__toolbar' }, countEl, clearBtn),
    days,
    h('div', { class: 'lm-disc-more' }, more));
  return wrap;
}

// ── Collections ───────────────────────────────────────────
function collectionTile(c) {
  const previews = (c.previews || []).filter(Boolean).slice(0, 4);
  const tint = previews.find((p) => p.palette?.length)?.palette?.[0];
  return h('li', null, h('a', { class: 'lm-coll-tile', href: `#/collections/${enc(c.id)}`, style: tint ? { '--tile-tint': tint } : undefined },
    h('div', { class: 'lm-coll-tile__art', 'data-count': String(previews.length), 'aria-hidden': 'true' },
      ...previews.map((p) => (p.poster ? h('img', { src: p.poster, alt: '', loading: 'lazy', onError: (e) => e.currentTarget.remove() }) : h('span'))),
      previews.length ? null : icon('layers', { size: 32 })),
    h('div', { class: 'lm-coll-tile__text' },
      h('span', { class: 'lm-coll-tile__name' }, c.name),
      h('span', { class: 'lm-coll-tile__meta' },
        plural(c.itemCount ?? 0, 'title'),
        c.visibility === 'unlisted' ? h('span', { class: 'lm-badge lm-badge--4k' }, 'Shared') : null))));
}

function createCollection() {
  let modal;
  const formId = newUid('form');
  const form = h('form', { class: 'lm-form', id: formId, novalidate: true },
    field({ label: 'Name', name: 'name', required: true, maxlength: 80, placeholder: 'Rainy Sunday films' }),
    field({ label: 'Description', name: 'description', type: 'textarea', rows: 3, maxlength: 500, hint: 'Optional.' }));
  const create = button('Create collection', { variant: 'primary', type: 'submit', attrs: { form: formId } });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const values = formValues(form);
    if (!values.name.trim()) {
      applyFieldErrors(form, { fields: { name: 'Give the collection a name.' } });
      return;
    }
    create.classList.add('is-busy');
    try {
      const { collection } = await api.collections.create({ name: values.name.trim(), description: values.description.trim() });
      modal.close();
      navigate(`/collections/${enc(collection.id)}`);
    } catch (err) {
      if (!applyFieldErrors(form, err)) toastError(err);
    } finally {
      create.classList.remove('is-busy');
    }
  });
  modal = openModal({ title: 'New collection', content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), create] });
  setTimeout(() => form.querySelector('input')?.focus(), 40);
}

async function collectionsTab() {
  const { items } = await api.collections.list();
  const wrap = h('div', { class: 'lm-lib__tab' });
  const newBtn = button('New collection', { variant: 'primary', icon: 'plus', onClick: createCollection });
  if (!items.length) {
    wrap.append(emptyState({
      title: 'No collections yet',
      message: session.isServer
        ? 'Group titles into your own collections — a film night, a mood, a course of study — and share them by link if you like.'
        : 'Group titles into your own collections — a film night, a mood, a course of study. In Preview mode they are kept on this device.',
      actions: [newBtn],
    }));
    return wrap;
  }
  wrap.append(
    h('div', { class: 'lm-lib__toolbar' }, h('p', { class: 'lm-disc-count' }, plural(items.length, 'collection')), newBtn),
    h('ul', { class: 'lm-coll-grid', role: 'list' }, ...items.map(collectionTile)));
  return wrap;
}

// ── Page ──────────────────────────────────────────────────
export default async function render(ctx) {
  if (session.isServer && !session.account) {
    ctx.setTitle('My List');
    return h('div', { class: 'lm-page lm-container lm-lib' }, h('h1', { class: 'visually-hidden' }, 'My List'), emptyState({
      title: 'Sign in to keep a list',
      message: 'My List, Continue Watching, history and collections belong to your profile. Sign in to see them on any device.',
      actions: [linkButton('Sign in', `#/login?next=${enc(ctx.raw)}`, { variant: 'primary', icon: 'login' }), linkButton('Create an account', '#/register', { variant: 'ghost' })],
    }));
  }
  const active = TABS.some((t) => t.id === ctx.params.tab) ? ctx.params.tab : 'list';
  const setTitle = (id) => ctx.setTitle(TABS.find((t) => t.id === id)?.title || 'My List');
  setTitle(active);

  let tabset;
  const rerender = () => tabset?.select(currentTab);
  let currentTab = active;
  const renderers = { list: listTab, continue: continueTab, history: () => historyTab(rerender), collections: collectionsTab };
  tabset = tabs({
    label: 'Library sections',
    active,
    tabs: TABS.map((t) => ({ id: t.id, label: t.label, render: renderers[t.id] })),
    onChange: (id) => {
      currentTab = id;
      syncUrl(id === 'list' ? '/my-list' : `/my-list/${id}`);
      setTitle(id);
    },
  });

  return h('div', { class: 'lm-page lm-container lm-lib' },
    h('header', { class: 'lm-page-header lm-disc-head' },
      h('div', null,
        h('p', { class: 'lm-eyebrow' }, session.profile?.name ? `${session.profile.name}’s library` : 'Your library'),
        h('h1', { class: 'lm-h1' }, 'My List'),
        h('p', { class: 'lm-disc-head__sub' }, session.isServer
          ? 'Saved titles, what you are watching, your history and your collections — private to this profile.'
          : 'Saved titles, progress, history and collections are kept on this device in Preview mode.')),
      h('div', { class: 'lm-cluster' }, linkButton('Viewing statistics', '#/stats', { variant: 'ghost', size: 'sm', icon: 'chart' }))),
    tabset);
}

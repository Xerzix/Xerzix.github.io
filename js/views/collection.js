// A personal collection (/collections/:id, editable by its owner profile) and the public,
// read-only view of an unlisted collection (/shared/:token, server only).
import { h, announce, debounce, newUid } from '../core/dom.js';
import { api, ServerRequiredError } from '../api/client.js';
import { bus } from '../core/bus.js';
import { session } from '../core/session.js';
import { date, plural, relativeTime, titleFacts } from '../core/format.js';
import { navigate } from '../core/router.js';
import { titleCard } from '../ui/card.js';
import { icon } from '../ui/icons.js';
import {
  applyFieldErrors, button, confirmDialog, emptyState, errorState, field, formValues, linkButton, openModal, segmented, toast, toastError,
} from '../ui/components.js';

/** The router applies the route's generic title after render; re-apply the specific one. */
function setPageTitle(ctx, title) {
  ctx.setTitle(title);
  const off = bus.on('route:changed', ({ path }) => {
    off();
    if (path === ctx.path && !ctx.signal?.aborted) ctx.setTitle(title);
  });
}

const enc = encodeURIComponent;

// ── Title picker (also used by the compare page) ──────────
/**
 * Opens a searchable catalog picker in a dialog.
 *   mode 'multi':  each row has an Add/Added toggle; onToggle(title, nextSelected) → Promise<boolean>
 *   mode 'single': each row has a Choose button; onPick(title) is called and the dialog closes.
 * Returns the modal's `closed` promise.
 */
export function openTitlePicker({ title = 'Add titles', mode = 'multi', isSelected = () => false, isDisabled = () => false, onToggle, onPick, hint } = {}) {
  const inputId = newUid('pick');
  const input = h('input', { id: inputId, class: 'lm-input', type: 'search', placeholder: 'Search by title, person or genre', autocomplete: 'off', enterkeyhint: 'search' });
  const status = h('p', { class: 'lm-hint', role: 'status' });
  const list = h('ul', { class: 'lm-picker__list', role: 'list' });
  let controller = null;
  let modal;

  const row = (t) => {
    const selected = isSelected(t.id);
    const disabled = isDisabled(t.id);
    let action;
    if (mode === 'single') {
      action = button(disabled ? 'Added' : 'Choose', {
        variant: disabled ? 'ghost' : 'primary',
        size: 'sm',
        disabled,
        ariaLabel: disabled ? `${t.title} is already included` : `Choose ${t.title}`,
        onClick: () => {
          onPick?.(t);
          modal.close(t);
        },
      });
    } else {
      action = button(selected ? 'Added' : 'Add', { variant: selected ? 'ghost' : 'glass', size: 'sm', icon: selected ? 'check' : 'plus', attrs: { 'aria-pressed': String(selected), 'aria-label': `${selected ? 'Remove' : 'Add'} ${t.title}` } });
      action.addEventListener('click', async () => {
        const next = action.getAttribute('aria-pressed') !== 'true';
        action.disabled = true;
        try {
          const ok = await onToggle(t, next);
          if (ok !== false) {
            action.setAttribute('aria-pressed', String(next));
            action.setAttribute('aria-label', `${next ? 'Remove' : 'Add'} ${t.title}`);
            action.className = `lm-btn lm-btn--${next ? 'ghost' : 'glass'} lm-btn--sm`;
            action.replaceChildren(icon(next ? 'check' : 'plus'), h('span', null, next ? 'Added' : 'Add'));
            announce(next ? `Added ${t.title}` : `Removed ${t.title}`);
          }
        } catch (err) {
          toastError(err);
        } finally {
          action.disabled = false;
        }
      });
    }
    return h('li', { class: 'lm-picker__row' },
      h('span', { class: 'lm-picker__thumb', style: t.palette?.[0] ? { '--card-tint': t.palette[0] } : undefined }, t.poster ? h('img', { src: t.poster, alt: '', loading: 'lazy', onError: (e) => e.currentTarget.remove() }) : null),
      h('span', { class: 'lm-picker__text' }, h('strong', null, t.title), h('span', null, [...titleFacts(t), t.type === 'series' ? 'Series' : 'Film', t.ageRating].filter(Boolean).join(' · '))),
      action);
  };

  const load = async (q) => {
    controller?.abort();
    controller = new AbortController();
    list.setAttribute('aria-busy', 'true');
    try {
      const r = await api.catalog.search(q ? { q, pageSize: 30 } : { sort: 'relevance', pageSize: 30 }, { signal: controller.signal });
      list.removeAttribute('aria-busy');
      list.replaceChildren(...r.items.map(row));
      status.textContent = r.items.length
        ? q ? `${plural(r.total, 'match', 'matches')}${r.total > r.items.length ? ` — showing the first ${r.items.length}` : ''}` : 'Featured titles — search to find anything in the catalog.'
        : r.didYouMean ? `No matches. Did you mean “${r.didYouMean}”?` : 'No matches in the Lumina catalog.';
    } catch (err) {
      if (err.name === 'AbortError') return;
      list.removeAttribute('aria-busy');
      status.textContent = err.message;
    }
  };
  const search = debounce(() => load(input.value.trim()), 200);
  input.addEventListener('input', search);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      search.cancel();
      load(input.value.trim());
    }
  });

  modal = openModal({
    title,
    size: 'wide',
    content: h('div', { class: 'lm-picker' },
      h('label', { class: 'lm-label', for: inputId }, 'Search the catalog'),
      input,
      hint ? h('p', { class: 'lm-hint' }, hint) : null,
      status,
      list),
    actions: [button(mode === 'multi' ? 'Done' : 'Cancel', { variant: mode === 'multi' ? 'primary' : 'ghost', onClick: () => modal.close() })],
    onClose: () => {
      search.cancel();
      controller?.abort();
    },
  });
  setTimeout(() => input.focus(), 40);
  load('');
  return modal.closed;
}

// ── Helpers ───────────────────────────────────────────────
function simplePage(ctx, title, state) {
  setPageTitle(ctx, title);
  return h('div', { class: 'lm-page lm-container lm-lib' }, h('h1', { class: 'visually-hidden' }, title), state);
}

export function shareLink(col) {
  if (col.shareToken) return `${location.origin}${location.pathname}#/shared/${col.shareToken}`;
  return col.shareUrl || '';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Link copied to the clipboard.', { type: 'success', timeout: 2600 });
  } catch {
    toast(`Copy this link: ${text}`, { timeout: 9000 });
  }
}

// ── Owner view ────────────────────────────────────────────
async function ownerView(ctx) {
  if (session.isServer && !session.account) {
    return simplePage(ctx, 'Sign in to see your collections', emptyState({
      title: 'Sign in to see your collections',
      message: 'Collections belong to a profile. Sign in and choose a profile to open this one.',
      actions: [linkButton('Sign in', `#/login?next=${enc(ctx.raw)}`, { variant: 'primary', icon: 'login' })],
    }));
  }
  let col;
  try {
    col = (await api.collections.get(ctx.params.id)).collection;
  } catch (err) {
    if (err.status === 404) {
      return simplePage(ctx, 'Collection not found', emptyState({
        title: 'This collection is not here',
        message: 'It may have been deleted, or it belongs to a different profile.',
        actions: [linkButton('Your collections', '#/my-list/collections', { variant: 'primary', icon: 'layers' })],
      }));
    }
    throw err;
  }
  setPageTitle(ctx, col.name);

  const heading = h('h1', { class: 'lm-h1 lm-coll__name' }, col.name);
  const desc = h('p', { class: 'lm-disc-head__sub lm-coll__desc' }, col.description || '');
  const meta = h('p', { class: 'lm-coll__meta' });
  const grid = h('ul', { class: 'lm-grid lm-coll__grid', role: 'list' });
  const body = h('div');
  const shareSlot = h('div');

  const paintMeta = () => {
    heading.textContent = col.name;
    desc.textContent = col.description || '';
    meta.replaceChildren(...[
      h('span', null, plural(col.items.length, 'title')),
      h('span', { class: ['lm-badge', col.visibility === 'unlisted' ? 'lm-badge--4k' : 'lm-badge--solid'] }, icon(col.visibility === 'unlisted' ? 'globe' : 'lock', { size: 12 }), col.visibility === 'unlisted' ? 'Shared by link' : 'Private'),
      col.updatedAt ? h('span', null, `Updated ${relativeTime(col.updatedAt)}`) : null,
    ].filter(Boolean));
  };

  const itemNode = (item) => h('li', { class: 'lm-coll__item', 'data-title-id': item.titleId },
    titleCard(item.title),
    item.note ? h('p', { class: 'lm-coll__note' }, item.note) : null,
    button('Remove', {
      variant: 'ghost',
      size: 'sm',
      icon: 'trash',
      className: 'lm-coll__remove',
      ariaLabel: `Remove ${item.title.title} from ${col.name}`,
      onClick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        try {
          await api.collections.removeItem(col.id, item.titleId);
          const i = col.items.findIndex((x) => x.titleId === item.titleId);
          col.items.splice(i, 1);
          paintItems();
          paintMeta();
          const next = grid.querySelectorAll('.lm-coll__remove')[Math.min(i, col.items.length - 1)];
          (next || addBtn).focus();
          toast(`Removed “${item.title.title}”.`, {
            type: 'success',
            action: { label: 'Undo', onClick: async () => { try { await api.collections.addItem(col.id, item.titleId); await reload(); } catch (err) { toastError(err); } } },
          });
        } catch (err) {
          btn.disabled = false;
          toastError(err);
        }
      },
    }));

  const paintItems = () => {
    if (!col.items.length) {
      body.replaceChildren(emptyState({
        title: 'Nothing in this collection yet',
        message: 'Choose Add titles to search the catalog and pick the films and series that belong here.',
        actions: [button('Add titles', { variant: 'primary', icon: 'plus', onClick: openPicker })],
      }));
      return;
    }
    grid.replaceChildren(...col.items.map(itemNode));
    body.replaceChildren(grid);
  };

  const reload = async () => {
    col = (await api.collections.get(col.id)).collection;
    paintMeta();
    paintItems();
    paintShare();
  };

  async function openPicker() {
    const ids = new Set(col.items.map((i) => i.titleId));
    let changed = false;
    await openTitlePicker({
      title: `Add to “${col.name}”`,
      isSelected: (id) => ids.has(id),
      onToggle: async (t, add) => {
        if (add) await api.collections.addItem(col.id, t.id);
        else await api.collections.removeItem(col.id, t.id);
        if (add) ids.add(t.id);
        else ids.delete(t.id);
        changed = true;
        return true;
      },
    });
    if (changed) {
      try {
        await reload();
      } catch (err) {
        toastError(err);
      }
    }
  }

  function editDetails() {
    let modal;
    const form = h('form', { class: 'lm-form', novalidate: true },
      field({ label: 'Name', name: 'name', value: col.name, required: true, maxlength: 80 }),
      field({ label: 'Description', name: 'description', type: 'textarea', value: col.description, rows: 3, maxlength: 500, hint: 'Optional. Shown to anyone you share the link with.' }));
    const save = button('Save', { variant: 'primary', type: 'submit', attrs: { form: newUid('f') } });
    form.id = save.getAttribute('form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const values = formValues(form);
      if (!values.name.trim()) {
        applyFieldErrors(form, { fields: { name: 'Give the collection a name.' } });
        return;
      }
      save.classList.add('is-busy');
      try {
        // An empty description clears it (on the server and in Preview mode alike).
        const res = await api.collections.update(col.id, { name: values.name.trim(), description: values.description.trim() });
        col = { ...col, ...res.collection, items: col.items };
        paintMeta();
        ctx.setTitle(col.name);
        modal.close();
        toast('Collection updated.', { type: 'success', timeout: 2400 });
      } catch (err) {
        if (!applyFieldErrors(form, err)) toastError(err);
      } finally {
        save.classList.remove('is-busy');
      }
    });
    modal = openModal({ title: 'Edit collection', content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), save] });
    setTimeout(() => form.querySelector('input')?.focus(), 40);
  }

  function paintShare() {
    if (!session.isServer) {
      shareSlot.replaceChildren(h('p', { class: 'lm-hint lm-coll__share-note' }, icon('lock', { size: 14 }), ' Private to this device. Sharing collections by link needs the Lumina server.'));
      return;
    }
    if (session.features?.sharedCollections === false) {
      shareSlot.replaceChildren(h('p', { class: 'lm-hint lm-coll__share-note' }, icon('lock', { size: 14 }), ' Private. Sharing by link is turned off on this server.'));
      return;
    }
    const setVisibility = async (visibility) => {
      try {
        const res = await api.collections.update(col.id, { visibility });
        col = { ...col, ...res.collection, items: col.items };
        paintMeta();
        paintShare();
        announce(visibility === 'unlisted' ? 'Sharing by link is on' : 'The collection is private again. The old link no longer works.');
      } catch (err) {
        toastError(err);
        paintShare();
      }
    };
    const url = col.visibility === 'unlisted' ? shareLink(col) : '';
    const linkId = newUid('link');
    shareSlot.replaceChildren(h('section', { class: 'lm-panel lm-coll__share', 'aria-labelledby': `${linkId}-h` },
      h('div', { class: 'lm-coll__share-head' },
        h('div', null,
          h('h2', { class: 'lm-h3', id: `${linkId}-h` }, 'Sharing'),
          h('p', { class: 'lm-hint' }, col.visibility === 'unlisted'
            ? 'Anyone with the link can view this collection. It is not listed or searchable, and your profile name is shown as the curator.'
            : 'Only this profile can see this collection.')),
        segmented({ label: 'Who can see this collection', value: col.visibility, options: [{ value: 'private', label: 'Private' }, { value: 'unlisted', label: 'Anyone with the link' }], onChange: setVisibility })),
      url ? h('div', { class: 'lm-coll__link' },
        h('label', { class: 'visually-hidden', for: linkId }, 'Share link'),
        h('input', { id: linkId, class: 'lm-input', readOnly: true, value: url, onFocus: (e) => e.currentTarget.select() }),
        button('Copy link', { variant: 'glass', icon: 'copy', onClick: () => copyText(url) })) : null));
  }

  const addBtn = button('Add titles', { variant: 'primary', icon: 'plus', onClick: openPicker });
  const page = h('div', { class: 'lm-page lm-container lm-lib lm-coll' },
    h('header', { class: 'lm-page-header lm-disc-head' },
      h('div', null,
        h('nav', { class: 'lm-crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/my-list/collections' }, 'Collections'), h('span', { 'aria-hidden': 'true' }, '/'), h('span', { 'aria-current': 'page' }, 'Collection')),
        heading,
        desc,
        meta),
      h('div', { class: 'lm-cluster' },
        addBtn,
        button('Edit', { variant: 'glass', icon: 'edit', onClick: editDetails }),
        button('Delete', {
          variant: 'danger',
          icon: 'trash',
          onClick: async () => {
            const ok = await confirmDialog({ title: `Delete “${col.name}”?`, message: `The collection and its list of ${plural(col.items.length, 'title')} will be removed${col.visibility === 'unlisted' ? ', and the share link will stop working' : ''}. The titles stay in the catalog. This can’t be undone.`, confirmLabel: 'Delete collection', danger: true });
            if (!ok) return;
            try {
              await api.collections.remove(col.id);
              toast(`Deleted “${col.name}”.`, { type: 'success' });
              navigate('/my-list/collections');
            } catch (err) {
              toastError(err);
            }
          },
        }))),
    shareSlot,
    body);
  paintMeta();
  paintItems();
  paintShare();
  return page;
}

// ── Shared (public, read-only) view ───────────────────────
async function sharedView(ctx) {
  let col;
  try {
    col = (await api.collections.shared(ctx.params.token)).collection;
  } catch (err) {
    if (err instanceof ServerRequiredError) throw err;
    if (err.status === 404 || err.status === 403) {
      return simplePage(ctx, 'Shared collection unavailable', emptyState({
        title: 'This shared collection is not available',
        message: err.code === 'FEATURE_DISABLED' ? 'Sharing collections is turned off on this Lumina server.' : 'The owner may have made it private or deleted it, or the link may be incomplete.',
        actions: [linkButton('Browse Lumina', '#/', { variant: 'primary', icon: 'home' })],
      }));
    }
    return simplePage(ctx, 'Shared collection', errorState(err, { retry: () => navigate(ctx.raw, { replace: true }) }));
  }
  setPageTitle(ctx, col.name);
  const page = h('div', { class: 'lm-page lm-container lm-lib lm-coll lm-coll--shared' },
    h('header', { class: 'lm-page-header lm-disc-head' },
      h('div', null,
        h('p', { class: 'lm-eyebrow' }, 'Shared collection'),
        h('h1', { class: 'lm-h1 lm-coll__name' }, col.name),
        col.description ? h('p', { class: 'lm-disc-head__sub lm-coll__desc' }, col.description) : null,
        h('p', { class: 'lm-coll__meta' },
          h('span', null, 'Curated by ', h('strong', null, col.owner?.name || 'a Lumina member')),
          h('span', null, plural(col.itemCount, 'title')),
          col.updatedAt ? h('span', null, `Updated ${date(col.updatedAt)}`) : null))),
    col.items.length
      ? h('ul', { class: 'lm-grid lm-coll__grid', role: 'list' }, ...col.items.map((i) => h('li', { class: 'lm-coll__item' }, titleCard(i.title), i.note ? h('p', { class: 'lm-coll__note' }, i.note) : null)))
      : emptyState({ title: 'Nothing to show here', message: 'This collection is empty, or its titles are outside this profile’s maturity setting.', actions: [linkButton('Browse Lumina', '#/', { variant: 'primary' })] }),
    h('p', { class: 'lm-hint lm-coll__shared-note' }, 'Shared collections are read-only. Titles outside your profile’s maturity setting are not shown.'));
  return page;
}

export default async function render(ctx) {
  if (ctx.params.token) return sharedView(ctx);
  return ownerView(ctx);
}


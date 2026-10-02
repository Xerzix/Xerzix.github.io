// "Import from TMDB": search TMDB (server-side, metadata only), pick a result and open the
// new-title form pre-filled with it. Nothing is saved until staff review and save the form.
import { h } from '../core/dom.js';
import { button, notice, openModal, withBusy } from '../ui/components.js';
import { adminApi } from './api.js';
import { inlineLoading } from './ui.js';

let pending = null;

/** The metadata picked in the import dialog, consumed once by the title editor. */
export function takeImport() {
  const p = pending;
  pending = null;
  return p;
}

export function openTmdbImport(ctx) {
  const q = h('input', { class: 'lm-input', type: 'search', name: 'q', placeholder: 'Title to look up', 'aria-label': 'Title to look up on TMDB', autocomplete: 'off', required: true });
  const type = h('select', { class: 'lm-select', 'aria-label': 'Type' },
    h('option', { value: 'multi' }, 'Films and series'), h('option', { value: 'movie' }, 'Films'), h('option', { value: 'tv' }, 'Series'));
  const search = button('Search', { variant: 'primary', type: 'submit', icon: 'search' });
  const results = h('div', { 'aria-live': 'polite' });
  const form = h('form', { class: 'adm-filters', role: 'search' },
    h('div', { class: 'adm-filter adm-filter--grow' }, q), h('div', { class: 'adm-filter' }, type), search);
  let modal;

  const choose = async (item, btn) => {
    await withBusy(btn, async () => {
      try {
        const r = await adminApi.tmdb.details(item.tmdbType, item.tmdbId);
        pending = r.metadata;
        modal.close();
        ctx.navigate('/content/new?from=tmdb');
      } catch (err) {
        results.prepend(notice(err.message, { type: 'danger' }));
      }
    });
  };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!q.value.trim()) return q.focus();
    results.replaceChildren(inlineLoading('Searching TMDB…'));
    await withBusy(search, async () => {
      try {
        const r = await adminApi.tmdb.search(q.value.trim(), type.value);
        if (!r.items.length) {
          results.replaceChildren(h('p', { class: 'lm-muted' }, 'TMDB has nothing matching that search.'));
          return;
        }
        results.replaceChildren(h('ul', { class: 'adm-tmdb-results', 'aria-label': 'TMDB results' }, ...r.items.map((item) => {
          const use = button('Use this', { variant: 'ghost', size: 'sm' });
          use.setAttribute('aria-label', `Use ${item.title}${item.year ? ` (${item.year})` : ''}`);
          use.addEventListener('click', () => choose(item, use));
          return h('li', null,
            h('div', null,
              h('strong', null, item.title, item.year ? ` (${item.year})` : ''),
              h('span', { class: 'lm-muted lm-xsmall' }, ` · ${item.type === 'series' ? 'Series' : 'Film'}`),
              item.overview ? h('p', null, item.overview) : null),
            use);
        })));
      } catch (err) {
        results.replaceChildren(err.code === 'TMDB_NOT_CONFIGURED'
          ? notice('TMDB import is not configured on this server. An operator can enable it by setting TMDB_API_TOKEN (a TMDB read access token). You can still create titles by hand.', { type: 'warn', title: 'Not configured' })
          : notice(err.message, { type: 'danger' }));
      }
    });
  });

  modal = openModal({
    title: 'Import metadata from TMDB',
    size: 'wide',
    content: h('div', { class: 'adm-modal-stack' },
      h('p', { class: 'lm-muted lm-small' }, 'TMDB provides descriptive metadata only — it does not grant any right to stream a title. Only add titles you are licensed to show. You will review every field before anything is saved.'),
      form,
      results),
  });
  setTimeout(() => q.focus(), 40);
}

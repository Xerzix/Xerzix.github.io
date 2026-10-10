// Content: searchable, filterable list of every title (all statuses), with entry points to
// create a title by hand or from TMDB metadata.
import { h } from '../../core/dom.js';
import { icon } from '../../ui/icons.js';
import { button, toast, toastError, withBusy } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { openTmdbImport } from '../tmdb-import.js';
import { badge, dataTable, filterBar, listController, page, pager, panel, queryState, statusBadge, time } from '../ui.js';

export function posterThumb(src, alt = '') {
  if (!src) return h('span', { class: 'adm-thumb adm-thumb--empty', 'aria-hidden': 'true' }, icon('film'));
  return h('img', { class: 'adm-thumb', src, alt, loading: 'lazy', width: 34, height: 50 });
}

/** Matches every title (except locked Lumina key art) to TMDB and stores its real artwork. */
function syncAllButton(reload) {
  const btn = button('Sync artwork', { variant: 'ghost', icon: 'refresh' });
  btn.addEventListener('click', () => withBusy(btn, async () => {
    try {
      const { summary: s } = await adminApi.artwork.syncAll();
      const parts = [`${s.matched} matched`, s.notFound && `${s.notFound} without an exact TMDB match`, s.noArtwork && `${s.noArtwork} without TMDB artwork`, s.skipped && `${s.skipped} Lumina key art kept`, s.errors && `${s.errors} failed`].filter(Boolean);
      toast(`Artwork sync: ${parts.join(', ')}.`, { type: s.errors ? 'warn' : 'success', timeout: 8000 });
      reload();
    } catch (err) {
      toastError(err);
    }
  }));
  return btn;
}

export default async function render(ctx) {
  const state = queryState(ctx, { q: '', type: '', status: '', sort: 'updated', page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.titles.list({ ...s, pageSize: 25 }, opts),
    render: (data) => h('div', { class: 'adm-results' },
      dataTable({
        caption: 'Titles',
        empty: state.q || state.status || state.type ? 'No titles match these filters.' : 'The catalog is empty. Create the first title.',
        columns: [
          {
            key: 'title',
            label: 'Title',
            render: (t) => h('div', { class: 'adm-titlecell' }, posterThumb(t.poster),
              h('div', { class: 'adm-cellstack' },
                h('a', { href: `#/content/${encodeURIComponent(t.id)}` }, t.title),
                h('small', null, [t.id, t.creator ? `by ${t.creator.name}` : null].filter(Boolean).join(' · ')))),
          },
          { key: 'type', label: 'Type', render: (t) => (t.type === 'series' ? `Series · ${t.episodeCount} ep.` : 'Film') },
          { key: 'status', label: 'Status', render: (t) => h('div', { class: 'adm-badges' }, statusBadge(t.status), t.featured ? badge('Featured', '4k') : null) },
          { key: 'year', label: 'Year', className: 'adm-num' },
          { key: 'ageRating', label: 'Rating' },
          {
            key: 'media',
            label: 'Media',
            render: (t) => (t.media.total
              ? h('span', { title: `${t.media.ready} ready, ${t.media.verified} verified of ${t.media.total}` }, `${t.media.ready}/${t.media.total} ready`, t.media.verified < t.media.total ? h('small', { class: 'lm-muted' }, ` · ${t.media.total - t.media.verified} unverified`) : null)
              : h('span', { class: 'lm-muted' }, 'None')),
          },
          { key: 'updatedAt', label: 'Updated', render: (t) => time(t.updatedAt), className: 'adm-nowrap' },
        ],
        rows: data.items,
      }),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });

  const filters = filterBar({
    label: 'Filter titles',
    values: state,
    fields: [
      { name: 'q', label: 'Search', type: 'search', placeholder: 'Title or id' },
      { name: 'type', label: 'Type', type: 'select', options: [{ value: '', label: 'All types' }, { value: 'movie', label: 'Films' }, { value: 'series', label: 'Series' }] },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, { value: 'draft', label: 'Draft' }, { value: 'published', label: 'Published' }, { value: 'unpublished', label: 'Unpublished' }] },
      { name: 'sort', label: 'Sort by', type: 'select', options: [{ value: 'updated', label: 'Recently updated' }, { value: 'title', label: 'Title A–Z' }, { value: 'added', label: 'Recently added' }, { value: 'rank', label: 'Editorial rank' }] },
    ],
    onChange: (v) => {
      Object.assign(state, v, { page: 1 });
      list.load();
    },
  });

  list.load();
  return page({
    eyebrow: 'Catalog',
    title: 'Content',
    subtitle: 'Every film and series, including drafts. Publishing checks that a title has a synopsis, poster, licence and ready media.',
    actions: [
      syncAllButton(() => list.load()),
      button('Import from TMDB', { variant: 'ghost', icon: 'download', onClick: () => openTmdbImport(ctx) }),
      h('a', { class: 'lm-btn lm-btn--primary', href: '#/content/new' }, icon('plus'), h('span', null, 'New title')),
    ],
  }, panel({ flush: false }, filters), list.el);
}

// Media: every media entry across the catalog, with verification status and actions.
import { h } from '../../core/dom.js';
import { adminApi } from '../api.js';
import { mediaTable, openMediaEditor } from '../media-editor.js';
import { filterBar, listController, page, pager, panel, queryState } from '../ui.js';

export default async function render(ctx) {
  const state = queryState(ctx, { q: '', kind: '', status: '', verified: '', page: 1 });
  let origins = [];
  const list = listController(ctx, {
    state,
    fetch: async (s, opts) => {
      const r = await adminApi.media.list({ ...s, pageSize: 30 }, opts);
      origins = r.allowedOrigins || [];
      originsNote.textContent = origins.length ? `Remote sources are allowed from: ${origins.join(', ')} (MEDIA_ORIGINS).` : '';
      return r;
    },
    render: (data) => h('div', { class: 'adm-results' },
      panel({ flush: true },
        mediaTable(data.items, {
          showTitle: true,
          onChange: () => list.load(),
          onEdit: (m) => openMediaEditor({ media: m, onSaved: () => list.load() }),
          empty: 'No media entries match these filters.',
        })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  const originsNote = h('p', { class: 'lm-hint' });
  const filters = filterBar({
    label: 'Filter media',
    values: state,
    fields: [
      { name: 'q', label: 'Search', type: 'search', placeholder: 'Title, episode, source or id' },
      { name: 'kind', label: 'Kind', type: 'select', options: [{ value: '', label: 'All kinds' }, { value: 'hls', label: 'HLS' }, { value: 'progressive', label: 'Progressive' }, { value: 'dash', label: 'DASH' }] },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, { value: 'ready', label: 'Ready' }, { value: 'processing', label: 'Processing' }, { value: 'failed', label: 'Failed' }] },
      { name: 'verified', label: 'Verification', type: 'select', options: [{ value: '', label: 'Any' }, { value: '1', label: 'Verified' }, { value: '0', label: 'Not verified' }] },
    ],
    onChange: (v) => {
      Object.assign(state, v, { page: 1 });
      list.load();
    },
  });
  list.load();
  return page({
    eyebrow: 'Catalog',
    title: 'Media',
    subtitle: 'Playable sources for every title and episode. Verification reads the HLS manifest (or probes a local file) and records only the renditions and tracks that really exist — that is what viewers see as 4K, HD, audio and subtitle options.',
  }, panel({}, filters, originsNote), list.el);
}

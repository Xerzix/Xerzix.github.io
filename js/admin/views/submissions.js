// Submissions queue: creator uploads waiting for review, filterable by status.
import { h } from '../../core/dom.js';
import { adminApi } from '../api.js';
import { dataTable, filterBar, listController, page, pager, panel, queryState, statusBadge, statusLabel, time } from '../ui.js';

const STATUSES = ['queue', 'submitted', 'under_review', 'info_required', 'approved', 'rejected', 'published', 'all'];
const TYPE_LABELS = { movie: 'Feature film', short: 'Short film', documentary: 'Documentary', pilot: 'Pilot', series: 'Series', episode: 'Episode', trailer: 'Trailer' };

export default async function render(ctx) {
  const state = queryState(ctx, { status: 'queue', q: '', page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.submissions.list(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      panel({ flush: true }, dataTable({
        caption: 'Submissions',
        empty: state.status === 'queue' ? 'Nothing is waiting for review.' : 'No submissions match these filters.',
        columns: [
          { key: 'projectTitle', label: 'Project', render: (s) => h('div', { class: 'adm-cellstack' }, h('a', { href: `#/submissions/${encodeURIComponent(s.id)}` }, s.projectTitle), h('small', null, TYPE_LABELS[s.contentType] || s.contentType)) },
          { key: 'creator', label: 'Creator', render: (s) => h('div', { class: 'adm-cellstack' }, h('span', null, s.creator?.displayName || '—'), h('small', null, s.creator?.email)) },
          { key: 'fileCount', label: 'Files', className: 'adm-num' },
          { key: 'status', label: 'Status', render: (s) => statusBadge(s.status) },
          { key: 'submittedAt', label: 'Submitted', render: (s) => time(s.submittedAt), className: 'adm-nowrap' },
          { key: 'updatedAt', label: 'Updated', render: (s) => time(s.updatedAt), className: 'adm-nowrap' },
        ],
        rows: data.items,
      })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  list.load();
  return page({
    eyebrow: 'Creators',
    title: 'Submissions',
    subtitle: 'Review the files, rights and attestation of each submission. Approving does not publish anything: publishing creates a draft title that staff complete and publish separately.',
  }, panel({}, filterBar({
    label: 'Filter submissions',
    values: state,
    fields: [
      { name: 'q', label: 'Search', type: 'search', placeholder: 'Project or creator' },
      { name: 'status', label: 'Status', type: 'select', options: STATUSES.map((s) => ({ value: s, label: s === 'queue' ? 'Needs review (queue)' : s === 'all' ? 'All sent in' : statusLabel(s) })) },
    ],
    onChange: (v) => { Object.assign(state, v, { page: 1 }); list.load(); },
  })), list.el);
}

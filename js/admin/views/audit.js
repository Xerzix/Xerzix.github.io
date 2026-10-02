// Audit log (administrators): every privileged action, filterable by actor, action and target.
import { h } from '../../core/dom.js';
import { adminApi } from '../api.js';
import { dataTable, filterBar, jsonDetails, listController, mono, page, pager, panel, queryState, time } from '../ui.js';

const TARGET_LINKS = {
  title: (id) => `#/content/${encodeURIComponent(id)}`,
  account: (id) => `#/users/${encodeURIComponent(id)}`,
  submission: (id) => `#/submissions/${encodeURIComponent(id)}`,
};

export default async function render(ctx) {
  const state = queryState(ctx, { actor: '', action: '', targetType: '', targetId: '', page: 1 });
  let areas = [];
  const areaSelect = { name: 'action', label: 'Area', type: 'select', options: [{ value: '', label: 'All areas' }] };
  const list = listController(ctx, {
    state,
    fetch: async (s, opts) => {
      const r = await adminApi.platform.audit({ ...s, pageSize: 50 }, opts);
      if (!areas.length && r.areas.length) {
        areas = r.areas;
        const sel = filters.querySelector('select[name="action"]');
        for (const a of areas) sel.append(h('option', { value: `${a}.`, selected: state.action === `${a}.` }, a));
      }
      return r;
    },
    render: (data) => h('div', { class: 'adm-results' },
      panel({ flush: true }, dataTable({
        caption: 'Audit log',
        empty: 'No entries match these filters.',
        columns: [
          { key: 'createdAt', label: 'When', render: (a) => time(a.createdAt, { absolute: true }), className: 'adm-nowrap' },
          { key: 'action', label: 'Action', className: 'adm-nowrap', render: (a) => mono(a.action) },
          { key: 'actor', label: 'Actor', render: (a) => (a.actor ? h('a', { href: `#/users/${encodeURIComponent(a.actor.id)}` }, a.actor.email || a.actor.id) : 'System') },
          { key: 'target', label: 'Target', className: 'adm-break', render: (a) => (a.targetType ? (TARGET_LINKS[a.targetType] ? h('a', { href: TARGET_LINKS[a.targetType](a.targetId) }, `${a.targetType} ${a.targetId}`) : `${a.targetType} ${a.targetId || ''}`) : null) },
          { key: 'details', label: 'Details', render: (a) => jsonDetails(a.details) },
          { key: 'ip', label: 'IP', className: 'adm-nowrap', render: (a) => mono(a.ip || '—') },
        ],
        rows: data.items,
      })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  const filters = filterBar({
    label: 'Filter audit log',
    values: state,
    fields: [
      { name: 'actor', label: 'Actor', type: 'search', placeholder: 'Email or account id' },
      areaSelect,
      { name: 'targetType', label: 'Target type', type: 'select', options: [{ value: '', label: 'Any' }, ...['title', 'season', 'episode', 'media', 'account', 'review', 'comment', 'collection', 'submission', 'submission_file', 'creator_application', 'announcement', 'platform_setting', 'quality_report'].map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))] },
      { name: 'targetId', label: 'Target id', type: 'search', placeholder: 'Exact id' },
    ],
    onChange: (v) => { Object.assign(state, v, { page: 1 }); list.load(); },
  });
  list.load();
  return page({ eyebrow: 'Platform', title: 'Audit log', subtitle: 'Every privileged action — content, media, moderation, users, submissions and settings — with who did it, when and from where.' }, panel({}, filters), list.el);
}

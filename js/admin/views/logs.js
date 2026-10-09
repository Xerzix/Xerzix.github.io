// Logs & errors: in-memory server logs (administrators), player-reported playback errors and
// viewer quality reports (subjective, kept apart from measured telemetry).
import { h } from '../../core/dom.js';
import { toast, toastError, notice } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { staff } from '../shell.js';
import { appLink, dataTable, filterBar, jsonDetails, listController, mono, page, pager, panel, queryState, statusBadge, time, viewTabs } from '../ui.js';

function serverLogs(ctx) {
  if (!staff.isAdmin) return [notice('Server logs are limited to administrators.', { type: 'info' })];
  const state = queryState(ctx, { tab: 'server', level: 'info', q: '', limit: '200' });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.platform.logs(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      h('p', { class: 'lm-hint' }, data.note),
      panel({ flush: true }, dataTable({
        caption: 'Server log entries',
        empty: 'No log entries match.',
        columns: [
          { key: 't', label: 'Time', render: (e) => time(e.t, { absolute: true }), className: 'adm-nowrap' },
          { key: 'level', label: 'Level', render: (e) => h('span', { class: `adm-level adm-level--${e.level}` }, e.level) },
          { key: 'msg', label: 'Message', render: (e) => h('span', { style: { color: 'var(--lm-text)' } }, e.msg) },
          { key: 'fields', label: 'Fields', render: (e) => { const { t, level, msg, ...rest } = e; return jsonDetails(rest, Object.keys(rest).slice(0, 4).join(', ') || 'Details'); } },
        ],
        rows: data.items,
      }))),
  });
  list.load();
  return [panel({}, filterBar({
    label: 'Filter server logs',
    values: state,
    fields: [
      { name: 'q', label: 'Contains', type: 'search', placeholder: 'Text, request id, path…' },
      { name: 'level', label: 'Minimum level', type: 'select', options: ['debug', 'info', 'warn', 'error'].map((l) => ({ value: l, label: l[0].toUpperCase() + l.slice(1) })) },
      { name: 'limit', label: 'Show', type: 'select', options: ['100', '200', '500', '1000'].map((n) => ({ value: n, label: `${n} entries` })) },
    ],
    onChange: (v) => { Object.assign(state, v); list.load(); },
  })), list.el];
}

function playbackErrors(ctx) {
  const state = queryState(ctx, { tab: 'playback', code: '', fatal: '', page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.platform.playbackErrors(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      data.summary.length ? panel({ title: 'Last 7 days by error code', flush: true }, dataTable({
        caption: 'Errors by code',
        columns: [
          { key: 'code', label: 'Code', render: (s) => h('button', { type: 'button', class: 'lm-link', onClick: () => { state.code = s.code; state.page = 1; list.load(); } }, s.code) },
          { key: 'count', label: 'Errors', className: 'adm-num' },
          { key: 'fatal', label: 'Fatal', className: 'adm-num' },
          { key: 'lastAt', label: 'Last seen', render: (s) => time(s.lastAt) },
        ],
        rows: data.summary,
      })) : null,
      panel({ title: state.code ? `Errors with code ${state.code}` : 'All errors', flush: true }, dataTable({
        caption: 'Playback errors',
        empty: 'No playback errors have been reported.',
        columns: [
          { key: 'createdAt', label: 'When', render: (e) => time(e.createdAt, { absolute: true }), className: 'adm-nowrap' },
          { key: 'code', label: 'Code', render: (e) => h('div', { class: 'adm-cellstack' }, mono(e.code), e.fatal ? statusBadge('failed', 'Fatal') : null) },
          { key: 'title', label: 'Title', render: (e) => (e.titleId ? h('a', { href: `#/content/${encodeURIComponent(e.titleId)}?tab=media` }, e.titleName || e.titleId) : null) },
          { key: 'message', label: 'Message', render: (e) => h('span', { class: 'adm-truncate', title: e.message || '' }, e.message) },
          { key: 'details', label: 'Details', render: (e) => jsonDetails({ mediaId: e.mediaId, episodeId: e.episodeId, userAgent: e.userAgent, ...(e.details || {}) }) },
        ],
        rows: data.items,
      })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  list.load();
  return [panel({}, filterBar({
    label: 'Filter playback errors',
    values: state,
    fields: [
      { name: 'code', label: 'Code', type: 'search', placeholder: 'e.g. MEDIA_ERR_NETWORK' },
      { name: 'fatal', label: 'Severity', type: 'select', options: [{ value: '', label: 'All' }, { value: '1', label: 'Fatal only' }] },
    ],
    onChange: (v) => { Object.assign(state, v, { page: 1 }); list.load(); },
  })), list.el];
}

const CATEGORIES = ['buffering', 'interruptions', 'poor_quality', 'audio_sync', 'missing_subtitles', 'wrong_language', 'playback_error', 'crash', 'other'];

function qualityReports(ctx) {
  const state = queryState(ctx, { tab: 'quality', status: 'open', category: '', page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.platform.qualityReports(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      panel({ flush: true, description: 'Viewer reports are subjective. Measured player telemetry is summarised separately on Platform health.' }, dataTable({
        caption: 'Quality reports',
        empty: 'No quality reports match.',
        columns: [
          { key: 'createdAt', label: 'When', render: (q) => time(q.createdAt), className: 'adm-nowrap' },
          { key: 'category', label: 'Problem', render: (q) => h('div', { class: 'adm-cellstack' }, h('span', null, q.category.replace(/_/g, ' ')), q.description ? h('small', { class: 'adm-truncate', title: q.description }, q.description) : null) },
          { key: 'title', label: 'Title', render: (q) => appLink(q.titleName || q.titleId, `#/title/${encodeURIComponent(q.titleId)}`) },
          { key: 'device', label: 'Device & network', render: (q) => h('div', { class: 'adm-cellstack' }, h('span', null, q.device || '—'), h('small', null, [q.connectionMbps ? `${q.connectionMbps} Mb/s` : null, q.selectedResolution].filter(Boolean).join(' · '))) },
          { key: 'diagnostics', label: 'Diagnostics', render: (q) => jsonDetails(q.diagnostics) },
          {
            key: 'status',
            label: 'Status',
            render: (q) => {
              const sel = h('select', { class: 'lm-select adm-compact', 'aria-label': `Status of report ${q.id}` }, ...['open', 'acknowledged', 'resolved'].map((s) => h('option', { value: s, selected: s === q.status }, s[0].toUpperCase() + s.slice(1))));
              sel.addEventListener('change', async () => {
                try {
                  await adminApi.platform.setQualityStatus(q.id, sel.value);
                  toast(`Marked ${sel.value}.`, { type: 'success' });
                } catch (err) {
                  sel.value = q.status;
                  toastError(err);
                }
              });
              return sel;
            },
          },
        ],
        rows: data.items,
      })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  list.load();
  return [panel({}, filterBar({
    label: 'Filter quality reports',
    values: state,
    fields: [
      { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All' }, { value: 'open', label: 'Open' }, { value: 'acknowledged', label: 'Acknowledged' }, { value: 'resolved', label: 'Resolved' }] },
      { name: 'category', label: 'Problem', type: 'select', options: [{ value: '', label: 'All problems' }, ...CATEGORIES.map((c) => ({ value: c, label: c.replace(/_/g, ' ') }))] },
    ],
    onChange: (v) => { Object.assign(state, v, { page: 1 }); list.load(); },
  })), list.el];
}

export default async function render(ctx) {
  const requested = ctx.query.get('tab');
  const tab = ['server', 'playback', 'quality'].includes(requested) ? requested : staff.isAdmin ? 'server' : 'playback';
  const body = tab === 'server' ? serverLogs(ctx) : tab === 'quality' ? qualityReports(ctx) : playbackErrors(ctx);
  return page({ eyebrow: 'Platform', title: 'Logs & errors', subtitle: 'What the server logged, what players reported as errors, and what viewers told us about playback quality.' },
    viewTabs({
      label: 'Log sources',
      base: '/logs',
      active: tab,
      tabs: [{ id: 'server', label: 'Server logs', query: 'tab=server' }, { id: 'playback', label: 'Playback errors', query: 'tab=playback' }, { id: 'quality', label: 'Quality reports', query: 'tab=quality' }],
    }),
    ...body);
}

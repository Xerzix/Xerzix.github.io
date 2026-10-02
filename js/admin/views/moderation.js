// Moderation: reports grouped by reported item (with a preview), the reviews list
// (including spam-held reviews) and the moderation history from the audit log.
import { h, newUid } from '../../core/dom.js';
import { bus } from '../../core/bus.js';
import { button, field, stars, toast, toastError, withBusy } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { staff } from '../shell.js';
import { appLink, badge, confirmWithNote, dataTable, filterBar, jsonDetails, listController, mono, page, pager, panel, queryState, statusBadge, time, viewTabs } from '../ui.js';

const ACTIONS = [
  { value: 'dismiss', label: 'Dismiss', hint: 'No violation. Reports are closed; the content stays.' },
  { value: 'hide', label: 'Hide', hint: 'Hidden from everyone but its author. Reversible from the Reviews tab.' },
  { value: 'remove', label: 'Remove', hint: 'Removed for a clear violation. The author is notified.', danger: true },
  { value: 'suspend_author', label: 'Suspend author', hint: 'Hides the content and suspends the author’s account, signing them out everywhere.', danger: true },
];
const TYPE_LABEL = { review: 'Review', comment: 'Comment', collection: 'Shared collection' };

function reportCard(group, onDone) {
  const t = group.target;
  const name = newUid('act');
  const authorIsStaff = t.author && t.author.role !== 'member';
  const actions = ACTIONS.filter((a) => a.value !== 'suspend_author' || !authorIsStaff || staff.isAdmin);
  const hint = h('p', { class: 'lm-hint' });
  const radios = h('fieldset', { class: 'adm-radio-row' }, h('legend', { class: 'lm-label' }, 'Decision'),
    ...actions.map((a, i) => h('label', { class: ['adm-radio', a.danger && 'adm-radio--danger'] }, h('input', { type: 'radio', name, value: a.value, checked: i === 0, disabled: !t.exists && a.value !== 'dismiss' }), h('span', null, a.label))));
  const days = field({ label: 'Suspension length', name: 'suspendDays', type: 'select', value: '7', options: [{ value: '1', label: '1 day' }, { value: '3', label: '3 days' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }, { value: '', label: 'Until reinstated' }] });
  const note = field({ label: 'Internal note', name: 'note', maxlength: 1000, hint: 'Recorded in the moderation history.' });
  const toAuthor = field({ label: 'Message to the author (optional)', name: 'messageToAuthor', maxlength: 1000 });
  const submit = button('Apply decision', { variant: 'primary' });
  const sync = () => {
    const a = radios.querySelector('input:checked').value;
    hint.textContent = ACTIONS.find((x) => x.value === a).hint;
    days.hidden = a !== 'suspend_author';
    toAuthor.hidden = a === 'dismiss';
  };
  radios.addEventListener('change', sync);
  sync();
  const form = h('form', { class: 'adm-resolve', novalidate: true, onSubmit: (e) => { e.preventDefault(); submit.click(); } },
    radios, hint, h('div', { class: 'adm-resolve__fields' }, days, note, toAuthor), submit);
  submit.addEventListener('click', () => withBusy(submit, async () => {
    const action = radios.querySelector('input:checked').value;
    try {
      const r = await adminApi.moderation.resolve(group.reports[0].id, {
        action,
        note: note.control.value.trim() || undefined,
        messageToAuthor: toAuthor.control.value.trim() || undefined,
        suspendDays: action === 'suspend_author' ? (days.control.value ? Number(days.control.value) : null) : undefined,
      });
      toast(action === 'dismiss' ? 'Reports dismissed.' : `Done — ${r.resolved} report${r.resolved === 1 ? '' : 's'} resolved${r.suspended ? ', author suspended' : ''}.`, { type: 'success' });
      bus.emit('admin:queues-changed');
      onDone();
    } catch (err) {
      toastError(err);
    }
  }));

  const context = t.exists ? [
    t.context?.titleName ? h('span', null, 'on ', appLink(t.context.titleName, `#/title/${encodeURIComponent(t.context.titleId)}`)) : null,
    t.context?.collectionName ? h('span', null, `“${t.context.collectionName}” · ${t.context.itemCount} titles · ${t.context.visibility}`) : null,
  ] : [];
  return h('article', { class: 'adm-panel' }, h('div', { class: 'adm-panel__body adm-report' },
    h('div', { class: 'lm-cluster' },
      badge(TYPE_LABEL[group.targetType] || group.targetType, 'solid'),
      h('strong', null, `${group.count} report${group.count === 1 ? '' : 's'}`),
      ...group.reasons.map((r) => badge(`${r.label}${r.count > 1 ? ` ×${r.count}` : ''}`, 'warn')),
      h('span', { class: 'lm-spacer' }),
      h('span', { class: 'lm-hint' }, 'Last reported ', time(group.lastReportedAt))),
    t.exists
      ? h('div', { class: 'lm-stack lm-stack--sm' },
        h('div', { class: 'lm-cluster lm-small lm-muted' },
          h('span', null, 'By ', t.author?.accountId ? h('a', { class: 'lm-link', href: `#/users/${encodeURIComponent(t.author.accountId)}` }, t.author.name || t.author.email) : 'unknown'),
          t.author?.role && t.author.role !== 'member' ? badge(t.author.role, 'accent') : null,
          ...context,
          t.rating ? stars(t.rating) : null,
          t.containsSpoilers ? badge('Spoilers', 'warn') : null,
          statusBadge(t.status)),
        h('blockquote', { class: 'adm-quote' }, t.body || '(No text — rating only)'))
      : h('blockquote', { class: ['adm-quote', 'adm-quote--gone'] }, 'The reported item has been deleted.'),
    h('details', null, h('summary', { class: 'lm-small lm-muted' }, `Report details (${group.reports.length})`),
      h('ul', { class: 'lm-stack lm-stack--sm', style: { margin: '10px 0 0', paddingLeft: '1.2em' } }, ...group.reports.map((r) => h('li', { class: 'lm-small' },
        h('strong', null, r.reasonLabel), ' · ', r.reporter?.email || 'deleted account', ' · ', time(r.createdAt),
        r.details ? h('p', { class: 'lm-muted' }, r.details) : null,
        r.status !== 'open' ? h('p', { class: 'lm-hint' }, `${r.status} ${r.resolvedBy ? `by ${r.resolvedBy}` : ''} ${r.resolutionNote ? `— ${r.resolutionNote}` : ''}`) : null)))),
    group.reports.some((r) => r.status === 'open') ? form : null));
}

function reportsTab(ctx) {
  const state = queryState(ctx, { tab: 'reports', status: 'open', type: '', page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.moderation.reports(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      data.items.length
        ? h('div', { class: 'lm-stack' }, ...data.items.map((g) => reportCard(g, () => list.load())))
        : panel({}, h('p', { class: 'lm-muted' }, state.status === 'open' ? 'No open reports. The community is calm.' : 'No reports match these filters.')),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  list.load();
  return [panel({}, filterBar({
    label: 'Filter reports',
    values: state,
    fields: [
      { name: 'status', label: 'Status', type: 'select', options: [{ value: 'open', label: 'Open' }, { value: 'actioned', label: 'Actioned' }, { value: 'dismissed', label: 'Dismissed' }, { value: 'all', label: 'All' }] },
      { name: 'type', label: 'Item', type: 'select', options: [{ value: '', label: 'All items' }, { value: 'review', label: 'Reviews' }, { value: 'comment', label: 'Comments' }, { value: 'collection', label: 'Shared collections' }] },
    ],
    onChange: (v) => { Object.assign(state, v, { page: 1 }); list.load(); },
  })), list.el];
}

async function setReview(r, status, onDone) {
  const copy = {
    visible: { title: 'Approve this review?', label: 'Approve', message: 'It becomes visible on the title page and counts towards the member rating.' },
    hidden: { title: 'Hide this review?', label: 'Hide', message: 'Only its author will see it. The author is notified.' },
    removed: { title: 'Remove this review?', label: 'Remove', message: 'Removed for a clear violation of the Community Guidelines. The author is notified.', danger: true },
  }[status];
  const res = await confirmWithNote({ title: copy.title, message: copy.message, confirmLabel: copy.label, danger: copy.danger, noteLabel: 'Internal note (optional)' });
  if (!res) return;
  try {
    await adminApi.moderation.setReview(r.id, { status, note: res.note });
    toast(`Review ${status === 'visible' ? 'approved' : status}.`, { type: 'success' });
    bus.emit('admin:queues-changed');
    onDone();
  } catch (err) {
    toastError(err);
  }
}

function reviewsTab(ctx) {
  const state = queryState(ctx, { tab: 'reviews', status: '', q: '', reported: '', page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.moderation.reviews(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      panel({ flush: true }, dataTable({
        caption: 'Reviews',
        empty: 'No reviews match these filters.',
        columns: [
          {
            key: 'body',
            label: 'Review',
            render: (r) => h('div', { class: 'adm-cellstack', style: { maxWidth: '46ch' } },
              h('span', { class: 'lm-cluster lm-cluster--sm' }, stars(r.rating), r.containsSpoilers ? badge('Spoilers', 'warn') : null, r.openReports ? badge(`${r.openReports} report${r.openReports === 1 ? '' : 's'}`, 'danger') : null),
              h('span', { style: { whiteSpace: 'pre-wrap', color: 'var(--lm-text)' } }, r.body ? (r.body.length > 280 ? `${r.body.slice(0, 280)}…` : r.body) : h('em', { class: 'lm-muted' }, 'Rating only')),
              r.moderationNote ? h('small', null, `Note: ${r.moderationNote}`) : null),
          },
          { key: 'titleName', label: 'Title', className: 'adm-minw', render: (r) => appLink(r.titleName || r.titleId, `#/title/${encodeURIComponent(r.titleId)}`) },
          { key: 'author', label: 'Author', render: (r) => h('div', { class: 'adm-cellstack' }, h('a', { href: `#/users/${encodeURIComponent(r.author.accountId)}` }, r.author.name), h('small', null, r.author.email), r.author.status === 'suspended' ? badge('Suspended', 'danger') : null) },
          { key: 'status', label: 'Status', render: (r) => h('div', { class: 'adm-cellstack' }, statusBadge(r.status, r.status === 'pending' ? 'Held (spam filter)' : undefined), r.spamScore ? h('small', null, `Spam score ${r.spamScore.toFixed(2)}`) : null) },
          { key: 'createdAt', label: 'Posted', render: (r) => time(r.createdAt), className: 'adm-nowrap' },
          {
            key: 'actions',
            label: 'Actions',
            render: (r) => h('div', { class: 'adm-actions' },
              r.status !== 'visible' ? button('Approve', { variant: 'ghost', size: 'sm', onClick: () => setReview(r, 'visible', () => list.load()), attrs: { 'aria-label': `Approve review by ${r.author.name}` } }) : null,
              r.status !== 'hidden' ? button('Hide', { variant: 'ghost', size: 'sm', onClick: () => setReview(r, 'hidden', () => list.load()), attrs: { 'aria-label': `Hide review by ${r.author.name}` } }) : null,
              r.status !== 'removed' ? button('Remove', { variant: 'danger', size: 'sm', onClick: () => setReview(r, 'removed', () => list.load()), attrs: { 'aria-label': `Remove review by ${r.author.name}` } }) : null),
          },
        ],
        rows: data.items,
      })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  list.load();
  return [panel({}, filterBar({
    label: 'Filter reviews',
    values: state,
    fields: [
      { name: 'q', label: 'Search', type: 'search', placeholder: 'Text, title or author' },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'All statuses' }, { value: 'pending', label: 'Held by spam filter' }, { value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' }, { value: 'removed', label: 'Removed' }] },
      { name: 'reported', label: 'Reports', type: 'select', options: [{ value: '', label: 'Any' }, { value: '1', label: 'With open reports' }] },
    ],
    onChange: (v) => { Object.assign(state, v, { page: 1 }); list.load(); },
  })), list.el];
}

function historyTab(ctx) {
  const state = queryState(ctx, { tab: 'history', page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.moderation.history(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      panel({ flush: true }, dataTable({
        caption: 'Moderation history',
        empty: 'No moderation actions yet.',
        columns: [
          { key: 'createdAt', label: 'When', render: (a) => time(a.createdAt, { absolute: true }), className: 'adm-nowrap' },
          { key: 'action', label: 'Action', className: 'adm-nowrap', render: (a) => mono(a.action.replace(/^moderation\./, '')) },
          { key: 'target', label: 'Target', render: (a) => (a.targetType === 'account' ? h('a', { href: `#/users/${encodeURIComponent(a.targetId)}` }, `account ${a.targetId}`) : `${a.targetType} ${a.targetId}`) },
          { key: 'actor', label: 'Moderator', render: (a) => a.actor?.email || 'System' },
          { key: 'details', label: 'Details', render: (a) => jsonDetails(a.details) },
        ],
        rows: data.items,
      })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  list.load();
  return [list.el];
}

export default async function render(ctx) {
  const tab = ['reports', 'reviews', 'history'].includes(ctx.query.get('tab')) ? ctx.query.get('tab') : 'reports';
  const body = tab === 'reviews' ? reviewsTab(ctx) : tab === 'history' ? historyTab(ctx) : reportsTab(ctx);
  return page({
    eyebrow: 'Community',
    title: 'Moderation',
    subtitle: 'Decisions follow the Community Guidelines. Every action is recorded in the moderation history, and authors are told when their content is hidden or removed.',
  },
  viewTabs({ label: 'Moderation sections', base: '/moderation', active: tab, tabs: [{ id: 'reports', label: 'Reports', query: '' }, { id: 'reviews', label: 'Reviews', query: 'tab=reviews' }, { id: 'history', label: 'History', query: 'tab=history' }] }),
  ...body);
}

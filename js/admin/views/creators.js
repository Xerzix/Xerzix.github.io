// Creator applications: review queue with a decision drawer (approve / request info / reject).
import { h } from '../../core/dom.js';
import { countryName } from '../../core/format.js';
import { bus } from '../../core/bus.js';
import { button, field, toast, withBusy } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { dataTable, drawer, filterBar, kv, listController, page, pager, panel, queryState, safeExternal, statusBadge, time, viewTabs } from '../ui.js';

const STATUS_TABS = [
  { id: 'pending', label: 'Pending' },
  { id: 'info_required', label: 'Info required' },
  { id: 'approved', label: 'Approved' },
  { id: 'rejected', label: 'Rejected' },
  { id: 'all', label: 'All' },
];

function openApplication(app, onDone) {
  const decision = h('fieldset', { class: 'adm-radio-row' },
    h('legend', { class: 'lm-label' }, 'Decision'),
    ...[
      ['approve', 'Approve — grant creator access'],
      ['info_required', 'Ask for more information'],
      ['reject', 'Reject'],
    ].map(([value, label], i) => h('label', { class: ['adm-radio', value === 'reject' && 'adm-radio--danger'] }, h('input', { type: 'radio', name: 'decision', value, checked: i === 0 }), h('span', null, label))));
  const note = field({ label: 'Note to the applicant', name: 'note', type: 'textarea', rows: 4, maxlength: 2000, hint: 'Required when asking for information or rejecting. The applicant sees this note in their notifications.' });
  const submit = button('Record decision', { variant: 'primary', icon: 'check' });
  const content = h('div', { class: 'adm-modal-stack' },
    kv([
      ['Status', statusBadge(app.status)],
      ['Legal name', app.legalName],
      ['Account', app.account ? h('a', { class: 'lm-link', href: `#/users/${encodeURIComponent(app.accountId)}` }, `${app.account.displayName || ''} <${app.account.email}>`) : app.accountId],
      ['Contact email', app.contactEmail],
      ['Company', app.company],
      ['Country', app.country ? countryName(app.country.toUpperCase()) : null],
      ['Website', app.website ? safeExternal(app.website) : null],
      ['Portfolio', app.portfolio ? safeExternal(app.portfolio) : null],
      ['Applied', time(app.createdAt, { absolute: true })],
      app.reviewedAt ? ['Last decision', h('span', null, time(app.reviewedAt, { absolute: true }), app.reviewedBy ? ` by ${app.reviewedBy}` : '')] : null,
      app.reviewerNote ? ['Previous note', app.reviewerNote] : null,
    ]),
    h('div', null, h('h3', { class: 'lm-label' }, 'About their work'), h('p', { class: 'adm-quote' }, app.bio)),
    h('form', { class: 'lm-form', novalidate: true, onSubmit: (e) => { e.preventDefault(); submit.click(); } }, decision, note));
  const d = drawer({ title: `Application · ${app.legalName}`, content, actions: [button('Close', { variant: 'ghost', onClick: () => d.close() }), submit] });
  submit.addEventListener('click', () => withBusy(submit, async () => {
    const value = decision.querySelector('input:checked').value;
    try {
      await adminApi.creators.decide(app.id, { decision: value, note: note.control.value.trim() || undefined });
      toast(value === 'approve' ? 'Approved. The applicant can now submit work.' : 'Decision recorded and the applicant notified.', { type: 'success' });
      bus.emit('admin:queues-changed');
      d.close();
      onDone();
    } catch (err) {
      note.setError(err.fields?.note || '');
      if (!err.fields) toast(err.message, { type: 'error' });
    }
  }));
}

export default async function render(ctx) {
  const state = queryState(ctx, { status: 'pending', q: '', page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.creators.list(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      panel({ flush: true }, dataTable({
        caption: 'Creator applications',
        empty: state.status === 'pending' ? 'No applications are waiting. You’re all caught up.' : 'No applications match.',
        columns: [
          {
            key: 'legalName',
            label: 'Applicant',
            render: (a) => h('div', { class: 'adm-cellstack' },
              h('button', { type: 'button', class: 'lm-link', style: { textAlign: 'left' }, onClick: () => openApplication(a, () => list.load()) }, a.legalName),
              h('small', null, a.account?.email || a.contactEmail)),
          },
          { key: 'company', label: 'Company' },
          { key: 'country', label: 'Country', render: (a) => (a.country ? countryName(a.country.toUpperCase()) : null) },
          { key: 'createdAt', label: 'Applied', render: (a) => time(a.createdAt), className: 'adm-nowrap' },
          { key: 'status', label: 'Status', render: (a) => statusBadge(a.status) },
          { key: 'review', label: 'Actions', render: (a) => button('Review', { variant: 'ghost', size: 'sm', onClick: () => openApplication(a, () => list.load()), attrs: { 'aria-label': `Review ${a.legalName}` } }) },
        ],
        rows: data.items,
      })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });
  list.load();
  return page({
    eyebrow: 'Creators',
    title: 'Creator applications',
    subtitle: 'Approving an application lets that account upload work for review. Approval never publishes anything.',
  },
  viewTabs({ label: 'Application status', base: '/creators', active: state.status, tabs: STATUS_TABS.map((s) => ({ ...s, query: `status=${s.id}` })) }),
  panel({}, filterBar({ label: 'Search applications', values: state, fields: [{ name: 'q', label: 'Search', type: 'search', placeholder: 'Name, email or company' }], onChange: (v) => { Object.assign(state, v, { page: 1 }); list.load(); } })),
  list.el);
}

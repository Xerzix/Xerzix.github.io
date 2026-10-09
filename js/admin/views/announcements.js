// Announcements: platform-wide notices delivered through every member's notification centre.
import { h } from '../../core/dom.js';
import { button, confirmDialog, field, toast, toastError, withBusy } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { dataTable, errorSummary, listController, page, pager, panel, queryState, statusBadge, textField, time } from '../ui.js';

const toIso = (local) => (local ? new Date(local).toISOString() : undefined);

export default async function render(ctx) {
  const state = queryState(ctx, { page: 1 });
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.announcements.list(s, opts),
    render: (data) => h('div', { class: 'adm-results' },
      panel({ title: 'All announcements', flush: true }, dataTable({
        caption: 'Announcements',
        empty: 'No announcements yet.',
        columns: [
          { key: 'title', label: 'Announcement', render: (a) => h('div', { class: 'adm-cellstack', style: { maxWidth: '48ch' } }, h('span', null, a.title), h('small', null, a.body), a.link ? h('small', null, 'Link: ', h('code', null, a.link)) : null) },
          { key: 'audience', label: 'Audience', render: (a) => (a.audience === 'creators' ? 'Creators' : 'Everyone') },
          { key: 'window', label: 'Shown', render: (a) => h('div', { class: 'adm-cellstack' }, h('span', null, 'from ', time(a.startsAt, { absolute: true })), h('small', null, a.endsAt ? h('span', null, 'until ', time(a.endsAt, { absolute: true })) : 'no end date')) },
          { key: 'state', label: 'State', render: (a) => statusBadge(a.state === 'active' ? 'active' : a.state) },
          { key: 'reads', label: 'Read / dismissed', className: 'adm-num', render: (a) => `${a.reads} / ${a.dismissals}` },
          {
            key: 'actions',
            label: 'Actions',
            render: (a) => button('Delete', {
              variant: 'ghost', size: 'sm', icon: 'trash', attrs: { 'aria-label': `Delete announcement ${a.title}` },
              onClick: async () => {
                if (!(await confirmDialog({ title: 'Delete this announcement?', message: 'It disappears from every notification centre immediately.', confirmLabel: 'Delete', danger: true }))) return;
                try {
                  await adminApi.announcements.remove(a.id);
                  toast('Announcement deleted.', { type: 'success' });
                  list.load();
                } catch (err) {
                  toastError(err);
                }
              },
            }),
          },
        ],
        rows: data.items,
      })),
      pager({ ...data, onPage: (p) => { state.page = p; list.load(); } })),
  });

  const title = textField({ label: 'Title', name: 'title', required: true, maxlength: 120 });
  const body = textField({ label: 'Message', name: 'body', type: 'textarea', rows: 4, required: true, maxlength: 1000 });
  const link = field({ label: 'Link (optional)', name: 'link', placeholder: '#/new or https://…', hint: 'An in-app link starting with #/ or an https URL.' });
  const audience = field({ label: 'Audience', name: 'audience', type: 'select', options: [{ value: 'all', label: 'Everyone with an account' }, { value: 'creators', label: 'Creators only' }] });
  const startsAt = field({ label: 'Starts', name: 'startsAt', type: 'datetime-local', hint: 'Leave empty to start now.' });
  const endsAt = field({ label: 'Ends (optional)', name: 'endsAt', type: 'datetime-local' });
  const summary = errorSummary();
  const submit = button('Publish announcement', { variant: 'primary', icon: 'bell' });
  const form = h('form', { class: 'lm-form', novalidate: true, onSubmit: (e) => { e.preventDefault(); submit.click(); } },
    summary, title, body, h('div', { class: 'adm-fields' }, link, audience), h('div', { class: 'adm-fields' }, startsAt, endsAt), h('div', null, submit));
  submit.addEventListener('click', () => withBusy(submit, async () => {
    summary.clear();
    try {
      await adminApi.announcements.create({
        title: title.control.value.trim(),
        body: body.control.value.trim(),
        link: link.control.value.trim() || null,
        audience: audience.control.value,
        startsAt: toIso(startsAt.control.value),
        endsAt: toIso(endsAt.control.value) || null,
      });
      toast('Announcement published.', { type: 'success' });
      form.reset();
      for (const f of form.querySelectorAll('.lm-field')) f.setError?.('');
      list.load();
    } catch (err) {
      for (const f of [title, body, link, audience, startsAt, endsAt]) f.setError(err.fields?.[f.control.name] || '');
      if (!err.fields) summary.show(err);
    }
  }));

  list.load();
  return page({
    eyebrow: 'Communication',
    title: 'Announcements',
    subtitle: 'Announcements appear in members’ notification centres while they are active. Members who turned off “Platform announcements” in their notification preferences do not see them.',
  }, h('div', { class: 'adm-grid-2' }, list.el, h('div', { class: 'adm-sticky' }, panel({ title: 'New announcement' }, form))));
}

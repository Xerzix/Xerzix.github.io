// Users: search and filter accounts.
import { h } from '../../core/dom.js';
import { adminApi } from '../api.js';
import { badge, dataTable, filterBar, listController, num, page, pager, panel, queryState, statTile, statusBadge, tiles, time } from '../ui.js';

export default async function render(ctx) {
  const state = queryState(ctx, { q: '', role: '', status: '', creator: '', page: 1 });
  const counts = h('div');
  const list = listController(ctx, {
    state,
    fetch: (s, opts) => adminApi.users.list(s, opts),
    render: (data) => {
      counts.replaceChildren(tiles(
        statTile({ label: 'Accounts', value: num(data.counts.total) }),
        statTile({ label: 'Staff', value: num(data.counts.staff) }),
        statTile({ label: 'Creators', value: num(data.counts.creators) }),
        statTile({ label: 'Suspended', value: num(data.counts.suspended), tone: data.counts.suspended ? 'attention' : undefined }),
      ));
      return h('div', { class: 'adm-results' },
        panel({ flush: true }, dataTable({
          caption: 'Accounts',
          empty: 'No accounts match these filters.',
          columns: [
            { key: 'displayName', label: 'Account', render: (u) => h('div', { class: 'adm-cellstack' }, h('a', { href: `#/users/${encodeURIComponent(u.id)}` }, u.displayName || u.email), h('small', null, u.email)) },
            { key: 'role', label: 'Role', render: (u) => h('div', { class: 'adm-badges' }, statusBadge(u.role), u.isCreator ? badge('Creator', '4k') : null) },
            { key: 'status', label: 'Status', render: (u) => h('div', { class: 'adm-cellstack' }, statusBadge(u.status), u.suspendedUntil ? h('small', null, 'until ', time(u.suspendedUntil)) : null) },
            { key: 'totpEnabled', label: '2FA', render: (u) => (u.totpEnabled ? badge('On', 'ok') : h('span', { class: 'lm-muted' }, 'Off')) },
            { key: 'profileCount', label: 'Profiles', className: 'adm-num', render: (u) => `${u.profileCount}/${u.maxProfiles}` },
            { key: 'activeSessions', label: 'Sessions', className: 'adm-num' },
            { key: 'createdAt', label: 'Joined', render: (u) => time(u.createdAt), className: 'adm-nowrap' },
            { key: 'lastLoginAt', label: 'Last sign-in', render: (u) => time(u.lastLoginAt), className: 'adm-nowrap' },
          ],
          rows: data.items,
        })),
        pager({ ...data, onPage: (p) => { state.page = p; list.load(); } }));
    },
  });
  list.load();
  return page({
    eyebrow: 'People',
    title: 'Users',
    subtitle: 'Only administrators change roles, profile limits or creator access. Moderators can suspend member accounts.',
  }, counts, panel({}, filterBar({
    label: 'Filter accounts',
    values: state,
    fields: [
      { name: 'q', label: 'Search', type: 'search', placeholder: 'Email, name or account id' },
      { name: 'role', label: 'Role', type: 'select', options: [{ value: '', label: 'All roles' }, { value: 'member', label: 'Members' }, { value: 'staff', label: 'Staff' }, { value: 'moderator', label: 'Moderators' }, { value: 'admin', label: 'Administrators' }] },
      { name: 'status', label: 'Status', type: 'select', options: [{ value: '', label: 'Any status' }, { value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }] },
      { name: 'creator', label: 'Creators', type: 'select', options: [{ value: '', label: 'Everyone' }, { value: '1', label: 'Creators only' }] },
    ],
    onChange: (v) => { Object.assign(state, v, { page: 1 }); list.load(); },
  })), list.el);
}

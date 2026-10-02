// User detail: account facts, role/status/limits form (with the server's rules mirrored in
// the UI), sessions, reviews, submissions, creator application and account history.
import { h } from '../../core/dom.js';
import { button, checkbox, confirmDialog, field, notice, toast, toastError, withBusy } from '../../ui/components.js';
import { stars } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { staff } from '../shell.js';
import { appLink, badge, dataTable, errorSummary, jsonDetails, kv, mono, page, panel, rerender, statusBadge, time } from '../ui.js';

const toLocalInput = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export default async function render(ctx) {
  const root = h('div');
  let data = await adminApi.users.get(ctx.params.id, { signal: ctx.signal });

  function accountForm() {
    const a = data.account;
    const self = a.id === staff.account.id;
    const canManage = staff.isAdmin || a.role === 'member';
    const summary = errorSummary();
    const role = field({ label: 'Role', name: 'role', type: 'select', value: a.role, options: [{ value: 'member', label: 'Member' }, { value: 'moderator', label: 'Moderator' }, { value: 'admin', label: 'Administrator' }], hint: self ? 'You cannot change your own role.' : staff.isAdmin ? 'Staff must confirm their password every 15 minutes to use the dashboard.' : 'Only administrators change roles.' });
    role.control.disabled = self || !staff.isAdmin;
    const status = field({ label: 'Status', name: 'status', type: 'select', value: a.status, options: [{ value: 'active', label: 'Active' }, { value: 'suspended', label: 'Suspended' }], hint: self ? 'You cannot suspend your own account.' : 'Suspending signs the account out everywhere.' });
    status.control.disabled = self || !canManage;
    const reason = field({ label: 'Suspension reason', name: 'suspendedReason', value: a.suspendedReason || '', maxlength: 500, hint: 'Shown to the member in a notification.' });
    const until = field({ label: 'Suspended until', name: 'suspendedUntil', type: 'datetime-local', value: toLocalInput(a.suspendedUntil), hint: 'Leave empty for an indefinite suspension.' });
    const maxProfiles = field({ label: 'Profile limit', name: 'maxProfiles', type: 'number', value: a.maxProfiles, min: 1, max: 5 });
    maxProfiles.control.disabled = !staff.isAdmin;
    const creator = checkbox('Creator access (can submit work)', { name: 'isCreator', checked: a.isCreator });
    creator.querySelector('input').disabled = !staff.isAdmin;
    const suspension = h('div', { class: 'adm-fields' }, reason, until);
    const sync = () => { suspension.hidden = status.control.value !== 'suspended'; };
    status.control.addEventListener('change', sync);
    sync();
    const save = button('Save account', { variant: 'primary', icon: 'check', disabled: !canManage });
    save.addEventListener('click', () => withBusy(save, async () => {
      summary.clear();
      const body = {};
      if (!role.control.disabled && role.control.value !== a.role) body.role = role.control.value;
      if (!status.control.disabled) {
        body.status = status.control.value;
        if (body.status === 'suspended') {
          body.suspendedReason = reason.control.value.trim() || null;
          body.suspendedUntil = until.control.value ? new Date(until.control.value).toISOString() : null;
        }
        if (body.status === a.status && body.status === 'active') delete body.status;
      }
      if (staff.isAdmin) {
        if (Number(maxProfiles.control.value) !== a.maxProfiles) body.maxProfiles = Number(maxProfiles.control.value);
        const c = creator.querySelector('input').checked;
        if (c !== a.isCreator) body.isCreator = c;
      }
      if (!Object.keys(body).length) {
        toast('Nothing changed.', { type: 'info' });
        return;
      }
      if (body.role && !(await confirmDialog({ title: `Make ${a.displayName || a.email} ${body.role === 'admin' ? 'an administrator' : body.role === 'moderator' ? 'a moderator' : 'a member'}?`, message: body.role === 'admin' ? 'Administrators can change roles, settings and delete content.' : 'Their dashboard access changes immediately.', confirmLabel: 'Change role', danger: body.role === 'admin' }))) return;
      if (body.status === 'suspended' && a.status !== 'suspended' && !(await confirmDialog({ title: 'Suspend this account?', message: 'They are signed out on every device and cannot sign in until the suspension ends or is lifted.', confirmLabel: 'Suspend', danger: true }))) return;
      try {
        data = await adminApi.users.update(a.id, body);
        toast('Account updated.', { type: 'success' });
        draw();
      } catch (err) {
        for (const f of [role, status, reason, until, maxProfiles]) f.setError(err.fields?.[f.control.name] || '');
        summary.show(err);
      }
    }));
    return panel({ title: 'Access', description: canManage ? null : 'Moderators can manage member accounts only.' },
      h('form', { class: 'lm-form', novalidate: true, onSubmit: (e) => { e.preventDefault(); save.click(); } },
        summary,
        h('div', { class: 'adm-fields' }, role, status),
        suspension,
        h('div', { class: 'adm-fields' }, maxProfiles, h('div', { class: 'lm-field', style: { justifyContent: 'center' } }, creator)),
        h('div', null, save)));
  }

  function sessionsPanel() {
    const a = data.account;
    const canManage = staff.isAdmin || a.role === 'member' || a.id === staff.account.id;
    const revoke = button('Sign out everywhere', { variant: 'danger', size: 'sm', icon: 'logout', disabled: !canManage || !data.sessions.length });
    revoke.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Sign this account out everywhere?', message: a.id === staff.account.id ? 'Your other sessions are ended; this one stays signed in.' : 'Every active session is ended immediately.', confirmLabel: 'Sign out', danger: true }))) return;
      await withBusy(revoke, async () => {
        try {
          const r = await adminApi.users.revokeSessions(a.id);
          toast(`${r.revoked} session${r.revoked === 1 ? '' : 's'} ended.`, { type: 'success' });
          data = await adminApi.users.get(a.id);
          draw();
        } catch (err) {
          toastError(err);
        }
      });
    });
    return panel({ title: `Active sessions (${data.sessions.length})`, flush: true, actions: [revoke] }, dataTable({
      caption: 'Active sessions',
      empty: 'No active sessions.',
      columns: [
        { key: 'userAgent', label: 'Device', render: (s) => h('span', { class: 'adm-truncate', title: s.userAgent }, s.userAgent || 'Unknown') },
        { key: 'ip', label: 'IP', render: (s) => mono(s.ip || '—') },
        { key: 'lastSeenAt', label: 'Last seen', render: (s) => time(s.lastSeenAt), className: 'adm-nowrap' },
        { key: 'elevated', label: 'Staff mode', render: (s) => (s.elevated ? badge('Elevated', 'warn') : null) },
      ],
      rows: data.sessions,
    }));
  }

  function draw() {
    const a = data.account;
    ctx.setTitle(a.displayName || a.email);
    const rc = data.reviewCounts || {};
    rerender(root, page({
      eyebrow: 'Account',
      title: a.displayName || a.email,
      subtitle: a.email,
      back: { href: '#/users', label: 'All users' },
      actions: [statusBadge(a.role), statusBadge(a.status), a.isCreator ? badge('Creator', '4k') : null].filter(Boolean),
    },
    a.status === 'suspended' ? notice(`Suspended${a.suspendedUntil ? ` until ${new Date(a.suspendedUntil).toLocaleString()}` : ' until reinstated'}${a.suspendedReason ? ` — ${a.suspendedReason.replace(/[.!?]+$/, '')}` : ''}.`, { type: 'danger' }) : null,
    h('div', { class: 'adm-grid-2' },
      h('div', { class: 'lm-stack lm-stack--lg' },
        accountForm(),
        sessionsPanel(),
        panel({ title: 'Reviews', flush: true, description: `${rc.visible || 0} visible · ${rc.pending || 0} held · ${rc.hidden || 0} hidden · ${rc.removed || 0} removed · ${data.reportsAgainst} reports against their posts` }, dataTable({
          caption: 'Recent reviews',
          empty: 'No reviews.',
          columns: [
            { key: 'titleName', label: 'Title', className: 'adm-minw', render: (r) => appLink(r.titleName || r.titleId, `#/title/${encodeURIComponent(r.titleId)}`) },
            { key: 'rating', label: 'Rating', render: (r) => stars(r.rating) },
            { key: 'body', label: 'Text', render: (r) => (r.body ? h('span', { class: 'adm-truncate', title: r.body }, r.body) : null) },
            { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
            { key: 'createdAt', label: 'Posted', render: (r) => time(r.createdAt) },
          ],
          rows: data.reviews,
        })),
        panel({ title: 'Submissions', flush: true }, dataTable({
          caption: 'Submissions',
          empty: 'No submissions.',
          columns: [
            { key: 'projectTitle', label: 'Project', render: (s) => h('a', { href: `#/submissions/${encodeURIComponent(s.id)}` }, s.projectTitle) },
            { key: 'contentType', label: 'Type' },
            { key: 'status', label: 'Status', render: (s) => statusBadge(s.status) },
            { key: 'updatedAt', label: 'Updated', render: (s) => time(s.updatedAt) },
          ],
          rows: data.submissions,
        })),
        panel({ title: 'Account history', flush: true }, dataTable({
          caption: 'Staff actions on this account',
          empty: 'No staff actions on this account.',
          columns: [
            { key: 'createdAt', label: 'When', render: (x) => time(x.createdAt, { absolute: true }), className: 'adm-nowrap' },
            { key: 'action', label: 'Action', className: 'adm-nowrap', render: (x) => mono(x.action) },
            { key: 'actor', label: 'By', render: (x) => x.actor?.email || 'System' },
            { key: 'details', label: 'Details', render: (x) => jsonDetails(x.details) },
          ],
          rows: data.history,
        }))),
      h('div', { class: 'lm-stack adm-sticky' },
        panel({ title: 'Summary' }, kv([
          ['Account ID', mono(a.id)],
          ['Joined', time(a.createdAt, { absolute: true })],
          ['Last sign-in', time(a.lastLoginAt, { absolute: true })],
          ['Email verified', a.emailVerified ? 'Yes' : 'No'],
          ['Two-factor', a.totpEnabled ? 'On' : 'Off'],
          ['Profiles', `${data.profiles.length} of ${a.maxProfiles}${data.profiles.some((p) => p.isKids) ? ' (includes kids profiles)' : ''}`],
          ['Locked until', a.lockedUntil && a.lockedUntil > new Date().toISOString() ? time(a.lockedUntil, { absolute: true }) : null],
        ])),
        panel({ title: 'Creator status' }, data.creatorApplication
          ? kv([
            ['Application', statusBadge(data.creatorApplication.status)],
            ['Legal name', data.creatorApplication.legalName],
            ['Applied', time(data.creatorApplication.createdAt)],
            ['Reviewer note', data.creatorApplication.reviewerNote],
          ])
          : h('p', { class: 'lm-muted lm-small' }, a.isCreator ? 'Creator access granted directly by an administrator.' : 'Has not applied to become a creator.'))))));
  }
  draw();
  return root;
}

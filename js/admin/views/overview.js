// Overview: queues that need attention, catalog and account counts, health summary and the
// latest staff activity.
import { h } from '../../core/dom.js';
import { errorState } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { staff } from '../shell.js';
import { bytes, dataTable, duration, inlineLoading, mono, num, page, panel, statTile, statusBadge, tiles, time } from '../ui.js';

export default async function render(ctx) {
  const body = h('div', { class: 'adm-page__body' }, inlineLoading());
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const root = page({
    eyebrow: 'Overview',
    title: `${greeting}, ${staff.account?.displayName?.split(' ')[0] || 'there'}`,
    subtitle: 'Queues waiting for staff, the state of the catalog and the health of this server.',
  }, body);

  const load = async () => {
    try {
      const o = await adminApi.overview({ signal: ctx.signal });
      const q = o.queues;
      const attention = (n) => (n > 0 ? 'attention' : undefined);
      const queueTiles = tiles(
        statTile({ label: 'Reported items', value: num(q.reportedItems), sub: `${num(q.openReports)} open reports`, href: '#/moderation', tone: attention(q.reportedItems), iconName: 'flag' }),
        statTile({ label: 'Reviews held for review', value: num(q.pendingReviews), sub: 'Spam filter held these', href: '#/moderation?tab=reviews&status=pending', tone: attention(q.pendingReviews), iconName: 'message' }),
        statTile({ label: 'Creator applications', value: num(q.creatorApplications), sub: 'Pending decision', href: '#/creators', tone: attention(q.creatorApplications), iconName: 'clapper' }),
        statTile({ label: 'Submissions to review', value: num(q.submissionsAwaiting), sub: `${num(q.submissionsInfoRequired)} waiting on creators`, href: '#/submissions', tone: attention(q.submissionsAwaiting), iconName: 'upload' }),
        statTile({ label: 'Quality reports', value: num(q.qualityReportsOpen), sub: 'Open viewer reports', href: '#/logs?tab=quality', tone: attention(q.qualityReportsOpen), iconName: 'alert' }),
        statTile({ label: 'Playback errors (24 h)', value: num(q.playbackErrors24h), sub: 'Reported by players', href: '#/logs?tab=playback', tone: q.playbackErrors24h > 0 ? 'danger' : undefined, iconName: 'alert' }),
      );
      queueTiles.classList.add('adm-tiles--3');
      body.replaceChildren(h('div', { class: 'adm-page' },
        panel({ title: 'Needs attention', description: 'Items waiting for a moderator or administrator.' },
          queueTiles),
        h('div', { class: 'adm-grid-halves' },
          panel({ title: 'Catalog', actions: [h('a', { class: 'lm-btn lm-btn--ghost lm-btn--sm', href: '#/content' }, h('span', null, 'Open content'))] },
            tiles(
              statTile({ label: 'Published', value: num(o.titles.published), sub: `${num(o.titles.movies)} films · ${num(o.titles.series)} series`, href: '#/content?status=published' }),
              statTile({ label: 'Drafts', value: num(o.titles.draft), sub: `${num(o.titles.unpublished)} unpublished`, href: '#/content?status=draft' }),
              statTile({ label: 'Media entries', value: num(o.media.total), sub: `${num(o.media.unverified)} ready but unverified`, href: '#/media?verified=0', tone: o.media.failed ? 'danger' : undefined }),
              statTile({ label: 'Transcoding', value: num(o.transcode.queued + o.transcode.running), sub: `${num(o.transcode.failed)} failed jobs`, href: '#/health', tone: o.transcode.failed ? 'danger' : undefined }),
            )),
          panel({ title: 'People', actions: [h('a', { class: 'lm-btn lm-btn--ghost lm-btn--sm', href: '#/users' }, h('span', null, 'Open users'))] },
            tiles(
              statTile({ label: 'Accounts', value: num(o.accounts.total), sub: `${num(o.accounts.newLast7d)} new in 7 days`, href: '#/users' }),
              statTile({ label: 'Creators', value: num(o.creators), href: '#/users?creator=1' }),
              statTile({ label: 'Staff', value: num(o.accounts.staff), href: '#/users?role=staff' }),
              statTile({ label: 'Suspended', value: num(o.accounts.suspended), href: '#/users?status=suspended', tone: o.accounts.suspended ? 'attention' : undefined }),
            ))),
        h('div', { class: 'adm-grid-halves' },
          panel({ title: 'Server health', description: `Up ${duration(o.health.uptimeS)} · database ${bytes(o.health.dbBytes + (o.health.walBytes || 0))} · private storage ${bytes(o.health.storageBytes)}`, actions: [h('a', { class: 'lm-btn lm-btn--ghost lm-btn--sm', href: '#/health' }, h('span', null, 'Details'))] },
            dataTable({
              caption: 'Integrations',
              columns: [
                { key: 'name', label: 'Integration' },
                { key: 'status', label: 'Status', render: (r) => statusBadge(r.status) },
              ],
              rows: o.health.integrations,
            }),
            o.health.recentErrors ? h('p', { class: 'lm-hint', style: { marginTop: '12px' } }, `${o.health.recentErrors} error log entries in memory. `, staff.isAdmin ? h('a', { class: 'lm-link', href: '#/logs?level=error' }, 'View server logs') : null) : null),
          panel({ title: 'Recent staff activity', actions: staff.isAdmin ? [h('a', { class: 'lm-btn lm-btn--ghost lm-btn--sm', href: '#/audit' }, h('span', null, 'Audit log'))] : [] },
            dataTable({
              caption: 'Latest audit log entries',
              empty: 'No staff actions have been recorded yet.',
              columns: [
                { key: 'action', label: 'Action', className: 'adm-nowrap', render: (r) => mono(r.action) },
                // Addresses may break anywhere so the When column never scrolls out of a half-width panel.
                { key: 'actor', label: 'By', className: 'adm-break', render: (r) => r.actor?.email || 'System' },
                { key: 'createdAt', label: 'When', render: (r) => time(r.createdAt), className: 'adm-nowrap' },
              ],
              rows: o.recentActivity,
            })))));
    } catch (err) {
      if (err.name !== 'AbortError') body.replaceChildren(errorState(err, { retry: load }));
    }
  };
  load();
  return root;
}

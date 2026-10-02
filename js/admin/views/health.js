// Platform health: process, database, storage, transcoding and integrations — plus usage
// over the last N days, which is ESTIMATED from player telemetry (not a CDN bill).
import { h, newUid } from '../../core/dom.js';
import { errorState } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { badge, bytes, dataTable, duration, inlineLoading, mono, num, page, panel, statTile, statusBadge, tiles, time } from '../ui.js';

const hours = (s) => s / 3600;
const fmtHours = (s) => {
  const v = hours(s);
  return v >= 100 ? `${num(Math.round(v))} h` : `${v.toFixed(v >= 10 ? 0 : 1)} h`;
};

function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v);
}

/**
 * Single-series column chart of daily watch time. Bars are the hit targets (pointer and
 * keyboard: focus the chart, then ← → to move between days); a table view is always there.
 */
function dailyChart(daily) {
  const max = niceMax(Math.max(...daily.map((d) => hours(d.seconds))));
  const tipId = newUid('tip');
  const tip = h('div', { class: 'adm-chart__tip', id: tipId, role: 'status', hidden: true });
  const fmtDay = (d) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const bars = daily.map((d, i) => {
    const pct = (hours(d.seconds) / max) * 100;
    return h('div', { class: 'adm-chart__slot', dataset: { i: String(i) } },
      h('span', { class: ['adm-chart__bar', !d.seconds && 'is-zero'], style: { height: d.seconds ? `max(2px, ${pct}%)` : '1px' } }));
  });
  const plot = h('div', {
    class: 'adm-chart__plot',
    tabindex: '0',
    role: 'group',
    'aria-label': `Daily watch time, ${daily.length} days. Use the left and right arrow keys to read each day.`,
    'aria-describedby': tipId,
  }, ...bars);
  let active = -1;
  const show = (i) => {
    active = Math.max(0, Math.min(daily.length - 1, i));
    const d = daily[active];
    bars.forEach((b, j) => b.classList.toggle('is-active', j === active));
    tip.replaceChildren(h('strong', null, fmtHours(d.seconds)), h('span', null, `${fmtDay(d.day)} · ${num(d.sessions)} session${d.sessions === 1 ? '' : 's'} · ~${bytes(d.bytes)}`));
    tip.hidden = false;
    const slot = bars[active];
    const left = slot.offsetLeft + slot.offsetWidth / 2;
    tip.style.left = `${Math.min(Math.max(left, 90), plot.clientWidth - 90)}px`;
  };
  const hide = () => {
    tip.hidden = true;
    bars.forEach((b) => b.classList.remove('is-active'));
  };
  plot.addEventListener('pointermove', (e) => {
    const slot = e.target.closest('.adm-chart__slot');
    if (slot) show(Number(slot.dataset.i));
  });
  plot.addEventListener('pointerleave', () => { if (document.activeElement !== plot) hide(); });
  plot.addEventListener('focus', () => show(active < 0 ? daily.length - 1 : active));
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      show(active + (e.key === 'ArrowRight' ? 1 : -1));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      show(e.key === 'Home' ? 0 : daily.length - 1);
    }
  });
  const mid = Math.floor(daily.length / 2);
  return h('figure', { class: 'adm-chart' },
    h('figcaption', { class: 'adm-chart__title' }, 'Daily watch time (hours)'),
    h('div', { class: 'adm-chart__frame' },
      h('div', { class: 'adm-chart__yaxis', 'aria-hidden': 'true' }, h('span', null, max < 10 ? max.toFixed(max < 1 ? 2 : 1) : num(max)), h('span', null, '0')),
      h('div', { class: 'adm-chart__area' },
        h('span', { class: 'adm-chart__grid', 'aria-hidden': 'true' }),
        plot, tip)),
    h('div', { class: 'adm-chart__xaxis', 'aria-hidden': 'true' }, h('span', null, fmtDay(daily[0].day)), h('span', null, fmtDay(daily[mid].day)), h('span', null, fmtDay(daily.at(-1).day))),
    h('details', { class: 'adm-json' }, h('summary', null, 'Show as a table'),
      dataTable({
        caption: 'Daily watch time',
        columns: [
          { key: 'day', label: 'Day', render: (d) => fmtDay(d.day) },
          { key: 'seconds', label: 'Watch time', render: (d) => fmtHours(d.seconds), className: 'adm-num' },
          { key: 'sessions', label: 'Sessions', render: (d) => num(d.sessions), className: 'adm-num' },
          { key: 'bytes', label: 'Est. data', render: (d) => bytes(d.bytes), className: 'adm-num' },
        ],
        rows: [...daily].reverse(),
      })));
}

function usagePanel(ctx) {
  const body = h('div', null, inlineLoading());
  const select = h('select', { class: 'lm-select adm-filter__control', id: newUid('days'), 'aria-label': 'Usage period' },
    ...[7, 30, 90].map((d) => h('option', { value: String(d), selected: d === 30 }, `Last ${d} days`)));
  const load = async () => {
    body.classList.add('is-loading');
    try {
      const u = await adminApi.platform.usage(Number(select.value), { signal: ctx.signal });
      body.replaceChildren(h('div', { class: 'lm-stack' },
        h('p', { class: 'lm-hint' }, badge(u.label, 'warn'), ' ', u.note),
        tiles(
          statTile({ label: 'Watch time', value: fmtHours(u.totals.secondsWatched), sub: `${select.value}-day total` }),
          statTile({ label: 'Estimated data delivered', value: bytes(u.totals.bytesEstimate), sub: 'From selected bitrates' }),
          statTile({ label: 'Playback sessions', value: num(u.totals.sessions), sub: `${num(u.totals.accounts)} signed-in viewers` }),
          statTile({ label: 'Rebuffering', value: duration(u.totals.rebufferSeconds), sub: `${num(u.totals.errors)} player errors` }),
          statTile({ label: 'Private storage in use', value: bytes(u.storage.bytes), sub: `${num(u.storage.files)} files${u.storage.truncated ? ' (partial count)' : ''}` }),
        ),
        u.totals.sessions ? dailyChart(u.daily) : h('p', { class: 'lm-muted lm-small' }, 'No player telemetry in this period yet.'),
        u.topTitles.length ? dataTable({
          caption: 'Most watched titles',
          captionHidden: false,
          columns: [
            { key: 'title', label: 'Title', render: (t) => (t.titleId ? h('a', { href: `#/content/${encodeURIComponent(t.titleId)}` }, t.title || t.titleId) : 'Unknown') },
            { key: 'secondsWatched', label: 'Watch time', render: (t) => fmtHours(t.secondsWatched), className: 'adm-num' },
            { key: 'sessions', label: 'Sessions', render: (t) => num(t.sessions), className: 'adm-num' },
            { key: 'bytesEstimate', label: 'Est. data', render: (t) => bytes(t.bytesEstimate), className: 'adm-num' },
          ],
          rows: u.topTitles,
        }) : null));
    } catch (err) {
      if (err.name !== 'AbortError') body.replaceChildren(errorState(err, { retry: load }));
    } finally {
      body.classList.remove('is-loading');
    }
  };
  select.addEventListener('change', load);
  load();
  return panel({ title: 'Usage', description: 'Estimated from player telemetry.', actions: [h('div', { class: 'adm-filter' }, select)] }, body);
}

export default async function render(ctx) {
  const body = h('div', null, inlineLoading());
  const load = async () => {
    try {
      const x = await adminApi.platform.health({ signal: ctx.signal });
      const mem = x.server.memory;
      const q = x.transcode;
      body.replaceChildren(h('div', { class: 'adm-page' },
        tiles(
          statTile({ label: 'Uptime', value: duration(x.server.uptimeS), sub: `${x.server.node} · ${x.server.platform}`, iconName: 'clock' }),
          statTile({ label: 'Memory', value: bytes(mem.rss), sub: `Heap ${bytes(mem.heapUsed)} of ${bytes(mem.heapTotal)}`, iconName: 'device' }),
          statTile({ label: 'Database', value: bytes(x.database.bytes + x.database.walBytes), sub: `File ${bytes(x.database.bytes)} · write-ahead log ${bytes(x.database.walBytes)}`, iconName: 'layers' }),
          statTile({ label: 'Private storage', value: bytes(x.storage.bytes), sub: x.storage.present ? `${num(x.storage.files)} files${x.storage.truncated ? ' (walk stopped early)' : ''}` : 'Directory not created yet', iconName: 'upload' }),
          statTile({ label: 'Transcoding', value: `${num(q.queued)} queued`, sub: `${num(q.running)} running · ${num(q.done)} done · ${num(q.failed)} failed`, tone: q.failed ? 'danger' : undefined, iconName: 'film' }),
        ),
        panel({ title: 'Integrations', flush: true, description: 'What this server is configured to use. Nothing here is simulated: unconfigured integrations are simply unavailable.' }, dataTable({
          caption: 'Integrations',
          columns: [
            { key: 'name', label: 'Integration' },
            { key: 'status', label: 'Status', render: (r) => statusBadge(r.status, r.status === 'info' ? 'Info' : undefined) },
            { key: 'detail', label: 'Detail', render: (r) => h('span', { class: 'lm-small' }, r.detail) },
          ],
          rows: x.integrations,
        })),
        usagePanel(ctx),
        h('div', { class: 'adm-grid-halves' },
          panel({ title: 'Database tables', flush: true, description: `${x.database.path}` }, dataTable({
            caption: 'Row counts',
            columns: [{ key: 'name', label: 'Table', render: (t) => mono(t.name) }, { key: 'rows', label: 'Rows', render: (t) => num(t.rows), className: 'adm-num' }],
            rows: x.database.tables,
          })),
          panel({ title: 'Schema migrations' }, h('ul', { class: 'lm-stack lm-stack--sm', style: { margin: 0, paddingLeft: '1.2em' } }, ...x.database.migrations.map((m) => h('li', null, mono(m)))),
            h('p', { class: 'lm-hint', style: { marginTop: '12px' } }, 'Checked ', time(x.checkedAt, { absolute: true }))))));
    } catch (err) {
      if (err.name !== 'AbortError') body.replaceChildren(errorState(err, { retry: load }));
    }
  };
  load();
  return page({ eyebrow: 'Platform', title: 'Platform health', subtitle: 'This server process, its database and storage, and the integrations it is configured with.' }, body);
}

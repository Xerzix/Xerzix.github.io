// Admin UI kit: page scaffolding, stat tiles, accessible data tables, pagination, filter
// bars, list editors (rows of inputs), drawers and small formatting helpers. Everything is
// built with h() — strings always become text nodes.
import { h, append, replace, newUid, debounce } from '../core/dom.js';
import { date, relativeTime, bytes as fmtBytes } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { button, field, openModal, spinner, errorState, notice } from '../ui/components.js';

// ───────────────────────────── Page scaffolding ─────────────────────────────

export function page({ title, eyebrow, subtitle, actions = [], back }, ...children) {
  return h('div', { class: 'adm-page' },
    h('header', { class: 'adm-page__head' },
      h('div', { class: 'adm-page__titles' },
        back ? h('a', { class: 'adm-back', href: back.href }, icon('chevronLeft'), back.label) : null,
        eyebrow ? h('span', { class: 'lm-eyebrow' }, eyebrow) : null,
        h('h1', { class: 'adm-h1' }, title),
        subtitle ? h('p', { class: 'adm-page__sub' }, subtitle) : null),
      actions.length ? h('div', { class: 'adm-page__actions' }, ...actions) : null),
    ...children);
}

export function panel({ title, description, actions = [], flush = false, id, tag = 'section' } = {}, ...children) {
  const headingId = title ? newUid('pnl') : undefined;
  return h(tag, { class: ['adm-panel', flush && 'adm-panel--flush'], id, 'aria-labelledby': headingId },
    title || actions.length ? h('div', { class: 'adm-panel__head' },
      h('div', null,
        title ? h('h2', { class: 'adm-panel__title', id: headingId }, title) : null,
        description ? h('p', { class: 'adm-panel__desc' }, description) : null),
      actions.length ? h('div', { class: 'adm-panel__actions' }, ...actions) : null) : null,
    h('div', { class: 'adm-panel__body' }, ...children));
}

export function statTile({ label, value, sub, href, tone, iconName }) {
  const inner = [
    h('span', { class: 'adm-stat__label' }, iconName ? icon(iconName) : null, label),
    h('span', { class: 'adm-stat__value' }, value ?? '—'),
    sub ? h('span', { class: 'adm-stat__sub' }, sub) : null,
  ];
  return href
    ? h('a', { class: ['adm-stat', tone && `adm-stat--${tone}`], href }, ...inner)
    : h('div', { class: ['adm-stat', tone && `adm-stat--${tone}`] }, ...inner);
}

export function tiles(...items) {
  return h('div', { class: 'adm-tiles' }, ...items);
}

export function inlineLoading(label = 'Loading…') {
  return h('div', { class: 'adm-loading' }, spinner(label), h('span', null, label));
}

export function emptyRow(message) {
  return h('div', { class: 'adm-empty' }, icon('lantern'), h('p', null, message));
}

// ───────────────────────────── Focus-preserving re-render ─────────────────────────────

/** A stable description of a control: same tag + same name/label/text after a re-render. */
function focusKey(el) {
  const label = el.getAttribute('name') || el.getAttribute('aria-label') || el.textContent.trim().replace(/\s+/g, ' ').slice(0, 80);
  return `${el.tagName}|${el.getAttribute('type') || ''}|${label}`;
}

function focusQuietly(el) {
  if (!el) return false;
  if (!el.matches('a[href], button, input, select, textarea, [tabindex]')) el.setAttribute('tabindex', '-1');
  el.focus({ preventScroll: true });
  return document.activeElement === el;
}

/**
 * Replaces the content of `root` (a detail view redrawn after an action) without dropping
 * keyboard focus to <body>: focus returns to the same control in the new content, or to the
 * heading of the panel it was in, or to the page heading.
 */
const lastFocus = new WeakMap();

export function rerender(root, ...nodes) {
  if (!lastFocus.has(root)) {
    lastFocus.set(root, null);
    root.addEventListener('focusin', (e) => lastFocus.set(root, e.target));
  }
  let active = document.activeElement;
  // withBusy() disables the button while its action runs, and a disabled button loses focus
  // to <body>; that button is still the control the user was on.
  const busy = lastFocus.get(root);
  if ((!active || active === document.body) && busy?.disabled && busy.getAttribute('aria-busy') === 'true') active = busy;
  const inside = active && active !== document.body && root.contains(active);
  const key = inside ? focusKey(active) : null;
  const panelTitle = inside ? active.closest('.adm-panel')?.querySelector('.adm-panel__title')?.textContent : null;
  root.replaceChildren(...nodes);
  if (!inside) return;
  const same = [...root.querySelectorAll(active.tagName)].find((el) => focusKey(el) === key && !el.disabled && !el.closest('[hidden]'));
  if (focusQuietly(same)) return;
  const heading = panelTitle ? [...root.querySelectorAll('.adm-panel__title')].find((h2) => h2.textContent === panelTitle) : null;
  if (focusQuietly(heading)) return;
  focusQuietly(root.querySelector('h1') || root);
}

// ───────────────────────────── Badges & formatting ─────────────────────────────

const TONES = {
  published: 'ok', ready: 'ok', active: 'ok', visible: 'ok', approved: 'ok', actioned: 'ok', resolved: 'ok', configured: 'ok', done: 'ok', clean: 'ok',
  draft: 'solid', dismissed: 'solid', ended: 'solid', info: 'solid', not_configured: 'solid', development: 'warn', acknowledged: 'solid', scheduled: 'solid', member: 'solid',
  unpublished: 'warn', processing: 'warn', pending: 'warn', open: 'warn', hidden: 'warn', info_required: 'warn', submitted: 'warn', queued: 'warn', running: 'warn', under_review: 'accent', moderator: 'accent', admin: 'accent',
  failed: 'danger', removed: 'danger', suspended: 'danger', rejected: 'danger', infected: 'danger', misconfigured: 'danger', missing: 'danger', error: 'danger',
};
const LABELS = {
  under_review: 'Under review', info_required: 'Info required', not_configured: 'Not configured', development: 'Development only',
  misconfigured: 'Misconfigured', missing: 'Binary missing',
};

export function statusLabel(status) {
  return LABELS[status] || String(status || '').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
}

export function statusBadge(status, label) {
  const tone = TONES[status];
  return h('span', { class: ['lm-badge', tone && `lm-badge--${tone}`, 'adm-badge'] }, label || statusLabel(status));
}

export function badge(text, tone) {
  return h('span', { class: ['lm-badge', tone && `lm-badge--${tone}`, 'adm-badge'] }, text);
}

export function time(iso, { absolute = false } = {}) {
  if (!iso) return h('span', { class: 'lm-muted' }, '—');
  const full = new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return h('time', { datetime: iso, title: full }, absolute ? full : relativeTime(iso));
}

export const fmtDate = (iso) => date(iso);
export const bytes = (n) => (Number.isFinite(n) ? fmtBytes(n) : '—');
export const num = (n) => (Number.isFinite(n) ? new Intl.NumberFormat().format(n) : '—');

export function duration(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const d = Math.floor(seconds / 86400);
  const hrs = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${hrs}h`;
  if (hrs) return `${hrs}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

export function mono(text) {
  return h('code', { class: 'adm-mono' }, text);
}

/** A link into the main Lumina app (opens in a new tab). */
export function appLink(label, hash) {
  return h('a', { class: 'lm-link', href: `index.html${hash}`, target: '_blank', rel: 'noopener' }, label, h('span', { class: 'visually-hidden' }, ' (opens Lumina in a new tab)'));
}

/** External link from user-supplied data: only http(s), never followed with referrer. */
export function safeExternal(url, label) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('scheme');
    return h('a', { class: 'lm-link', href: u.href, target: '_blank', rel: 'noopener noreferrer nofollow' }, label || u.href);
  } catch {
    return h('span', null, url);
  }
}

export function kv(pairs) {
  return h('dl', { class: 'adm-kv' }, ...pairs.filter(Boolean).flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v === null || v === undefined || v === '' ? h('span', { class: 'lm-muted' }, '—') : v)]));
}

export function jsonDetails(value, summary = 'Details') {
  if (value === null || value === undefined || (typeof value === 'object' && !Object.keys(value).length)) return h('span', { class: 'lm-muted' }, '—');
  return h('details', { class: 'adm-json' }, h('summary', null, summary), h('pre', null, JSON.stringify(value, null, 2)));
}

// ───────────────────────────── Tables ─────────────────────────────

/**
 * columns: [{ key, label, render?(row) → Node|string, className?, width?, align? }]
 * Returns an accessible table (caption + scoped headers) or an empty state.
 */
export function dataTable({ caption, captionHidden = true, columns, rows, empty = 'Nothing to show yet.', className }) {
  if (!rows.length) return emptyRow(empty);
  return h('div', { class: ['lm-table-wrap', 'adm-table-wrap', className] },
    h('table', { class: 'lm-table adm-table' },
      caption ? h('caption', { class: captionHidden ? 'visually-hidden' : 'adm-caption' }, caption) : null,
      h('thead', null, h('tr', null, ...columns.map((c) => h('th', { scope: 'col', class: c.className, style: c.width ? { width: c.width } : undefined }, c.label)))),
      h('tbody', null, ...rows.map((row) => h('tr', null, ...columns.map((c, i) => {
        const content = c.render ? c.render(row) : row[c.key];
        const cell = content === null || content === undefined || content === '' ? h('span', { class: 'lm-muted' }, '—') : content;
        return i === 0 && c.rowHeader !== false ? h('th', { scope: 'row', class: ['adm-rowhead', c.className] }, cell) : h('td', { class: c.className }, cell);
    }))))));
}

export function pager({ page, pageSize, total, onPage, label = 'Pagination' }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = Math.min(total, page * pageSize);
  if (total <= pageSize) return h('p', { class: 'adm-pager__summary' }, total ? `${num(total)} ${total === 1 ? 'item' : 'items'}` : '');
  return h('nav', { class: 'adm-pager', 'aria-label': label },
    h('p', { class: 'adm-pager__summary' }, `Showing ${num(from)}–${num(to)} of ${num(total)}`),
    h('div', { class: 'lm-cluster lm-cluster--sm' },
      button('Previous', { variant: 'ghost', size: 'sm', icon: 'chevronLeft', disabled: page <= 1, onClick: () => onPage(page - 1) }),
      h('span', { class: 'adm-pager__page', 'aria-current': 'page' }, `Page ${page} of ${pages}`),
      button('Next', { variant: 'ghost', size: 'sm', iconRight: 'chevronRight', disabled: page >= pages, onClick: () => onPage(page + 1) })));
}

// ───────────────────────────── Filters & query state ─────────────────────────────

/** Mirrors list state into the admin URL without re-rendering the view. */
export function syncQuery(ctx, state) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(state)) if (v !== undefined && v !== null && v !== '' && !(k === 'page' && Number(v) === 1)) qs.set(k, String(v));
  const s = qs.toString();
  const target = `#${ctx.path}${s ? `?${s}` : ''}`;
  if (location.hash !== target) history.replaceState({ ...(history.state || {}) }, '', target);
}

export function queryState(ctx, defaults) {
  const out = { ...defaults };
  for (const k of Object.keys(defaults)) {
    const v = ctx.query.get(k);
    if (v !== null) out[k] = typeof defaults[k] === 'number' ? Number(v) || defaults[k] : v;
  }
  return out;
}

/**
 * Filter bar. fields: [{ name, label, type: 'search'|'select', options?, placeholder? }]
 * onChange(values) fires on select change, and (debounced) while typing in search boxes.
 */
export function filterBar({ fields, values, onChange, label = 'Filters' }) {
  const form = h('form', { class: 'adm-filters', role: 'search', 'aria-label': label, onSubmit: (e) => { e.preventDefault(); emit(); } });
  const controls = {};
  const emit = () => onChange(Object.fromEntries(Object.entries(controls).map(([k, el]) => [k, el.value])));
  const typed = debounce(emit, 350);
  for (const f of fields) {
    const id = newUid('flt');
    let control;
    if (f.type === 'select') {
      control = h('select', { id, class: 'lm-select adm-filter__control', name: f.name, onChange: emit },
        ...f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(values[f.name] ?? '') }, o.label)));
    } else {
      control = h('input', { id, class: 'lm-input adm-filter__control', type: 'search', name: f.name, value: values[f.name] || '', placeholder: f.placeholder || 'Search', autocomplete: 'off', onInput: typed });
    }
    controls[f.name] = control;
    form.append(h('div', { class: ['adm-filter', f.type === 'search' && 'adm-filter--grow'] }, h('label', { class: 'adm-filter__label', for: id }, f.label), control));
  }
  return form;
}

/**
 * Wires a list view: loads data for the current state, renders it, keeps the URL in sync
 * and ignores stale responses. Returns { el, load, state }.
 */
export function listController(ctx, { state, fetch, render }) {
  const el = h('div', { class: 'adm-results', 'aria-live': 'polite' });
  let seq = 0;
  const load = async () => {
    const mine = ++seq;
    el.classList.add('is-loading');
    el.setAttribute('aria-busy', 'true');
    if (!el.firstChild) el.append(inlineLoading());
    try {
      const data = await fetch(state, { signal: ctx.signal });
      if (mine !== seq) return;
      rerender(el, render(data));
      syncQuery(ctx, state);
    } catch (err) {
      if (err?.name === 'AbortError' || mine !== seq) return;
      el.replaceChildren(errorState(err, { retry: load }));
    } finally {
      if (mine === seq) {
        el.classList.remove('is-loading');
        el.removeAttribute('aria-busy');
      }
    }
  };
  return { el, load, state };
}

/** Segmented links (tabs within a view) that navigate by query string. */
export function viewTabs({ tabs, active, label, base }) {
  return h('nav', { class: 'adm-viewtabs', 'aria-label': label },
    ...tabs.map((t) => h('a', { class: 'adm-viewtab', href: `#${base}${t.query ? `?${t.query}` : ''}`, 'aria-current': t.id === active ? 'page' : undefined },
      t.label, t.count ? h('span', { class: 'adm-count' }, String(t.count)) : null)));
}

// ───────────────────────────── Forms ─────────────────────────────

/** Error summary shown at the top of a form; lists nested field errors field() cannot show. */
export function errorSummary() {
  const el = h('div', { class: 'adm-error-summary', role: 'alert', hidden: true, tabindex: '-1' });
  el.show = (err) => {
    const fields = err?.fields || {};
    const entries = Object.entries(fields);
    replace(el,
      h('strong', null, err?.message || 'Something went wrong.'),
      entries.length ? h('ul', null, ...entries.map(([k, v]) => h('li', null, h('code', null, k), ' — ', v))) : null);
    el.hidden = false;
    el.focus();
  };
  el.clear = () => {
    el.hidden = true;
    el.replaceChildren();
  };
  return el;
}

/** Comma-separated list <-> array. */
export const splitList = (s) => String(s || '').split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

/**
 * Rows of inputs for arrays of objects (cast, tracks, fallbacks…).
 * columns: [{ key, label, type: 'text'|'number'|'select'|'checkbox'|'color', options?, placeholder?, width? }]
 * Returns a fieldset element with .getValue().
 */
export function listEditor({ legend, hint, columns, value = [], addLabel = 'Add row', max = 50, blank = {} }) {
  const tbody = h('tbody');
  const fs = h('fieldset', { class: 'adm-listedit' });
  const addBtn = button(addLabel, { variant: 'ghost', size: 'sm', icon: 'plus' });
  const table = h('table', { class: 'adm-listedit__table' },
    h('thead', null, h('tr', null, ...columns.map((c) => h('th', { scope: 'col', style: c.width ? { width: c.width } : undefined }, c.label)), h('th', null, h('span', { class: 'visually-hidden' }, 'Remove')))),
    tbody);
  const empty = h('p', { class: 'adm-listedit__empty' }, 'None yet.');
  const refresh = () => {
    const n = tbody.children.length;
    empty.hidden = n > 0;
    table.hidden = n === 0;
    addBtn.disabled = n >= max;
  };
  const addRow = (data = {}) => {
    const row = h('tr');
    row.inputs = {};
    columns.forEach((c) => {
      const aria = `${c.label} (row ${tbody.children.length + 1})`;
      let input;
      const val = data[c.key] ?? blank[c.key];
      if (c.type === 'select') {
        input = h('select', { class: 'lm-select adm-compact', 'aria-label': aria }, ...c.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(val ?? '') }, o.label)));
      } else if (c.type === 'checkbox') {
        input = h('input', { type: 'checkbox', class: 'adm-check', 'aria-label': aria, checked: !!val });
      } else if (c.type === 'color') {
        const text = h('input', { class: 'lm-input adm-compact adm-mono', 'aria-label': aria, value: val || '#781B32', maxlength: 7, pattern: '#[0-9A-Fa-f]{6}' });
        const swatch = h('input', { type: 'color', class: 'adm-swatch', 'aria-label': `${aria} picker`, value: /^#[0-9a-f]{6}$/i.test(val || '') ? val : '#781b32' });
        swatch.addEventListener('input', () => { text.value = swatch.value.toUpperCase(); });
        text.addEventListener('input', () => { if (/^#[0-9a-f]{6}$/i.test(text.value)) swatch.value = text.value; });
        input = text;
        row.append(h('td', null, h('div', { class: 'adm-colorpair' }, swatch, text)));
        row.inputs[c.key] = input;
        return;
      } else {
        input = h('input', { class: ['lm-input', 'adm-compact', c.mono && 'adm-mono'], type: c.type === 'number' ? 'number' : 'text', 'aria-label': aria, value: val ?? '', placeholder: c.placeholder, step: c.step || (c.type === 'number' ? 'any' : undefined), inputmode: c.type === 'number' ? 'decimal' : undefined });
      }
      row.inputs[c.key] = input;
      row.append(h('td', { class: c.type === 'checkbox' ? 'adm-center' : undefined }, input));
    });
    row.append(h('td', { class: 'adm-center' }, h('button', { type: 'button', class: 'lm-icon-btn adm-rowbtn', 'aria-label': 'Remove row', onClick: () => { row.remove(); refresh(); } }, icon('trash'))));
    tbody.append(row);
    refresh();
    return row;
  };
  addBtn.addEventListener('click', () => {
    const row = addRow();
    Object.values(row.inputs)[0]?.focus();
  });
  value.forEach((v) => addRow(v));
  append(fs, [h('legend', { class: 'lm-label' }, legend), hint ? h('p', { class: 'lm-hint' }, hint) : null, table, empty, h('div', null, addBtn)]);
  refresh();
  fs.getValue = () => [...tbody.children].map((row) => {
    const out = {};
    columns.forEach((c) => {
      const el = row.inputs[c.key];
      if (c.type === 'checkbox') out[c.key] = el.checked;
      else if (c.type === 'number') out[c.key] = el.value === '' ? undefined : Number(el.value);
      else out[c.key] = el.value.trim();
    });
    return out;
  }).filter((r) => columns.some((c) => c.type !== 'checkbox' && c.type !== 'select' && r[c.key] !== '' && r[c.key] !== undefined));
  return fs;
}

/** field() with a live character count. */
export function textField(opts) {
  const f = field(opts);
  if (opts.maxlength) {
    const count = h('span', { class: 'lm-hint adm-count-hint', 'aria-live': 'off' });
    const upd = () => { count.textContent = `${f.control.value.length} / ${opts.maxlength}`; };
    f.control.addEventListener('input', upd);
    upd();
    f.append(count);
  }
  return f;
}

// ───────────────────────────── Dialogs ─────────────────────────────

/** Side drawer built on the shared modal (focus trap, Esc, focus restore). */
export function drawer({ title, content, actions = [], onClose }) {
  const m = openModal({ title, content, actions, size: 'wide', onClose });
  m.el.classList.add('adm-drawer');
  return m;
}

/**
 * Confirmation with an optional note. Resolves { note } or null when cancelled.
 *   confirmWithNote({ title, message, confirmLabel, danger, noteLabel, noteRequired, noteHint })
 */
export function confirmWithNote({ title, message, confirmLabel = 'Confirm', danger = false, noteLabel, noteRequired = false, noteHint, extra }) {
  return new Promise((resolve) => {
    const note = noteLabel ? field({ label: noteLabel, name: 'note', type: 'textarea', rows: 3, hint: noteHint, required: noteRequired, maxlength: 1000 }) : null;
    let result = null;
    const ok = button(confirmLabel, { variant: danger ? 'danger' : 'primary' });
    const cancel = button('Cancel', { variant: 'ghost' });
    const form = h('form', { class: 'lm-form', onSubmit: (e) => { e.preventDefault(); submit(); } }, message ? h('p', { class: 'lm-muted' }, message) : null, extra || null, note);
    const modal = openModal({ title, content: form, actions: [cancel, ok], onClose: () => resolve(result) });
    const submit = () => {
      const value = note?.control.value.trim() || '';
      if (noteRequired && !value) {
        note.setError('Please add a note.');
        note.control.focus();
        return;
      }
      result = { note: value || undefined, form };
      modal.close(true);
    };
    ok.addEventListener('click', submit);
    cancel.addEventListener('click', () => modal.close(false));
    setTimeout(() => (note ? note.control : (danger ? cancel : ok)).focus(), 40);
  });
}

export function infoNotice(message, opts) {
  return notice(message, opts);
}

/** Simple wrapper for icon-only buttons with a visible tooltip label. */
export function iconButton(iconName, label, onClick, { danger = false } = {}) {
  return h('button', { type: 'button', class: ['lm-icon-btn', 'adm-iconbtn', danger && 'adm-iconbtn--danger'], 'aria-label': label, title: label, onClick }, icon(iconName));
}

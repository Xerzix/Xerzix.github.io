// Reusable UI building blocks. Views compose these instead of hand-rolling markup so the
// whole app shares one visual language and one set of accessibility behaviours.
import { h, newUid, announce } from '../core/dom.js';
import { icon, starIcon } from './icons.js';

/** <button> with the Lumina button styles. variant: primary | light | glass | ghost | danger */
export function button(label, { variant, size, icon: iconName, iconRight, onClick, type = 'button', ariaLabel, className, block, disabled, attrs = {} } = {}) {
  const cls = ['lm-btn', variant && `lm-btn--${variant}`, size && `lm-btn--${size}`, block && 'lm-btn--block', !label && 'lm-btn--icon', className];
  return h('button', { type, class: cls, onClick, 'aria-label': ariaLabel || (!label ? attrs.title : undefined), disabled, ...attrs },
    iconName ? icon(iconName) : null,
    label ? h('span', null, label) : null,
    iconRight ? icon(iconRight) : null);
}

/** Link styled as a button. */
export function linkButton(label, href, { variant, size, icon: iconName, className, attrs = {} } = {}) {
  return h('a', { href, class: ['lm-btn', variant && `lm-btn--${variant}`, size && `lm-btn--${size}`, className], ...attrs }, iconName ? icon(iconName) : null, h('span', null, label));
}

/** Marks a button busy while `fn` runs; restores it afterwards. Returns fn's result. */
export async function withBusy(btn, fn) {
  btn.classList.add('is-busy');
  btn.setAttribute('aria-busy', 'true');
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-busy');
    btn.removeAttribute('aria-busy');
    btn.disabled = false;
  }
}

// ── Toasts ───────────────────────────────────────────────
export function toast(message, { type = 'info', action, timeout = 4200 } = {}) {
  const root = document.getElementById('lm-toasts');
  if (!root) return;
  const ico = type === 'error' ? 'alert' : type === 'success' ? 'checkCircle' : 'info';
  const el = h('div', { class: `lm-toast lm-toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
    icon(ico, { className: 'lm-toast__icon' }),
    h('div', { class: 'lm-toast__msg' }, message),
    action ? h('button', { class: 'lm-toast__action', onClick: () => { action.onClick(); dismiss(); } }, action.label) : null,
    h('button', { class: 'lm-icon-btn', 'aria-label': 'Dismiss', onClick: () => dismiss() }, icon('close', { size: 16 })));
  const dismiss = () => {
    el.classList.add('is-leaving');
    setTimeout(() => el.remove(), 220);
  };
  root.append(el);
  if (timeout) setTimeout(dismiss, timeout);
  return dismiss;
}

/** Shows an API/validation error as a toast with a sensible message. */
export function toastError(err, fallback = 'Something went wrong. Please try again.') {
  if (err?.name === 'AbortError') return;
  console.warn(err);
  toast(err?.message || fallback, { type: 'error', timeout: 6000 });
}

// ── Dialogs ──────────────────────────────────────────────
/**
 * Opens a native <dialog> (focus trap, Esc to close, focus restored on close).
 * Returns { el, body, close, closed } where `closed` resolves with the return value.
 */
export function openModal({ title, content, actions = [], size, sheet = false, onClose, labelledBy } = {}) {
  const titleId = newUid('dlg');
  const previouslyFocused = document.activeElement;
  let resolveClosed;
  const closed = new Promise((r) => (resolveClosed = r));
  const body = h('div', { class: 'lm-modal__body' });
  if (content) body.append(...[content].flat());
  const dlg = h('dialog', { class: ['lm-modal', size === 'wide' && 'lm-modal--wide', sheet && 'lm-modal--sheet'], 'aria-labelledby': labelledBy || titleId },
    h('div', { class: 'lm-modal__head' },
      h('h2', { id: titleId }, title || ''),
      h('button', { class: 'lm-icon-btn', 'aria-label': 'Close', onClick: () => close() }, icon('close'))),
    body,
    actions.length ? h('div', { class: 'lm-modal__foot' }, ...actions) : null);
  let returnValue;
  const close = (value) => {
    returnValue = value;
    if (dlg.open) dlg.close();
  };
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.(returnValue);
    resolveClosed(returnValue);
    if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
  });
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) close();
  });
  document.getElementById('lm-modals').append(dlg);
  dlg.showModal();
  return { el: dlg, body, close, closed };
}

/** Promise<boolean> confirmation dialog. */
export function confirmDialog({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false }) {
  let modal;
  const ok = button(confirmLabel, { variant: danger ? 'danger' : 'primary', onClick: () => modal.close(true) });
  const cancel = button(cancelLabel, { variant: 'ghost', onClick: () => modal.close(false) });
  modal = openModal({ title, content: h('p', { class: 'lm-muted' }, message), actions: [cancel, ok] });
  setTimeout(() => (danger ? cancel : ok).focus(), 30);
  return modal.closed.then((v) => v === true);
}

// ── Popover menu ─────────────────────────────────────────
/**
 * Wires a trigger button to a menu element: aria-expanded, click-outside, Esc, arrow keys.
 * `menu` must be a positioned .lm-menu inside a .lm-popover-anchor next to the trigger.
 */
export function bindMenu(trigger, menu, { onOpen } = {}) {
  const id = menu.id || newUid('menu');
  menu.id = id;
  menu.hidden = true;
  trigger.setAttribute('aria-haspopup', 'true');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-controls', id);
  // Only items that are rendered: a menu may hide some entries at some widths.
  const items = () => [...menu.querySelectorAll('a[href], button:not([disabled]), [role="menuitem"]')].filter((el) => el.getClientRects().length > 0);
  const open = () => {
    menu.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    onOpen?.();
    document.addEventListener('pointerdown', outside, true);
  };
  const close = (focusTrigger = false) => {
    menu.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    if (focusTrigger) trigger.focus();
  };
  const outside = (e) => {
    if (!menu.contains(e.target) && !trigger.contains(e.target)) close();
  };
  trigger.addEventListener('click', () => (menu.hidden ? open() : close()));
  // Choosing an item (or any navigation) closes the menu.
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a[href], [role="menuitem"]')) close();
  });
  window.addEventListener('hashchange', () => close());
  trigger.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      open();
      items()[0]?.focus();
    }
  });
  menu.addEventListener('keydown', (e) => {
    const list = items();
    const i = list.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      list[(i + 1) % list.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      list[(i - 1 + list.length) % list.length]?.focus();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  menu.addEventListener('click', (e) => {
    if (e.target.closest('a[href], button[data-close-menu], .lm-menu__item')) close();
  });
  return { open, close, get isOpen() { return !menu.hidden; } };
}

export function menuItem(label, { icon: iconName, href, onClick, attrs = {} } = {}) {
  const children = [iconName ? icon(iconName) : null, h('span', null, label)];
  return href
    ? h('a', { class: 'lm-menu__item', href, role: 'menuitem', ...attrs }, ...children)
    : h('button', { class: 'lm-menu__item', type: 'button', role: 'menuitem', onClick, ...attrs }, ...children);
}

// ── States ───────────────────────────────────────────────
export function spinner(label = 'Loading') {
  return h('span', { class: 'lm-spinner', role: 'status', 'aria-label': label },
    h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 50 50', 'aria-hidden': 'true' }, h('circle', { cx: 25, cy: 25, r: 20 })));
}

export function loading(label = 'Loading…') {
  return h('div', { class: 'lm-loading' }, spinner(label), h('span', null, label));
}

/** Empty state with optional illustration and actions. */
export function emptyState({ title, message, actions = [], art = 'lantern' } = {}) {
  return h('div', { class: 'lm-empty' },
    emptyArt(art),
    h('h2', null, title),
    message ? h('p', null, message) : null,
    actions.length ? h('div', { class: 'lm-cluster' }, ...actions) : null);
}

function emptyArt(kind) {
  // A single stone lantern with a soft glow — used for empty and error states.
  const glowId = newUid('glow');
  const svg = h('svg', { xmlns: 'http://www.w3.org/2000/svg', viewBox: '0 0 120 120', class: 'lm-empty__art', 'aria-hidden': 'true' },
    h('defs', null, h('radialGradient', { id: glowId }, h('stop', { offset: 0, 'stop-color': 'var(--lm-gold)', 'stop-opacity': 0.45 }), h('stop', { offset: 1, 'stop-color': 'var(--lm-gold)', 'stop-opacity': 0 }))),
    h('circle', { cx: 60, cy: 52, r: 44, fill: `url(#${glowId})` }),
    h('path', { d: 'M38 36 Q50 32 54 22 L66 22 Q70 32 82 36 Z', fill: 'var(--lm-surface-3)' }),
    h('rect', { x: 46, y: 36, width: 28, height: 26, rx: 2, fill: 'var(--lm-surface-3)' }),
    h('rect', { x: 52, y: 41, width: 16, height: 15, fill: kind === 'error' ? 'var(--lm-danger)' : 'var(--lm-gold)', opacity: 0.85 }),
    h('rect', { x: 42, y: 62, width: 36, height: 7, rx: 2, fill: 'var(--lm-surface-3)' }),
    h('rect', { x: 55, y: 69, width: 10, height: 26, fill: 'var(--lm-surface-3)' }),
    h('rect', { x: 40, y: 95, width: 40, height: 8, rx: 2, fill: 'var(--lm-surface-3)' }),
    h('circle', { cx: 60, cy: 17, r: 4, fill: 'var(--lm-surface-3)' }),
  );
  return svg;
}

export function errorState(err, { retry } = {}) {
  return emptyState({
    art: 'error',
    title: err?.status === 404 ? 'Not found' : 'Something went wrong',
    message: err?.message || 'Please try again in a moment.',
    actions: retry ? [button('Try again', { variant: 'primary', icon: 'refresh', onClick: retry })] : [],
  });
}

/** Panel shown in Preview mode for features that need the Lumina server. */
export function serverRequired(feature = 'This part of Lumina') {
  return h('div', { class: 'lm-server-required' },
    h('div', { class: 'lm-panel' },
      icon('lantern', { size: 44 }),
      h('span', { class: 'lm-eyebrow' }, 'Preview mode'),
      h('h1', null, `${feature} needs the Lumina server`),
      h('p', null, 'You are viewing Lumina on static hosting, which can browse and play the open catalog and keep your list on this device. Accounts, profiles, reviews, creator uploads and administration run on the Lumina server.'),
      h('p', null, 'To run it: ', h('code', null, 'npm start'), ' — see the README for setup.'),
      h('a', { class: 'lm-btn lm-btn--primary', href: '#/' }, h('span', null, 'Back to browsing'))));
}

// ── Ratings ──────────────────────────────────────────────
/** Read-only star display. */
export function stars(value, { size = 'md', label } = {}) {
  const el = h('span', { class: ['lm-stars', size === 'lg' && 'lm-stars--lg'], role: 'img', 'aria-label': label || `${value} out of 5 stars` });
  for (let i = 1; i <= 5; i++) el.append(starIcon(value >= i ? 'full' : value >= i - 0.5 ? 'half' : 'empty'));
  return el;
}

/** Accessible 1–5 star input (radio group). onChange(value). */
export function starInput({ value = 0, name = newUid('stars'), label = 'Your rating', onChange } = {}) {
  const fs = h('fieldset', { class: 'lm-star-input' }, h('legend', { class: 'visually-hidden' }, label));
  const labels = [];
  const paint = (v) => labels.forEach((l, i) => l.classList.toggle('is-on', i < v));
  for (let i = 1; i <= 5; i++) {
    const input = h('input', { type: 'radio', name, value: String(i), checked: i === value, 'aria-label': `${i} star${i > 1 ? 's' : ''}` });
    input.addEventListener('change', () => {
      value = i;
      paint(i);
      onChange?.(i);
      announce(`Rated ${i} of 5`);
    });
    const l = h('label', { onMouseenter: () => paint(i), onMouseleave: () => paint(value) }, input, starIcon('full'));
    labels.push(l);
    fs.append(l);
  }
  paint(value);
  fs.getValue = () => value;
  return fs;
}

// ── Form helpers ─────────────────────────────────────────
/**
 * Labelled field. `control` is an <input>/<select>/<textarea> (created if a type is given).
 *   field({ label: 'Email', name: 'email', type: 'email', required: true, hint })
 */
export function field({ label, name, type = 'text', value, hint, required, placeholder, autocomplete, control, options, rows, min, max, maxlength, pattern, inputmode } = {}) {
  const id = newUid('fld');
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = `${id}-err`;
  let el = control;
  if (!el) {
    if (type === 'select') {
      el = h('select', { class: 'lm-select' }, ...(options || []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
    } else if (type === 'textarea') {
      el = h('textarea', { class: 'lm-textarea', rows: rows || 5, placeholder, maxlength });
      if (value) el.value = value;
    } else {
      el = h('input', { class: 'lm-input', type, value: value ?? '', placeholder, autocomplete, min, max, maxlength, pattern, inputmode });
    }
  }
  el.id = id;
  if (name) el.name = name;
  if (required) el.required = true;
  el.setAttribute('aria-describedby', [hintId, errId].filter(Boolean).join(' '));
  const err = h('span', { class: 'lm-error-text', id: errId, hidden: true });
  const wrap = h('div', { class: 'lm-field' },
    h('label', { class: 'lm-label', for: id }, label, required ? h('span', { 'aria-hidden': 'true', class: 'lm-muted' }, ' *') : null),
    el,
    hint ? h('span', { class: 'lm-hint', id: hintId }, hint) : null,
    err);
  wrap.control = el;
  wrap.setError = (msg) => {
    wrap.classList.toggle('has-error', !!msg);
    el.setAttribute('aria-invalid', msg ? 'true' : 'false');
    err.hidden = !msg;
    err.textContent = msg || '';
  };
  return wrap;
}

/** Applies server field errors ({fields}) to a form built with field(). Returns true if any. */
export function applyFieldErrors(form, err) {
  const fields = err?.fields || {};
  let first = null;
  for (const wrap of form.querySelectorAll('.lm-field')) {
    const name = wrap.control?.name;
    wrap.setError?.(name && fields[name] ? fields[name] : '');
    if (name && fields[name] && !first) first = wrap.control;
  }
  first?.focus();
  return !!first;
}

/** Collects named controls of a form into an object (checkboxes → booleans). */
export function formValues(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') out[el.name] = el.checked;
    else if (el.type === 'radio') {
      if (el.checked) out[el.name] = el.value;
    } else out[el.name] = el.value;
  }
  return out;
}

export function checkbox(label, { name, checked, description } = {}) {
  return h('label', { class: 'lm-checkbox' }, h('input', { type: 'checkbox', name, checked }), h('span', null, label, description ? h('span', { class: 'lm-hint', style: { display: 'block' } }, description) : null));
}

/** Accessible switch. onChange(bool). */
export function toggleSwitch({ checked = false, label, onChange }) {
  const btn = h('button', { type: 'button', class: 'lm-switch', role: 'switch', 'aria-checked': String(checked), 'aria-label': label });
  btn.addEventListener('click', () => {
    const next = btn.getAttribute('aria-checked') !== 'true';
    btn.setAttribute('aria-checked', String(next));
    onChange?.(next);
  });
  btn.setChecked = (v) => btn.setAttribute('aria-checked', String(!!v));
  return btn;
}

/** Row with title/description and a control on the right. */
export function settingRow(title, description, control) {
  return h('div', { class: 'lm-setting' }, h('div', { class: 'lm-setting__text' }, h('strong', null, title), description ? h('span', null, description) : null), control);
}

/** Segmented control. options: [{value,label}] */
export function segmented({ options, value, label, onChange }) {
  const group = h('div', { class: 'lm-segmented', role: 'group', 'aria-label': label });
  const btns = options.map((o) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value) }, o.label);
    b.addEventListener('click', () => {
      btns.forEach((x) => x.setAttribute('aria-pressed', 'false'));
      b.setAttribute('aria-pressed', 'true');
      onChange?.(o.value);
    });
    return b;
  });
  group.append(...btns);
  return group;
}

/**
 * Tabs with roving focus. tabs: [{ id, label, render: () => Node|Promise<Node> }]
 * Returns the root; `onChange(id)` fires on switch.
 */
export function tabs({ tabs: defs, active, label, onChange }) {
  const baseId = newUid('tabs');
  const list = h('div', { class: 'lm-tabs', role: 'tablist', 'aria-label': label });
  const panel = h('div', { role: 'tabpanel', class: 'lm-tabpanel', tabindex: '0' });
  let current = active || defs[0].id;
  const btns = defs.map((d) => {
    const b = h('button', { type: 'button', class: 'lm-tab', role: 'tab', id: `${baseId}-${d.id}`, 'aria-selected': String(d.id === current), tabindex: d.id === current ? '0' : '-1' }, d.label);
    b.addEventListener('click', () => select(d.id));
    return b;
  });
  list.append(...btns);
  list.addEventListener('keydown', (e) => {
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % btns.length;
    if (e.key === 'ArrowLeft') j = (i - 1 + btns.length) % btns.length;
    if (e.key === 'Home') j = 0;
    if (e.key === 'End') j = btns.length - 1;
    if (j !== null) {
      e.preventDefault();
      btns[j].focus();
      select(defs[j].id);
    }
  });
  async function select(id) {
    current = id;
    btns.forEach((b, i) => {
      const on = defs[i].id === id;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    });
    panel.setAttribute('aria-labelledby', `${baseId}-${id}`);
    panel.replaceChildren(loading());
    const def = defs.find((d) => d.id === id);
    try {
      const node = await def.render();
      panel.replaceChildren(node);
    } catch (err) {
      panel.replaceChildren(errorState(err));
    }
    onChange?.(id);
  }
  const root = h('div', { class: 'lm-tabset' }, list, panel);
  root.select = select;
  select(current);
  return root;
}

/** Section heading with the gold rule and optional "See all" link. */
export function sectionHead(title, { subtitle, href, level = 'h2', id } = {}) {
  return h('div', { class: 'lm-section-head' },
    h('div', null, h(level, { id }, title), subtitle ? h('p', { class: 'lm-section-sub' }, subtitle) : null, h('span', { class: 'lm-rule', 'aria-hidden': 'true' })),
    href ? h('a', { class: 'lm-see-all', href }, 'See all', icon('chevronRight')) : null);
}

export function notice(message, { type = 'info', title } = {}) {
  const ico = type === 'warn' ? 'alert' : type === 'danger' ? 'alert' : type === 'ok' ? 'checkCircle' : 'info';
  return h('div', { class: ['lm-notice', type !== 'info' && `lm-notice--${type}`], role: type === 'danger' ? 'alert' : undefined }, icon(ico), h('div', null, title ? h('strong', { style: { display: 'block' } }, title) : null, message));
}

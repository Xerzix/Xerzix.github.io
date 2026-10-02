// Player UI building blocks: icon buttons, the menu controller (WAI-ARIA menu pattern with
// radio/checkbox items and sub-pages), the seek slider and in-player dialogs. Dialogs and
// menus live inside the player root so they keep working in fullscreen.
import { h, newUid } from '../core/dom.js';
import { clock } from '../core/format.js';
import { icon } from '../ui/icons.js';

// The skip glyphs end in a bar drawn as a line, which a filled icon does not paint: the
// player draws them as outlines so "next" never reads as a second play button.
const OUTLINED = new Set(['skipNext', 'skipPrev']);

/** Icon as used inside the player. */
export const playerIcon = (name) => icon(name, OUTLINED.has(name) ? { filled: false } : undefined);

/** Icon-only control button with an accessible name and a hover/focus tooltip. */
export function iconButton(name, label, onClick, { className, attrs = {} } = {}) {
  const btn = h('button', { type: 'button', class: ['lm-player__btn', className], 'aria-label': label, 'data-tip': label, onClick, ...attrs }, playerIcon(name));
  btn.setIcon = (next) => btn.replaceChildren(playerIcon(next));
  btn.setLabel = (text) => {
    btn.setAttribute('aria-label', text);
    btn.dataset.tip = text;
  };
  return btn;
}

// ─────────────────────────────── Menus ───────────────────────────────
/**
 * A popover menu attached to a trigger button.
 * build(menu) returns item definitions:
 *   { type: 'radio'|'check', label, sub?, checked, disabled?, onSelect }
 *   { type: 'action', label, icon?, onSelect, keepOpen? }
 *   { type: 'submenu', label, value?, items: () => defs, title }
 *   { type: 'group', label, items: defs }  { type: 'separator' }  { type: 'note', label }
 */
export class PlayerMenu {
  constructor({ host, trigger, label, build, onToggle }) {
    this.host = host;
    this.trigger = trigger;
    this.label = label;
    this.build = build;
    this.onToggle = onToggle;
    this.stack = [];
    this.el = h('div', { class: 'lm-player__menu', role: 'menu', 'aria-label': label, id: newUid('pmenu'), hidden: true });
    this.el.addEventListener('keydown', (e) => this.onKey(e));
    trigger.setAttribute('aria-haspopup', 'menu');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', this.el.id);
    trigger.addEventListener('click', () => (this.isOpen ? this.close() : this.open()));
    trigger.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.open();
      }
    });
    this.outside = (e) => {
      if (!this.el.contains(e.target) && !this.trigger.contains(e.target)) this.close();
    };
    host.append(this.el);
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.stack = [{ title: null, items: () => this.build(this) }];
    this.render();
    this.el.hidden = false;
    this.trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', this.outside, true);
    this.onToggle?.(true, this);
    this.focusInitial();
  }

  close({ focusTrigger = false } = {}) {
    if (!this.isOpen) return;
    this.el.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', this.outside, true);
    this.onToggle?.(false, this);
    if (focusTrigger) this.trigger.focus();
  }

  /** Rebuilds the current page in place (e.g. after the live quality label changes). */
  refresh() {
    if (!this.isOpen) return;
    const focusedIndex = this.items().indexOf(document.activeElement);
    this.render();
    if (focusedIndex >= 0) this.items()[Math.min(focusedIndex, this.items().length - 1)]?.focus();
  }

  items() {
    return [...this.el.querySelectorAll('[role^="menuitem"]:not([aria-disabled="true"])')];
  }

  focusInitial() {
    const checked = this.el.querySelector('[role^="menuitem"][aria-checked="true"]:not([aria-disabled="true"])');
    (checked || this.items()[0])?.focus();
  }

  render() {
    const page = this.stack.at(-1);
    const nodes = [];
    if (this.stack.length > 1) {
      nodes.push(h('button', { type: 'button', role: 'menuitem', class: 'lm-player__mi lm-player__mi--back', onClick: () => this.back() }, icon('chevronLeft'), h('span', null, page.title)));
      nodes.push(h('div', { class: 'lm-player__msep', role: 'separator' }));
    }
    for (const def of page.items()) nodes.push(this.renderItem(def));
    this.el.replaceChildren(...nodes.filter(Boolean));
  }

  renderItem(def) {
    switch (def.type) {
      case 'separator':
        return h('div', { class: 'lm-player__msep', role: 'separator' });
      case 'note':
        return h('p', { class: 'lm-player__mnote', role: 'none' }, def.label);
      case 'group': {
        const id = newUid('mgrp');
        return h('div', { role: 'group', 'aria-labelledby': id, class: 'lm-player__mgroup' },
          h('div', { class: 'lm-player__mlabel', id, role: 'presentation' }, def.label),
          ...def.items.map((d) => this.renderItem(d)));
      }
      case 'submenu':
        return h('button', {
          type: 'button', role: 'menuitem', class: 'lm-player__mi', 'aria-haspopup': 'menu',
          onClick: () => this.push(def),
        }, def.icon ? icon(def.icon) : h('span', { class: 'lm-player__mi-icon' }), h('span', { class: 'lm-player__mi-label' }, def.label), def.value ? h('span', { class: 'lm-player__mi-value' }, def.value) : null, icon('chevronRight'));
      case 'radio':
      case 'check': {
        const btn = h('button', {
          type: 'button',
          role: def.type === 'radio' ? 'menuitemradio' : 'menuitemcheckbox',
          class: 'lm-player__mi',
          'aria-checked': String(!!def.checked),
          'aria-disabled': def.disabled ? 'true' : undefined,
          onClick: () => {
            if (def.disabled) return;
            def.onSelect?.();
            if (def.type === 'check' || def.keepOpen) this.refresh();
            else this.close({ focusTrigger: true });
          },
        },
        h('span', { class: 'lm-player__mi-icon' }, def.checked ? icon('check') : null),
        h('span', { class: 'lm-player__mi-label' }, def.label, def.sub ? h('span', { class: 'lm-player__mi-sub' }, def.sub) : null));
        return btn;
      }
      default:
        return h('button', {
          type: 'button', role: 'menuitem', class: 'lm-player__mi',
          onClick: () => {
            if (!def.keepOpen) this.close({ focusTrigger: !def.noFocusReturn });
            def.onSelect?.();
          },
        }, def.icon ? icon(def.icon) : h('span', { class: 'lm-player__mi-icon' }), h('span', { class: 'lm-player__mi-label' }, def.label));
    }
  }

  push(def) {
    this.stack.push({ title: def.title || def.label, items: def.items });
    this.render();
    this.focusInitial();
  }

  back() {
    if (this.stack.length <= 1) return;
    this.stack.pop();
    this.render();
    this.focusInitial();
  }

  onKey(e) {
    const list = this.items();
    const i = list.indexOf(document.activeElement);
    const move = (j) => {
      e.preventDefault();
      list[(j + list.length) % list.length]?.focus();
    };
    switch (e.key) {
      case 'ArrowDown': move(i + 1); break;
      case 'ArrowUp': move(i - 1); break;
      case 'Home': move(0); break;
      case 'End': move(list.length - 1); break;
      case 'ArrowRight':
        if (document.activeElement?.getAttribute('aria-haspopup') === 'menu') {
          e.preventDefault();
          document.activeElement.click();
        } else e.preventDefault();
        break;
      case 'ArrowLeft':
      case 'Backspace':
        e.preventDefault();
        if (this.stack.length > 1) this.back();
        break;
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        this.close({ focusTrigger: true });
        break;
      case 'Tab':
        this.close();
        break;
      default:
        // Stop player shortcuts while navigating a menu (Space/Enter activate the item).
        if (e.key.length === 1 && e.key !== ' ') e.preventDefault();
    }
  }

  destroy() {
    document.removeEventListener('pointerdown', this.outside, true);
    this.el.remove();
  }
}

// ─────────────────────────────── Seek bar ───────────────────────────────
export class SeekBar {
  constructor({ onSeek, onScrub, step = 10 }) {
    this.onSeek = onSeek;
    this.onScrub = onScrub;
    this.step = step;
    this.duration = 0;
    this.current = 0;
    this.scrubbing = false;
    this.disabled = false;
    this.buffered = h('div', { class: 'lm-seek__buffered' });
    this.played = h('div', { class: 'lm-seek__played' });
    this.markers = h('div', { class: 'lm-seek__markers', 'aria-hidden': 'true' });
    this.thumb = h('div', { class: 'lm-seek__thumb', 'aria-hidden': 'true' });
    this.tip = h('div', { class: 'lm-seek__tip', 'aria-hidden': 'true' });
    this.el = h('div', {
      class: 'lm-seek', role: 'slider', tabindex: '0', 'aria-label': 'Seek', 'aria-valuemin': '0', 'aria-valuemax': '0', 'aria-valuenow': '0', 'aria-valuetext': '0:00',
    }, h('div', { class: 'lm-seek__track' }, this.buffered, this.played, this.markers), this.thumb, this.tip);
    this.bind();
  }

  bind() {
    const el = this.el;
    const timeAt = (e) => {
      const r = el.getBoundingClientRect();
      const x = Math.min(Math.max(e.clientX - r.left, 0), r.width);
      return { time: r.width ? (x / r.width) * this.duration : 0, x, width: r.width };
    };
    el.addEventListener('pointermove', (e) => {
      if (!this.duration) return;
      const { time, x, width } = timeAt(e);
      this.showTip(time, x, width);
      if (this.scrubbing) this.preview(time);
    });
    el.addEventListener('pointerleave', () => {
      if (!this.scrubbing) this.tip.classList.remove('is-visible');
    });
    el.addEventListener('pointerdown', (e) => {
      if (this.disabled || !this.duration || (e.pointerType === 'mouse' && e.button !== 0)) return;
      e.preventDefault();
      el.setPointerCapture?.(e.pointerId);
      this.scrubbing = true;
      el.classList.add('is-scrubbing');
      const { time, x, width } = timeAt(e);
      this.showTip(time, x, width);
      this.preview(time);
      this.onScrub?.(time);
    });
    const end = (e) => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      el.classList.remove('is-scrubbing');
      this.tip.classList.remove('is-visible');
      const { time } = timeAt(e);
      this.onScrub?.(null);
      this.onSeek?.(time, { final: true });
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', () => {
      if (!this.scrubbing) return;
      this.scrubbing = false;
      el.classList.remove('is-scrubbing');
      this.tip.classList.remove('is-visible');
      this.onScrub?.(null);
      this.render(this.current);
    });
    el.addEventListener('keydown', (e) => {
      if (this.disabled || !this.duration) return;
      let t = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') t = this.current + this.step;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') t = this.current - this.step;
      else if (e.key === 'PageUp') t = this.current + 60;
      else if (e.key === 'PageDown') t = this.current - 60;
      else if (e.key === 'Home') t = 0;
      else if (e.key === 'End') t = Math.max(0, this.duration - 1);
      if (t === null) return;
      e.preventDefault();
      t = Math.min(Math.max(t, 0), this.duration);
      this.render(t);
      this.onSeek?.(t, { final: true, keyboard: true });
    });
  }

  showTip(time, x, width) {
    this.tip.textContent = clock(time);
    const half = (this.tip.offsetWidth || 48) / 2;
    this.tip.style.left = `${Math.min(Math.max(x, half), Math.max(half, width - half))}px`;
    this.tip.classList.add('is-visible');
  }

  preview(time) {
    this.render(time);
  }

  setDuration(d) {
    this.duration = Number.isFinite(d) && d > 0 ? d : 0;
    this.el.setAttribute('aria-valuemax', String(Math.round(this.duration)));
  }

  setDisabled(disabled, reason) {
    this.disabled = !!disabled;
    this.el.setAttribute('aria-disabled', String(!!disabled));
    this.el.classList.toggle('is-disabled', !!disabled);
    if (reason) this.el.setAttribute('aria-description', reason);
    else this.el.removeAttribute('aria-description');
  }

  update(current, bufferedRanges) {
    this.current = current || 0;
    if (!this.scrubbing) this.render(this.current);
    if (bufferedRanges && this.duration) {
      let end = 0;
      for (let i = 0; i < bufferedRanges.length; i++) {
        if (bufferedRanges.start(i) <= this.current + 0.5 && bufferedRanges.end(i) >= this.current) end = bufferedRanges.end(i);
      }
      this.buffered.style.width = `${Math.min(100, (end / this.duration) * 100)}%`;
    }
  }

  render(t) {
    const pct = this.duration ? Math.min(100, Math.max(0, (t / this.duration) * 100)) : 0;
    this.played.style.width = `${pct}%`;
    this.thumb.style.left = `${pct}%`;
    this.el.setAttribute('aria-valuenow', String(Math.round(t || 0)));
    this.el.setAttribute('aria-valuetext', `${clock(t)} of ${clock(this.duration)}`);
  }

  /** Intro range and credits start, drawn on the track. */
  setMarkers({ introStart, introEnd, credits } = {}) {
    this.markers.replaceChildren();
    if (!this.duration) return;
    const pct = (s) => `${Math.min(100, Math.max(0, (s / this.duration) * 100))}%`;
    if (Number.isFinite(introStart) && Number.isFinite(introEnd) && introEnd > introStart) {
      this.markers.append(h('span', { class: 'lm-seek__range', title: 'Intro', style: { left: pct(introStart), width: `calc(${pct(introEnd)} - ${pct(introStart)})` } }));
    }
    if (Number.isFinite(credits) && credits > 0 && credits < this.duration) {
      this.markers.append(h('span', { class: 'lm-seek__tick', title: 'Credits', style: { left: pct(credits) } }));
    }
  }
}

// ─────────────────────────────── Dialogs ───────────────────────────────
/**
 * A modal dialog inside the player (works in fullscreen, unlike the page-level modal root).
 * Traps focus, closes on Esc or the close button, restores focus.
 */
export function playerDialog(host, { title, content, actions = [], className, onClose, side = false }) {
  const titleId = newUid('pdlg');
  const previous = document.activeElement;
  const body = h('div', { class: 'lm-player__dialog-body' }, content);
  const panel = h('div', { class: ['lm-player__dialog', side && 'lm-player__dialog--side', className], role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
    h('div', { class: 'lm-player__dialog-head' },
      h('h2', { id: titleId }, title),
      h('button', { type: 'button', class: 'lm-player__btn', 'aria-label': 'Close', 'data-tip': 'Close', onClick: () => close() }, icon('close'))),
    body,
    actions.length ? h('div', { class: 'lm-player__dialog-foot' }, ...actions) : null);
  const backdrop = h('div', { class: 'lm-player__backdrop', onClick: (e) => { if (e.target === backdrop) close(); } }, panel);
  let closed = false;
  const focusables = () => [...panel.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])')].filter((el) => el.offsetParent !== null || el === document.activeElement);
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    // Keep player shortcuts out of dialogs.
    e.stopPropagation();
  });
  function close(value) {
    if (closed) return;
    closed = true;
    backdrop.classList.add('is-leaving');
    setTimeout(() => backdrop.remove(), 180);
    onClose?.(value);
    if (previous && document.contains(previous)) previous.focus({ preventScroll: true });
  }
  host.append(backdrop);
  requestAnimationFrame(() => (panel.querySelector('[data-autofocus]') || focusables()[1] || focusables()[0])?.focus());
  return { el: panel, body, close, get closed() { return closed; } };
}

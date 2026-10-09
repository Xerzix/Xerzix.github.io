// DOM helpers. `h()` builds elements from data without ever parsing HTML, so any string
// passed as a child becomes a text node — this is Lumina's primary XSS defence. Do not use
// innerHTML with data anywhere in the app.
const SVG_NS = 'http://www.w3.org/2000/svg';
const SVG_CSS_PROPS = new Set(['fill', 'stroke', 'stop-color', 'stop-opacity', 'opacity', 'fill-opacity', 'stroke-opacity', 'color']);
const SVG_TAGS = new Set(['svg', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'g', 'defs', 'linearGradient', 'radialGradient', 'stop', 'use', 'mask', 'clipPath', 'filter', 'feGaussianBlur', 'text', 'tspan', 'symbol', 'title', 'pattern']);

/**
 * h('button', { class: 'lm-btn', onClick: fn, 'aria-label': 'Play' }, icon('play'), 'Play')
 * Props: class/className, style (object or string), dataset (object), on<Event> handlers,
 * boolean attributes (true → present, false/null → absent), ref (callback receiving the node).
 */
export function h(tag, props, ...children) {
  const isSvg = SVG_TAGS.has(tag) || props?.xmlns === SVG_NS;
  const el = isSvg ? document.createElementNS(SVG_NS, tag) : document.createElement(tag);
  if (props) applyProps(el, props, isSvg);
  append(el, children);
  return el;
}

function applyProps(el, props, isSvg) {
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class' || key === 'className') {
      const cls = Array.isArray(value) ? value.filter(Boolean).join(' ') : value;
      if (isSvg) el.setAttribute('class', cls);
      else el.className = cls;
    } else if (key === 'style') {
      if (typeof value === 'string') el.setAttribute('style', value);
      else for (const [prop, v] of Object.entries(value)) if (v !== undefined && v !== null) el.style.setProperty(prop.startsWith('--') ? prop : prop.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), String(v));
    } else if (key === 'dataset') {
      for (const [k, v] of Object.entries(value)) if (v !== undefined && v !== null) el.dataset[k] = v;
    } else if (key === 'ref') {
      value(el);
    } else if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
    } else if (key === 'text') {
      el.textContent = value;
    } else if (key === 'value' && 'value' in el && !isSvg) {
      el.value = value;
    } else if (key === 'checked' || key === 'selected' || key === 'disabled' || key === 'hidden' || key === 'open' || key === 'multiple' || key === 'required' || key === 'readOnly') {
      if (!isSvg && key in el) el[key] = !!value;
      else if (value) el.setAttribute(key, '');
    } else if (value === true) {
      el.setAttribute(key, '');
    } else if (isSvg && SVG_CSS_PROPS.has(key) && typeof value === 'string' && /var\(|color-mix\(/.test(value)) {
      // Presentation attributes do not reliably resolve custom properties; use inline CSS.
      el.style.setProperty(key, value);
    } else {
      if (key === 'href' || key === 'src' || key === 'action' || key === 'xlink:href') assertSafeUrl(value);
      el.setAttribute(key, String(value));
    }
  }
}

/** Blocks javascript: and other script-capable URLs from reaching href/src attributes. */
export function assertSafeUrl(url) {
  const s = String(url).trim().toLowerCase().replace(/[\u0000-\u001f\s]/g, '');
  if (s.startsWith('javascript:') || s.startsWith('vbscript:') || (s.startsWith('data:') && !s.startsWith('data:image/'))) {
    throw new Error(`Unsafe URL blocked: ${url}`);
  }
}

export function append(el, children) {
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false || child === true) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

export function clear(el) {
  while (el.firstChild) el.firstChild.remove();
  return el;
}

export function replace(el, ...children) {
  clear(el);
  return append(el, children);
}

export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Unique ids for aria relationships. */
let uid = 0;
export const newUid = (prefix = 'lm') => `${prefix}-${++uid}`;

/** Resolves on the next animation frame. */
export const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()));

export function prefersReducedMotion() {
  const pref = document.documentElement.dataset.motion;
  if (pref === 'reduced') return true;
  if (pref === 'full') return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** Debounce helper. */
export function debounce(fn, ms) {
  let t;
  const wrapped = (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
  wrapped.cancel = () => clearTimeout(t);
  return wrapped;
}

/** Announces a message to screen readers via the polite live region. */
export function announce(message) {
  const region = document.getElementById('lm-live');
  if (!region) return;
  region.textContent = '';
  setTimeout(() => {
    region.textContent = message;
  }, 50);
}

/** Loads an image and resolves when decoded (for smooth fades). */
export function loadImage(img) {
  if (img.complete && img.naturalWidth) return Promise.resolve();
  return new Promise((resolve) => {
    img.addEventListener('load', () => resolve(), { once: true });
    img.addEventListener('error', () => resolve(), { once: true });
  });
}

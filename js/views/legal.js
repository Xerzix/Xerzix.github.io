// Legal documents (#/legal/:doc). The drafts in content/legal/ are same-origin HTML fragments
// we trust, but they are still never inserted as HTML: the file is parsed into an inert
// document with DOMParser and rebuilt node by node with h() from an allowlist of elements and
// attributes. Scripts, styles, frames, embedded objects, forms, images, event-handler
// attributes and script-capable URLs never reach the page. Works in Preview mode (it only
// fetches a static file).
import { h, prefersReducedMotion } from '../core/dom.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, errorState, loading } from '../ui/components.js';

export const LEGAL_DOCS = [
  { id: 'terms', title: 'Terms of Service', summary: 'The agreement between you and the operator of this Lumina service.' },
  { id: 'privacy', title: 'Privacy Policy', summary: 'What this service collects, why, how long it is kept and the choices you have.' },
  { id: 'cookies', title: 'Cookie Policy', summary: 'The one cookie Lumina sets and what it keeps in your browser’s storage.' },
  { id: 'copyright', title: 'Copyright & Takedown', summary: 'How to report infringing material, how to respond, and how repeat infringement is handled.' },
  { id: 'community', title: 'Community Guidelines', summary: 'What is welcome in reviews, replies and shared collections, and how moderation works.' },
  { id: 'creator-agreement', title: 'Creator Submission Agreement', summary: 'The terms that apply when you submit your own work to Lumina.' },
  { id: 'accessibility', title: 'Accessibility Statement', summary: 'Our accessibility target, what is implemented, known limitations and how to give feedback.' },
  { id: 'contact', title: 'Contact & Support', summary: 'How to reach the operator about your account, content, privacy or legal matters.' },
];

// ───────────────────────────── Sanitising rebuild ─────────────────────────────

const HTML_NS = 'http://www.w3.org/1999/xhtml';

/** Elements kept as they are. */
const ALLOWED = new Set([
  'section', 'article', 'header', 'footer', 'aside', 'nav', 'div', 'p', 'span', 'h2', 'h3', 'h4', 'h5', 'h6',
  'ul', 'ol', 'li', 'dl', 'dt', 'dd', 'a', 'strong', 'em', 'b', 'i', 'u', 's', 'small', 'mark', 'code', 'kbd', 'pre',
  'blockquote', 'q', 'cite', 'abbr', 'time', 'address', 'br', 'hr', 'sup', 'sub', 'del', 'ins',
  'table', 'caption', 'colgroup', 'col', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'figure', 'figcaption', 'details', 'summary',
]);

/** Elements dropped together with everything inside them. Anything else unknown is unwrapped. */
const DROPPED = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'noscript', 'link', 'meta', 'base',
  'form', 'input', 'button', 'select', 'option', 'optgroup', 'textarea', 'label', 'fieldset', 'output', 'dialog',
  'img', 'picture', 'source', 'video', 'audio', 'track', 'canvas', 'map', 'area', 'svg', 'math', 'portal', 'title', 'head',
]);

const GLOBAL_ATTRS = new Set(['id', 'title', 'lang', 'dir']);
const TAG_ATTRS = {
  a: new Set(['href']),
  time: new Set(['datetime']),
  abbr: new Set(['title']),
  ol: new Set(['start', 'reversed', 'type']),
  th: new Set(['colspan', 'rowspan', 'scope', 'headers']),
  td: new Set(['colspan', 'rowspan', 'headers']),
  col: new Set(['span']),
  colgroup: new Set(['span']),
  details: new Set(['open']),
};
const NOTICE_TONES = new Set(['warn', 'info', 'danger', 'ok']);

const slug = (text) => String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * Classifies an href from the document. Returns { href, kind } for links that are safe to keep
 * ('route' in-app, 'section' within this document, 'external' http(s), 'mail'), or null.
 */
export function safeLegalHref(raw, docId) {
  const value = String(raw ?? '').replace(/[\u0000- \u007f]/g, '');
  if (!value) return null;
  if (value.startsWith('#/')) return /^#\/[A-Za-z0-9/_?=&.%-]*$/.test(value) ? { href: value, kind: 'route' } : null;
  if (value.startsWith('#')) {
    const id = slug(value.slice(1));
    return id ? { href: `#/legal/${docId}?s=${id}`, kind: 'section', section: id } : null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null; // relative paths and anything unparsable
  }
  if (url.protocol === 'https:' || url.protocol === 'http:') return { href: url.href, kind: 'external' };
  if (url.protocol === 'mailto:') return { href: url.href, kind: 'mail' };
  return null; // javascript:, data:, vbscript:, file:, …
}

/**
 * Rebuilds the children of `source` (a node from a DOMParser document) as fresh nodes made
 * with h(). Returns an array of nodes and strings.
 */
export function rebuild(source, docId, ids = new Set()) {
  const out = [];
  for (const node of source.childNodes) {
    if (node.nodeType === 3) {
      out.push(node.data);
      continue;
    }
    if (node.nodeType !== 1) continue; // comments, processing instructions…
    if (node.namespaceURI !== HTML_NS) continue; // SVG and MathML islands
    let tag = node.localName;
    if (DROPPED.has(tag)) continue;
    const children = rebuild(node, docId, ids);
    if (tag === 'h1') tag = 'h2'; // the page has exactly one h1: the document title
    if (!ALLOWED.has(tag)) {
      out.push(...children);
      continue;
    }
    const tone = node.getAttribute('data-notice');
    if (tone !== null && (tag === 'aside' || tag === 'div' || tag === 'section')) {
      const t = NOTICE_TONES.has(tone) ? tone : 'info';
      out.push(h('div', { class: ['lm-notice', t !== 'info' && `lm-notice--${t}`], role: 'note', style: { margin: '0 0 var(--lm-space-5)' } }, icon(t === 'info' ? 'info' : t === 'ok' ? 'checkCircle' : 'alert'), h('div', null, ...children)));
      continue;
    }
    const props = {};
    const allowed = TAG_ATTRS[tag];
    for (const { name, value } of node.attributes) {
      const n = name.toLowerCase();
      if (!(GLOBAL_ATTRS.has(n) || allowed?.has(n))) continue;
      if (n === 'id') {
        let id = slug(value);
        if (!id || ids.has(id)) continue;
        ids.add(id);
        props.id = `legal-${id}`;
      } else if (n === 'href') {
        const link = safeLegalHref(value, docId);
        if (!link) continue;
        props.href = link.href;
        if (link.kind === 'section') props['data-section'] = link.section;
        if (link.kind === 'external') {
          props.target = '_blank';
          props.rel = 'noopener noreferrer';
        }
      } else if (['colspan', 'rowspan', 'span', 'start'].includes(n)) {
        if (/^\d{1,3}$/.test(value)) props[n] = value;
      } else if (n === 'reversed' || n === 'open') {
        props[n] = true;
      } else {
        props[n] = value.slice(0, 300);
      }
    }
    if (tag === 'a' && !props.href) {
      // An unsafe or missing link keeps its text (and anchor id) but is no longer a link.
      out.push(h('span', props.id ? { id: props.id } : null, ...children));
      continue;
    }
    if (/^h[2-6]$/.test(tag)) {
      if (!props.id) {
        let base = slug(node.textContent) || 'section';
        let id = base;
        for (let i = 2; ids.has(id); i++) id = `${base}-${i}`;
        ids.add(id);
        props.id = `legal-${id}`;
      }
      props.style = { scrollMarginTop: 'calc(var(--lm-header-h) + 24px)' };
    }
    // Tables use the design system's table styles; long cells read better top-aligned.
    if (tag === 'table') props.class = 'lm-table';
    if (tag === 'td' || tag === 'th') props.style = { verticalAlign: 'top' };
    if (tag === 'caption') props.style = { captionSide: 'top', textAlign: 'left', padding: '12px 14px', fontSize: 'var(--lm-fs-sm)', fontWeight: 'var(--lm-weight-semibold)', color: 'var(--lm-text)' };
    const el = h(tag, props, ...children);
    if (props.target === '_blank') el.append(h('span', { class: 'visually-hidden' }, ' (opens in a new tab)'));
    // Wide tables scroll inside their own frame on narrow screens instead of widening the page.
    out.push(tag === 'table' ? h('div', { class: 'lm-table-wrap', style: { margin: '0 0 var(--lm-space-5)', background: 'color-mix(in srgb, var(--lm-surface) 88%, transparent)' } }, el) : el);
  }
  return out;
}

/** Parses an HTML fragment into an inert document and returns the rebuilt, safe nodes. */
export function sanitizeLegalHtml(html, docId) {
  const parsed = new DOMParser().parseFromString(String(html), 'text/html');
  return rebuild(parsed.body, docId);
}

// ───────────────────────────── Page ─────────────────────────────

// Applies only while a legal page is open: removes the app chrome and prints dark-on-light.
const PRINT_CSS = `
@page { margin: 18mm 16mm; }
html, body { background: #fff !important; color: #111 !important; }
#lm-header, #lm-footer, #lm-garden, .lm-petals, .lm-preview-banner, .lm-skip-link, #lm-toasts,
[data-legal-aside], [data-legal-print], [data-legal-toc] { display: none !important; }
.lm-page { padding: 0 !important; min-height: 0 !important; }
.lm-two-col { display: block !important; }
.lm-page-header { margin-bottom: 8mm !important; }
.lm-page-header h1, .lm-legal-doc h2, .lm-legal-doc h3, .lm-legal-doc strong { color: #000 !important; }
.lm-page-header p, .lm-legal-doc, .lm-legal-doc p, .lm-legal-doc li, .lm-legal-doc td, .lm-legal-doc th { color: #111 !important; }
.lm-page-header .lm-eyebrow, .lm-page-header .lm-muted { color: #333 !important; }
.lm-legal-doc { max-width: none !important; font-size: 11pt; line-height: 1.5; }
.lm-legal-doc a { color: #000 !important; text-decoration: underline !important; }
.lm-legal-doc a[target="_blank"]::after { content: " (" attr(href) ")"; font-size: 9pt; }
.lm-legal-doc h2, .lm-legal-doc h3 { break-after: avoid; }
.lm-legal-doc table, .lm-legal-doc li { break-inside: avoid; }
.lm-legal-doc .lm-table-wrap { overflow: visible !important; border: 1px solid #000 !important; }
.lm-legal-doc th, .lm-legal-doc caption { background: none !important; color: #000 !important; }
.lm-legal-doc th, .lm-legal-doc td { border-bottom: 1px solid #999 !important; }
.lm-legal-doc .lm-notice, .lm-badge { background: none !important; border: 1px solid #000 !important; color: #000 !important; }
.lm-legal-doc .lm-notice svg { display: none; }
`;

function docNav(current) {
  return h('nav', { class: 'lm-panel', 'aria-label': 'Legal documents', 'data-legal-aside': '' },
    h('h2', { class: 'lm-eyebrow', style: { margin: '0 0 var(--lm-space-3)' } }, 'Legal documents'),
    h('ul', { class: 'lm-stack lm-stack--sm lm-small', role: 'list', style: { listStyle: 'none', margin: 0, padding: 0 } },
      ...LEGAL_DOCS.map((d) => h('li', null, d.id === current
        ? h('a', { href: `#/legal/${d.id}`, 'aria-current': 'page', style: { color: 'var(--lm-text)', fontWeight: 'var(--lm-weight-semibold)' } }, d.title)
        : h('a', { class: 'lm-link', href: `#/legal/${d.id}` }, d.title)))));
}

function scrollToSection(container, id, { focus = true } = {}) {
  const target = container.querySelector(`#legal-${CSS.escape(id)}`);
  if (!target) return false;
  target.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
  if (focus) {
    // Moves the reading position for keyboard and screen-reader users; a heading is not a
    // control, so it gets no focus ring (the scroll already shows where the reader is).
    target.setAttribute('tabindex', '-1');
    target.style.outline = 'none';
    target.focus({ preventScroll: true });
  }
  return true;
}

export default async function render(ctx) {
  const docId = ctx.params.doc;
  const meta = LEGAL_DOCS.find((d) => d.id === docId);
  if (!meta) {
    ctx.setTitle('Legal documents');
    return h('div', { class: 'lm-page lm-container' },
      h('header', { class: 'lm-page-header' }, h('div', null, h('span', { class: 'lm-eyebrow' }, 'Legal'), h('h1', null, 'Legal documents'))),
      h('div', { class: 'lm-two-col' },
        emptyState({ title: 'We could not find that document', message: 'Choose one of Lumina’s legal documents instead.' }),
        docNav(null)));
  }
  ctx.setTitle(meta.title);

  const article = h('article', { class: 'lm-prose lm-legal-doc', 'aria-labelledby': 'legal-title', style: { maxWidth: 'var(--lm-maxw-text)' } }, loading('Loading the document…'));
  // The documents number their own headings ("1. Summary"), so the list adds no markers.
  const tocList = h('ol', { class: 'lm-stack lm-stack--sm lm-small', style: { margin: 0, padding: 0, listStyle: 'none' } });
  const toc = h('details', { class: 'lm-panel', open: true, 'data-legal-toc': '' },
    h('summary', { class: 'lm-eyebrow', style: { cursor: 'pointer' } }, 'On this page'),
    h('nav', { 'aria-label': 'On this page', style: { marginTop: 'var(--lm-space-3)' } }, tocList));
  const aside = h('aside', { class: 'lm-stack', 'aria-label': 'Document navigation', 'data-legal-aside': '' }, toc, docNav(docId));
  const main = h('div', { class: 'lm-stack' }, article);

  // Wide screens keep the contents beside the text (sticky); narrow screens show it first.
  const wide = window.matchMedia('(min-width: 960px)');
  const place = () => {
    if (wide.matches) {
      aside.prepend(toc);
      Object.assign(aside.style, { position: 'sticky', top: 'calc(var(--lm-header-h) + 24px)', alignSelf: 'start', maxHeight: 'calc(100vh - var(--lm-header-h) - 48px)', overflowY: 'auto' });
    } else {
      main.prepend(toc);
      aside.removeAttribute('style');
      toc.open = false;
    }
  };
  place();
  wide.addEventListener('change', place);
  ctx.onDestroy(() => wide.removeEventListener('change', place));

  // In-document links (contents and cross-references) scroll without a route change.
  const onSectionClick = (e) => {
    const a = e.target.closest('a[data-section]');
    if (!a || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!scrollToSection(article, a.dataset.section)) return;
    e.preventDefault();
    history.replaceState(history.state, '', a.getAttribute('href'));
  };
  article.addEventListener('click', onSectionClick);
  tocList.addEventListener('click', onSectionClick);

  const load = async () => {
    article.replaceChildren(loading('Loading the document…'));
    try {
      const res = await fetch(`content/legal/${docId}.html`, { signal: ctx.signal, headers: { Accept: 'text/html' } });
      if (!res.ok) throw Object.assign(new Error(res.status === 404 ? 'This document has not been published yet.' : `The document could not be loaded (HTTP ${res.status}).`), { status: res.status });
      const nodes = sanitizeLegalHtml(await res.text(), docId);
      article.replaceChildren(...nodes);
      const headings = [...article.querySelectorAll('h2[id]')];
      tocList.replaceChildren(...headings.map((hd) => {
        const id = hd.id.replace(/^legal-/, '');
        return h('li', null, h('a', { class: 'lm-link', href: `#/legal/${docId}?s=${id}`, 'data-section': id }, hd.textContent));
      }));
      toc.hidden = headings.length < 2;
      const wanted = ctx.query.get('s');
      if (wanted) setTimeout(() => scrollToSection(article, wanted), 0);
    } catch (err) {
      if (err.name === 'AbortError') return;
      toc.hidden = true;
      article.replaceChildren(errorState(err, { retry: load }));
    }
  };
  await load();

  const printStyle = h('style', { media: 'print' }, PRINT_CSS);
  return h('div', { class: 'lm-page lm-container' },
    printStyle,
    h('header', { class: 'lm-page-header' },
      h('div', null,
        h('span', { class: 'lm-eyebrow' }, 'Legal'),
        h('h1', { id: 'legal-title' }, meta.title),
        h('p', null, meta.summary),
        h('div', { class: 'lm-cluster lm-cluster--sm', style: { marginTop: 'var(--lm-space-3)' } },
          h('span', { class: 'lm-badge lm-badge--warn' }, 'Draft'),
          h('span', { class: 'lm-small lm-muted' }, 'Prepared for legal review — not yet in effect.'))),
      h('div', { 'data-legal-print': '' }, button('Print', { variant: 'ghost', size: 'sm', onClick: () => window.print() }))),
    h('div', { class: 'lm-two-col' }, main, aside));
}

// Title artwork with an honest fallback. Every poster, backdrop and episode still in the app is
// rendered through artImg(): it shows the title's real artwork (lazy-loaded, with responsive
// sizes when available) and, when there is none or the image cannot load (artwork not synced
// yet, metadata provider unavailable, file removed), the Lumina-branded fallback below. The
// fallback names the title; it never imitates a poster.
import { h } from '../core/dom.js';
import { logoMark } from './icons.js';

/** Branded stand-in: midnight and velvet, the Lumina mark, and the title's name. */
export function artFallback({ title = '', kind = 'poster', className = '' } = {}) {
  return h('div', { class: ['lm-artfb', className], 'data-kind': kind, 'aria-hidden': 'true' },
    h('span', { class: 'lm-artfb__petals' }),
    logoMark('lm-artfb__mark'),
    title ? h('span', { class: 'lm-artfb__title' }, title) : null,
    h('span', { class: 'lm-artfb__note' }, 'Lumina'));
}

/**
 * <img> for a piece of title artwork, or the fallback.
 * @param {{ src?: string|null, srcset?: string|null, sizes?: string, alt?: string, title?: string,
 *   kind?: 'poster'|'backdrop'|'still', loading?: 'lazy'|'eager', fetchpriority?: string, className?: string }} o
 */
export function artImg({ src, srcset = null, sizes, alt = '', title = '', kind = 'poster', loading = 'lazy', fetchpriority, className } = {}) {
  if (!src) return artFallback({ title, kind, className });
  const img = h('img', {
    class: className,
    src,
    srcset: srcset || undefined,
    sizes: srcset ? sizes : undefined,
    alt,
    loading,
    decoding: 'async',
    fetchpriority,
    'data-loading': '',
    'data-kind': kind,
  });
  img.addEventListener('load', () => img.removeAttribute('data-loading'), { once: true });
  img.addEventListener('error', () => {
    // A broken image never stays on screen.
    if (img.isConnected) img.replaceWith(artFallback({ title, kind, className }));
  }, { once: true });
  return img;
}

/** Best poster-shaped source for a title summary. */
export const posterOf = (t) => ({ src: t?.poster || null, srcset: t?.poster ? t.posterSrcset : null });
/** Best wide source: the backdrop, else nothing (a poster stretched wide looks wrong). */
export const backdropOf = (t) => ({ src: t?.backdrop || null, srcset: t?.backdrop ? t.backdropSrcset : null });

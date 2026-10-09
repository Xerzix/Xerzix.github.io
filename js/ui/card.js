// Title cards (poster and landscape), the shared metadata line, and the touch quick-view.
import { h, loadImage } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { library, toggleList, session } from '../core/session.js';
import { titleFacts, timeLeft, languageName } from '../core/format.js';
import { ratingLabel } from '../core/ratings.js';
import { navigate } from '../core/router.js';
import { icon } from './icons.js';
import { button, openModal, toast, toastError, stars } from './components.js';

export function qualityBadge(t) {
  if (!t.quality) return null;
  return h('span', { class: ['lm-badge', t.quality === '4K' && 'lm-badge--4k'], title: t.quality === '4K' ? 'Available in 4K Ultra HD' : t.quality === 'HD' ? 'Available in HD' : 'Standard definition' }, t.quality === '4K' ? '4K UHD' : t.quality);
}

export function ageBadge(t) {
  const advisory = t.ratingSource === 'advisory';
  return h('span', {
    class: 'lm-badge lm-badge--solid',
    title: `${ratingLabel(t.ageRating)}${advisory ? ' — advisory rating assigned by Lumina' : ''}`,
  }, t.ageRating);
}

/** "2010 · TV-14 · 15m · 4K UHD · CC" metadata line. */
export function titleMeta(t, { extended = false } = {}) {
  const facts = titleFacts(t);
  const el = h('div', { class: 'lm-meta' });
  if (facts[0]) el.append(h('span', null, facts[0]));
  el.append(ageBadge(t));
  for (const f of facts.slice(1)) el.append(h('span', null, f));
  const q = qualityBadge(t);
  if (q) el.append(q);
  if (t.hdr) el.append(h('span', { class: 'lm-badge' }, t.hdr));
  if (t.hasSubtitles) el.append(h('span', { class: 'lm-badge', title: `Subtitles: ${t.subtitleLanguages.map((l) => languageName(l)).join(', ')}` }, 'CC'));
  if (extended && t.audioLanguages?.length) {
    el.append(h('span', { title: 'Audio' }, t.audioLanguages.map((l) => languageName(l)).join(', ')));
  }
  if (t.memberRating?.count) {
    el.append(h('span', { class: 'lm-cluster lm-cluster--sm', title: `${t.memberRating.average} average from ${t.memberRating.count} member ratings` }, stars(t.memberRating.average), h('span', null, String(t.memberRating.average))));
  }
  return el;
}

export function playHref(t, episodeId) {
  return `#/watch/${encodeURIComponent(t.id)}${episodeId ? `?episode=${encodeURIComponent(episodeId)}` : ''}`;
}

function listButton(t, { size = 'sm', variant = 'glass', label = false } = {}) {
  const inList = library.inList(t.id);
  const b = button(label ? (inList ? 'In My List' : 'My List') : '', {
    variant,
    size,
    icon: inList ? 'check' : 'plus',
    ariaLabel: `${inList ? 'Remove' : 'Add'} ${t.title} ${inList ? 'from' : 'to'} My List`,
    attrs: { 'data-list-toggle': t.id, 'data-list-label': label ? '1' : '', title: inList ? 'Remove from My List' : 'Add to My List', 'aria-pressed': String(inList) },
    onClick: async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (!session.profile) {
        toast('Sign in and choose a profile to keep a list.', { action: { label: 'Sign in', onClick: () => navigate('/login') } });
        return;
      }
      try {
        const added = await toggleList(t.id);
        toast(added ? `Added “${t.title}” to My List` : `Removed “${t.title}” from My List`, { type: 'success', timeout: 2600 });
      } catch (err) {
        toastError(err);
      }
    },
  });
  return b;
}
export { listButton };

// Keep every My List button in sync with the library cache.
bus.on('library:changed', () => {
  for (const b of document.querySelectorAll('[data-list-toggle]')) {
    const id = b.dataset.listToggle;
    const inList = library.inList(id);
    b.setAttribute('aria-pressed', String(inList));
    b.title = inList ? 'Remove from My List' : 'Add to My List';
    const svg = b.querySelector('svg');
    if (svg) svg.replaceWith(icon(inList ? 'check' : 'plus'));
    const span = b.querySelector('span');
    if (span && b.dataset.listLabel) span.textContent = inList ? 'In My List' : 'My List';
    const name = b.getAttribute('aria-label')?.replace(/^(Add|Remove) (.*) (to|from) My List$/, '$2');
    if (name) b.setAttribute('aria-label', `${inList ? 'Remove' : 'Add'} ${name} ${inList ? 'from' : 'to'} My List`);
  }
});

// Card art is at most ~212px (poster) or ~360px (landscape) wide (css/tokens.css), and grid
// cards stretch a little; uploaded artwork offers smaller copies through srcset.
const CARD_SIZES = { poster: '(max-width: 640px) 34vw, 260px', landscape: '(max-width: 640px) 80vw, 420px' };

function artImage(src, alt = '', srcset = null, sizes = undefined) {
  const img = h('img', { src, alt, srcset: srcset || undefined, sizes: srcset ? sizes : undefined, loading: 'lazy', decoding: 'async', 'data-loading': '' });
  loadImage(img).then(() => img.removeAttribute('data-loading'));
  return img;
}

/**
 * A title card.
 * @param {object} t   TitleSummary
 * @param {object} o   { variant: 'poster'|'landscape', progress (0–1), episode, positionS, durationS, reason, upNext }
 */
export function titleCard(t, o = {}) {
  const variant = o.variant || 'poster';
  const landscape = variant === 'landscape';
  const facts = titleFacts(t);
  const kind = t.type === 'series' ? 'series' : 'film';
  const episodeLabel = o.episode ? `S${o.episode.seasonNumber}:E${o.episode.number} “${o.episode.name}”` : '';
  const href = landscape ? playHref(t, o.episode?.id) : `#/title/${encodeURIComponent(t.id)}`;
  const ariaLabel = landscape
    ? `${o.upNext ? 'Play next' : 'Resume'} ${t.title}${episodeLabel ? `, ${episodeLabel}` : ''}${o.durationS ? `, ${timeLeft(o.positionS, o.durationS)}` : ''}`
    : `${t.title}, ${[facts[0], kind, t.ageRating, t.quality].filter(Boolean).join(', ')}`;
  const tint = t.palette?.[0];
  const progress = o.progress ?? (library.progressFor(t.id)?.durationS ? library.progressFor(t.id).positionS / library.progressFor(t.id).durationS : null);

  const art = h('div', { class: 'lm-card__art' },
    landscape
      ? artImage(o.episode?.still || t.backdrop || t.poster, '', o.episode?.still ? null : t.backdrop ? t.backdropSrcset : t.posterSrcset, CARD_SIZES.landscape)
      : artImage(t.poster || t.backdrop, '', t.poster ? t.posterSrcset : t.backdropSrcset, CARD_SIZES.poster),
    h('div', { class: 'lm-card__badges' }, qualityBadge(t)),
    landscape ? h('div', { class: 'lm-card__play-hint', 'aria-hidden': 'true' }, h('span', null, icon('play'))) : null,
    progress && progress > 0.01 && progress < 0.99 ? h('div', { class: 'lm-card__progress' }, h('div', { class: 'lm-progress', role: 'progressbar', 'aria-label': 'Watched', 'aria-valuenow': String(Math.round(progress * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { style: { width: `${Math.round(progress * 100)}%` } }))) : null);

  const overlay = h('div', { class: 'lm-card__overlay' },
    h('div', { class: 'lm-card__overlay-title' }, t.title),
    landscape && episodeLabel ? h('div', { class: 'lm-card__episode' }, episodeLabel) : null,
    titleMeta(t),
    h('div', { class: 'lm-card__genres' }, (t.genres || []).slice(0, 3).join(' · ')),
    o.reason ? h('div', { class: 'lm-card__genres' }, o.reason) : null,
    h('div', { class: 'lm-card__actions' },
      button('', { variant: 'light', size: 'sm', icon: 'play', ariaLabel: `Play ${t.title}`, attrs: { title: 'Play' }, onClick: (e) => { e.preventDefault(); navigate(playHref(t, o.episode?.id).slice(1)); } }),
      listButton(t),
      button('', { variant: 'glass', size: 'sm', icon: 'chevronDown', ariaLabel: `More about ${t.title}`, attrs: { title: 'More information' }, onClick: (e) => { e.preventDefault(); navigate(`/title/${encodeURIComponent(t.id)}`); } })));

  const card = h('article', { class: 'lm-card', 'data-variant': variant, 'data-title-id': t.id, style: tint ? { '--card-tint': tint } : undefined },
    h('a', { class: 'lm-card__link', href, 'aria-label': ariaLabel }, art),
    overlay,
    h('button', { class: 'lm-card__info-touch', type: 'button', 'aria-label': `Quick view: ${t.title}`, onClick: () => quickView(t, o) }, icon('info')),
    h('div', { class: 'lm-card__caption' },
      h('span', { class: 'lm-card__title' }, t.title),
      landscape
        ? h('span', { class: 'lm-card__sub' }, [episodeLabel || (o.upNext ? 'Up next' : ''), o.durationS ? timeLeft(o.positionS, o.durationS) : ''].filter(Boolean).join(' · '))
        : h('span', { class: 'lm-card__sub' }, facts.join(' · '), h('span', { class: 'lm-badge lm-badge--solid' }, t.ageRating))));
  return card;
}

/** Skeleton placeholder while rows load. */
export function skeletonCard(variant = 'poster') {
  return h('div', { class: 'lm-card lm-card--skeleton', 'data-variant': variant, 'aria-hidden': 'true' },
    h('div', { class: 'lm-card__art lm-skeleton' }),
    h('div', { class: 'lm-card__caption' }, h('div', { class: 'lm-skeleton', style: { height: '12px', width: '70%' } })));
}

/** Touch equivalent of the hover preview: a bottom sheet with the same information and actions. */
export function quickView(t, o = {}) {
  let modal;
  const content = h('div', { class: 'lm-stack' },
    t.backdrop ? h('img', { src: t.backdrop, alt: '', style: { borderRadius: 'var(--lm-radius-md)', aspectRatio: '16/9', objectFit: 'cover', width: '100%' } }) : null,
    titleMeta(t, { extended: true }),
    h('p', { class: 'lm-muted' }, t.synopsis),
    h('p', { class: 'lm-small lm-muted' }, (t.genres || []).join(' · ')),
    h('div', { class: 'lm-cluster' },
      button(o.progress ? 'Resume' : 'Play', { variant: 'primary', icon: 'play', onClick: () => { modal.close(); navigate(playHref(t, o.episode?.id).slice(1)); } }),
      listButton(t, { size: undefined, variant: undefined, label: true }),
      button('Details', { variant: 'ghost', icon: 'info', onClick: () => { modal.close(); navigate(`/title/${encodeURIComponent(t.id)}`); } })));
  modal = openModal({ title: t.title, content, sheet: true });
}

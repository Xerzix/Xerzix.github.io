// Horizontal content rows with scroll-snap, paging buttons, keyboard navigation between
// cards and lazy rendering (cards are built only when a row approaches the viewport).
import { h, newUid } from '../core/dom.js';
import { icon } from './icons.js';
import { sectionHead } from './components.js';
import { titleCard, skeletonCard } from './card.js';

/**
 * @param {{ id, title, subtitle?, href?, items: object[], variant?: 'poster'|'landscape', render?: (item) => Node }} row
 * Items are `{ title: TitleSummary, ...cardOptions }` (as returned by the home API) unless
 * a custom `render` is given.
 */
export function carousel({ id, title, subtitle, href, items, variant = 'poster', render }) {
  const headingId = newUid('row');
  const track = h('ul', { class: 'lm-row__track', role: 'list' });
  const prev = h('button', { class: 'lm-row__nav lm-row__nav--prev', type: 'button', 'aria-label': `Previous titles in ${title}`, disabled: true }, icon('chevronLeft'));
  const next = h('button', { class: 'lm-row__nav lm-row__nav--next', type: 'button', 'aria-label': `More titles in ${title}` }, icon('chevronRight'));
  const section = h('section', { class: 'lm-row', 'data-row': id, 'data-variant': variant, 'aria-labelledby': headingId },
    h('div', { class: 'lm-row__head' }, sectionHead(title, { subtitle, href, id: headingId })),
    h('div', { class: 'lm-row__viewport' }, prev, track, next));

  const build = render || ((item) => titleCard(item.title, { ...item, variant }));
  let built = false;
  const fill = () => {
    if (built) return;
    built = true;
    track.replaceChildren(...items.map((item) => h('li', null, build(item))));
    update();
  };
  // Placeholders keep layout stable until the row is near the viewport.
  track.append(...Array.from({ length: Math.min(items.length, 8) }, () => h('li', null, skeletonCard(variant))));
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      fill();
      io.disconnect();
    }
  }, { rootMargin: '600px 0px' });
  io.observe(section);

  const update = () => {
    const max = track.scrollWidth - track.clientWidth - 4;
    prev.disabled = track.scrollLeft <= 4;
    next.disabled = track.scrollLeft >= max;
  };
  const page = (dir) => {
    track.scrollBy({ left: dir * track.clientWidth * 0.85, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  prev.addEventListener('click', () => page(-1));
  next.addEventListener('click', () => page(1));
  track.addEventListener('scroll', () => requestAnimationFrame(update), { passive: true });
  window.addEventListener('resize', update, { passive: true });

  // Arrow keys move between cards; Home/End jump to the ends.
  track.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const links = [...track.querySelectorAll('.lm-card__link')];
    const current = links.findIndex((l) => l === document.activeElement || l.parentElement.contains(document.activeElement));
    if (current < 0) return;
    let target = current;
    if (e.key === 'ArrowRight') target = Math.min(links.length - 1, current + 1);
    if (e.key === 'ArrowLeft') target = Math.max(0, current - 1);
    if (e.key === 'Home') target = 0;
    if (e.key === 'End') target = links.length - 1;
    e.preventDefault();
    links[target].focus();
    links[target].scrollIntoView({ block: 'nearest', inline: 'nearest' });
  });

  section.fill = fill;
  return section;
}

/** A responsive grid of cards (browse pages, My List, search results). */
export function cardGrid(items, { variant = 'poster', render } = {}) {
  const build = render || ((item) => titleCard(item.title || item, { ...(item.title ? item : {}), variant }));
  return h('ul', { class: ['lm-grid', variant === 'landscape' && 'lm-grid--landscape'], role: 'list' }, ...items.map((item) => h('li', null, build(item))));
}

// Building blocks for the live TMDB catalogue: cards, rows, an infinitely scrolling grid, the
// required TMDB credit and friendly error states. Data comes from /api/tmdb/* (the server holds
// the TMDB credential); images load from TMDB's public image CDN.
import { h, announce, newUid } from '../core/dom.js';
import { date, plural } from '../core/format.js';
import { icon } from './icons.js';
import { artImg } from './artwork.js';
import { carousel } from './carousel.js';
import { button, emptyState, errorState, loading, serverRequired } from './components.js';

export const TMDB_NOTICE = 'This product uses the TMDB API but is not endorsed or certified by TMDB.';
const TMDB_URL = 'https://www.themoviedb.org/';
// Drop TMDB's official logo here (https://www.themoviedb.org/about/logos-attribution). Until
// it exists, the credit shows the name in text instead of a broken image.
const TMDB_LOGO = 'assets/brand/tmdb-logo.svg';

export const tmdbHref = (item) => `#/explore/title/${item.type}/${item.id}`;
export const typeLabel = (type) => (type === 'tv' ? 'TV series' : 'Film');

/** "12 Mar 2010" from a TMDB date, read as a calendar date (no time-zone shift). */
export function releaseDate(iso) {
  return iso && /^\d{4}-\d{2}-\d{2}$/.test(iso) ? date(`${iso}T12:00:00`) : '';
}

/** TMDB's 0–10 member score, e.g. "7.8". Null when nobody has voted. */
export function ratingText(item) {
  return item?.rating == null ? null : item.rating.toFixed(1);
}

export function ratingBadge(item, { long = false } = {}) {
  const r = ratingText(item);
  if (!r) return null;
  const label = `TMDB rating ${r} out of 10${item.voteCount ? ` from ${plural(item.voteCount, 'vote')}` : ''}`;
  return h('span', { class: 'lm-tmdb-score', title: label, 'aria-label': label },
    icon('star', { size: 13 }), h('span', null, r), long && item.voteCount ? h('span', { class: 'lm-tmdb-score__votes' }, `(${item.voteCount.toLocaleString()})`) : null);
}

const POSTER_SIZES = '(max-width: 640px) 34vw, 260px';

/** A poster card for a TMDB movie or series. */
export function tmdbCard(item) {
  const facts = [item.year, typeLabel(item.type)].filter(Boolean);
  return h('article', { class: 'lm-card lm-tmdb-card', 'data-variant': 'poster', 'data-tmdb': `${item.type}:${item.id}` },
    h('a', { class: 'lm-card__link', href: tmdbHref(item), 'aria-label': `${item.title}, ${facts.join(', ')}${ratingText(item) ? `, rated ${ratingText(item)} out of 10` : ''}` },
      h('div', { class: 'lm-card__art' },
        artImg({ src: item.poster?.src, srcset: item.poster?.srcset, sizes: POSTER_SIZES, title: item.title, kind: 'poster' }),
        h('div', { class: 'lm-card__badges' }, ratingBadge(item)))),
    h('div', { class: 'lm-card__caption' },
      h('span', { class: 'lm-card__title' }, item.title),
      h('span', { class: 'lm-card__sub' }, facts.join(' · '))));
}

/** A lazily rendered horizontal row of TMDB cards. */
export function tmdbRow({ id, title, subtitle, href, items }) {
  return carousel({ id, title, subtitle, href, items, render: tmdbCard });
}

/** The credit TMDB's terms require wherever its data appears. */
export function tmdbCredit({ compact = false } = {}) {
  const logo = h('img', { class: 'lm-tmdb-credit__logo', src: TMDB_LOGO, alt: 'TMDB', width: 92, height: 12, loading: 'lazy', decoding: 'async' });
  logo.addEventListener('error', () => logo.replaceWith(h('span', { class: 'lm-tmdb-credit__name' }, 'TMDB')), { once: true });
  return h('aside', { class: ['lm-tmdb-credit', compact && 'lm-tmdb-credit--compact'], 'aria-label': 'Data source' },
    h('a', { class: 'lm-tmdb-credit__mark', href: TMDB_URL, target: '_blank', rel: 'noopener noreferrer', 'aria-label': 'The Movie Database (TMDB), opens in a new tab' }, logo),
    h('p', null, 'Film and TV data, posters and images from ', h('a', { class: 'lm-link', href: TMDB_URL, target: '_blank', rel: 'noopener noreferrer' }, 'The Movie Database (TMDB)'), '. ', TMDB_NOTICE));
}

/**
 * The right panel for a failed TMDB request: Preview mode, not configured, rate-limited, or a
 * generic error with "Try again". Never a blank page.
 */
export function tmdbError(err, { retry } = {}) {
  if (err?.code === 'SERVER_REQUIRED') return serverRequired('The TMDB catalogue');
  if (err?.code === 'TMDB_NOT_CONFIGURED') {
    return emptyState({
      title: 'The TMDB catalogue is not set up yet',
      message: 'An administrator needs to add a TMDB API key to the server (TMDB_API_KEY in .env) and restart Lumina. Lumina’s own catalogue is still available.',
      actions: [h('a', { class: 'lm-btn lm-btn--primary', href: '#/' }, h('span', null, 'Browse Lumina'))],
    });
  }
  if (err?.code === 'NOT_FOUND' || err?.status === 404) {
    return emptyState({ title: 'Title not found', message: 'TMDB has no entry at this address. It may have been removed.', actions: [h('a', { class: 'lm-btn lm-btn--primary', href: '#/explore' }, h('span', null, 'Back to Explore'))] });
  }
  if (err?.code === 'TMDB_BUSY' || err?.code === 'RATE_LIMITED') {
    return errorState({ message: 'TMDB is busy right now. Wait a few seconds and try again.' }, { retry });
  }
  if (err?.code === 'TMDB_UNAVAILABLE' || err?.code === 'TMDB_AUTH_FAILED' || err?.code === 'NETWORK') {
    return errorState({ message: 'We couldn’t reach The Movie Database just now. Lumina’s own catalogue is unaffected.' }, { retry });
  }
  return errorState(err, { retry });
}

/**
 * A grid that loads TMDB pages as the visitor scrolls (with a "Load more" button for keyboard
 * users and as a fallback). `fetchPage(page)` resolves to { page, totalPages, totalResults, items }.
 * Only one page is in flight at a time, duplicates across pages are dropped, and a failed page
 * can be retried without losing what is already shown.
 */
export function infiniteGrid({ fetchPage, empty, signal, noun = ['title', 'titles'] }) {
  const el = h('div', { class: 'lm-disc-results lm-tmdb-results' });
  let seq = 0;

  async function start() {
    const my = ++seq;
    el.setAttribute('aria-busy', 'true');
    el.replaceChildren(loading(`Loading ${noun[1]}…`));
    let first;
    try {
      first = await fetchPage(1);
    } catch (err) {
      if (my !== seq || err?.name === 'AbortError' || signal?.aborted) return;
      el.removeAttribute('aria-busy');
      el.replaceChildren(tmdbError(err, { retry: start }));
      return;
    }
    if (my !== seq) return;
    el.removeAttribute('aria-busy');
    if (!first.items.length) {
      el.replaceChildren(empty ? empty() : emptyState({ title: `No ${noun[1]} found` }));
      announce(`No ${noun[1]} found`);
      return;
    }

    const seen = new Set();
    const grid = h('ul', { class: 'lm-grid', role: 'list', id: newUid('tmdb-grid') });
    const status = h('p', { class: 'lm-disc-count', role: 'status' });
    const more = button('Load more', { variant: 'glass', icon: 'chevronDown' });
    const sentinel = h('div', { class: 'lm-tmdb-sentinel', 'aria-hidden': 'true' });
    const footer = h('div', { class: 'lm-disc-more' }, status, more);
    let page = 0;
    let totalPages = 1;
    let totalResults = 0;
    let busy = false;
    let failed = false;

    const add = (data) => {
      page = data.page || page + 1;
      totalPages = data.totalPages || page;
      totalResults = data.totalResults || totalResults;
      const nodes = [];
      for (const item of data.items) {
        const key = `${item.type}:${item.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push(h('li', null, tmdbCard(item)));
      }
      grid.append(...nodes);
      const done = page >= totalPages;
      status.textContent = done
        ? `Showing all ${plural(seen.size, noun[0], noun[1])}`
        : `Showing ${seen.size.toLocaleString()} of ${plural(totalResults, noun[0], noun[1]).replace(/^\d+/, (n) => Number(n).toLocaleString())}`;
      more.hidden = done;
      if (done) io.disconnect();
      return nodes;
    };

    async function next({ focus = false } = {}) {
      if (busy || page >= totalPages || my !== seq || signal?.aborted) return;
      busy = true;
      more.disabled = true;
      more.classList.add('is-busy');
      try {
        const data = await fetchPage(page + 1);
        if (my !== seq) return;
        failed = false;
        const nodes = add(data);
        if (focus) nodes[0]?.querySelector('.lm-card__link')?.focus();
        announce(status.textContent);
      } catch (err) {
        if (my !== seq || err?.name === 'AbortError' || signal?.aborted) return;
        // Stop auto-loading until the visitor asks again, so a TMDB outage is not hammered.
        failed = true;
        status.textContent = `${err?.code === 'TMDB_BUSY' || err?.code === 'RATE_LIMITED' ? 'TMDB is busy right now.' : 'We couldn’t load more titles.'} Choose “Load more” to try again.`;
        announce(status.textContent);
      } finally {
        busy = false;
        more.disabled = false;
        more.classList.remove('is-busy');
      }
    }

    const io = new IntersectionObserver((entries) => {
      if (!failed && entries.some((e) => e.isIntersecting)) next();
    }, { rootMargin: '900px 0px' });
    more.addEventListener('click', () => {
      failed = false;
      next({ focus: true });
    });
    signal?.addEventListener('abort', () => io.disconnect(), { once: true });

    add(first);
    el.replaceChildren(grid, sentinel, footer);
    announce(status.textContent);
    if (page < totalPages) io.observe(sentinel);
  }

  start();
  return { el, reload: start };
}

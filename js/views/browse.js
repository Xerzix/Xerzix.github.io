// Browse pages: Movies (/movies), TV Shows (/tv), New Releases (/new) and Trending (/trending).
import { h, announce, newUid } from '../core/dom.js';
import { api } from '../api/client.js';
import { plural } from '../core/format.js';
import { cardGrid, carousel } from '../ui/carousel.js';
import { titleCard } from '../ui/card.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, errorState, linkButton, loading, sectionHead, segmented } from '../ui/components.js';

const PAGE_SIZE = 24;

const SORTS = [
  { value: 'newest', label: 'Newest' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Member rating' },
  { value: 'added', label: 'Recently added' },
  { value: 'runtime', label: 'Runtime' },
];

/** Keeps the address bar in sync without re-rendering the view (the router re-renders on navigate). */
function syncUrl(path) {
  const target = `#${path}`;
  if (location.hash !== target) history.replaceState({ ...(history.state || {}) }, '', target);
}

function pageHead({ eyebrow, title, subtitle, actions }) {
  return h('header', { class: 'lm-page-header lm-disc-head' },
    h('div', null,
      eyebrow ? h('p', { class: 'lm-eyebrow' }, eyebrow) : null,
      h('h1', { class: 'lm-h1' }, title),
      subtitle ? h('p', { class: 'lm-disc-head__sub' }, subtitle) : null),
    actions ? h('div', { class: 'lm-cluster' }, actions) : null);
}

/** A labelled native <select> for sorting. */
export function sortSelect({ options, value, onChange, label = 'Sort by' }) {
  const id = newUid('sort');
  const select = h('select', { class: 'lm-select lm-select--compact', id }, ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  select.addEventListener('change', () => onChange(select.value));
  return h('div', { class: 'lm-disc-sort' }, h('label', { class: 'lm-disc-sort__label', for: id }, icon('sort'), h('span', null, label)), select);
}

/**
 * A paged grid of titles fetched with `fetchPage(page)` → { items, total }.
 * Returns { el, reload(fetchPage) }. Handles loading, empty, error and "Load more".
 */
export function pagedGrid({ fetchPage, empty, noun = ['title', 'titles'] }) {
  const label = noun[1];
  const el = h('div', { class: 'lm-disc-results', 'aria-live': 'off' });
  let seq = 0;
  let fetcher = fetchPage;

  async function load() {
    const my = ++seq;
    el.setAttribute('aria-busy', 'true');
    el.replaceChildren(loading(`Loading ${label}…`));
    let page = 1;
    try {
      const first = await fetcher(page);
      if (my !== seq) return;
      el.removeAttribute('aria-busy');
      if (!first.items.length) {
        el.replaceChildren(empty());
        announce(`No ${label} found`);
        return;
      }
      const grid = cardGrid(first.items.map((t) => ({ title: t })));
      let shown = first.items.length;
      const status = h('p', { class: 'lm-disc-count' });
      const more = button('Load more', { variant: 'glass', icon: 'chevronDown' });
      const footer = h('div', { class: 'lm-disc-more' }, status, more);
      const update = (total) => {
        status.textContent = `Showing ${shown} of ${plural(total, noun[0], noun[1])}`;
        more.hidden = shown >= total;
        footer.hidden = shown >= total && total <= PAGE_SIZE;
      };
      update(first.total);
      more.addEventListener('click', async () => {
        more.classList.add('is-busy');
        more.disabled = true;
        try {
          // The page counter only advances once the page has arrived, so a failed request is
          // retried on the next click instead of being skipped.
          const next = await fetcher(page + 1);
          if (my !== seq) return;
          page += 1;
          const nodes = next.items.map((t) => h('li', null, titleCard(t)));
          grid.append(...nodes);
          shown += next.items.length;
          update(next.total);
          nodes[0]?.querySelector('.lm-card__link')?.focus({ preventScroll: false });
          announce(status.textContent);
        } catch (err) {
          if (my !== seq) return;
          status.textContent = `${err.message || 'Something went wrong.'} Choose “Load more” to try again.`;
          announce(status.textContent);
        } finally {
          more.classList.remove('is-busy');
          more.disabled = false;
        }
      });
      el.replaceChildren(grid, footer);
      announce(status.textContent);
    } catch (err) {
      if (my !== seq || err.name === 'AbortError') return;
      el.removeAttribute('aria-busy');
      el.replaceChildren(errorState(err, { retry: load }));
    }
  }

  return {
    el,
    reload(nextFetch) {
      if (nextFetch) fetcher = nextFetch;
      return load();
    },
  };
}

/** Horizontal, scrollable chip group. `multi` = toggle each chip; otherwise single-select with an "All" chip. */
export function chipGroup({ label, options, selected = [], multi = false, allLabel = 'All', onChange }) {
  let current = new Set(selected);
  const group = h('div', { class: 'lm-chip-scroll', role: 'group', 'aria-label': label });
  const paint = () => {
    for (const b of group.querySelectorAll('button[data-value]')) {
      const v = b.dataset.value;
      b.setAttribute('aria-pressed', String(v === '' ? current.size === 0 : current.has(v)));
    }
  };
  const chip = (value, text, count) => h('button', {
    type: 'button',
    class: 'lm-chip',
    'data-value': value,
    onClick: () => {
      if (value === '') current = new Set();
      else if (multi) {
        if (current.has(value)) current.delete(value);
        else current.add(value);
      } else current = current.has(value) ? new Set() : new Set([value]);
      paint();
      onChange([...current]);
    },
  }, text, count !== undefined ? h('span', { class: 'lm-chip__count' }, String(count)) : null);
  if (!multi) group.append(chip('', allLabel));
  for (const o of options) group.append(chip(o.value, o.label, o.count));
  paint();
  group.set = (values) => {
    current = new Set(values);
    paint();
  };
  return group;
}

// ── Movies & TV Shows ─────────────────────────────────────
async function catalogBrowse(ctx, type) {
  const isTv = type === 'series';
  const name = isTv ? 'TV Shows' : 'Movies';
  const base = isTv ? '/tv' : '/movies';
  ctx.setTitle(name);
  let genre = ctx.query.get('genre') || '';
  let sort = SORTS.some((s) => s.value === ctx.query.get('sort')) ? ctx.query.get('sort') : 'newest';

  // Genre chips come from this type's own facets, so every chip leads somewhere.
  const facets = await api.catalog.titles({ type, pageSize: 1 });
  const genres = facets.facets?.genres || [];
  if (genre && !genres.some((g) => g.value === genre)) genre = '';

  const sub = h('p', { class: 'lm-disc-head__sub' });
  const setSub = (total) => {
    sub.textContent = total
      ? `${plural(total, isTv ? 'series' : 'film', isTv ? 'series' : 'films')}${genre ? ` in ${genre}` : ''} on Lumina.`
      : '';
  };

  const syncState = () => {
    const qs = new URLSearchParams();
    if (genre) qs.set('genre', genre);
    if (sort !== 'newest') qs.set('sort', sort);
    syncUrl(`${base}${qs.toString() ? `?${qs}` : ''}`);
  };

  const fetchPage = (page) => api.catalog.titles({ type, genres: genre || undefined, sort, page, pageSize: PAGE_SIZE }).then((r) => {
    setSub(r.total);
    return r;
  });

  const results = pagedGrid({
    fetchPage,
    noun: isTv ? ['series', 'series'] : ['film', 'films'],
    empty: () => emptyState({
      title: genre ? `No ${isTv ? 'series' : 'films'} in ${genre} yet` : `No ${name.toLowerCase()} yet`,
      message: genre ? 'Try another genre, or browse the whole catalog.' : 'Nothing has been published here yet. New titles appear as soon as they are licensed and published.',
      actions: genre ? [button('Show all genres', { variant: 'primary', onClick: () => { chips.set([]); genre = ''; syncState(); results.reload(); } })] : [linkButton('Browse genres', '#/genres', { variant: 'primary' })],
    }),
  });

  const chips = chipGroup({
    label: `Filter ${name.toLowerCase()} by genre`,
    options: genres.map((g) => ({ value: g.value, label: g.value, count: g.count })),
    selected: genre ? [genre] : [],
    onChange: (values) => {
      genre = values[0] || '';
      syncState();
      results.reload();
    },
  });

  const toolbar = h('div', { class: 'lm-disc-toolbar' },
    genres.length > 1 ? chips : h('span'),
    sortSelect({ options: SORTS, value: sort, onChange: (v) => { sort = v; syncState(); results.reload(); } }));

  const head = h('header', { class: 'lm-page-header lm-disc-head' },
    h('div', null, h('p', { class: 'lm-eyebrow' }, 'Browse'), h('h1', { class: 'lm-h1' }, name), sub),
    h('div', { class: 'lm-cluster' }, linkButton(isTv ? 'Movies' : 'TV Shows', isTv ? '#/movies' : '#/tv', { variant: 'ghost', size: 'sm', icon: isTv ? 'film' : 'tv' }), linkButton('Genres', '#/genres', { variant: 'ghost', size: 'sm', icon: 'grid' })));

  results.reload();
  return h('div', { class: 'lm-page lm-container lm-disc' }, head, toolbar, results.el);
}

// ── New Releases ──────────────────────────────────────────
async function newReleases(ctx) {
  ctx.setTitle('New Releases');
  let type = ['movie', 'series'].includes(ctx.query.get('type')) ? ctx.query.get('type') : '';
  const page = h('div', { class: 'lm-page lm-container lm-disc' });
  page.append(pageHead({ eyebrow: 'Browse', title: 'New Releases', subtitle: 'The newest films and series on Lumina, by release date.' }));

  // Recently added to Lumina — only titles actually added in the last 30 days.
  try {
    const recent = await api.catalog.titles({ sort: 'added', recent: 1, pageSize: 20 });
    if (recent.items.length) {
      const row = carousel({ id: 'recently-added', title: 'Recently added to Lumina', subtitle: 'Added to the catalog in the last 30 days', items: recent.items.map((t) => ({ title: t })) });
      row.classList.add('lm-disc-row');
      page.append(row);
    }
  } catch {
    /* the main grid below reports errors */
  }

  const results = pagedGrid({
    fetchPage: (p) => api.catalog.titles({ sort: 'newest', type: type || undefined, page: p, pageSize: PAGE_SIZE }),
    empty: () => emptyState({ title: 'Nothing released yet', message: 'New titles appear here as soon as they are published.', actions: [linkButton('Browse genres', '#/genres', { variant: 'primary' })] }),
  });
  const headingId = newUid('sec');
  page.append(h('section', { class: 'lm-disc-section', 'aria-labelledby': headingId },
    h('div', { class: 'lm-disc-toolbar' },
      sectionHead('Newest first', { id: headingId, subtitle: 'Sorted by original release date' }),
      segmented({
        label: 'Type',
        value: type,
        options: [{ value: '', label: 'All' }, { value: 'movie', label: 'Movies' }, { value: 'series', label: 'Series' }],
        onChange: (v) => {
          type = v;
          syncUrl(`/new${type ? `?type=${type}` : ''}`);
          results.reload();
        },
      })),
    results.el));
  results.reload();
  return page;
}

// ── Trending ──────────────────────────────────────────────
function rankedGrid(items) {
  return h('ol', { class: 'lm-rank-grid' }, ...items.slice(0, 10).map((item, i) => h('li', { class: 'lm-rank' },
    h('span', { class: 'lm-rank__n', 'aria-hidden': 'true' }, String(i + 1)),
    h('div', { class: 'lm-rank__card' }, titleCard(item.title, item)))));
}

async function trending(ctx) {
  ctx.setTitle('Trending');
  const home = await api.catalog.home();
  const rows = new Map(home.rows.map((r) => [r.id, r]));
  const page = h('div', { class: 'lm-page lm-container lm-disc' },
    pageHead({ eyebrow: 'On Lumina now', title: 'Trending', subtitle: 'What Lumina members are actually watching — distinct profiles over the last 14 days.' }));

  const sections = [['trending-movies', 'Trending movies'], ['trending-tv', 'Trending TV shows']].filter(([id]) => rows.get(id)?.items.length);
  if (sections.length) {
    for (const [id, title] of sections) {
      const headingId = newUid('sec');
      page.append(h('section', { class: 'lm-disc-section', 'aria-labelledby': headingId },
        sectionHead(title, { id: headingId, subtitle: 'Ranked by the number of profiles watching in the last 14 days' }),
        rankedGrid(rows.get(id).items)));
    }
    return page;
  }

  page.append(h('div', { class: 'lm-panel lm-disc-honest' },
    icon('flame', { size: 28 }),
    h('div', null,
      h('h2', { class: 'lm-h3' }, 'Not enough viewing activity yet'),
      h('p', { class: 'lm-muted' }, 'Trending reflects real viewing on Lumina over the last 14 days. A title appears here once at least two different profiles have watched it, and there is not enough activity yet to rank anything honestly.'),
      h('p', { class: 'lm-muted' }, 'In the meantime, here is what the Lumina team recommends.'))));

  let picks = rows.get('selects')?.items;
  if (!picks?.length) {
    const r = await api.catalog.titles({ sort: 'relevance', pageSize: 12 });
    picks = r.items.map((t) => ({ title: t }));
  }
  if (picks.length) {
    const headingId = newUid('sec');
    page.append(h('section', { class: 'lm-disc-section', 'aria-labelledby': headingId },
      sectionHead('Lumina Selects', { id: headingId, subtitle: 'Hand-picked by the Lumina team', href: '#/discover' }),
      cardGrid(picks)));
  }
  return page;
}

export default async function render(ctx) {
  switch (ctx.path.replace(/\/+$/, '')) {
    case '/tv': return catalogBrowse(ctx, 'series');
    case '/new': return newReleases(ctx);
    case '/trending': return trending(ctx);
    default: return catalogBrowse(ctx, 'movie');
  }
}

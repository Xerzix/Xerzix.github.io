// Explore: the live TMDB catalogue. The hub (/explore) shows trending and popular rows; list
// pages (/explore/trending, /explore/movies, /explore/tv, /explore/top-movies, /explore/top-tv),
// genres (/explore/genres, /explore/genre/:type/:genre) and search (/explore/search) page
// through TMDB as the visitor scrolls. Title pages live in tmdb-title.js.
import { h, debounce, newUid } from '../core/dom.js';
import { api } from '../api/client.js';
import { session } from '../core/session.js';
import { icon } from '../ui/icons.js';
import { emptyState, loading, segmented } from '../ui/components.js';
import { infiniteGrid, tmdbCredit, tmdbError, tmdbRow } from '../ui/tmdb.js';

const enc = encodeURIComponent;

function syncUrl(path) {
  const target = `#${path}`;
  if (location.hash !== target) history.replaceState({ ...(history.state || {}) }, '', target);
}

function head({ eyebrow = 'Explore', title, subtitle, extra }) {
  return h('header', { class: 'lm-page-header lm-disc-head lm-tmdb-head' },
    h('div', null,
      h('p', { class: 'lm-eyebrow' }, eyebrow),
      h('h1', { class: 'lm-h1' }, title),
      subtitle ? h('p', { class: 'lm-disc-head__sub' }, subtitle) : null),
    extra ? h('div', { class: 'lm-cluster' }, extra) : null);
}

const NAV_LINKS = [
  ['Trending', '#/explore/trending', 'flame'],
  ['Popular films', '#/explore/movies', 'film'],
  ['Popular series', '#/explore/tv', 'tv'],
  ['Top rated films', '#/explore/top-movies', 'star'],
  ['Top rated series', '#/explore/top-tv', 'star'],
  ['Genres', '#/explore/genres', 'grid'],
];

function quickLinks(current) {
  return h('nav', { class: 'lm-chip-scroll lm-tmdb-links', 'aria-label': 'Explore sections' },
    ...NAV_LINKS.map(([label, href, ico]) => h('a', { class: 'lm-chip', href, 'aria-current': href === current ? 'page' : undefined }, icon(ico, { size: 14 }), label)));
}

/** Search form shared by the hub and the search page. `onSearch(q)` handles submit / live typing. */
function searchBox({ value = '', onSearch, autofocus = false }) {
  const id = newUid('tmdbq');
  const input = h('input', {
    id, class: 'lm-srch__input', type: 'search', value, placeholder: 'Search films and series on TMDB…',
    autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', maxlength: 100,
  });
  const form = h('form', { class: 'lm-srch__box lm-tmdb-search', role: 'search' },
    h('label', { class: 'visually-hidden', for: id }, 'Search films and series on TMDB'),
    icon('search', { className: 'lm-srch__icon' }),
    input);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSearch(input.value.trim(), { submit: true });
  });
  form.input = input;
  if (autofocus) setTimeout(() => { if (document.contains(input)) input.focus({ preventScroll: true }); }, 80);
  return form;
}

/** In Preview mode or with no TMDB credential, show one clear panel instead of the page. */
async function gate(ctx) {
  const status = await api.tmdb.status().catch(() => ({ configured: false }));
  if (status.preview || !session.isServer) return tmdbError({ code: 'SERVER_REQUIRED' });
  if (!status.configured) {
    return h('div', { class: 'lm-page lm-container' }, h('h1', { class: 'visually-hidden' }, 'Explore'), tmdbError({ code: 'TMDB_NOT_CONFIGURED' }));
  }
  ctx.tmdbReady = true;
  return null;
}

// ── Hub ──────────────────────────────────────────────────
async function hub(ctx) {
  ctx.setTitle('Explore');
  const opts = { signal: ctx.signal };
  const rows = h('div', { class: 'lm-tmdb-rows' });
  // Rows run edge to edge like the home page's, so they sit outside the text container.
  const page = h('div', { class: 'lm-page lm-tmdb lm-tmdb-hub' },
    h('div', { class: 'lm-container lm-disc' },
      head({ title: 'Explore the wider garden', subtitle: 'Search and browse hundreds of thousands of films and series from The Movie Database. Explore is for discovery: what you can stream lives in Lumina’s own catalogue.' }),
      searchBox({ onSearch: (q) => q && ctx.navigate(`/explore/search?q=${enc(q)}`) }),
      quickLinks('#/explore')),
    rows,
    h('div', { class: 'lm-container' }, tmdbCredit()));

  const defs = [
    { id: 'tmdb-trending', title: 'Trending this week', href: '#/explore/trending', load: () => api.tmdb.trending({ type: 'all', window: 'week' }, opts) },
    { id: 'tmdb-popular-movies', title: 'Popular films', href: '#/explore/movies', load: () => api.tmdb.popular('movie', {}, opts) },
    { id: 'tmdb-popular-tv', title: 'Popular series', href: '#/explore/tv', load: () => api.tmdb.popular('tv', {}, opts) },
    { id: 'tmdb-top-movies', title: 'Top rated films', href: '#/explore/top-movies', load: () => api.tmdb.topRated('movie', {}, opts) },
    { id: 'tmdb-top-tv', title: 'Top rated series', href: '#/explore/top-tv', load: () => api.tmdb.topRated('tv', {}, opts) },
  ];
  const fill = async () => {
    rows.setAttribute('aria-busy', 'true');
    const results = await Promise.allSettled(defs.map((d) => d.load()));
    if (ctx.signal.aborted) return;
    rows.removeAttribute('aria-busy');
    const ok = results.map((r, i) => (r.status === 'fulfilled' && r.value.items.length ? tmdbRow({ ...defs[i], items: r.value.items }) : null)).filter(Boolean);
    if (!ok.length) {
      const err = results.find((r) => r.status === 'rejected')?.reason;
      rows.replaceChildren(h('div', { class: 'lm-container' }, tmdbError(err || { message: 'TMDB returned no titles.' }, { retry: fill })));
      return;
    }
    rows.replaceChildren(...ok);
  };
  rows.append(h('div', { class: 'lm-container' }, loading('Loading TMDB…')));
  fill();
  return page;
}

// ── Lists ────────────────────────────────────────────────
const LISTS = {
  trending: { title: 'Trending', subtitle: 'What people are watching and talking about, refreshed by TMDB every day.', typed: true },
  movies: { title: 'Popular films', subtitle: 'The most popular films on TMDB right now.', load: (page, o) => api.tmdb.popular('movie', { page }, o), noun: ['film', 'films'] },
  tv: { title: 'Popular series', subtitle: 'The most popular series on TMDB right now.', load: (page, o) => api.tmdb.popular('tv', { page }, o), noun: ['series', 'series'] },
  'top-movies': { title: 'Top rated films', subtitle: 'Films with the highest TMDB member scores.', load: (page, o) => api.tmdb.topRated('movie', { page }, o), noun: ['film', 'films'] },
  'top-tv': { title: 'Top rated series', subtitle: 'Series with the highest TMDB member scores.', load: (page, o) => api.tmdb.topRated('tv', { page }, o), noun: ['series', 'series'] },
};

function listPage(ctx, key) {
  const def = LISTS[key];
  ctx.setTitle(def.title);
  const o = { signal: ctx.signal };
  let extra = null;
  let grid;
  if (def.typed) {
    const types = [{ value: 'all', label: 'All' }, { value: 'movie', label: 'Films' }, { value: 'tv', label: 'Series' }];
    let type = types.some((t) => t.value === ctx.query.get('type')) ? ctx.query.get('type') : 'all';
    const load = () => infiniteGrid({ signal: ctx.signal, fetchPage: (page) => api.tmdb.trending({ type, window: 'week', page }, o) });
    extra = segmented({
      label: 'Show',
      options: types,
      value: type,
      onChange: (v) => {
        type = v;
        syncUrl(`/explore/trending${type === 'all' ? '' : `?type=${type}`}`);
        const next = load();
        grid.el.replaceWith(next.el);
        grid = next;
      },
    });
    grid = load();
  } else {
    grid = infiniteGrid({ signal: ctx.signal, noun: def.noun, fetchPage: (page) => def.load(page, o) });
  }
  return h('div', { class: 'lm-page lm-container lm-disc lm-tmdb' },
    head({ title: def.title, subtitle: def.subtitle, extra }),
    quickLinks(`#/explore/${key}`),
    grid.el,
    tmdbCredit({ compact: true }));
}

// ── Genres ───────────────────────────────────────────────
async function genreIndex(ctx) {
  ctx.setTitle('Explore genres');
  let genres;
  try {
    genres = await api.tmdb.genres({ signal: ctx.signal });
  } catch (err) {
    return h('div', { class: 'lm-page lm-container' }, h('h1', { class: 'visually-hidden' }, 'Genres'), tmdbError(err, { retry: () => ctx.navigate('/explore/genres', { replace: true }) }));
  }
  const group = (heading, type, list) => h('section', { class: 'lm-tmdb-genres', 'aria-label': heading },
    h('h2', { class: 'lm-h3' }, heading),
    h('ul', { class: 'lm-tmdb-genres__list', role: 'list' },
      ...list.map((g) => h('li', null, h('a', { class: 'lm-chip', href: `#/explore/genre/${type}/${g.id}` }, g.name)))));
  return h('div', { class: 'lm-page lm-container lm-disc lm-tmdb' },
    head({ title: 'Genres', subtitle: 'Every TMDB genre, for films and for series.' }),
    quickLinks('#/explore/genres'),
    group('Film genres', 'movie', genres.movie || []),
    group('Series genres', 'tv', genres.tv || []),
    tmdbCredit({ compact: true }));
}

const GENRE_SORTS = [
  { value: 'popular', label: 'Popular' },
  { value: 'rating', label: 'Highest rated' },
  { value: 'newest', label: 'Newest' },
];

async function genrePage(ctx, type, genreId) {
  if (!['movie', 'tv'].includes(type) || !/^\d+$/.test(genreId)) return tmdbError({ code: 'NOT_FOUND' });
  let name = 'Genre';
  try {
    const all = await api.tmdb.genres({ signal: ctx.signal });
    name = (all[type] || []).find((g) => String(g.id) === genreId)?.name || name;
  } catch {
    /* the grid below reports the error */
  }
  const kind = type === 'tv' ? 'series' : 'films';
  ctx.setTitle(`${name} ${kind}`);
  let sort = GENRE_SORTS.some((s) => s.value === ctx.query.get('sort')) ? ctx.query.get('sort') : 'popular';
  const load = () => infiniteGrid({
    signal: ctx.signal,
    noun: type === 'tv' ? ['series', 'series'] : ['film', 'films'],
    fetchPage: (page) => api.tmdb.discover(type, { genre: genreId, sort, page }, { signal: ctx.signal }),
    empty: () => emptyState({ title: `No ${name.toLowerCase()} ${kind} found`, actions: [h('a', { class: 'lm-btn lm-btn--primary', href: '#/explore/genres' }, h('span', null, 'All genres'))] }),
  });
  let grid = load();
  const sorter = segmented({
    label: 'Sort by',
    options: GENRE_SORTS,
    value: sort,
    onChange: (v) => {
      sort = v;
      syncUrl(`/explore/genre/${type}/${genreId}${sort === 'popular' ? '' : `?sort=${sort}`}`);
      const next = load();
      grid.el.replaceWith(next.el);
      grid = next;
    },
  });
  return h('div', { class: 'lm-page lm-container lm-disc lm-tmdb' },
    head({ eyebrow: type === 'tv' ? 'Series genre' : 'Film genre', title: name, subtitle: `${name} ${kind} on TMDB.`, extra: sorter }),
    quickLinks('#/explore/genres'),
    grid.el,
    tmdbCredit({ compact: true }));
}

// ── Search ───────────────────────────────────────────────
const SEARCH_TYPES = [{ value: 'multi', label: 'All' }, { value: 'movie', label: 'Films' }, { value: 'tv', label: 'Series' }];

function searchPage(ctx) {
  ctx.setTitle('Search TMDB');
  let q = (ctx.query.get('q') || '').slice(0, 100);
  let type = SEARCH_TYPES.some((t) => t.value === ctx.query.get('type')) ? ctx.query.get('type') : 'multi';
  const slot = h('div', { class: 'lm-tmdb-search-results' });
  let grid = null;

  const run = () => {
    const qs = new URLSearchParams();
    if (q) qs.set('q', q);
    if (type !== 'multi') qs.set('type', type);
    syncUrl(`/explore/search${qs.toString() ? `?${qs}` : ''}`);
    if (!q) {
      grid = null;
      slot.replaceChildren(emptyState({ title: 'Search the TMDB catalogue', message: 'Type a film or series title. Results load as you scroll.', art: 'lantern' }));
      return;
    }
    grid = infiniteGrid({
      signal: ctx.signal,
      noun: ['result', 'results'],
      fetchPage: (page) => api.tmdb.search({ q, type, page }, { signal: ctx.signal }),
      empty: () => emptyState({ title: `Nothing on TMDB matches “${q}”`, message: 'Check the spelling, or try the original title.' }),
    });
    slot.replaceChildren(grid.el);
  };
  const live = debounce(() => run(), 450);
  const form = searchBox({
    value: q,
    autofocus: !q,
    onSearch: (value) => {
      q = value;
      live.cancel?.();
      run();
    },
  });
  form.input.addEventListener('input', () => {
    const value = form.input.value.trim();
    if (value === q || (value && value.length < 2)) return;
    q = value;
    live();
  });
  ctx.onDestroy(() => live.cancel?.());
  const types = segmented({
    label: 'Search in',
    options: SEARCH_TYPES,
    value: type,
    onChange: (v) => {
      type = v;
      run();
    },
  });
  run();
  return h('div', { class: 'lm-page lm-container lm-disc lm-tmdb' },
    head({ title: 'Search TMDB', subtitle: 'Live results from The Movie Database.', extra: types }),
    form,
    quickLinks(''),
    slot,
    tmdbCredit({ compact: true }));
}

export default async function render(ctx) {
  const blocked = await gate(ctx);
  if (blocked) return blocked;
  const path = ctx.path.replace(/\/$/, '');
  if (path === '/explore') return hub(ctx);
  if (path === '/explore/search') return searchPage(ctx);
  if (path === '/explore/genres') return genreIndex(ctx);
  if (ctx.params.genre) return genrePage(ctx, ctx.params.type, ctx.params.genre);
  if (LISTS[ctx.params.list]) return listPage(ctx, ctx.params.list);
  return h('div', { class: 'lm-page lm-container' }, h('h1', { class: 'visually-hidden' }, 'Not found'), tmdbError({ code: 'NOT_FOUND' }));
}

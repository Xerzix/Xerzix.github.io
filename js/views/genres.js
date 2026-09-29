// Genres: an index of genre tiles (/genres) and a single genre's titles (/genres/:genre).
import { h } from '../core/dom.js';
import { api } from '../api/client.js';
import { bus } from '../core/bus.js';
import { session } from '../core/session.js';
import { plural } from '../core/format.js';
import { navigate } from '../core/router.js';
import { button, emptyState, linkButton, segmented, toast, toastError } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { pagedGrid, sortSelect } from './browse.js';

/** The router applies the route's generic title after render; re-apply the specific one. */
function setPageTitle(ctx, title) {
  ctx.setTitle(title);
  const off = bus.on('route:changed', ({ path }) => {
    off();
    if (path === ctx.path && !ctx.signal?.aborted) ctx.setTitle(title);
  });
}

const SORTS = [
  { value: 'relevance', label: 'Featured' },
  { value: 'newest', label: 'Newest' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Member rating' },
  { value: 'added', label: 'Recently added' },
  { value: 'runtime', label: 'Runtime' },
];

function syncUrl(path) {
  const target = `#${path}`;
  if (location.hash !== target) history.replaceState({ ...(history.state || {}) }, '', target);
}

const genreHref = (name) => `#/genres/${encodeURIComponent(name)}`;

// ── Index ─────────────────────────────────────────────────
function genreTile(g, titles) {
  const tint = titles.find((t) => t.palette?.length)?.palette?.[0];
  const posters = titles.filter((t) => t.poster).slice(0, 3);
  return h('li', null, h('a', {
    class: 'lm-genre-tile',
    href: genreHref(g.name),
    style: tint ? { '--tile-tint': tint } : undefined,
    'aria-label': `${g.name}, ${plural(g.count, 'title')}`,
  },
  h('div', { class: 'lm-genre-tile__art', 'aria-hidden': 'true', 'data-count': String(posters.length) },
    ...posters.map((t) => h('img', { src: t.poster, alt: '', loading: 'lazy', decoding: 'async', onError: (e) => e.currentTarget.remove() }))),
  h('div', { class: 'lm-genre-tile__text' },
    h('span', { class: 'lm-genre-tile__name' }, g.name),
    h('span', { class: 'lm-genre-tile__count' }, plural(g.count, 'title')))));
}

async function genreIndex(ctx) {
  ctx.setTitle('Genres');
  const [{ genres }, sample] = await Promise.all([api.catalog.genres(), api.catalog.titles({ sort: 'relevance', pageSize: 100 })]);
  const page = h('div', { class: 'lm-page lm-container lm-disc' },
    h('header', { class: 'lm-page-header lm-disc-head' },
      h('div', null,
        h('p', { class: 'lm-eyebrow' }, 'Browse'),
        h('h1', { class: 'lm-h1' }, 'Genres'),
        h('p', { class: 'lm-disc-head__sub' }, genres.length ? `${plural(genres.length, 'genre')} across the Lumina catalog.` : ''))));
  if (!genres.length) {
    page.append(emptyState({ title: 'No genres yet', message: 'Genres appear once titles are published to the catalog.', actions: [linkButton('Back to home', '#/', { variant: 'primary' })] }));
    return page;
  }
  // Posters for each tile: from the first page, topped up per genre when needed.
  const byGenre = new Map(genres.map((g) => [g.name, []]));
  for (const t of sample.items) for (const g of t.genres || []) byGenre.get(g)?.push(t);
  await Promise.all(genres.filter((g) => byGenre.get(g.name).length < Math.min(3, g.count)).map(async (g) => {
    try {
      const r = await api.catalog.titles({ genres: g.name, sort: 'relevance', pageSize: 3 });
      byGenre.set(g.name, r.items);
    } catch {
      /* the tile still works without art */
    }
  }));
  const sorted = [...genres].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  page.append(h('ul', { class: 'lm-genre-grid', role: 'list' }, ...sorted.map((g) => genreTile(g, byGenre.get(g.name)))));
  return page;
}

// ── Single genre ──────────────────────────────────────────
async function followButton(genre) {
  if (!session.isServer || !session.profile) return null;
  let following = false;
  try {
    const { items } = await api.follows.list();
    following = items.some((f) => f.type === 'genre' && f.id === genre);
  } catch {
    return null;
  }
  const b = button(following ? 'Following' : 'Follow genre', {
    variant: 'glass',
    size: 'sm',
    icon: following ? 'check' : 'bell',
    attrs: { 'aria-pressed': String(following), title: 'Get notified when new titles are added to this genre' },
  });
  b.addEventListener('click', async () => {
    b.disabled = true;
    try {
      if (following) await api.follows.unfollow('genre', genre);
      else await api.follows.follow('genre', genre);
      following = !following;
      b.setAttribute('aria-pressed', String(following));
      b.replaceChildren(icon(following ? 'check' : 'bell'), h('span', null, following ? 'Following' : 'Follow genre'));
      toast(following ? `You will hear about new ${genre} titles.` : `You unfollowed ${genre}.`, { type: 'success', timeout: 2600 });
    } catch (err) {
      toastError(err);
    } finally {
      b.disabled = false;
    }
  });
  return b;
}

async function genrePage(ctx, name) {
  const { genres } = await api.catalog.genres();
  const genre = genres.find((g) => g.name.toLowerCase() === name.toLowerCase());
  if (!genre) {
    setPageTitle(ctx, 'Genre not found');
    return h('div', { class: 'lm-page lm-container' },
      h('h1', { class: 'visually-hidden' }, 'Genre not found'),
      emptyState({
        title: `No “${name}” titles on Lumina`,
        message: 'That genre is not in the catalog, or nothing in it is available on this profile.',
        actions: [linkButton('All genres', '#/genres', { variant: 'primary', icon: 'grid' }), linkButton('Search', `#/search?q=${encodeURIComponent(name)}`, { variant: 'ghost', icon: 'search' })],
      }));
  }
  setPageTitle(ctx, genre.name);
  let type = ['movie', 'series'].includes(ctx.query.get('type')) ? ctx.query.get('type') : '';
  let sort = SORTS.some((s) => s.value === ctx.query.get('sort')) ? ctx.query.get('sort') : 'relevance';
  const sync = () => {
    const qs = new URLSearchParams();
    if (type) qs.set('type', type);
    if (sort !== 'relevance') qs.set('sort', sort);
    syncUrl(`/genres/${encodeURIComponent(genre.name)}${qs.toString() ? `?${qs}` : ''}`);
  };
  const results = pagedGrid({
    noun: ['title', 'titles'],
    fetchPage: (p) => api.catalog.titles({ genres: genre.name, type: type || undefined, sort, page: p, pageSize: 24 }),
    empty: () => emptyState({
      title: `No ${type === 'series' ? 'series' : 'films'} in ${genre.name}`,
      message: 'Try showing every type in this genre.',
      actions: [button('Show all types', { variant: 'primary', onClick: () => { type = ''; sync(); navigate(`/genres/${encodeURIComponent(genre.name)}`, { replace: true }); } })],
    }),
  });

  const follow = await followButton(genre.name).catch(() => null);
  const others = genres.filter((g) => g.name !== genre.name);
  const page = h('div', { class: 'lm-page lm-container lm-disc' },
    h('header', { class: 'lm-page-header lm-disc-head' },
      h('div', null,
        h('nav', { class: 'lm-crumbs', 'aria-label': 'Breadcrumb' }, h('a', { href: '#/genres' }, 'Genres'), h('span', { 'aria-hidden': 'true' }, '/'), h('span', { 'aria-current': 'page' }, genre.name)),
        h('h1', { class: 'lm-h1' }, genre.name),
        h('p', { class: 'lm-disc-head__sub' }, `${plural(genre.count, 'title')} on Lumina.`)),
      follow ? h('div', { class: 'lm-cluster' }, follow) : null),
    h('div', { class: 'lm-disc-toolbar' },
      segmented({
        label: 'Type',
        value: type,
        options: [{ value: '', label: 'All' }, { value: 'movie', label: 'Movies' }, { value: 'series', label: 'Series' }],
        onChange: (v) => { type = v; sync(); results.reload(); },
      }),
      sortSelect({ options: SORTS, value: sort, onChange: (v) => { sort = v; sync(); results.reload(); } })),
    results.el,
    others.length ? h('nav', { class: 'lm-disc-related', 'aria-label': 'Other genres' },
      h('h2', { class: 'lm-h3' }, 'Other genres'),
      h('div', { class: 'lm-cluster lm-cluster--sm' }, ...others.map((g) => h('a', { class: 'lm-chip', href: genreHref(g.name) }, g.name)))) : null);
  results.reload();
  return page;
}

export default async function render(ctx) {
  if (ctx.params.genre) return genrePage(ctx, ctx.params.genre);
  return genreIndex(ctx);
}


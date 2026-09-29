// Compare up to three titles side by side (/compare?ids=a,b,c), then ask Velvia about them.
import { h, announce } from '../core/dom.js';
import { api } from '../api/client.js';
import { date, languageName, plural, resolutionLabel, runtime } from '../core/format.js';
import { ratingLabel } from '../core/ratings.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, loading, notice, stars } from '../ui/components.js';
import { velviaCompare } from '../ui/panels/velvia-panel.js';
import { openTitlePicker } from './collection.js';

const MAX = 3;
const enc = encodeURIComponent;
const human = (s) => String(s).replace(/-/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

function syncUrl(ids) {
  const target = `#/compare${ids.length ? `?ids=${ids.map(enc).join(',')}` : ''}`;
  if (location.hash !== target) history.replaceState({ ...(history.state || {}) }, '', target);
}

const list = (items, empty = '—') => (items?.length ? h('ul', { class: 'lm-cmp__list' }, ...items.map((x) => h('li', null, x))) : h('span', { class: 'lm-muted' }, empty));

/** Attribute rows: [label, (title) => Node|string]. */
const ROWS = [
  ['Released', (t) => (t.releaseDate ? date(t.releaseDate, { year: 'numeric', month: 'short', day: 'numeric' }) : t.year ? String(t.year) : '—')],
  ['Type', (t) => (t.type === 'series' ? `Series · ${plural(t.seasonCount || 0, 'season')}, ${plural(t.episodeCount || 0, 'episode')}` : 'Film')],
  ['Runtime', (t) => (t.runtimeMin ? (t.type === 'series' ? `About ${runtime(t.runtimeMin)} per episode` : runtime(t.runtimeMin)) : '—')],
  ['Genres', (t) => list((t.genres || []).map((g) => h('a', { class: 'lm-link', href: `#/genres/${enc(g)}` }, g)))],
  ['Moods', (t) => list((t.moods || []).map(human))],
  ['Member rating', (t) => (t.memberRating?.count
    ? h('span', { class: 'lm-cluster lm-cluster--sm' }, stars(t.memberRating.average), h('span', null, `${t.memberRating.average} · ${plural(t.memberRating.count, 'rating')}`))
    : h('span', { class: 'lm-muted' }, 'Not yet rated'))],
  ['Directors', (t) => list(t.credits?.directors || t.directors || [])],
  ['Cast', (t) => list((t.credits?.cast || []).slice(0, 6).map((c) => (c.role ? h('span', null, c.name, h('span', { class: 'lm-muted' }, ` as ${c.role}`)) : c.name)))],
  ['Audio languages', (t) => list((t.audioLanguages || []).map((l) => languageName(l)), 'Not listed')],
  ['Subtitles', (t) => list((t.subtitleLanguages || []).map((l) => languageName(l)), 'None available')],
  ['Resolutions', (t) => (t.resolutions?.length ? list(t.resolutions.map(resolutionLabel)) : h('span', { class: 'lm-muted' }, 'Detected when playback starts'))],
  ['Age rating', (t) => h('span', null, h('span', { class: 'lm-badge lm-badge--solid' }, t.ageRating), ` ${ratingLabel(t.ageRating)}`, t.ratingSource === 'advisory' ? h('span', { class: 'lm-cmp__note' }, 'Advisory rating assigned by Lumina') : null)],
];

export default async function render(ctx) {
  ctx.setTitle('Compare');
  let ids = [...new Set((ctx.query.get('ids') || '').split(',').map((s) => s.trim()).filter(Boolean))].slice(0, MAX);
  const cache = new Map();
  const body = h('div', { class: 'lm-cmp__body' });
  const velviaSlot = h('div', { class: 'lm-cmp__velvia' });

  const fetchTitle = async (id) => {
    if (!cache.has(id)) cache.set(id, api.catalog.title(id));
    return cache.get(id);
  };

  const choose = () => openTitlePicker({
    title: ids.length ? 'Add a title to compare' : 'Choose a title to compare',
    mode: 'single',
    isDisabled: (id) => ids.includes(id),
    hint: `Compare up to ${MAX} titles side by side.`,
    onPick: (t) => {
      ids = [...ids, t.id].slice(0, MAX);
      paint().then(() => {
        body.querySelector(`[data-col="${CSS.escape(t.id)}"] a`)?.focus();
        announce(`Added ${t.title} to the comparison`);
      });
    },
  });

  const removeId = (id, name) => {
    ids = ids.filter((x) => x !== id);
    paint().then(() => {
      (body.querySelector('[data-col] a') || body.querySelector('button'))?.focus();
      announce(`Removed ${name} from the comparison`);
    });
  };

  async function paint() {
    syncUrl(ids);
    if (!ids.length) {
      velviaSlot.replaceChildren();
      body.replaceChildren(emptyState({
        title: 'Pick titles to compare',
        message: `Put up to ${MAX} films or series side by side — runtime, genres, moods, cast, languages, subtitles, verified resolutions and ratings.`,
        actions: [button('Choose a title', { variant: 'primary', icon: 'plus', onClick: choose })],
      }));
      return;
    }
    body.replaceChildren(loading('Loading titles…'));
    const settled = await Promise.allSettled(ids.map(fetchTitle));
    const titles = [];
    const problems = [];
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') titles.push(r.value);
      else problems.push({ id: ids[i], err: r.reason });
    });
    if (problems.length) {
      ids = ids.filter((id) => !problems.some((p) => p.id === id));
      syncUrl(ids);
    }

    const canAdd = titles.length < MAX;
    const headRow = h('tr', null,
      h('td', { class: 'lm-cmp__corner' }),
      ...titles.map((t) => h('th', { scope: 'col', class: 'lm-cmp__head', 'data-col': t.id, style: t.palette?.[0] ? { '--card-tint': t.palette[0] } : undefined },
        h('a', { class: 'lm-cmp__poster', href: `#/title/${enc(t.id)}` },
          t.poster ? h('img', { src: t.poster, alt: '', loading: 'lazy', onError: (e) => e.currentTarget.remove() }) : null,
          h('span', { class: 'lm-cmp__title' }, t.title)),
        h('span', { class: 'lm-cmp__sub' }, [t.year, t.type === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · ')),
        button('Remove', { variant: 'ghost', size: 'sm', icon: 'close', ariaLabel: `Remove ${t.title} from the comparison`, onClick: () => removeId(t.id, t.title) }))),
      canAdd ? h('td', { class: 'lm-cmp__add' }, button('Add a title', { variant: 'glass', icon: 'plus', onClick: choose })) : null);

    const rows = ROWS.map(([label, fn]) => h('tr', null,
      h('th', { scope: 'row' }, label),
      ...titles.map((t) => h('td', null, fn(t))),
      canAdd ? h('td', { class: 'lm-cmp__empty-cell', 'aria-hidden': 'true' }) : null));

    // What every compared title has in common (only when comparing two or more).
    if (titles.length > 1) {
      const common = (key) => titles.map((t) => new Set(t[key] || [])).reduce((a, b) => new Set([...a].filter((x) => b.has(x))));
      const shared = [...common('genres'), ...[...common('moods')].map(human)];
      rows.unshift(h('tr', { class: 'lm-cmp__common' },
        h('th', { scope: 'row' }, 'In common'),
        h('td', { colspan: String(titles.length + (canAdd ? 1 : 0)) }, shared.length
          ? h('span', { class: 'lm-cluster lm-cluster--sm' }, ...shared.map((s) => h('span', { class: 'lm-chip lm-chip--static' }, s)))
          : h('span', { class: 'lm-muted' }, 'No genres or moods in common'))));
    }

    const names = titles.map((t) => t.title);
    body.replaceChildren(...[
      problems.length ? notice(`${plural(problems.length, 'title')} could not be loaded and ${problems.length === 1 ? 'was' : 'were'} left out: ${problems.map((p) => p.err?.code === 'PROFILE_RESTRICTED' ? 'outside this profile’s maturity setting' : p.err?.message || p.id).join('; ')}`, { type: 'warn' }) : null,
      h('div', { class: 'lm-cmp__scroll', tabindex: '0', role: 'region', 'aria-label': 'Comparison table (scrolls sideways on small screens)' },
        h('table', { class: 'lm-cmp__table', 'data-cols': String(titles.length + (canAdd ? 1 : 0)) },
          h('caption', { class: 'visually-hidden' }, `Comparison of ${names.join(', ')}`),
          h('thead', null, headRow),
          h('tbody', null, ...rows))),
    ].filter(Boolean));

    velviaSlot.replaceChildren();
    if (titles.length > 1) {
      try {
        const panel = velviaCompare({ titles });
        if (panel instanceof Node) velviaSlot.append(panel);
      } catch (err) {
        console.warn('Velvia compare panel failed to mount', err);
      }
    }
  }

  await paint();
  return h('div', { class: 'lm-page lm-container lm-cmp' },
    h('header', { class: 'lm-page-header lm-disc-head' },
      h('div', null,
        h('p', { class: 'lm-eyebrow' }, 'Side by side'),
        h('h1', { class: 'lm-h1' }, 'Compare titles'),
        h('p', { class: 'lm-disc-head__sub' }, 'Every value comes from the catalog record. Resolutions are listed only once they have been verified from the stream.')),
      h('div', { class: 'lm-cluster' }, h('a', { class: 'lm-btn lm-btn--ghost lm-btn--sm', href: '#/velvia' }, icon('sparkle'), h('span', null, 'Ask Velvia')))),
    body,
    velviaSlot);
}

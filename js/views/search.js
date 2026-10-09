// Full search: live results as you type, filters, sorting, active-filter chips, recent
// searches and honest empty states. The URL always reflects the current search.
import { h, announce, debounce, newUid } from '../core/dom.js';
import { api } from '../api/client.js';
import { session } from '../core/session.js';
import { store } from '../core/storage.js';
import { languageName, plural } from '../core/format.js';
import { parseSearchParams, toSearchParams } from '../core/search.js';
import { ratingLabel } from '../core/ratings.js';
import { rememberSearch } from '../ui/header.js';
import { cardGrid } from '../ui/carousel.js';
import { titleCard } from '../ui/card.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, errorState, linkButton, loading, segmented } from '../ui/components.js';
import { chipGroup, sortSelect } from './browse.js';

const PAGE_SIZE = 24;
const SORTS = [
  { value: 'relevance', label: 'Relevance' },
  { value: 'newest', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Title' },
  { value: 'rating', label: 'Member rating' },
];
const RUNTIMES = [{ value: '', label: 'Any length' }, { value: '30', label: 'Up to 30 minutes' }, { value: '60', label: 'Up to 1 hour' }, { value: '90', label: 'Up to 90 minutes' }, { value: '120', label: 'Up to 2 hours' }];
const RESOLUTIONS = [{ value: '', label: 'Any resolution' }, { value: '720', label: 'HD and above' }, { value: '2160', label: '4K only' }];
const RATINGS = [{ value: '', label: 'Any' }, { value: '3', label: '3+ stars' }, { value: '4', label: '4+ stars' }];

const recentKey = () => `recentSearches.${session.profile?.id || 'guest'}`;

function syncUrl(state) {
  const qs = new URLSearchParams(toSearchParams({ q: state.q, sort: state.sort || undefined, filters: state.filters })).toString();
  const target = `#/search${qs ? `?${qs}` : ''}`;
  if (location.hash !== target) history.replaceState({ ...(history.state || {}) }, '', target);
}

function selectField(label, options, value, onChange, { disabled, hint } = {}) {
  const id = newUid('sf');
  const select = h('select', { class: 'lm-select', id, disabled }, ...options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label)));
  select.addEventListener('change', () => onChange(select.value));
  return h('div', { class: 'lm-field' }, h('label', { class: 'lm-label', for: id }, label), select, hint ? h('span', { class: 'lm-hint' }, hint) : null);
}

function fieldset(legend, ...children) {
  return h('fieldset', { class: 'lm-srch__group' }, h('legend', { class: 'lm-label' }, legend), ...children);
}

export default async function render(ctx) {
  ctx.setTitle('Search');
  const parsed = parseSearchParams(ctx.query);
  const state = { q: parsed.q, sort: parsed.sort && parsed.sort !== 'relevance' ? parsed.sort : '', filters: { ...parsed.filters }, page: 1 };

  // Filter options come from the whole (visible) catalog so every choice can match something.
  const [genreRes, all] = await Promise.all([api.catalog.genres(), api.catalog.search({ pageSize: 1 })]);
  const facets = all.facets || {};
  const genres = genreRes.genres || [];
  const currentYear = new Date().getFullYear();

  // ── Search box ──
  const inputId = newUid('q');
  const input = h('input', {
    id: inputId, class: 'lm-srch__input', type: 'search', value: state.q, placeholder: 'Titles, people, genres, moods…',
    autocomplete: 'off', spellcheck: 'false', enterkeyhint: 'search', 'aria-describedby': `${inputId}-hint`,
  });
  const clearBtn = h('button', { type: 'button', class: 'lm-srch__clear', 'aria-label': 'Clear search', hidden: !state.q }, icon('close'));
  const box = h('div', { class: 'lm-srch__box' },
    h('label', { class: 'visually-hidden', for: inputId }, 'Search Lumina'),
    icon('search', { className: 'lm-srch__icon' }),
    input,
    clearBtn);

  // ── Toolbar: type, filters toggle, sort ──
  const panelId = newUid('filters');
  const filterCount = h('span', { class: 'lm-srch__count', hidden: true });
  const filtersBtn = h('button', { type: 'button', class: 'lm-btn lm-btn--glass lm-btn--sm', 'aria-expanded': 'false', 'aria-controls': panelId }, icon('sliders'), h('span', null, 'Filters'), filterCount);
  const typeSlot = h('div');
  const sortSlot = h('div');
  const panel = h('div', { class: 'lm-srch__panel lm-panel', id: panelId, hidden: true, role: 'region', 'aria-label': 'Search filters' });
  const chipsRow = h('div', { class: 'lm-srch__active', role: 'group', 'aria-label': 'Active filters' });
  const results = h('div', { class: 'lm-srch__results' });
  const status = h('p', { class: 'lm-srch__status', role: 'status' });

  const advancedCount = () => {
    const f = state.filters;
    return (f.genres?.length || 0) + (f.ageRatings?.length || 0) + ['yearFrom', 'yearTo', 'runtimeMax', 'language', 'subtitles', 'resolution', 'minRating', 'recentDays'].filter((k) => f[k] !== undefined && f[k] !== null && f[k] !== '').length;
  };
  const hasCriteria = () => !!state.q.trim() || !!state.filters.type || advancedCount() > 0;

  const setFilter = (key, value) => {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) delete state.filters[key];
    else state.filters[key] = value;
    state.page = 1;
    refresh();
  };

  function renderType() {
    typeSlot.replaceChildren(segmented({
      label: 'Type',
      value: state.filters.type || '',
      options: [{ value: '', label: 'All' }, { value: 'movie', label: 'Movies' }, { value: 'series', label: 'Series' }],
      onChange: (v) => setFilter('type', v),
    }));
  }

  function renderSort() {
    sortSlot.replaceChildren(sortSelect({ options: SORTS, value: state.sort || 'relevance', onChange: (v) => { state.sort = v === 'relevance' ? '' : v; state.page = 1; refresh(); } }));
  }

  function renderPanel() {
    const f = state.filters;
    const yearInput = (key, label) => {
      const id = newUid('yr');
      const el = h('input', { id, class: 'lm-input', type: 'number', inputmode: 'numeric', min: 1880, max: currentYear + 1, placeholder: label === 'From' ? 'Any' : String(currentYear), value: f[key] ?? '' });
      el.addEventListener('change', () => {
        const n = parseInt(el.value, 10);
        setFilter(key, Number.isFinite(n) && n >= 1880 && n <= currentYear + 1 ? n : undefined);
      });
      return h('div', { class: 'lm-field' }, h('label', { class: 'lm-label lm-label--sub', for: id }, label), el);
    };
    const recent = h('input', { type: 'checkbox', checked: !!f.recentDays });
    recent.addEventListener('change', () => setFilter('recentDays', recent.checked ? 30 : undefined));
    const langs = facets.languages || [];
    const subs = facets.subtitles || [];
    const ages = facets.ageRatings || [];
    panel.replaceChildren(
      h('div', { class: 'lm-srch__grid' },
        genres.length ? fieldset('Genres', chipGroup({ label: 'Genres', multi: true, options: genres.map((g) => ({ value: g.name, label: g.name })), selected: f.genres || [], onChange: (v) => setFilter('genres', v) })) : null,
        fieldset('Release year', h('div', { class: 'lm-srch__pair' }, yearInput('yearFrom', 'From'), yearInput('yearTo', 'To'))),
        selectField('Runtime', RUNTIMES, f.runtimeMax ? String(f.runtimeMax) : '', (v) => setFilter('runtimeMax', v ? Number(v) : undefined), { hint: 'For series, the typical episode length.' }),
        ages.length ? fieldset('Maturity rating', chipGroup({ label: 'Maturity ratings', multi: true, options: ages.map((a) => ({ value: a.value, label: a.value })), selected: f.ageRatings || [], onChange: (v) => setFilter('ageRatings', v) }), h('span', { class: 'lm-hint' }, 'Choose one or more ratings. Profile maturity limits always apply.')) : null,
        selectField('Original or audio language', [{ value: '', label: 'Any language' }, ...langs.map((l) => ({ value: l.value, label: languageName(l.value) }))], f.language, (v) => setFilter('language', v || undefined)),
        selectField('Subtitles', [{ value: '', label: subs.length ? 'Any' : 'No subtitled titles yet' }, ...subs.map((l) => ({ value: l.value, label: languageName(l.value) }))], f.subtitles, (v) => setFilter('subtitles', v || undefined), { disabled: !subs.length }),
        selectField('Resolution', RESOLUTIONS, f.resolution ?? '', (v) => setFilter('resolution', v ? Number(v) : undefined), { hint: 'Only verified stream resolutions count.' }),
        fieldset('Member rating', segmented({ label: 'Minimum member rating', value: f.minRating ? String(f.minRating) : '', options: RATINGS, onChange: (v) => setFilter('minRating', v ? Number(v) : undefined) })),
        fieldset('Availability', h('label', { class: 'lm-checkbox' }, recent, h('span', null, 'Added in the last 30 days')))),
      h('div', { class: 'lm-srch__panel-foot' }, button('Clear all filters', { variant: 'ghost', size: 'sm', icon: 'close', onClick: () => clearAll() }), button('Done', { variant: 'primary', size: 'sm', onClick: () => togglePanel(false, true) })));
  }

  function togglePanel(open = panel.hidden, focusBack = false) {
    panel.hidden = !open;
    filtersBtn.setAttribute('aria-expanded', String(open));
    if (open) panel.querySelector('button, input, select')?.focus();
    else if (focusBack) filtersBtn.focus();
  }
  filtersBtn.addEventListener('click', () => togglePanel());

  function clearAll() {
    state.filters = {};
    state.page = 1;
    renderType();
    renderPanel();
    refresh();
    announce('All filters cleared');
  }

  function renderChips() {
    const f = state.filters;
    const chips = [];
    const chip = (text, remove) => chips.push(h('button', { type: 'button', class: 'lm-chip lm-chip--removable', 'aria-label': `Remove filter: ${text}`, onClick: () => { remove(); state.page = 1; renderType(); renderPanel(); refresh(); } }, h('span', null, text), icon('close')));
    if (f.type) chip(f.type === 'movie' ? 'Movies' : 'Series', () => delete f.type);
    for (const g of f.genres || []) chip(g, () => { f.genres = f.genres.filter((x) => x !== g); if (!f.genres.length) delete f.genres; });
    if (f.yearFrom || f.yearTo) chip(f.yearFrom && f.yearTo ? `${f.yearFrom}–${f.yearTo}` : f.yearFrom ? `From ${f.yearFrom}` : `Until ${f.yearTo}`, () => { delete f.yearFrom; delete f.yearTo; });
    if (f.runtimeMax) chip(RUNTIMES.find((r) => r.value === String(f.runtimeMax))?.label || `Up to ${f.runtimeMax} minutes`, () => delete f.runtimeMax);
    for (const a of f.ageRatings || []) chip(`${a} · ${ratingLabel(a)}`, () => { f.ageRatings = f.ageRatings.filter((x) => x !== a); if (!f.ageRatings.length) delete f.ageRatings; });
    if (f.language) chip(`Language: ${languageName(f.language)}`, () => delete f.language);
    if (f.subtitles) chip(`Subtitles: ${languageName(f.subtitles)}`, () => delete f.subtitles);
    if (f.resolution) chip(f.resolution >= 2160 ? '4K only' : 'HD and above', () => delete f.resolution);
    if (f.minRating) chip(`${f.minRating}+ stars`, () => delete f.minRating);
    if (f.recentDays) chip('Added recently', () => delete f.recentDays);
    if (f.country) chip(`Country: ${f.country}`, () => delete f.country);
    if (f.tags?.length) for (const tag of f.tags) chip(tag.replace(/-/g, ' '), () => { f.tags = f.tags.filter((x) => x !== tag); if (!f.tags.length) delete f.tags; });
    if (chips.length > 1) chips.push(h('button', { type: 'button', class: 'lm-srch__clear-all', onClick: clearAll }, 'Clear all'));
    chipsRow.replaceChildren(...chips);
    chipsRow.hidden = !chips.length;
    const n = advancedCount();
    filterCount.hidden = !n;
    filterCount.textContent = String(n);
    filtersBtn.setAttribute('aria-label', n ? `Filters, ${n} active` : 'Filters');
  }

  // ── Start state: recent searches and genres ──
  function startState() {
    const recent = store.get(recentKey(), []);
    const wrap = h('div', { class: 'lm-srch__start' });
    if (recent.length) {
      const list = h('ul', { class: 'lm-srch__recent', role: 'list' }, ...recent.map((term) => h('li', null,
        h('button', { type: 'button', class: 'lm-srch__recent-term', onClick: () => { input.value = term; state.q = term; state.page = 1; rememberSearch(term); refresh(); } }, icon('history'), h('span', null, term)),
        h('button', { type: 'button', class: 'lm-icon-btn', 'aria-label': `Remove “${term}” from recent searches`, onClick: () => { store.set(recentKey(), store.get(recentKey(), []).filter((x) => x !== term)); results.replaceChildren(startState()); announce('Removed from recent searches'); } }, icon('close')))));
      wrap.append(h('section', { class: 'lm-srch__start-block', 'aria-labelledby': 'srch-recent' },
        h('div', { class: 'lm-srch__start-head' },
          h('h2', { class: 'lm-h3', id: 'srch-recent' }, 'Recent searches'),
          button('Clear history', { variant: 'ghost', size: 'sm', icon: 'trash', onClick: () => { store.remove(recentKey()); results.replaceChildren(startState()); announce('Search history cleared'); input.focus(); } })),
        list));
    }
    if (genres.length) {
      wrap.append(h('section', { class: 'lm-srch__start-block', 'aria-labelledby': 'srch-genres' },
        h('h2', { class: 'lm-h3', id: 'srch-genres' }, 'Browse by genre'),
        h('div', { class: 'lm-cluster lm-cluster--sm' }, ...genres.map((g) => h('a', { class: 'lm-chip', href: `#/genres/${encodeURIComponent(g.name)}` }, g.name, h('span', { class: 'lm-chip__count' }, String(g.count)))))));
    }
    wrap.append(h('p', { class: 'lm-srch__velvia' }, icon('sparkle'), h('span', null, 'Not sure what you are looking for? '), h('a', { class: 'lm-link', href: '#/velvia' }, 'Describe it to Velvia'), '.'));
    return wrap;
  }

  // ── Results ──
  let controller = null;
  let seq = 0;
  async function run({ append = false } = {}) {
    const my = ++seq;
    controller?.abort();
    controller = new AbortController();
    syncUrl(state);
    renderChips();
    if (!hasCriteria()) {
      status.textContent = '';
      results.replaceChildren(startState());
      return;
    }
    // A fresh search always starts at page 1; "Load more" asks for the page after the last one
    // shown. state.page only moves once that page has arrived, so a failure never skips one.
    const page = append ? state.page + 1 : 1;
    const query = { ...toSearchParams({ q: state.q.trim(), sort: state.sort || undefined, filters: state.filters }), page, pageSize: PAGE_SIZE };
    if (!append) {
      results.setAttribute('aria-busy', 'true');
      // The old grid may stay visible while the new results load; its pager must not append to it.
      moreFooter.hidden = true;
      if (!results.querySelector('.lm-grid')) results.replaceChildren(loading('Searching…'));
    }
    try {
      const r = await api.catalog.search(query, { signal: controller.signal });
      if (my !== seq) return;
      state.page = page;
      results.removeAttribute('aria-busy');
      const term = state.q.trim();
      status.textContent = r.total
        ? `${plural(r.total, 'result')}${term ? ` for “${term}”` : ''}`
        : '';
      if (append) {
        const grid = results.querySelector('.lm-grid');
        const nodes = r.items.map((t) => h('li', null, titleCard(t)));
        grid.append(...nodes);
        updateMore(r);
        nodes[0]?.querySelector('.lm-card__link')?.focus();
        announce(`Showing ${grid.children.length} of ${r.total}`);
        return;
      }
      if (!r.items.length) {
        results.replaceChildren(noResults(term, r.didYouMean));
        announce(term ? `No results for ${term}` : 'No titles match these filters');
        return;
      }
      const grid = cardGrid(r.items.map((t) => ({ title: t })));
      results.replaceChildren(...[
        r.didYouMean && term && r.didYouMean.toLowerCase() !== term.toLowerCase() ? didYouMean(r.didYouMean) : null,
        grid,
        moreFooter,
      ].filter(Boolean));
      updateMore(r);
    } catch (err) {
      if (err.name === 'AbortError' || my !== seq) return;
      results.removeAttribute('aria-busy');
      if (append && results.querySelector('.lm-grid')) {
        // Keep everything already shown; "Load more" asks for the same page again.
        moreCount.textContent = `${err.message || 'Something went wrong.'} Choose “Load more” to try again.`;
        moreBtn.hidden = false;
        moreFooter.hidden = false;
        announce(moreCount.textContent);
        return;
      }
      results.replaceChildren(errorState(err, { retry: () => run() }));
    }
  }
  const moreBtn = button('Load more', { variant: 'glass', icon: 'chevronDown' });
  const moreCount = h('p', { class: 'lm-disc-count' });
  const moreFooter = h('div', { class: 'lm-disc-more' }, moreCount, moreBtn);
  const updateMore = (r) => {
    const shown = Math.min(r.total, r.page * r.pageSize);
    moreCount.textContent = `Showing ${shown} of ${plural(r.total, 'result')}`;
    moreBtn.hidden = shown >= r.total;
    moreFooter.hidden = shown >= r.total;
  };
  moreBtn.addEventListener('click', async () => {
    moreBtn.classList.add('is-busy');
    try {
      await run({ append: true });
    } finally {
      moreBtn.classList.remove('is-busy');
    }
  });

  function didYouMean(suggestion) {
    return h('p', { class: 'lm-srch__dym' }, 'Did you mean ', h('button', { type: 'button', class: 'lm-link', onClick: () => { input.value = suggestion; state.q = suggestion; state.page = 1; clearBtn.hidden = false; rememberSearch(suggestion); refresh(); } }, suggestion), '?');
  }

  function noResults(term, suggestion) {
    const filtered = advancedCount() > 0 || !!state.filters.type;
    const actions = [];
    if (filtered) actions.push(button('Remove filters', { variant: 'primary', icon: 'close', onClick: clearAll }));
    actions.push(linkButton('Browse genres', '#/genres', { variant: filtered ? 'ghost' : 'primary', icon: 'grid' }));
    actions.push(linkButton('Ask Velvia', `#/velvia${term ? `?q=${encodeURIComponent(term)}` : ''}`, { variant: 'ghost', icon: 'sparkle' }));
    const tips = [
      suggestion ? null : 'Check the spelling, or try a shorter or more general term.',
      filtered ? `${plural(advancedCount() + (state.filters.type ? 1 : 0), 'filter')} may be hiding matches.` : null,
      'You can search by title, actor, director, genre or mood — for example “relaxing” or “dragon”.',
    ].filter(Boolean);
    return h('div', null,
      suggestion ? didYouMean(suggestion) : null,
      emptyState({
        title: term ? `No results for “${term}”` : 'No titles match these filters',
        message: tips.join(' '),
        actions,
      }));
  }

  const refresh = () => run();
  const liveSearch = debounce(() => {
    state.page = 1;
    run();
  }, 220);

  input.addEventListener('input', () => {
    state.q = input.value;
    clearBtn.hidden = !input.value;
    liveSearch();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      liveSearch.cancel();
      rememberSearch(input.value);
      state.page = 1;
      run();
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      input.value = '';
      state.q = '';
      clearBtn.hidden = true;
      run();
    }
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    state.q = '';
    clearBtn.hidden = true;
    state.page = 1;
    run();
    input.focus();
  });
  // Choosing a result counts as a search worth remembering.
  results.addEventListener('click', (e) => {
    if (e.target.closest('.lm-card a, .lm-card button') && state.q.trim()) rememberSearch(state.q);
  });
  ctx.onDestroy(() => {
    liveSearch.cancel();
    controller?.abort();
  });

  renderType();
  renderSort();
  renderPanel();
  if (advancedCount() > 0 && window.matchMedia('(min-width: 861px)').matches) {
    panel.hidden = false;
    filtersBtn.setAttribute('aria-expanded', 'true');
  }

  const page = h('div', { class: 'lm-page lm-container lm-srch' },
    h('header', { class: 'lm-srch__head' },
      h('h1', { class: 'lm-h1' }, 'Search'),
      box,
      h('p', { class: 'lm-hint lm-srch__hint', id: `${inputId}-hint` }, 'Results update as you type. Search titles, people, genres, moods and keywords.')),
    h('div', { class: 'lm-srch__toolbar' }, typeSlot, filtersBtn, h('span', { class: 'lm-spacer' }), sortSlot),
    panel,
    chipsRow,
    status,
    results);

  run();
  // The header's search button leads here on phones, so start typing straight away.
  if (!state.q) setTimeout(() => { if (document.contains(input)) input.focus({ preventScroll: true }); }, 80);
  return page;
}

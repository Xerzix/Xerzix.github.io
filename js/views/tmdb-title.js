// A TMDB title page (/explore/title/:type/:id): backdrop, poster, overview, release date, TMDB
// rating, cast, details and recommendations, in the same cinematic layout as Lumina's own title
// pages. TMDB titles are for discovery only, so there is no Play button; "Find on Lumina" looks
// the title up in Lumina's own catalogue.
import { h, newUid } from '../core/dom.js';
import { api } from '../api/client.js';
import { countryName, languageName, plural, runtime } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { artImg } from '../ui/artwork.js';
import { linkButton, sectionHead } from '../ui/components.js';
import { ratingBadge, releaseDate, tmdbCredit, tmdbError, tmdbRow, typeLabel } from '../ui/tmdb.js';
import { session } from '../core/session.js';

const enc = encodeURIComponent;

function hero(t) {
  const facts = h('div', { class: 'lm-meta' },
    t.year ? h('span', null, String(t.year)) : null,
    t.certification ? h('span', { class: 'lm-badge lm-badge--solid', title: 'US certification reported by TMDB' }, t.certification) : null,
    t.type === 'movie' && t.runtimeMin ? h('span', null, runtime(t.runtimeMin)) : null,
    t.type === 'tv' && t.seasonCount ? h('span', null, plural(t.seasonCount, 'season')) : null,
    ratingBadge(t, { long: true }));
  return h('section', { class: 'lm-detail__hero' },
    h('div', { class: 'lm-detail__backdrop', 'aria-hidden': 'true' },
      t.backdrop ? artImg({ src: t.backdrop.src, srcset: t.backdrop.srcset, sizes: '100vw', kind: 'backdrop', loading: 'eager', fetchpriority: 'high' }) : null),
    h('div', { class: 'lm-detail__shade', 'aria-hidden': 'true' }),
    h('div', { class: 'lm-container lm-detail__hero-inner' },
      h('div', { class: 'lm-detail__poster' },
        artImg({ src: t.poster?.src, srcset: t.poster?.srcset, sizes: '(max-width: 640px) 40vw, 300px', alt: `${t.title} poster`, title: t.title, kind: 'poster', loading: 'eager' }),
        h('a', { class: 'lm-detail__artcredit', href: t.tmdbUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Artwork: TMDB')),
      h('div', { class: 'lm-detail__intro' },
        h('p', { class: 'lm-eyebrow lm-detail__eyebrow' }, `${typeLabel(t.type)} · from TMDB`),
        h('h1', { class: 'lm-detail__title' }, t.title),
        t.originalTitle && t.originalTitle !== t.title ? h('p', { class: 'lm-detail__original', lang: t.originalLanguage || undefined }, t.originalTitle) : null,
        t.tagline ? h('p', { class: 'lm-detail__tagline' }, t.tagline) : null,
        facts,
        t.genreIds?.length
          ? h('div', { class: 'lm-detail__genres' }, ...t.genreIds.map((g) => h('a', { class: 'lm-tag lm-detail__genre', href: `#/explore/genre/${t.type}/${g.id}` }, g.name)))
          : null,
        h('p', { class: 'lm-detail__synopsis' }, t.overview || 'TMDB has no overview for this title yet.'),
        h('p', { class: 'lm-detail__notice', role: 'note' }, icon('info', { size: 16 }), h('span', null, 'Listed from The Movie Database for discovery. Search Lumina to see whether it is available to stream.')),
        h('div', { class: 'lm-detail__actions' },
          linkButton('Find on Lumina', `#/search?q=${enc(t.title)}`, { variant: 'primary', icon: 'search' }),
          h('a', { class: 'lm-btn lm-btn--glass', href: t.tmdbUrl, target: '_blank', rel: 'noopener noreferrer' }, h('span', null, 'View on TMDB'), icon('external', { size: 14 })),
          t.homepage ? h('a', { class: 'lm-btn lm-btn--ghost', href: t.homepage, target: '_blank', rel: 'noopener noreferrer' }, h('span', null, 'Official site'), icon('external', { size: 14 })) : null))));
}

function castSection(t) {
  if (!t.cast?.length) return null;
  const headingId = newUid('cast');
  return h('section', { class: 'lm-detail__section lm-container lm-tmdb-cast', 'aria-labelledby': headingId },
    sectionHead('Cast', { id: headingId }),
    h('ul', { class: 'lm-tmdb-cast__list', role: 'list' },
      ...t.cast.map((c) => h('li', { class: 'lm-tmdb-person' },
        h('div', { class: 'lm-tmdb-person__photo' },
          c.profile ? h('img', { src: c.profile.src, alt: '', loading: 'lazy', decoding: 'async', onError: (e) => e.currentTarget.remove() }) : null,
          h('span', { class: 'lm-tmdb-person__initials', 'aria-hidden': 'true' }, c.name.split(/\s+/).map((p) => p[0]).slice(0, 2).join(''))),
        h('span', { class: 'lm-tmdb-person__name' }, c.name),
        c.character ? h('span', { class: 'lm-tmdb-person__role' }, c.character) : null))));
}

function detailsSection(t) {
  const headingId = newUid('details');
  const rows = [];
  const add = (term, ...value) => {
    const v = value.flat().filter((x) => x !== null && x !== undefined && x !== '');
    if (v.length) rows.push(h('div', { class: 'lm-facts__row' }, h('dt', null, term), h('dd', null, ...v)));
  };
  if (t.directors?.length) add(t.type === 'movie' && t.directors.length > 1 ? 'Directors' : t.directorLabel, t.directors.join(', '));
  if (t.writers?.length) add('Writers', t.writers.join(', '));
  add(t.type === 'tv' ? 'First aired' : 'Release date', releaseDate(t.releaseDate) || (t.year ? String(t.year) : 'Not yet announced'));
  add('TMDB rating', t.rating != null ? `${t.rating.toFixed(1)} / 10` : 'Not yet rated', t.voteCount ? h('span', { class: 'lm-muted' }, ` · ${plural(t.voteCount, 'vote')}`) : null);
  if (t.type === 'tv') {
    add('Episodes', t.seasonCount ? `${plural(t.seasonCount, 'season')}, ${plural(t.episodeCount || 0, 'episode')}` : null);
    add('Runtime', t.runtimeMin ? `About ${runtime(t.runtimeMin)} per episode` : null);
  } else {
    add('Runtime', t.runtimeMin ? runtime(t.runtimeMin) : null);
  }
  add('Certification', t.certification ? h('span', { class: 'lm-badge lm-badge--solid' }, t.certification) : null, t.certification ? h('span', { class: 'lm-facts__note' }, 'US rating reported by TMDB') : null);
  add('Status', t.status);
  add('Original language', t.originalLanguage ? languageName(t.originalLanguage) : null);
  if (t.countries?.length) add(t.countries.length > 1 ? 'Countries' : 'Country', t.countries.map((c) => countryName(c)).join(', '));
  if (t.spokenLanguages?.length) add('Spoken languages', t.spokenLanguages.join(', '));
  return h('section', { class: 'lm-detail__section lm-container', 'aria-labelledby': headingId },
    sectionHead('Details', { id: headingId }),
    h('dl', { class: 'lm-facts' }, ...rows));
}

export default async function render(ctx) {
  const { type, id } = ctx.params;
  const wrap = (node) => h('div', { class: 'lm-page lm-container' }, h('h1', { class: 'visually-hidden' }, 'Title'), node);
  if (!session.isServer) return tmdbError({ code: 'SERVER_REQUIRED' });
  if (!['movie', 'tv'].includes(type) || !/^\d+$/.test(id)) return wrap(tmdbError({ code: 'NOT_FOUND' }));
  let t;
  try {
    t = await api.tmdb.details(type, id, { signal: ctx.signal });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    return wrap(tmdbError(err, { retry: () => ctx.navigate(`/explore/title/${type}/${id}`, { replace: true }) }));
  }
  ctx.setTitle(t.title);
  const page = h('article', { class: 'lm-detail lm-tmdb-detail', 'data-type': t.type === 'tv' ? 'series' : 'movie' }, hero(t));
  const cast = castSection(t);
  if (cast) page.append(cast);
  page.append(detailsSection(t));
  if (t.recommendations?.length) {
    page.append(h('div', { class: 'lm-detail__similar' }, tmdbRow({ id: 'tmdb-recommended', title: 'More like this', subtitle: 'Recommended by TMDB members', items: t.recommendations })));
  }
  page.append(h('div', { class: 'lm-container' }, tmdbCredit({ compact: true })));
  return page;
}

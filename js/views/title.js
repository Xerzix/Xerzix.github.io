// Title detail: the cinematic header, actions, episodes, full details, community panels and
// similar titles. Everything shown is taken from the catalog record and this profile's own
// progress; nothing is inferred or invented.
import { h, announce, newUid, prefersReducedMotion } from '../core/dom.js';
import { api, ServerRequiredError } from '../api/client.js';
import { bus } from '../core/bus.js';
import { library, refreshLibrary, session } from '../core/session.js';
import { clock, countryName, date, languageName, plural, resolutionLabel, runtime, timeLeft } from '../core/format.js';
import { ratingLabel } from '../core/ratings.js';
import { carousel } from '../ui/carousel.js';
import { listButton, playHref, titleMeta } from '../ui/card.js';
import { icon } from '../ui/icons.js';
import { button, emptyState, errorState, linkButton, sectionHead, toast, toastError } from '../ui/components.js';
import { navigate } from '../core/router.js';
import { reviewsPanel } from '../ui/panels/reviews-panel.js';
import { velviaPanel } from '../ui/panels/velvia-panel.js';
import { qualityPanel, qualityReportButton } from '../ui/panels/quality-panel.js';

const enc = encodeURIComponent;
const epLabel = (e) => `S${e.seasonNumber}:E${e.number}`;
/** Artwork that fails to load is removed so the tinted placeholder shows instead of a broken icon. */
const hideBroken = (e) => e.currentTarget.remove();

/** Mounts a panel owned by another area; a failure never breaks the title page. */
function mountPanel(fn) {
  try {
    const node = fn();
    return node instanceof Node ? node : null;
  } catch (err) {
    console.warn('Panel failed to mount', err);
    return null;
  }
}

function unavailable(ctx, { title, message, actions }) {
  ctx.setTitle(title);
  return h('div', { class: 'lm-page lm-container' }, h('h1', { class: 'visually-hidden' }, title), emptyState({ title, message, actions }));
}

/**
 * Works out what "Play" should do from per-episode progress rows.
 * Returns { label, href, episode, resume, positionS, durationS, upNextId, lastCompletedId, allDone, anyProgress }.
 */
export function playbackPlan(t, rows = []) {
  const byEp = new Map(rows.map((r) => [r.episodeId || '', r]));
  if (t.type !== 'series') {
    const p = byEp.get('') || library.progressFor(t.id);
    const resume = p && !p.completed && p.positionS >= 15 && (!p.durationS || p.positionS / p.durationS < 0.95);
    return {
      label: resume ? 'Resume' : p?.completed ? 'Play again' : 'Play',
      href: playHref(t),
      resume,
      positionS: p?.positionS || 0,
      durationS: p?.durationS || null,
      allDone: !!p?.completed,
      anyProgress: !!p,
    };
  }
  const episodes = (t.seasons || []).flatMap((s) => s.episodes);
  const playable = episodes.filter((e) => e.hasMedia !== false);
  const latest = [...rows].filter((r) => r.episodeId).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
  const completedIds = new Set(rows.filter((r) => r.completed && r.episodeId).map((r) => r.episodeId));
  const allDone = playable.length > 0 && playable.every((e) => completedIds.has(e.id));
  let target = playable[0] || null;
  let resume = false;
  let upNextId = null;
  let lastCompletedId = null;
  if (latest && !allDone) {
    const ep = episodes.find((e) => e.id === latest.episodeId);
    if (ep && !latest.completed && latest.positionS >= 15) {
      target = ep;
      resume = true;
    } else if (ep) {
      lastCompletedId = ep.id;
      // The next episode after the latest one that has not been finished yet.
      const i = playable.findIndex((e) => e.id === ep.id);
      const next = playable.slice(i + 1).find((e) => !completedIds.has(e.id)) || playable.find((e) => !completedIds.has(e.id));
      if (next) {
        target = next;
        upNextId = next.id;
      }
    }
  }
  const pos = resume ? latest.positionS : 0;
  const label = !target ? 'Play' : resume ? `Resume ${epLabel(target)}` : upNextId ? `Play ${epLabel(target)}` : allDone ? `Watch again from ${epLabel(target)}` : `Play ${epLabel(target)}`;
  return {
    label,
    href: target ? playHref(t, target.id) : playHref(t),
    episode: target,
    resume,
    positionS: pos,
    durationS: resume ? latest.durationS : null,
    upNextId,
    lastCompletedId,
    allDone,
    anyProgress: rows.length > 0,
  };
}

function genreLinks(t) {
  return (t.genres || []).map((g) => h('a', { class: 'lm-tag lm-detail__genre', href: `#/genres/${enc(g)}` }, g));
}

function heroSection(t, parts) {
  const eyebrow = (t.tags || []).includes('lumina-original') ? 'A Lumina Original' : t.creator ? `From ${t.creator.name}` : t.type === 'series' ? 'Series' : 'Film';
  const tint = t.palette?.[0];
  return h('section', { class: 'lm-detail__hero', style: tint ? { '--detail-tint': tint } : undefined },
    h('div', { class: 'lm-detail__backdrop', 'aria-hidden': 'true' },
      t.backdrop || t.poster ? h('img', { src: t.backdrop || t.poster, alt: '', decoding: 'async', fetchpriority: 'high', onError: hideBroken }) : null),
    h('div', { class: 'lm-detail__shade', 'aria-hidden': 'true' }),
    h('div', { class: 'lm-container lm-detail__hero-inner' },
      h('div', { class: 'lm-detail__poster' }, t.poster ? h('img', { src: t.poster, alt: `${t.title} poster`, decoding: 'async' }) : h('span', { 'aria-hidden': 'true' }, t.title.slice(0, 1))),
      h('div', { class: 'lm-detail__intro' },
        h('p', { class: 'lm-eyebrow lm-detail__eyebrow' }, eyebrow),
        h('h1', { class: 'lm-detail__title' }, t.title),
        t.originalTitle && t.originalTitle !== t.title ? h('p', { class: 'lm-detail__original', lang: t.originalLanguage === 'ja' || /[぀-ヿ一-龯]/.test(t.originalTitle) ? 'ja' : t.originalLanguage || undefined }, t.originalTitle) : null,
        t.tagline ? h('p', { class: 'lm-detail__tagline' }, t.tagline) : null,
        titleMeta(t, { extended: true }),
        t.genres?.length ? h('div', { class: 'lm-detail__genres' }, ...genreLinks(t)) : null,
        h('p', { class: 'lm-detail__synopsis' }, t.synopsis),
        parts.resumeLine,
        parts.primary,
        parts.secondary)));
}

// ── Episodes ──────────────────────────────────────────────
function episodesSection(t, state) {
  const headingId = newUid('eps');
  const seasons = t.seasons || [];
  const list = h('ol', { class: 'lm-episodes', role: 'list' });
  const meta = h('p', { class: 'lm-muted lm-small lm-episodes__season-meta' });
  let current = seasons[0]?.number;

  const renderSeason = () => {
    const season = seasons.find((s) => s.number === current) || seasons[0];
    if (!season) return;
    meta.textContent = [season.name && season.name !== `Season ${season.number}` ? season.name : null, season.year, plural(season.episodes.length, 'episode'), season.synopsis].filter(Boolean).join(' · ');
    const byEp = new Map(state.rows.map((r) => [r.episodeId, r]));
    list.replaceChildren(...season.episodes.map((e) => {
      const p = byEp.get(e.id);
      const ratio = p?.completed ? 1 : p?.durationS ? Math.min(1, p.positionS / p.durationS) : 0;
      const isNext = state.plan.upNextId === e.id || (state.plan.resume && state.plan.episode?.id === e.id);
      const name = `${e.number}. ${e.name}`;
      const status = p?.completed ? 'Watched' : ratio > 0.01 ? timeLeft(p.positionS, p.durationS) || `${clock(p.positionS)} watched` : '';
      const art = h('div', { class: 'lm-episode__still' },
        e.still || t.backdrop ? h('img', { src: e.still || t.backdrop, alt: '', loading: 'lazy', decoding: 'async', onError: hideBroken }) : null,
        e.hasMedia !== false ? h('span', { class: 'lm-episode__play', 'aria-hidden': 'true' }, icon('play')) : null,
        ratio > 0.01 ? h('div', { class: 'lm-episode__progress' }, h('div', { class: 'lm-progress', role: 'progressbar', 'aria-label': `${e.name} watched`, 'aria-valuenow': String(Math.round(ratio * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { style: { width: `${Math.round(ratio * 100)}%` } }))) : null);
      const text = h('div', { class: 'lm-episode__text' },
        h('div', { class: 'lm-episode__top' },
          h('h3', { class: 'lm-episode__name' }, name),
          isNext ? h('span', { class: 'lm-badge lm-badge--accent' }, state.plan.resume ? 'Continue' : 'Up next') : null,
          p?.completed ? h('span', { class: 'lm-badge lm-badge--ok' }, icon('check', { size: 12 }), 'Watched') : null),
        h('p', { class: 'lm-episode__meta' }, [e.runtimeMin ? runtime(e.runtimeMin) : null, e.airDate ? date(e.airDate) : null, status && !p?.completed ? status : null, e.hasMedia === false ? 'Not yet available to stream' : null].filter(Boolean).join(' · ')),
        e.synopsis ? h('p', { class: 'lm-episode__synopsis' }, e.synopsis) : null);
      const label = `Play episode ${e.number}, ${e.name}${p?.completed ? ', watched' : ratio > 0.01 ? `, ${status}` : ''}${isNext ? ', up next' : ''}`;
      return h('li', { class: ['lm-episode', isNext && 'is-next', p?.completed && 'is-watched'] },
        e.hasMedia !== false
          ? h('a', { class: 'lm-episode__link', href: playHref(t, e.id), 'aria-label': label }, art, text)
          : h('div', { class: 'lm-episode__link is-unavailable' }, art, text));
    }));
  };

  const focusEp = state.plan.episode;
  if (focusEp) current = focusEp.seasonNumber;
  let picker = null;
  if (seasons.length > 1) {
    const id = newUid('season');
    const select = h('select', { class: 'lm-select lm-select--compact', id }, ...seasons.map((s) => h('option', { value: String(s.number), selected: s.number === current }, s.name && s.name !== `Season ${s.number}` ? `Season ${s.number}: ${s.name}` : `Season ${s.number}`)));
    select.addEventListener('change', () => {
      current = Number(select.value);
      renderSeason();
      announce(`Showing ${select.selectedOptions[0].textContent}`);
    });
    picker = h('div', { class: 'lm-disc-sort' }, h('label', { class: 'visually-hidden', for: id }, 'Season'), select);
  }
  renderSeason();
  const section = h('section', { class: 'lm-detail__section lm-container', 'aria-labelledby': headingId },
    h('div', { class: 'lm-detail__section-head' }, sectionHead('Episodes', { id: headingId }), picker),
    meta,
    list);
  section.refresh = renderSeason;
  return section;
}

// ── Details ───────────────────────────────────────────────
function detailsSection(t) {
  const headingId = newUid('details');
  const rows = [];
  const add = (term, ...value) => {
    const v = value.flat().filter((x) => x !== null && x !== undefined && x !== '');
    if (v.length) rows.push(h('div', { class: 'lm-facts__row' }, h('dt', null, term), h('dd', null, ...v)));
  };
  const people = (names) => names.map((n, i) => [i ? ', ' : '', h('a', { class: 'lm-link', href: `#/search?q=${enc(n)}` }, n)]);
  const credits = t.credits || {};

  add(credits.directors?.length > 1 ? 'Directors' : 'Director', people(credits.directors || []));
  if (credits.cast?.length) {
    add('Cast', h('ul', { class: 'lm-facts__list' }, ...credits.cast.map((c) => h('li', null, h('a', { class: 'lm-link', href: `#/search?q=${enc(c.name)}` }, c.name), c.role ? h('span', { class: 'lm-muted' }, ` as ${c.role}`) : null))));
  }
  if (credits.crew?.length) {
    add('Crew', h('ul', { class: 'lm-facts__list' }, ...credits.crew.map((c) => h('li', null, c.name, c.job ? h('span', { class: 'lm-muted' }, ` — ${c.job}`) : null))));
  }
  if (t.creator) add('Creator', t.creator.name, h('span', { class: 'lm-muted' }, ' · published through Lumina Creators'));
  add('Release date', t.releaseDate ? date(t.releaseDate, { year: 'numeric', month: 'long', day: 'numeric' }) : t.year ? String(t.year) : null);
  if (t.type === 'series') {
    add('Runtime', t.runtimeMin ? `About ${runtime(t.runtimeMin)} per episode` : null, t.seasonCount ? h('span', { class: 'lm-muted' }, ` · ${plural(t.seasonCount, 'season')}, ${plural(t.episodeCount || 0, 'episode')}`) : null);
  } else {
    add('Runtime', t.runtimeMin ? runtime(t.runtimeMin) : null);
  }
  add('Genres', (t.genres || []).map((g, i) => [i ? ', ' : '', h('a', { class: 'lm-link', href: `#/genres/${enc(g)}` }, g)]));
  add('Age rating',
    h('span', { class: 'lm-badge lm-badge--solid' }, t.ageRating),
    ` ${ratingLabel(t.ageRating)}`,
    t.ratingSource === 'advisory' ? h('span', { class: 'lm-facts__note' }, 'Advisory rating assigned by Lumina') : null);
  add('Original language', t.originalLanguage ? languageName(t.originalLanguage) : null);
  if (t.countries?.length) add(t.countries.length > 1 ? 'Countries' : 'Country', t.countries.map((c) => countryName(c)).join(', '));
  add('Audio languages', (t.audioLanguages || []).map((l) => languageName(l)).join(', '));
  add('Subtitles', t.subtitleLanguages?.length ? t.subtitleLanguages.map((l) => languageName(l)).join(', ') : 'None available');
  add('Supported resolutions', t.resolutions?.length
    ? h('ul', { class: 'lm-facts__list lm-facts__list--inline' }, ...t.resolutions.map((r) => h('li', null, resolutionLabel(r))))
    : h('span', { class: 'lm-muted' }, 'Resolutions are detected from the stream when playback starts'));
  add('Audio formats', (t.audioFormats || []).join(', '));
  add('HDR', t.hdr || null);
  if (t.awards?.length) add('Awards', h('ul', { class: 'lm-facts__list' }, ...t.awards.map((a) => h('li', null, typeof a === 'string' ? a : [a.name, a.year].filter(Boolean).join(', ')))));
  const lic = t.license || {};
  if (lic.name || lic.attribution) {
    add('Licence & attribution',
      h('div', { class: 'lm-stack lm-stack--sm' },
        lic.name ? (lic.url ? h('a', { class: 'lm-link', href: lic.url, target: '_blank', rel: 'noopener noreferrer license' }, lic.name, icon('external', { size: 14 })) : h('span', null, lic.name)) : null,
        lic.attribution ? h('span', { class: 'lm-muted' }, lic.attribution) : null,
        lic.source ? h('a', { class: 'lm-link lm-small', href: lic.source, target: '_blank', rel: 'noopener noreferrer' }, 'Original source', icon('external', { size: 14 })) : null));
  }
  return h('section', { class: 'lm-detail__section lm-container', 'aria-labelledby': headingId },
    sectionHead('Details', { id: headingId }),
    h('dl', { class: 'lm-facts' }, ...rows));
}

// ── Page ──────────────────────────────────────────────────
export default async function render(ctx) {
  const id = ctx.params.id;
  let t;
  try {
    t = await api.catalog.title(id);
  } catch (err) {
    if (err.code === 'PROFILE_RESTRICTED') {
      return unavailable(ctx, {
        title: 'Not available on this profile',
        message: `This title is outside the maturity setting${session.profile ? ` for ${session.profile.name}` : ''}. Switch to a profile with a higher maturity setting, or ask the account owner to change it.`,
        actions: [
          session.isServer ? linkButton('Switch profile', '#/profiles', { variant: 'primary', icon: 'users' }) : null,
          linkButton('Keep browsing', '#/', { variant: 'ghost', icon: 'home' }),
        ].filter(Boolean),
      });
    }
    if (err.status === 404) {
      return unavailable(ctx, {
        title: 'Title not found',
        message: 'This title is not in the Lumina catalog. It may have been removed, or the link may be mistyped.',
        actions: [linkButton('Search Lumina', `#/search?q=${enc(id.replace(/[-_]+/g, ' '))}`, { variant: 'primary', icon: 'search' }), linkButton('Home', '#/', { variant: 'ghost', icon: 'home' })],
      });
    }
    throw err;
  }
  ctx.setTitle(t.title);

  // Ambient mode: a soft wash of the title's palette behind the page.
  const ambientOn = session.profile?.preferences?.appearance?.ambientMode !== false;
  if (ambientOn && t.palette?.length) {
    const amb = h('div', { class: 'lm-ambient', 'aria-hidden': 'true', style: { '--amb-1': t.palette[0], '--amb-2': t.palette[1] || t.palette[0], '--amb-3': t.palette[2] || t.palette[0] } });
    document.body.append(amb);
    ctx.onDestroy(() => amb.remove());
  }

  const canTrack = !!session.profile;
  const state = { rows: [], plan: null };
  const loadProgress = async () => {
    if (!canTrack) return [];
    try {
      return (await api.library.titleProgress(t.id)).items || [];
    } catch {
      return [];
    }
  };
  state.rows = await loadProgress();
  state.plan = playbackPlan(t, state.rows);

  // ── Actions ──
  const panels = {};
  const primary = h('div', { class: 'lm-detail__actions' });
  const secondary = h('div', { class: 'lm-detail__more', role: 'group', 'aria-label': 'More actions' });
  const resumeLine = h('p', { class: 'lm-detail__resume' });
  let episodes = null;

  const watchedBtn = button('Mark as watched', { variant: 'ghost', size: 'sm', icon: 'eye' });
  const setWatchedLabel = () => {
    const done = state.plan.allDone;
    watchedBtn.replaceChildren(icon(done ? 'eyeOff' : 'eye'), h('span', null, done ? 'Mark unwatched' : t.type === 'series' ? 'Mark series watched' : 'Mark as watched'));
    watchedBtn.setAttribute('aria-pressed', String(done));
  };

  const renderPrimary = () => {
    const plan = state.plan;
    const play = t.playable
      ? linkButton(plan.label, plan.href, { variant: 'primary', size: 'lg', icon: 'play', attrs: { 'aria-label': `${plan.label}: ${t.title}${plan.episode ? `, episode “${plan.episode.name}”` : ''}` } })
      : button('Not yet available', { variant: 'primary', size: 'lg', icon: 'clock', disabled: true });
    primary.replaceChildren(...[
      play,
      t.trailerMediaId ? linkButton('Trailer', `#/watch/${enc(t.id)}?trailer=1`, { variant: 'glass', size: 'lg', icon: 'film' }) : null,
      listButton(t, { size: 'lg', variant: 'glass', label: true }),
    ].filter(Boolean));
    if (plan.resume && plan.durationS) {
      const ratio = Math.min(1, plan.positionS / plan.durationS);
      resumeLine.replaceChildren(
        h('span', { class: 'lm-progress lm-detail__resume-bar', role: 'progressbar', 'aria-label': 'Progress', 'aria-valuenow': String(Math.round(ratio * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100' }, h('span', { style: { width: `${Math.round(ratio * 100)}%` } })),
        h('span', null, [plan.episode ? `${epLabel(plan.episode)} “${plan.episode.name}”` : null, timeLeft(plan.positionS, plan.durationS)].filter(Boolean).join(' · ')));
      resumeLine.hidden = false;
    } else if (plan.upNextId && plan.episode) {
      resumeLine.replaceChildren(icon('skipNext', { size: 16 }), h('span', null, `Up next: ${epLabel(plan.episode)} “${plan.episode.name}”`));
      resumeLine.hidden = false;
    } else {
      resumeLine.hidden = true;
    }
    setWatchedLabel();
  };

  const refreshProgress = async () => {
    state.rows = await loadProgress();
    state.plan = playbackPlan(t, state.rows);
    renderPrimary();
    episodes?.refresh();
  };

  watchedBtn.addEventListener('click', async () => {
    if (!session.profile) {
      toast('Sign in and choose a profile to track what you watch.', { action: { label: 'Sign in', onClick: () => navigate('/login') } });
      return;
    }
    const undo = state.plan.allDone;
    watchedBtn.disabled = true;
    try {
      if (undo) await api.library.unmarkWatched(t.id);
      else await api.library.markWatched(t.id);
      await refreshLibrary();
      await refreshProgress();
      bus.emit('library:refresh-home', {});
      toast(undo ? `Cleared your progress for “${t.title}”.` : `Marked “${t.title}” as watched.`, { type: 'success', timeout: 2600 });
    } catch (err) {
      toastError(err);
    } finally {
      watchedBtn.disabled = false;
    }
  });

  const scrollToPanel = (key) => {
    const node = panels[key];
    if (!node) return false;
    node.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
    const focusable = node.querySelector('h2, h3, [tabindex], button, a, textarea, input');
    if (focusable) {
      if (!focusable.matches('button, a, textarea, input')) focusable.setAttribute('tabindex', '-1');
      focusable.focus({ preventScroll: true });
    }
    return true;
  };

  const shareBtn = button('Share', {
    variant: 'ghost',
    size: 'sm',
    icon: 'share',
    onClick: async () => {
      const url = `${location.origin}${location.pathname}#/title/${enc(t.id)}`;
      if (navigator.share) {
        try {
          await navigator.share({ title: `${t.title} on Lumina`, text: t.tagline || t.synopsis?.slice(0, 140), url });
          return;
        } catch (err) {
          if (err.name === 'AbortError') return;
        }
      }
      try {
        await navigator.clipboard.writeText(url);
        toast('Link copied to the clipboard.', { type: 'success', timeout: 2600 });
      } catch {
        toast(`Copy this link: ${url}`, { timeout: 9000 });
      }
    },
  });

  // Follow series (server mode, with a profile).
  let followBtn = null;
  if (t.type === 'series' && session.isServer && session.profile) {
    let following = false;
    try {
      following = (await api.follows.list()).items.some((f) => f.type === 'series' && f.id === t.id);
    } catch {
      /* follow state is optional */
    }
    followBtn = button('Follow series', { variant: 'ghost', size: 'sm', icon: 'bell', attrs: { title: 'Get notified when new episodes arrive' } });
    const paintFollow = () => {
      followBtn.replaceChildren(icon(following ? 'check' : 'bell'), h('span', null, following ? 'Following' : 'Follow series'));
      followBtn.setAttribute('aria-pressed', String(following));
    };
    paintFollow();
    followBtn.addEventListener('click', async () => {
      followBtn.disabled = true;
      try {
        if (following) await api.follows.unfollow('series', t.id);
        else await api.follows.follow('series', t.id);
        following = !following;
        paintFollow();
        toast(following ? `You will be notified about new episodes of “${t.title}”.` : `You unfollowed “${t.title}”.`, { type: 'success', timeout: 2800 });
      } catch (err) {
        toastError(err);
      } finally {
        followBtn.disabled = false;
      }
    });
  }

  // Panels owned by the community, Velvia and playback areas.
  panels.reviews = mountPanel(() => reviewsPanel(t));
  panels.velvia = mountPanel(() => velviaPanel({ title: t }));
  panels.quality = mountPanel(() => qualityPanel(t));
  const visible = (n) => n && !n.hidden;
  const reportBtn = mountPanel(() => qualityReportButton(t, t.type === 'series' ? state.plan.episode || null : null));

  // "Rate" leads to the reviews panel, so it is offered only while that panel is shown.
  const rateBtn = panels.reviews ? button('Rate', { variant: 'ghost', size: 'sm', icon: 'star', onClick: () => scrollToPanel('reviews') }) : null;
  if (rateBtn) {
    rateBtn.hidden = !visible(panels.reviews);
    const mo = new MutationObserver(() => { rateBtn.hidden = !visible(panels.reviews); });
    mo.observe(panels.reviews, { attributes: true, attributeFilter: ['hidden'] });
    ctx.onDestroy(() => mo.disconnect());
  }
  const velviaBtn = button('Ask Velvia', {
    variant: 'ghost',
    size: 'sm',
    icon: 'sparkle',
    className: 'lm-detail__velvia',
    onClick: () => {
      if (visible(panels.velvia) && scrollToPanel('velvia')) return;
      navigate(`/velvia?q=${enc(`Titles like ${t.title}`)}`);
    },
  });
  secondary.append(...[
    watchedBtn,
    rateBtn,
    shareBtn,
    followBtn,
    linkButton('Compare', `#/compare?ids=${enc(t.id)}`, { variant: 'ghost', size: 'sm', icon: 'columns' }),
    velviaBtn,
    reportBtn,
  ].filter(Boolean));
  renderPrimary();

  const page = h('article', { class: 'lm-detail', 'data-type': t.type },
    heroSection(t, { primary, secondary, resumeLine }));

  if (t.type === 'series' && t.seasons?.length) {
    episodes = episodesSection(t, state);
    page.append(episodes);
  }
  page.append(detailsSection(t));

  for (const key of ['reviews', 'velvia', 'quality']) {
    if (panels[key]) page.append(h('div', { class: `lm-detail__panel lm-detail__panel--${key} lm-container` }, panels[key]));
  }

  // More like this.
  const similarSlot = h('div', { class: 'lm-detail__similar' });
  page.append(similarSlot);
  api.catalog.similar(t.id).then(({ items }) => {
    if (items?.length) similarSlot.replaceChildren(carousel({ id: 'similar', title: 'More like this', subtitle: 'Similar genres, moods and filmmakers', items: items.map((x) => ({ title: x })) }));
  }).catch((err) => {
    if (!(err instanceof ServerRequiredError)) similarSlot.replaceChildren(h('div', { class: 'lm-container' }, errorState(err)));
  });

  return page;
}

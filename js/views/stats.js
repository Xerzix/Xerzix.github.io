// Private viewing statistics for the active profile, computed only from its own history.
import { h, newUid } from '../core/dom.js';
import { api } from '../api/client.js';
import { bus } from '../core/bus.js';
import { refreshLibrary, session, setProfile } from '../core/session.js';
import { date, plural, relativeTime } from '../core/format.js';
import { icon } from '../ui/icons.js';
import { button, confirmDialog, emptyState, errorState, linkButton, loading, settingRow, toast, toastError, toggleSwitch } from '../ui/components.js';

const enc = encodeURIComponent;

/** 11520 -> "3h 12m", 540 -> "9m", 20 -> "<1m", 0 -> "0m" */
export function duration(seconds) {
  const s = Math.max(0, Math.round(seconds || 0));
  if (!s) return '0m';
  if (s < 60) return '<1m';
  const hrs = Math.floor(s / 3600);
  const mins = Math.round((s % 3600) / 60);
  if (!hrs) return `${mins}m`;
  return mins ? `${hrs}h ${mins}m` : `${hrs}h`;
}

function longDuration(seconds) {
  const s = Math.round(seconds || 0);
  if (s < 60) return s ? 'less than a minute' : 'no time';
  const hrs = Math.floor(s / 3600);
  const mins = Math.round((s % 3600) / 60);
  return [hrs ? plural(hrs, 'hour') : null, mins ? plural(mins, 'minute') : null].filter(Boolean).join(' ');
}

const monthName = (key, style = 'short') => {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: style, ...(style === 'long' ? { year: 'numeric' } : {}), timeZone: 'UTC' });
};

function tile(value, label, sub) {
  return h('div', { class: 'lm-stats__tile' },
    h('span', { class: 'lm-stats__value' }, value),
    h('span', { class: 'lm-stats__label' }, label),
    sub ? h('span', { class: 'lm-stats__tile-sub' }, sub) : null);
}

function section(title, ...children) {
  const id = newUid('st');
  return h('section', { class: 'lm-panel lm-stats__card', 'aria-labelledby': id }, h('h2', { class: 'lm-panel__title', id }, title), ...children);
}

/** Monthly bars: one series, one hue, anchored to the baseline, value on hover/focus and in text. */
function monthlyChart(monthly) {
  const max = Math.max(0, ...monthly.map((m) => m.seconds));
  const total = monthly.reduce((n, m) => n + m.seconds, 0);
  if (!max) return h('p', { class: 'lm-muted' }, 'No viewing time recorded in the last 12 months.');
  const busiest = monthly.reduce((a, b) => (b.seconds > a.seconds ? b : a));
  return h('figure', { class: 'lm-stats__chart' },
    h('div', { class: 'lm-stats__chart-scale', 'aria-hidden': 'true' }, h('span', null, duration(max)), h('span', null, '0')),
    h('ol', { class: 'lm-stats__bars', role: 'list' }, ...monthly.map((m) => {
      const pct = Math.round((m.seconds / max) * 100);
      return h('li', { class: 'lm-stats__bar', tabindex: '0', 'aria-label': `${monthName(m.month, 'long')}: ${m.seconds ? longDuration(m.seconds) : 'nothing watched'}` },
        h('span', { class: 'lm-stats__bar-track', 'aria-hidden': 'true' },
          h('span', { class: ['lm-stats__bar-fill', !m.seconds && 'is-zero'], style: { height: `${m.seconds ? Math.max(pct, 2) : 0}%` } }),
          h('span', { class: 'lm-stats__tip' }, `${monthName(m.month)} · ${duration(m.seconds)}`)),
        h('span', { class: 'lm-stats__bar-label', 'aria-hidden': 'true' }, monthName(m.month).slice(0, 3)));
    })),
    h('figcaption', { class: 'lm-hint' }, `${duration(total)} in the last 12 months. Busiest month: ${monthName(busiest.month, 'long')} (${duration(busiest.seconds)}).`));
}

function genreBars(topGenres) {
  const bySeconds = topGenres.some((g) => g.seconds > 0);
  const max = Math.max(1, ...topGenres.map((g) => (bySeconds ? g.seconds : g.titles)));
  return h('ol', { class: 'lm-stats__genres', role: 'list' }, ...topGenres.map((g) => {
    const v = bySeconds ? g.seconds : g.titles;
    const text = bySeconds ? `${duration(g.seconds)} · ${plural(g.titles, 'title')}` : plural(g.titles, 'title');
    return h('li', null,
      h('div', { class: 'lm-stats__genre-row' },
        h('a', { class: 'lm-stats__genre', href: `#/genres/${enc(g.genre)}` }, g.genre),
        h('span', { class: 'lm-stats__genre-val' }, text)),
      h('span', { class: 'lm-stats__hbar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.max(2, Math.round((v / max) * 100))}%` } })));
  }));
}

function titleRow(t, sub) {
  return h('li', { class: 'lm-stats__title' },
    h('a', { class: 'lm-stats__thumb', href: `#/title/${enc(t.id)}`, tabindex: '-1', 'aria-hidden': 'true', style: t.palette?.[0] ? { '--card-tint': t.palette[0] } : undefined },
      t.poster ? h('img', { src: t.poster, alt: '', loading: 'lazy', onError: (e) => e.currentTarget.remove() }) : null),
    h('span', { class: 'lm-stats__title-text' }, h('a', { href: `#/title/${enc(t.id)}` }, t.title), h('span', null, sub)));
}

function statsBody(s) {
  if (!s.sessions && !s.titlesWatched) {
    return emptyState({
      title: 'Nothing to count yet',
      message: 'Your statistics are built from what this profile watches. Start something and come back — the numbers only ever reflect real viewing.',
      actions: [linkButton('Find something to watch', '#/discover', { variant: 'primary', icon: 'compass' })],
    });
  }
  const tiles = h('div', { class: 'lm-stats__tiles' },
    tile(duration(s.totalSeconds), 'Time watched', s.firstWatchedAt ? `Since ${date(s.firstWatchedAt)}` : null),
    tile(String(s.titlesWatched), s.titlesWatched === 1 ? 'Title watched' : 'Titles watched'),
    tile(String(s.moviesWatched), s.moviesWatched === 1 ? 'Film' : 'Films'),
    tile(String(s.episodesWatched), s.episodesWatched === 1 ? 'Episode' : 'Episodes'),
    tile(String(s.completedSeries.length), 'Series completed'));

  const grid = h('div', { class: 'lm-stats__grid' },
    section('Monthly viewing', monthlyChart(s.monthly || [])),
    s.topGenres?.length ? section('Top genres', genreBars(s.topGenres)) : null);

  const lists = h('div', { class: 'lm-stats__grid lm-stats__grid--even' },
    s.favorites?.length ? section('Most watched',
      h('p', { class: 'lm-hint lm-stats__card-sub' }, 'The titles you have spent the most time with.'),
      h('ol', { class: 'lm-stats__titles', role: 'list' }, ...s.favorites.map((t) => titleRow(t, `${duration(t.watchedSeconds)}${t.sessions > 1 ? ` over ${plural(t.sessions, 'session')}` : ''}`)))) : null,
    s.recent?.length ? section('Recently watched',
      h('ol', { class: 'lm-stats__titles', role: 'list' }, ...s.recent.slice(0, 8).map((r) => titleRow(r.title, relativeTime(r.watchedAt))))) : null);

  return h('div', { class: 'lm-stack lm-stack--lg' },
    tiles,
    grid,
    lists.children.length ? lists : null,
    s.completedSeries?.length ? section('Series you have completed',
      h('ul', { class: 'lm-stats__titles lm-stats__titles--row', role: 'list' }, ...s.completedSeries.map((t) => titleRow(t, plural(t.episodeCount || 0, 'episode'))))) : null);
}

export default async function render(ctx) {
  ctx.setTitle('Viewing statistics');
  if (session.isServer && !session.account) {
    return h('div', { class: 'lm-page lm-container lm-stats' }, h('h1', { class: 'visually-hidden' }, 'Viewing statistics'), emptyState({
      title: 'Sign in to see your statistics',
      message: 'Viewing statistics are private to each profile and built only from its own history.',
      actions: [linkButton('Sign in', `#/login?next=${enc(ctx.raw)}`, { variant: 'primary', icon: 'login' })],
    }));
  }

  const content = h('div', { class: 'lm-stats__content' });
  let enabled = session.profile?.preferences?.privacy?.statsEnabled !== false;

  const load = async () => {
    content.replaceChildren(loading('Counting…'));
    try {
      const s = await api.library.stats();
      enabled = s.enabled !== false;
      toggle.setChecked(enabled);
      content.replaceChildren(enabled
        ? statsBody(s)
        : emptyState({ title: 'Statistics are turned off', message: 'Nothing is being summarised for this profile. Turn statistics on above to see time watched, favourite genres and more. Your viewing history is unaffected either way.' }));
    } catch (err) {
      content.replaceChildren(errorState(err, { retry: load }));
    }
  };

  const toggle = toggleSwitch({
    checked: enabled,
    label: 'Keep viewing statistics',
    onChange: async (next) => {
      try {
        const res = await api.profiles.updatePreferences(session.profile?.id || 'local', { privacy: { statsEnabled: next } });
        if (res?.profile) setProfile(res.profile);
        toast(next ? 'Viewing statistics are on.' : 'Viewing statistics are off.', { type: 'success', timeout: 2400 });
        load();
      } catch (err) {
        toggle.setChecked(!next);
        toastError(err);
      }
    },
  });

  const deleteBtn = button('Delete my viewing data', {
    variant: 'danger',
    size: 'sm',
    icon: 'trash',
    onClick: async () => {
      const ok = await confirmDialog({
        title: 'Delete your viewing data?',
        message: `This permanently removes ${session.profile?.name ? `${session.profile.name}’s` : 'this profile’s'} viewing history and saved progress. Statistics reset to zero, Continue Watching empties and recommendations start fresh. My List and collections are kept.`,
        confirmLabel: 'Delete viewing data',
        danger: true,
      });
      if (!ok) return;
      try {
        await api.library.clearHistory();
        await refreshLibrary();
        bus.emit('library:refresh-home', {});
        toast('Your viewing data has been deleted.', { type: 'success' });
        load();
      } catch (err) {
        toastError(err);
      }
    },
  });

  const privacy = h('section', { class: 'lm-panel lm-stats__privacy', 'aria-label': 'Privacy' },
    h('div', { class: 'lm-stats__privacy-note' },
      icon('lock'),
      h('div', null,
        h('strong', null, 'Only you can see this. Nothing here is shared.'),
        h('p', { class: 'lm-muted lm-small' }, session.isServer
          ? 'These numbers are calculated on request from this profile’s own history. They are never shown to other profiles, other members or the Lumina team, and never used for advertising.'
          : 'In Preview mode your history never leaves this device; these numbers are calculated in your browser.'))),
    settingRow('Keep viewing statistics', 'Turning this off hides this page. Your history is still used for Continue Watching unless you delete it.', toggle),
    settingRow('Delete my viewing data', 'Removes history and saved progress for this profile.', deleteBtn));

  load();
  return h('div', { class: 'lm-page lm-container lm-stats' },
    h('header', { class: 'lm-page-header lm-disc-head' },
      h('div', null,
        h('p', { class: 'lm-eyebrow' }, session.profile?.name ? `Private to ${session.profile.name}` : 'Private to you'),
        h('h1', { class: 'lm-h1' }, 'Viewing statistics'),
        h('p', { class: 'lm-disc-head__sub' }, 'What you have watched on Lumina, by time, genre and month.')),
      h('div', { class: 'lm-cluster' }, linkButton('Viewing history', '#/my-list/history', { variant: 'ghost', size: 'sm', icon: 'history' }))),
    privacy,
    content);
}

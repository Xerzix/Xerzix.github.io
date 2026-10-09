// Composes the home page rows from catalog summaries and the viewer's own signals.
// Shared by the server (/api/home) and Preview mode. Rows with no genuine content are
// omitted rather than padded, so nothing on the home page is invented.
import { similarTitles, tasteProfile, tasteScore } from './similarity.js';

const DAY = 86_400_000;
const MIN_MEMBER_RATINGS = 3;

/**
 * @param {object[]} titles  Published summaries the profile may see.
 * @param {object} s         Signals:
 *   progress:   [{ titleId, episodeId, positionS, durationS, completed, updatedAt, episode? }]
 *   watchlist:  [{ titleId, addedAt }]
 *   history:    [{ titleId, watchedAt }]
 *   ratings:    { [titleId]: 1..5 }          (the profile's own ratings)
 *   activity:   { [titleId]: number }        (platform-wide plays, last 14 days; server only)
 *   community:  { [titleId]: { reviews, comments } }
 *   useHistory: boolean                      (privacy: personalise from history or not)
 *   collections: [{ id, name, description? }] (editorial collections an admin defined; server only)
 *   now:        ms timestamp
 */
export function composeHome(titles, s = {}) {
  const now = s.now ?? Date.now();
  const byId = new Map(titles.map((t) => [t.id, t]));
  const useHistory = s.useHistory !== false;
  const progress = (s.progress || []).filter((p) => byId.has(p.titleId));
  const watchlist = (s.watchlist || []).filter((w) => byId.has(w.titleId));
  const history = useHistory ? (s.history || []).filter((h) => byId.has(h.titleId)) : [];
  const ratings = s.ratings || {};
  const rows = [];
  const push = (row) => {
    if (row.items.length) rows.push(row);
  };

  // 1. Continue Watching — most recent activity first (behaviour kept from the original site).
  const latestPerTitle = new Map();
  for (const p of [...progress].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))) {
    if (!latestPerTitle.has(p.titleId)) latestPerTitle.set(p.titleId, p);
  }
  const continueItems = [];
  for (const p of latestPerTitle.values()) {
    const t = byId.get(p.titleId);
    const ratio = p.durationS ? p.positionS / p.durationS : 0;
    if (t.type === 'movie') {
      if (!p.completed && p.positionS >= 15 && ratio < 0.95) continueItems.push({ title: t, progress: ratio, positionS: p.positionS, durationS: p.durationS });
    } else if (!p.completed && p.positionS >= 15) {
      continueItems.push({ title: t, progress: ratio, episodeId: p.episodeId, episode: p.episode, positionS: p.positionS, durationS: p.durationS });
    } else if (p.completed && p.nextEpisode) {
      continueItems.push({ title: t, progress: 0, episodeId: p.nextEpisode.id, episode: p.nextEpisode, positionS: 0, durationS: null, upNext: true });
    }
  }
  push({ id: 'continue', title: 'Continue Watching', variant: 'landscape', items: continueItems.slice(0, 20) });

  // Taste profile from this profile's own activity (never other people's).
  const completedIds = new Set(progress.filter((p) => p.completed && byId.get(p.titleId)?.type === 'movie').map((p) => p.titleId));
  const seeds = [];
  if (useHistory) {
    for (const h of history.slice(0, 50)) seeds.push({ title: byId.get(h.titleId), weight: 1 });
    for (const id of completedIds) seeds.push({ title: byId.get(id), weight: 0.5 });
  }
  for (const w of watchlist) seeds.push({ title: byId.get(w.titleId), weight: 0.8 });
  for (const [id, r] of Object.entries(ratings)) if (byId.has(id)) seeds.push({ title: byId.get(id), weight: (r - 3) * 1.2 });
  const taste = tasteProfile(seeds.filter((x) => x.title));
  const seen = new Set([...completedIds, ...history.map((h) => h.titleId)]);

  // 2. Recommended for You (only when there is something to personalise from).
  if (taste.size) {
    const recs = titles
      .filter((t) => !seen.has(t.id) && !(ratings[t.id] <= 2))
      .map((t) => ({ t, s: tasteScore(taste, t) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.t.editorialRank - b.t.editorialRank)
      .slice(0, 20)
      .map((x) => ({ title: x.t }));
    push({ id: 'recommended', title: 'Recommended for You', items: recs });
  } else {
    const picks = [...titles].sort((a, b) => a.editorialRank - b.editorialRank).slice(0, 12).map((t) => ({ title: t }));
    push({ id: 'selects', title: 'Lumina Selects', subtitle: 'Hand-picked by the Lumina team', items: picks });
  }

  // 3–4. Trending — real platform activity only. Without enough signal the rows are omitted.
  const activity = s.activity || {};
  const trending = (type) => titles
    .filter((t) => t.type === type && (activity[t.id] || 0) >= 2)
    .sort((a, b) => activity[b.id] - activity[a.id])
    .slice(0, 20)
    .map((t) => ({ title: t }));
  push({ id: 'trending-movies', title: 'Trending Movies', href: '#/trending', items: trending('movie') });
  push({ id: 'trending-tv', title: 'Trending TV Shows', href: '#/trending', items: trending('series') });

  // 5. Recently Added.
  push({
    id: 'recent',
    title: 'Recently Added',
    href: '#/new',
    items: [...titles].filter((t) => t.addedAt && now - Date.parse(t.addedAt) <= 90 * DAY).sort((a, b) => Date.parse(b.addedAt) - Date.parse(a.addedAt)).slice(0, 20).map((t) => ({ title: t })),
  });

  // 6. New Releases — released within the last year.
  push({
    id: 'new-releases',
    title: 'New Releases',
    href: '#/new',
    items: titles.filter((t) => t.releaseDate && now - Date.parse(t.releaseDate) <= 365 * DAY && Date.parse(t.releaseDate) <= now).sort((a, b) => Date.parse(b.releaseDate) - Date.parse(a.releaseDate)).map((t) => ({ title: t })),
  });

  // 7. Critically Discussed — most member reviews and replies.
  const community = s.community || {};
  const discussed = titles.filter((t) => (community[t.id]?.reviews || 0) + (community[t.id]?.comments || 0) >= 2);
  push({
    id: 'discussed',
    title: 'Critically Discussed',
    subtitle: 'Most reviewed and debated by Lumina members',
    items: discussed.sort((a, b) => (community[b.id].reviews + community[b.id].comments) - (community[a.id].reviews + community[a.id].comments)).slice(0, 20).map((t) => ({ title: t })),
  });

  // 8. Highest Rated by Lumina Members — needs a minimum number of ratings to be meaningful.
  push({
    id: 'top-rated',
    title: 'Highest Rated by Lumina Members',
    items: titles.filter((t) => (t.memberRating?.count || 0) >= MIN_MEMBER_RATINGS).sort((a, b) => b.memberRating.average - a.memberRating.average || b.memberRating.count - a.memberRating.count).slice(0, 20).map((t) => ({ title: t })),
  });

  // Editorial collections defined in Admin → Settings: their name and description label the
  // built-in tag rows below, and every other collection gets a row of the titles tagged with it.
  const curated = new Map((Array.isArray(s.collections) ? s.collections : []).filter((c) => c && c.id && c.name).map((c) => [c.id, c]));
  const label = (tag, title, subtitle) => (curated.has(tag) ? { title: curated.get(tag).name, subtitle: curated.get(tag).description || undefined } : { title, subtitle });

  // 9. Hidden Gems — editorially tagged, or well rated with little viewing.
  push({
    id: 'hidden-gems',
    ...label('hidden-gem', 'Hidden Gems'),
    items: titles.filter((t) => (t.tags || []).includes('hidden-gem') || ((t.memberRating?.average || 0) >= 4.3 && (t.memberRating?.count || 0) >= MIN_MEMBER_RATINGS && (activity[t.id] || 0) < 3)).map((t) => ({ title: t })),
  });

  push({ id: 'originals', ...label('lumina-original', 'Lumina Originals'), items: titles.filter((t) => (t.tags || []).includes('lumina-original')).sort((a, b) => a.editorialRank - b.editorialRank).map((t) => ({ title: t })) });
  for (const row of collectionRows(titles, [...curated.values()])) push(row);

  // 10–13. Editorial collections driven by catalog metadata.
  push({ id: 'japanese', ...label('japanese-cinema', 'Japanese Cinema'), href: '#/search?language=ja', items: titles.filter((t) => t.originalLanguage === 'ja' || (t.countries || []).includes('JP') || (t.tags || []).includes('japanese-cinema')).map((t) => ({ title: t })) });
  push({ id: 'international', title: 'International Cinema', items: titles.filter((t) => (t.originalLanguage && t.originalLanguage !== 'en') || ((t.countries || []).length && !(t.countries || []).some((c) => ['US', 'GB'].includes(c)))).filter((t) => !(t.tags || []).includes('lumina-original')).map((t) => ({ title: t })) });
  push({ id: 'award-winning', title: 'Award-Winning Movies', items: titles.filter((t) => t.type === 'movie' && (t.awards || []).length).map((t) => ({ title: t })) });
  push({ id: 'documentaries', title: 'Popular Documentaries', href: '#/genres/Documentary', items: titles.filter((t) => (t.genres || []).includes('Documentary')).map((t) => ({ title: t })) });

  // 14. Your Watchlist.
  push({ id: 'watchlist', title: 'Your Watchlist', href: '#/my-list', items: watchlist.map((w) => ({ title: byId.get(w.titleId) })) });

  // 15. Because You Watched — anchored on the most recent title with history.
  const anchorId = useHistory ? (history[0]?.titleId || [...latestPerTitle.keys()][0]) : null;
  if (anchorId && byId.has(anchorId)) {
    const anchor = byId.get(anchorId);
    const items = similarTitles(anchor, titles.filter((t) => !seen.has(t.id) || t.id === anchor.id), 16).filter((t) => t.id !== anchor.id).map((t) => ({ title: t, reason: `Because you watched ${anchor.title}` }));
    push({ id: 'because', title: `Because You Watched ${anchor.title}`, items });
  }

  // Series row so shows are discoverable even without activity.
  push({ id: 'series', title: 'Series to Settle Into', href: '#/tv', items: titles.filter((t) => t.type === 'series').map((t) => ({ title: t })) });

  const featured = [...titles].filter((t) => t.featured).sort((a, b) => a.editorialRank - b.editorialRank);
  return {
    featured: (featured.length ? featured : [...titles].sort((a, b) => a.editorialRank - b.editorialRank)).slice(0, 6),
    rows,
  };
}

/** Tags that already have a row of their own on the home page. */
export const BUILT_IN_COLLECTION_TAGS = ['hidden-gem', 'lumina-original', 'japanese-cinema'];

/**
 * One row per admin-defined editorial collection with at least one visible title, in the
 * admin's order: { id: 'collection-<id>', title, subtitle?, href, items }.
 */
export function collectionRows(titles, collections = [], { skip = BUILT_IN_COLLECTION_TAGS } = {}) {
  const rows = [];
  for (const c of collections) {
    if (!c?.id || !c.name || skip.includes(c.id)) continue;
    const items = titles
      .filter((t) => (t.tags || []).includes(c.id))
      .sort((a, b) => (a.editorialRank ?? 1000) - (b.editorialRank ?? 1000) || a.title.localeCompare(b.title))
      .slice(0, 20)
      .map((t) => ({ title: t }));
    if (items.length) rows.push({ id: `collection-${c.id}`, title: c.name, subtitle: c.description || undefined, href: `#/search?tags=${encodeURIComponent(c.id)}`, items });
  }
  return rows;
}

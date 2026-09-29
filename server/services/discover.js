// The personalised Discover page. Every section is built from real catalog metadata, this
// profile's own activity, or measured platform activity; sections with nothing genuine to
// show are omitted rather than padded. Parental limits apply through catalog.published().
import { similarTitles, tasteProfile, tasteScore } from '../../js/core/similarity.js';
import { platformActivity } from './library.js';

const DAY = 86_400_000;
const MAX_ITEMS = 20;
const NEW_WINDOW_DAYS = 90;
const RELEASE_WINDOW_DAYS = 365;
const POPULAR_MIN_PROFILES = 2;

const hasAny = (list, wanted) => (list || []).some((x) => wanted.includes(x));

/** Editorial movie nights, defined purely by catalog metadata. */
export const THEMED_NIGHTS = [
  {
    id: 'quiet-night-in',
    title: 'A Quiet Night In',
    description: 'Relaxing, meditative picks for winding down.',
    match: (t) => hasAny(t.moods, ['relaxing', 'meditative']),
  },
  {
    id: 'mind-benders',
    title: 'Mind-Benders',
    description: 'Complex plots, surreal worlds and ideas that linger.',
    match: (t) => hasAny(t.moods, ['complex-plot', 'surreal', 'thought-provoking']),
  },
  {
    id: 'family-night',
    title: 'Family Movie Night',
    description: 'Family-friendly films rated PG / TV-PG or gentler.',
    match: (t) => t.type === 'movie' && t.minAge <= 8 && (hasAny(t.moods, ['family-friendly']) || hasAny(t.tags, ['family']) || hasAny(t.genres, ['Family'])),
  },
  {
    id: 'under-20',
    title: 'Under 20 Minutes',
    description: 'Complete stories and episodes you can finish in a short break.',
    match: (t) => t.runtimeMin > 0 && t.runtimeMin <= 20,
  },
];

export class DiscoverService {
  constructor(db, catalog, library) {
    this.db = db;
    this.catalog = catalog;
    this.library = library;
    this.activityCache = { at: 0, value: {} };
  }

  activity() {
    if (Date.now() - this.activityCache.at > 60_000) this.activityCache = { at: Date.now(), value: platformActivity(this.db) };
    return this.activityCache.value;
  }

  /** Creator display names for titles published from creator submissions. */
  creatorNames(ids) {
    const out = new Map();
    for (const id of ids) {
      const row = this.catalog.load().rowsById.get(id);
      if (row?.creator_account_id) out.set(id, row.creator_account_id);
    }
    if (!out.size) return out;
    const accountIds = [...new Set(out.values())];
    const names = new Map(this.db.all(`SELECT id, display_name FROM accounts WHERE id IN (${accountIds.map(() => '?').join(', ')})`, ...accountIds).map((a) => [a.id, a.display_name]));
    for (const [titleId, accountId] of out) out.set(titleId, names.get(accountId) || null);
    return out;
  }

  compose(profile, { now = Date.now() } = {}) {
    const titles = this.catalog.published(profile);
    const byId = new Map(titles.map((t) => [t.id, t]));
    const sections = [];
    const push = (s) => {
      const items = s.items.slice(0, MAX_ITEMS);
      if (items.length) sections.push({ ...s, items });
    };
    const byRank = (a, b) => (a.editorialRank ?? 1000) - (b.editorialRank ?? 1000) || a.title.localeCompare(b.title);

    // Personal signals (only this profile's own activity).
    let taste = new Map();
    let seen = new Set();
    let history = [];
    if (profile) {
      const s = this.library.homeSignals(profile);
      const useHistory = s.useHistory !== false;
      history = useHistory ? s.history.filter((h) => byId.has(h.titleId)) : [];
      const completed = s.progress.filter((p) => p.completed && byId.get(p.titleId)?.type === 'movie').map((p) => p.titleId);
      const seeds = [];
      if (useHistory) {
        for (const h of history.slice(0, 50)) seeds.push({ title: byId.get(h.titleId), weight: 1 });
        for (const id of completed) seeds.push({ title: byId.get(id), weight: 0.5 });
      }
      for (const w of s.watchlist) if (byId.has(w.titleId)) seeds.push({ title: byId.get(w.titleId), weight: 0.8 });
      for (const [id, r] of Object.entries(s.ratings || {})) if (byId.has(id)) seeds.push({ title: byId.get(id), weight: (r - 3) * 1.2 });
      taste = tasteProfile(seeds.filter((x) => x.title));
      seen = new Set([...(useHistory ? history.map((h) => h.titleId) : []), ...completed]);
    }

    // 1. New on Lumina for you — recently added titles that match this profile's taste.
    if (taste.size) {
      push({
        id: 'new-for-you',
        title: 'New on Lumina for you',
        description: `Added in the last ${NEW_WINDOW_DAYS} days and close to what you watch and save.`,
        items: titles
          .filter((t) => !seen.has(t.id) && t.addedAt && now - Date.parse(t.addedAt) <= NEW_WINDOW_DAYS * DAY)
          .map((t) => ({ t, s: tasteScore(taste, t) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || Date.parse(b.t.addedAt) - Date.parse(a.t.addedAt))
          .map((x) => ({ title: x.t })),
      });
    }

    // 2. Recently released — release date within the last year, newest first.
    push({
      id: 'recently-released',
      title: 'Recently released',
      description: 'Titles released in the past year.',
      items: titles
        .filter((t) => t.releaseDate && Date.parse(t.releaseDate) <= now && now - Date.parse(t.releaseDate) <= RELEASE_WINDOW_DAYS * DAY)
        .sort((a, b) => Date.parse(b.releaseDate) - Date.parse(a.releaseDate) || byRank(a, b))
        .map((t) => ({ title: t })),
    });

    // 3. Themed movie nights from catalog metadata.
    for (const night of THEMED_NIGHTS) {
      push({ id: night.id, title: night.title, description: night.description, items: titles.filter(night.match).sort(byRank).map((t) => ({ title: t })) });
    }

    // 4. Because you watched — anchored on the two most recent titles in history.
    for (const h of history.slice(0, 2)) {
      const anchor = byId.get(h.titleId);
      const items = similarTitles(anchor, titles.filter((t) => !seen.has(t.id)), MAX_ITEMS)
        .map((t) => ({ title: t, reason: `Because you watched ${anchor.title}` }));
      push({ id: `because-${anchor.id}`, title: `Because you watched ${anchor.title}`, description: 'Similar genres, moods and filmmakers.', items });
    }

    // 5. Popular on Lumina — distinct profiles watching in the last 14 days.
    const activity = this.activity();
    push({
      id: 'popular',
      title: 'Popular on Lumina',
      description: 'Watched by the most Lumina profiles in the last 14 days.',
      items: titles
        .filter((t) => (activity[t.id] || 0) >= POPULAR_MIN_PROFILES)
        .sort((a, b) => activity[b.id] - activity[a.id] || byRank(a, b))
        .map((t) => ({ title: t })),
    });

    // 6. Creator spotlight — work published by independent creators on Lumina.
    const creators = this.creatorNames(titles.map((t) => t.id));
    push({
      id: 'creator-spotlight',
      title: 'Creator spotlight',
      description: 'Independent work submitted and published by creators on Lumina.',
      items: titles
        .filter((t) => creators.has(t.id))
        .sort((a, b) => (Date.parse(b.publishedAt || b.addedAt) || 0) - (Date.parse(a.publishedAt || a.addedAt) || 0))
        .map((t) => ({ title: t, reason: creators.get(t.id) ? `By ${creators.get(t.id)}` : undefined })),
    });

    return { sections };
  }
}

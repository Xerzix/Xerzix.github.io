// Preview-mode backend for static hosting (GitHub Pages). It reads the published catalog
// snapshot (data/catalog.json) and keeps a device-local library in localStorage for a
// single "Guest" profile. It never pretends to have accounts, reviews, uploads or
// moderation: those calls throw ServerRequiredError.
import { ServerRequiredError, ApiError } from './client.js';
import { buildIndex, search, suggest, parseSearchParams } from '../core/search.js';
import { similarTitles } from '../core/similarity.js';
import { composeHome } from '../core/home-rows.js';
import { store } from '../core/storage.js';

const DEFAULT_PREFS = {
  appearance: {},
  subtitles: { size: 'medium', color: '#F8F5F2', background: 'shadow', position: 'bottom' },
  playback: { autoplayNext: true, skipIntro: false, skipCredits: false, defaultQuality: 'auto', saveProgress: true, dataSaver: false },
  home: { hiddenRows: [] },
  privacy: { useHistoryForRecommendations: true, statsEnabled: true },
};

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) && base?.[k] && typeof base[k] === 'object' ? deepMerge(base[k], v) : v;
  }
  return out;
}

const notInPreview = (feature) => () => {
  throw new ServerRequiredError(feature);
};

export async function createStaticBackend() {
  let snapshot;
  try {
    const res = await fetch('data/catalog.json', { cache: 'no-cache' });
    snapshot = await res.json();
  } catch {
    snapshot = { titles: [], media: {} };
  }
  const titles = snapshot.titles || [];
  const media = snapshot.media || {};
  const byId = new Map(titles.map((t) => [t.id, t]));
  const index = buildIndex(titles);
  const now = () => new Date().toISOString();

  // ── Device-local state ──
  const lib = () => store.get('local.library', { watchlist: [], progress: {}, history: [], collections: [], follows: [] });
  const saveLib = (l) => store.set('local.library', l);
  const profile = () => {
    const p = store.get('local.profile', null) || {};
    return {
      id: 'local',
      name: p.name || 'Guest',
      avatar: p.avatar || 'sakura',
      isKids: false,
      maxAge: null,
      hasPin: false,
      uiLanguage: p.uiLanguage || 'en',
      audioLanguage: p.audioLanguage || null,
      subtitleLanguage: p.subtitleLanguage || null,
      subtitlesDefault: !!p.subtitlesDefault,
      autoplayNext: p.autoplayNext !== false,
      autoplayPreviews: p.autoplayPreviews !== false,
      preferences: deepMerge(DEFAULT_PREFS, p.preferences || {}),
    };
  };

  const requireTitle = (id) => {
    const t = byId.get(id);
    if (!t) throw new ApiError(404, 'NOT_FOUND', 'That title is not in the Lumina catalog.');
    return t;
  };
  const allEpisodes = (t) => (t.seasons || []).flatMap((s) => s.episodes);
  const mediaFor = (titleId, episodeId, role = 'main') => Object.values(media).find((m) => m.titleId === titleId && m.role === role && (role !== 'main' || (episodeId ? m.episodeId === episodeId : !m.episodeId)));
  const progressKey = (titleId, episodeId) => `${titleId}::${episodeId || ''}`;

  function progressRows() {
    const l = lib();
    return Object.values(l.progress)
      .filter((p) => byId.has(p.titleId))
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .map((p) => {
        const t = byId.get(p.titleId);
        const ep = p.episodeId ? allEpisodes(t).find((e) => e.id === p.episodeId) : null;
        return { ...p, episode: ep || null };
      });
  }

  function nextEpisodeAfter(t, episodeId) {
    const eps = allEpisodes(t).filter((e) => e.hasMedia !== false);
    const i = eps.findIndex((e) => e.id === episodeId);
    return i >= 0 ? eps[i + 1] || null : null;
  }

  function signals() {
    const l = lib();
    const prefs = profile().preferences;
    const history = [...l.history].sort((a, b) => Date.parse(b.watchedAt) - Date.parse(a.watchedAt));
    const seen = new Set();
    return {
      progress: progressRows().map((p) => (p.completed && p.episodeId ? { ...p, nextEpisode: nextEpisodeAfter(byId.get(p.titleId), p.episodeId) } : p)),
      watchlist: [...l.watchlist].sort((a, b) => a.sortOrder - b.sortOrder).map((w) => ({ titleId: w.titleId, addedAt: w.addedAt })),
      history: history.filter((h) => (seen.has(h.titleId) ? false : seen.add(h.titleId))).map((h) => ({ titleId: h.titleId, watchedAt: h.watchedAt })),
      ratings: {},
      useHistory: prefs.privacy?.useHistoryForRecommendations !== false,
    };
  }

  const backend = {
    mode: 'static',
    session: {
      get: async () => ({
        mode: 'static',
        account: null,
        profile: profile(),
        profileCount: 1,
        elevated: false,
        plan: null,
        features: { registration: false, reviewComments: false, watchParties: false, sharedCollections: false, requireSigninToPlay: false, velviaProvider: 'local' },
        limits: { maxProfiles: 1 },
      }),
    },
    auth: { register: notInPreview('Creating an account'), login: notInPreview('Signing in'), logout: async () => null, forgot: notInPreview('Password recovery'), reset: notInPreview('Password recovery'), elevate: notInPreview('Account security') },
    account: new Proxy({}, { get: (_, k) => notInPreview('Account management') }),
    profiles: {
      list: async () => ({ profiles: [profile()], max: 1 }),
      create: notInPreview('Additional profiles'),
      update: async (id, d) => {
        const p = store.get('local.profile', {}) || {};
        store.set('local.profile', { ...p, ...d, preferences: deepMerge(p.preferences || {}, d.preferences || {}) });
        return { profile: profile() };
      },
      remove: notInPreview('Profile management'),
      select: async () => ({ profile: profile() }),
      setPin: notInPreview('Profile PINs'),
      updatePreferences: async (id, preferences) => {
        const p = store.get('local.profile', {}) || {};
        store.set('local.profile', { ...p, preferences: deepMerge(p.preferences || {}, preferences) });
        return { profile: profile() };
      },
    },
    catalog: {
      home: async () => composeHome(titles, signals()),
      titles: async (q) => search(index, { ...parseSearchParams(q || {}), q: '' }),
      title: async (id) => requireTitle(id),
      similar: async (id) => ({ items: similarTitles(requireTitle(id), titles, 12) }),
      search: async (q) => search(index, parseSearchParams(q || {})),
      suggest: async (q) => ({ suggestions: suggest(index, q) }),
      genres: async () => {
        const counts = new Map();
        for (const t of titles) for (const g of t.genres || []) counts.set(g, (counts.get(g) || 0) + 1);
        return { genres: [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.localeCompare(b.name)) };
      },
      playback: async (titleId, { episodeId, role } = {}) => {
        const t = requireTitle(titleId);
        const { seasons, credits, license, ...summary } = t;
        let episode = null;
        if (role !== 'trailer' && t.type === 'series') {
          const eps = allEpisodes(t);
          if (episodeId) episode = eps.find((e) => e.id === episodeId);
          if (!episode) {
            const last = progressRows().find((p) => p.titleId === titleId);
            episode = (last && (last.completed ? nextEpisodeAfter(t, last.episodeId) : eps.find((e) => e.id === last.episodeId))) || eps[0];
          }
        }
        const m = mediaFor(titleId, episode?.id, role === 'trailer' ? 'trailer' : 'main');
        if (!m) throw new ApiError(404, 'MEDIA_UNAVAILABLE', 'No playable media is available for this title yet.');
        const saved = lib().progress[progressKey(titleId, episode?.id)];
        const eps = t.type === 'series' ? allEpisodes(t).filter((e) => e.hasMedia !== false) : [];
        const i = episode ? eps.findIndex((e) => e.id === episode.id) : -1;
        return {
          titleId,
          title: summary,
          episode,
          media: { ...m },
          next: i >= 0 ? eps[i + 1] || null : null,
          previous: i > 0 ? eps[i - 1] : null,
          resumeAt: saved && !saved.completed ? saved.positionS : 0,
        };
      },
    },
    discover: {
      get: async () => {
        const home = composeHome(titles, signals());
        return { sections: home.rows.filter((r) => r.id !== 'continue') };
      },
    },
    library: {
      summary: async () => {
        const l = lib();
        const progress = {};
        for (const p of progressRows()) if (!progress[p.titleId]) progress[p.titleId] = p;
        return { watchlistIds: [...l.watchlist].sort((a, b) => a.sortOrder - b.sortOrder).map((w) => w.titleId), progress, ratings: {} };
      },
      watchlist: async () => ({ items: [...lib().watchlist].sort((a, b) => a.sortOrder - b.sortOrder).filter((w) => byId.has(w.titleId)).map((w) => ({ ...w, title: byId.get(w.titleId) })) }),
      addToList: async (titleId) => {
        requireTitle(titleId);
        const l = lib();
        if (!l.watchlist.some((w) => w.titleId === titleId)) {
          const min = Math.min(0, ...l.watchlist.map((w) => w.sortOrder));
          l.watchlist.push({ titleId, addedAt: now(), sortOrder: min - 1 });
        }
        saveLib(l);
        return { ok: true };
      },
      removeFromList: async (titleId) => {
        const l = lib();
        l.watchlist = l.watchlist.filter((w) => w.titleId !== titleId);
        saveLib(l);
        return { ok: true };
      },
      reorderList: async (ids) => {
        const l = lib();
        for (const w of l.watchlist) w.sortOrder = ids.indexOf(w.titleId) >= 0 ? ids.indexOf(w.titleId) : 9999;
        saveLib(l);
        return { ok: true };
      },
      continueWatching: async () => ({ items: progressRows().filter((p) => !p.completed && p.positionS >= 15).filter((p, i, arr) => arr.findIndex((x) => x.titleId === p.titleId) === i).map((p) => ({ ...p, title: byId.get(p.titleId) })) }),
      titleProgress: async (titleId) => ({ items: Object.values(lib().progress).filter((p) => p.titleId === titleId) }),
      saveProgress: async ({ titleId, episodeId = null, positionS, durationS = null, completed, watchedDelta = 0 }) => {
        requireTitle(titleId);
        if (profile().preferences.playback?.saveProgress === false) return { completed: false, positionS, durationS };
        const l = lib();
        const done = completed ?? !!(durationS && positionS / durationS >= 0.95);
        const ts = now();
        l.progress[progressKey(titleId, episodeId)] = { titleId, episodeId: episodeId || null, positionS, durationS, completed: done, updatedAt: ts };
        const last = [...l.history].reverse().find((h) => h.titleId === titleId && (h.episodeId || null) === (episodeId || null));
        if (last && Date.now() - Date.parse(last.updatedAt) < 30 * 60_000) {
          last.seconds += Math.round(Math.max(0, Math.min(watchedDelta, 60)));
          last.updatedAt = ts;
        } else {
          l.history.push({ id: Date.now(), titleId, episodeId: episodeId || null, watchedAt: ts, updatedAt: ts, seconds: Math.round(Math.max(0, Math.min(watchedDelta, 60))) });
          if (l.history.length > 2000) l.history.splice(0, l.history.length - 2000);
        }
        saveLib(l);
        return { completed: done, positionS, durationS, updatedAt: ts };
      },
      markWatched: async (titleId, episodeId) => {
        const t = requireTitle(titleId);
        const l = lib();
        const ts = now();
        const targets = t.type === 'series' && !episodeId ? allEpisodes(t).map((e) => e.id) : [episodeId || null];
        for (const ep of targets) l.progress[progressKey(titleId, ep)] = { titleId, episodeId: ep, positionS: 0, durationS: null, completed: true, updatedAt: ts };
        l.history.push({ id: Date.now(), titleId, episodeId: episodeId || null, watchedAt: ts, updatedAt: ts, seconds: 0 });
        saveLib(l);
        return { ok: true };
      },
      unmarkWatched: async (titleId) => {
        const l = lib();
        for (const k of Object.keys(l.progress)) if (l.progress[k].titleId === titleId) delete l.progress[k];
        saveLib(l);
        return { ok: true };
      },
      history: async (page = 1) => {
        const items = [...lib().history].filter((h) => byId.has(h.titleId)).sort((a, b) => Date.parse(b.watchedAt) - Date.parse(a.watchedAt));
        const pageSize = 50;
        return {
          total: items.length,
          page,
          pageSize,
          items: items.slice((page - 1) * pageSize, page * pageSize).map((h) => {
            const t = byId.get(h.titleId);
            const ep = h.episodeId ? allEpisodes(t).find((e) => e.id === h.episodeId) : null;
            return { ...h, title: t, episode: ep ? { id: ep.id, seasonNumber: ep.seasonNumber, number: ep.number, name: ep.name } : null };
          }),
        };
      },
      removeHistory: async (id) => {
        const l = lib();
        l.history = l.history.filter((h) => String(h.id) !== String(id));
        saveLib(l);
        return { ok: true };
      },
      clearHistory: async () => {
        const l = lib();
        l.history = [];
        l.progress = {};
        saveLib(l);
        return { ok: true };
      },
      stats: async () => {
        const { computeStats } = await import('../core/stats.js');
        return computeStats(lib().history, titles);
      },
    },
    collections: {
      list: async () => ({ items: lib().collections.map((c) => ({ ...c, itemCount: c.items.length, items: undefined, previews: c.items.slice(0, 4).map((i) => byId.get(i.titleId)).filter(Boolean) })) }),
      create: async ({ name, description = '' }) => {
        const l = lib();
        const c = { id: `col_${Date.now().toString(36)}`, name, description, visibility: 'private', items: [], createdAt: now(), updatedAt: now() };
        l.collections.push(c);
        saveLib(l);
        return { collection: c };
      },
      get: async (id) => {
        const c = lib().collections.find((x) => x.id === id);
        if (!c) throw new ApiError(404, 'NOT_FOUND', 'That collection no longer exists.');
        return { collection: { ...c, items: c.items.filter((i) => byId.has(i.titleId)).map((i) => ({ ...i, title: byId.get(i.titleId) })) } };
      },
      update: async (id, d) => {
        const l = lib();
        const c = l.collections.find((x) => x.id === id);
        if (!c) throw new ApiError(404, 'NOT_FOUND', 'That collection no longer exists.');
        if (d.visibility && d.visibility !== 'private') throw new ServerRequiredError('Sharing collections');
        Object.assign(c, { name: d.name ?? c.name, description: d.description ?? c.description, updatedAt: now() });
        saveLib(l);
        return { collection: c };
      },
      remove: async (id) => {
        const l = lib();
        l.collections = l.collections.filter((x) => x.id !== id);
        saveLib(l);
        return { ok: true };
      },
      addItem: async (id, titleId) => {
        requireTitle(titleId);
        const l = lib();
        const c = l.collections.find((x) => x.id === id);
        if (!c) throw new ApiError(404, 'NOT_FOUND', 'That collection no longer exists.');
        if (!c.items.some((i) => i.titleId === titleId)) c.items.push({ titleId, addedAt: now(), position: c.items.length });
        c.updatedAt = now();
        saveLib(l);
        return { ok: true };
      },
      removeItem: async (id, titleId) => {
        const l = lib();
        const c = l.collections.find((x) => x.id === id);
        if (c) c.items = c.items.filter((i) => i.titleId !== titleId);
        saveLib(l);
        return { ok: true };
      },
      shared: notInPreview('Shared collections'),
    },
    follows: {
      list: async () => ({ items: lib().follows }),
      follow: async (type, id) => {
        const l = lib();
        if (!l.follows.some((f) => f.type === type && f.id === id)) l.follows.push({ type, id, createdAt: now() });
        saveLib(l);
        return { ok: true };
      },
      unfollow: async (type, id) => {
        const l = lib();
        l.follows = l.follows.filter((f) => !(f.type === type && f.id === id));
        saveLib(l);
        return { ok: true };
      },
    },
    reviews: new Proxy({}, { get: (_, k) => (k === 'list' ? async () => ({ items: [], summary: null, mine: null, unavailable: true }) : notInPreview('Reviews and ratings')) }),
    quality: {
      report: notInPreview('Playback quality reports'),
      summary: async () => ({ unavailable: true }),
      session: async () => null,
      error: async () => null,
    },
    velvia: {
      status: async () => ({ provider: 'local', available: true, grounded: true, model: null, preview: true }),
      chat: async (payload) => {
        const { respond } = await import('../core/velvia-engine.js');
        // The engine honours options.useHistory and the profile's privacy preference
        // (signals().useHistory), and skips completed films using progress.
        return respond(titles, payload, signals());
      },
    },
    creators: new Proxy({}, { get: () => notInPreview('Creator submissions') }),
    uploads: new Proxy({}, { get: () => notInPreview('Uploads') }),
    notifications: {
      list: notInPreview('Notifications'),
      unreadCount: async () => ({ unread: 0 }),
      read: notInPreview('Notifications'),
      readAll: notInPreview('Notifications'),
      remove: notInPreview('Notifications'),
      prefs: notInPreview('Notification preferences'),
      setPrefs: notInPreview('Notification preferences'),
    },
    parties: new Proxy({}, { get: () => notInPreview('Watch parties') }),
  };
  return backend;
}

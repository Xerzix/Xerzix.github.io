// Personal library for the active profile: My List, progress, history and card state.
import { requireProfile } from '../auth/session.js';
import { v } from '../lib/validate.js';
import { rateLimit } from '../lib/security.js';

const progressSchema = v.object({
  titleId: v.string().max(80),
  episodeId: v.string().max(80).optional(),
  positionS: v.number().min(0).max(24 * 3600),
  durationS: v.number().min(0).max(24 * 3600).optional(),
  completed: v.boolean().optional(),
  watchedDelta: v.number().min(0).max(120).optional(),
});

export default function register(app, { db, services }) {
  const { library, catalog } = services;
  const withTitles = (rows, key = 'titleId') => {
    const byId = catalog.load().byId;
    return rows.filter((r) => byId.has(r[key])).map((r) => ({ ...r, title: byId.get(r[key]) }));
  };

  app.get('/api/library/summary', requireProfile, (ctx) => library.summary(ctx.profile.id));

  app.get('/api/library/watchlist', requireProfile, (ctx) => ({
    items: withTitles(library.watchlistIds(ctx.profile.id).map((w) => ({ titleId: w.title_id, addedAt: w.added_at, sortOrder: w.sort_order }))),
  }));

  app.put('/api/library/watchlist/:titleId', requireProfile, rateLimit('list', { max: 120, windowMs: 60_000, by: 'account' }), (ctx) => {
    library.addToList(ctx.profile, ctx.params.titleId);
    return { ok: true };
  });

  app.delete('/api/library/watchlist/:titleId', requireProfile, (ctx) => {
    library.removeFromList(ctx.profile.id, ctx.params.titleId);
    return { ok: true };
  });

  app.put('/api/library/watchlist-order', requireProfile, async (ctx) => {
    const { titleIds } = v.parse(v.object({ titleIds: v.array(v.string().max(80)).max(1000) }), await ctx.body());
    library.reorderList(ctx.profile.id, titleIds);
    return { ok: true };
  });

  app.get('/api/library/continue', requireProfile, (ctx) => {
    const rows = library.progressRows(ctx.profile.id).filter((p) => !p.completed && p.positionS >= 15);
    const seen = new Set();
    const latest = rows.filter((p) => (seen.has(p.titleId) ? false : seen.add(p.titleId)));
    return { items: withTitles(latest) };
  });

  app.put('/api/library/progress', requireProfile, rateLimit('progress', { max: 240, windowMs: 60_000, by: 'account' }), async (ctx) => {
    const body = v.parse(progressSchema, await ctx.body());
    return library.saveProgress(ctx.profile, body);
  });

  app.post('/api/library/watched', requireProfile, async (ctx) => {
    const { titleId, episodeId } = v.parse(v.object({ titleId: v.string().max(80), episodeId: v.string().max(80).optional() }), await ctx.body());
    library.markWatched(ctx.profile, titleId, episodeId || '');
    return { ok: true };
  });

  app.delete('/api/library/watched/:titleId', requireProfile, (ctx) => {
    library.unmarkWatched(ctx.profile.id, ctx.params.titleId);
    return { ok: true };
  });

  app.get('/api/library/history', requireProfile, (ctx) => {
    const page = Math.max(parseInt(ctx.query.page, 10) || 1, 1);
    const { total, pageSize, rows } = library.history(ctx.profile.id, { page, pageSize: 50 });
    const byId = catalog.load().byId;
    const episodeInfo = (id) => (id ? db.get('SELECT id, season_number AS seasonNumber, number, name FROM episodes WHERE id = ?', id) || null : null);
    return {
      total,
      page,
      pageSize,
      items: rows.filter((r) => byId.has(r.title_id)).map((r) => ({
        id: r.id,
        titleId: r.title_id,
        episodeId: r.episode_id || null,
        watchedAt: r.watched_at,
        seconds: r.seconds,
        episode: episodeInfo(r.episode_id),
        title: byId.get(r.title_id),
      })),
    };
  });

  app.delete('/api/library/history/:id', requireProfile, (ctx) => {
    library.removeHistoryEntry(ctx.profile.id, Number(ctx.params.id));
    return { ok: true };
  });

  app.delete('/api/library/history', requireProfile, (ctx) => {
    library.clearHistory(ctx.profile.id);
    return { ok: true };
  });
}

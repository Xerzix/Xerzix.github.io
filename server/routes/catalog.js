// Public catalog: home rows, browse, title details, search, suggestions and playback info.
import { composeHome } from '../../js/core/home-rows.js';
import { parseSearchParams } from '../../js/core/search.js';
import { unauthorized } from '../lib/errors.js';
import { rateLimit } from '../lib/security.js';
import { communityActivity, platformActivity } from '../services/library.js';

export default function register(app, { db, services, config }) {
  const { catalog, library } = services;

  let activityCache = { at: 0, activity: {}, community: {} };
  const activity = () => {
    if (Date.now() - activityCache.at > 60_000) activityCache = { at: Date.now(), activity: platformActivity(db), community: communityActivity(db) };
    return activityCache;
  };

  app.get('/api/home', (ctx) => {
    const titles = catalog.published(ctx.profile);
    const signals = ctx.profile ? library.homeSignals(ctx.profile) : {};
    const { activity: act, community } = activity();
    const home = composeHome(titles, { ...signals, activity: act, community });
    return { featured: home.featured, rows: home.rows };
  });

  app.get('/api/titles', (ctx) => {
    const params = parseSearchParams(ctx.query);
    return catalog.search({ ...params, q: '' }, ctx.profile);
  });

  app.get('/api/titles/:id', (ctx) => catalog.detail(ctx.params.id, { profile: ctx.profile }));

  app.get('/api/titles/:id/similar', (ctx) => ({ items: catalog.similar(ctx.params.id, ctx.profile, 12) }));

  app.get('/api/genres', (ctx) => ({ genres: catalog.genres(ctx.profile) }));

  app.get('/api/search', rateLimit('search', { max: 120, windowMs: 60_000 }), (ctx) => catalog.search(parseSearchParams(ctx.query), ctx.profile));

  app.get('/api/search/suggest', rateLimit('suggest', { max: 300, windowMs: 60_000 }), (ctx) => ({ suggestions: catalog.suggest(String(ctx.query.q || '').slice(0, 100), ctx.profile) }));

  // Playback descriptor. Anonymous playback is allowed unless REQUIRE_SIGNIN_TO_PLAY=true;
  // progress is only saved for signed-in profiles.
  app.get('/api/playback/:titleId', (ctx) => {
    if (config.features.requireSigninToPlay && !ctx.account) throw unauthorized('Sign in to watch.');
    const episodeId = ctx.query.episodeId || null;
    const role = ctx.query.role === 'trailer' ? 'trailer' : 'main';
    const resume = ctx.profile && role === 'main' ? library.resumeInfo(ctx.profile.id, ctx.params.titleId, episodeId) : null;
    const info = catalog.playback(ctx.params.titleId, episodeId, { profile: ctx.profile, account: ctx.account, role, progress: resume });
    if (resume && role === 'main') {
      const epResume = info.episode ? library.resumeInfo(ctx.profile.id, ctx.params.titleId, info.episode.id) : resume;
      info.resumeAt = epResume.positionS || 0;
    }
    return info;
  });
}

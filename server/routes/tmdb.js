// Live TMDB catalogue (/api/tmdb/*): public, read-only, rate-limited. The server holds the TMDB
// credential and answers with mapped JSON; see services/tmdb-catalog.js.
import { HttpError } from '../lib/errors.js';
import { rateLimit } from '../lib/security.js';
import { v } from '../lib/validate.js';
import { MAX_PAGE, TMDB_ATTRIBUTION, TmdbCatalog } from '../services/tmdb-catalog.js';

const type = v.enum(['movie', 'tv']);
const page = v.int().min(1).max(MAX_PAGE).default(1);
const listSchema = v.object({ page });
const trendingSchema = v.object({ type: v.enum(['all', 'movie', 'tv']).default('all'), window: v.enum(['day', 'week']).default('week'), page });
const discoverSchema = v.object({ genre: v.int().min(1).max(1_000_000), sort: v.enum(['popular', 'rating', 'newest']).default('popular'), page });
const searchSchema = v.object({ q: v.string().min(1).max(100), type: v.enum(['multi', 'movie', 'tv']).default('multi'), page });
const pathSchema = v.object({ type, id: v.int().min(1).max(100_000_000).optional() });

/** Query strings carry extra keys (cache busters and the like); only the schema's keys are read. */
function pick(schema, source) {
  const out = {};
  for (const k of Object.keys(schema.shape)) if (source[k] !== undefined && source[k] !== '') out[k] = source[k];
  return v.parse(schema, out);
}

export default function register(app, { services, config }) {
  services.tmdb ??= new TmdbCatalog(config);
  const tmdb = services.tmdb;
  const limit = rateLimit('tmdb', { max: 240, windowMs: 60_000 });

  // Every data endpoint answers 503 TMDB_NOT_CONFIGURED until a credential is set, so the
  // interface can say so plainly instead of showing an empty catalogue.
  const requireConfigured = () => {
    if (!tmdb.configured()) {
      throw new HttpError(503, 'TMDB_NOT_CONFIGURED', 'The TMDB catalogue is not set up on this server yet. An administrator needs to set TMDB_API_KEY (or TMDB_API_TOKEN).');
    }
  };
  const cached = (ctx, seconds) => ctx.setHeader('Cache-Control', `public, max-age=${seconds}`);

  app.get('/api/tmdb/status', () => ({ configured: tmdb.configured(), attribution: TMDB_ATTRIBUTION }));

  app.get('/api/tmdb/genres', limit, requireConfigured, async (ctx) => {
    cached(ctx, 3600);
    return tmdb.genres();
  });

  app.get('/api/tmdb/trending', limit, requireConfigured, async (ctx) => {
    cached(ctx, 300);
    return tmdb.trending(pick(trendingSchema, ctx.query));
  });

  app.get('/api/tmdb/search', limit, requireConfigured, async (ctx) => {
    cached(ctx, 120);
    return tmdb.search(pick(searchSchema, ctx.query));
  });

  app.get('/api/tmdb/:type/popular', limit, requireConfigured, async (ctx) => {
    const { type: t } = v.parse(pathSchema, { type: ctx.params.type });
    cached(ctx, 300);
    return tmdb.popular({ type: t, ...pick(listSchema, ctx.query) });
  });

  app.get('/api/tmdb/:type/top-rated', limit, requireConfigured, async (ctx) => {
    const { type: t } = v.parse(pathSchema, { type: ctx.params.type });
    cached(ctx, 300);
    return tmdb.topRated({ type: t, ...pick(listSchema, ctx.query) });
  });

  app.get('/api/tmdb/:type/discover', limit, requireConfigured, async (ctx) => {
    const { type: t } = v.parse(pathSchema, { type: ctx.params.type });
    cached(ctx, 300);
    return tmdb.discover({ type: t, ...pick(discoverSchema, ctx.query) });
  });

  app.get('/api/tmdb/:type/:id', limit, requireConfigured, async (ctx) => {
    if (!/^\d+$/.test(ctx.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Unknown API endpoint.');
    const p = v.parse(pathSchema, { type: ctx.params.type, id: ctx.params.id });
    cached(ctx, 900);
    return tmdb.details(p);
  });
}

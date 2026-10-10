// Title artwork: the TMDB image cache (public) and the staff sync tools (/api/admin/artwork).
// See services/artwork.js for how titles are matched and why artwork never implies playback.
import { requireStaff } from '../auth/session.js';
import { HttpError } from '../lib/errors.js';
import { rateLimit } from '../lib/security.js';
import { sendFile } from '../lib/static.js';
import { v } from '../lib/validate.js';
import { ArtworkService } from '../services/artwork.js';
import { audit } from '../services/audit.js';

const syncSchema = v.object({
  ids: v.array(v.string().max(120)).max(500).optional(),
  force: v.boolean().optional(),
});
const titleSyncSchema = v.object({
  tmdbId: v.int().min(1).max(100_000_000).optional(),
  tmdbType: v.enum(['movie', 'tv']).optional(),
  force: v.boolean().optional(),
  unlock: v.boolean().optional(),
});

export default function register(app, { db, services, config }) {
  services.artwork ??= new ArtworkService(db, config, { catalog: services.catalog });
  const artwork = services.artwork;
  const syncLimit = rateLimit('artwork-sync', { max: 20, windowMs: 3600_000, by: 'account' });

  // Cached TMDB images, same-origin. Only files referenced by a catalog title or episode are
  // fetched, so this is not an open image proxy. A miss or an unreachable CDN is a 404, and the
  // interface shows the Lumina fallback artwork instead.
  app.get('/media/artwork/tmdb/:size/:file', async (ctx) => {
    const path = await artwork.cachedImage(ctx.params.size, ctx.params.file);
    if (!path) throw new HttpError(404, 'NOT_FOUND', 'That image is not available.');
    await sendFile(ctx, path, { cache: 'public, max-age=31536000, immutable' });
  });

  app.get('/api/admin/artwork', ...requireStaff, () => ({
    configured: artwork.configured(),
    attribution: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    titles: artwork.status(),
  }));

  app.post('/api/admin/artwork/sync', ...requireStaff, syncLimit, async (ctx) => {
    const body = v.parse(syncSchema, await ctx.body());
    const out = await artwork.syncAll({ ids: body.ids, force: !!body.force });
    audit(db, ctx, 'content.artwork_sync', { targetType: 'catalog', targetId: 'all', details: out.summary });
    return out;
  });

  app.post('/api/admin/titles/:id/artwork', ...requireStaff, syncLimit, async (ctx) => {
    const body = v.parse(titleSyncSchema, await ctx.body());
    const result = await artwork.syncTitle(ctx.params.id, body);
    audit(db, ctx, 'content.artwork_sync', { targetType: 'title', targetId: ctx.params.id, details: { status: result.status, tmdbId: result.tmdbId ?? body.tmdbId ?? null } });
    return result;
  });
}

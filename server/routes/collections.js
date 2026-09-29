// Personal collections (profile) and the public read-only view of unlisted collections.
import { requireProfile } from '../auth/session.js';
import { forbidden, notFound } from '../lib/errors.js';
import { rateLimit } from '../lib/security.js';
import { v } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { CollectionService } from '../services/collections.js';

const VISIBILITY = ['private', 'unlisted'];

const createSchema = v.object({
  name: v.string().min(1).max(80),
  description: v.string().max(500).default(''),
  visibility: v.enum(VISIBILITY).default('private'),
});

const patchSchema = v.object({
  name: v.string().min(1).max(80).optional(),
  description: v.string().max(500).nullable().optional(),
  visibility: v.enum(VISIBILITY).optional(),
});

const itemSchema = v.object({ note: v.string().max(280).nullable().optional() });

export default function register(app, { db, services, config }) {
  services.collections ??= new CollectionService(db, services.catalog, { publicUrl: config.publicUrl });
  const collections = services.collections;
  const { library } = services;

  const assertSharingAllowed = (visibility) => {
    if (visibility === 'unlisted' && !config.features.sharedCollections) {
      throw forbidden('Sharing collections is turned off on this Lumina server.', 'FEATURE_DISABLED');
    }
  };

  app.get('/api/collections', requireProfile, (ctx) => ({ items: collections.list(ctx.profile) }));

  app.post('/api/collections', requireProfile, rateLimit('collections', { max: 30, windowMs: 60_000, by: 'account' }), async (ctx) => {
    const body = v.parse(createSchema, await ctx.body());
    assertSharingAllowed(body.visibility);
    const collection = collections.create(ctx.profile, body);
    if (collection.visibility === 'unlisted') audit(db, ctx, 'collection.share', { targetType: 'collection', targetId: collection.id, details: { visibility: 'unlisted' } });
    ctx.json({ collection }, 201);
  });

  app.get('/api/collections/:id', requireProfile, (ctx) => ({ collection: collections.get(ctx.profile, ctx.params.id) }));

  app.patch('/api/collections/:id', requireProfile, rateLimit('collections-edit', { max: 120, windowMs: 60_000, by: 'account' }), async (ctx) => {
    const body = v.parse(patchSchema, await ctx.body());
    assertSharingAllowed(body.visibility);
    const { collection, visibilityChanged, previous } = collections.update(ctx.profile, ctx.params.id, body);
    if (visibilityChanged) {
      // Sharing makes profile-authored text publicly reachable, so it is recorded for moderation.
      audit(db, ctx, collection.visibility === 'unlisted' ? 'collection.share' : 'collection.unshare', {
        targetType: 'collection', targetId: collection.id, details: { from: previous, to: collection.visibility },
      });
    }
    return { collection };
  });

  app.delete('/api/collections/:id', requireProfile, (ctx) => {
    collections.remove(ctx.profile, ctx.params.id);
    return { ok: true };
  });

  app.put('/api/collections/:id/items/:titleId', requireProfile, rateLimit('collection-items', { max: 240, windowMs: 60_000, by: 'account' }), async (ctx) => {
    const { note } = v.parse(itemSchema, await ctx.body());
    // Only titles this profile is allowed to see can be added (404 / 403 PROFILE_RESTRICTED otherwise).
    collections.own(ctx.profile.id, ctx.params.id);
    library.assertVisible(ctx.profile, ctx.params.titleId);
    collections.addItem(ctx.profile, ctx.params.id, ctx.params.titleId, { note });
    return { ok: true };
  });

  app.delete('/api/collections/:id/items/:titleId', requireProfile, (ctx) => {
    collections.removeItem(ctx.profile, ctx.params.id, ctx.params.titleId);
    return { ok: true };
  });

  // Public, read-only. Tokens are 144-bit random values; the limiter blunts guessing anyway.
  app.get('/api/shared/collections/:token', rateLimit('shared-collection', { max: 60, windowMs: 60_000 }), (ctx) => {
    if (!config.features.sharedCollections) throw forbidden('Shared collections are turned off on this Lumina server.', 'FEATURE_DISABLED');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(ctx.params.token)) throw notFound('This shared collection is not available. The link may have been turned off.');
    return { collection: collections.shared(ctx.params.token, ctx.profile) };
  });
}


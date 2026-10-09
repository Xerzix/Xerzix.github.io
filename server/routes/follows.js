// Follows for the active profile: series, creators and genres. Other slices read the
// `follows` table to notify followers about new episodes and releases.
import { requireProfile } from '../auth/session.js';
import { now } from '../db/index.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { rateLimit } from '../lib/security.js';

const TYPES = ['series', 'creator', 'genre'];
const MAX_FOLLOWS = 500;

export default function register(app, { db, services }) {
  const { catalog, library } = services;

  /** Validates the follow target and returns its canonical id. */
  function resolveTarget(profile, type, rawId) {
    const id = String(rawId || '').slice(0, 120);
    if (!TYPES.includes(type)) throw badRequest('You can follow a series, a creator or a genre.');
    if (!id) throw badRequest('Choose something to follow.');
    if (type === 'series') {
      const t = library.assertVisible(profile, id);
      if (t.type !== 'series') throw notFound('That series is not in the Lumina catalog.');
      return t.id;
    }
    if (type === 'genre') {
      const genre = catalog.genres(profile).find((g) => g.name.toLowerCase() === id.toLowerCase());
      if (!genre) throw notFound('That genre is not in the Lumina catalog.');
      return genre.name;
    }
    const creator = db.get('SELECT id FROM accounts WHERE id = ? AND is_creator = 1', id);
    if (!creator) throw notFound('That creator is not on Lumina.');
    return creator.id;
  }

  app.get('/api/follows', requireProfile, (ctx) => {
    const byId = catalog.load().byId;
    const rows = db.all('SELECT target_type, target_id, created_at FROM follows WHERE profile_id = ? ORDER BY created_at DESC', ctx.profile.id);
    return {
      items: rows.map((r) => ({
        type: r.target_type,
        id: r.target_id,
        createdAt: r.created_at,
        ...(r.target_type === 'series' && byId.has(r.target_id) ? { title: byId.get(r.target_id) } : {}),
      })),
    };
  });

  app.put('/api/follows/:type/:id', requireProfile, rateLimit('follows', { max: 120, windowMs: 60_000, by: 'account' }), (ctx) => {
    const type = ctx.params.type;
    const id = resolveTarget(ctx.profile, type, ctx.params.id);
    const exists = db.get('SELECT 1 FROM follows WHERE profile_id = ? AND target_type = ? AND target_id = ?', ctx.profile.id, type, id);
    if (!exists) {
      const { n } = db.get('SELECT COUNT(*) AS n FROM follows WHERE profile_id = ?', ctx.profile.id);
      if (n >= MAX_FOLLOWS) throw conflict(`A profile can follow up to ${MAX_FOLLOWS} series, creators and genres.`, 'FOLLOW_LIMIT', { max: MAX_FOLLOWS });
      db.run('INSERT OR IGNORE INTO follows (profile_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)', ctx.profile.id, type, id, now());
    }
    return { ok: true, following: true };
  });

  app.delete('/api/follows/:type/:id', requireProfile, (ctx) => {
    if (!TYPES.includes(ctx.params.type)) throw badRequest('You can follow a series, a creator or a genre.');
    // Unfollowing never needs the target to still exist (a series may have been unpublished).
    db.run('DELETE FROM follows WHERE profile_id = ? AND target_type = ? AND target_id = ?', ctx.profile.id, ctx.params.type, String(ctx.params.id).slice(0, 120));
    if (ctx.params.type === 'genre') {
      db.run('DELETE FROM follows WHERE profile_id = ? AND target_type = ? AND lower(target_id) = lower(?)', ctx.profile.id, 'genre', String(ctx.params.id).slice(0, 120));
    }
    return { ok: true, following: false };
  });
}

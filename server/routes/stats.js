// Private viewing statistics for the active profile (only the profile itself can read them).
import { requireProfile } from '../auth/session.js';
import { StatsService } from '../services/stats.js';

export default function register(app, { db, services }) {
  services.stats ??= new StatsService(db, services.catalog);
  const stats = services.stats;

  app.get('/api/library/stats', requireProfile, (ctx) => stats.forProfile(ctx.profile));
}

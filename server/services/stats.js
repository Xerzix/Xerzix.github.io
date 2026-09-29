// Private viewing statistics for the active profile. The numbers come only from this
// profile's own history rows (see js/core/stats.js) and are never shared or aggregated.
import { parseJson } from '../db/index.js';
import { computeStats } from '../../js/core/stats.js';

export function statsEnabled(profile) {
  return parseJson(profile?.preferences, {})?.privacy?.statsEnabled !== false;
}

export class StatsService {
  constructor(db, catalog) {
    this.db = db;
    this.catalog = catalog;
  }

  forProfile(profile, { now = Date.now() } = {}) {
    if (!statsEnabled(profile)) return { enabled: false };
    const history = this.db.all(
      'SELECT title_id AS titleId, episode_id AS episodeId, watched_at AS watchedAt, seconds FROM history WHERE profile_id = ? ORDER BY watched_at DESC LIMIT 20000',
      profile.id,
    );
    const progress = this.db.all(
      `SELECT title_id AS titleId, episode_id AS episodeId, completed FROM progress WHERE profile_id = ? AND completed = 1 AND episode_id <> ''`,
      profile.id,
    ).map((p) => ({ ...p, completed: !!p.completed }));
    return computeStats(history, this.catalog.load().summaries, { now, progress });
  }
}

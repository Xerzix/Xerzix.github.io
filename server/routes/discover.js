// Personalised discovery page. Public: anonymous visitors get the non-personal sections;
// the active profile's parental limits always apply.
import { DiscoverService } from '../services/discover.js';

export default function register(app, { db, services }) {
  services.discover ??= new DiscoverService(db, services.catalog, services.library);
  const discover = services.discover;

  app.get('/api/discover', (ctx) => discover.compose(ctx.profile));
}

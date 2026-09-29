// Session bootstrap for the frontend and a public health probe.
import { accountDto, profileDto } from '../services/dto.js';
import { planSummary } from '../services/entitlements.js';

const startedAt = Date.now();

export default function register(app, { db, config }) {
  app.get('/api/health', () => ({ status: 'ok', service: 'lumina', uptimeS: Math.round((Date.now() - startedAt) / 1000) }));

  app.get('/api/session', (ctx) => {
    const profileCount = ctx.account ? db.get('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', ctx.account.id).n : 0;
    return {
      mode: 'server',
      account: accountDto(ctx.account),
      profile: profileDto(ctx.profile),
      profileCount,
      elevated: !!(ctx.session?.elevatedUntil && ctx.session.elevatedUntil > new Date().toISOString()),
      plan: ctx.account ? planSummary(ctx.account) : null,
      features: {
        registration: config.auth.allowRegistration,
        reviewComments: config.features.communityComments,
        watchParties: config.features.watchParties,
        sharedCollections: config.features.sharedCollections,
        requireSigninToPlay: config.features.requireSigninToPlay,
        velviaProvider: config.velvia.provider,
      },
      limits: { maxProfiles: ctx.account?.max_profiles ?? config.profiles.maxPerAccount },
    };
  });
}

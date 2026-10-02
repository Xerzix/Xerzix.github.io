// Session bootstrap for the frontend and a public health probe.
import { declareSettingConsumer, readPlatformSettings } from '../services/admin/settings.js';
import { accountDto, profileDto } from '../services/dto.js';
import { planSummary } from '../services/entitlements.js';

const startedAt = Date.now();

export default function register(app, { db, config }) {
  // js/app.js shows the admin maintenance message to everyone.
  declareSettingConsumer('maintenanceMessage');
  app.get('/api/health', () => ({ status: 'ok', service: 'lumina', uptimeS: Math.round((Date.now() - startedAt) / 1000) }));

  app.get('/api/session', (ctx) => {
    const profileCount = ctx.account ? db.get('SELECT COUNT(*) AS n FROM profiles WHERE account_id = ?', ctx.account.id).n : 0;
    const platform = readPlatformSettings(db);
    return {
      mode: 'server',
      account: accountDto(ctx.account),
      profile: profileDto(ctx.profile),
      profileCount,
      elevated: !!(ctx.session?.elevatedUntil && ctx.session.elevatedUntil > new Date().toISOString()),
      plan: ctx.account ? planSummary(ctx.account) : null,
      features: {
        registration: platform.registrationOpen,
        reviewComments: config.features.communityComments,
        watchParties: platform.watchPartiesEnabled,
        sharedCollections: config.features.sharedCollections,
        requireSigninToPlay: config.features.requireSigninToPlay,
        velviaProvider: config.velvia.provider,
      },
      limits: { maxProfiles: ctx.account?.max_profiles ?? config.profiles.maxPerAccount },
      notice: platform.maintenanceMessage ? { message: platform.maintenanceMessage } : null,
    };
  });
}

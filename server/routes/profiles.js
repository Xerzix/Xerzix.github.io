// Profiles (up to 5 per account — they share one account and are not separate subscriptions
// or streams), PIN locks, parental controls and per-profile preferences.
// See docs/API.md → Profiles.
//
// Parental-control rules enforced here:
//  • PIN-protected profiles need their PIN to be selected, edited, deleted or re-PINned. The
//    active profile may change its own everyday settings without re-entering the PIN, but
//    never its maturity settings.
//  • While a restricted profile is active (a kids profile, or any profile with a maturity
//    limit), the session cannot add or delete profiles, set PINs, edit other profiles or
//    change any maturity setting — not even with that profile's own PIN, which its viewer
//    knows. A grown-up re-entering the account password (POST /api/auth/elevate) allows one
//    such change; the confirmation then ends (see parentalGuard). This is also how a
//    forgotten PIN is reset.
import { requireAuth } from '../auth/session.js';
import { hashPassword, verifyPassword } from '../lib/crypto.js';
import { rateLimit } from '../lib/security.js';
import { patterns, v } from '../lib/validate.js';
import { isElevated } from '../services/accounts.js';
import { audit } from '../services/audit.js';
import { profileDto } from '../services/dto.js';
import { createProfileSchema, parentalGuard, pinError, preferencesSchema, ProfileService, updateProfileSchema } from '../services/profiles.js';

const pinAttempts = (profileId) => rateLimit('profile-pin', { max: 5, windowMs: 5 * 60_000, by: () => profileId });

/**
 * Enforces a profile's PIN. `allowActive`: the session's active profile (entered with its PIN)
 * may skip it. `allowElevated`: the account owner, after re-entering the account password,
 * may skip it (the "forgot PIN" path). A PIN that is supplied is always checked, so a client
 * can use any of these endpoints to confirm a PIN before showing protected settings.
 */
async function checkPin(ctx, profile, pin, { allowActive = false, allowElevated = true, field = 'pin' } = {}) {
  if (!profile.pin_hash) return;
  const exempt = (allowActive && ctx.session?.profileId === profile.id) || (allowElevated && isElevated(ctx));
  if (exempt && !pin) return;
  if (!pin) throw pinError('PIN_REQUIRED', field);
  pinAttempts(profile.id)(ctx);
  if (!(await verifyPassword(String(pin), profile.pin_hash))) throw pinError('PIN_INVALID', field);
}

export default function register(app, { db, services }) {
  const profiles = (services.profiles ??= new ProfileService(db));
  const dto = (p) => ({ profile: profileDto(p) });
  const guard = (ctx) => parentalGuard(db, ctx, { message: 'Profiles can only be managed by a grown-up while this profile is active. Switch to a grown-up profile, or confirm the account password to continue.' });

  app.get('/api/profiles', requireAuth, (ctx) => ({
    profiles: profiles.list(ctx.account.id).map(profileDto),
    max: ctx.account.max_profiles,
  }));

  app.post('/api/profiles', requireAuth, async (ctx) => {
    const data = v.parse(createProfileSchema, await ctx.body());
    guard(ctx);
    const profile = profiles.create(ctx.account, data);
    audit(db, ctx, 'profile.create', { targetType: 'profile', targetId: profile.id, details: { isKids: !!profile.is_kids, maxAge: profile.max_age } });
    return dto(profile);
  });

  app.patch('/api/profiles/:id', requireAuth, async (ctx) => {
    const profile = profiles.get(ctx.account.id, ctx.params.id);
    const data = v.parse(updateProfileSchema, await ctx.body());
    const maturityChange = (data.isKids !== undefined && data.isKids !== !!profile.is_kids)
      || (data.maxAge !== undefined && data.maxAge !== profile.max_age);
    if (profile.id !== ctx.profile?.id || maturityChange) guard(ctx);
    await checkPin(ctx, profile, data.pin, { allowActive: !maturityChange });
    delete data.pin;
    const updated = profiles.update(ctx.account.id, profile, data);
    if (maturityChange) {
      audit(db, ctx, 'profile.maturity_change', { targetType: 'profile', targetId: profile.id, details: { isKids: !!updated.is_kids, maxAge: updated.max_age } });
    }
    return dto(updated);
  });

  app.delete('/api/profiles/:id', requireAuth, async (ctx) => {
    const profile = profiles.get(ctx.account.id, ctx.params.id);
    const { pin } = v.parse(v.object({ pin: v.string().max(12).optional() }), await ctx.body());
    guard(ctx);
    await checkPin(ctx, profile, pin);
    profiles.remove(ctx.account.id, profile);
    audit(db, ctx, 'profile.delete', { targetType: 'profile', targetId: profile.id });
  });

  app.post('/api/profiles/:id/select', requireAuth, async (ctx) => {
    const profile = profiles.get(ctx.account.id, ctx.params.id);
    const { pin } = v.parse(v.object({ pin: v.string().max(12).optional() }), await ctx.body());
    // Entering a locked profile always needs its PIN, even for the account owner.
    await checkPin(ctx, profile, pin, { allowActive: true, allowElevated: false });
    profiles.select(ctx.session.id, profile);
    ctx.session.profileId = profile.id;
    return dto(profile);
  });

  app.put('/api/profiles/:id/pin', requireAuth, async (ctx) => {
    const profile = profiles.get(ctx.account.id, ctx.params.id);
    const body = v.parse(v.object({
      pin: v.string().pattern(patterns.pin, 'Use exactly 4 digits.').nullable(),
      currentPin: v.string().max(12).optional(),
    }), await ctx.body());
    guard(ctx);
    await checkPin(ctx, profile, body.currentPin, { field: 'currentPin' });
    const updated = profiles.setPinHash(ctx.account.id, profile.id, body.pin ? await hashPassword(body.pin) : null);
    audit(db, ctx, body.pin ? 'profile.pin_set' : 'profile.pin_remove', { targetType: 'profile', targetId: profile.id });
    return dto(updated);
  });

  app.put('/api/profiles/:id/preferences', requireAuth, async (ctx) => {
    const profile = profiles.get(ctx.account.id, ctx.params.id);
    const raw = await ctx.body();
    const { preferences } = v.parse(preferencesSchema, raw);
    const { pin } = v.parse(v.object({ pin: v.string().max(12).optional() }), raw);
    if (profile.id !== ctx.profile?.id) guard(ctx);
    await checkPin(ctx, profile, pin, { allowActive: true });
    return dto(profiles.updatePreferences(ctx.account.id, profile, preferences));
  });
}

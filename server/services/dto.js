// Maps database rows to the JSON shapes the API returns. Keeping this in one place
// guarantees secrets (password/PIN hashes, TOTP seeds) never leak into responses.
import { parseJson } from '../db/index.js';

export function accountDto(a) {
  if (!a) return null;
  return {
    id: a.id,
    email: a.email,
    displayName: a.display_name,
    role: a.role,
    isCreator: !!a.is_creator,
    status: a.status,
    totpEnabled: !!a.totp_enabled,
    emailVerified: !!a.email_verified_at,
    maxProfiles: a.max_profiles,
    createdAt: a.created_at,
  };
}

export const DEFAULT_PROFILE_PREFERENCES = {
  appearance: {
    preset: 'velvet-garden',
    custom: null, // { bg, bg2, surface, accent, accentStrong, button, text, text2, gold }
    environment: 'sakura',
    animation: true,
    petalIntensity: 0.6,
    ambientLight: 0.6,
    parallax: true,
    density: 'comfortable',
    translucent: true,
    ambientMode: true,
    heroAutoRotate: true,
  },
  subtitles: { size: 'medium', color: '#F8F5F2', background: 'shadow', position: 'bottom' },
  playback: { autoplayNext: true, skipIntro: false, skipCredits: false, defaultQuality: 'auto', saveProgress: true, dataSaver: false },
  home: { hiddenRows: [] },
  privacy: { useHistoryForRecommendations: true, statsEnabled: true },
};

export function mergePreferences(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = mergePreferences(base[k], v);
    else out[k] = v;
  }
  return out;
}

export function profileDto(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    avatar: p.avatar,
    isKids: !!p.is_kids,
    maxAge: p.max_age ?? null,
    hasPin: !!p.pin_hash,
    uiLanguage: p.ui_language,
    audioLanguage: p.audio_language,
    subtitleLanguage: p.subtitle_language,
    subtitlesDefault: !!p.subtitles_default,
    autoplayNext: !!p.autoplay_next,
    autoplayPreviews: !!p.autoplay_previews,
    preferences: mergePreferences(DEFAULT_PROFILE_PREFERENCES, parseJson(p.preferences, {})),
    createdAt: p.created_at,
  };
}

// Appearance: theme presets, custom colours with contrast checking, environments,
// animation, density and translucency. Applies everything to <html> as CSS variables and
// data attributes; persistence is handled by the caller (profile preferences).
import { contrastRatio, ensureContrast, luminance, mix, readableOn } from './core/contrast.js';
import { applyEnvironment } from './fx/garden.js';

export const THEME_KEYS = ['bg', 'bg2', 'surface', 'accent', 'accentStrong', 'button', 'text', 'text2', 'gold'];

export const THEME_LABELS = {
  bg: 'Primary background',
  bg2: 'Secondary background',
  surface: 'Card background',
  accent: 'Accent colour',
  accentStrong: 'Highlight colour',
  button: 'Button colour',
  text: 'Text colour',
  text2: 'Secondary text',
  gold: 'Decorative accent',
};

export const PRESETS = [
  {
    id: 'velvet-garden', name: 'Original Velvet Garden', environment: 'sakura',
    colors: { bg: '#080808', bg2: '#141414', surface: '#121011', accent: '#781b32', accentStrong: '#b52b49', button: '#781b32', text: '#f8f5f2', text2: '#b8b3b4', gold: '#c6a46a' },
  },
  {
    id: 'midnight-sakura', name: 'Midnight Sakura', environment: 'sakura',
    colors: { bg: '#07060b', bg2: '#120f1a', surface: '#15111d', accent: '#8a2c55', accentStrong: '#d0507f', button: '#8a2c55', text: '#f7f2f6', text2: '#bdb2bf', gold: '#e3b7c8' },
  },
  {
    id: 'crimson-temple', name: 'Crimson Temple', environment: 'lantern',
    colors: { bg: '#0a0505', bg2: '#1a0b0c', surface: '#1c0e0f', accent: '#9e1b2f', accentStrong: '#d8344c', button: '#9e1b2f', text: '#fbf3ef', text2: '#c4aba8', gold: '#d4a05a' },
  },
  {
    id: 'moonlit-garden', name: 'Moonlit Garden', environment: 'moonlit',
    colors: { bg: '#05080d', bg2: '#0e141c', surface: '#111923', accent: '#4a5f88', accentStrong: '#8fa6d6', button: '#3e5277', text: '#eef2f7', text2: '#a9b3c2', gold: '#cfc7a4' },
  },
  {
    id: 'golden-pavilion', name: 'Golden Pavilion', environment: 'autumn',
    colors: { bg: '#0b0906', bg2: '#17130c', surface: '#1a150d', accent: '#8c6a2e', accentStrong: '#d2a94f', button: '#7d5d24', text: '#fbf6ea', text2: '#c9bfa8', gold: '#e3c27a' },
  },
  {
    id: 'minimal-black', name: 'Minimal Black', environment: 'none',
    colors: { bg: '#000000', bg2: '#0d0d0d', surface: '#101010', accent: '#781b32', accentStrong: '#b52b49', button: '#2a2a2a', text: '#ffffff', text2: '#a8a8a8', gold: '#9a9a9a' },
  },
];

export const DEFAULT_APPEARANCE = {
  preset: 'velvet-garden',
  custom: null,
  environment: 'sakura',
  animation: true,
  petalIntensity: 0.6,
  ambientLight: 0.6,
  parallax: true,
  density: 'comfortable',
  translucent: true,
  ambientMode: true,
  heroAutoRotate: true,
  motion: 'system', // system | reduced | full
};

export function presetById(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS[0];
}

/** The effective colour set for an appearance object. */
export function resolveColors(appearance) {
  if (appearance?.preset === 'custom' && appearance.custom) return { ...PRESETS[0].colors, ...appearance.custom };
  return { ...presetById(appearance?.preset).colors };
}

/**
 * Readability report for a colour set. Each check has { id, label, ratio, min, ok, severity }.
 * AA body text needs 4.5:1; large text and UI elements need 3:1.
 */
export function checkContrast(c) {
  const checks = [
    { id: 'text-bg', label: 'Text on primary background', fg: c.text, bg: c.bg, min: 4.5 },
    { id: 'text-bg2', label: 'Text on secondary background', fg: c.text, bg: c.bg2, min: 4.5 },
    { id: 'text-surface', label: 'Text on cards', fg: c.text, bg: c.surface, min: 4.5 },
    { id: 'text2-bg', label: 'Secondary text on background', fg: c.text2, bg: c.bg, min: 4.5 },
    { id: 'button', label: 'Button label on button colour', fg: readableOn(c.button, c.text), bg: c.button, min: 4.5 },
    { id: 'highlight', label: 'Highlight colour against background', fg: c.accentStrong, bg: c.bg, min: 3 },
  ];
  return checks.map((k) => {
    const ratio = contrastRatio(k.fg, k.bg);
    return { ...k, ratio: Math.round(ratio * 100) / 100, ok: ratio >= k.min, severity: ratio >= k.min ? 'ok' : ratio >= k.min * 0.75 ? 'warn' : 'fail' };
  });
}

/** Returns a copy with text colours adjusted until every check passes. */
export function autoFix(c) {
  const out = { ...c };
  const darkest = [c.bg, c.bg2, c.surface].reduce((a, b) => (contrastRatio(out.text, a) < contrastRatio(out.text, b) ? a : b));
  out.text = ensureContrast(out.text, darkest, 4.5);
  out.text2 = ensureContrast(out.text2, c.bg, 4.5);
  out.accentStrong = ensureContrast(out.accentStrong, c.bg, 3);
  return out;
}

/** The first mix of `color` towards `target` (in 2% steps) that satisfies `ok`, else `target`. */
function nudge(color, target, ok) {
  if (ok(color)) return color;
  for (let i = 1; i <= 50; i++) {
    const c = mix(color, target, i / 50);
    if (ok(c)) return c;
  }
  return target;
}

/**
 * The complete readability fix used by Settings → Appearance. autoFix() only adjusts text,
 * which cannot help when a background is the problem (no text colour reads on both a dark
 * and a light background). This keeps the primary background where possible and:
 *  1. moves the primary background towards black (light text) or white (dark text) only if
 *     even pure white/black text could not reach 4.5:1 on it;
 *  2. moves the secondary and card backgrounds towards the primary one until they can carry
 *     the same text;
 *  3. adjusts text, secondary text and highlight colours, then the button colour.
 * Every colour changes only as much as needed, a palette that already passes is returned
 * unchanged, and the result passes every checkContrast() check.
 */
export function fixPalette(c) {
  if (checkContrast(c).every((x) => x.ok)) return { ...c };
  const out = { ...c };
  const lightText = contrastRatio('#ffffff', out.bg) >= contrastRatio('#000000', out.bg);
  const extreme = lightText ? '#ffffff' : '#000000';
  const away = lightText ? '#000000' : '#ffffff';
  // A background leaves room for readable text when the extreme text colour reaches 4.6:1.
  const roomy = (bg) => contrastRatio(extreme, bg) >= 4.6;
  out.bg = nudge(out.bg, away, roomy);
  out.bg2 = nudge(out.bg2, out.bg, roomy);
  out.surface = nudge(out.surface, out.bg, roomy);
  const backgrounds = [out.bg, out.bg2, out.surface];
  out.text = nudge(out.text, extreme, (t) => backgrounds.every((bg) => contrastRatio(t, bg) >= 4.5));
  out.text2 = nudge(out.text2, extreme, (t) => contrastRatio(t, out.bg) >= 4.5);
  out.accentStrong = nudge(out.accentStrong, extreme, (t) => contrastRatio(t, out.bg) >= 3);
  // The button label is the better of the text colour and near-black; move the button away from it.
  const label = readableOn(out.button, out.text);
  const buttonOk = (b) => contrastRatio(readableOn(b, out.text), b) >= 4.5;
  out.button = nudge(out.button, luminance(label) > 0.18 ? '#000000' : '#ffffff', buttonOk);
  if (!buttonOk(out.button)) out.button = nudge(out.button, luminance(label) > 0.18 ? '#ffffff' : '#000000', buttonOk);
  return out;
}

/** Applies an appearance object to the document. */
export function applyAppearance(appearance = DEFAULT_APPEARANCE) {
  const a = { ...DEFAULT_APPEARANCE, ...appearance };
  const c = resolveColors(a);
  const root = document.documentElement;
  const set = (k, v) => root.style.setProperty(k, v);
  set('--lm-bg', c.bg);
  set('--lm-bg-2', c.bg2);
  set('--lm-surface', c.surface);
  set('--lm-accent', c.accent);
  set('--lm-accent-strong', c.accentStrong);
  set('--lm-accent-text', ensureContrast(c.accentStrong, c.bg, 4.5));
  set('--lm-button', c.button);
  set('--lm-button-text', readableOn(c.button, c.text));
  set('--lm-text', c.text);
  set('--lm-text-2', c.text2);
  set('--lm-gold', c.gold);
  set('--ambient-light', String(a.ambientLight ?? 0.6));
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', c.bg);

  applyEnvironment(a.environment);
  root.dataset.density = a.density || 'comfortable';
  root.dataset.translucent = a.translucent ? 'true' : 'false';
  root.dataset.animation = a.animation ? 'on' : 'off';
  root.dataset.parallax = a.parallax ? 'on' : 'off';
  root.dataset.ambientLight = '';
  if (a.motion === 'reduced' || a.motion === 'full') root.dataset.motion = a.motion;
  else delete root.dataset.motion;
  return a;
}

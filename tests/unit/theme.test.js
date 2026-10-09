// Colour-contrast utilities (js/core/contrast.js) and the theme readability checks and
// automatic fixes (js/theme.js checkContrast / autoFix) used by Settings → Appearance.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contrastRatio, ensureContrast, luminance, mix, parseHex, readableOn, toHex } from '../../js/core/contrast.js';
import { autoFix, checkContrast, DEFAULT_APPEARANCE, fixPalette, presetById, PRESETS, resolveColors, THEME_KEYS, THEME_LABELS } from '../../js/theme.js';
import { ENVIRONMENTS } from '../../js/fx/garden.js';

const HEX = /^#[0-9a-f]{6}$/i;
const near = (a, b, eps = 0.02) => Math.abs(a - b) <= eps;

// ── contrast.js ──
test('parseHex accepts 3- and 6-digit colours and rejects everything else', () => {
  assert.deepEqual(parseHex('#fff'), [255, 255, 255]);
  assert.deepEqual(parseHex('abcdef'), [171, 205, 239]);
  assert.deepEqual(parseHex(' #000000 '), [0, 0, 0]);
  assert.deepEqual(parseHex('#A1b2C3'), [161, 178, 195]);
  for (const bad of ['#12345', 'red', '', '#ggghhh', null, undefined, '#1234567']) assert.equal(parseHex(bad), null, String(bad));
});

test('toHex rounds and clamps channels', () => {
  assert.equal(toHex([255, 0, 128]), '#ff0080');
  assert.equal(toHex([300, -5, 127.6]), '#ff0080');
  assert.equal(toHex([0, 0, 0]), '#000000');
});

test('relative luminance follows WCAG', () => {
  assert.equal(luminance('#ffffff'), 1);
  assert.equal(luminance('#000000'), 0);
  assert.equal(luminance('not a colour'), 0);
  assert.ok(near(luminance('#808080'), 0.2159, 0.001));
  assert.ok(luminance('#ff0000') < luminance('#00ff00'), 'green is perceived brighter than red');
});

test('contrastRatio: known values, symmetry and range', () => {
  assert.ok(near(contrastRatio('#ffffff', '#000000'), 21));
  assert.equal(contrastRatio('#123456', '#123456'), 1);
  assert.equal(contrastRatio('#f8f5f2', '#080808'), contrastRatio('#080808', '#f8f5f2'));
  assert.ok(near(contrastRatio('#767676', '#ffffff'), 4.54), 'the classic AA grey on white');
  assert.ok(contrastRatio('#777777', '#ffffff') < 4.5);
});

test('mix interpolates between two colours', () => {
  assert.equal(mix('#000000', '#ffffff', 0), '#000000');
  assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
  assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
  assert.equal(mix('#ff0000', '#0000ff', 0.25), '#bf0040');
});

test('ensureContrast leaves good pairs alone and otherwise reaches the target', () => {
  assert.equal(ensureContrast('#f8f5f2', '#080808', 4.5), '#f8f5f2');
  const lifted = ensureContrast('#555555', '#101010', 4.5);
  assert.ok(contrastRatio(lifted, '#101010') >= 4.5);
  assert.ok(luminance(lifted) > luminance('#555555'), 'moves towards white on dark backgrounds');
  const darkened = ensureContrast('#bbbbbb', '#f5f0e8', 4.5);
  assert.ok(contrastRatio(darkened, '#f5f0e8') >= 4.5);
  assert.ok(luminance(darkened) < luminance('#bbbbbb'), 'moves towards black on light backgrounds');
  assert.ok(contrastRatio(ensureContrast('#b52b49', '#080808', 3), '#080808') >= 3);
  // An impossible target returns the best extreme instead of looping forever.
  assert.equal(ensureContrast('#777777', '#000000', 25), '#ffffff');
});

test('readableOn picks the better of the light and dark text colours', () => {
  assert.equal(readableOn('#080808'), '#f8f5f2');
  assert.equal(readableOn('#f5f0e8'), '#0b0b0b');
  assert.equal(readableOn('#781b32', '#ffffff'), '#ffffff');
  assert.equal(readableOn('#ffd000', '#ffffff', '#111111'), '#111111');
});

// ── theme.js ──
test('the nine theme keys are labelled', () => {
  assert.equal(THEME_KEYS.length, 9);
  assert.deepEqual(Object.keys(THEME_LABELS).sort(), [...THEME_KEYS].sort());
  for (const k of THEME_KEYS) assert.ok(THEME_LABELS[k].length > 3);
});

test('every preset is complete, uses a real environment and passes every readability check', () => {
  const envIds = new Set(ENVIRONMENTS.map((e) => e.id));
  assert.equal(new Set(PRESETS.map((p) => p.id)).size, PRESETS.length);
  assert.equal(PRESETS.length, 6);
  for (const p of PRESETS) {
    assert.ok(envIds.has(p.environment), `${p.id} environment`);
    for (const k of THEME_KEYS) assert.match(p.colors[k], HEX, `${p.id}.${k}`);
    const failing = checkContrast(p.colors).filter((c) => !c.ok);
    assert.deepEqual(failing.map((c) => `${c.id} ${c.ratio}`), [], `${p.id} should be readable`);
  }
});

test('checkContrast reports ratio, threshold and severity for each check', () => {
  const checks = checkContrast(PRESETS[0].colors);
  assert.deepEqual(checks.map((c) => c.id), ['text-bg', 'text-bg2', 'text-surface', 'text2-bg', 'button', 'highlight']);
  for (const c of checks) {
    assert.equal(typeof c.label, 'string');
    assert.equal(c.ratio, Math.round(c.ratio * 100) / 100, 'rounded to two decimals');
    assert.ok([4.5, 3].includes(c.min));
    assert.equal(c.severity, 'ok');
  }
  const poor = checkContrast({ ...PRESETS[0].colors, text: '#555555', text2: '#6b6b6b', accentStrong: '#5a1020' });
  const byId = Object.fromEntries(poor.map((c) => [c.id, c]));
  assert.equal(byId['text-bg'].severity, 'fail');
  assert.equal(byId['text-bg'].ok, false);
  // 3.38–4.5 is "warn" (within 75% of the AA target), below that "fail".
  assert.equal(byId['text2-bg'].ok, false);
  assert.equal(byId['text2-bg'].severity, byId['text2-bg'].ratio >= 4.5 * 0.75 ? 'warn' : 'fail');
  assert.equal(byId.highlight.severity, 'fail');
  const warn = checkContrast({ ...PRESETS[0].colors, text2: '#6f6c6d' }).find((c) => c.id === 'text2-bg');
  assert.ok(warn.ratio >= 3.375 && warn.ratio < 4.5, `ratio ${warn.ratio}`);
  assert.equal(warn.severity, 'warn');
});

const BAD_PALETTES = {
  'dim text on black': { bg: '#101010', bg2: '#202020', surface: '#1a1a1a', accent: '#300010', accentStrong: '#401020', button: '#781b32', text: '#555555', text2: '#333333', gold: '#c6a46a' },
  'pale text on cream': { bg: '#f5f0e8', bg2: '#ffffff', surface: '#eeeeee', accent: '#781b32', accentStrong: '#f0c0c0', button: '#781b32', text: '#aaaaaa', text2: '#cccccc', gold: '#c6a46a' },
  'navy on navy': { bg: '#0a1020', bg2: '#101830', surface: '#142040', accent: '#203060', accentStrong: '#243870', button: '#3e5277', text: '#2a3a5a', text2: '#1f2a44', gold: '#cfc7a4' },
};

test('autoFix makes text, secondary text and highlights readable without touching backgrounds', () => {
  for (const [name, palette] of Object.entries(BAD_PALETTES)) {
    const before = JSON.stringify(palette);
    const fixed = autoFix(palette);
    assert.equal(JSON.stringify(palette), before, `${name}: input is not mutated`);
    for (const k of ['bg', 'bg2', 'surface', 'accent', 'button', 'gold']) assert.equal(fixed[k], palette[k], `${name}: ${k} unchanged`);
    for (const k of THEME_KEYS) assert.match(fixed[k], HEX);
    const checks = Object.fromEntries(checkContrast(fixed).map((c) => [c.id, c]));
    for (const id of ['text-bg', 'text-bg2', 'text-surface', 'text2-bg', 'highlight']) {
      assert.ok(checks[id].ok, `${name}: ${id} (${checks[id].ratio})`);
    }
  }
});

test('autoFix is a no-op for palettes that already pass', () => {
  for (const p of PRESETS) assert.deepEqual(autoFix(p.colors), p.colors);
});

test('button labels: autoFix leaves the button colour alone, so the Appearance editor also nudges it', () => {
  // theme.js autoFix only adjusts text colours; the "button" check can still fail after it.
  // Settings → Appearance applies this extra step (see fixButton in js/views/settings.js).
  const fixButton = (c) => ({ ...c, button: ensureContrast(c.button, readableOn(c.button, c.text), 4.5) });
  for (const [name, palette] of Object.entries(BAD_PALETTES)) {
    const fixed = fixButton(autoFix(palette));
    const failing = checkContrast(fixed).filter((c) => !c.ok);
    assert.deepEqual(failing.map((c) => `${c.id} ${c.ratio}`), [], name);
  }
});

test('fixPalette fixes problems autoFix cannot reach: backgrounds that no text colour reads on', () => {
  // A light card background on a dark theme: no single text colour reads on both, and
  // autoFix (text only) moves the failure to other checks instead.
  const lightCard = { ...PRESETS[0].colors, surface: '#e8e0d8' };
  assert.ok(checkContrast(autoFix(lightCard)).some((c) => !c.ok), 'autoFix alone cannot fix this');
  const fixed = fixPalette(lightCard);
  assert.deepEqual(checkContrast(fixed).filter((c) => !c.ok).map((c) => c.id), []);
  assert.equal(fixed.bg, lightCard.bg, 'the primary background is kept');
  assert.notEqual(fixed.surface, lightCard.surface, 'the card background moves towards it');
  const green = { ...PRESETS[0].colors, bg2: '#009944' };
  assert.deepEqual(checkContrast(fixPalette(green)).filter((c) => !c.ok).map((c) => c.id), []);
  for (const [name, palette] of Object.entries(BAD_PALETTES)) {
    const before = JSON.stringify(palette);
    const out = fixPalette(palette);
    assert.equal(JSON.stringify(palette), before, `${name}: input is not mutated`);
    for (const k of THEME_KEYS) assert.match(out[k], HEX);
    assert.deepEqual(checkContrast(out).filter((c) => !c.ok).map((c) => `${c.id} ${c.ratio}`), [], name);
  }
});

test('fixPalette: every single-colour edit of every preset ends with all checks passing; passing palettes are untouched', () => {
  const levels = [0x00, 0x33, 0x66, 0x99, 0xcc, 0xff];
  const colours = [];
  for (const r of levels) for (const g of levels) for (const b of levels) colours.push(toHex([r, g, b]));
  let broken = 0;
  for (const p of PRESETS) {
    assert.deepEqual(fixPalette(p.colors), p.colors, `${p.id} is already readable`);
    for (const k of THEME_KEYS) {
      for (const colour of colours) {
        const palette = { ...p.colors, [k]: colour };
        const fixed = fixPalette(palette);
        if (checkContrast(palette).every((c) => c.ok)) {
          assert.deepEqual(fixed, palette, `${p.id} ${k}=${colour} passes, so nothing changes`);
          continue;
        }
        broken++;
        const failing = checkContrast(fixed).filter((c) => !c.ok);
        assert.deepEqual(failing.map((c) => c.id), [], `${p.id} ${k}=${colour}`);
      }
    }
  }
  assert.ok(broken > 1000, `exercised ${broken} unreadable palettes`);
});

test('resolveColors: presets, custom palettes and fallbacks', () => {
  assert.deepEqual(resolveColors({ preset: 'moonlit-garden' }), presetById('moonlit-garden').colors);
  assert.deepEqual(resolveColors({ preset: 'unknown' }), PRESETS[0].colors);
  assert.deepEqual(resolveColors(undefined), PRESETS[0].colors);
  const custom = resolveColors({ preset: 'custom', custom: { accent: '#224466', text: '#fafafa' } });
  assert.equal(custom.accent, '#224466');
  assert.equal(custom.text, '#fafafa');
  assert.equal(custom.bg, PRESETS[0].colors.bg, 'missing custom colours fall back to the default preset');
  assert.deepEqual(resolveColors({ preset: 'custom', custom: null }), PRESETS[0].colors);
  const copy = resolveColors({ preset: 'velvet-garden' });
  copy.bg = '#ffffff';
  assert.notEqual(PRESETS[0].colors.bg, '#ffffff', 'returns a copy');
});

test('default appearance matches the server defaults for profiles', async () => {
  const { DEFAULT_PROFILE_PREFERENCES } = await import('../../server/services/dto.js');
  for (const [k, value] of Object.entries(DEFAULT_PROFILE_PREFERENCES.appearance)) {
    assert.deepEqual(DEFAULT_APPEARANCE[k], value, `appearance.${k}`);
  }
  assert.equal(DEFAULT_APPEARANCE.motion, 'system');
});

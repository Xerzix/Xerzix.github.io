// Settings (/settings, /settings/:section). Preferences live on the active profile, so they
// follow the viewer to every device (in Preview mode they are kept on this device through
// the static backend's local "Guest" profile). Appearance edits preview live and are only
// kept when saved; leaving with unsaved changes reverts them.
import { h, newUid, announce } from '../core/dom.js';
import { api } from '../api/client.js';
import { bus } from '../core/bus.js';
import { session, setProfile, refreshLibrary } from '../core/session.js';
import { store } from '../core/storage.js';
import { INTERFACE_LANGUAGES } from '../core/i18n.js';
import { PRESETS, THEME_KEYS, THEME_LABELS, DEFAULT_APPEARANCE, checkContrast, fixPalette, resolveColors, presetById } from '../theme.js';
import { ENVIRONMENTS } from '../fx/garden.js';
import { playIntro } from '../fx/intro.js';
import { setAppearance, currentAppearance } from '../app.js';
import { button, confirmDialog, emptyState, errorState, linkButton, notice, serverRequired, settingRow, toast, toastError, toggleSwitch, withBusy } from '../ui/components.js';
import { icon, logoMark } from '../ui/icons.js';
import { avatar } from '../ui/avatars.js';
import { MEDIA_LANGUAGES, maturityLabel } from './profiles.js';
import { grownUpReason, withReauth } from './account.js';

const VERSION = '2.0.0';

const SECTIONS = [
  { id: 'appearance', label: 'Appearance', icon: 'palette', intro: 'Colours, garden environment, motion and layout. Changes preview instantly and are kept when you save.', render: appearanceSection },
  { id: 'playback', label: 'Playback', icon: 'play', intro: 'How titles start, continue and remember where you stopped.', render: playbackSection },
  { id: 'language', label: 'Language & subtitles', icon: 'subtitles', intro: 'Interface language, preferred audio and how subtitles look.', render: languageSection },
  { id: 'notifications', label: 'Notifications', icon: 'bell', server: true, intro: 'Choose which updates appear in your Lumina notifications.', render: notificationsSection },
  { id: 'parental', label: 'Parental controls', icon: 'shield', server: true, intro: 'Maturity ratings, kids profiles and PINs.', render: parentalSection },
  { id: 'privacy', label: 'Privacy & data', icon: 'eye', intro: 'What Lumina uses to personalise your garden, and what it keeps.', render: privacySection },
  { id: 'accessibility', label: 'Accessibility', icon: 'sliders', intro: 'Motion, captions and comfortable reading.', render: accessibilitySection },
  { id: 'about', label: 'About', icon: 'info', intro: 'Version, mode and the opening sequence.', render: aboutSection },
];

export const HOME_ROWS = [
  ['continue', 'Continue Watching'], ['recommended', 'Recommended for You'], ['because', 'Because You Watched…'], ['selects', 'Lumina Selects'],
  ['trending-movies', 'Trending Movies'], ['trending-tv', 'Trending TV Shows'], ['recent', 'Recently Added'], ['new-releases', 'New Releases'],
  ['discussed', 'Critically Discussed'], ['top-rated', 'Highest Rated by Members'], ['hidden-gems', 'Hidden Gems'], ['originals', 'Lumina Originals'],
  ['japanese', 'Japanese Cinema'], ['international', 'International Cinema'], ['award-winning', 'Award-Winning Movies'], ['documentaries', 'Popular Documentaries'],
  ['watchlist', 'Your Watchlist'], ['series', 'Series to Settle Into'],
].map(([id, label]) => ({ id, label }));

const PREF_DEFAULTS = {
  subtitles: { size: 'medium', color: '#F8F5F2', background: 'shadow', position: 'bottom' },
  playback: { autoplayNext: true, skipIntro: false, skipCredits: false, defaultQuality: 'auto', saveProgress: true, dataSaver: false },
  home: { hiddenRows: [] },
  privacy: { useHistoryForRecommendations: true, statsEnabled: true },
};

// Small colour strips for the environment cards (sky, dusk, foliage, lantern light).
const ENV_SWATCHES = {
  sakura: ['#3a1627', '#1b0d16', '#f1a7bd', '#f5c98a'],
  moonlit: ['#10203a', '#060a14', '#d6ddf2', '#ffd79a'],
  autumn: ['#45200d', '#1a0c07', '#e36a2f', '#ffc36b'],
  snow: ['#202838', '#0b0e14', '#eef3f8', '#ffd9a0'],
  lantern: ['#22100c', '#080506', '#e3927a', '#ffb45e'],
  none: ['#141414', '#080808', '#1f1f1f', '#2a2a2a'],
};

const SUBTITLE_COLOURS = [
  ['#F8F5F2', 'White'], ['#FFE45C', 'Yellow'], ['#7FE3F0', 'Cyan'], ['#9BE89B', 'Green'], ['#F5B8C8', 'Blossom'],
];

// ── Shared helpers ────────────────────────────────────────
const prefs = (k) => ({ ...PREF_DEFAULTS[k], ...(session.profile?.preferences?.[k] || {}) });

async function savePrefs(patch) {
  const res = await api.profiles.updatePreferences(session.profile.id, patch);
  setProfile(res.profile);
  return res.profile;
}

async function saveProfile(patch) {
  const res = await api.profiles.update(session.profile.id, patch);
  setProfile(res.profile);
  return res.profile;
}

/** Saves an appearance change right away (used outside the Appearance editor). */
async function saveAppearance(patch) {
  const before = currentAppearance();
  const next = { ...pickAppearance(before), ...patch };
  setAppearance(next, { persistLocal: !session.profile });
  if (!session.profile) return;
  try {
    // The whole appearance is sent so a profile that has never saved one keeps what is on screen.
    await savePrefs({ appearance: next });
  } catch (err) {
    setAppearance(before, { persistLocal: false });
    throw err;
  }
}

function group(title, intro, ...children) {
  return h('div', { class: 'lm-panel lm-settings-group' },
    title ? h('h3', null, title) : null,
    intro ? h('p', { class: 'lm-settings-group__intro' }, intro) : null,
    ...children);
}

/** A choice of options rendered as a segmented control with a setter. */
function choice({ options, value, label, onChange }) {
  const group = h('div', { class: 'lm-segmented', role: 'group', 'aria-label': label });
  const buttons = options.map((o) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(o.value === value), 'data-value': o.value }, o.label);
    b.addEventListener('click', () => {
      if (b.getAttribute('aria-pressed') === 'true') return;
      group.set(o.value);
      onChange(o.value);
    });
    return b;
  });
  group.append(...buttons);
  group.set = (v) => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === v)));
  return group;
}

function selectControl({ label, options, value, onChange }) {
  const select = h('select', { class: 'lm-select', 'aria-label': label }, ...options.map((o) => h('option', { value: o.value }, o.label)));
  select.value = value;
  select.addEventListener('change', () => onChange(select.value));
  return select;
}

function rangeRow(title, description, value, onInput) {
  const id = newUid('range');
  const pct = (v) => `${Math.round(v * 100)}%`;
  const out = h('output', { class: 'lm-range-value', for: id }, pct(value));
  const input = h('input', { id, type: 'range', class: 'lm-range', min: '0', max: '1', step: '0.05', value: String(value), 'aria-valuetext': pct(value) });
  input.addEventListener('input', () => {
    const v = Number(input.value);
    out.textContent = pct(v);
    input.setAttribute('aria-valuetext', pct(v));
    onInput(v);
  });
  const row = h('div', { class: 'lm-setting lm-setting--range' },
    h('div', { class: 'lm-setting__text' }, h('label', { for: id }, h('strong', null, title)), description ? h('span', null, description) : null),
    h('div', { class: 'lm-range-wrap' }, input, out));
  row.set = (v) => {
    input.value = String(v);
    out.textContent = pct(v);
    input.setAttribute('aria-valuetext', pct(v));
  };
  row.setDisabled = (off) => {
    input.disabled = off;
    row.classList.toggle('is-disabled', off);
  };
  return row;
}

function signInPrompt(what, sectionId) {
  return group(null, null, h('div', { class: 'lm-signin-prompt' },
    icon('user'),
    h('div', null, h('strong', null, `Sign in to change ${what}`), h('p', null, 'These settings belong to a profile, so they follow you to every device you sign in on.')),
    linkButton('Sign in', `#/login?next=${encodeURIComponent(`/settings/${sectionId}`)}`, { variant: 'primary' })));
}

/** The Preview-mode "needs the server" panel, demoted to a section heading (one h1 per page). */
function serverOnly(feature) {
  const node = serverRequired(feature);
  const h1 = node.querySelector('h1');
  if (h1) h1.replaceWith(h('h2', null, h1.textContent));
  return h('div', { class: 'lm-inline-server' }, node);
}

/**
 * Wraps an autosaving control: runs `save(value)`, shows "Saved", and on failure calls
 * `revert()` and explains the problem.
 */
function autosave(sctx, save, revert) {
  return async (value) => {
    try {
      await save(value);
      sctx.saved();
    } catch (err) {
      revert?.(value);
      toastError(err);
    }
  };
}

function sw(sctx, { checked, label, save }) {
  const control = toggleSwitch({ checked: !!checked, label });
  control.addEventListener('click', () => {
    const value = control.getAttribute('aria-checked') === 'true';
    autosave(sctx, save, () => control.setChecked(!value))(value);
  });
  return control;
}

// ── View ──────────────────────────────────────────────────
export default async function render(ctx) {
  const id = ctx.params.section || 'appearance';
  const def = SECTIONS.find((s) => s.id === id);
  const page = h('div', { class: 'lm-page lm-container lm-settings-page' });
  if (!def) {
    page.append(h('h1', { class: 'visually-hidden' }, 'Settings'), emptyState({
      title: 'That settings page doesn’t exist',
      message: 'It may have moved. Choose a section from Settings.',
      actions: [linkButton('All settings', '#/settings', { variant: 'primary' })],
    }));
    return page;
  }
  ctx.setTitle(`${def.label} · Settings`);

  const guard = { dirty: () => false, discard: () => {} };
  const status = h('p', { class: 'lm-settings__status', role: 'status' });
  let statusTimer = 0;
  const sctx = {
    ctx,
    guard,
    saved() {
      status.textContent = 'Saved';
      status.classList.add('is-visible');
      clearTimeout(statusTimer);
      statusTimer = setTimeout(() => {
        status.classList.remove('is-visible');
        status.textContent = '';
      }, 1800);
    },
  };
  ctx.onDestroy(() => clearTimeout(statusTimer));

  const leave = async (path) => {
    if (!guard.dirty()) return ctx.navigate(path);
    const discard = await confirmDialog({ title: 'Discard unsaved changes?', message: 'Your appearance changes haven’t been saved yet.', confirmLabel: 'Discard changes', cancelLabel: 'Keep editing' });
    if (discard) {
      guard.discard();
      ctx.navigate(path);
    }
  };

  const nav = h('nav', { class: 'lm-settings__nav', 'aria-label': 'Settings sections' },
    h('ul', { role: 'list' }, ...SECTIONS.map((s) => {
      const a = h('a', { href: `#/settings/${s.id}`, 'aria-current': s.id === id ? 'page' : undefined }, icon(s.icon), h('span', null, s.label),
        s.server && !session.isServer ? h('span', { class: 'lm-settings__server-tag' }, 'Server') : null);
      a.addEventListener('click', (e) => {
        if (!guard.dirty()) return;
        e.preventDefault();
        leave(`/settings/${s.id}`);
      });
      return h('li', null, a);
    })));

  const pickerId = newUid('section');
  const picker = h('select', { class: 'lm-select', id: pickerId }, ...SECTIONS.map((s) => h('option', { value: s.id, selected: s.id === id }, s.label)));
  picker.addEventListener('change', () => {
    const target = picker.value;
    picker.value = id;
    leave(`/settings/${target}`);
  });

  const who = session.profile;
  const context = !session.isServer
    ? 'Preview mode — your settings are saved on this device.'
    : who
      ? `Saved to the ${who.name} profile, so they follow ${who.name} to every device.`
      : 'You’re not signed in — appearance and accessibility choices apply to this device only.';

  const headingId = newUid('settings-sec');
  const content = h('section', { class: 'lm-settings__content', 'aria-labelledby': headingId },
    h('div', { class: 'lm-settings__head' },
      h('div', null, h('h2', { id: headingId }, def.label), h('p', null, def.intro)),
      status));
  let body;
  try {
    body = await def.render(sctx);
  } catch (err) {
    body = errorState(err, { retry: () => ctx.navigate(ctx.raw, { replace: true }) });
  }
  content.append(...[body].flat().filter(Boolean));

  page.append(
    h('header', { class: 'lm-page-header' }, h('div', null,
      h('span', { class: 'lm-eyebrow' }, 'Preferences'),
      h('h1', null, 'Settings'),
      h('p', null, context))),
    h('div', { class: 'lm-settings' },
      nav,
      h('div', { class: 'lm-settings__main' },
        h('div', { class: 'lm-field lm-settings__picker' }, h('label', { class: 'lm-label', for: pickerId }, 'Section'), picker),
        content)));
  return page;
}

// ── Appearance ────────────────────────────────────────────
function pickAppearance(a = {}) {
  const out = {};
  for (const k of Object.keys(DEFAULT_APPEARANCE)) out[k] = a[k] ?? DEFAULT_APPEARANCE[k];
  out.custom = a.custom ? Object.fromEntries(THEME_KEYS.filter((k) => a.custom[k]).map((k) => [k, a.custom[k].toLowerCase()])) : null;
  return out;
}

function normalizeHex(value) {
  let v = String(value || '').trim().toLowerCase();
  if (!v.startsWith('#')) v = `#${v}`;
  if (/^#[0-9a-f]{3}$/.test(v)) v = `#${v.slice(1).split('').map((c) => c + c).join('')}`;
  return /^#[0-9a-f]{6}$/.test(v) ? v : null;
}

/** "a, b and c" */
function listOf(items) {
  return items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

/** The colours fixPalette() would change, or [] when it cannot improve anything. */
function readabilityFix(colors) {
  const fixed = fixPalette(colors);
  const changed = THEME_KEYS.filter((k) => fixed[k] !== colors[k]);
  return { fixed, changed };
}

const contrastSummaryText = (problems) => (problems.length
  ? `${problems.length} ${problems.length === 1 ? 'check falls' : 'checks fall'} below the WCAG AA contrast guideline. Text may be hard to read.`
  : 'Every check meets the WCAG AA contrast guideline.');

function paintPreview(el, c) {
  const vars = { '--p-bg': c.bg, '--p-bg2': c.bg2, '--p-surface': c.surface, '--p-accent': c.accent, '--p-strong': c.accentStrong, '--p-button': c.button, '--p-text': c.text, '--p-text2': c.text2, '--p-gold': c.gold };
  for (const [k, v] of Object.entries(vars)) el.style.setProperty(k, v);
  if (!el.firstChild) {
    el.append(
      h('span', { class: 'lm-preset__card' }, h('span', { class: 'lm-preset__line lm-preset__line--title' }), h('span', { class: 'lm-preset__line' }), h('span', { class: 'lm-preset__btn' })),
      h('span', { class: 'lm-preset__bar' }),
      h('span', { class: 'lm-preset__dot' }));
  }
}

function appearanceSection(sctx) {
  const { ctx } = sctx;
  let saved = pickAppearance(currentAppearance());
  let draft = pickAppearance(saved);
  const dirty = () => JSON.stringify(draft) !== JSON.stringify(saved);
  let frame = 0;
  const apply = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => setAppearance(draft, { persistLocal: false }));
    refresh();
  };
  const customColors = () => (draft.custom ? resolveColors({ preset: 'custom', custom: draft.custom }) : resolveColors(draft));

  // Theme presets (radio group)
  const presetName = newUid('preset');
  const presetInputs = new Map();
  let customPreview;
  const presetGrid = h('fieldset', { class: 'lm-preset-grid' }, h('legend', { class: 'visually-hidden' }, 'Colour theme'),
    ...[...PRESETS, { id: 'custom', name: 'Custom colours' }].map((p) => {
      const input = h('input', { type: 'radio', name: presetName, value: p.id });
      input.addEventListener('change', () => choosePreset(p.id));
      presetInputs.set(p.id, input);
      const preview = h('span', { class: 'lm-preset__preview', 'aria-hidden': 'true' });
      if (p.id === 'custom') customPreview = preview;
      else paintPreview(preview, p.colors);
      return h('label', { class: ['lm-preset', p.id === 'custom' && 'lm-preset--custom'] }, input, preview, h('span', { class: 'lm-preset__name' }, icon('checkCircle'), p.name));
    }));

  function choosePreset(id) {
    if (id === 'custom') {
      if (!draft.custom) draft.custom = { ...resolveColors(draft) };
      draft.preset = 'custom';
      announce('Custom colours. Edit them below.');
    } else {
      const p = presetById(id);
      draft.preset = id;
      draft.environment = p.environment;
      announce(`Previewing ${p.name}`);
    }
    apply();
  }

  // Custom colour editor
  const colourRows = new Map();
  const colourGrid = h('div', { class: 'lm-colour-grid' }, ...THEME_KEYS.map((k) => {
    const textId = newUid('hex');
    const picker = h('input', { type: 'color', 'aria-label': `${THEME_LABELS[k]} colour picker` });
    const text = h('input', { id: textId, class: 'lm-input', type: 'text', maxlength: 7, spellcheck: 'false', autocomplete: 'off', inputmode: 'text', 'aria-describedby': undefined });
    const set = (v) => {
      draft.custom = { ...customColors(), [k]: v };
      draft.preset = 'custom';
      apply();
    };
    picker.addEventListener('input', () => {
      text.value = picker.value;
      text.removeAttribute('aria-invalid');
      set(picker.value.toLowerCase());
    });
    text.addEventListener('input', () => {
      const v = normalizeHex(text.value);
      if (!v) return text.setAttribute('aria-invalid', 'true');
      text.removeAttribute('aria-invalid');
      picker.value = v;
      set(v);
    });
    text.addEventListener('blur', () => {
      text.value = customColors()[k];
      text.removeAttribute('aria-invalid');
    });
    colourRows.set(k, { picker, text });
    return h('div', { class: 'lm-colour' }, picker, h('label', { for: textId }, THEME_LABELS[k]), text);
  }));

  const contrastList = h('ul', { class: 'lm-contrast__list', role: 'list' });
  const contrastSummary = h('div');
  const fixBtn = button('Fix readability automatically', { variant: 'primary', size: 'sm', icon: 'sparkle' });
  fixBtn.addEventListener('click', () => {
    const { fixed, changed } = readabilityFix(customColors());
    if (!changed.length) {
      announce('No automatic fix is available for these colours. Choose darker or lighter colours by hand.');
      return;
    }
    draft.custom = fixed;
    draft.preset = 'custom';
    // The result is announced here, not by the report (and no older report announcement fires).
    clearTimeout(announceTimer);
    lastProblemCount = null;
    apply();
    // Report what actually happened, never more.
    const remaining = checkContrast(fixed).filter((x) => !x.ok);
    const what = listOf(changed.map((k) => THEME_LABELS[k].toLowerCase()));
    const message = remaining.length
      ? `Adjusted the ${what}. ${remaining.length} ${remaining.length === 1 ? 'check still falls' : 'checks still fall'} short: ${listOf(remaining.map((x) => x.label.toLowerCase()))}.`
      : `Adjusted the ${what}. Every text check now passes.`;
    announce(message);
    toast(message, { type: remaining.length ? 'info' : 'success' });
  });
  // The report updates in place; only a change in how many checks fail is announced.
  const contrastItems = new Map();
  let lastProblemCount = null;
  let announceTimer = 0;
  function renderContrast(c) {
    const checks = checkContrast(c);
    const problems = checks.filter((x) => !x.ok);
    for (const x of checks) {
      let item = contrastItems.get(x.id);
      if (!item) {
        item = { mark: h('span', { class: 'lm-contrast__mark' }), sr: h('span', { class: 'visually-hidden' }), ratio: h('span', { class: 'lm-contrast__ratio' }) };
        item.li = h('li', { class: 'lm-contrast__item' }, item.mark, h('span', { class: 'lm-contrast__label' }, x.label, item.sr), item.ratio);
        contrastItems.set(x.id, item);
        contrastList.append(item.li);
      }
      if (item.li.dataset.severity !== x.severity) {
        item.li.dataset.severity = x.severity;
        item.mark.replaceChildren(icon(x.ok ? 'checkCircle' : 'alert'));
        item.sr.textContent = x.ok ? ' — passes' : x.severity === 'warn' ? ' — slightly too low' : ' — too low';
      }
      const ratio = `${x.ratio.toFixed(2)} : 1 · needs ${x.min}`;
      if (item.ratio.textContent !== ratio) item.ratio.textContent = ratio;
    }
    const type = problems.length ? (problems.some((x) => x.severity === 'fail') ? 'danger' : 'warn') : 'ok';
    const key = `${problems.length}:${type}`;
    if (contrastSummary.dataset.key !== key) {
      contrastSummary.dataset.key = key;
      contrastSummary.replaceChildren(notice(contrastSummaryText(problems), { type }));
    }
    if (lastProblemCount !== null && lastProblemCount !== problems.length) {
      clearTimeout(announceTimer);
      announceTimer = setTimeout(() => announce(contrastSummaryText(problems)), 700);
    }
    lastProblemCount = problems.length;
    // Offer the fix only when it would change something.
    fixBtn.hidden = !problems.length || !readabilityFix(c).changed.length;
  }
  const customEditor = h('div', { class: 'lm-custom-editor lm-safe-palette' },
    h('div', { class: 'lm-custom-editor__head' },
      h('h4', null, 'Your colours'),
      h('p', null, 'The page previews your palette as you edit. This editor keeps the default colours so you can always read it.')),
    colourGrid,
    h('div', { class: 'lm-contrast' },
      h('strong', null, 'Readability'),
      contrastSummary,
      contrastList,
      h('div', null, fixBtn)));
  const customiseBtn = button('Customise these colours', { variant: 'glass', size: 'sm', icon: 'palette', onClick: () => {
    choosePreset('custom');
    presetInputs.get('custom').focus();
  } });
  const presetNote = h('div', { class: 'lm-cluster', style: { marginTop: 'var(--lm-space-4)' } },
    h('p', { class: 'lm-muted lm-small', style: { flex: '1 1 260px' } }, 'Every built-in theme meets WCAG AA contrast for text. Choosing one also switches to its paired garden.'),
    customiseBtn);

  // Environments
  const envName = newUid('env');
  const envInputs = new Map();
  const envGrid = h('fieldset', { class: 'lm-env-grid' }, h('legend', { class: 'visually-hidden' }, 'Garden environment'),
    ...ENVIRONMENTS.map((env) => {
      const input = h('input', { type: 'radio', name: envName, value: env.id });
      input.addEventListener('change', () => {
        draft.environment = env.id;
        apply();
      });
      envInputs.set(env.id, input);
      return h('label', { class: 'lm-env' }, input,
        h('span', { class: 'lm-env__swatch', 'aria-hidden': 'true' }, ...(ENV_SWATCHES[env.id] || ENV_SWATCHES.none).map((c) => h('span', { style: { background: c } }))),
        h('span', null, h('strong', null, env.name), h('small', null, env.description)));
    }));

  // Motion & effects
  const animSwitch = toggleSwitch({ checked: draft.animation, label: 'Animated particles', onChange: (v) => { draft.animation = v; apply(); } });
  const petals = rangeRow('Particle intensity', 'How many petals, leaves, snowflakes or embers drift through the garden.', draft.petalIntensity, (v) => { draft.petalIntensity = v; apply(); });
  const ambient = rangeRow('Ambient light', 'Brightness of the garden behind the interface.', draft.ambientLight, (v) => { draft.ambientLight = v; apply(); });
  const parallaxSwitch = toggleSwitch({ checked: draft.parallax, label: 'Parallax depth', onChange: (v) => { draft.parallax = v; apply(); } });
  const motion = choice({
    label: 'Motion',
    value: draft.motion,
    options: [{ value: 'system', label: 'System' }, { value: 'reduced', label: 'Reduced' }, { value: 'full', label: 'Full' }],
    onChange: (v) => { draft.motion = v; apply(); },
  });

  // Layout & surfaces
  const density = choice({
    label: 'Interface density',
    value: draft.density,
    options: [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }],
    onChange: (v) => { draft.density = v; apply(); },
  });
  const translucentSwitch = toggleSwitch({ checked: draft.translucent, label: 'Translucent surfaces', onChange: (v) => { draft.translucent = v; apply(); } });
  const ambientModeSwitch = toggleSwitch({ checked: draft.ambientMode, label: 'Ambient mode on title pages', onChange: (v) => { draft.ambientMode = v; apply(); } });
  const heroSwitch = toggleSwitch({ checked: draft.heroAutoRotate, label: 'Rotate the featured banner', onChange: (v) => { draft.heroAutoRotate = v; apply(); } });

  // Save / discard / reset
  const saveBtn = button('Save appearance', { variant: 'primary', icon: 'check' });
  const discardBtn = button('Discard changes', { variant: 'ghost' });
  const bar = h('div', { class: 'lm-savebar lm-safe-palette', role: 'region', 'aria-label': 'Unsaved appearance changes', hidden: true },
    h('span', { class: 'lm-savebar__msg' }, icon('info'), 'You’re previewing unsaved changes.'),
    h('div', { class: 'lm-cluster lm-cluster--sm' }, discardBtn, saveBtn));
  const resetBtn = button('Reset to default', { variant: 'ghost', icon: 'refresh' });
  resetBtn.addEventListener('click', () => {
    draft = pickAppearance(DEFAULT_APPEARANCE);
    apply();
    announce('Default appearance restored. Save to keep it.');
  });
  discardBtn.addEventListener('click', () => {
    draft = pickAppearance(saved);
    apply();
    announce('Changes discarded');
  });
  saveBtn.addEventListener('click', () => withBusy(saveBtn, async () => {
    const payload = { ...draft, petalIntensity: Math.round(draft.petalIntensity * 100) / 100, ambientLight: Math.round(draft.ambientLight * 100) / 100 };
    try {
      if (session.profile) await savePrefs({ appearance: payload });
      else setAppearance(payload, { persistLocal: true });
      saved = pickAppearance(draft);
      refresh();
      sctx.saved();
      toast(session.isServer && session.profile ? `Appearance saved to ${session.profile.name}.` : 'Appearance saved on this device.', { type: 'success' });
    } catch (err) {
      toastError(err);
    }
  }));

  function refresh() {
    presetInputs.forEach((input, id) => { input.checked = draft.preset === id; });
    paintPreview(customPreview, customColors());
    const isCustom = draft.preset === 'custom';
    customEditor.hidden = !isCustom;
    presetNote.hidden = isCustom;
    if (isCustom) {
      const c = customColors();
      colourRows.forEach(({ picker, text }, k) => {
        picker.value = c[k];
        if (document.activeElement !== text) text.value = c[k];
      });
      renderContrast(c);
    } else {
      lastProblemCount = null;
    }
    envInputs.forEach((input, id) => { input.checked = draft.environment === id; });
    animSwitch.setChecked(draft.animation);
    petals.set(draft.petalIntensity);
    petals.setDisabled(!draft.animation);
    ambient.set(draft.ambientLight);
    parallaxSwitch.setChecked(draft.parallax);
    motion.set(draft.motion);
    density.set(draft.density);
    translucentSwitch.setChecked(draft.translucent);
    ambientModeSwitch.setChecked(draft.ambientMode);
    heroSwitch.setChecked(draft.heroAutoRotate);
    bar.hidden = !dirty();
  }

  // Leaving with unsaved changes reverts the preview.
  sctx.guard.dirty = dirty;
  sctx.guard.discard = () => {
    draft = pickAppearance(saved);
    setAppearance(saved, { persistLocal: false });
  };
  const onBeforeUnload = (e) => {
    if (!dirty()) return;
    e.preventDefault();
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  const profileId = session.profile?.id;
  const offSession = bus.on('session:changed', () => {
    // Signed out or switched profile elsewhere: the app has applied that appearance.
    if (session.profile?.id === profileId) return;
    saved = pickAppearance(currentAppearance());
    draft = pickAppearance(saved);
    refresh();
  });
  ctx.onDestroy(() => {
    window.removeEventListener('beforeunload', onBeforeUnload);
    offSession();
    cancelAnimationFrame(frame);
    clearTimeout(announceTimer);
    if (dirty()) {
      setAppearance(saved, { persistLocal: false });
      toast('Unsaved appearance changes were discarded.');
    }
  });

  refresh();
  return [
    group('Colour theme', 'Six palettes drawn from the garden, or your own colours.', presetGrid, presetNote, customEditor),
    group('Garden environment', 'The living scene behind Lumina.', envGrid),
    group('Motion & effects', null,
      settingRow('Animated particles', 'Drifting petals, leaves, snow, fireflies or embers.', animSwitch),
      petals,
      ambient,
      settingRow('Parallax depth', 'Layers of the garden shift gently as you move the pointer or scroll.', parallaxSwitch),
      settingRow('Motion', 'System follows your device’s reduced-motion setting.', motion)),
    group('Layout & surfaces', null,
      settingRow('Interface density', 'Spacing between rows, cards and controls.', density),
      settingRow('Translucent surfaces', 'Frosted-glass panels that let the garden glow through (the original Glass mode).', translucentSwitch),
      settingRow('Ambient mode on title pages', 'Tint the page with colours from the title’s artwork.', ambientModeSwitch),
      settingRow('Rotate the featured banner', 'Move to the next featured title every few seconds on Home.', heroSwitch)),
    h('div', { class: 'lm-form-actions' }, resetBtn),
    bar,
  ];
}

// ── Playback ──────────────────────────────────────────────
function playbackSection(sctx) {
  if (!session.profile) return signInPrompt('playback settings', 'playback');
  const pb = prefs('playback');
  const quality = selectControl({
    label: 'Default quality',
    value: pb.defaultQuality,
    options: [{ value: 'auto', label: 'Auto — adapts to your connection' }, { value: 'data-saver', label: 'Data saver — lower resolutions' }, { value: 'highest', label: 'Highest available' }],
    onChange: autosave(sctx, (v) => savePrefs({ playback: { defaultQuality: v } }), () => { quality.value = prefs('playback').defaultQuality; }),
  });
  return [
    group('While watching', null,
      settingRow('Autoplay next episode', 'Start the next episode automatically when one ends.', sw(sctx, { checked: pb.autoplayNext, label: 'Autoplay next episode', save: (v) => savePrefs({ playback: { autoplayNext: v } }) })),
      settingRow('Skip intros', 'Jump past opening titles automatically when a title marks them.', sw(sctx, { checked: pb.skipIntro, label: 'Skip intros', save: (v) => savePrefs({ playback: { skipIntro: v } }) })),
      settingRow('Skip credits', 'Move on to the next episode when the end credits begin.', sw(sctx, { checked: pb.skipCredits, label: 'Skip credits', save: (v) => savePrefs({ playback: { skipCredits: v } }) })),
      settingRow('Save watch progress', 'Remember where you stopped, for resuming and Continue Watching.', sw(sctx, { checked: pb.saveProgress, label: 'Save watch progress', save: (v) => savePrefs({ playback: { saveProgress: v } }) }))),
    group('Quality', 'Lumina only offers resolutions a title really has. “Highest available” never upscales.',
      settingRow('Default quality', null, quality),
      settingRow('Data saver', 'Prefer lower resolutions on every connection to use less data.', sw(sctx, { checked: pb.dataSaver, label: 'Data saver', save: (v) => savePrefs({ playback: { dataSaver: v } }) }))),
    group('While browsing', null,
      settingRow('Autoplay previews', 'Play trailers quietly on title pages and the featured banner.', sw(sctx, { checked: session.profile.autoplayPreviews, label: 'Autoplay previews', save: (v) => saveProfile({ autoplayPreviews: v }) }))),
  ];
}

// ── Language & subtitles ──────────────────────────────────
function languageSection(sctx) {
  if (!session.profile) return signInPrompt('language and subtitle settings', 'language');
  const p = session.profile;
  const reloadBtn = h('button', { type: 'button', class: 'lm-link', onClick: () => location.reload() }, 'Reload now');
  const reloadNote = notice(h('span', null, 'The profile menu has switched already. The main navigation bar follows the next time Lumina loads. ', reloadBtn), { type: 'info' });
  reloadNote.hidden = true;
  const langName = newUid('ui-lang');
  const inputs = [];
  const langList = h('fieldset', { class: 'lm-choice-list' }, h('legend', { class: 'visually-hidden' }, 'Interface language'),
    ...INTERFACE_LANGUAGES.map((l) => {
      const input = h('input', { type: 'radio', name: langName, value: l.code, checked: p.uiLanguage === l.code });
      inputs.push(input);
      input.addEventListener('change', autosave(sctx, async () => {
        await saveProfile({ uiLanguage: l.code });
        reloadNote.hidden = false;
      }, () => inputs.forEach((i) => { i.checked = i.value === session.profile.uiLanguage; })));
      return h('label', { class: 'lm-choice' }, input, h('span', null,
        h('strong', { lang: l.code }, l.name),
        h('small', null, l.coverage === 'Complete' ? 'Complete' : `${l.coverage} — other text appears in English`)));
    }));

  const audio = selectControl({ label: 'Preferred audio language', value: p.audioLanguage || '', options: [{ value: '', label: 'Original language' }, ...MEDIA_LANGUAGES], onChange: autosave(sctx, (v) => saveProfile({ audioLanguage: v || null }), () => { audio.value = session.profile.audioLanguage || ''; }) });
  const subLang = selectControl({ label: 'Preferred subtitle language', value: p.subtitleLanguage || '', options: [{ value: '', label: 'Same as the interface' }, ...MEDIA_LANGUAGES], onChange: autosave(sctx, (v) => saveProfile({ subtitleLanguage: v || null }), () => { subLang.value = session.profile.subtitleLanguage || ''; }) });

  // Subtitle style with a live sample
  let style = prefs('subtitles');
  const cap = h('span', { class: 'lm-sub-preview__cap' }, 'The lanterns are lit for you tonight.');
  const sample = h('div', { class: 'lm-sub-preview', role: 'img', 'aria-label': 'Subtitle preview over a garden scene' },
    h('img', { src: 'assets/art/hanami-backdrop.svg', alt: '' }),
    h('div', { class: 'lm-sub-preview__line' }, cap));
  const paint = () => {
    sample.dataset.size = style.size;
    sample.dataset.bg = style.background;
    sample.dataset.pos = style.position;
    sample.style.setProperty('--sub-color', style.color);
  };
  paint();
  const update = (key) => autosave(sctx, async (v) => {
    style = { ...style, [key]: v };
    paint();
    await savePrefs({ subtitles: { [key]: v } });
  }, () => {
    style = prefs('subtitles');
    paint();
  });
  const size = choice({ label: 'Subtitle size', value: style.size, options: [{ value: 'small', label: 'Small' }, { value: 'medium', label: 'Medium' }, { value: 'large', label: 'Large' }, { value: 'xlarge', label: 'Extra large' }], onChange: update('size') });
  const background = choice({ label: 'Subtitle background', value: style.background, options: [{ value: 'none', label: 'None' }, { value: 'shadow', label: 'Drop shadow' }, { value: 'box', label: 'Dark box' }], onChange: update('background') });
  const position = choice({ label: 'Subtitle position', value: style.position, options: [{ value: 'bottom', label: 'Bottom' }, { value: 'raised', label: 'Raised' }, { value: 'top', label: 'Top' }], onChange: update('position') });
  const colourName = newUid('sub-colour');
  const saveColour = update('color');
  const colours = h('fieldset', { class: 'lm-swatches' }, h('legend', { class: 'visually-hidden' }, 'Subtitle colour'),
    ...SUBTITLE_COLOURS.map(([hex, label]) => {
      const input = h('input', { type: 'radio', name: colourName, value: hex, 'aria-label': label, checked: style.color.toLowerCase() === hex.toLowerCase() });
      input.addEventListener('change', () => saveColour(hex));
      return h('label', { class: 'lm-swatch', title: label }, input, h('span', { style: { '--sw': hex } }));
    }));

  return [
    group('Interface language', 'The language of menus and buttons for this profile.', langList, reloadNote),
    group('Audio & subtitles', 'Lumina only offers the audio and subtitle languages a title really has. When your choice isn’t available, the original audio plays.',
      settingRow('Preferred audio', null, audio),
      settingRow('Preferred subtitles', null, subLang),
      settingRow('Subtitles on by default', 'Turn on subtitles in your preferred language when playback starts.', sw(sctx, { checked: p.subtitlesDefault, label: 'Subtitles on by default', save: (v) => saveProfile({ subtitlesDefault: v }) }))),
    group('Subtitle style', 'Changes apply to every title this profile watches.',
      sample,
      settingRow('Size', null, size),
      h('div', { class: 'lm-setting' }, h('div', { class: 'lm-setting__text' }, h('strong', null, 'Colour')), colours),
      settingRow('Background', 'A shadow or box keeps subtitles readable over bright scenes.', background),
      settingRow('Position', 'Raise subtitles to keep them clear of on-screen captions.', position)),
  ];
}

// ── Notifications ─────────────────────────────────────────
const NOTIFICATION_PREFS = [
  ['newEpisodes', 'New episodes', 'When a series you follow adds an episode.'],
  ['genreReleases', 'New in your genres', 'When titles arrive in genres you follow.'],
  ['creatorReleases', 'Creator releases', 'New work from creators you follow.'],
  ['reviewReplies', 'Replies to your reviews', 'When someone comments on a review you wrote.'],
  ['announcements', 'Lumina announcements', 'Occasional news about the platform.'],
];

async function notificationsSection(sctx) {
  if (!session.isServer) return serverOnly('Choosing notification preferences');
  if (!session.account) return signInPrompt('notification preferences', 'notifications');
  let current;
  try {
    current = await api.notifications.prefs();
  } catch (err) {
    if (err.status === 404 || err.status === 405) {
      return group(null, null, notice('Notification preferences aren’t available on this server yet. Account and security notices are always delivered.', { type: 'info' }));
    }
    throw err;
  }
  current = current?.preferences || current || {};
  return group('Send me notifications about', 'Account and security notices, submission updates and moderation decisions are always delivered.',
    ...NOTIFICATION_PREFS.map(([key, title, description]) => settingRow(title, description, sw(sctx, {
      checked: current[key] !== false,
      label: title,
      save: async (v) => {
        const next = { ...current, [key]: v };
        const res = await withReauth(() => api.notifications.setPrefs(next), { reason: grownUpReason('change notification settings for the account') });
        if (res === undefined) throw new Error('Not changed. Notification settings belong to the whole account, so a grown-up needs to confirm the account password.');
        current = res?.preferences || (res && typeof res === 'object' && key in res ? res : next);
      },
    }))));
}

// ── Parental controls ─────────────────────────────────────
function parentalSection() {
  if (!session.isServer) return serverOnly('Managing parental controls');
  if (!session.profile) return signInPrompt('parental controls', 'parental');
  const p = session.profile;
  return [
    group('This profile', null,
      h('div', { class: 'lm-cluster', style: { gap: 'var(--lm-space-4)' } },
        avatar(p.avatar, { size: 64 }),
        h('div', { style: { flex: '1 1 220px' } },
          h('strong', null, p.name),
          h('p', { class: 'lm-muted lm-small' }, [p.isKids ? 'Kids profile' : 'Standard profile', maturityLabel(p.maxAge), p.hasPin ? 'Locked with a PIN' : 'No PIN'].join(' · '))),
        linkButton('Manage profiles', '#/profiles/manage', { variant: 'primary', icon: 'edit' }))),
    group('How parental controls work', null,
      h('ul', { class: 'lm-delete-list' },
        h('li', null, 'Every profile has a maturity rating. Titles rated above it are hidden everywhere — browsing, search, Velvia Suggestions and direct links.'),
        h('li', null, 'Kids profiles are limited to titles rated 13 and under.'),
        h('li', null, 'While a kids profile or any profile with a maturity rating is active, adding, deleting or unlocking profiles, changing ratings or PINs, and account settings need the account password. Each confirmation covers one change, and its own PIN is never enough.'),
        h('li', null, 'Add a 4-digit PIN to grown-up profiles so nobody else can switch into them.'),
        h('li', null, 'Forgot a PIN? Reset it from Manage profiles by confirming the account password.'),
        h('li', null, 'Ratings come from official classifications where they exist; others are labelled as advisory.'))),
  ];
}

// ── Privacy & data ────────────────────────────────────────
function privacySection(sctx) {
  const parts = [];
  if (session.profile) {
    const pv = prefs('privacy');
    parts.push(group('Personalisation', null,
      settingRow('Use viewing history for recommendations', 'Recommendations and Velvia Suggestions consider what this profile has watched. When off, only your list and ratings are used.',
        sw(sctx, { checked: pv.useHistoryForRecommendations, label: 'Use viewing history for recommendations', save: (v) => savePrefs({ privacy: { useHistoryForRecommendations: v } }) })),
      settingRow('Viewing statistics', h('span', null, 'A private summary of what this profile watches. ', h('a', { class: 'lm-link', href: '#/stats' }, 'See your statistics')),
        sw(sctx, { checked: pv.statsEnabled, label: 'Viewing statistics', save: (v) => savePrefs({ privacy: { statsEnabled: v } }) }))));

    const hidden = new Set(prefs('home').hiddenRows);
    const switches = new Map();
    const rows = h('div', { class: 'lm-row-toggles' }, ...HOME_ROWS.map((r) => {
      const control = sw(sctx, {
        checked: !hidden.has(r.id),
        label: `Show “${r.label}” on Home`,
        save: async (visible) => {
          if (visible) hidden.delete(r.id);
          else hidden.add(r.id);
          try {
            await savePrefs({ home: { hiddenRows: [...hidden] } });
          } catch (err) {
            if (visible) hidden.add(r.id);
            else hidden.delete(r.id);
            throw err;
          }
        },
      });
      switches.set(r.id, control);
      return settingRow(r.label, null, control);
    }));
    const showAll = button('Show every row', { variant: 'ghost', size: 'sm', icon: 'eye' });
    showAll.addEventListener('click', autosave(sctx, async () => {
      await savePrefs({ home: { hiddenRows: [] } });
      hidden.clear();
      switches.forEach((c) => c.setChecked(true));
    }));
    parts.push(group('Home rows', 'Hide rows you don’t want on Home. Rows only appear when they have something to show.', rows, h('div', { class: 'lm-form-actions', style: { marginTop: 'var(--lm-space-4)' } }, showAll)));

    const clearHistory = button('Clear watch history…', { variant: 'danger', size: 'sm' });
    clearHistory.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Clear watch history?', message: `This removes ${session.profile.name}’s viewing history and Continue Watching progress. My List, ratings and reviews stay.`, confirmLabel: 'Clear history', danger: true }))) return;
      withBusy(clearHistory, async () => {
        try {
          await api.library.clearHistory();
          await refreshLibrary();
          bus.emit('library:refresh-home');
          toast('Watch history cleared.', { type: 'success' });
        } catch (err) {
          toastError(err);
        }
      });
    });
    const clearSearch = button('Clear search history', { variant: 'ghost', size: 'sm' });
    clearSearch.addEventListener('click', () => {
      store.remove(`recentSearches.${session.profile?.id || 'guest'}`);
      toast('Recent searches cleared.', { type: 'success' });
      sctx.saved();
    });
    parts.push(group('History', null,
      settingRow('Watch history', 'Viewing history and Continue Watching progress for this profile.', clearHistory),
      settingRow('Search history', 'Recent searches remembered on this device for this profile.', clearSearch)));
  } else {
    parts.push(signInPrompt('privacy settings', 'privacy'));
  }

  if (session.isServer && session.account) {
    parts.push(group('Your data', null,
      settingRow('Download or delete your data', 'Get a copy of everything Lumina stores about your account, or delete the account, from your account page.', linkButton('Go to Account', '#/account', { variant: 'glass', size: 'sm', icon: 'user' }))));
  }
  if (!session.isServer) {
    const wipe = button('Clear device data…', { variant: 'danger', size: 'sm', icon: 'trash' });
    wipe.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Clear everything on this device?', message: 'This removes My List, collections, progress, history, preferences and appearance saved by this browser, and replays the introduction. It can’t be undone.', confirmLabel: 'Clear device data', danger: true }))) return;
      for (const key of store.keys()) store.remove(key);
      location.reload();
    });
    parts.push(group('This device', 'In Preview mode everything is stored in this browser only — nothing is sent to a server.',
      settingRow('Clear data stored on this device', 'Your list, progress, history and preferences. The page reloads afterwards.', wipe)));
  }
  return parts;
}

// ── Accessibility ─────────────────────────────────────────
function accessibilitySection(sctx) {
  const a = currentAppearance();
  const motion = choice({
    label: 'Motion',
    value: a.motion || 'system',
    options: [{ value: 'system', label: 'System' }, { value: 'reduced', label: 'Reduced' }, { value: 'full', label: 'Full' }],
    onChange: autosave(sctx, (v) => saveAppearance({ motion: v }), () => motion.set(currentAppearance().motion || 'system')),
  });
  const density = choice({
    label: 'Interface density',
    value: a.density,
    options: [{ value: 'compact', label: 'Compact' }, { value: 'comfortable', label: 'Comfortable' }, { value: 'spacious', label: 'Spacious' }],
    onChange: autosave(sctx, (v) => saveAppearance({ density: v }), () => density.set(currentAppearance().density)),
  });
  const parts = [
    group('Motion', 'Reduced motion stops the hero rotation, parallax and drifting particles; everything still works.',
      settingRow('Motion', 'System follows your device’s reduced-motion setting.', motion),
      settingRow('Animated particles', 'Petals, leaves, snow, fireflies and embers.', sw(sctx, { checked: a.animation, label: 'Animated particles', save: (v) => saveAppearance({ animation: v }) })),
      settingRow('Parallax depth', 'Garden layers shifting with the pointer and scroll.', sw(sctx, { checked: a.parallax, label: 'Parallax depth', save: (v) => saveAppearance({ parallax: v }) })),
      settingRow('Rotate the featured banner', 'Turn off to keep the banner still until you choose the next title.', sw(sctx, { checked: a.heroAutoRotate, label: 'Rotate the featured banner', save: (v) => saveAppearance({ heroAutoRotate: v }) }))),
    group('Reading comfort', null,
      settingRow('Interface density', 'More space between controls can make the interface easier to use.', density),
      settingRow('Translucent surfaces', 'Turn off for solid panels with stronger contrast behind text.', sw(sctx, { checked: a.translucent, label: 'Translucent surfaces', save: (v) => saveAppearance({ translucent: v }) }))),
  ];
  if (session.profile) {
    parts.push(group('Captions', 'Style and size are in Language & subtitles.',
      settingRow('Captions on by default', 'Start every title with subtitles or captions in your preferred language, when the title has them.', sw(sctx, { checked: session.profile.subtitlesDefault, label: 'Captions on by default', save: (v) => saveProfile({ subtitlesDefault: v }) })),
      h('div', { class: 'lm-form-actions', style: { marginTop: 'var(--lm-space-3)' } }, linkButton('Subtitle style', '#/settings/language', { variant: 'glass', size: 'sm', icon: 'subtitles' }))));
  }
  parts.push(group('Keyboard', null,
    h('ul', { class: 'lm-kbd-list', role: 'list' },
      h('li', null, h('kbd', { class: 'lm-kbd' }, '/'), 'Search from anywhere'),
      h('li', null, h('kbd', { class: 'lm-kbd' }, 'Tab'), 'Move between controls; a gold ring shows where you are'),
      h('li', null, h('kbd', { class: 'lm-kbd' }, 'Esc'), 'Close dialogs, menus and search suggestions'))));
  return parts;
}

// ── About ─────────────────────────────────────────────────
function aboutSection() {
  const replay = button('Replay the introduction', { variant: 'primary', icon: 'play' });
  replay.addEventListener('click', () => playIntro({ force: true }));
  return [
    group(null, null,
      h('div', { class: 'lm-about' },
        logoMark('lm-about__mark'),
        h('div', { style: { flex: '1 1 240px' } },
          h('h3', null, 'LUMINA'),
          h('p', null, `Version ${VERSION} · ${session.isServer ? 'Connected to the Lumina server' : 'Preview mode on static hosting — the open catalog, with your list and preferences kept on this device'}`)),
        replay)),
    group('Good to know', null,
      h('ul', { class: 'lm-link-list', role: 'list' },
        h('li', null, h('a', { href: '#/legal/terms' }, 'Terms of Service')),
        h('li', null, h('a', { href: '#/legal/privacy' }, 'Privacy Policy')),
        h('li', null, h('a', { href: '#/legal/cookies' }, 'Cookie Policy')),
        h('li', null, h('a', { href: '#/legal/accessibility' }, 'Accessibility statement')),
        h('li', null, h('a', { href: '#/legal/contact' }, 'Contact & support'))),
      h('p', { class: 'lm-muted lm-small', style: { marginTop: 'var(--lm-space-4)' } }, 'Open films courtesy of the Blender Foundation under Creative Commons licences — each title lists its attribution.')),
  ];
}

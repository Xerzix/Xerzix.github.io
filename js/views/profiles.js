// Profiles inside the signed-in account: choose one (/profiles) or manage them (/profiles/manage).
// (The opening "Who's watching?" screen lists separate accounts: see views/identities.js.)
// Up to five profiles share one account: each has its own list, history, recommendations,
// maturity rating, optional PIN and preferences. They are not separate subscriptions and
// do not add simultaneous streams.
import { h, newUid, announce, prefersReducedMotion } from '../core/dom.js';
import { api } from '../api/client.js';
import { session, refreshSession, setProfile } from '../core/session.js';
import { INTERFACE_LANGUAGES } from '../core/i18n.js';
import { MATURITY_PRESETS } from '../core/ratings.js';
import { avatar, AVATARS } from '../ui/avatars.js';
import { icon } from '../ui/icons.js';
import { applyFieldErrors, button, confirmDialog, errorState, field, linkButton, notice, openModal, settingRow, toast, toastError, toggleSwitch, withBusy } from '../ui/components.js';
import { safeNext } from './auth.js';
import { grownUpReason, isRestrictedProfile, lockAgain, reauth, withReauth } from './account.js';
import { bus } from '../core/bus.js';

/** Audio and subtitle language choices (ISO 639-1). */
export const MEDIA_LANGUAGES = [
  ['en', 'English'], ['ja', 'Japanese — 日本語'], ['es', 'Spanish — Español'], ['fr', 'French — Français'], ['de', 'German — Deutsch'],
  ['it', 'Italian — Italiano'], ['pt', 'Portuguese — Português'], ['ko', 'Korean — 한국어'], ['zh', 'Chinese — 中文'], ['hi', 'Hindi — हिन्दी'],
  ['ar', 'Arabic — العربية'], ['ru', 'Russian — Русский'], ['nl', 'Dutch — Nederlands'], ['sv', 'Swedish — Svenska'], ['pl', 'Polish — Polski'], ['tr', 'Turkish — Türkçe'],
].map(([value, label]) => ({ value, label }));

export const KIDS_MAX_AGE = 13;

export function maturityLabel(maxAge) {
  return MATURITY_PRESETS.find((m) => m.maxAge === (maxAge ?? null))?.label || (maxAge ? `Up to age ${maxAge}` : 'All maturity ratings');
}

export const HOUSEHOLD_NOTE = 'Profiles are for the people who share this account. Each has its own list, history, recommendations and settings. They are not separate subscriptions and don’t add simultaneous streams.';

/** The explanation the API sends with PROFILE_LIMIT (server/services/profiles.js), shown before anyone tries. */
export function profileLimitMessage(max) {
  return `This account already has ${max} profiles, the maximum. Profiles belong to one account — they are not separate subscriptions or simultaneous streams. Delete a profile to create another.`;
}

const PARENTAL_NOTE = 'kids profiles, and any profile with a maturity rating, only show titles within that rating. While one is active, adding, deleting or unlocking profiles and changing ratings need the account password. Add a PIN to grown-up profiles so nobody else can switch into them.';

const minutes = (s) => Math.max(1, Math.ceil((Number(s) || 300) / 60));

// ── PIN prompts ───────────────────────────────────────────
function pinInput(label, describedBy) {
  const input = h('input', {
    class: 'lm-input lm-pin__input', type: 'password', inputmode: 'numeric', autocomplete: 'off', maxlength: 4, pattern: '[0-9]*',
    'aria-label': label, 'aria-describedby': describedBy, enterkeyhint: 'done',
  });
  input.addEventListener('input', () => {
    const clean = input.value.replace(/\D/g, '').slice(0, 4);
    if (clean !== input.value) input.value = clean;
  });
  return input;
}

/**
 * Asks for a profile's 4-digit PIN and runs `submit(pin)`. Resolves with `{ pin, result }`
 * once it succeeds, or null when cancelled. `onForgot` adds a "Forgot the PIN?" link.
 */
export function pinPrompt({ profile, title, message, submit, onForgot }) {
  return new Promise((resolve) => {
    let outcome = null;
    let busy = false;
    let modal;
    const errId = newUid('pin-err');
    const input = pinInput(`4-digit PIN for ${profile.name}`, errId);
    const err = h('p', { class: 'lm-pin__error', id: errId, role: 'alert' });
    const wrap = h('div', { class: 'lm-pin' }, avatar(profile.avatar), h('p', null, message), input, err,
      onForgot ? h('button', { type: 'button', class: 'lm-pin__forgot', onClick: () => { outcome = null; modal.close(); onForgot(); } }, 'Forgot the PIN?') : null);
    const go = button('Continue', { variant: 'primary', onClick: () => attempt() });
    modal = openModal({ title, content: wrap, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), go] });
    modal.closed.then(() => resolve(outcome));
    setTimeout(() => input.focus(), 40);

    async function attempt() {
      const pin = input.value;
      if (!/^\d{4}$/.test(pin)) {
        err.textContent = 'Enter all 4 digits.';
        input.focus();
        return;
      }
      if (busy) return;
      busy = true;
      try {
        const result = await withBusy(go, () => submit(pin));
        outcome = { pin, result };
        modal.close();
      } catch (e) {
        wrap.classList.remove('is-shaking');
        void wrap.offsetWidth;
        wrap.classList.add('is-shaking');
        err.textContent = e.code === 'PIN_INVALID' ? 'That PIN is not correct. Try again.'
          : e.code === 'RATE_LIMITED' ? `Too many attempts. Try again in ${minutes(e.retryAfter)} minute${minutes(e.retryAfter) === 1 ? '' : 's'}.`
            : e.message;
        input.value = '';
        input.focus();
      } finally {
        busy = false;
      }
    }
    input.addEventListener('input', () => {
      err.textContent = '';
      if (input.value.length === 4) attempt();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        attempt();
      }
    });
  });
}

/** Choose (or change) a PIN: two entries that must match. Resolves with the new PIN or null. */
function choosePin({ profile, title = 'Choose a PIN', submit }) {
  return new Promise((resolve) => {
    let outcome = null;
    let modal;
    const formId = newUid('pin-new');
    const errId = newUid('pin-new-err');
    const first = pinInput('New 4-digit PIN', errId);
    const second = pinInput('Confirm the new PIN', errId);
    first.id = newUid('pin-a');
    second.id = newUid('pin-b');
    const err = h('p', { class: 'lm-pin__error', id: errId, role: 'alert' });
    const form = h('form', { id: formId, class: 'lm-pin', novalidate: true },
      avatar(profile.avatar),
      h('p', null, `The PIN will be needed to open ${profile.name} and to change its settings. Choose one that kids won’t guess.`),
      h('label', { class: 'lm-label', for: first.id }, 'New PIN'), first,
      h('label', { class: 'lm-label', for: second.id }, 'Confirm PIN'), second, err);
    const save = button('Save PIN', { variant: 'primary', type: 'submit', attrs: { form: formId } });
    modal = openModal({ title, content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), save] });
    modal.closed.then(() => resolve(outcome));
    setTimeout(() => first.focus(), 40);
    first.addEventListener('input', () => {
      if (first.value.length === 4) second.focus();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!/^\d{4}$/.test(first.value)) {
        err.textContent = 'Use exactly 4 digits.';
        return first.focus();
      }
      if (first.value !== second.value) {
        err.textContent = 'The PINs do not match.';
        second.value = '';
        return second.focus();
      }
      withBusy(save, async () => {
        try {
          await submit(first.value);
          outcome = first.value;
          modal.close();
        } catch (ex) {
          err.textContent = ex.message;
        }
      });
    });
  });
}

/** "Forgot the PIN?": the account password lets the owner set a new one. */
async function resetForgottenPin(profile) {
  if (!(await reauth({ reason: `Enter the account password to reset the PIN for ${profile.name}.` }))) return null;
  const pin = await choosePin({ profile, title: `New PIN for ${profile.name}`, submit: (value) => api.profiles.setPin(profile.id, { pin: value }) });
  if (pin) toast(`${profile.name}’s PIN was reset.`, { type: 'success' });
  return pin;
}

// ── View ──────────────────────────────────────────────────
export default async function render(ctx) {
  const manage = ctx.path === '/profiles/manage';
  let next = safeNext(ctx.query.get('next'));
  if (next.startsWith('/profiles')) next = '/';
  const nextQ = next !== '/' ? `?next=${encodeURIComponent(next)}` : '';
  ctx.setTitle(manage ? 'Manage profiles' : 'Choose a profile');

  const root = h('div', { class: 'lm-profiles' });
  const heading = h('h1', null, manage ? 'Manage profiles' : 'Choose a profile');
  let data;
  try {
    data = await api.profiles.list();
  } catch (err) {
    root.append(heading, errorState(err, { retry: () => ctx.navigate(ctx.raw) }));
    return root;
  }

  const lede = h('p', { class: 'lm-profiles__lede' });
  const grid = h('ul', { class: 'lm-profiles__grid', role: 'list', 'aria-label': 'Profiles' });
  const notes = h('div');
  const actions = h('div', { class: 'lm-profiles__actions' });
  root.append(h('span', { class: 'lm-eyebrow lm-profiles__eyebrow' }, manage ? 'Your household' : 'Welcome to Lumina'), heading, lede, grid, notes, actions);

  const reloadData = async () => {
    data = await api.profiles.list();
    draw();
  };
  // A kids or maturity-limited profile is active: changes need a grown-up's password.
  const restricted = () => isRestrictedProfile(session.profile);
  const restrictedLocked = () => restricted() && !session.elevated;
  if (manage) {
    // The server ends a grown-up's confirmation after one change; redraw the notice when it does.
    let wasElevated = session.elevated;
    const off = bus.on('session:changed', () => {
      if (session.elevated !== wasElevated) {
        wasElevated = session.elevated;
        draw();
      }
    });
    ctx.onDestroy?.(off);
  }

  function draw() {
    const count = data.profiles.length;
    const atLimit = count >= data.max;
    lede.textContent = manage
      ? 'Choose a profile to edit its name, picture, maturity rating, languages or PIN.'
      : 'Choose your profile. Each one keeps its own list, progress and recommendations.';
    const limitId = newUid('limit');
    grid.replaceChildren(
      ...data.profiles.map((p, i) => h('li', null, tile(p, i))),
      h('li', null, addTile(count, atLimit, limitId)),
    );
    notes.replaceChildren();
    const countPill = h('span', { class: 'lm-profiles__count' }, icon('users', { size: 16 }), `${count} of ${data.max} profiles`);
    if (atLimit) {
      notes.append(h('div', { class: 'lm-profiles__note lm-profiles__note--limit', id: limitId },
        countPill,
        h('p', null, profileLimitMessage(data.max)),
        manage ? h('p', null, h('strong', null, 'Parental controls: '), PARENTAL_NOTE) : null));
    } else if (manage) {
      notes.append(h('div', { class: 'lm-profiles__note' },
        countPill,
        h('p', null, HOUSEHOLD_NOTE),
        h('p', null, h('strong', null, 'Parental controls: '), PARENTAL_NOTE)));
    }
    if (manage && restricted()) {
      const who = session.profile.isKids ? 'A kids profile' : 'A profile with a maturity rating';
      if (!session.elevated) {
        const unlock = h('button', { type: 'button', class: 'lm-link' }, 'confirm the account password');
        unlock.addEventListener('click', async () => {
          if (await reauth({ reason: grownUpReason('manage profiles') })) {
            await refreshSession();
            draw();
          }
        });
        notes.append(h('div', { class: 'lm-profiles__notice' }, notice(h('span', null, `${who} is active, so profile changes are locked. Switch to a grown-up profile, or `, unlock, '.'), { type: 'warn', title: 'Parental controls' })));
      } else {
        const lock = button('Lock now', { variant: 'glass', size: 'sm', icon: 'lock' });
        lock.addEventListener('click', () => withBusy(lock, async () => {
          try {
            await lockAgain();
            announce('Profile changes locked');
            draw();
          } catch (err) {
            toastError(err);
          }
        }));
        notes.append(h('div', { class: 'lm-profiles__notice' }, notice(h('div', null,
          h('p', null, `Unlocked for a grown-up while ${session.profile.name} is active. The confirmation covers one change and ends after 5 minutes.`),
          h('div', { class: 'lm-parental-actions' }, lock)), { type: 'info', title: 'Parental controls' })));
      }
    }
    actions.replaceChildren(manage
      ? linkButton('Done', `#/profiles${nextQ}`, { variant: 'primary', size: 'lg' })
      : linkButton('Manage profiles', `#/profiles/manage${nextQ}`, { variant: 'glass', icon: 'edit' }));
  }

  function tile(p, i) {
    const current = session.profile?.id === p.id;
    const label = manage
      ? `Edit ${p.name}`
      : [p.name, p.isKids && 'kids profile', p.hasPin && 'locked with a PIN', current && 'current profile'].filter(Boolean).join(', ');
    const btn = h('button', { type: 'button', class: 'lm-profile-tile', style: { '--i': i }, 'aria-label': label },
      h('span', { class: 'lm-profile-tile__art' },
        avatar(p.avatar),
        p.hasPin && !manage ? h('span', { class: 'lm-profile-tile__lock', 'aria-hidden': 'true' }, icon('lock')) : null,
        manage ? h('span', { class: 'lm-profile-tile__edit', 'aria-hidden': 'true' }, icon('edit')) : null),
      h('span', { class: 'lm-profile-tile__name' }, p.name),
      h('span', { class: 'lm-profile-tile__meta', 'aria-hidden': 'true' },
        p.isKids ? h('span', { class: 'lm-badge lm-badge--4k' }, 'Kids') : null,
        manage && p.hasPin ? h('span', { class: 'lm-badge' }, icon('lock', { size: 12 }), 'PIN') : null,
        current ? h('span', { class: 'lm-badge lm-badge--solid' }, 'Current') : null));
    btn.addEventListener('click', () => (manage ? edit(p) : choose(p, btn)));
    return btn;
  }

  function addTile(count, atLimit, limitId) {
    const btn = h('button', {
      type: 'button', class: 'lm-profile-tile lm-profile-tile--add', style: { '--i': count },
      'aria-disabled': atLimit ? 'true' : undefined, 'aria-describedby': atLimit ? limitId : undefined,
      'aria-label': atLimit ? `Add profile (unavailable — ${count} of ${data.max} profiles)` : 'Add profile',
    },
    h('span', { class: 'lm-profile-tile__art' }, icon('plus')),
    h('span', { class: 'lm-profile-tile__name' }, 'Add profile'),
    h('span', { class: 'lm-profile-tile__meta lm-xsmall lm-muted', 'aria-hidden': 'true' }, `${count} of ${data.max}`));
    btn.addEventListener('click', () => {
      if (atLimit) {
        toast(profileLimitMessage(data.max), { type: 'info', timeout: 8000 });
        const note = document.getElementById(limitId);
        note?.scrollIntoView({ block: 'center', behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
        note?.classList.remove('is-flagged');
        void note?.offsetWidth;
        note?.classList.add('is-flagged');
        return;
      }
      openEditor(null);
    });
    return btn;
  }

  async function choose(p, btn) {
    if (btn.classList.contains('is-busy')) return;
    const enter = async () => {
      await refreshSession();
      announce(`Watching as ${p.name}`);
      ctx.navigate(next, { replace: true });
    };
    const withPin = async () => {
      const ok = await pinPrompt({
        profile: p, title: `Enter ${p.name}’s PIN`, message: 'This profile is locked with a PIN.',
        submit: (pin) => api.profiles.select(p.id, { pin }),
        onForgot: async () => {
          const pin = await resetForgottenPin(p);
          if (pin) {
            await api.profiles.select(p.id, { pin });
            await enter();
          }
        },
      });
      if (ok) await enter();
    };
    try {
      if (p.hasPin && p.id !== session.profile?.id) return await withPin();
      btn.classList.add('is-busy');
      await api.profiles.select(p.id, {});
      await enter();
    } catch (err) {
      btn.classList.remove('is-busy');
      if (err.code === 'PIN_REQUIRED') return withPin();
      toastError(err);
    }
  }

  async function edit(p) {
    let pin;
    if (restrictedLocked() && p.id !== session.profile?.id) {
      // Editing another profile from a restricted one needs a grown-up first.
      if (!(await reauth({ reason: grownUpReason(`edit ${p.name}`) }))) return;
      await refreshSession().catch(() => {});
    }
    if (p.hasPin && !session.elevated) {
      const ok = await pinPrompt({
        profile: p, title: `Edit ${p.name}`, message: 'Enter this profile’s PIN to change its settings.',
        // A PATCH with only the PIN verifies it without changing anything.
        submit: (value) => api.profiles.update(p.id, { pin: value }),
        onForgot: async () => {
          const newPin = await resetForgottenPin(p);
          if (newPin) {
            await reloadData();
            openEditor(data.profiles.find((x) => x.id === p.id), newPin);
          }
        },
      });
      if (!ok) return;
      pin = ok.pin;
    }
    openEditor(p, pin);
  }

  function openEditor(p, pin) {
    const creating = !p;
    let currentPin = pin;
    let hasPin = !!p?.hasPin;
    const formId = newUid('profile');
    const alert = h('div', { role: 'alert' });

    const nameF = field({ label: 'Name', name: 'name', value: p?.name || '', maxlength: 40, required: true });
    nameF.control.setAttribute('autocomplete', 'off');
    const used = new Set(data.profiles.filter((x) => x.id !== p?.id).map((x) => x.avatar));
    const startAvatar = p?.avatar || AVATARS.find((a) => !used.has(a.id))?.id || AVATARS[0].id;
    const avatarName = newUid('avatar');
    const preview = h('span', null, avatar(startAvatar));
    const picker = h('fieldset', { class: 'lm-profile-form__group' },
      h('legend', null, 'Profile picture'),
      h('div', { class: 'lm-avatar-picker' }, ...AVATARS.map((a) => {
        const input = h('input', { type: 'radio', name: avatarName, value: a.id, checked: a.id === startAvatar, 'aria-label': a.name });
        input.addEventListener('change', () => preview.replaceChildren(avatar(a.id)));
        return h('label', { class: 'lm-avatar-option', title: a.name }, input, avatar(a.id), h('span', { class: 'lm-avatar-option__check', 'aria-hidden': 'true' }, icon('check')));
      })));

    let kids = !!p?.isKids;
    const maturity = h('select', { class: 'lm-select', name: 'maxAge' });
    const fillMaturity = (value) => {
      const options = MATURITY_PRESETS.filter((m) => !kids || (m.maxAge !== null && m.maxAge <= KIDS_MAX_AGE));
      maturity.replaceChildren(...options.map((m) => h('option', { value: m.maxAge === null ? '' : String(m.maxAge) }, m.label)));
      const wanted = value === null || value === undefined ? '' : String(value);
      maturity.value = options.some((m) => String(m.maxAge ?? '') === wanted) ? wanted : String(options[0].maxAge ?? '');
    };
    fillMaturity(p ? p.maxAge : null);
    const maturityF = field({ label: 'Maturity rating', control: maturity, hint: 'Titles rated above this are hidden everywhere for this profile, including search and Velvia.' });
    const kidsSwitch = toggleSwitch({
      checked: kids,
      label: 'Kids profile',
      onChange: (v) => {
        kids = v;
        const currentAge = maturity.value === '' ? null : Number(maturity.value);
        fillMaturity(v ? (currentAge !== null && currentAge <= KIDS_MAX_AGE ? currentAge : 7) : currentAge);
      },
    });

    const uiF = field({ label: 'Interface language', name: 'uiLanguage', type: 'select', value: p?.uiLanguage || 'en', options: INTERFACE_LANGUAGES.map((l) => ({ value: l.code, label: l.coverage === 'Complete' ? l.name : `${l.name} (partial)` })) });
    const audioF = field({ label: 'Preferred audio', name: 'audioLanguage', type: 'select', value: p?.audioLanguage || '', options: [{ value: '', label: 'Original language' }, ...MEDIA_LANGUAGES] });
    const subsF = field({ label: 'Preferred subtitles', name: 'subtitleLanguage', type: 'select', value: p?.subtitleLanguage || '', options: [{ value: '', label: 'Same as the interface' }, ...MEDIA_LANGUAGES] });
    const subsDefault = toggleSwitch({ checked: !!p?.subtitlesDefault, label: 'Subtitles on by default' });
    const autoNext = toggleSwitch({ checked: p ? p.autoplayNext : true, label: 'Autoplay next episode' });
    const autoPrev = toggleSwitch({ checked: p ? p.autoplayPreviews : true, label: 'Autoplay previews' });

    const pinStatus = h('span');
    const pinButtons = h('div', { class: 'lm-cluster lm-cluster--sm' });
    const drawPin = () => {
      pinStatus.textContent = hasPin
        ? 'A 4-digit PIN is needed to open this profile and to change its settings.'
        : 'No PIN. Anyone using this account can open this profile.';
      const add = button(hasPin ? 'Change PIN' : 'Add a PIN', { variant: 'glass', size: 'sm', icon: 'lock' });
      add.addEventListener('click', async () => {
        const newPin = await choosePin({
          profile: p, title: hasPin ? `Change ${p.name}’s PIN` : `Lock ${p.name} with a PIN`,
          submit: (value) => withReauth(() => api.profiles.setPin(p.id, { pin: value, currentPin }), { reason: grownUpReason('change PINs') }),
        });
        if (newPin) {
          currentPin = newPin;
          hasPin = true;
          drawPin();
          toast(`${p.name} is locked with a PIN.`, { type: 'success' });
          changed = true;
        }
      });
      const remove = hasPin ? button('Remove PIN', { variant: 'ghost', size: 'sm' }) : null;
      remove?.addEventListener('click', async () => {
        if (!(await confirmDialog({ title: 'Remove the PIN?', message: `Anyone using this account will be able to open ${p.name} and change its settings.`, confirmLabel: 'Remove PIN' }))) return;
        try {
          const res = await withReauth(() => api.profiles.setPin(p.id, { pin: null, currentPin }), { reason: grownUpReason('remove PINs') });
          if (res === undefined) return;
          hasPin = false;
          currentPin = undefined;
          drawPin();
          toast('PIN removed.', { type: 'success' });
          changed = true;
        } catch (err) {
          toastError(err);
        }
      });
      pinButtons.replaceChildren(...[add, remove].filter(Boolean));
    };
    let changed = false;

    const form = h('form', { id: formId, class: 'lm-profile-form', novalidate: true },
      alert,
      h('div', { class: 'lm-profile-editor-head' }, preview, h('div', { style: { flex: '1' } }, nameF)),
      picker,
      h('fieldset', { class: 'lm-profile-form__group' },
        h('legend', null, 'Viewing'),
        settingRow('Kids profile', 'A simpler, safer space for younger viewers. It can’t add, delete or unlock other profiles.', kidsSwitch),
        maturityF),
      h('fieldset', { class: 'lm-profile-form__group' },
        h('legend', null, 'Languages'),
        h('div', { class: 'lm-form-row' }, uiF, audioF, subsF),
        settingRow('Subtitles on by default', 'Turn on subtitles in your preferred language when playback starts.', subsDefault)),
      h('fieldset', { class: 'lm-profile-form__group' },
        h('legend', null, 'Playback'),
        settingRow('Autoplay next episode', 'Continue a series automatically.', autoNext),
        settingRow('Autoplay previews', 'Play trailers quietly while browsing.', autoPrev)),
      creating ? null : h('fieldset', { class: 'lm-profile-form__group' },
        h('legend', null, 'Profile lock'),
        h('div', { class: 'lm-profile-form__pin' }, pinStatus, pinButtons)),
      creating || data.profiles.length < 2 ? null : h('div', { class: 'lm-profile-form__danger' },
        button('Delete profile', { variant: 'danger', size: 'sm', icon: 'trash', onClick: () => remove() })));
    if (!creating) drawPin();

    const save = button(creating ? 'Create profile' : 'Save', { variant: 'primary', type: 'submit', attrs: { form: formId } });
    let modal;
    modal = openModal({
      title: creating ? 'Add a profile' : `Edit ${p.name}`,
      size: 'wide',
      content: form,
      actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), save],
      onClose: () => {
        if (changed) reloadData().catch(() => {});
      },
    });
    setTimeout(() => nameF.control.focus(), 40);

    const checked = (sw) => sw.getAttribute('aria-checked') === 'true';
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      alert.replaceChildren();
      const name = nameF.control.value.trim();
      nameF.setError(name ? '' : 'Give the profile a name.');
      if (!name) return nameF.control.focus();
      const payload = {
        name,
        avatar: form.querySelector(`input[name="${avatarName}"]:checked`)?.value || startAvatar,
        isKids: kids,
        maxAge: maturity.value === '' ? null : Number(maturity.value),
        uiLanguage: uiF.control.value,
        audioLanguage: audioF.control.value || null,
        subtitleLanguage: subsF.control.value || null,
        subtitlesDefault: checked(subsDefault),
        autoplayNext: checked(autoNext),
        autoplayPreviews: checked(autoPrev),
      };
      withBusy(save, async () => {
        try {
          const res = await withReauth(
            () => (creating ? api.profiles.create(payload) : api.profiles.update(p.id, { ...payload, pin: currentPin })),
            { reason: grownUpReason(creating ? 'add a profile' : p.id === session.profile?.id ? 'change this profile’s maturity rating' : `change ${p.name}`) },
          );
          if (!res) return;
          if (res.profile.id === session.profile?.id) setProfile(res.profile);
          changed = true;
          modal.close();
          toast(creating ? `${res.profile.name} is ready.` : `${res.profile.name} saved.`, { type: 'success' });
        } catch (err) {
          if (err.fields) applyFieldErrors(form, err);
          if (err.code === 'PROFILE_LIMIT') {
            // Another device may have filled the last place since this page loaded.
            const max = err.extra?.max || data.max;
            alert.replaceChildren(notice(err.message || profileLimitMessage(max), { type: 'warn', title: `${max} of ${max} profiles` }));
            changed = true;
          } else if (!err.fields || err.code === 'PIN_REQUIRED' || err.code === 'PIN_INVALID') {
            alert.replaceChildren(notice(err.code?.startsWith('PIN_') ? 'The PIN was not accepted. Close this window and enter the PIN again.' : err.message, { type: 'danger' }));
          }
          if (alert.firstChild) alert.scrollIntoView({ block: 'nearest' });
        }
      });
    });

    async function remove() {
      const ok = await confirmDialog({
        title: `Delete ${p.name}?`,
        message: `${p.name}’s list, collections, watch history, progress, ratings, reviews and preferences will be permanently deleted. Other profiles are not affected.`,
        confirmLabel: 'Delete profile',
        danger: true,
      });
      if (!ok) return;
      try {
        const res = await withReauth(() => api.profiles.remove(p.id, { pin: currentPin }), { reason: grownUpReason('delete profiles') });
        if (res === undefined) return; // cancelled the password prompt
        changed = true;
        modal.close();
        if (session.profile?.id === p.id) await refreshSession();
        toast(`${p.name} was deleted.`, { type: 'success' });
      } catch (err) {
        if (err.code === 'LAST_PROFILE') alert.replaceChildren(notice(err.message, { type: 'warn' }));
        else toastError(err);
      }
    }
  }

  draw();
  return root;
}

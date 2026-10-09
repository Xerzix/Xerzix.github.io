// Settings (administrators): platform settings and the genre / editorial collection taxonomy.
import { h } from '../../core/dom.js';
import { button, field, notice, toast, toastError, toggleSwitch, withBusy } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { badge, errorSummary, inlineLoading, listEditor, page, panel, time } from '../ui.js';

/** Badges that say what a setting does on this server right now. */
function settingBadges(s) {
  return h('div', { class: 'adm-setting-meta' },
    s.envLocked
      ? badge(`Off via ${s.env}`, 'warn')
      : s.enforced ? badge('Enforced', 'ok') : badge('Not enforced yet', 'warn'),
    s.isDefault ? badge('Default') : null);
}

function settingsPanel(data, onSaved) {
  const values = {};
  const rows = data.settings.map((s) => {
    const changed = s.updatedAt ? h('p', { class: 'adm-setting-effect' }, 'Changed ', time(s.updatedAt)) : null;
    if (s.type === 'boolean') {
      values[s.key] = s.value;
      const labelId = `adm-set-${s.key}`;
      const sw = toggleSwitch({ checked: !!s.value, label: s.label, onChange: (v) => { values[s.key] = v; } });
      sw.setAttribute('aria-describedby', `${labelId}-effect`);
      if (s.envLocked) sw.disabled = true;
      return h('div', { class: 'lm-setting adm-setting' },
        h('div', { class: 'adm-setting__text' },
          h('strong', { id: labelId }, s.label),
          settingBadges(s),
          h('p', { class: 'adm-setting-effect', id: `${labelId}-effect` }, s.effect),
          changed),
        sw);
    }
    const f = field({ label: s.label, name: s.key, type: 'textarea', rows: 3, value: s.value || '', maxlength: 500, hint: s.effect });
    values[s.key] = () => f.control.value.trim() || null;
    return h('div', { class: 'lm-setting adm-setting adm-setting--block' }, settingBadges(s), f, changed);
  });
  const save = button('Save settings', { variant: 'primary', icon: 'check' });
  save.addEventListener('click', () => withBusy(save, async () => {
    const body = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, typeof v === 'function' ? v() : v]));
    try {
      const r = await adminApi.platform.saveSettings(body);
      toast('Settings saved.', { type: 'success' });
      onSaved(r);
    } catch (err) {
      toastError(err);
    }
  }));
  const pending = data.settings.filter((s) => !s.enforced && !s.envLocked);
  return panel({
    title: 'Platform settings',
    description: 'Stored in the database and recorded in the audit log. Server environment variables always win: a feature switched off in the environment cannot be switched on here.',
  },
  pending.length ? notice(`${pending.map((s) => s.label).join(', ')} ${pending.length === 1 ? 'is' : 'are'} saved and audited, but no feature on this server reads ${pending.length === 1 ? 'it' : 'them'} yet, so changing ${pending.length === 1 ? 'it' : 'them'} does not affect members. Settings marked “Enforced” take effect immediately.`, { type: 'warn', title: 'Not every setting is enforced yet' }) : null,
  h('div', { class: 'adm-settings-list' }, ...rows),
  h('div', { style: { marginTop: '16px' } }, save));
}

function taxonomyPanel(tax, onSaved) {
  const summary = errorSummary();
  const genres = field({
    label: 'Genres',
    name: 'genres',
    type: 'textarea',
    rows: 6,
    value: tax.genres.join('\n'),
    hint: 'One per line. Members see genres in this order on the Genres page (genres not listed follow alphabetically), and editors get them as suggestions in the title editor.',
  });
  const collections = listEditor({
    legend: 'Editorial collections',
    hint: 'Each collection with at least one published title becomes a row on the home page and on Discover, in this order, with this name and description. Add a collection to a title by giving the title its id as a tag. The ids hidden-gem, lumina-original and japanese-cinema rename the home page’s built-in rows.',
    columns: [{ key: 'id', label: 'Id', placeholder: 'hidden-gem', mono: true, width: '28%' }, { key: 'name', label: 'Name', placeholder: 'Hidden gems' }, { key: 'description', label: 'Description' }],
    value: tax.collections,
    addLabel: 'Add collection',
    max: 60,
  });
  const usage = h('p', { class: 'lm-hint' }, `In use: ${Object.keys(tax.usage.genres).length} genres and ${Object.keys(tax.usage.collections).length} collections across the catalog.${tax.customised ? '' : ' Showing what the catalog uses today — save to curate the list.'}`);
  const save = button('Save taxonomy', { variant: 'primary', icon: 'check' });
  save.addEventListener('click', () => withBusy(save, async () => {
    summary.clear();
    try {
      const r = await adminApi.taxonomy.put({
        genres: genres.control.value.split('\n').map((x) => x.trim()).filter(Boolean),
        collections: collections.getValue().map((c) => ({ id: c.id.toLowerCase(), name: c.name, ...(c.description ? { description: c.description } : {}) })),
      });
      toast('Taxonomy saved.', { type: 'success' });
      onSaved(r);
    } catch (err) {
      genres.setError(err.fields?.genres || '');
      summary.show(err);
    }
  }));
  return panel({ title: 'Genres & editorial collections' }, h('div', { class: 'lm-form' }, summary, usage, genres, collections, h('div', null, save)));
}

export default async function render(ctx) {
  const left = h('div', null, inlineLoading());
  const right = h('div', null, inlineLoading());
  const loadSettings = async () => {
    try {
      const data = await adminApi.platform.settings({ signal: ctx.signal });
      left.replaceChildren(settingsPanel(data, () => loadSettings()));
    } catch (err) {
      if (err.name !== 'AbortError') left.replaceChildren(notice(err.message, { type: 'danger' }));
    }
  };
  const loadTaxonomy = async () => {
    try {
      const tax = await adminApi.taxonomy.get({ signal: ctx.signal });
      right.replaceChildren(taxonomyPanel(tax, () => loadTaxonomy()));
    } catch (err) {
      if (err.name !== 'AbortError') right.replaceChildren(notice(err.message, { type: 'danger' }));
    }
  };
  loadSettings();
  loadTaxonomy();
  return page({ eyebrow: 'Platform', title: 'Settings', subtitle: 'Platform-wide switches and the taxonomy editors use. Every change is recorded in the audit log.' },
    h('div', { class: 'adm-grid-halves' }, left, right));
}

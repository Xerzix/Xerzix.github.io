// Title editor: every catalog field, seasons & episodes, media, and publishing with the
// server's publish checklist. `#/content/new` creates a draft (optionally pre-filled from
// TMDB); `#/content/:id?tab=details|episodes|media` edits an existing title.
import { h } from '../../core/dom.js';
import { AGE_RATINGS, minAgeFor } from '../../core/ratings.js';
import { icon } from '../../ui/icons.js';
import { button, checkbox, confirmDialog, field, notice, openModal, toast, toastError, withBusy } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { staff } from '../shell.js';
import { takeImport } from '../tmdb-import.js';
import { artworkUpload } from '../artwork-upload.js';
import { mediaTable, openMediaEditor } from '../media-editor.js';
import { appLink, badge, dataTable, errorSummary, iconButton, kv, listEditor, mono, page, panel, rerender, splitList, statusBadge, textField, time, viewTabs } from '../ui.js';

const RATING_OPTIONS = AGE_RATINGS.map((r) => ({ value: r.code, label: `${r.code} — ${r.label} (${r.minAge}+)` }));
const isSafeImage = (s) => /^https:\/\//i.test(s) || /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/.test(s);

function suggestions(control, options, label) {
  if (!options?.length) return null;
  const wrap = h('div', { class: 'adm-suggest', role: 'group', 'aria-label': label });
  const sync = () => {
    const current = splitList(control.value).map((x) => x.toLowerCase());
    for (const b of wrap.children) b.setAttribute('aria-pressed', String(current.includes(b.dataset.value.toLowerCase())));
  };
  for (const o of options) {
    const b = h('button', { type: 'button', dataset: { value: o.value }, 'aria-pressed': 'false' }, o.label);
    b.addEventListener('click', () => {
      const list = splitList(control.value);
      const i = list.findIndex((x) => x.toLowerCase() === o.value.toLowerCase());
      if (i >= 0) list.splice(i, 1);
      else list.push(o.value);
      control.value = list.join(', ');
      control.dispatchEvent(new Event('input', { bubbles: true }));
    });
    wrap.append(b);
  }
  control.addEventListener('input', sync);
  sync();
  return wrap;
}

function artPreview(control, { width, height, label }) {
  const img = h('img', { alt: '', width, height, style: { width: `${width}px`, height: `${height}px` } });
  const fig = h('figure', null, img, h('figcaption', null, label));
  const update = () => {
    const v = control.value.trim();
    fig.hidden = !v || !isSafeImage(v);
    if (!fig.hidden) img.src = v;
  };
  control.addEventListener('change', update);
  control.addEventListener('blur', update);
  update();
  return fig;
}

/** Builds the details form. Returns { el, body(), markClean(), dirty }. */
function detailsForm(t, { isNew, taxonomy, imported }) {
  const f = {};
  f.title = textField({ label: 'Title', name: 'title', value: t.title || '', required: true, maxlength: 200 });
  f.type = isNew ? field({ label: 'Type', name: 'type', type: 'select', value: t.type || 'movie', options: [{ value: 'movie', label: 'Film' }, { value: 'series', label: 'Series' }] }) : null;
  f.id = isNew ? field({ label: 'ID (URL slug)', name: 'id', value: '', placeholder: 'generated from the title', hint: 'Lowercase letters, numbers and hyphens. Cannot be changed later.' }) : null;
  f.originalTitle = field({ label: 'Original title', name: 'originalTitle', value: t.originalTitle || '' });
  f.tagline = textField({ label: 'Tagline', name: 'tagline', value: t.tagline || '', maxlength: 300 });
  f.synopsis = textField({ label: 'Synopsis', name: 'synopsis', type: 'textarea', rows: 6, value: t.synopsis || '', maxlength: 5000, hint: 'Required to publish. Avoid spoilers beyond the first act.' });
  f.year = field({ label: 'Year', name: 'year', type: 'number', value: t.year ?? '', min: 1870, max: 2100 });
  f.releaseDate = field({ label: 'Release date', name: 'releaseDate', type: 'date', value: t.releaseDate || '' });
  f.runtimeMin = field({ label: t.type === 'series' ? 'Typical episode runtime (min)' : 'Runtime (min)', name: 'runtimeMin', type: 'number', value: t.runtimeMin ?? '', min: 0 });
  f.originalLanguage = field({ label: 'Original language', name: 'originalLanguage', value: t.originalLanguage || '', placeholder: 'en', hint: 'Language code, e.g. en, ja, pt-BR.' });

  f.ageRating = field({ label: 'Age rating', name: 'ageRating', type: 'select', value: t.ageRating || 'NR', options: RATING_OPTIONS });
  f.ratingSource = field({
    label: 'Rating source', name: 'ratingSource', type: 'select', value: t.ratingSource || 'advisory',
    options: [{ value: 'official', label: 'Official — from a ratings board' }, { value: 'advisory', label: 'Advisory — assigned by Lumina' }],
    hint: 'Use “official” only for a certification issued by a ratings board. Viewers see which one applies.',
  });
  const minAge = h('output', { class: 'adm-stat__value', style: { fontSize: '1.4rem' } });
  const updateAge = () => { minAge.textContent = `${minAgeFor(f.ageRating.control.value)}+`; };
  f.ageRating.control.addEventListener('change', updateAge);
  updateAge();

  f.genres = field({ label: 'Genres', name: 'genres', value: (t.genres || []).join(', '), hint: 'Comma-separated. Followers of these genres are notified when the title is published.' });
  f.tags = field({ label: 'Editorial collections (tags)', name: 'tags', value: (t.tags || []).join(', '), hint: 'e.g. lumina-original, hidden-gem.' });
  f.moods = field({ label: 'Moods', name: 'moods', value: (t.moods || []).join(', '), hint: 'Used by search and Velvia, e.g. calm, bittersweet.' });
  f.keywords = field({ label: 'Keywords', name: 'keywords', value: (t.keywords || []).join(', ') });
  f.countries = field({ label: 'Countries', name: 'countries', value: (t.countries || []).join(', '), placeholder: 'JP, NL', hint: 'Two-letter ISO codes.' });
  f.awards = field({ label: 'Awards', name: 'awards', type: 'textarea', rows: 3, value: (t.awards || []).join('\n'), hint: 'One per line. Only awards the title actually received.' });

  const credits = t.credits || {};
  f.directors = field({ label: 'Directors / creators', name: 'credits.directors', value: (credits.directors || []).join(', '), hint: 'Comma-separated.' });
  const cast = listEditor({ legend: 'Cast', columns: [{ key: 'name', label: 'Name' }, { key: 'role', label: 'Role / character' }], value: credits.cast || [], addLabel: 'Add cast member', max: 150 });
  const crew = listEditor({ legend: 'Crew', columns: [{ key: 'name', label: 'Name' }, { key: 'job', label: 'Job', placeholder: 'Writer' }], value: credits.crew || [], addLabel: 'Add crew member', max: 150 });

  f.poster = field({ label: 'Poster', name: 'poster', value: t.poster || '', placeholder: 'assets/art/title-poster.svg', hint: 'Required to publish. 2:3 artwork you are licensed to use.' });
  f.backdrop = field({ label: 'Backdrop', name: 'backdrop', value: t.backdrop || '', placeholder: 'assets/art/title-backdrop.svg', hint: '16:9 artwork.' });
  const palette = listEditor({ legend: 'Palette', hint: 'Up to 8 colours used for ambient lighting around the player.', columns: [{ key: 'color', label: 'Colour', type: 'color' }], value: (t.palette || []).map((color) => ({ color })), addLabel: 'Add colour', max: 8 });

  const license = t.license || {};
  f.licenseName = field({ label: 'Licence', name: 'license.name', value: license.name || '', placeholder: 'CC BY 4.0, or “Licensed to Lumina”', hint: 'Required to publish.' });
  f.licenseUrl = field({ label: 'Licence URL', name: 'license.url', type: 'url', value: license.url || '' });
  f.licenseAttribution = field({ label: 'Attribution', name: 'license.attribution', value: license.attribution || '', hint: 'Required to publish. Shown to viewers on the title page.' });
  f.licenseSource = field({ label: 'Source', name: 'license.source', value: license.source || '', hint: 'Where the licence or the original work comes from.' });

  const featured = checkbox('Featured on the home page hero', { name: 'featured', checked: !!t.featured });
  f.editorialRank = field({ label: 'Editorial rank', name: 'editorialRank', type: 'number', value: t.editorialRank ?? 1000, min: 0, hint: 'Lower numbers appear first.' });
  f.creatorAccountId = field({ label: 'Creator account ID', name: 'creatorAccountId', value: t.creatorAccountId || '', hint: 'Links the title to a creator; their followers are notified on publish.' });

  const tmdbNotice = imported ? notice(h('div', { class: 'lm-stack lm-stack--sm' },
    h('span', null, 'Pre-filled from ', h('a', { class: 'lm-link', href: imported.source.url, target: '_blank', rel: 'noopener noreferrer' }, 'TMDB'), '. Review every field before saving. TMDB provides metadata only; it does not license the film for streaming. ',
      imported.ratingSource === 'official' ? `The ${imported.ageRating} rating is TMDB’s US certification.` : 'No US certification was found, so the rating is “NR” — assign an advisory rating.'),
    imported.artwork?.poster || imported.artwork?.backdrop ? h('span', null, 'TMDB artwork is subject to TMDB’s own terms and to the rights of its creators — prefer artwork you are licensed to use. Images from image.tmdb.org also only display if that origin is in MEDIA_ORIGINS. ',
      imported.artwork.poster ? button('Use TMDB poster URL anyway', { variant: 'ghost', size: 'sm', onClick: () => { f.poster.control.value = imported.artwork.poster; f.poster.control.dispatchEvent(new Event('change')); markDirty(); } }) : null) : null),
  { type: 'warn', title: 'Imported from TMDB' }) : null;

  const summary = errorSummary();
  const el = h('form', { class: 'adm-form', novalidate: true },
    tmdbNotice,
    summary,
    panel({ title: 'Basics' }, h('div', { class: 'adm-fields adm-fields--wide' },
      h('div', { class: 'adm-span' }, f.title), f.type, f.id, f.originalTitle, h('div', { class: 'adm-span' }, f.tagline), h('div', { class: 'adm-span' }, f.synopsis),
      f.year, f.releaseDate, f.runtimeMin, f.originalLanguage)),
    panel({ title: 'Age rating', description: 'The minimum age drives parental controls on kids profiles.' }, h('div', { class: 'adm-fields' },
      f.ageRating, f.ratingSource, h('div', { class: 'lm-field' }, h('span', { class: 'lm-label' }, 'Minimum viewer age'), minAge, h('span', { class: 'lm-hint' }, 'Computed from the rating (unrated titles count as 18+).')))),
    panel({ title: 'Discovery' }, h('div', { class: 'adm-form' },
      h('div', null, f.genres, suggestions(f.genres.control, (taxonomy?.genres || []).map((g) => ({ value: g, label: g })), 'Genre suggestions')),
      h('div', null, f.tags, suggestions(f.tags.control, (taxonomy?.collections || []).map((c) => ({ value: c.id, label: c.name })), 'Collection suggestions')),
      h('div', { class: 'adm-fields' }, f.moods, f.keywords, f.countries),
      f.awards)),
    panel({ title: 'Credits' }, h('div', { class: 'adm-form' }, f.directors, cast, crew)),
    panel({ title: 'Artwork', description: 'Upload PNG, JPEG or WebP artwork you are licensed to use, or enter a site path (assets/…) or https URL. External images load only from origins allowed by the Content-Security-Policy (MEDIA_ORIGINS).' },
      h('div', { class: 'adm-form' },
        h('div', { class: 'adm-fields' },
          h('div', { class: 'lm-stack lm-stack--sm' }, f.poster, artworkUpload({ role: 'poster', label: 'Poster', control: f.poster.control })),
          h('div', { class: 'lm-stack lm-stack--sm' }, f.backdrop, artworkUpload({ role: 'backdrop', label: 'Backdrop', control: f.backdrop.control }))),
        h('div', { class: 'adm-artpreview' }, artPreview(f.poster.control, { width: 96, height: 144, label: 'Poster preview' }), artPreview(f.backdrop.control, { width: 256, height: 144, label: 'Backdrop preview' })),
        palette)),
    panel({ title: 'Licence & attribution', description: 'Lumina only streams media it is licensed to show. Record the licence exactly as granted.' },
      h('div', { class: 'adm-fields' }, f.licenseName, f.licenseUrl, f.licenseAttribution, f.licenseSource)),
    panel({ title: 'Editorial' }, h('div', { class: 'adm-fields' }, h('div', { class: 'lm-field', style: { justifyContent: 'center' } }, featured), f.editorialRank, f.creatorAccountId)));

  let dirty = isNew && !!imported;
  const listeners = new Set();
  const markDirty = () => {
    dirty = true;
    listeners.forEach((fn) => fn(true));
  };
  el.addEventListener('input', markDirty);
  el.addEventListener('change', markDirty);
  el.addEventListener('click', (e) => { if (e.target.closest('.adm-rowbtn, .adm-listedit .lm-btn')) markDirty(); });

  const val = (x) => x.control.value.trim();
  const numOrNull = (x) => (x.control.value === '' ? null : Number(x.control.value));
  const body = () => {
    const out = {
      title: val(f.title),
      originalTitle: val(f.originalTitle) || null,
      tagline: val(f.tagline) || null,
      synopsis: val(f.synopsis) || null,
      year: numOrNull(f.year),
      releaseDate: val(f.releaseDate) || null,
      runtimeMin: numOrNull(f.runtimeMin),
      originalLanguage: val(f.originalLanguage) || null,
      ageRating: f.ageRating.control.value,
      ratingSource: f.ratingSource.control.value,
      genres: splitList(f.genres.control.value),
      tags: splitList(f.tags.control.value).map((x) => x.toLowerCase().replace(/\s+/g, '-')),
      moods: splitList(f.moods.control.value),
      keywords: splitList(f.keywords.control.value),
      countries: splitList(f.countries.control.value).map((c) => c.toUpperCase()),
      awards: f.awards.control.value.split('\n').map((x) => x.trim()).filter(Boolean),
      credits: { directors: splitList(f.directors.control.value), cast: cast.getValue().map((c) => ({ name: c.name, ...(c.role ? { role: c.role } : {}) })), crew: crew.getValue() },
      poster: val(f.poster) || null,
      backdrop: val(f.backdrop) || null,
      palette: palette.getValue().map((p) => p.color).filter(Boolean),
      license: Object.fromEntries(Object.entries({ name: val(f.licenseName), url: val(f.licenseUrl), attribution: val(f.licenseAttribution), source: val(f.licenseSource) }).filter(([, v]) => v)),
      featured: featured.querySelector('input').checked,
      creatorAccountId: val(f.creatorAccountId) || null,
    };
    if (f.editorialRank.control.value !== '') out.editorialRank = Number(f.editorialRank.control.value);
    if (isNew) {
      out.type = f.type.control.value;
      if (val(f.id)) out.id = val(f.id);
    }
    return out;
  };
  return {
    el,
    body,
    summary,
    get dirty() { return dirty; },
    onDirty: (fn) => listeners.add(fn),
    markClean() {
      dirty = false;
      listeners.forEach((fn) => fn(false));
    },
    focusFirst: () => f.title.control.focus(),
  };
}

function importedToTitle(m) {
  return {
    type: m.type, title: m.title, originalTitle: m.originalTitle, tagline: m.tagline, synopsis: m.synopsis, year: m.year, releaseDate: m.releaseDate,
    runtimeMin: m.runtimeMin, ageRating: m.ageRating, ratingSource: m.ratingSource, genres: m.genres, keywords: m.keywords, countries: m.countries,
    originalLanguage: m.originalLanguage, credits: m.credits, license: {}, palette: [], tags: [], moods: [], awards: [],
  };
}

// ───────────────────────────── Side panels ─────────────────────────────

const CHECKS = [
  ['synopsis', 'Synopsis'],
  ['poster', 'Poster artwork'],
  ['license', 'Licence name and attribution'],
  ['media', 'Ready main media'],
];

function publishPanel(data, { form, onChange }) {
  const t = data.title;
  const missing = new Map(data.publish.missing.map((m) => [m.field, m.message]));
  const list = h('ul', { class: 'adm-checklist', 'aria-label': 'Publishing requirements' }, ...CHECKS.map(([key, label]) => {
    const miss = missing.get(key);
    const text = key === 'media' && t.type === 'series' ? 'At least one episode with ready media' : label;
    return h('li', { class: miss ? 'is-missing' : 'is-ok' }, icon(miss ? 'alert' : 'checkCircle'), h('span', null, text, miss ? h('span', { class: 'visually-hidden' }, ' — missing') : h('span', { class: 'visually-hidden' }, ' — done'), miss ? h('small', { class: 'lm-hint', style: { display: 'block' } }, miss) : null));
  }));
  const actions = h('div', { class: 'lm-stack lm-stack--sm' });
  const dirtyNote = h('p', { class: 'lm-hint', hidden: !form?.dirty }, 'Save your changes before publishing.');
  if (t.status === 'published') {
    const unpub = button('Unpublish', { variant: 'ghost', icon: 'eyeOff', block: true });
    unpub.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `Unpublish “${t.title}”?`, message: 'It disappears from the catalog, search and every My List immediately. You can publish it again later.', confirmLabel: 'Unpublish', danger: true }))) return;
      await withBusy(unpub, async () => {
        try {
          onChange(await adminApi.titles.unpublish(t.id));
          toast('Unpublished.', { type: 'success' });
        } catch (err) {
          toastError(err);
        }
      });
    });
    actions.append(appLink('View on Lumina', `#/title/${encodeURIComponent(t.id)}`), unpub);
  } else {
    const pub = button('Publish', { variant: 'primary', icon: 'upload', block: true, disabled: missing.size > 0 || form?.dirty });
    form?.onDirty((d) => {
      pub.disabled = d || missing.size > 0;
      dirtyNote.hidden = !d;
    });
    pub.addEventListener('click', async () => {
      const ok = await confirmDialog({
        title: `Publish “${t.title}”?`,
        message: 'It appears in the catalog immediately. Followers of its genres (and of its creator) are notified once.',
        confirmLabel: 'Publish',
      });
      if (!ok) return;
      await withBusy(pub, async () => {
        try {
          const r = await adminApi.titles.publish(t.id);
          const n = (r.notified?.genreRelease || 0) + (r.notified?.creatorRelease || 0);
          toast(`Published.${n ? ` ${n} follower${n === 1 ? '' : 's'} notified.` : ''}`, { type: 'success' });
          onChange(r);
        } catch (err) {
          toastError(err);
        }
      });
    });
    actions.append(pub, dirtyNote);
    if (missing.size) actions.append(h('p', { class: 'lm-hint' }, 'Complete the checklist to publish.'));
  }
  if (staff.isAdmin && t.status !== 'published') {
    const del = button('Delete title', { variant: 'danger', icon: 'trash', block: true });
    del.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: `Delete “${t.title}”?`, message: 'This permanently deletes the title with its seasons, episodes, media entries, reviews and viewing progress. Files in storage are kept.', confirmLabel: 'Delete permanently', danger: true }))) return;
      try {
        await adminApi.titles.remove(t.id);
        toast('Title deleted.', { type: 'success' });
        location.hash = '#/content';
      } catch (err) {
        toastError(err);
      }
    });
    actions.append(del);
  }
  return panel({ title: 'Publishing', actions: [statusBadge(t.status)] },
    h('div', { class: 'lm-stack' },
      t.publishedAt ? h('p', { class: 'lm-hint' }, 'First published ', time(t.publishedAt, { absolute: true })) : null,
      list,
      actions));
}

function recordPanel(data) {
  const t = data.title;
  return panel({ title: 'Record' }, kv([
    ['ID', mono(t.id)],
    ['Type', t.type === 'series' ? 'Series' : 'Film'],
    ['Added', time(t.addedAt, { absolute: true })],
    ['Updated', time(t.updatedAt)],
    ['Creator', data.creator ? h('a', { class: 'lm-link', href: `#/users/${encodeURIComponent(data.creator.id)}` }, data.creator.name || data.creator.email) : null],
    ['Submission', data.submission ? h('a', { class: 'lm-link', href: `#/submissions/${encodeURIComponent(data.submission.id)}` }, `${data.submission.projectTitle} (${data.submission.status})`) : null],
    t.type === 'series' ? ['Series followers', String(data.followers)] : null,
  ]));
}

// ───────────────────────────── Episodes tab ─────────────────────────────

function seasonDialog(t, season, onDone) {
  const number = field({ label: 'Season number', name: 'number', type: 'number', value: season?.number ?? '', min: 0, required: true });
  const name = field({ label: 'Name', name: 'name', value: season?.name || '', placeholder: 'Season 1' });
  const synopsis = field({ label: 'Synopsis', name: 'synopsis', type: 'textarea', rows: 3, value: season?.synopsis || '' });
  const year = field({ label: 'Year', name: 'year', type: 'number', value: season?.year ?? '' });
  const form = h('form', { class: 'lm-form', novalidate: true }, h('div', { class: 'adm-fields' }, number, year), name, synopsis);
  const save = button(season ? 'Save season' : 'Add season', { variant: 'primary' });
  const modal = openModal({ title: season ? `Edit season ${season.number}` : 'Add a season', content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), save] });
  form.addEventListener('submit', (e) => { e.preventDefault(); save.click(); });
  save.addEventListener('click', () => withBusy(save, async () => {
    const body = { number: number.control.value === '' ? undefined : Number(number.control.value), name: name.control.value.trim() || null, synopsis: synopsis.control.value.trim() || null, year: year.control.value === '' ? null : Number(year.control.value) };
    try {
      if (season?.id) await adminApi.seasons.update(season.id, body);
      else await adminApi.titles.createSeason(t.id, body);
      modal.close();
      onDone();
    } catch (err) {
      for (const [k, fl] of Object.entries({ number, name, synopsis, year })) fl.setError(err.fields?.[k] || '');
      if (!err.fields) toastError(err);
    }
  }));
}

function episodeDialog(t, seasons, ep, onDone, defaultSeason) {
  const nextNumber = (sn) => 1 + Math.max(0, ...(seasons.find((s) => s.number === sn)?.episodes || []).map((e) => e.number));
  const sn0 = ep?.seasonNumber ?? defaultSeason ?? seasons.at(-1)?.number ?? 1;
  const seasonNumber = field({ label: 'Season', name: 'seasonNumber', type: 'number', value: sn0, min: 0, required: true });
  const number = field({ label: 'Episode number', name: 'number', type: 'number', value: ep?.number ?? nextNumber(sn0), min: 0, required: true });
  const name = field({ label: 'Name', name: 'name', value: ep?.name || '', required: true, maxlength: 200 });
  const synopsis = field({ label: 'Synopsis', name: 'synopsis', type: 'textarea', rows: 3, value: ep?.synopsis || '' });
  const runtimeMin = field({ label: 'Runtime (min)', name: 'runtimeMin', type: 'number', value: ep?.runtimeMin ?? '' });
  const airDate = field({ label: 'Air date', name: 'airDate', type: 'date', value: ep?.airDate || '' });
  const still = field({ label: 'Still image', name: 'still', value: ep?.still || '', placeholder: 'assets/art/…' });
  const form = h('form', { class: 'lm-form', novalidate: true }, h('div', { class: 'adm-fields' }, seasonNumber, number), name, synopsis, h('div', { class: 'adm-fields' }, runtimeMin, airDate), still);
  const save = button(ep ? 'Save episode' : 'Add episode', { variant: 'primary' });
  const modal = openModal({ title: ep ? `Edit S${ep.seasonNumber} E${ep.number}` : 'Add an episode', content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), save] });
  form.addEventListener('submit', (e) => { e.preventDefault(); save.click(); });
  save.addEventListener('click', () => withBusy(save, async () => {
    const n = (x) => (x.control.value === '' ? null : Number(x.control.value));
    const body = { seasonNumber: n(seasonNumber), number: n(number), name: name.control.value.trim(), synopsis: synopsis.control.value.trim() || null, runtimeMin: n(runtimeMin), airDate: airDate.control.value || null, still: still.control.value.trim() || null };
    try {
      if (ep) await adminApi.episodes.update(ep.id, body);
      else await adminApi.titles.createEpisode(t.id, body);
      modal.close();
      onDone();
    } catch (err) {
      for (const [k, fl] of Object.entries({ seasonNumber, number, name, synopsis, runtimeMin, airDate, still })) fl.setError(err.fields?.[k] || '');
      if (!err.fields) toastError(err);
    }
  }));
  setTimeout(() => name.control.focus(), 40);
}

function episodesTab(data, reload) {
  const t = data.title;
  const seasons = data.seasons;
  const header = h('div', { class: 'lm-cluster' },
    button('Add season', { variant: 'ghost', icon: 'plus', onClick: () => seasonDialog(t, null, reload) }),
    button('Add episode', { variant: 'primary', icon: 'plus', onClick: () => episodeDialog(t, seasons, null, reload) }));
  if (!seasons.length) return h('div', { class: 'adm-page' }, header, notice('No seasons yet. Add a season, then its episodes. Each episode needs its own media.', { type: 'info' }));
  return h('div', { class: 'adm-page' }, header, ...seasons.map((s) => panel({
    title: `Season ${s.number}${s.name && s.name !== `Season ${s.number}` ? ` · ${s.name}` : ''}`,
    description: s.synopsis || null,
    flush: true,
    actions: [
      button('Add episode', { variant: 'ghost', size: 'sm', icon: 'plus', onClick: () => episodeDialog(t, seasons, null, reload, s.number) }),
      s.id ? button('Edit', { variant: 'ghost', size: 'sm', icon: 'edit', onClick: () => seasonDialog(t, s, reload) }) : null,
      s.id && staff.isAdmin ? button('Delete', {
        variant: 'ghost', size: 'sm', icon: 'trash',
        onClick: async () => {
          if (!(await confirmDialog({ title: `Delete season ${s.number}?`, message: `This deletes the season and its ${s.episodes.length} episode${s.episodes.length === 1 ? '' : 's'}, with their media entries and viewing progress.`, confirmLabel: 'Delete season', danger: true }))) return;
          try {
            await adminApi.seasons.remove(s.id);
            toast('Season deleted.', { type: 'success' });
            reload();
          } catch (err) {
            toastError(err);
          }
        },
      }) : null,
    ].filter(Boolean),
  }, dataTable({
    caption: `Season ${s.number} episodes`,
    empty: 'No episodes in this season yet.',
    columns: [
      { key: 'number', label: 'No.', render: (e) => `E${e.number}`, className: 'adm-nowrap' },
      { key: 'name', label: 'Episode', rowHeader: false, render: (e) => h('div', { class: 'adm-cellstack' }, h('span', null, e.name), e.synopsis ? h('small', { class: 'adm-truncate' }, e.synopsis) : null) },
      { key: 'runtimeMin', label: 'Runtime', render: (e) => (e.runtimeMin ? `${e.runtimeMin} min` : null) },
      { key: 'airDate', label: 'Air date' },
      {
        key: 'media',
        label: 'Media',
        render: (e) => {
          const main = e.media.find((m) => m.role === 'main');
          return main ? h('div', { class: 'adm-badges' }, statusBadge(main.status), main.verified ? badge('Verified', 'ok') : badge('Unverified')) : h('span', { class: 'lm-muted' }, 'No media');
        },
      },
      {
        key: 'actions',
        label: 'Actions',
        render: (e) => {
          const main = e.media.find((m) => m.role === 'main');
          return h('div', { class: 'adm-actions' },
            button(main ? 'Media' : 'Add media', { variant: 'ghost', size: 'sm', icon: main ? 'layers' : 'plus', onClick: () => openMediaEditor({ media: main || null, titleId: t.id, episodeId: e.id, onSaved: reload }), attrs: { 'aria-label': `${main ? 'Edit media for' : 'Add media to'} ${e.name}` } }),
            iconButton('edit', `Edit ${e.name}`, () => episodeDialog(t, seasons, e, reload)),
            staff.isAdmin ? iconButton('trash', `Delete ${e.name}`, async () => {
              if (!(await confirmDialog({ title: `Delete “${e.name}”?`, message: 'This deletes the episode, its media entries and viewing progress.', confirmLabel: 'Delete episode', danger: true }))) return;
              try {
                await adminApi.episodes.remove(e.id);
                reload();
              } catch (err) {
                toastError(err);
              }
            }, { danger: true }) : null);
        },
      },
    ],
    rows: s.episodes,
  }))));
}

function mediaTab(data, reload) {
  const t = data.title;
  const episodes = data.seasons.flatMap((s) => s.episodes);
  return h('div', { class: 'adm-page' },
    h('div', { class: 'lm-cluster' },
      button('Add media', { variant: 'primary', icon: 'plus', onClick: () => openMediaEditor({ titleId: t.id, onSaved: reload }) }),
      h('span', { class: 'lm-hint' }, 'Verify each entry so Lumina records the real renditions, codecs and tracks.')),
    panel({ flush: true, title: 'Media entries', description: t.type === 'series' ? 'Episode media and title-level trailers or extras.' : 'The film itself, plus trailers and extras.' },
      mediaTable(data.media, { episodes, onChange: reload, onEdit: (m) => openMediaEditor({ media: m, onSaved: reload }), empty: 'No media yet. Add the main video first.' })));
}

// ───────────────────────────── View ─────────────────────────────

export default async function render(ctx) {
  const isNew = !ctx.params.id;
  const tab = ['details', 'episodes', 'media'].includes(ctx.query.get('tab')) ? ctx.query.get('tab') : 'details';
  const taxonomy = await adminApi.taxonomy.get({ signal: ctx.signal }).catch(() => null);

  if (isNew) {
    const imported = ctx.query.get('from') === 'tmdb' ? takeImport() : null;
    const form = detailsForm(imported ? importedToTitle(imported) : { type: 'movie', ageRating: 'NR', ratingSource: 'advisory' }, { isNew: true, taxonomy, imported });
    const save = button('Create draft', { variant: 'primary', icon: 'check' });
    save.addEventListener('click', () => withBusy(save, async () => {
      form.summary.clear();
      try {
        const r = await adminApi.titles.create(form.body());
        form.markClean();
        toast('Draft created. Add media, then publish when the checklist is complete.', { type: 'success' });
        ctx.navigate(`/content/${encodeURIComponent(r.title.id)}`, { replace: true });
      } catch (err) {
        applyErrors(form, err);
      }
    }));
    form.el.addEventListener('submit', (e) => { e.preventDefault(); save.click(); });
    ctx.setTitle('New title');
    return page({ title: 'New title', eyebrow: 'Content', back: { href: '#/content', label: 'All titles' }, subtitle: 'New titles start as drafts. Nothing is visible to viewers until it is published.' },
      form.el,
      h('div', { class: 'adm-savebar' }, h('span', { class: 'adm-savebar__state' }, 'Draft — not visible to viewers'), h('a', { class: 'lm-btn lm-btn--ghost', href: '#/content' }, h('span', null, 'Cancel')), save));
  }

  let data = await adminApi.titles.get(ctx.params.id, { signal: ctx.signal });
  const root = h('div');
  const reload = async () => {
    try {
      data = await adminApi.titles.get(ctx.params.id);
      draw();
    } catch (err) {
      toastError(err);
    }
  };
  let form = null;

  function draw() {
    const t = data.title;
    ctx.setTitle(t.title);
    const episodeCount = data.seasons.reduce((n, s) => n + s.episodes.length, 0);
    const tabs = viewTabs({
      label: 'Title sections',
      base: `/content/${encodeURIComponent(t.id)}`,
      active: tab,
      tabs: [
        { id: 'details', label: 'Details', query: '' },
        t.type === 'series' ? { id: 'episodes', label: `Episodes (${episodeCount})`, query: 'tab=episodes' } : null,
        { id: 'media', label: `Media (${data.media.length})`, query: 'tab=media' },
      ].filter(Boolean),
    });
    tabs.addEventListener('click', async (e) => {
      const a = e.target.closest('a');
      if (!a || !form?.dirty) return;
      e.preventDefault();
      if (await confirmDialog({ title: 'Discard unsaved changes?', message: 'Your edits to the details have not been saved.', confirmLabel: 'Discard', danger: true })) {
        form.markClean();
        ctx.navigate(a.getAttribute('href').slice(1));
      }
    });

    let content;
    if (tab === 'episodes' && t.type === 'series') content = episodesTab(data, reload);
    else if (tab === 'media') content = mediaTab(data, reload);
    else {
      form = detailsForm(t, { isNew: false, taxonomy });
      const state = h('span', { class: 'adm-savebar__state', 'aria-live': 'polite' }, 'All changes saved');
      const bar = h('div', { class: 'adm-savebar' }, state);
      const save = button('Save changes', { variant: 'primary', icon: 'check', disabled: true });
      const discard = button('Discard', { variant: 'ghost', disabled: true, onClick: () => { form.markClean(); draw(); } });
      bar.append(discard, save);
      form.onDirty((d) => {
        bar.classList.toggle('is-dirty', d);
        state.textContent = d ? 'Unsaved changes' : 'All changes saved';
        save.disabled = !d;
        discard.disabled = !d;
      });
      save.addEventListener('click', () => withBusy(save, async () => {
        form.summary.clear();
        try {
          data = await adminApi.titles.update(t.id, form.body());
          form.markClean();
          toast('Changes saved.', { type: 'success' });
          side.replaceChildren(publishPanel(data, { form, onChange: (d) => { data = d; draw(); } }), recordPanel(data));
          status.replaceChildren(statusBadge(data.title.status));
        } catch (err) {
          applyErrors(form, err);
          save.disabled = false;
        }
      }));
      form.el.addEventListener('submit', (e) => { e.preventDefault(); if (!save.disabled) save.click(); });
      const side = h('div', { class: 'lm-stack adm-sticky' }, publishPanel(data, { form, onChange: (d) => { data = d; draw(); } }), recordPanel(data));
      content = h('div', { class: 'adm-grid-2' }, h('div', { class: 'lm-stack lm-stack--lg' }, form.el, bar), side);
    }
    if (tab !== 'details') form = null;
    const status = h('span', null, statusBadge(t.status));
    rerender(root, page({
      eyebrow: t.type === 'series' ? 'Series' : 'Film',
      title: t.title,
      back: { href: '#/content', label: 'All titles' },
      actions: [status, t.status === 'published' ? appLink('View on Lumina', `#/title/${encodeURIComponent(t.id)}`) : null].filter(Boolean),
    }, tabs, content));
  }
  draw();
  return root;
}

function applyErrors(form, err) {
  const fields = err.fields || {};
  for (const wrap of form.el.querySelectorAll('.lm-field')) {
    const name = wrap.control?.name;
    if (name) wrap.setError?.(fields[name] || '');
  }
  if (err.code === 'VALIDATION_FAILED' || err.fields) form.summary.show(err);
  else toastError(err);
}

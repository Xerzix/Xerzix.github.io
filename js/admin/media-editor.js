// Media entries: editor dialog (sources, fallbacks, variants, audio/subtitle tracks, markers),
// verification with its report, transcoding and deletion. Shared by the title editor's Media
// tab and the global Media page.
import { h } from '../core/dom.js';
import { resolutionLabel } from '../core/format.js';
import { button, confirmDialog, field, openModal, toast, toastError, withBusy, notice } from '../ui/components.js';
import { adminApi } from './api.js';
import { staff } from './shell.js';
import { badge, dataTable, errorSummary, iconButton, kv, listEditor, mono, splitList, statusBadge, time } from './ui.js';

const KINDS = [{ value: 'hls', label: 'HLS (adaptive .m3u8)' }, { value: 'progressive', label: 'Progressive file (.mp4/.webm)' }, { value: 'dash', label: 'DASH (.mpd)' }];
const ROLES = [{ value: 'main', label: 'Main video' }, { value: 'trailer', label: 'Trailer' }, { value: 'extra', label: 'Extra' }];
const HDR = [{ value: '', label: 'SDR (none)' }, { value: 'HDR10', label: 'HDR10' }, { value: 'HDR10+', label: 'HDR10+' }, { value: 'Dolby Vision', label: 'Dolby Vision' }, { value: 'HLG', label: 'HLG' }];
const STATUSES = [{ value: 'ready', label: 'Ready' }, { value: 'processing', label: 'Processing' }, { value: 'failed', label: 'Failed' }];

export function resolutionBadges(m) {
  if (!m.resolutions?.length) return m.verified ? h('span', { class: 'lm-muted' }, 'No resolution declared') : h('span', { class: 'lm-muted' }, 'Unverified');
  return h('div', { class: 'adm-badges' }, ...m.resolutions.map((r) => badge(r >= 2160 ? '4K' : `${r}p`, r >= 2160 ? '4k' : undefined)));
}

export function verifiedCell(m) {
  if (m.verified) return h('span', { class: 'adm-cellstack' }, statusBadge('ready', 'Verified'), h('small', null, time(m.verifiedAt)));
  const failed = m.verifyReport && m.verifyReport.ok === false;
  return h('span', { class: 'adm-cellstack' }, statusBadge(failed ? 'failed' : 'draft', failed ? 'Check failed' : 'Not verified'), failed ? h('small', { title: m.verifyReport.message }, m.verifyReport.code || '') : null);
}

function episodeLabel(e) {
  return `S${e.seasonNumber} E${e.number} · ${e.name}`;
}

/** Dialog showing what verification found (or why it could not). */
export function showVerifyReport(result) {
  const r = result.report || {};
  const content = [notice(result.message, { type: result.ok ? 'ok' : 'warn', title: result.ok ? 'Verified' : 'Not verified' })];
  if (r.renditions?.length) {
    content.push(dataTable({
      caption: 'Renditions in the manifest',
      captionHidden: false,
      columns: [
        { key: 'height', label: 'Resolution', render: (x) => (x.height ? resolutionLabel(x.height) : 'Not declared') },
        { key: 'bandwidth', label: 'Bandwidth', render: (x) => (x.bandwidth ? `${(x.bandwidth / 1e6).toFixed(2)} Mb/s` : '—'), className: 'adm-num' },
        { key: 'codecs', label: 'Codecs', render: (x) => mono((x.codecs || []).join(', ')) },
        { key: 'videoRange', label: 'Range', render: (x) => x.videoRange || '—' },
      ],
      rows: r.renditions,
    }));
  }
  if (r.audio?.length || r.subtitles?.length) {
    content.push(kv([
      ['Audio', r.audio?.length ? r.audio.map((a) => `${a.label || a.name || a.lang}${a.channels ? ` (${a.channels} ch)` : ''}${a.default ? ' · default' : ''}${a.label && a.name && a.label !== a.name ? ` — manifest name “${a.name}”` : ''}`).join(', ') : 'None declared'],
      ['Subtitles', r.subtitles?.length ? r.subtitles.map((s) => s.label || s.name || s.lang).join(', ') : 'None declared in the manifest'],
      ['Duration', r.durationS ? `${Math.round(r.durationS)} s (measured)` : null],
    ]));
  }
  if (r.probes?.length) content.push(kv(r.probes.map((p, i) => [i ? `Variant ${i}` : 'File', `${p.height ? `${p.height}p` : 'no video size'} · ${p.videoCodec || '?'} / ${p.audioCodec || 'no audio'}${p.durationS ? ` · ${Math.round(p.durationS)} s` : ''}`])));
  if (r.note) content.push(h('p', { class: 'lm-hint' }, r.note));
  openModal({ title: 'Verification result', size: 'wide', content: h('div', { class: 'adm-modal-stack' }, ...content) });
}

export async function verify(m, btn, onChange) {
  const run = async () => {
    try {
      const r = await adminApi.media.verify(m.id);
      toast(r.message, { type: r.ok ? 'success' : 'error', timeout: 6000 });
      showVerifyReport(r);
      onChange?.(r.media);
    } catch (err) {
      toastError(err);
    }
  };
  return btn ? withBusy(btn, run) : run();
}

export async function transcode(m, onChange) {
  const suggested = m.source?.startsWith('storage:') && !m.source.endsWith('.m3u8') ? m.source.slice(8) : '';
  const key = field({ label: 'Source file (private storage key)', name: 'sourceKey', value: suggested, hint: 'The original upload to transcode, e.g. submissions/sub_…/file.mp4. The result replaces this entry’s source with an HLS ladder.' });
  const go = button('Queue transcoding', { variant: 'primary', icon: 'refresh' });
  const modal = openModal({ title: 'Transcode to HLS', content: h('div', { class: 'adm-modal-stack' }, key), actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), go] });
  go.addEventListener('click', () => withBusy(go, async () => {
    try {
      const r = await adminApi.media.transcode(m.id, { sourceKey: key.control.value.trim() || undefined });
      toast(r.job?.existing ? 'A transcoding job is already queued for this entry.' : 'Transcoding queued.', { type: 'success' });
      modal.close();
      onChange?.(r.media);
    } catch (err) {
      if (err.fields?.sourceKey) key.setError(err.fields.sourceKey);
      else modal.body.prepend(notice(err.message, { type: err.status === 503 ? 'warn' : 'danger', title: err.status === 503 ? 'Transcoding unavailable' : undefined }));
    }
  }));
}

export async function remove(m, onChange) {
  const ok = await confirmDialog({ title: 'Delete this media entry?', message: `${m.source} will no longer be playable from this title. Files in storage are not deleted.`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await adminApi.media.remove(m.id);
    toast('Media entry deleted.', { type: 'success' });
    onChange?.(null);
  } catch (err) {
    toastError(err);
  }
}

export function mediaActions(m, { onChange, onEdit }) {
  const verifyBtn = button('Verify', { variant: 'ghost', size: 'sm', icon: 'checkCircle' });
  verifyBtn.setAttribute('aria-label', `Verify ${m.label || m.id}`);
  verifyBtn.addEventListener('click', () => verify(m, verifyBtn, onChange));
  return h('div', { class: 'adm-actions' },
    iconButton('edit', `Edit ${m.label || m.id}`, () => onEdit(m)),
    verifyBtn,
    m.source?.startsWith('storage:') ? iconButton('refresh', `Transcode ${m.label || m.id}`, () => transcode(m, onChange)) : null,
    staff.isAdmin ? iconButton('trash', `Delete ${m.label || m.id}`, () => remove(m, onChange), { danger: true }) : null);
}

/** Table of media entries. showTitle adds a title/episode column (global list). */
export function mediaTable(items, { showTitle = false, episodes = [], onChange, onEdit, empty = 'No media yet.' }) {
  const epName = (id) => {
    const e = episodes.find((x) => x.id === id);
    return e ? episodeLabel(e) : id;
  };
  return dataTable({
    caption: 'Media entries',
    empty,
    columns: [
      showTitle
        ? { key: 'title', label: 'Title', className: 'adm-minw', render: (m) => h('div', { class: 'adm-cellstack' }, h('a', { href: `#/content/${encodeURIComponent(m.titleId)}?tab=media` }, m.titleName || m.titleId), h('small', null, m.episodeId ? `S${m.seasonNumber} E${m.episodeNumber} · ${m.episodeName}` : ROLES.find((r) => r.value === m.role)?.label)) }
        : { key: 'role', label: 'Entry', render: (m) => h('div', { class: 'adm-cellstack' }, h('span', null, m.label || ROLES.find((r) => r.value === m.role)?.label), h('small', null, m.episodeId ? epName(m.episodeId) : ROLES.find((r) => r.value === m.role)?.label)) },
      { key: 'kind', label: 'Kind', render: (m) => m.kind.toUpperCase() },
      { key: 'source', label: 'Source', render: (m) => h('span', { class: 'adm-truncate', title: m.source }, mono(m.source)) },
      { key: 'resolutions', label: 'Renditions', render: resolutionBadges },
      { key: 'verified', label: 'Verification', render: verifiedCell },
      { key: 'status', label: 'Status', render: (m) => statusBadge(m.status) },
      { key: 'actions', label: 'Actions', render: (m) => mediaActions(m, { onChange, onEdit }), className: 'adm-nowrap' },
    ],
    rows: items,
  });
}

/**
 * Opens the editor. `titleId` is required for new entries; episodes are loaded from the title.
 *   openMediaEditor({ media?, titleId, episodeId?, onSaved(media) })
 */
export async function openMediaEditor({ media = null, titleId, episodeId = null, onSaved }) {
  let detail;
  try {
    detail = await adminApi.titles.get(media?.titleId || titleId);
  } catch (err) {
    toastError(err);
    return;
  }
  const t = detail.title;
  const episodes = detail.seasons.flatMap((s) => s.episodes);
  const m = media || { role: 'main', kind: 'hls', status: 'ready', episodeId, fallbacks: [], variants: [], audioTracks: [], subtitleTracks: [], audioFormats: [] };
  const isNew = !media;

  const role = field({ label: 'Role', name: 'role', type: 'select', value: m.role, options: ROLES });
  const episode = t.type === 'series'
    ? field({ label: 'Episode', name: 'episodeId', type: 'select', value: m.episodeId || '', options: [{ value: '', label: 'None (title-level trailer or extra)' }, ...episodes.map((e) => ({ value: e.id, label: episodeLabel(e) }))], hint: 'Main media for a series belongs to an episode.' })
    : null;
  const label = field({ label: 'Label', name: 'label', value: m.label || '', placeholder: 'e.g. Director’s cut', maxlength: 120 });
  const kind = field({ label: 'Kind', name: 'kind', type: 'select', value: m.kind, options: KINDS });
  const source = field({
    label: 'Source',
    name: 'source',
    value: m.source || '',
    required: true,
    hint: 'A site path under media/ (e.g. media/originals/x/master.m3u8), a private storage:<key>, or an https URL on an origin listed in MEDIA_ORIGINS. Changing it clears the verification.',
  });
  source.control.classList.add('adm-mono');
  const status = field({ label: 'Status', name: 'status', type: 'select', value: m.status, options: STATUSES, hint: 'Only ready media is playable and counts for publishing.' });
  const durationS = field({ label: 'Duration (seconds)', name: 'durationS', type: 'number', value: m.durationS ?? '', min: 0 });
  const introStart = field({ label: 'Intro starts (s)', name: 'introStart', type: 'number', value: m.introStart ?? '', min: 0 });
  const introEnd = field({ label: 'Intro ends (s)', name: 'introEnd', type: 'number', value: m.introEnd ?? '', min: 0 });
  const creditsStart = field({ label: 'Credits start (s)', name: 'creditsStart', type: 'number', value: m.creditsStart ?? '', min: 0 });
  const hdr = field({ label: 'HDR', name: 'hdr', type: 'select', value: m.hdr || '', options: HDR, hint: 'Replaced by what the manifest declares when you verify.' });
  const audioFormats = field({ label: 'Audio formats', name: 'audioFormats', value: (m.audioFormats || []).join(', '), placeholder: 'AAC, Stereo, 5.1, Dolby Atmos', hint: 'Comma-separated. Verification fills these from the manifest.' });

  const fallbacks = listEditor({
    legend: 'Fallback sources',
    hint: 'Tried in order if the main source fails to play.',
    columns: [{ key: 'kind', label: 'Kind', type: 'select', options: KINDS, width: '32%' }, { key: 'src', label: 'Source', mono: true }],
    value: m.fallbacks,
    addLabel: 'Add fallback',
    max: 6,
    blank: { kind: 'progressive' },
  });
  const variants = listEditor({
    legend: 'Progressive variants',
    hint: 'Alternative files at other heights (progressive media only).',
    columns: [{ key: 'height', label: 'Height', type: 'number', width: '18%' }, { key: 'src', label: 'Source', mono: true }, { key: 'bitrateKbps', label: 'kb/s', type: 'number', width: '16%' }],
    value: m.variants,
    addLabel: 'Add variant',
    max: 12,
  });
  const audioTracks = listEditor({
    legend: 'Audio tracks',
    hint: 'Declare only tracks that exist in the media. Verification replaces them with what an HLS manifest declares.',
    columns: [
      { key: 'lang', label: 'Language', placeholder: 'en', width: '14%' },
      { key: 'label', label: 'Label', placeholder: 'English' },
      { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'main', label: 'Main' }, { value: 'description', label: 'Audio description' }, { value: 'commentary', label: 'Commentary' }, { value: 'dub', label: 'Dub' }], width: '24%' },
      { key: 'default', label: 'Default', type: 'checkbox', width: '10%' },
    ],
    value: m.audioTracks,
    addLabel: 'Add audio track',
    max: 30,
    blank: { kind: 'main' },
  });
  const subtitleTracks = listEditor({
    legend: 'Subtitle tracks',
    hint: 'Side-loaded WebVTT files need a source; tracks declared inside the HLS manifest have none.',
    columns: [
      { key: 'lang', label: 'Language', placeholder: 'en', width: '12%' },
      { key: 'label', label: 'Label', placeholder: 'English' },
      { key: 'kind', label: 'Kind', type: 'select', options: [{ value: 'subtitles', label: 'Subtitles' }, { value: 'captions', label: 'Captions (SDH)' }], width: '18%' },
      { key: 'src', label: 'WebVTT source', mono: true, placeholder: 'media/…/en.vtt' },
      { key: 'default', label: 'Default', type: 'checkbox', width: '9%' },
    ],
    value: m.subtitleTracks,
    addLabel: 'Add subtitle track',
    max: 60,
    blank: { kind: 'subtitles' },
  });
  const syncKind = () => {
    variants.hidden = kind.control.value !== 'progressive';
  };
  kind.control.addEventListener('change', syncKind);
  syncKind();

  const summary = errorSummary();
  const verifiedInfo = !isNew ? h('div', { class: 'adm-panel' }, h('div', { class: 'adm-panel__body' }, kv([
    ['Verified renditions', resolutionBadges(m)],
    ['Video codecs', (m.videoCodecs || []).join(', ') || null],
    ['Verified', m.verifiedAt ? time(m.verifiedAt, { absolute: true }) : 'Not yet — use Verify after saving'],
    ['Last check', m.verifyReport?.message || m.verifyReport?.note || null],
  ]))) : notice('Save the entry, then use Verify so Lumina records the real renditions and tracks. Nothing is shown to viewers as 4K/HD until it is verified.', { type: 'info' });

  const form = h('form', { class: 'adm-form', novalidate: true },
    summary,
    verifiedInfo,
    h('div', { class: 'adm-fields' }, role, episode, label, kind, status),
    source,
    fallbacks,
    variants,
    h('div', { class: 'adm-fields' }, durationS, introStart, introEnd, creditsStart),
    h('div', { class: 'adm-fields' }, hdr, audioFormats),
    audioTracks,
    subtitleTracks);

  const numOrNull = (f) => (f.control.value === '' ? null : Number(f.control.value));
  const save = button(isNew ? 'Add media' : 'Save media', { variant: 'primary', icon: 'check' });
  const modal = openModal({ title: `${isNew ? 'Add media' : 'Edit media'} · ${t.title}`, size: 'wide', content: form, actions: [button('Cancel', { variant: 'ghost', onClick: () => modal.close() }), save] });
  modal.el.classList.add('adm-drawer');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save.click();
  });
  save.addEventListener('click', () => withBusy(save, async () => {
    summary.clear();
    for (const f of form.querySelectorAll('.lm-field')) f.setError?.('');
    const body = {
      role: role.control.value,
      episodeId: episode ? (episode.control.value || null) : undefined,
      label: label.control.value.trim() || null,
      kind: kind.control.value,
      source: source.control.value.trim(),
      status: status.control.value,
      durationS: numOrNull(durationS),
      introStart: numOrNull(introStart),
      introEnd: numOrNull(introEnd),
      creditsStart: numOrNull(creditsStart),
      hdr: hdr.control.value || null,
      audioFormats: splitList(audioFormats.control.value),
      fallbacks: fallbacks.getValue(),
      variants: kind.control.value === 'progressive' ? variants.getValue() : [],
      audioTracks: audioTracks.getValue(),
      subtitleTracks: subtitleTracks.getValue().map((s) => {
        const prev = (m.subtitleTracks || []).find((x) => x.lang === s.lang && x.label === s.label);
        return { ...s, src: s.src || null, ...(prev?.inManifest && !s.src ? { inManifest: true } : {}) };
      }),
    };
    if (!source.control.value.trim()) {
      source.setError('Enter a media location.');
      source.control.focus();
      return;
    }
    try {
      const r = isNew ? await adminApi.media.create({ ...body, titleId: t.id }) : await adminApi.media.update(m.id, body);
      toast(isNew ? 'Media added. Verify it to record its real renditions.' : (r.verificationReset ? 'Saved. The source changed, so verification was cleared.' : 'Media saved.'), { type: 'success' });
      if (r.notified) toast(`Notified ${r.notified} follower${r.notified === 1 ? '' : 's'} about the new episode.`, { type: 'info' });
      modal.close();
      onSaved?.(r.media);
    } catch (err) {
      const fields = err.fields || {};
      for (const f of form.querySelectorAll('.lm-field')) if (f.control?.name && fields[f.control.name]) f.setError(fields[f.control.name]);
      summary.show(err);
    }
  }));
  setTimeout(() => source.control.focus(), 40);
  return modal;
}

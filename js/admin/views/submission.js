// Submission detail: metadata, rights & attestation, files (signed preview/download links),
// the event timeline, status transitions with messages and internal notes, and — for
// administrators — turning an approved submission into a draft catalog title.
import { h } from '../../core/dom.js';
import { bus } from '../../core/bus.js';
import { countryName, languageName } from '../../core/format.js';
import { button, checkbox, confirmDialog, field, notice, openModal, toast, toastError, withBusy } from '../../ui/components.js';
import { adminApi } from '../api.js';
import { staff } from '../shell.js';
import { badge, bytes, dataTable, iconButton, kv, mono, page, panel, rerender, safeExternal, statusBadge, statusLabel, time } from '../ui.js';

const TRANSITION_COPY = {
  under_review: { label: 'Start review', hint: 'Tells the creator a reviewer has picked it up.' },
  info_required: { label: 'Request information', hint: 'The creator can reply and add files; the message is required.', needsMessage: true },
  approved: { label: 'Approve', hint: 'Approval does not publish anything.' },
  rejected: { label: 'Reject', hint: 'Explain the decision; the creator sees this message.', needsMessage: true, danger: true },
};
const EVENT_LABELS = { status: 'Status change', comment: 'Note', info_request: 'Information requested', info_response: 'Creator responded', file: 'File' };

async function openFile(submissionId, f, mode) {
  try {
    const r = await adminApi.submissions.fileUrl(submissionId, f.id);
    if (mode === 'download') {
      const a = h('a', { href: r.url, download: f.originalName, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      return;
    }
    const isVideo = /^video\//.test(r.mime);
    const isImage = /^image\//.test(r.mime);
    const media = isVideo
      ? h('video', { class: 'adm-preview-media', src: r.url, controls: true, preload: 'metadata', playsinline: true })
      : isImage ? h('img', { class: 'adm-preview-media', src: r.url, alt: `Preview of ${f.originalName}`, style: { objectFit: 'contain' } })
        : h('p', null, 'This file type cannot be previewed in the browser. ', h('a', { class: 'lm-link', href: r.url, download: f.originalName }, 'Download it'), ' instead.');
    const m = openModal({
      title: f.originalName,
      size: 'wide',
      content: h('div', { class: 'adm-modal-stack' }, media, h('p', { class: 'lm-hint' }, `Private link valid until ${new Date(r.expiresAt).toLocaleTimeString()}. Access is recorded in the audit log.`)),
      onClose: () => { if (isVideo) media.pause(); },
    });
    return m;
  } catch (err) {
    toastError(err);
  }
}

// Attestation answers (server/services/creators.js DISTRIBUTION_RIGHTS / CLEARANCE_ANSWERS).
const DISTRIBUTION = { owner: 'Copyright owner', exclusive_license: 'Exclusive licence', non_exclusive_license: 'Non-exclusive licence' };
const CLEARANCE = { yes: 'Yes', no: 'No', not_applicable: 'Not applicable' };

function answer(map, value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return map[value] || String(value);
}

function territoryList(list = []) {
  return list.map((c) => (c === 'WW' ? 'Worldwide' : /^[A-Z]{2}$/.test(c) ? `${countryName(c)} (${c})` : c)).join(', ');
}

function probeDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return seconds < 90 ? `${Math.round(seconds)} s` : `${Math.round(seconds / 60)} min`;
}

function probeSummary(f) {
  const p = f.probe;
  if (!p) return h('span', { class: 'lm-muted' }, 'Not probed');
  const parts = [p.height ? `${p.height}p` : null, p.videoCodec, p.audioCodec, probeDuration(p.durationS)].filter(Boolean);
  return h('div', { class: 'adm-cellstack' }, h('span', null, parts.join(' · ') || '—'), ['feature', 'episode', 'trailer'].includes(f.role) ? h('small', null, f.browserPlayable ? 'Browser-playable MP4' : 'Needs transcoding') : null);
}

export default async function render(ctx) {
  const root = h('div');
  const id = ctx.params.id;
  let data = await adminApi.submissions.get(id, { signal: ctx.signal });
  const reload = async (next) => {
    data = next || await adminApi.submissions.get(id);
    draw();
  };

  function statusPanel() {
    const s = data.submission;
    const allowed = data.allowedTransitions;
    if (!allowed.length) {
      const text = data.awaitingCreatorResponse
        ? 'Waiting for the creator to respond to your information request. You can move it back under review once they reply.'
        : s.status === 'approved' ? 'Approved. Create a draft title from it to prepare publication.'
          : s.status === 'published' ? 'Published. The title is live in the catalog.'
            : s.status === 'rejected' ? 'Rejected. No further transitions.'
              : 'No status changes are available right now.';
      return panel({ title: 'Status', actions: [statusBadge(s.status)] }, h('p', { class: 'lm-muted lm-small' }, text));
    }
    const radios = h('fieldset', { class: 'adm-radio-row' }, h('legend', { class: 'lm-label' }, 'Move to'),
      ...allowed.map((st, i) => h('label', { class: ['adm-radio', TRANSITION_COPY[st]?.danger && 'adm-radio--danger'] }, h('input', { type: 'radio', name: 'status', value: st, checked: i === 0 }), h('span', null, TRANSITION_COPY[st]?.label || statusLabel(st)))));
    const hint = h('p', { class: 'lm-hint' });
    const message = field({ label: 'Message to the creator', name: 'message', type: 'textarea', rows: 4, maxlength: 3000 });
    const internal = field({ label: 'Internal note (staff only)', name: 'internalNote', type: 'textarea', rows: 2, maxlength: 3000, hint: 'Never shown to the creator.' });
    const submit = button('Update status', { variant: 'primary', icon: 'check', block: true });
    const sync = () => {
      const st = radios.querySelector('input:checked').value;
      hint.textContent = TRANSITION_COPY[st]?.hint || '';
      message.querySelector('.lm-label').firstChild.textContent = TRANSITION_COPY[st]?.needsMessage ? 'Message to the creator (required)' : 'Message to the creator (optional)';
      submit.className = submit.className.replace(/lm-btn--(primary|danger)/, TRANSITION_COPY[st]?.danger ? 'lm-btn--danger' : 'lm-btn--primary');
    };
    radios.addEventListener('change', sync);
    const form = h('form', { class: 'lm-form', novalidate: true, onSubmit: (e) => { e.preventDefault(); submit.click(); } }, radios, hint, message, internal, submit);
    sync();
    submit.addEventListener('click', () => withBusy(submit, async () => {
      const st = radios.querySelector('input:checked').value;
      if (TRANSITION_COPY[st]?.needsMessage && !message.control.value.trim()) {
        message.setError('The creator needs to know why.');
        message.control.focus();
        return;
      }
      try {
        const r = await adminApi.submissions.setStatus(id, { status: st, message: message.control.value.trim() || undefined, internalNote: internal.control.value.trim() || undefined });
        toast(`Status changed to ${statusLabel(st).toLowerCase()}. The creator was notified.`, { type: 'success' });
        bus.emit('admin:queues-changed');
        reload(r);
      } catch (err) {
        message.setError(err.fields?.message || '');
        if (!err.fields) toastError(err);
      }
    }));
    return panel({ title: 'Status', actions: [statusBadge(s.status)] }, form);
  }

  function publishPanel() {
    const s = data.submission;
    if (data.title) {
      return panel({ title: 'Catalog title' }, h('div', { class: 'lm-stack lm-stack--sm' },
        h('p', { class: 'lm-small' }, h('a', { class: 'lm-link', href: `#/content/${encodeURIComponent(data.title.id)}` }, data.title.title), ' ', statusBadge(data.title.status)),
        data.title.status !== 'published' ? h('p', { class: 'lm-hint' }, 'Complete artwork, licence and rating, verify the media, then publish the title. The submission becomes “published” automatically and the creator is notified.') : null));
    }
    if (s.status !== 'approved') return null;
    if (!staff.isAdmin) return panel({ title: 'Publication' }, h('p', { class: 'lm-hint' }, 'An administrator can now create a draft catalog title from this submission.'));
    const create = button('Create draft title', { variant: 'primary', icon: 'film', block: true });
    create.addEventListener('click', async () => {
      if (!(await confirmDialog({ title: 'Create a draft title?', message: 'Lumina creates an unpublished title from this submission, with media entries for its video files (queued for transcoding when ffmpeg is configured). Nothing becomes visible to viewers.', confirmLabel: 'Create draft' }))) return;
      await withBusy(create, async () => {
        try {
          const r = await adminApi.submissions.publish(id);
          toast('Draft title created.', { type: 'success' });
          if (r.warnings?.length) openModal({ title: 'Draft created — check these', content: h('ul', { class: 'lm-stack lm-stack--sm' }, ...r.warnings.map((w) => h('li', null, w))) });
          ctx.navigate(`/content/${encodeURIComponent(r.titleId)}`);
        } catch (err) {
          toastError(err);
        }
      });
    });
    return panel({ title: 'Publication' }, h('div', { class: 'lm-stack lm-stack--sm' }, h('p', { class: 'lm-hint' }, 'Creates a draft title linked to this creator. Staff then add artwork and licence details and publish it.'), create));
  }

  function notePanel() {
    const msg = field({ label: 'Add a note', name: 'message', type: 'textarea', rows: 3, maxlength: 3000 });
    const vis = checkbox('Visible to the creator (they are notified)', { name: 'visibleToCreator' });
    const add = button('Add note', { variant: 'ghost', icon: 'message' });
    add.addEventListener('click', () => withBusy(add, async () => {
      if (!msg.control.value.trim()) {
        msg.setError('Write a note first.');
        return;
      }
      try {
        reload(await adminApi.submissions.comment(id, { message: msg.control.value.trim(), visibleToCreator: vis.querySelector('input').checked }));
        toast('Note added.', { type: 'success' });
      } catch (err) {
        toastError(err);
      }
    }));
    return panel({ title: 'Notes' }, h('div', { class: 'lm-stack' }, msg, vis, add));
  }

  function draw() {
    const s = data.submission;
    const r = s.rights || {};
    ctx.setTitle(s.projectTitle);
    const timeline = h('ol', { class: 'adm-timeline' }, ...data.events.map((e) => h('li', { class: !e.visibleToCreator ? 'is-internal' : undefined },
      h('div', { class: 'adm-timeline__meta' },
        h('strong', null, EVENT_LABELS[e.kind] || e.kind),
        e.toStatus ? h('span', null, `${statusLabel(e.fromStatus || '')} → ${statusLabel(e.toStatus)}`) : null,
        h('span', null, e.actor ? `${e.actor.name || 'Someone'}${e.actor.isStaff ? ' (staff)' : ''}` : 'System'),
        time(e.createdAt),
        !e.visibleToCreator ? badge('Internal') : null),
      e.message ? h('p', { class: 'adm-timeline__msg' }, e.message) : null)));

    rerender(root, page({
      eyebrow: 'Submission',
      title: s.projectTitle,
      back: { href: '#/submissions', label: 'All submissions' },
      subtitle: `${s.creator?.displayName || 'Creator'} · ${s.creator?.email || ''}`,
      actions: [statusBadge(s.status)],
    },
    h('div', { class: 'adm-grid-2' },
      h('div', { class: 'lm-stack lm-stack--lg' },
        panel({ title: 'Project' }, h('div', { class: 'lm-stack' },
          s.description ? h('p', { class: 'adm-quote' }, s.description) : null,
          kv([
            ['Type', s.contentType],
            ['Runtime', s.runtimeMin ? `${s.runtimeMin} min` : null],
            ['Genres', (s.genres || []).join(', ')],
            ['Language', s.language ? languageName(s.language) : null],
            ['Release year', s.releaseYear ? String(s.releaseYear) : null],
            ['Country', s.country ? countryName(s.country.toUpperCase()) : null],
            ['Trailer link', s.trailerUrl ? safeExternal(s.trailerUrl) : null],
            ['Additional info', s.additionalInfo],
            ['Creator application', data.application ? h('span', null, statusBadge(data.application.status), ` ${data.application.legalName}${data.application.company ? ` · ${data.application.company}` : ''}`) : null],
            ['Creator account', h('a', { class: 'lm-link', href: `#/users/${encodeURIComponent(s.accountId)}` }, 'Open account')],
          ]))),
        panel({ title: 'Rights & attestation', description: 'What the creator declared. Check it against the documents they uploaded.' }, h('div', { class: 'lm-stack' },
          s.attestedAt ? null : notice('The creator has not attested the rights for this submission.', { type: 'warn' }),
          kv([
            ['Copyright owner', r.copyrightOwner],
            ['Distribution rights', answer(DISTRIBUTION, r.distributionRights)],
            ['Territories', territoryList(r.territories)],
            ['Restrictions', r.restrictions],
            ['Music cleared', answer(CLEARANCE, r.musicCleared)],
            ['Footage cleared', answer(CLEARANCE, r.footageCleared)],
            ['Documentation notes', r.documentationNotes],
            ['Attested', s.attestedAt ? h('span', null, time(s.attestedAt, { absolute: true }), s.attestationIp ? ` from ${s.attestationIp}` : '') : null],
          ]))),
        panel({ title: 'Files', flush: true, description: 'Preview and download links are signed and expire after 30 minutes.' }, dataTable({
          caption: 'Submitted files',
          empty: 'No files have been uploaded.',
          columns: [
            { key: 'originalName', label: 'File', render: (f) => h('div', { class: 'adm-cellstack' }, h('span', { class: 'adm-truncate', title: f.originalName }, f.originalName), h('small', null, `${f.role}${f.label ? ` · ${f.label}` : ''}`)) },
            { key: 'mime', label: 'Type', render: (f) => h('div', { class: 'adm-cellstack' }, mono(f.mime), h('small', null, bytes(f.sizeBytes))) },
            { key: 'probe', label: 'Probe', render: probeSummary },
            { key: 'scanStatus', label: 'Scan', render: (f) => statusBadge(f.scanStatus, f.scanStatus === 'not_configured' ? 'Not scanned' : undefined) },
            {
              key: 'actions',
              label: 'Actions',
              render: (f) => h('div', { class: 'adm-actions' },
                f.scanStatus === 'infected' ? badge('Blocked', 'danger') : iconButton('eye', `Preview ${f.originalName}`, () => openFile(id, f, 'preview')),
                f.scanStatus === 'infected' ? null : iconButton('download', `Download ${f.originalName}`, () => openFile(id, f, 'download'))),
            },
          ],
          rows: data.files,
        })),
        panel({ title: 'History', description: 'Internal notes are marked and never shown to the creator.' }, data.events.length ? timeline : h('p', { class: 'lm-muted' }, 'No events yet.'))),
      h('div', { class: 'lm-stack adm-sticky' }, statusPanel(), publishPanel(), notePanel()))));
  }
  draw();
  return root;
}

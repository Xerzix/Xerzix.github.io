// A creator's submission (/creators/submissions/:id): a four-step flow — project details,
// files (resumable uploader), rights & ownership, review & submit — plus the event timeline
// and, when the reviewer asks for something, a response form.
import { h, newUid, announce } from '../core/dom.js';
import { api } from '../api/client.js';
import { bytes, date, languageName, plural, relativeTime, runtime } from '../core/format.js';
import { icon } from '../ui/icons.js';
import {
  button, linkButton, withBusy, toast, toastError, confirmDialog, field, applyFieldErrors, notice, emptyState, errorState, sectionHead,
} from '../ui/components.js';
import { completeReceivedUpload, createUploader, ROLE_LABELS } from '../ui/uploader.js';
import { CONTENT_TYPES, STATUS_META, contentTypeLabel, statusBadge } from './creator-dashboard.js';

const STEPS = [
  { id: 'details', label: 'Project details' },
  { id: 'files', label: 'Files' },
  { id: 'rights', label: 'Rights & ownership' },
  { id: 'submit', label: 'Review & submit' },
];

const FILE_ROLES = [
  { value: 'feature', hint: 'The complete film or programme master.' },
  { value: 'episode', hint: 'One episode of a series (upload one file per episode).' },
  { value: 'trailer', hint: 'A trailer or promotional clip.' },
  { value: 'poster', hint: 'Portrait key art, 2:3.' },
  { value: 'backdrop', hint: 'Landscape artwork, 16:9, without text.' },
  { value: 'subtitle', hint: 'WebVTT or SRT, one file per language.' },
  { value: 'document', hint: 'Licences, releases or chain-of-title documents (PDF).' },
];

const LANGUAGES = ['en', 'ja', 'fr', 'de', 'es', 'it', 'pt', 'ko', 'zh', 'hi', 'ar', 'ru', 'nl', 'sv', 'no', 'da', 'fi', 'pl', 'tr', 'th', 'vi', 'id', 'he', 'el', 'cs', 'hu', 'uk', 'fa', 'zxx'];

const MAIN_ROLES = (contentType) => (contentType === 'trailer' ? ['feature', 'episode', 'trailer'] : ['feature', 'episode']);
const EDITABLE = ['draft', 'uploading', 'info_required'];
const DELETABLE = ['draft', 'uploading', 'rejected'];

function completion(data) {
  const s = data.submission;
  const details = !!(s.projectTitle && (s.description || '').trim().length >= 20 && s.runtimeMin && s.language);
  const files = data.files.some((f) => MAIN_ROLES(s.contentType).includes(f.role) && f.scanStatus !== 'infected');
  const rights = !!s.attestedAt;
  const uploadsDone = !data.uploads?.length;
  return { details, files, rights, uploadsDone, submitted: !['draft', 'uploading'].includes(s.status) };
}

function probeSummary(f) {
  const p = f.probe || {};
  const parts = [];
  if (p.width && p.height) parts.push(`${p.width}×${p.height}`);
  if (p.videoCodec) parts.push(p.videoCodec.toUpperCase().replace('H264', 'H.264').replace('HEVC', 'HEVC'));
  if (p.audioTracks?.length) parts.push(`${p.audioTracks.length} audio track${p.audioTracks.length > 1 ? 's' : ''}`);
  if (p.durationS) parts.push(p.durationS < 60 ? `${Math.max(1, Math.round(p.durationS))} s` : runtime(p.durationS / 60));
  if (p.cues) parts.push(plural(p.cues, 'cue'));
  if (!parts.length && p.container) parts.push(p.container.toUpperCase());
  return parts.join(' · ');
}

const SCAN_TEXT = {
  clean: ['Scanned: clean', 'lm-badge--ok'],
  not_configured: ['Not scanned (no scanner on this server)', 'lm-badge--solid'],
  error: ['Scan could not run — staff will check', 'lm-badge--warn'],
  pending: ['Scan pending', 'lm-badge--solid'],
  infected: ['Flagged by scanner', 'lm-badge--danger'],
};

const EVENT_ICON = { status: 'flag', file: 'upload', comment: 'message', info_request: 'alert', info_response: 'send' };

function dateTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'long', timeStyle: 'short' });
}

export default async function render(ctx) {
  const id = ctx.params.id;
  let data;
  try {
    data = await api.creators.submission(id);
  } catch (err) {
    ctx.setTitle('Submission');
    const wrap = (node) => h('div', { class: 'lm-page lm-container' }, h('h1', { class: 'visually-hidden' }, 'Submission'), node);
    if (err.code === 'CREATOR_REQUIRED') return wrap(emptyState({ title: 'Creator access needed', message: err.message, actions: [linkButton('Go to Creators', '#/creators', { variant: 'primary' })] }));
    if (err.status === 404) return wrap(emptyState({ title: 'Submission not found', message: 'It may have been deleted, or it belongs to another account.', actions: [linkButton('Back to your dashboard', '#/creators/dashboard', { variant: 'primary' })] }));
    return wrap(errorState(err, { retry: () => ctx.navigate(`/creators/submissions/${id}`, { replace: true }) }));
  }

  const done = completion(data);
  const initial = ctx.query.get('step');
  let step = STEPS.some((s) => s.id === initial) ? initial : !done.details ? 'details' : !done.files ? 'files' : !done.rights ? 'rights' : 'submit';
  let uploader = null;
  let uploadRole = MAIN_ROLES(data.submission.contentType).includes('feature') && data.submission.contentType !== 'episode' ? 'feature' : 'episode';
  if (data.submission.contentType === 'trailer') uploadRole = 'trailer';
  ctx.onDestroy(() => uploader?.destroy());

  const headSlot = h('div');
  const bannerSlot = h('div');
  const stepperSlot = h('nav', { class: 'lm-stepper-nav', 'aria-label': 'Submission steps' });
  const panelSlot = h('section', { class: 'lm-submission__panel lm-panel', 'aria-live': 'off' });
  const timelineSlot = h('aside', { class: 'lm-submission__aside' });
  const page = h('div', { class: 'lm-page lm-container lm-submission' },
    headSlot, bannerSlot,
    h('div', { class: 'lm-submission__layout' },
      h('div', { class: 'lm-submission__main' }, stepperSlot, panelSlot),
      timelineSlot));

  async function reload({ keepStep = true } = {}) {
    try {
      data = await api.creators.submission(id);
    } catch (err) {
      toastError(err);
      return;
    }
    paint({ keepStep });
  }

  function goTo(next) {
    step = next;
    paintStepper();
    paintPanel();
    panelSlot.querySelector('h2')?.focus({ preventScroll: false });
    history.replaceState(history.state, '', `#/creators/submissions/${encodeURIComponent(id)}?step=${next}`);
  }

  // ── Header ──
  function paintHead() {
    const s = data.submission;
    ctx.setTitle(s.projectTitle);
    const actions = [];
    if (DELETABLE.includes(s.status)) {
      actions.push(button(s.status === 'rejected' ? 'Delete submission' : 'Delete draft', { variant: 'ghost', size: 'sm', icon: 'trash', onClick: async () => {
        const ok = await confirmDialog({ title: `Delete “${s.projectTitle}”?`, message: 'The submission and all of its uploaded files are permanently deleted.', confirmLabel: 'Delete', danger: true });
        if (!ok) return;
        try {
          await api.creators.removeSubmission(s.id);
          toast('Submission deleted.', { type: 'success' });
          ctx.navigate('/creators/dashboard');
        } catch (err) {
          toastError(err);
        }
      } }));
    }
    headSlot.replaceChildren(h('header', { class: 'lm-submission__head' },
      h('a', { class: 'lm-back', href: '#/creators/dashboard' }, icon('arrowLeft'), h('span', null, 'Creator dashboard')),
      h('div', { class: 'lm-submission__title-row' },
        h('div', null,
          h('span', { class: 'lm-eyebrow' }, contentTypeLabel(s.contentType)),
          h('h1', { class: 'lm-h1' }, s.projectTitle),
          h('div', { class: 'lm-cluster lm-cluster--sm lm-submission__meta' },
            statusBadge(s.status),
            h('span', { class: 'lm-small lm-muted' }, s.submittedAt ? `Submitted ${date(s.submittedAt)}` : `Started ${date(s.createdAt)}`),
            h('span', { class: 'lm-small lm-muted' }, `Updated ${relativeTime(s.updatedAt)}`))),
        h('div', { class: 'lm-cluster lm-cluster--sm' }, ...actions))));
  }

  // ── "Information needed" banner with the response form ──
  function paintBanner() {
    const s = data.submission;
    bannerSlot.replaceChildren();
    if (s.status === 'info_required') {
      const request = [...data.events].reverse().find((e) => e.kind === 'info_request') || null;
      const msg = request?.message || s.statusReason || 'The reviewer needs more information.';
      const reply = field({ label: 'Your response', name: 'message', type: 'textarea', rows: 4, maxlength: 5000, hint: 'Explain what you changed or answer the question. You can update details and files before sending.' });
      const send = button('Send response', { variant: 'primary', icon: 'send', type: 'submit' });
      // Sending the response locks the files, so it waits for uploads that are still running.
      const waitNote = h('p', { class: 'lm-error-text', role: 'alert', hidden: true });
      const form = h('form', { class: 'lm-form', novalidate: true }, reply, waitNote, h('div', { class: 'lm-cluster' }, send));
      form.addEventListener('submit', (e) => {
        e.preventDefault();
        waitNote.hidden = true;
        const text = reply.control.value.trim();
        if (!text) {
          reply.setError('Write a response first.');
          reply.control.focus();
          return;
        }
        if (uploader?.hasActiveUploads()) {
          waitNote.textContent = 'An upload is still running. Wait for it to finish (or cancel it), then send your response — files cannot be added once it is sent.';
          waitNote.hidden = false;
          return;
        }
        withBusy(send, async () => {
          try {
            await api.creators.respond(s.id, text);
            toast('Response sent. The submission is back with the reviewer.', { type: 'success' });
            await reload();
          } catch (err) {
            if (err.code === 'UPLOADS_IN_PROGRESS') {
              waitNote.textContent = err.message;
              waitNote.hidden = false;
            } else if (!applyFieldErrors(form, err)) toastError(err);
          }
        });
      });
      bannerSlot.append(h('section', { class: 'lm-submission__request lm-panel', 'aria-labelledby': 'sub-req' },
        h('div', { class: 'lm-submission__request-head' }, icon('alert', { size: 22 }), h('h2', { class: 'lm-h3', id: 'sub-req' }, 'The reviewer needs more information')),
        h('blockquote', { class: 'lm-submission__quote' }, msg),
        form));
    } else if (!EDITABLE.includes(s.status)) {
      const m = STATUS_META[s.status];
      bannerSlot.append(notice(m?.text || '', { type: s.status === 'rejected' ? 'danger' : s.status === 'approved' || s.status === 'published' ? 'ok' : 'info', title: m?.label }));
      if (s.status === 'rejected' && s.statusReason) bannerSlot.append(notice(s.statusReason, { type: 'danger', title: 'Reason' }));
    }
  }

  // ── Stepper ──
  function paintStepper() {
    const c = completion(data);
    const state = { details: c.details, files: c.files, rights: c.rights, submit: c.submitted };
    stepperSlot.replaceChildren(h('ol', { class: 'lm-stepper' }, ...STEPS.map((s, i) => h('li', { class: ['lm-stepper__item', state[s.id] && 'is-done', step === s.id && 'is-current'] },
      h('button', { type: 'button', class: 'lm-stepper__btn', 'aria-current': step === s.id ? 'step' : undefined, onClick: () => goTo(s.id) },
        h('span', { class: 'lm-stepper__num', 'aria-hidden': 'true' }, state[s.id] ? icon('check') : String(i + 1)),
        h('span', { class: 'lm-stepper__label' }, h('span', { class: 'visually-hidden' }, `Step ${i + 1}: `), s.label, state[s.id] ? h('span', { class: 'visually-hidden' }, ' (complete)') : null))))));
  }

  function paintPanel() {
    const editable = EDITABLE.includes(data.submission.status);
    const renderers = { details: detailsStep, files: filesStep, rights: rightsStep, submit: submitStep };
    panelSlot.replaceChildren(...renderers[step](editable));
  }

  function stepHeading(i, title, sub) {
    return h('div', { class: 'lm-submission__step-head' },
      h('span', { class: 'lm-eyebrow' }, `Step ${i} of 4`),
      h('h2', { class: 'lm-h2', tabindex: '-1' }, title),
      sub ? h('p', { class: 'lm-muted' }, sub) : null);
  }

  function nextButton(next, label) {
    return button(label, { variant: 'glass', iconRight: 'arrowRight', onClick: () => goTo(next) });
  }

  // ── Step 1 ──
  function detailsStep(editable) {
    const s = data.submission;
    const langs = LANGUAGES.includes(s.language) || !s.language ? LANGUAGES : [...LANGUAGES, s.language];
    const f = {
      projectTitle: field({ label: 'Project title', name: 'projectTitle', required: true, value: s.projectTitle, maxlength: 200 }),
      contentType: field({ label: 'Type of work', name: 'contentType', type: 'select', options: CONTENT_TYPES, value: s.contentType }),
      description: field({ label: 'Synopsis', name: 'description', type: 'textarea', rows: 6, value: s.description, maxlength: 5000, required: true, hint: 'At least 20 characters. This helps reviewers and becomes the starting point for the title page.' }),
      runtimeMin: field({ label: 'Runtime (minutes)', name: 'runtimeMin', type: 'number', value: s.runtimeMin ?? '', min: 1, max: 1500, required: true, inputmode: 'numeric' }),
      language: field({ label: 'Original language', name: 'language', type: 'select', required: true, value: s.language ?? '', options: [{ value: '', label: 'Choose…' }, ...langs.map((l) => ({ value: l, label: languageName(l) }))] }),
      releaseYear: field({ label: 'Year of completion', name: 'releaseYear', type: 'number', value: s.releaseYear ?? '', min: 1888, max: new Date().getFullYear() + 3, inputmode: 'numeric' }),
      country: field({ label: 'Country of production', name: 'country', value: s.country ?? '', maxlength: 2, placeholder: 'JP', hint: 'Two-letter code' }),
      genres: field({ label: 'Genres', name: 'genres', value: (s.genres || []).join(', '), hint: 'Separate with commas, up to 8.' }),
      trailerUrl: field({ label: 'Trailer link', name: 'trailerUrl', type: 'url', value: s.trailerUrl ?? '', placeholder: 'https://', hint: 'Optional — a public link to an existing trailer.' }),
      additionalInfo: field({ label: 'Anything else reviewers should know?', name: 'additionalInfo', type: 'textarea', rows: 3, value: s.additionalInfo ?? '', maxlength: 5000 }),
    };
    const save = button('Save details', { variant: 'primary', type: 'submit', icon: 'check' });
    const fieldset = h('fieldset', { class: 'lm-form lm-submission__fieldset', disabled: !editable },
      h('legend', { class: 'visually-hidden' }, 'Project details'),
      h('div', { class: 'lm-form-row' }, f.projectTitle, f.contentType),
      f.description,
      h('div', { class: 'lm-form-row' }, f.runtimeMin, f.language, f.releaseYear),
      h('div', { class: 'lm-form-row' }, f.country, f.genres),
      f.trailerUrl,
      f.additionalInfo);
    const form = h('form', { class: 'lm-form', novalidate: true }, fieldset,
      h('div', { class: 'lm-submission__actions' }, editable ? save : null, nextButton('files', 'Next: files')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyFieldErrors(form, null);
      const v = (name) => f[name].control.value.trim();
      const num = (name) => (v(name) === '' ? null : Number(v(name)));
      const payload = {
        projectTitle: v('projectTitle'),
        contentType: v('contentType'),
        description: v('description'),
        runtimeMin: num('runtimeMin'),
        language: v('language') || null,
        releaseYear: num('releaseYear'),
        country: v('country') || null,
        genres: v('genres').split(',').map((g) => g.trim()).filter(Boolean).slice(0, 8),
        trailerUrl: v('trailerUrl') || null,
        additionalInfo: v('additionalInfo') || null,
      };
      withBusy(save, async () => {
        try {
          const res = await api.creators.updateSubmission(data.submission.id, payload);
          data.submission = res.submission;
          toast('Details saved.', { type: 'success', timeout: 2600 });
          paintHead();
          paintStepper();
        } catch (err) {
          if (!applyFieldErrors(form, err)) toastError(err);
        }
      });
    });
    return [stepHeading(1, 'Project details', 'Tell reviewers what the work is. You can come back and change these until you submit.'), form];
  }

  // ── Step 2 ──
  function fileRow(file, editable) {
    const [scanText, scanBadge] = SCAN_TEXT[file.scanStatus] || [file.scanStatus, 'lm-badge--solid'];
    const remove = editable ? button('', { variant: 'ghost', size: 'sm', icon: 'trash', ariaLabel: `Remove ${file.originalName}` }) : null;
    remove?.addEventListener('click', async () => {
      const ok = await confirmDialog({ title: 'Remove this file?', message: `“${file.originalName}” will be deleted from the submission.`, confirmLabel: 'Remove', danger: true });
      if (!ok) return;
      try {
        await api.creators.removeFile(data.submission.id, file.id);
        announce(`${file.originalName} removed`);
        await reload();
      } catch (err) {
        toastError(err);
      }
    });
    const summary = probeSummary(file);
    return h('li', { class: 'lm-file' },
      h('span', { class: 'lm-file__icon', 'aria-hidden': 'true' }, icon(['feature', 'episode', 'trailer'].includes(file.role) ? 'film' : file.role === 'subtitle' ? 'subtitles' : file.role === 'document' ? 'list' : 'palette')),
      h('div', { class: 'lm-file__main' },
        h('div', { class: 'lm-file__top' }, h('strong', { class: 'lm-file__name' }, file.originalName), h('span', { class: 'lm-badge lm-badge--solid' }, ROLE_LABELS[file.role] || file.role)),
        h('span', { class: 'lm-file__meta' }, [bytes(file.sizeBytes), summary, `added ${relativeTime(file.createdAt)}`].filter(Boolean).join(' · ')),
        h('div', { class: 'lm-cluster lm-cluster--sm' },
          h('span', { class: `lm-badge ${scanBadge}` }, scanText),
          file.sha256 ? h('span', { class: 'lm-file__hash', title: `SHA-256 ${file.sha256}` }, `SHA-256 ${file.sha256.slice(0, 12)}…`) : null)),
      remove);
  }

  // ── Unfinished uploads not handled by the uploader on this page ──
  let unfinishedSlotRef = null;
  function paintUnfinished() {
    const slot = unfinishedSlotRef;
    if (!slot) return;
    const known = new Set(uploader?.knownUploadIds?.() || []);
    const unfinished = (data.uploads || []).filter((u) => !known.has(u.id));
    if (!unfinished.length) {
      slot.replaceChildren();
      return;
    }
    slot.replaceChildren(h('div', { class: 'lm-submission__block' },
      h('h3', { class: 'lm-h3' }, 'Unfinished uploads'),
      h('p', { class: 'lm-small lm-muted' }, 'These uploads have not finished. Resume them by choosing the same file again on the device you started from, or discard them.'),
      h('ul', { class: 'lm-file-list' }, ...unfinished.map((u) => {
        const discard = button('Discard', { variant: 'ghost', size: 'sm', icon: 'close' });
        discard.addEventListener('click', () => withBusy(discard, async () => {
          try {
            await api.uploads.abort(u.id);
            await reload();
          } catch (err) {
            toastError(err);
          }
        }));
        const pct = u.size ? Math.floor((u.offset / u.size) * 100) : 0;
        // All bytes arrived but the check was interrupted: it can be finished from any device.
        let check = null;
        if (u.size && u.offset >= u.size) {
          check = button('Finish checking', { variant: 'glass', size: 'sm', icon: 'refresh' });
          check.addEventListener('click', () => withBusy(check, async () => {
            try {
              const st = await completeReceivedUpload(u.id);
              if (st.status === 'complete') announce(`${u.filename} uploaded`);
              else toast(st.error || 'The file could not be verified.', { type: 'error', timeout: 7000 });
            } catch (err) {
              toastError(err);
            }
            await reload();
          }));
        }
        return h('li', { class: 'lm-file' },
          h('span', { class: 'lm-file__icon', 'aria-hidden': 'true' }, icon('history')),
          h('div', { class: 'lm-file__main' }, h('strong', { class: 'lm-file__name' }, u.filename), h('span', { class: 'lm-file__meta' }, check
            ? `${ROLE_LABELS[u.role] || u.role} · ${bytes(u.size)} received · checking was interrupted`
            : `${ROLE_LABELS[u.role] || u.role} · ${pct}% of ${bytes(u.size)} · expires ${relativeTime(u.expiresAt)}`)),
          h('div', { class: 'lm-cluster lm-cluster--sm' }, check, discard));
      }))));
  }

  function filesStep(editable) {
    const s = data.submission;
    const main = MAIN_ROLES(s.contentType);
    const list = data.files.length
      ? h('ul', { class: 'lm-file-list' }, ...data.files.map((f) => fileRow(f, editable)))
      : h('p', { class: 'lm-muted' }, 'No files yet.');
    const parts = [stepHeading(2, 'Files', `Upload the master${s.contentType === 'series' ? ' files for every episode' : ''}, plus artwork, subtitles and any rights documents.`)];
    parts.push(h('div', { class: 'lm-submission__block' }, h('h3', { class: 'lm-h3' }, 'Uploaded files'), list,
      !data.files.some((f) => main.includes(f.role)) ? h('p', { class: 'lm-small lm-muted' }, `A ${main.map((r) => ROLE_LABELS[r].toLowerCase()).join(' or ')} file is required before you can submit.`) : null));

    // Uploads the uploader below runs or offers to resume (remembered on this device) are listed
    // there only; this block shows the rest (e.g. started on another device) and is repainted
    // whenever the uploader picks one up, so a running upload never shows a stale Discard.
    if (editable) {
      uploader ||= createUploader({
        submissionId: s.id,
        role: () => uploadRole,
        onComplete: () => reload(),
        onChange: ({ discarded } = {}) => {
          if (discarded) data.uploads = (data.uploads || []).filter((u) => u.id !== discarded);
          paintUnfinished();
        },
      });
    }
    const unfinishedSlot = h('div');
    unfinishedSlotRef = unfinishedSlot;
    parts.push(unfinishedSlot);
    paintUnfinished();

    if (!editable) {
      parts.push(notice('Files are locked while the submission is being reviewed.', { title: 'Locked' }));
      return parts;
    }
    const roleName = newUid('role');
    const roleHint = h('p', { class: 'lm-small lm-muted', id: `${roleName}-hint` });
    const paintHint = () => {
      roleHint.textContent = FILE_ROLES.find((r) => r.value === uploadRole)?.hint || '';
    };
    const picker = h('fieldset', { class: 'lm-role-picker', 'aria-describedby': `${roleName}-hint` },
      h('legend', { class: 'lm-label' }, 'What are you uploading?'),
      h('div', { class: 'lm-role-picker__options' }, ...FILE_ROLES.map((r) => {
        const input = h('input', { type: 'radio', name: roleName, value: r.value, checked: r.value === uploadRole });
        input.addEventListener('change', () => {
          uploadRole = r.value;
          paintHint();
          uploader?.refresh();
        });
        return h('label', { class: 'lm-role-picker__opt' }, input, h('span', null, ROLE_LABELS[r.value]));
      })),
      roleHint);
    paintHint();
    uploader.refresh();
    parts.push(h('div', { class: 'lm-submission__block' }, h('h3', { class: 'lm-h3' }, 'Add files'), picker, uploader),
      h('div', { class: 'lm-submission__actions' }, nextButton('rights', 'Next: rights & ownership')));
    return parts;
  }

  // ── Step 3 ──
  function radioGroup({ name, legend, options, value, hint }) {
    const errId = newUid('err');
    const err = h('span', { class: 'lm-error-text', id: errId, hidden: true });
    const fs = h('fieldset', { class: 'lm-options lm-options--inline', 'data-field': `rights.${name}`, 'aria-describedby': errId },
      h('legend', { class: 'lm-label' }, legend),
      hint ? h('p', { class: 'lm-hint' }, hint) : null,
      h('div', { class: 'lm-options__row' }, ...options.map((o) => h('label', { class: 'lm-option' },
        h('input', { type: 'radio', name, value: o.value, checked: value === o.value }),
        h('span', { class: 'lm-option__text' }, h('strong', null, o.label), o.hint ? h('span', null, o.hint) : null)))),
      err);
    fs.value = () => fs.querySelector('input:checked')?.value;
    fs.setError = (msg) => {
      err.hidden = !msg;
      err.textContent = msg || '';
      fs.classList.toggle('has-error', !!msg);
    };
    return fs;
  }

  function rightsStep(editable) {
    const s = data.submission;
    const r = s.rights || {};
    const territories = r.territories || [];
    const worldwide = !territories.length || territories.includes('WW');
    const owner = field({ label: 'Copyright owner', name: 'rights.copyrightOwner', value: r.copyrightOwner ?? '', maxlength: 200, required: true, hint: 'The person or company that owns the work.' });
    const distribution = radioGroup({ name: 'distributionRights', legend: 'Your distribution rights', value: r.distributionRights, options: [
      { value: 'owner', label: 'I own all rights', hint: 'You made the work and own it outright.' },
      { value: 'exclusive_license', label: 'Exclusive licence', hint: 'You hold an exclusive distribution licence.' },
      { value: 'non_exclusive_license', label: 'Non-exclusive licence', hint: 'Others may also distribute it.' },
    ] });
    const scope = radioGroup({ name: 'territoryScope', legend: 'Where may Lumina show it?', value: worldwide ? 'WW' : 'list', options: [
      { value: 'WW', label: 'Worldwide' },
      { value: 'list', label: 'Specific countries' },
    ] });
    scope.dataset.field = 'rights.territories';
    const countries = field({ label: 'Countries', name: 'rights.territoriesList', value: worldwide ? '' : territories.join(', '), placeholder: 'JP, FR, US', hint: 'Two-letter country codes separated by commas.' });
    const syncScope = () => {
      countries.hidden = scope.value() !== 'list';
    };
    scope.addEventListener('change', syncScope);
    syncScope();
    const clearance = [
      { value: 'yes', label: 'Yes, cleared' },
      { value: 'no', label: 'Not cleared' },
      { value: 'not_applicable', label: 'Not applicable' },
    ];
    const music = radioGroup({ name: 'musicCleared', legend: 'Is all music cleared for streaming?', value: r.musicCleared, options: clearance, hint: 'Score, songs and library music. Choose “Not applicable” if the work has no third-party music.' });
    const footage = radioGroup({ name: 'footageCleared', legend: 'Is third-party footage cleared?', value: r.footageCleared, options: clearance, hint: 'Archive footage, artwork and appearance releases.' });
    const restrictions = field({ label: 'Restrictions or holdbacks', name: 'rights.restrictions', type: 'textarea', rows: 3, value: r.restrictions ?? '', maxlength: 2000, hint: 'Optional — e.g. festival exclusivity until a date.' });
    const notes = field({ label: 'Documentation notes', name: 'rights.documentationNotes', type: 'textarea', rows: 3, value: r.documentationNotes ?? '', maxlength: 5000, hint: 'Optional — which documents you uploaded or can provide.' });
    const confirmBox = h('label', { class: 'lm-checkbox lm-attest', 'data-field': 'confirm' },
      h('input', { type: 'checkbox', name: 'confirm' }),
      h('span', null, 'I confirm that I hold the rights described above, that this information is accurate, and that I accept the ',
        h('a', { class: 'lm-link', href: '#/legal/creator-agreement', target: '_blank', rel: 'noopener' }, 'creator agreement'), '.'));
    const confirmErr = h('span', { class: 'lm-error-text', hidden: true });
    const save = button(s.attestedAt ? 'Update and confirm again' : 'Confirm rights', { variant: 'primary', type: 'submit', icon: 'shield' });
    const fieldset = h('fieldset', { class: 'lm-form lm-submission__fieldset', disabled: !editable },
      h('legend', { class: 'visually-hidden' }, 'Rights and ownership'),
      owner, distribution, scope, countries, music, footage, restrictions, notes, confirmBox, confirmErr);
    const form = h('form', { class: 'lm-form', novalidate: true }, fieldset,
      h('div', { class: 'lm-submission__actions' }, editable ? save : null, nextButton('submit', 'Next: review & submit')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      applyFieldErrors(form, null);
      for (const g of [distribution, scope, music, footage]) g.setError('');
      confirmErr.hidden = true;
      const list = countries.control.value.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      const payload = {
        rights: {
          copyrightOwner: owner.control.value.trim(),
          distributionRights: distribution.value(),
          territories: scope.value() === 'list' ? list : ['WW'],
          restrictions: restrictions.control.value.trim() || undefined,
          musicCleared: music.value(),
          footageCleared: footage.value(),
          documentationNotes: notes.control.value.trim() || undefined,
        },
        confirm: confirmBox.querySelector('input').checked,
      };
      if (!payload.confirm) {
        confirmErr.textContent = 'Tick the box to confirm your rights.';
        confirmErr.hidden = false;
        confirmBox.querySelector('input').focus();
        return;
      }
      withBusy(save, async () => {
        try {
          const res = await api.creators.attest(data.submission.id, payload);
          data.submission = res.submission;
          toast('Rights confirmed.', { type: 'success' });
          await reload();
          goTo('submit');
        } catch (err) {
          const fields = err.fields || {};
          let shown = applyFieldErrors(form, err);
          const groups = { 'rights.distributionRights': distribution, 'rights.musicCleared': music, 'rights.footageCleared': footage };
          for (const [key, g] of Object.entries(groups)) if (fields[key]) {
            g.setError(fields[key]);
            shown = true;
          }
          const territoryErr = Object.entries(fields).find(([k]) => k.startsWith('rights.territories'));
          if (territoryErr) {
            countries.setError(territoryErr[1]);
            shown = true;
          }
          if (fields.confirm) {
            confirmErr.textContent = fields.confirm;
            confirmErr.hidden = false;
            shown = true;
          }
          if (!shown) toastError(err);
        }
      });
    });
    const parts = [stepHeading(3, 'Rights & ownership', 'Lumina only streams work that is authorised for streaming. Answer honestly — reviewers may ask for documents.')];
    if (s.attestedAt) parts.push(notice(`You confirmed these rights on ${dateTime(s.attestedAt)}.`, { type: 'ok', title: 'Confirmed' }));
    parts.push(form);
    return parts;
  }

  // ── Step 4 ──
  function submitStep(editable) {
    const s = data.submission;
    const c = completion(data);
    const checks = [
      { ok: c.details, label: 'Project details are complete', fix: 'details', hint: 'Title, a synopsis of at least 20 characters, runtime and original language.' },
      { ok: c.files, label: `A ${MAIN_ROLES(s.contentType).map((r) => ROLE_LABELS[r].toLowerCase()).join(' or ')} file is uploaded`, fix: 'files' },
      { ok: c.uploadsDone, label: 'No uploads are still running', fix: 'files' },
      { ok: c.rights, label: 'Rights and ownership are confirmed', fix: 'rights' },
    ];
    const errors = h('div', { role: 'alert' });
    const list = h('ul', { class: 'lm-checklist lm-checklist--status' }, ...checks.map((x) => h('li', { class: x.ok ? 'is-ok' : 'is-missing' },
      h('span', { class: 'lm-checklist__mark', 'aria-hidden': 'true' }, icon(x.ok ? 'check' : 'close')),
      h('div', null,
        h('strong', null, x.label, h('span', { class: 'visually-hidden' }, x.ok ? ' — done' : ' — not yet')),
        !x.ok && x.hint ? h('p', null, x.hint) : null),
      !x.ok && editable ? button('Go to step', { variant: 'ghost', size: 'sm', iconRight: 'arrowRight', onClick: () => goTo(x.fix) }) : null)));
    const facts = [
      ['Type', contentTypeLabel(s.contentType)],
      ['Runtime', s.runtimeMin ? runtime(s.runtimeMin) : '—'],
      ['Language', s.language ? languageName(s.language) : '—'],
      ['Year', s.releaseYear || '—'],
      ['Files', `${data.files.length}`],
      ['Rights', s.attestedAt ? `Confirmed ${date(s.attestedAt)}` : 'Not confirmed'],
    ];
    const parts = [
      stepHeading(4, 'Review & submit', 'A person on the Lumina team reviews every submission. Nothing is published automatically — an editor publishes approved work.'),
      h('dl', { class: 'lm-sub-facts' }, ...facts.map(([k, v]) => h('div', null, h('dt', null, k), h('dd', null, String(v))))),
      list,
      errors,
    ];
    if (['draft', 'uploading'].includes(s.status)) {
      const ready = checks.every((x) => x.ok);
      const submit = button('Submit for review', { variant: 'primary', size: 'lg', icon: 'send', disabled: !ready });
      submit.addEventListener('click', () => withBusy(submit, async () => {
        errors.replaceChildren();
        try {
          await api.creators.submit(s.id);
          toast('Submitted. We will notify you when the status changes.', { type: 'success', timeout: 6000 });
          await reload();
        } catch (err) {
          const fields = Object.values(err.fields || {});
          errors.replaceChildren(notice(fields.length ? h('ul', null, ...fields.map((f) => h('li', null, f))) : err.message, { type: 'danger', title: 'Not ready yet' }));
        }
      }));
      if (!ready) submit.setAttribute('aria-describedby', 'sub-not-ready');
      parts.push(h('div', { class: 'lm-submission__actions' }, submit, !ready ? h('span', { class: 'lm-small lm-muted', id: 'sub-not-ready' }, 'Complete the items above to submit.') : null));
    } else if (s.status === 'info_required') {
      parts.push(notice('Use the response form at the top of this page to send your answer.', { type: 'warn' }));
    } else {
      parts.push(notice(STATUS_META[s.status]?.text || '', { title: `Status: ${STATUS_META[s.status]?.label || s.status}` }));
    }
    return parts;
  }

  // ── Timeline ──
  function paintTimeline() {
    const events = [...data.events].reverse();
    const describe = (e) => {
      if (e.kind === 'status' && e.toStatus) {
        const to = STATUS_META[e.toStatus]?.label || e.toStatus;
        return e.fromStatus ? `${STATUS_META[e.fromStatus]?.label || e.fromStatus} → ${to}` : to;
      }
      return { file: 'Files', comment: 'Note', info_request: 'Information requested', info_response: 'Your response' }[e.kind] || e.kind;
    };
    timelineSlot.replaceChildren(h('section', { class: 'lm-panel lm-timeline-panel', 'aria-labelledby': 'sub-tl' },
      sectionHead('Timeline', { id: 'sub-tl', level: 'h2' }),
      events.length
        ? h('ol', { class: 'lm-timeline' }, ...events.map((e) => h('li', { class: 'lm-timeline__item', 'data-kind': e.kind },
          h('span', { class: 'lm-timeline__dot', 'aria-hidden': 'true' }, icon(EVENT_ICON[e.kind] || 'info')),
          h('div', null,
            h('strong', null, describe(e)),
            e.message ? h('p', null, e.message) : null,
            h('span', { class: 'lm-xsmall lm-muted' }, `${e.by === 'you' ? 'You' : 'Lumina team'} · `, h('time', { datetime: e.createdAt, title: dateTime(e.createdAt) }, relativeTime(e.createdAt)))))))
        : h('p', { class: 'lm-muted lm-small' }, 'No activity yet.')));
  }

  function paint() {
    paintHead();
    paintBanner();
    paintStepper();
    paintPanel();
    paintTimeline();
  }
  paint();
  return page;
}

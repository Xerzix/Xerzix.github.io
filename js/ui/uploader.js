// Resumable uploader: drag-and-drop zone + per-file rows with progress, speed and time left,
// pause / resume / cancel, automatic retry with backoff on network errors, and resume after a
// reload (the upload id is remembered on this device; choosing the same file again continues
// from the server's offset). Speaks the tus-style protocol through api.uploads.*.
//
//   const up = createUploader({ submissionId, role: 'feature' | () => role, onComplete });
//   container.append(up);   … later: up.refresh() after the role changes; up.destroy() on leave.
import { h, announce, newUid } from '../core/dom.js';
import { api } from '../api/client.js';
import { store } from '../core/storage.js';
import { bytes } from '../core/format.js';
import { icon } from './icons.js';
import { button, confirmDialog, toast, toastError, withBusy } from './components.js';

const CHUNK = 8 * 1024 * 1024;
const RESUME_KEY = 'uploads.resume';
const RESUME_MAX_AGE_MS = 7 * 86_400_000;
const RETRY_DELAYS = [1000, 2000, 4000, 8000, 15_000, 30_000, 30_000, 30_000];

export const ROLE_KINDS = {
  feature: 'video', episode: 'video', trailer: 'video', poster: 'image', backdrop: 'image', artwork: 'image', document: 'document', subtitle: 'subtitle',
};
export const ROLE_LABELS = {
  feature: 'Feature', episode: 'Episode', trailer: 'Trailer', poster: 'Poster', backdrop: 'Backdrop', artwork: 'Artwork', document: 'Document', subtitle: 'Subtitles',
};
const DEFAULT_EXTENSIONS = {
  video: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'ts', 'mts', 'm2ts'],
  image: ['png', 'jpg', 'jpeg', 'webp'],
  document: ['pdf'],
  subtitle: ['vtt', 'srt'],
};
const KIND_ICON = { video: 'film', image: 'palette', document: 'list', subtitle: 'subtitles' };
const KIND_NAMES = { video: 'MP4, MOV, MKV, WebM or MPEG-TS', image: 'PNG, JPEG or WebP', document: 'PDF', subtitle: 'WebVTT or SRT (UTF-8)' };

let requirementsPromise = null;
/** The server's upload limits and formats (GET /api/creators/requirements), or null. */
export function uploadRequirements() {
  if (!requirementsPromise) {
    requirementsPromise = typeof api.request === 'function'
      ? api.request('GET', '/api/creators/requirements').catch(() => null)
      : Promise.resolve(null);
  }
  return requirementsPromise;
}

export function maxBytesFor(req, kind) {
  const u = req?.uploads;
  if (!u) return null;
  return { video: u.maxVideoBytes, image: u.maxImageBytes, document: u.maxDocumentBytes, subtitle: u.maxSubtitleBytes }[kind] ?? null;
}

// ── Remembered uploads (this device only) ──
function savedUploads() {
  const now = Date.now();
  return (store.get(RESUME_KEY, []) || []).filter((e) => e && e.uploadId && now - (e.savedAt || 0) < RESUME_MAX_AGE_MS);
}
function remember(entry) {
  store.set(RESUME_KEY, [...savedUploads().filter((e) => e.uploadId !== entry.uploadId), { ...entry, savedAt: Date.now() }]);
}
function forget(uploadId) {
  store.set(RESUME_KEY, savedUploads().filter((e) => e.uploadId !== uploadId));
}
const sameFile = (e, file) => e.name === file.name && e.size === file.size && e.lastModified === file.lastModified;

const extOf = (name) => (/\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1] || '').toLowerCase();

function timeLeft(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `${Math.max(1, Math.ceil(seconds))} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  const hrs = Math.floor(seconds / 3600);
  return `${hrs} h ${Math.round((seconds % 3600) / 60)} min left`;
}

const sleep = (ms, signal) => new Promise((resolve) => {
  const t = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => {
    clearTimeout(t);
    resolve();
  }, { once: true });
});

const isTransient = (err) => err?.status === 0 || err?.code === 'NETWORK' || err?.status === 408 || err?.status === 429 || err?.status >= 500 || err?.code === 'UPLOAD_BUSY';

/**
 * Every byte of an upload has reached the server. Normally the response to the last part
 * arrives after the server has checked the file; if that response was lost (or the server
 * restarted mid-check), wait for the running check, or ask the server to run it again with an
 * empty part at the final offset. Resolves with the upload's final status
 * ({ status: 'complete' | 'rejected' | …, error }); throws a final refusal, or the last
 * transient error when the server is still busy after a few minutes.
 */
export async function completeReceivedUpload(uploadId, { shouldStop = () => false } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const st = await api.uploads.status(uploadId);
      if ((st.status !== 'processing' && st.status !== 'in_progress') || st.offset < st.size) return st;
      await api.uploads.sendChunk(uploadId, st.size, new Blob([]));
    } catch (err) {
      if (!isTransient(err) || attempt >= 40 || shouldStop()) throw err;
      await sleep(Math.min(15_000, 1500 * (attempt + 1)));
    }
  }
}

export function createUploader({ submissionId = null, role, onComplete, purpose = 'submission', multiple = true } = {}) {
  const getRole = typeof role === 'function' ? role : () => role;
  const jobs = new Set();
  let req = null;
  let pendingResume = null;

  const inputId = newUid('file');
  const hintId = `${inputId}-hint`;
  const input = h('input', { type: 'file', id: inputId, class: 'visually-hidden', multiple, tabindex: '-1', 'aria-describedby': hintId });
  const choose = button('Choose files', { variant: 'primary', icon: 'upload' });
  const hint = h('p', { class: 'lm-dropzone__hint', id: hintId });
  const zone = h('div', { class: 'lm-dropzone' },
    h('span', { class: 'lm-dropzone__icon', 'aria-hidden': 'true' }, icon('upload')),
    h('p', { class: 'lm-dropzone__title' }, 'Drag and drop files here'),
    h('p', { class: 'lm-dropzone__or' }, 'or'),
    choose,
    hint,
    input);
  const resumeList = h('ul', { class: 'lm-upload-list lm-upload-list--resume', 'aria-label': 'Unfinished uploads' });
  const listEl = h('ul', { class: 'lm-upload-list', 'aria-label': 'Uploads' });
  const root = h('div', { class: 'lm-uploader' }, zone, resumeList, listEl);

  function kind() {
    return ROLE_KINDS[getRole()] || 'video';
  }

  function refresh() {
    const k = kind();
    const exts = req?.extensions?.[k] || DEFAULT_EXTENSIONS[k];
    input.accept = exts.map((e) => `.${e}`).join(',');
    const max = maxBytesFor(req, k);
    hint.textContent = `${ROLE_LABELS[getRole()] || 'File'}: ${KIND_NAMES[k]}${max ? ` · up to ${bytes(max)}` : ''}. Large files upload in parts and can resume if the connection drops.`;
  }
  refresh();
  uploadRequirements().then((r) => {
    req = r;
    refresh();
  });

  choose.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    handleFiles([...input.files]);
    input.value = '';
  });
  let depth = 0;
  zone.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
  });
  zone.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) zone.classList.remove('is-over');
  });
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    zone.classList.remove('is-over');
    const files = [...(e.dataTransfer?.files || [])];
    handleFiles(multiple ? files : files.slice(0, 1));
  });

  function handleFiles(files) {
    for (const file of files) {
      if ([...jobs].some((j) => sameFile(j.entry, file) && j.active)) continue;
      const saved = savedUploads().find((e) => sameFile(e, file) && e.submissionId === submissionId && e.purpose === purpose);
      const resumeTarget = pendingResume && sameFile(pendingResume, file) ? pendingResume : saved;
      pendingResume = null;
      const job = createJob(file, resumeTarget?.role || getRole(), resumeTarget);
      jobs.add(job);
      listEl.prepend(job.row);
      job.start();
    }
    paintResumable();
  }

  // Uploads remembered on this device that are not running in this page.
  async function paintResumable() {
    const entries = savedUploads().filter((e) => e.submissionId === submissionId && e.purpose === purpose && ![...jobs].some((j) => j.id === e.uploadId));
    const rows = [];
    for (const e of entries) {
      let st = null;
      try {
        st = await api.uploads.status(e.uploadId);
      } catch (err) {
        if (err.status === 404) forget(e.uploadId);
        continue;
      }
      if (st.status !== 'in_progress') {
        forget(e.uploadId);
        continue;
      }
      const pct = st.size ? Math.floor((st.offset / st.size) * 100) : 0;
      // Every byte arrived but the check was interrupted: no need for the file again.
      const received = st.status === 'processing';
      const pick = received
        ? button('Finish checking', { variant: 'glass', size: 'sm', icon: 'refresh' })
        : button('Choose file to resume', { variant: 'glass', size: 'sm', icon: 'refresh' });
      pick.addEventListener('click', () => {
        if (!received) {
          pendingResume = e;
          input.click();
          return;
        }
        withBusy(pick, async () => {
          try {
            const done = await completeReceivedUpload(e.uploadId);
            forget(e.uploadId);
            if (done.status === 'complete') {
              announce(`${e.name} uploaded`);
              onComplete?.({ upload: done });
            } else {
              toast(done.error || 'The file could not be verified.', { type: 'error', timeout: 7000 });
            }
          } catch (err) {
            if (!isTransient(err)) forget(e.uploadId);
            toastError(err);
          }
          paintResumable();
        });
      });
      const discard = button('', { variant: 'ghost', size: 'sm', icon: 'close', ariaLabel: `Discard the unfinished upload of ${e.name}` });
      discard.addEventListener('click', async () => {
        try {
          await api.uploads.abort(e.uploadId);
        } catch {
          /* already gone */
        }
        forget(e.uploadId);
        paintResumable();
      });
      rows.push(h('li', { class: 'lm-upload lm-upload--resume', 'data-state': 'paused' },
        h('span', { class: 'lm-upload__icon', 'aria-hidden': 'true' }, icon('history')),
        h('div', { class: 'lm-upload__main' },
          h('div', { class: 'lm-upload__top' }, h('strong', { class: 'lm-upload__name' }, e.name), h('span', { class: 'lm-upload__meta' }, `${bytes(e.size)} · ${ROLE_LABELS[e.role] || e.role}`)),
          h('div', { class: 'lm-upload__bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct), 'aria-label': `${e.name}: ${pct}% uploaded` }, h('span', { style: { width: `${pct}%` } })),
          h('span', { class: 'lm-upload__status' }, received
            ? 'Every byte arrived, but checking the file was interrupted. Lumina can finish checking it now.'
            : `${pct}% uploaded before you left. Choose the same file to continue where it stopped.`)),
        h('div', { class: 'lm-upload__controls' }, pick, discard)));
    }
    resumeList.replaceChildren(...rows);
    resumeList.hidden = !rows.length;
  }
  paintResumable();

  // ── One file ──
  function createJob(file, fileRole, resumeEntry) {
    const k = ROLE_KINDS[fileRole] || 'video';
    const job = { id: resumeEntry?.uploadId || null, entry: { name: file.name, size: file.size, lastModified: file.lastModified }, active: true };
    let offset = 0;
    let chunk = CHUNK;
    let paused = false;
    let cancelled = false;
    let controller = null;
    let samples = [];

    const bar = h('div', { class: 'lm-upload__bar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', 'aria-label': `Uploading ${file.name}` }, h('span'));
    const status = h('span', { class: 'lm-upload__status' }, 'Preparing…');
    const pauseBtn = button('', { variant: 'ghost', size: 'sm', icon: 'pause', ariaLabel: `Pause ${file.name}` });
    const retryBtn = button('Retry', { variant: 'glass', size: 'sm', icon: 'refresh' });
    const cancelBtn = button('', { variant: 'ghost', size: 'sm', icon: 'close', ariaLabel: `Cancel ${file.name}` });
    const dismissBtn = button('', { variant: 'ghost', size: 'sm', icon: 'close', ariaLabel: `Dismiss ${file.name}` });
    retryBtn.hidden = true;
    dismissBtn.hidden = true;
    const row = h('li', { class: 'lm-upload', 'data-state': 'queued' },
      h('span', { class: 'lm-upload__icon', 'aria-hidden': 'true' }, icon(KIND_ICON[k])),
      h('div', { class: 'lm-upload__main' },
        h('div', { class: 'lm-upload__top' }, h('strong', { class: 'lm-upload__name' }, file.name), h('span', { class: 'lm-upload__meta' }, `${bytes(file.size)} · ${ROLE_LABELS[fileRole] || fileRole}`)),
        bar,
        status),
      h('div', { class: 'lm-upload__controls' }, pauseBtn, retryBtn, cancelBtn, dismissBtn));
    job.row = row;

    const setState = (s, text) => {
      row.dataset.state = s;
      if (text !== undefined) status.textContent = text;
      const running = s === 'uploading' || s === 'retrying' || s === 'queued';
      pauseBtn.hidden = !(running || s === 'paused');
      cancelBtn.hidden = s === 'done' || s === 'error' || s === 'verifying';
      retryBtn.hidden = s !== 'error' || !job.retryable;
      dismissBtn.hidden = !(s === 'done' || s === 'error');
      pauseBtn.replaceChildren(icon(s === 'paused' ? 'play' : 'pause'));
      pauseBtn.setAttribute('aria-label', `${s === 'paused' ? 'Resume' : 'Pause'} ${file.name}`);
      job.active = !(s === 'done' || s === 'error');
      updateUnloadGuard();
    };
    const setIndeterminate = (on) => {
      bar.classList.toggle('is-indeterminate', on);
      if (on) bar.removeAttribute('aria-valuenow');
    };
    const paintProgress = () => {
      setIndeterminate(false);
      const pct = file.size ? Math.floor((offset / file.size) * 100) : 100;
      bar.firstChild.style.width = `${pct}%`;
      bar.setAttribute('aria-valuenow', String(pct));
      return pct;
    };
    const speed = () => {
      const now = performance.now();
      samples = samples.filter((s) => now - s.t < 20_000);
      if (samples.length < 2) return 0;
      const first = samples[0];
      const last = samples[samples.length - 1];
      return ((last.offset - first.offset) / (last.t - first.t)) * 1000;
    };

    function fail(err, { retryable = true } = {}) {
      job.retryable = retryable;
      setState('error', err?.message || 'The upload failed.');
      announce(`Upload of ${file.name} failed. ${err?.message || ''}`);
    }

    async function syncOffset() {
      const st = await api.uploads.status(job.id);
      if (st.status === 'complete') return 'complete';
      if (st.status !== 'in_progress' && st.status !== 'processing') {
        forget(job.id);
        const e = new Error(st.error || `This upload was ${st.status}. Choose the file again to start over.`);
        e.final = true;
        throw e;
      }
      offset = st.offset;
      return 'ok';
    }

    /** Every byte has been sent: wait for (or re-run) the server's check of the file. */
    async function finish() {
      setState('verifying', 'Checking the file…');
      let st;
      try {
        st = await completeReceivedUpload(job.id, { shouldStop: () => cancelled });
      } catch (err) {
        if (isTransient(err)) return fail({ message: 'The server is still checking this file. Check the submission again in a few minutes.' }, { retryable: true });
        forget(job.id);
        return fail(err, { retryable: false });
      }
      forget(job.id);
      if (st.status !== 'complete') {
        fail({ message: st.error || 'The file could not be verified.' }, { retryable: false });
        return;
      }
      offset = file.size;
      paintProgress();
      setState('done', 'Uploaded and verified.');
      status.prepend(icon('checkCircle', { size: 16 }));
      announce(`${file.name} uploaded`);
      onComplete?.({ upload: st, file });
    }

    async function run() {
      let attempt = 0;
      while (!paused && !cancelled && offset < file.size) {
        const end = Math.min(file.size, offset + chunk);
        const last = end === file.size;
        controller = new AbortController();
        const pct = paintProgress();
        const bps = speed();
        // Progress is measured per finished part; until the first part lands the bar is indeterminate.
        setIndeterminate(offset === 0);
        setState('uploading', last
          ? (offset === 0 ? 'Uploading and checking the file…' : 'Uploading the last part and checking the file…')
          : `${pct}%${bps ? ` · ${bytes(bps)}/s · ${timeLeft((file.size - offset) / bps)}` : ''}`);
        try {
          offset = await api.uploads.sendChunk(job.id, offset, file.slice(offset, end), { signal: controller.signal });
          samples.push({ t: performance.now(), offset });
          attempt = 0;
        } catch (err) {
          if (err?.name === 'AbortError') return;
          if (err.code === 'OFFSET_MISMATCH' && Number.isFinite(err.extra?.offset)) {
            offset = err.extra.offset;
            continue;
          }
          if (isTransient(err) && attempt < RETRY_DELAYS.length) {
            const wait = err.retryAfter ? err.retryAfter * 1000 : RETRY_DELAYS[attempt];
            attempt++;
            for (let left = Math.ceil(wait / 1000); left > 0 && !paused && !cancelled; left--) {
              setState('retrying', `${err.code === 'NETWORK' ? 'Connection lost' : 'The server is busy'}. Retrying in ${left} s…`);
              await sleep(1000, controller.signal);
            }
            if (paused || cancelled) return;
            if (!navigator.onLine) {
              setState('retrying', 'You are offline. The upload will continue when you reconnect.');
              await new Promise((r) => window.addEventListener('online', r, { once: true }));
            }
            try {
              if ((await syncOffset()) === 'complete') return finish();
            } catch (e) {
              if (e.final) return fail(e, { retryable: false });
              /* still offline: loop and back off again */
            }
            continue;
          }
          // The server refused the file (type, size, scan…) or the upload is gone.
          if (['UPLOAD_REJECTED', 'UPLOAD_INFECTED', 'UPLOAD_NOT_ACTIVE', 'SUBMISSION_LOCKED', 'NOT_FOUND', 'CHUNK_TOO_LARGE'].includes(err.code) || err.status === 404 || err.status === 422) {
            forget(job.id);
            return fail(err, { retryable: false });
          }
          return fail(err);
        }
      }
      if (!paused && !cancelled && offset >= file.size) await finish();
    }

    job.start = async () => {
      setState('queued', 'Preparing…');
      try {
        if (job.id) {
          if ((await syncOffset().catch((e) => {
            if (e.final || e.status === 404) {
              forget(job.id);
              job.id = null;
              return 'restart';
            }
            throw e;
          })) === 'complete') return finish();
        }
        if (!job.id) {
          const ext = extOf(file.name);
          const exts = req?.extensions?.[k] || DEFAULT_EXTENSIONS[k];
          if (ext && !exts.includes(ext)) return fail({ message: `${ROLE_LABELS[fileRole]} files must be ${KIND_NAMES[k]}.` }, { retryable: false });
          const max = maxBytesFor(req, k);
          if (max && file.size > max) return fail({ message: `This file is ${bytes(file.size)}; the limit for ${ROLE_LABELS[fileRole].toLowerCase()} files is ${bytes(max)}.` }, { retryable: false });
          const created = await api.uploads.create({ filename: file.name, size: file.size, mime: file.type || undefined, purpose, submissionId: submissionId || undefined, role: fileRole });
          job.id = created.id;
          offset = created.offset || 0;
          chunk = Math.min(CHUNK, created.maxChunkSize || CHUNK);
          remember({ uploadId: job.id, submissionId, purpose, role: fileRole, ...job.entry });
        }
        await run();
      } catch (err) {
        if (err?.name === 'AbortError') return;
        fail(err, { retryable: isTransient(err) });
      }
    };

    pauseBtn.addEventListener('click', async () => {
      if (row.dataset.state === 'paused') {
        paused = false;
        setState('queued', 'Resuming…');
        try {
          if ((await syncOffset()) === 'complete') return finish();
          await run();
        } catch (err) {
          fail(err, { retryable: !err.final });
        }
        return;
      }
      paused = true;
      controller?.abort();
      setState('paused', `Paused at ${paintProgress()}%.`);
      announce(`${file.name} paused`);
    });
    retryBtn.addEventListener('click', () => {
      paused = false;
      job.start();
    });
    cancelBtn.addEventListener('click', async () => {
      if (offset > 0 && !(await confirmDialog({ title: 'Cancel this upload?', message: `The ${bytes(offset)} already sent for “${file.name}” will be discarded.`, confirmLabel: 'Cancel upload', cancelLabel: 'Keep uploading', danger: true }))) return;
      cancelled = true;
      controller?.abort();
      if (job.id) {
        try {
          await api.uploads.abort(job.id);
        } catch {
          /* already finished or gone */
        }
        forget(job.id);
      }
      jobs.delete(job);
      row.remove();
      updateUnloadGuard();
      announce(`Upload of ${file.name} cancelled`);
    });
    dismissBtn.addEventListener('click', () => {
      jobs.delete(job);
      row.remove();
    });
    job.stop = () => {
      paused = true;
      controller?.abort();
    };
    return job;
  }

  // Warn before closing the tab while bytes are moving (uploads can resume, but it is slower).
  const onBeforeUnload = (e) => {
    e.preventDefault();
    e.returnValue = '';
  };
  let guarded = false;
  function updateUnloadGuard() {
    const busy = [...jobs].some((j) => j.active);
    if (busy && !guarded) window.addEventListener('beforeunload', onBeforeUnload);
    if (!busy && guarded) window.removeEventListener('beforeunload', onBeforeUnload);
    guarded = busy;
  }

  root.refresh = refresh;
  root.destroy = () => {
    // Leave the server uploads in place so they can be resumed later from this device.
    for (const j of jobs) j.stop?.();
    jobs.clear();
    updateUnloadGuard();
  };
  root.hasActiveUploads = () => [...jobs].some((j) => j.active);
  root.activeUploadIds = () => [...jobs].filter((j) => j.active && j.id).map((j) => j.id);
  return root;
}

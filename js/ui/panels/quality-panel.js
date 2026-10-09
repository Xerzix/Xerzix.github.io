// Playback quality on the title page, and the "Report a playback problem" form.
//
//   qualityPanel(title)                 → section: measured (player telemetry) vs reported (members)
//   qualityReportButton(title, episode) → button that opens the report form
//   openQualityReport(title, episode, { category, selectedResolution })  (used by the player)
//
// The two sources are never merged: "Measured by Lumina players" comes from what players
// recorded; "Reported by members" is subjective and labelled as such. Both show an honest
// "Not enough data yet" state below their thresholds.
import { h, newUid } from '../../core/dom.js';
import { api } from '../../api/client.js';
import { session } from '../../core/session.js';
import { navigate } from '../../core/router.js';
import { icon } from '../icons.js';
import { button, openModal, toast, applyFieldErrors, spinner } from '../components.js';
import { uaSummary, formatBitrate, episodeLabel } from '../../player/helpers.js';
import { readDiagnostics } from '../../player/telemetry.js';

export const QUALITY_CATEGORIES = [
  { value: 'buffering', label: 'Buffering or slow to start' },
  { value: 'interruptions', label: 'Playback stops or stutters' },
  { value: 'poor_quality', label: 'Picture looks poor or blurry' },
  { value: 'audio_sync', label: 'Audio out of sync' },
  { value: 'missing_subtitles', label: 'Subtitles missing or wrong' },
  { value: 'wrong_language', label: 'Wrong audio language' },
  { value: 'playback_error', label: 'An error message appeared' },
  { value: 'crash', label: 'The player froze or crashed' },
  { value: 'other', label: 'Something else' },
];
const CATEGORY_LABEL = Object.fromEntries(QUALITY_CATEGORIES.map((c) => [c.value, c.label]));

const pct = (x, digits = 1) => `${(x * 100).toFixed(digits)} %`;

// ─────────────────────────────── Title-page panel ───────────────────────────────
export function qualityPanel(title) {
  const headingId = newUid('qh');
  const body = h('div', { class: 'lm-quality__grid' }, h('div', { class: 'lm-quality__loading' }, spinner('Loading playback quality')));
  const section = h('section', { class: 'lm-quality', 'aria-labelledby': headingId },
    h('div', { class: 'lm-section-head' },
      h('div', null,
        h('h2', { id: headingId }, 'Playback quality'),
        h('p', { class: 'lm-section-sub' }, 'Last 90 days · measurements and member reports are kept separate'),
        h('span', { class: 'lm-rule', 'aria-hidden': 'true' })),
      qualityReportButton(title)),
    body);

  if (api.mode !== 'server') {
    // Preview mode has no shared telemetry; say so briefly instead of showing empty numbers.
    body.replaceChildren(h('p', { class: 'lm-quality__note' }, icon('info'), h('span', null, 'Playback quality data is collected on the Lumina server. It is not available in Preview mode.')));
    return section;
  }

  api.quality.summary(title.id).then((s) => {
    if (!s || s.unavailable) {
      section.hidden = true;
      return;
    }
    body.replaceChildren(measuredCard(s.measured || {}), reportedCard(s.reports || {}));
  }).catch(() => {
    body.replaceChildren(h('p', { class: 'lm-quality__note' }, icon('alert'), h('span', null, 'Playback quality could not be loaded right now.')));
  });
  return section;
}

function stat(label, value, hint) {
  return h('div', { class: 'lm-quality__stat' },
    h('dt', null, label),
    h('dd', null, value, hint ? h('span', { class: 'lm-quality__hint' }, hint) : null));
}

function measuredCard(m) {
  const head = h('div', { class: 'lm-quality__card-head' },
    h('span', { class: 'lm-quality__kind lm-quality__kind--measured' }, icon('chart'), 'Measured'),
    h('h3', null, 'Measured by Lumina players (last 90 days)'));
  if (!m.sufficient) {
    return h('article', { class: 'lm-panel lm-quality__card' }, head,
      h('p', { class: 'lm-quality__empty' }, h('strong', null, 'Not enough data yet.'), ` We publish measurements once the players of at least ${m.threshold || 10} different signed-in members have recorded viewing sessions`, m.viewers ? ` (${m.viewers} so far).` : '.'));
  }
  return h('article', { class: 'lm-panel lm-quality__card' }, head,
    h('dl', { class: 'lm-quality__stats' },
      stat('Members measured', String(m.viewers), `${m.sessions} viewing session${m.sessions === 1 ? '' : 's'}`),
      stat('Time spent buffering', m.rebufferRatio === null ? '—' : pct(m.rebufferRatio, m.rebufferRatio < 0.01 ? 2 : 1), 'of viewing time'),
      stat('Average bitrate', m.avgBitrateKbps ? formatBitrate(m.avgBitrateKbps * 1000) : '—', m.avgBitrateKbps ? 'of the video played' : null),
      stat('Median start time', m.medianStartupMs === null ? '—' : `${(m.medianStartupMs / 1000).toFixed(1)} s`),
      stat('Sessions with an error', m.errorRate === null ? '—' : pct(m.errorRate, 0))),
    h('p', { class: 'lm-quality__foot' }, 'Recorded automatically by the players of signed-in members during playback, with each member counted once. Varies with each viewer’s device and connection.'));
}

function reportedCard(r) {
  const head = h('div', { class: 'lm-quality__card-head' },
    h('span', { class: 'lm-quality__kind lm-quality__kind--reported' }, icon('message'), 'Reported'),
    h('h3', null, 'Reported by members — subjective'));
  if (!r.sufficient) {
    return h('article', { class: 'lm-panel lm-quality__card' }, head,
      h('p', { class: 'lm-quality__empty' }, h('strong', null, 'Not enough reports yet.'), ` Member reports are shown once at least ${r.threshold || 5} different members have reported`, r.count ? ` (${r.distinctReporters} so far).` : '.'));
  }
  const max = Math.max(1, ...r.categories.map((c) => c.count));
  return h('article', { class: 'lm-panel lm-quality__card' }, head,
    h('p', { class: 'lm-quality__lead' }, `${r.count} report${r.count === 1 ? '' : 's'} from ${r.distinctReporters} members`),
    h('ul', { class: 'lm-quality__bars', role: 'list' }, ...r.categories.map((c) => h('li', null,
      h('span', { class: 'lm-quality__bar-label' }, CATEGORY_LABEL[c.category] || c.category),
      h('span', { class: 'lm-quality__bar', 'aria-hidden': 'true' }, h('span', { style: { width: `${Math.round((c.count / max) * 100)}%` } })),
      h('span', { class: 'lm-quality__bar-count' }, String(c.count))))),
    h('p', { class: 'lm-quality__foot' }, 'What members told us about their own viewing. These are personal experiences, not official statistics.'));
}

// ─────────────────────────────── Report form ───────────────────────────────
export function qualityReportButton(title, episode = null) {
  return button('Report a playback problem', {
    variant: 'ghost',
    size: 'sm',
    icon: 'flag',
    onClick: () => openQualityReport(title, episode),
  });
}

/** Opens the report form (or explains why it is unavailable). */
export function openQualityReport(title, episode = null, { category, selectedResolution } = {}) {
  if (api.mode !== 'server' || !session.account) {
    const preview = api.mode !== 'server';
    let modal;
    const actions = [button('Close', { variant: 'ghost', onClick: () => modal.close() })];
    if (!preview) actions.push(button('Sign in', { variant: 'primary', icon: 'login', onClick: () => { modal.close(); navigate(`/login?next=${encodeURIComponent(location.hash.slice(1) || '/')}`); } }));
    modal = openModal({
      title: 'Report a playback problem',
      content: h('div', { class: 'lm-stack' },
        h('p', { class: 'lm-muted' }, preview
          ? 'Reports go to the Lumina team through the Lumina server. This copy of Lumina is running in Preview mode on static hosting, so reports cannot be sent from here.'
          : 'Sign in to your Lumina account to send a report. We use reports to find and fix playback problems.')),
      actions,
    });
    return modal;
  }

  const diagnostics = readDiagnostics();
  const matchesTitle = diagnostics && diagnostics.titleId === title.id;
  const conn = typeof navigator !== 'undefined' ? navigator.connection : null;
  const catName = 'category';
  const radios = QUALITY_CATEGORIES.map((c) => h('label', { class: 'lm-quality__radio' },
    h('input', { type: 'radio', name: catName, value: c.value, checked: c.value === (category || 'buffering'), required: true }),
    h('span', null, c.label)));
  const catField = h('fieldset', { class: 'lm-field lm-quality__cats' },
    h('legend', { class: 'lm-label' }, 'What went wrong?'),
    h('div', { class: 'lm-quality__radios' }, ...radios),
    h('span', { class: 'lm-error-text', hidden: true }));
  catField.control = { name: catName, focus: () => radios[0].querySelector('input').focus() };
  catField.setError = (msg) => {
    const err = catField.querySelector('.lm-error-text');
    err.hidden = !msg;
    err.textContent = msg || '';
  };

  const text = (label, name, { value = '', hint, type = 'text', maxlength, textarea = false, inputmode, step } = {}) => {
    const id = newUid('qf');
    const control = textarea
      ? h('textarea', { class: 'lm-textarea', id, name, rows: 4, maxlength })
      : h('input', { class: 'lm-input', id, name, type, value, maxlength, inputmode, step, min: type === 'number' ? '0' : undefined });
    if (textarea && value) control.value = value;
    const err = h('span', { class: 'lm-error-text', hidden: true, id: `${id}-err` });
    const hintEl = hint ? h('span', { class: 'lm-hint', id: `${id}-hint` }, hint) : null;
    control.setAttribute('aria-describedby', [hintEl && `${id}-hint`, `${id}-err`].filter(Boolean).join(' '));
    const wrap = h('div', { class: 'lm-field' }, h('label', { class: 'lm-label', for: id }, label), control, hintEl, err);
    wrap.control = control;
    wrap.setError = (msg) => {
      wrap.classList.toggle('has-error', !!msg);
      err.hidden = !msg;
      err.textContent = msg || '';
    };
    return wrap;
  };

  const description = text('What happened? (optional)', 'description', { textarea: true, maxlength: 2000, hint: 'For example: “Froze at 12:30 on my TV, audio kept going.”' });
  const device = text('Device (optional)', 'device', { value: uaSummary(navigator.userAgent), maxlength: 120, hint: 'Filled in from your browser. Edit it if you like.' });
  const speed = text('Connection speed in Mbps (optional)', 'connectionMbps', { type: 'number', step: 'any', inputmode: 'decimal', value: conn?.downlink ? String(conn.downlink) : '', hint: conn?.downlink ? 'Your browser’s rough estimate. Edit it if you ran a speed test.' : 'If you know it, e.g. from a speed test.' });
  const resolution = text('Selected resolution (optional)', 'selectedResolution', { value: selectedResolution || (matchesTitle ? diagnostics.quality || '' : ''), maxlength: 40 });

  const attach = h('input', { type: 'checkbox', name: 'attachDiagnostics', disabled: !matchesTitle });
  const preview = matchesTitle ? diagnosticsPreview(diagnostics) : null;
  const attachRow = h('div', { class: 'lm-quality__attach' },
    h('label', { class: 'lm-checkbox' }, attach,
      h('span', null, 'Attach playback diagnostics from this device',
        h('span', { class: 'lm-hint', style: { display: 'block' } }, matchesTitle
          ? 'Measurements your player recorded in this browser tab (shown below). Nothing is attached unless you tick this.'
          : 'Play this title in this browser tab first to have diagnostics to attach.'))),
    preview);

  const form = h('form', { class: 'lm-form lm-quality__form', novalidate: true },
    h('p', { class: 'lm-muted lm-small' }, episode ? `${title.title} · ${episodeLabel(episode)}` : title.title),
    catField, description, h('div', { class: 'lm-form-row' }, device, speed), resolution, attachRow);

  let modal;
  const submit = button('Send report', { variant: 'primary', icon: 'send' });
  const cancel = button('Cancel', { variant: 'ghost', onClick: () => modal.close() });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    send();
  });
  submit.addEventListener('click', () => send());

  async function send() {
    const fd = new FormData(form);
    const mbps = String(fd.get('connectionMbps') || '').trim();
    const body = {
      titleId: title.id,
      episodeId: episode?.id || undefined,
      category: fd.get(catName) || 'other',
      description: String(fd.get('description') || '').trim() || undefined,
      device: String(fd.get('device') || '').trim() || undefined,
      connectionMbps: mbps ? Number(mbps) : undefined,
      selectedResolution: String(fd.get('selectedResolution') || '').trim() || undefined,
      diagnostics: attach.checked && matchesTitle ? cleanDiagnostics(diagnostics) : undefined,
    };
    if (mbps && !Number.isFinite(body.connectionMbps)) {
      speed.setError('Enter a number, like 25.');
      speed.control.focus();
      return;
    }
    submit.disabled = true;
    try {
      await api.quality.report(body);
      modal.close();
      toast('Thanks — your report was sent to the Lumina team.', { type: 'success' });
    } catch (err) {
      submit.disabled = false;
      if (!applyFieldErrors(form, err)) toast(err?.message || 'The report could not be sent. Please try again.', { type: 'error' });
    }
  }

  modal = openModal({ title: 'Report a playback problem', content: form, actions: [cancel, submit], size: 'wide', sheet: true });
  setTimeout(() => form.querySelector('input[type=radio]:checked')?.focus(), 40);
  return modal;
}

const DIAG_FIELDS = [
  ['quality', 'Quality'], ['resolution', 'Resolution'], ['source', 'Source'], ['startupMs', 'Start time (ms)'],
  ['rebufferCount', 'Rebuffers'], ['rebufferSeconds', 'Buffering (s)'], ['avgBitrateKbps', 'Average bitrate (kbps)'],
  ['bandwidthKbps', 'Bandwidth estimate (kbps)'], ['bufferAheadS', 'Buffer ahead (s)'], ['droppedFrames', 'Dropped frames'],
  ['maxHeight', 'Highest resolution played'], ['codecs', 'Codecs'], ['errors', 'Recent error codes'],
];

function diagnosticsPreview(d) {
  const rows = DIAG_FIELDS.filter(([k]) => d[k] !== undefined && d[k] !== null && !(Array.isArray(d[k]) && !d[k].length));
  return h('details', { class: 'lm-quality__diag' },
    h('summary', null, 'What would be attached'),
    h('dl', null, ...rows.flatMap(([k, label]) => [h('dt', null, label), h('dd', null, Array.isArray(d[k]) ? d[k].join(', ') : String(d[k]))])));
}

/** Only the measured fields the API accepts. */
function cleanDiagnostics(d) {
  const keep = ['capturedAt', 'source', 'host', 'resolution', 'quality', 'startupMs', 'rebufferCount', 'rebufferSeconds', 'avgBitrateKbps', 'bandwidthKbps', 'bufferAheadS', 'droppedFrames', 'totalFrames', 'maxHeight', 'codecs', 'audio', 'subtitles', 'errors', 'userAgent'];
  const out = {};
  for (const k of keep) if (d[k] !== undefined && d[k] !== null) out[k] = d[k];
  if (Array.isArray(out.errors)) out.errors = out.errors.slice(-10).map((e) => String(e).slice(0, 64));
  return out;
}

// Staff API client for the admin app. Wraps api.request (js/api/client.js) and handles the
// two staff-only failure modes centrally:
//   REAUTH_REQUIRED     → asks the shell to show the password (+TOTP) form, then retries once
//   TOTP_SETUP_REQUIRED → asks the shell to explain that two-factor must be enabled first
import { api, ApiError } from '../api/client.js';

let reauthHandler = null;
let totpHandler = null;
let pendingReauth = null;

/** Registered by the shell: () => Promise<boolean> (true when the user re-authenticated). */
export function onReauthRequired(fn) {
  reauthHandler = fn;
}

export function onTotpSetupRequired(fn) {
  totpHandler = fn;
}

/**
 * After the re-auth dialog closes, focus would land on <body>: the control that started the
 * action is still disabled by withBusy() when the dialog tries to return focus to it. Wait
 * (briefly) for it to be enabled again and return focus there, unless focus moved elsewhere.
 */
// The last focused control: a busy button may already have lost focus (disabled elements
// are blurred) by the time a request fails with REAUTH_REQUIRED.
let lastFocused = null;
if (typeof document !== 'undefined') document.addEventListener('focusin', (e) => { lastFocused = e.target; }, true);

function restoreFocus(el) {
  if (!(el instanceof HTMLElement) || el === document.body) return;
  const until = Date.now() + 5000;
  const step = () => {
    if (!document.contains(el) || Date.now() > until) return;
    const active = document.activeElement;
    // Focus may still sit in the closing dialog; wait for it to land on <body>.
    const inDialog = !!active?.closest?.('dialog');
    if (active && active !== document.body && !inDialog) return; // focus moved on deliberately
    if (!inDialog && !el.disabled) {
      el.focus();
      return;
    }
    setTimeout(step, 50);
  };
  step();
}

async function call(method, path, { body, query, signal } = {}, retried = false) {
  try {
    return await api.request(method, path, { body: method === 'GET' ? undefined : (body ?? {}), query, signal });
  } catch (err) {
    if (err instanceof ApiError && err.code === 'REAUTH_REQUIRED' && !retried && reauthHandler) {
      const active = document.activeElement;
      const opener = active && active !== document.body ? active : lastFocused;
      // Several requests can fail at once; share one prompt.
      pendingReauth ||= Promise.resolve(reauthHandler()).finally(() => {
        pendingReauth = null;
      });
      const confirmed = await pendingReauth;
      if (confirmed) {
        try {
          return await call(method, path, { body, query, signal }, true);
        } finally {
          setTimeout(() => restoreFocus(opener), 0);
        }
      }
      setTimeout(() => restoreFocus(opener), 0);
    }
    if (err instanceof ApiError && err.code === 'TOTP_SETUP_REQUIRED') totpHandler?.(err);
    throw err;
  }
}

const get = (path, query, opts) => call('GET', path, { query, ...opts });
const post = (path, body) => call('POST', path, { body });
const put = (path, body) => call('PUT', path, { body });
const patch = (path, body) => call('PATCH', path, { body });
const del = (path, body) => call('DELETE', path, { body });
const enc = encodeURIComponent;

export const adminApi = {
  me: () => get('/api/admin/me'),
  overview: (opts) => get('/api/admin/overview', undefined, opts),
  titles: {
    list: (q, opts) => get('/api/admin/titles', q, opts),
    get: (id, opts) => get(`/api/admin/titles/${enc(id)}`, undefined, opts),
    create: (d) => post('/api/admin/titles', d),
    update: (id, d) => patch(`/api/admin/titles/${enc(id)}`, d),
    remove: (id) => del(`/api/admin/titles/${enc(id)}`),
    publish: (id) => post(`/api/admin/titles/${enc(id)}/publish`),
    unpublish: (id) => post(`/api/admin/titles/${enc(id)}/unpublish`),
    createSeason: (id, d) => post(`/api/admin/titles/${enc(id)}/seasons`, d),
    createEpisode: (id, d) => post(`/api/admin/titles/${enc(id)}/episodes`, d),
  },
  seasons: {
    update: (id, d) => patch(`/api/admin/seasons/${enc(id)}`, d),
    remove: (id) => del(`/api/admin/seasons/${enc(id)}`),
  },
  episodes: {
    update: (id, d) => patch(`/api/admin/episodes/${enc(id)}`, d),
    remove: (id) => del(`/api/admin/episodes/${enc(id)}`),
  },
  media: {
    list: (q, opts) => get('/api/admin/media', q, opts),
    get: (id) => get(`/api/admin/media/${enc(id)}`),
    create: (d) => post('/api/admin/media', d),
    update: (id, d) => patch(`/api/admin/media/${enc(id)}`, d),
    remove: (id) => del(`/api/admin/media/${enc(id)}`),
    verify: (id) => post(`/api/admin/media/${enc(id)}/verify`),
    transcode: (id, d) => post(`/api/admin/media/${enc(id)}/transcode`, d),
  },
  artwork: {
    // Artwork goes through the shared resumable uploads API; only creating the upload needs
    // staff rights (and may ask for re-authentication), so only that call is wrapped here.
    createUpload: (d) => post('/api/uploads', d),
  },
  tmdb: {
    search: (q, type) => get('/api/admin/tmdb/search', { q, type }),
    details: (type, id) => get(`/api/admin/tmdb/${enc(type)}/${enc(id)}`),
  },
  taxonomy: {
    get: (opts) => get('/api/admin/taxonomy', undefined, opts),
    put: (d) => put('/api/admin/taxonomy', d),
  },
  creators: {
    list: (q, opts) => get('/api/admin/creator-applications', q, opts),
    decide: (id, d) => post(`/api/admin/creator-applications/${enc(id)}/decision`, d),
  },
  submissions: {
    list: (q, opts) => get('/api/admin/submissions', q, opts),
    get: (id, opts) => get(`/api/admin/submissions/${enc(id)}`, undefined, opts),
    setStatus: (id, d) => post(`/api/admin/submissions/${enc(id)}/status`, d),
    comment: (id, d) => post(`/api/admin/submissions/${enc(id)}/comments`, d),
    publish: (id) => post(`/api/admin/submissions/${enc(id)}/publish`),
    fileUrl: (id, fileId) => get(`/api/admin/submissions/${enc(id)}/files/${enc(fileId)}/url`),
  },
  moderation: {
    reports: (q, opts) => get('/api/admin/reports', q, opts),
    resolve: (id, d) => post(`/api/admin/reports/${enc(id)}/resolve`, d),
    reviews: (q, opts) => get('/api/admin/reviews', q, opts),
    setReview: (id, d) => patch(`/api/admin/reviews/${enc(id)}`, d),
    setComment: (id, d) => patch(`/api/admin/comments/${enc(id)}`, d),
    history: (q, opts) => get('/api/admin/moderation/history', q, opts),
  },
  users: {
    list: (q, opts) => get('/api/admin/users', q, opts),
    get: (id, opts) => get(`/api/admin/users/${enc(id)}`, undefined, opts),
    update: (id, d) => patch(`/api/admin/users/${enc(id)}`, d),
    revokeSessions: (id) => post(`/api/admin/users/${enc(id)}/revoke-sessions`),
  },
  platform: {
    health: (opts) => get('/api/admin/health', undefined, opts),
    usage: (days, opts) => get('/api/admin/usage', { days }, opts),
    logs: (q, opts) => get('/api/admin/logs', q, opts),
    playbackErrors: (q, opts) => get('/api/admin/playback-errors', q, opts),
    qualityReports: (q, opts) => get('/api/admin/quality-reports', q, opts),
    setQualityStatus: (id, status) => patch(`/api/admin/quality-reports/${enc(id)}`, { status }),
    audit: (q, opts) => get('/api/admin/audit', q, opts),
    settings: (opts) => get('/api/admin/settings', undefined, opts),
    saveSettings: (d) => put('/api/admin/settings', d),
  },
  announcements: {
    list: (q, opts) => get('/api/admin/announcements', q, opts),
    create: (d) => post('/api/admin/announcements', d),
    remove: (id) => del(`/api/admin/announcements/${enc(id)}`),
  },
};

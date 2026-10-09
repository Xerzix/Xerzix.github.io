// Lumina API client. The rest of the app calls `api.<area>.<method>()` and never needs to
// know whether it is talking to the Lumina server or running in Preview mode (static
// hosting such as GitHub Pages). Preview mode implements catalog browsing, playback and a
// device-local library; everything that needs accounts or shared data throws
// ServerRequiredError, which views render with <serverRequired()>.

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = extra.fields || null;
    this.retryAfter = extra.retryAfter || null;
    this.extra = extra;
  }
}

export class ServerRequiredError extends ApiError {
  constructor(feature = 'This feature') {
    super(503, 'SERVER_REQUIRED', `${feature} needs the Lumina server. This copy of Lumina is running in Preview mode on static hosting.`);
    this.feature = feature;
  }
}

async function request(method, path, { body, query, signal, headers = {}, raw = false } = {}) {
  let url = path;
  if (query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `${url.includes('?') ? '&' : '?'}${s}`;
  }
  const init = {
    method,
    credentials: 'same-origin',
    signal,
    headers: { Accept: 'application/json', 'X-Lumina-Request': '1', ...headers },
  };
  if (body instanceof Blob || body instanceof ArrayBuffer) {
    init.body = body;
  } else if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(url, init);
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK', 'We could not reach Lumina. Check your connection and try again.');
  }
  if (raw) return res;
  if (res.status === 204) return null;
  let data = null;
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error || {};
    throw new ApiError(res.status, e.code || 'HTTP_ERROR', e.message || `Request failed (${res.status}).`, e);
  }
  return data;
}

const get = (p, query, opts) => request('GET', p, { query, ...opts });
const post = (p, body, opts) => request('POST', p, { body: body ?? {}, ...opts });
const put = (p, body, opts) => request('PUT', p, { body: body ?? {}, ...opts });
const patch = (p, body, opts) => request('PATCH', p, { body: body ?? {}, ...opts });
const del = (p, body, opts) => request('DELETE', p, { body, ...opts });
const enc = encodeURIComponent;

/** Server backend: thin wrappers over the REST API documented in docs/API.md. */
export function createServerBackend() {
  return {
    mode: 'server',
    request,
    session: {
      get: () => get('/api/session'),
    },
    auth: {
      register: (d) => post('/api/auth/register', d),
      login: (d) => post('/api/auth/login', d),
      logout: () => post('/api/auth/logout'),
      forgot: (d) => post('/api/auth/forgot', d),
      reset: (d) => post('/api/auth/reset', d),
      elevate: (d) => post('/api/auth/elevate', d),
    },
    account: {
      update: (d) => patch('/api/account', d),
      changePassword: (d) => post('/api/account/password', d),
      sessions: () => get('/api/account/sessions'),
      revokeSession: (id) => del(`/api/account/sessions/${enc(id)}`),
      revokeOtherSessions: () => del('/api/account/sessions'),
      setup2fa: () => post('/api/account/2fa/setup'),
      enable2fa: (d) => post('/api/account/2fa/enable', d),
      disable2fa: (d) => post('/api/account/2fa/disable', d),
      remove: (d) => del('/api/account', d),
      exportData: () => get('/api/account/export'),
      plan: () => get('/api/account/plan'),
    },
    profiles: {
      list: () => get('/api/profiles'),
      create: (d) => post('/api/profiles', d),
      update: (id, d) => patch(`/api/profiles/${enc(id)}`, d),
      remove: (id, d) => del(`/api/profiles/${enc(id)}`, d),
      select: (id, d) => post(`/api/profiles/${enc(id)}/select`, d),
      setPin: (id, d) => put(`/api/profiles/${enc(id)}/pin`, d),
      updatePreferences: (id, preferences) => put(`/api/profiles/${enc(id)}/preferences`, { preferences }),
    },
    catalog: {
      home: () => get('/api/home'),
      titles: (q) => get('/api/titles', q),
      title: (id) => get(`/api/titles/${enc(id)}`),
      similar: (id) => get(`/api/titles/${enc(id)}/similar`),
      search: (q, opts) => get('/api/search', q, opts),
      suggest: (q, opts) => get('/api/search/suggest', { q }, opts),
      genres: () => get('/api/genres'),
      playback: (titleId, { episodeId, role } = {}) => get(`/api/playback/${enc(titleId)}`, { episodeId, role }),
    },
    discover: {
      get: () => get('/api/discover'),
    },
    library: {
      summary: () => get('/api/library/summary'),
      watchlist: () => get('/api/library/watchlist'),
      addToList: (titleId) => put(`/api/library/watchlist/${enc(titleId)}`),
      removeFromList: (titleId) => del(`/api/library/watchlist/${enc(titleId)}`),
      reorderList: (titleIds) => put('/api/library/watchlist-order', { titleIds }),
      continueWatching: () => get('/api/library/continue'),
      titleProgress: (titleId) => get(`/api/library/title-progress/${enc(titleId)}`),
      saveProgress: (d, opts) => put('/api/library/progress', d, opts),
      markWatched: (titleId, episodeId) => post('/api/library/watched', { titleId, episodeId }),
      unmarkWatched: (titleId) => del(`/api/library/watched/${enc(titleId)}`),
      history: (page = 1) => get('/api/library/history', { page }),
      removeHistory: (id) => del(`/api/library/history/${enc(id)}`),
      clearHistory: () => del('/api/library/history'),
      stats: () => get('/api/library/stats'),
    },
    collections: {
      list: () => get('/api/collections'),
      create: (d) => post('/api/collections', d),
      get: (id) => get(`/api/collections/${enc(id)}`),
      update: (id, d) => patch(`/api/collections/${enc(id)}`, d),
      remove: (id) => del(`/api/collections/${enc(id)}`),
      addItem: (id, titleId) => put(`/api/collections/${enc(id)}/items/${enc(titleId)}`),
      removeItem: (id, titleId) => del(`/api/collections/${enc(id)}/items/${enc(titleId)}`),
      shared: (token) => get(`/api/shared/collections/${enc(token)}`),
    },
    follows: {
      list: () => get('/api/follows'),
      follow: (type, id) => put(`/api/follows/${enc(type)}/${enc(id)}`),
      unfollow: (type, id) => del(`/api/follows/${enc(type)}/${enc(id)}`),
    },
    reviews: {
      list: (titleId, q) => get(`/api/titles/${enc(titleId)}/reviews`, q),
      create: (titleId, d) => post(`/api/titles/${enc(titleId)}/reviews`, d),
      update: (id, d) => patch(`/api/reviews/${enc(id)}`, d),
      remove: (id) => del(`/api/reviews/${enc(id)}`),
      helpful: (id, on = true) => (on ? put(`/api/reviews/${enc(id)}/helpful`) : del(`/api/reviews/${enc(id)}/helpful`)),
      comments: (id) => get(`/api/reviews/${enc(id)}/comments`),
      comment: (id, body) => post(`/api/reviews/${enc(id)}/comments`, { body }),
      removeComment: (id) => del(`/api/comments/${enc(id)}`),
      report: (d) => post('/api/reports', d),
      block: (reviewId) => post('/api/blocks', { reviewId }),
      blocks: () => get('/api/blocks'),
      unblock: (id) => del(`/api/blocks/${enc(id)}`),
    },
    quality: {
      report: (d) => post('/api/quality-reports', d),
      summary: (titleId) => get(`/api/titles/${enc(titleId)}/quality`),
      session: (d) => post('/api/playback/sessions', d),
      error: (d) => post('/api/playback/errors', d),
    },
    velvia: {
      status: () => get('/api/velvia/status'),
      chat: (d, opts) => post('/api/velvia/chat', d, opts),
    },
    creators: {
      me: () => get('/api/creators/me'),
      apply: (d) => post('/api/creators/applications', d),
      submissions: () => get('/api/creators/submissions'),
      createSubmission: (d) => post('/api/creators/submissions', d),
      submission: (id) => get(`/api/creators/submissions/${enc(id)}`),
      updateSubmission: (id, d) => patch(`/api/creators/submissions/${enc(id)}`, d),
      attest: (id, d) => post(`/api/creators/submissions/${enc(id)}/attest`, d),
      submit: (id) => post(`/api/creators/submissions/${enc(id)}/submit`),
      respond: (id, message) => post(`/api/creators/submissions/${enc(id)}/respond`, { message }),
      removeSubmission: (id) => del(`/api/creators/submissions/${enc(id)}`),
      removeFile: (id, fileId) => del(`/api/creators/submissions/${enc(id)}/files/${enc(fileId)}`),
      titles: () => get('/api/creators/titles'),
    },
    uploads: {
      create: (d) => post('/api/uploads', d),
      status: (id) => get(`/api/uploads/${enc(id)}`),
      /** Sends one chunk at `offset`. Resolves with the server's new offset. */
      sendChunk: async (id, offset, blob, { signal } = {}) => {
        const res = await request('PATCH', `/api/uploads/${enc(id)}`, {
          body: blob,
          signal,
          raw: true,
          headers: { 'Content-Type': 'application/offset+octet-stream', 'Upload-Offset': String(offset) },
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          throw new ApiError(res.status, data?.error?.code || 'UPLOAD_FAILED', data?.error?.message || 'The upload was interrupted.', data?.error || {});
        }
        return Number(res.headers.get('Upload-Offset'));
      },
      abort: (id) => del(`/api/uploads/${enc(id)}`),
    },
    notifications: {
      list: (page = 1) => get('/api/notifications', { page }),
      unreadCount: () => get('/api/notifications/unread-count'),
      read: (id) => post(`/api/notifications/${enc(id)}/read`),
      readAll: () => post('/api/notifications/read-all'),
      remove: (id) => del(`/api/notifications/${enc(id)}`),
      prefs: () => get('/api/notifications/preferences'),
      setPrefs: (d) => put('/api/notifications/preferences', d),
    },
    parties: {
      create: (d) => post('/api/parties', d),
      get: (code) => get(`/api/parties/${enc(code)}`),
      join: (code) => post(`/api/parties/${enc(code)}/join`),
      update: (code, d) => patch(`/api/parties/${enc(code)}`, d),
      control: (code, d) => post(`/api/parties/${enc(code)}/control`, d),
      chat: (code, text) => post(`/api/parties/${enc(code)}/chat`, { text }),
      leave: (code) => post(`/api/parties/${enc(code)}/leave`),
      end: (code) => del(`/api/parties/${enc(code)}`),
      eventsUrl: (code) => `/api/parties/${enc(code)}/events`,
    },
  };
}

/** The live API object. Populated by initApi(). */
export const api = {};

/** Detects whether the Lumina server is reachable and installs the matching backend. */
export async function initApi() {
  let serverUp = false;
  try {
    const res = await fetch('/api/health', { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3500) });
    const data = res.ok && (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    serverUp = data?.service === 'lumina';
  } catch {
    serverUp = false;
  }
  if (serverUp) {
    Object.assign(api, createServerBackend());
  } else {
    const { createStaticBackend } = await import('./static-backend.js');
    Object.assign(api, await createStaticBackend());
  }
  return api.mode;
}

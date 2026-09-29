// Hash router (works on static hosting without server rewrites).
// Routes: { path: '/title/:id', load: () => import('../views/title.js'), title, layout, page, auth, server, feature }
//   layout: 'app' (header + footer) | 'bare' (minimal chrome) | 'immersive' (player)
//   auth:   'none' | 'account' | 'profile'
//   server: true when the route cannot work in Preview mode
// Views export `default async function render(ctx) -> Node`.
import { announce } from './dom.js';
import { bus } from './bus.js';

let routes = [];
let outlet = null;
let guard = null;
let current = null;
let renderSeq = 0;
let keySeq = Date.now();

function compile(path) {
  const keys = [];
  const re = path.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${re}\\/?$`), keys };
}

export function defineRoutes(list) {
  routes = list.map((r) => ({ layout: 'app', auth: 'none', ...r, ...compile(r.path) }));
}

export function parseHash(hash = location.hash) {
  const raw = hash.replace(/^#/, '') || '/';
  const [path, qs = ''] = raw.split('?');
  return { path: path.startsWith('/') ? path : `/${path}`, query: new URLSearchParams(qs), raw };
}

export function matchRoute(path) {
  for (const r of routes) {
    const m = r.regex.exec(path);
    if (m) {
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route: r, params };
    }
  }
  return null;
}

/** Navigates to an app path such as '/title/sintel' or '/search?q=moon'. */
export function navigate(path, { replace = false } = {}) {
  const target = path.startsWith('#') ? path : `#${path.startsWith('/') ? path : `/${path}`}`;
  if (target === location.hash && !replace) {
    render({ restore: null });
    return;
  }
  history.replaceState({ ...(history.state || {}), key: history.state?.key || ++keySeq, scroll: window.scrollY }, '');
  if (replace) history.replaceState({ key: ++keySeq, scroll: 0 }, '', target);
  else history.pushState({ key: ++keySeq, scroll: 0 }, '', target);
  render({ restore: null });
}

export function currentRoute() {
  return current;
}

/** Re-renders the current route (e.g. after signing in). */
export function reload() {
  return render({ restore: window.scrollY });
}

async function render({ restore }) {
  const seq = ++renderSeq;
  const { path, query, raw } = parseHash();
  const match = matchRoute(path) || matchRoute('/404');
  const ctx = {
    path,
    query,
    raw,
    params: match?.params || {},
    route: match?.route,
    navigate,
    setTitle: (t) => {
      document.title = t ? `${t} · Lumina` : 'Lumina';
    },
    onDestroy: (fn) => cleanups.push(fn),
  };
  const cleanups = [];
  const abort = new AbortController();
  ctx.signal = abort.signal;

  if (guard) {
    const redirect = await guard(match?.route, ctx);
    if (seq !== renderSeq) return;
    if (typeof redirect === 'string') {
      navigate(redirect, { replace: true });
      return;
    }
    if (redirect instanceof Node) {
      return swap(seq, ctx, redirect, match?.route, [], abort);
    }
  }

  let node;
  try {
    const mod = await match.route.load();
    if (seq !== renderSeq) return;
    node = await mod.default(ctx);
  } catch (err) {
    if (err?.name === 'AbortError' || seq !== renderSeq) return;
    console.error(err);
    const { errorState } = await import('../ui/components.js');
    node = errorState(err, { retry: () => reload() });
  }
  if (seq !== renderSeq) {
    cleanups.forEach((fn) => fn());
    return;
  }
  swap(seq, ctx, node, match.route, cleanups, abort, restore);
}

function swap(seq, ctx, node, route, cleanups, abort, restore = null) {
  if (current) {
    current.abort.abort();
    for (const fn of current.cleanups) {
      try {
        fn();
      } catch (err) {
        console.error(err);
      }
    }
  }
  const view = document.createElement('div');
  view.className = 'lm-view';
  view.append(node);
  outlet.replaceChildren(view);
  const r = route || {};
  document.body.dataset.layout = r.layout || 'app';
  document.body.dataset.page = r.page || r.path?.split('/')[1] || 'home';
  if (!document.title || r.title) ctx.setTitle(r.title);
  current = { route: r, ctx, cleanups, abort, path: ctx.path };

  window.scrollTo({ top: restore ?? 0, behavior: 'instant' });
  // Move focus to the new page's heading so screen reader and keyboard users land in context.
  const heading = view.querySelector('h1');
  if (heading && !restore) {
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
  announce(document.title);
  bus.emit('route:changed', { path: ctx.path, params: ctx.params, route: r });
}

export function startRouter({ outlet: el, guard: g }) {
  outlet = el;
  guard = g;
  // Intercept in-app links so every navigation gets a history entry with scroll state.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a[href^="#/"]');
    if (!a || a.target === '_blank') return;
    e.preventDefault();
    navigate(a.getAttribute('href').slice(1));
  });
  const isAppHash = () => !location.hash || location.hash.startsWith('#/');
  window.addEventListener('popstate', (e) => {
    if (isAppHash()) render({ restore: e.state?.scroll ?? null });
  });
  window.addEventListener('hashchange', () => {
    if (!history.state && isAppHash()) render({ restore: null });
  });
  if (!history.state) history.replaceState({ key: ++keySeq, scroll: 0 }, '');
  return render({ restore: null });
}

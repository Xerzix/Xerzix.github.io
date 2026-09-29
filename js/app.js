// Lumina application shell: route table, access guards, appearance, garden environment and
// particle fields. Feature views live in js/views/ and are loaded on demand.
import { h } from './core/dom.js';
import { bus } from './core/bus.js';
import { session, refreshSession } from './core/session.js';
import { setLanguage } from './core/i18n.js';
import { defineRoutes, startRouter } from './core/router.js';
import { initApi } from './api/client.js';
import { applyAppearance, DEFAULT_APPEARANCE } from './theme.js';
import { mountGarden, ENVIRONMENTS } from './fx/garden.js';
import { ParticleField, ENV_PARTICLES } from './fx/petals.js';
import { playIntro } from './fx/intro.js';
import { mountHeader } from './ui/header.js';
import { mountFooter } from './ui/footer.js';
import { serverRequired } from './ui/components.js';
import { store } from './core/storage.js';

// Route table. `server: true` routes need the Lumina server; `auth` enforces sign-in/profile.
export const ROUTES = [
  { path: '/', load: () => import('./views/home.js'), title: 'Home', page: 'home' },
  { path: '/movies', load: () => import('./views/browse.js'), title: 'Movies', page: 'browse' },
  { path: '/tv', load: () => import('./views/browse.js'), title: 'TV Shows', page: 'browse' },
  { path: '/new', load: () => import('./views/browse.js'), title: 'New Releases', page: 'browse' },
  { path: '/trending', load: () => import('./views/browse.js'), title: 'Trending', page: 'browse' },
  { path: '/genres', load: () => import('./views/genres.js'), title: 'Genres', page: 'genres' },
  { path: '/genres/:genre', load: () => import('./views/genres.js'), title: 'Genres', page: 'genres' },
  { path: '/discover', load: () => import('./views/discover.js'), title: 'Discover', page: 'discover' },
  { path: '/title/:id', load: () => import('./views/title.js'), title: '', page: 'title' },
  { path: '/watch/:id', load: () => import('./views/watch.js'), title: 'Watching', page: 'watch', layout: 'immersive' },
  { path: '/search', load: () => import('./views/search.js'), title: 'Search', page: 'search' },
  { path: '/my-list', load: () => import('./views/my-list.js'), title: 'My List', page: 'my-list' },
  { path: '/my-list/:tab', load: () => import('./views/my-list.js'), title: 'My List', page: 'my-list' },
  { path: '/collections/:id', load: () => import('./views/collection.js'), title: 'Collection', page: 'collection' },
  { path: '/shared/:token', load: () => import('./views/collection.js'), title: 'Shared collection', page: 'collection', server: true, feature: 'Shared collections' },
  { path: '/compare', load: () => import('./views/compare.js'), title: 'Compare', page: 'compare' },
  { path: '/stats', load: () => import('./views/stats.js'), title: 'Viewing statistics', page: 'stats' },
  { path: '/velvia', load: () => import('./views/velvia.js'), title: 'Velvia Suggestions', page: 'velvia' },
  { path: '/notifications', load: () => import('./views/notifications.js'), title: 'Notifications', page: 'notifications', server: true, feature: 'Notifications', auth: 'account' },
  { path: '/login', load: () => import('./views/auth.js'), title: 'Sign in', page: 'auth', layout: 'bare', server: true, feature: 'Signing in' },
  { path: '/register', load: () => import('./views/auth.js'), title: 'Create account', page: 'auth', layout: 'bare', server: true, feature: 'Creating an account' },
  { path: '/forgot', load: () => import('./views/auth.js'), title: 'Reset password', page: 'auth', layout: 'bare', server: true, feature: 'Password recovery' },
  { path: '/reset', load: () => import('./views/auth.js'), title: 'Choose a new password', page: 'auth', layout: 'bare', server: true, feature: 'Password recovery' },
  { path: '/profiles', load: () => import('./views/profiles.js'), title: 'Who’s watching?', page: 'profiles', layout: 'bare', server: true, feature: 'Profiles', auth: 'account' },
  { path: '/profiles/manage', load: () => import('./views/profiles.js'), title: 'Manage profiles', page: 'profiles', layout: 'bare', server: true, feature: 'Profiles', auth: 'account' },
  { path: '/account', load: () => import('./views/account.js'), title: 'Account', page: 'account', server: true, feature: 'Account management', auth: 'account' },
  { path: '/settings', load: () => import('./views/settings.js'), title: 'Settings', page: 'settings' },
  { path: '/settings/:section', load: () => import('./views/settings.js'), title: 'Settings', page: 'settings' },
  { path: '/creators', load: () => import('./views/creators.js'), title: 'Creators', page: 'creators' },
  { path: '/creators/dashboard', load: () => import('./views/creator-dashboard.js'), title: 'Creator dashboard', page: 'creators', server: true, feature: 'The creator dashboard', auth: 'account' },
  { path: '/creators/submissions/:id', load: () => import('./views/creator-submission.js'), title: 'Submission', page: 'creators', server: true, feature: 'Creator submissions', auth: 'account' },
  { path: '/party/:code', load: () => import('./views/party.js'), title: 'Watch party', page: 'party', layout: 'immersive', server: true, feature: 'Watch parties', auth: 'profile' },
  { path: '/legal/:doc', load: () => import('./views/legal.js'), title: 'Legal', page: 'legal' },
  { path: '/404', load: () => import('./views/not-found.js'), title: 'Not found', page: 'not-found' },
];

// ── Appearance & environment ──────────────────────────────
let backField = null;
let frontField = null;
let garden = null;
let appearance = { ...DEFAULT_APPEARANCE };

export function currentAppearance() {
  return appearance;
}

/** Applies appearance preferences everywhere (theme, environment, particles). */
export function setAppearance(next, { persistLocal = true } = {}) {
  appearance = applyAppearance({ ...DEFAULT_APPEARANCE, ...next });
  if (persistLocal) store.set('appearance', appearance);
  updateParticles();
  garden?.setParallax(appearance.parallax);
  bus.emit('theme:changed', appearance);
}

function updateParticles() {
  const kind = appearance.animation ? ENV_PARTICLES[appearance.environment] ?? null : null;
  const immersive = document.body.dataset.layout === 'immersive';
  for (const [field, scale] of [[backField, 1], [frontField, 1]]) {
    if (!field) continue;
    field.setKind(kind);
    field.setIntensity((appearance.petalIntensity ?? 0.6) * scale);
    if (!kind || immersive) field.halt();
    else {
      field.start();
      field.resume();
    }
  }
}

function applyProfileAppearance() {
  const prefs = session.profile?.preferences?.appearance;
  // A profile's saved appearance wins; otherwise keep this device's last choice.
  setAppearance(prefs && Object.keys(prefs).length ? prefs : store.get('appearance', DEFAULT_APPEARANCE), { persistLocal: !prefs });
  setLanguage(session.profile?.uiLanguage || 'en');
}

// ── Guards ────────────────────────────────────────────────
async function guard(route, ctx) {
  if (!route) return undefined;
  if (route.server && !session.isServer) return serverRequired(route.feature);
  const next = encodeURIComponent(ctx.raw);
  if ((route.auth === 'account' || route.auth === 'profile') && !session.account) return `/login?next=${next}`;
  if (route.auth === 'profile' && !session.profile) return `/profiles?next=${next}`;
  // Signed-in accounts choose a profile before browsing (like any multi-profile service).
  if (session.isServer && session.account && !session.profile && !['auth', 'profiles', 'account', 'legal'].includes(route.page)) {
    return `/profiles?next=${next}`;
  }
  return undefined;
}

// ── Boot ──────────────────────────────────────────────────
export async function boot() {
  document.querySelector('.lm-skip-link')?.addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('main').focus();
  });
  const introDone = playIntro();
  const gardenEl = document.getElementById('lm-garden');
  garden = mountGarden(gardenEl);
  const back = document.getElementById('lm-petals-back');
  const front = document.getElementById('lm-petals-front');
  backField = new ParticleField(back);
  frontField = new ParticleField(front, { front: true });
  setAppearance(store.get('appearance', DEFAULT_APPEARANCE), { persistLocal: false });

  const mode = await initApi();
  document.documentElement.dataset.mode = mode;
  try {
    await refreshSession();
  } catch (err) {
    console.error('Session unavailable', err);
  }
  applyProfileAppearance();
  bus.on('session:changed', applyProfileAppearance);

  mountHeader(document.getElementById('lm-header'));
  mountFooter(document.getElementById('lm-footer'));
  if (mode === 'static') {
    document.getElementById('lm-header').after(h('div', { class: 'lm-preview-banner', role: 'note' },
      h('strong', null, 'Preview'),
      h('span', null, 'Browsing the open catalog on static hosting. Your list and progress stay on this device; accounts, reviews and uploads need the Lumina server.')));
  }

  // Particles pause entirely while the player is open and gust on navigation.
  bus.on('route:changed', ({ route }) => {
    updateParticles();
    if (route?.layout !== 'immersive') backField?.gustNow(0.8);
  });

  await introDone;
  defineRoutes(ROUTES);
  await startRouter({ outlet: document.getElementById('main'), guard });
}

export { ENVIRONMENTS };

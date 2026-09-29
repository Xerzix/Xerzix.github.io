// Site header: logo, primary navigation, instant search, notifications, profile menu,
// mobile drawer and bottom tab bar.
import { h, debounce, newUid } from '../core/dom.js';
import { bus } from '../core/bus.js';
import { session } from '../core/session.js';
import { store } from '../core/storage.js';
import { t } from '../core/i18n.js';
import { relativeTime } from '../core/format.js';
import { navigate } from '../core/router.js';
import { api } from '../api/client.js';
import { icon, logoMark } from './icons.js';
import { avatar } from './avatars.js';
import { bindMenu, menuItem, toastError } from './components.js';

const NAV = [
  { href: '#/', key: 'nav.home', label: 'Home', match: (p) => p === '/', priority: 1, icon: 'home' },
  { href: '#/movies', key: 'nav.movies', label: 'Movies', match: (p) => p === '/movies', priority: 1, icon: 'film' },
  { href: '#/tv', key: 'nav.tv', label: 'TV Shows', match: (p) => p === '/tv', priority: 1, icon: 'tv' },
  { href: '#/genres', key: 'nav.genres', label: 'Genres', match: (p) => p.startsWith('/genres'), priority: 2, icon: 'grid' },
  { href: '#/new', key: 'nav.new', label: 'New Releases', match: (p) => p === '/new', priority: 2, icon: 'calendar' },
  { href: '#/trending', key: 'nav.trending', label: 'Trending', match: (p) => p === '/trending', priority: 3, icon: 'flame' },
  { href: '#/my-list', key: 'nav.mylist', label: 'My List', match: (p) => p.startsWith('/my-list'), priority: 1, icon: 'list' },
  { href: '#/velvia', key: 'nav.velvia', label: 'Velvia Suggestions', match: (p) => p.startsWith('/velvia'), priority: 1, icon: 'sparkle', velvia: true },
];

const MORE = [
  { href: '#/discover', key: 'nav.discover', label: 'Discover', icon: 'compass' },
  { href: '#/genres', key: 'nav.genres', label: 'Genres', icon: 'grid' },
  { href: '#/new', key: 'nav.new', label: 'New Releases', icon: 'calendar' },
  { href: '#/trending', key: 'nav.trending', label: 'Trending', icon: 'flame' },
  { href: '#/creators', key: 'nav.creators', label: 'Creators', icon: 'clapper' },
];

export function mountHeader(root) {
  root.className = 'lm-header';
  root.dataset.scrolled = 'false';
  const inner = h('div', { class: 'lm-header__inner' });
  root.replaceChildren(inner);

  const logo = h('a', { class: 'lm-logo', href: '#/', 'aria-label': 'Lumina home' }, logoMark(), h('span', { class: 'lm-logo__word', 'aria-hidden': 'true' }, 'LUMINA'));

  const navLinks = NAV.map((n) => h('li', { 'data-priority': String(n.priority) },
    h('a', { class: ['lm-nav__link', n.velvia && 'lm-nav__link--velvia'], href: n.href, 'data-nav': n.href }, n.velvia ? icon('sparkle') : null, t(n.key, n.label))));
  const moreBtn = h('button', { class: 'lm-nav__link', type: 'button' }, t('nav.browse', 'Browse'), icon('chevronDown'));
  const moreMenu = h('div', { class: 'lm-menu', role: 'menu', style: { left: '0', right: 'auto', top: 'calc(100% + 10px)' } }, ...MORE.map((m) => menuItem(t(m.key, m.label), { icon: m.icon, href: m.href })));
  const more = h('li', { class: 'lm-nav__more lm-popover-anchor' }, moreBtn, moreMenu);
  bindMenu(moreBtn, moreMenu);
  const nav = h('nav', { class: 'lm-nav', 'aria-label': 'Primary' }, h('ul', { role: 'list' }, ...navLinks, more));

  const tools = h('div', { class: 'lm-header__tools' });
  const menuToggle = h('button', { class: 'lm-icon-btn lm-menu-toggle', type: 'button', 'aria-label': 'Open menu' }, icon('menu'));
  menuToggle.addEventListener('click', openDrawer);
  inner.append(menuToggle, logo, nav, tools);

  const search = searchBox();
  const bellSlot = h('div', { class: 'lm-popover-anchor' });
  const profileSlot = h('div', { class: 'lm-popover-anchor' });
  tools.append(search, bellSlot, profileSlot);

  const bottom = mountBottomNav();

  function renderAccountTools() {
    bellSlot.firstElementChild?.dispatchEvent(new Event('lm:destroy'));
    bellSlot.replaceChildren(session.isServer && session.account ? notificationsBell() : '');
    profileSlot.replaceChildren(profileMenu());
  }
  renderAccountTools();
  bus.on('session:changed', renderAccountTools);

  // Active link state
  bus.on('route:changed', ({ path }) => {
    for (const a of root.querySelectorAll('[data-nav]')) {
      const n = NAV.find((x) => x.href === a.dataset.nav);
      if (n?.match(path)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
    for (const a of bottom.querySelectorAll('[data-tab]')) {
      if (a.dataset.tab === (path === '/' ? '/' : `/${path.split('/')[1]}`)) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  });

  // Solid header after scrolling
  let ticking = false;
  const onScroll = () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => {
      root.dataset.scrolled = String(window.scrollY > 24);
      ticking = false;
    });
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  return root;
}

// ── Instant search ──────────────────────────────────────
function recentKey() {
  return `recentSearches.${session.profile?.id || 'guest'}`;
}

export function rememberSearch(q) {
  const term = q.trim();
  if (!term) return;
  const list = store.get(recentKey(), []).filter((x) => x.toLowerCase() !== term.toLowerCase());
  list.unshift(term);
  store.set(recentKey(), list.slice(0, 8));
}

function searchBox() {
  const listId = newUid('suggest');
  const input = h('input', {
    class: 'lm-search__input', type: 'search', placeholder: t('search.placeholder', 'Titles, people, genres'),
    role: 'combobox', 'aria-expanded': 'false', 'aria-controls': listId, 'aria-autocomplete': 'list', 'aria-label': 'Search Lumina', autocomplete: 'off', enterkeyhint: 'search',
  });
  const clearBtn = h('button', { class: 'lm-search__clear', type: 'button', 'aria-label': 'Clear search', hidden: true }, icon('close'));
  const toggle = h('button', { class: 'lm-search__toggle', type: 'button', 'aria-label': 'Search' }, icon('search'));
  const panel = h('div', { class: 'lm-menu lm-search__panel', id: listId, role: 'listbox', 'aria-label': 'Search suggestions', hidden: true });
  const root = h('div', { class: 'lm-search lm-popover-anchor', role: 'search' }, h('div', { class: 'lm-search__box' }, toggle, input, clearBtn), panel);
  let options = [];
  let active = -1;
  let controller = null;

  const open = () => {
    root.classList.add('is-open');
    setTimeout(() => input.focus(), 30);
  };
  const close = () => {
    panel.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    if (!input.value) root.classList.remove('is-open');
  };
  const submit = (q) => {
    const term = (q ?? input.value).trim();
    if (!term) return;
    rememberSearch(term);
    close();
    input.blur();
    navigate(`/search?q=${encodeURIComponent(term)}`);
  };

  toggle.addEventListener('click', () => {
    if (window.matchMedia('(max-width: 720px)').matches) return navigate('/search');
    if (root.classList.contains('is-open') && input.value) submit();
    else open();
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    clearBtn.hidden = true;
    input.focus();
    showRecent();
  });

  function setOptions(nodes) {
    options = nodes.filter((n) => n.getAttribute('role') === 'option');
    active = -1;
    panel.replaceChildren(...nodes);
    panel.hidden = nodes.length === 0;
    input.setAttribute('aria-expanded', String(!panel.hidden));
  }

  function option(label, sub, { thumb, iconName, onChoose, onRemove }) {
    const id = newUid('opt');
    const el = h('div', { class: 'lm-suggestion', role: 'option', id, 'aria-selected': 'false' },
      thumb ? h('img', { class: 'lm-suggestion__thumb', src: thumb, alt: '' }) : h('span', { class: 'lm-suggestion__icon' }, icon(iconName || 'search')),
      h('span', { class: 'lm-suggestion__text' }, h('strong', null, label), sub ? h('span', null, sub) : null),
      onRemove ? h('button', { class: 'lm-suggestion__remove', type: 'button', 'aria-label': `Remove “${label}” from recent searches`, tabindex: '-1', onClick: (e) => { e.stopPropagation(); onRemove(); } }, icon('close')) : null);
    el.addEventListener('mousedown', (e) => e.preventDefault());
    el.addEventListener('click', onChoose);
    el.choose = onChoose;
    return el;
  }

  function showRecent() {
    const recent = store.get(recentKey(), []);
    if (!recent.length) return setOptions([]);
    setOptions([
      h('div', { class: 'lm-menu__label' }, 'Recent searches'),
      ...recent.map((q) => option(q, null, {
        iconName: 'history',
        onChoose: () => submit(q),
        onRemove: () => {
          store.set(recentKey(), store.get(recentKey(), []).filter((x) => x !== q));
          showRecent();
        },
      })),
      h('div', { class: 'lm-menu__sep' }),
      h('button', { class: 'lm-menu__item', type: 'button', onClick: () => { store.remove(recentKey()); setOptions([]); input.focus(); } }, icon('trash'), h('span', null, 'Clear search history')),
    ]);
  }

  const suggest = debounce(async (q) => {
    controller?.abort();
    controller = new AbortController();
    try {
      const { suggestions } = await api.catalog.suggest(q, { signal: controller.signal });
      const nodes = suggestions.map((s) => option(s.label, s.sub, {
        thumb: s.kind === 'title' ? s.poster : null,
        iconName: s.kind === 'person' ? 'user' : 'grid',
        onChoose: () => {
          close();
          input.blur();
          rememberSearch(s.label);
          if (s.kind === 'title') navigate(`/title/${encodeURIComponent(s.id)}`);
          else if (s.kind === 'genre') navigate(`/genres/${encodeURIComponent(s.label)}`);
          else navigate(`/search?q=${encodeURIComponent(s.label)}`);
        },
      }));
      nodes.push(option(`Search for “${q}”`, 'See all results', { iconName: 'search', onChoose: () => submit(q) }));
      setOptions(nodes);
    } catch (err) {
      if (err.name !== 'AbortError') setOptions([option(`Search for “${q}”`, null, { onChoose: () => submit(q) })]);
    }
  }, 120);

  input.addEventListener('focus', () => {
    root.classList.add('is-open');
    if (!input.value) showRecent();
  });
  input.addEventListener('input', () => {
    clearBtn.hidden = !input.value;
    if (input.value.trim().length >= 1) suggest(input.value.trim());
    else showRecent();
  });
  input.addEventListener('blur', () => setTimeout(() => {
    if (!root.contains(document.activeElement)) close();
  }, 120));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!options.length) return;
      e.preventDefault();
      options[active]?.setAttribute('aria-selected', 'false');
      active = e.key === 'ArrowDown' ? (active + 1) % options.length : (active - 1 + options.length) % options.length;
      options[active].setAttribute('aria-selected', 'true');
      options[active].scrollIntoView({ block: 'nearest' });
      input.setAttribute('aria-activedescendant', options[active].id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && options[active]) options[active].choose();
      else submit();
    } else if (e.key === 'Escape') {
      if (!panel.hidden) close();
      else {
        input.value = '';
        clearBtn.hidden = true;
        root.classList.remove('is-open');
        input.blur();
      }
    }
  });
  // "/" focuses search from anywhere (common streaming shortcut).
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !e.target.closest('input, textarea, select, [contenteditable]') && document.body.dataset.layout !== 'immersive') {
      e.preventDefault();
      open();
    }
  });
  return root;
}

// ── Notifications ───────────────────────────────────────
function notificationsBell() {
  const badge = h('span', { class: 'lm-count-badge', hidden: true });
  const btn = h('button', { class: 'lm-icon-btn', type: 'button', 'aria-label': t('nav.notifications', 'Notifications') }, icon('bell'), badge);
  const panel = h('div', { class: 'lm-menu lm-notif-panel', role: 'menu', 'aria-label': 'Notifications' });
  const wrap = h('div', { class: 'lm-popover-anchor' }, btn, panel);
  const setCount = (n) => {
    badge.hidden = !n;
    badge.textContent = n > 9 ? '9+' : String(n);
    btn.setAttribute('aria-label', n ? `Notifications, ${n} unread` : 'Notifications');
  };
  const refresh = async () => {
    try {
      const { unread } = await api.notifications.unreadCount();
      setCount(unread);
    } catch {
      /* optional */
    }
  };
  bindMenu(btn, panel, {
    onOpen: async () => {
      panel.replaceChildren(h('div', { class: 'lm-menu__label' }, 'Notifications'), h('p', { class: 'lm-notif lm-muted' }, 'Loading…'));
      try {
        const { items } = await api.notifications.list(1);
        const list = items.slice(0, 6).map((n) => h('a', {
          class: ['lm-notif', 'lm-menu__item', !n.readAt && 'is-unread'],
          href: n.link?.startsWith('#/') ? n.link : '#/notifications',
          onClick: () => { if (!n.readAt) api.notifications.read(n.id).then(refresh).catch(() => {}); },
        }, h('div', null, h('strong', null, n.title), n.body ? h('span', null, n.body) : null, h('time', { datetime: n.createdAt }, relativeTime(n.createdAt)))));
        panel.replaceChildren(
          h('div', { class: 'lm-menu__label' }, 'Notifications'),
          ...(list.length ? list : [h('p', { class: 'lm-notif lm-muted' }, 'You are all caught up.')]),
          h('div', { class: 'lm-menu__sep' }),
          menuItem('View all notifications', { icon: 'bell', href: '#/notifications' }),
        );
      } catch (err) {
        panel.replaceChildren(h('p', { class: 'lm-notif lm-muted' }, err.message));
      }
    },
  });
  refresh();
  const timer = setInterval(() => !document.hidden && refresh(), 60_000);
  const off = bus.on('notifications:changed', refresh);
  wrap.addEventListener('lm:destroy', () => {
    clearInterval(timer);
    off();
  });
  return wrap;
}

// ── Profile menu ────────────────────────────────────────
function profileMenu() {
  if (session.isServer && !session.account) {
    return h('a', { class: 'lm-btn lm-btn--primary lm-btn--sm', href: '#/login' }, h('span', null, t('nav.signin', 'Sign in')));
  }
  const p = session.profile;
  const btn = h('button', { class: 'lm-profile-btn', type: 'button', 'aria-label': `Profile menu${p ? ` for ${p.name}` : ''}` }, avatar(p?.avatar || 'sakura'), icon('chevronDown'));
  const items = [];
  if (p) items.push(h('div', { class: 'lm-menu__label' }, p.name));
  if (session.isServer) {
    items.push(
      menuItem(t('nav.profiles', 'Switch profile'), { icon: 'users', href: '#/profiles' }),
      menuItem(t('nav.manageProfiles', 'Manage profiles'), { icon: 'edit', href: '#/profiles/manage' }),
      menuItem(t('nav.account', 'Account'), { icon: 'user', href: '#/account' }),
    );
  }
  items.push(
    menuItem(t('nav.settings', 'Settings'), { icon: 'settings', href: '#/settings' }),
    menuItem(t('nav.stats', 'Viewing statistics'), { icon: 'chart', href: '#/stats' }),
    menuItem(t('nav.creators', 'Creators'), { icon: 'clapper', href: '#/creators' }),
  );
  if (session.isStaff) items.push(menuItem(t('nav.admin', 'Admin dashboard'), { icon: 'shield', href: 'admin.html' }));
  if (session.isServer) {
    items.push(h('div', { class: 'lm-menu__sep' }), menuItem(t('nav.signout', 'Sign out'), {
      icon: 'logout',
      onClick: async () => {
        try {
          await api.auth.logout();
          const { refreshSession } = await import('../core/session.js');
          await refreshSession();
          navigate('/');
        } catch (err) {
          toastError(err);
        }
      },
    }));
  } else {
    items.push(h('div', { class: 'lm-menu__sep' }), h('p', { class: 'lm-menu__item lm-xsmall' }, 'Preview mode — your list stays on this device.'));
  }
  const menu = h('div', { class: 'lm-menu', role: 'menu' }, ...items);
  bindMenu(btn, menu);
  return h('div', { class: 'lm-popover-anchor' }, btn, menu);
}

// ── Mobile drawer and bottom navigation ─────────────────
function openDrawer() {
  const links = [...NAV, ...MORE.filter((m) => !NAV.some((n) => n.href === m.href)), { href: '#/settings', key: 'nav.settings', label: 'Settings', icon: 'settings' }];
  const path = location.hash.slice(1).split('?')[0] || '/';
  const dlg = h('dialog', { class: 'lm-drawer', 'aria-label': 'Menu' },
    h('div', { class: 'lm-drawer__head' },
      h('a', { class: 'lm-logo', href: '#/' }, logoMark(), h('span', { class: 'lm-logo__word' }, 'LUMINA')),
      h('button', { class: 'lm-icon-btn', type: 'button', 'aria-label': 'Close menu', onClick: () => dlg.close() }, icon('close'))),
    h('nav', { 'aria-label': 'Main menu' }, ...links.map((l) => h('a', { href: l.href, 'aria-current': (l.match ? l.match(path) : l.href === `#${path}`) ? 'page' : undefined }, icon(l.icon), t(l.key, l.label)))));
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg || e.target.closest('a')) dlg.close();
  });
  dlg.addEventListener('close', () => dlg.remove());
  document.getElementById('lm-modals').append(dlg);
  dlg.showModal();
}

function mountBottomNav() {
  const tabs = [
    { tab: '/', href: '#/', icon: 'home', label: t('nav.home', 'Home') },
    { tab: '/search', href: '#/search', icon: 'search', label: t('nav.search', 'Search') },
    { tab: '/velvia', href: '#/velvia', icon: 'sparkle', label: 'Velvia' },
    { tab: '/my-list', href: '#/my-list', icon: 'list', label: t('nav.mylist', 'My List') },
    { tab: '/settings', href: '#/settings', icon: 'settings', label: t('nav.settings', 'Settings') },
  ];
  const nav = h('nav', { class: 'lm-bottom-nav', 'aria-label': 'Quick navigation' }, ...tabs.map((x) => h('a', { href: x.href, 'data-tab': x.tab }, icon(x.icon), h('span', null, x.label))));
  document.body.append(nav);
  return nav;
}

// "Who's watching?" — the opening screen. Five slots: each configured slot is a separate Lumina
// account (its own username, password and data) that has been used on this browser; empty
// slots add a new or existing account. With five identities there is no sixth slot.
import { h } from '../core/dom.js';
import { api } from '../api/client.js';
import { session } from '../core/session.js';
import { avatar } from '../ui/avatars.js';
import { icon, logoMark } from '../ui/icons.js';
import { button, confirmDialog, toast, toastError } from '../ui/components.js';
import { addIdentityDialog, markIdentityChosen, switchToIdentity } from '../ui/identity.js';

export default async function render(ctx) {
  ctx.setTitle('Who’s watching?');
  const next = (() => {
    const n = ctx.query.get('next') || '/';
    return n.startsWith('/') && !n.startsWith('/whos-watching') ? n : '/';
  })();
  let manage = ctx.query.get('manage') === '1';
  let data = await api.identities.list();
  const preview = !!data.preview || !session.isServer;

  const grid = h('ul', { class: 'lm-who__grid', role: 'list', 'aria-label': 'Identities on this device' });
  const status = h('p', { class: 'lm-who__status', role: 'status' });
  const manageBtn = button(manage ? 'Done' : 'Manage identities', { variant: manage ? 'primary' : 'glass', icon: manage ? 'check' : 'edit' });
  const continueLink = h('a', { class: 'lm-link lm-who__guest', href: `#${next}`, onClick: () => markIdentityChosen() },
    preview ? 'Continue to Lumina' : session.account ? 'Continue' : 'Browse without signing in');

  function slot(it, index) {
    const state = it.active ? 'Signed in' : it.suspended ? 'Suspended' : it.remembered ? 'Signed in on this device' : 'Password required';
    const tile = h('button', {
      type: 'button',
      class: ['lm-who__slot', it.active && 'is-active'],
      'aria-label': `${it.displayName || it.username}, @${it.username}. ${state}.${manage ? '' : ' Select to continue.'}`,
      'data-slot': String(index),
      disabled: manage,
      onClick: () => switchToIdentity(it, { next }),
    },
    h('span', { class: 'lm-who__art' }, avatar(it.avatar, { className: 'lm-avatar lm-who__avatar' }), it.active ? h('span', { class: 'lm-who__badge', 'aria-hidden': 'true' }, icon('check')) : null),
    h('span', { class: 'lm-who__name' }, it.displayName || it.username),
    h('span', { class: 'lm-who__user' }, `@${it.username}`),
    h('span', { class: ['lm-who__state', it.active && 'is-active'] }, !it.active && !it.remembered ? icon('lock') : null, state));
    const remove = manage ? button('Remove from this device', {
      variant: 'ghost',
      size: 'sm',
      icon: 'close',
      className: 'lm-who__remove',
      ariaLabel: `Remove ${it.username} from this device`,
      onClick: async () => {
        const ok = await confirmDialog({
          title: `Remove @${it.username} from this device?`,
          message: 'The identity disappears from “Who’s watching?” on this browser. The account, its list and its history are kept, and you can add it again by signing in.',
          confirmLabel: 'Remove',
          danger: true,
        });
        if (!ok) return;
        try {
          data = await api.identities.remove(it.id);
          if (it.active) await import('../core/session.js').then((m) => m.refreshSession());
          toast(`Removed @${it.username} from this device.`, { type: 'success' });
          draw();
        } catch (err) {
          toastError(err);
        }
      },
    }) : null;
    return h('li', { class: 'lm-who__cell' }, tile, remove);
  }

  function emptySlot(index) {
    const tile = h('button', {
      type: 'button',
      class: 'lm-who__slot lm-who__slot--empty',
      'data-slot': String(index),
      disabled: preview || manage,
      'aria-label': preview ? 'Empty slot. Accounts need the Lumina server.' : 'Empty slot. Add an identity: create an account or sign in.',
      onClick: () => addIdentityDialog({ taken: new Set(data.identities.map((x) => x.avatar)), next }),
    },
    h('span', { class: 'lm-who__art lm-who__art--empty' }, h('span', { class: 'lm-who__plus', 'aria-hidden': 'true' }, icon(preview ? 'lock' : 'plus'))),
    h('span', { class: 'lm-who__name' }, preview ? 'Unavailable' : 'Add identity'),
    h('span', { class: 'lm-who__user' }, 'Not set up'),
    h('span', { class: 'lm-who__state' }, preview ? 'Needs the Lumina server' : 'Create or sign in'));
    return h('li', { class: 'lm-who__cell' }, tile);
  }

  function draw() {
    const cells = data.identities.map((it, i) => slot(it, i));
    for (let i = data.identities.length; i < data.max; i++) cells.push(emptySlot(i));
    grid.replaceChildren(...cells);
    status.textContent = preview
      ? 'This copy of Lumina is running in Preview mode on static hosting. Separate accounts need the Lumina server; you can still browse and watch the open catalog.'
      : data.freeSlots === 0
        ? 'This device shows the maximum of five identities. To add another, choose Manage identities and remove one — the account and its data are kept.'
        : manage ? 'Removing an identity only takes it off this screen.' : '';
    manageBtn.hidden = preview || !data.identities.length;
  }

  manageBtn.addEventListener('click', () => {
    manage = !manage;
    manageBtn.replaceChildren(icon(manage ? 'check' : 'edit'), h('span', null, manage ? 'Done' : 'Manage identities'));
    manageBtn.classList.toggle('lm-btn--primary', manage);
    manageBtn.classList.toggle('lm-btn--glass', !manage);
    draw();
    grid.querySelector('button:not([disabled])')?.focus();
  });

  // Arrow keys move between slots (grid order), like a TV remote.
  grid.addEventListener('keydown', (e) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
    const tiles = [...grid.querySelectorAll('.lm-who__slot:not([disabled]), .lm-who__remove')];
    const i = tiles.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    const step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const target = e.key === 'Home' ? 0 : e.key === 'End' ? tiles.length - 1 : Math.max(0, Math.min(tiles.length - 1, i + step));
    tiles[target].focus();
  });

  draw();
  return h('main', { class: 'lm-who', id: 'main-who' },
    h('div', { class: 'lm-who__inner' },
      h('div', { class: 'lm-who__brand', 'aria-hidden': 'true' }, logoMark('lm-who__mark'), h('span', { class: 'lm-who__word' }, 'LUMINA')),
      h('h1', { class: 'lm-who__title' }, 'Who’s watching?'),
      h('p', { class: 'lm-who__lead' }, 'Each identity is its own Lumina account — its own username, password, list, history and settings.'),
      grid,
      status,
      h('div', { class: 'lm-who__actions' }, manageBtn, continueLink)));
}


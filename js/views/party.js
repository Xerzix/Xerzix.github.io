// Watch party (/party/:code). Immersive, server-only, profile required (see js/app.js).
// `/party/join` — or any code that is not a valid party code — shows the join-by-code form.
//
// Everyone in a party follows one shared timeline kept by the server: { playing, position,
// updatedAt, episodeId }. Changes arrive over Server-Sent Events. Each player extrapolates
// the party position with a server-clock offset and corrects drift larger than 1.5 s. The
// host is the reference clock: when its own playback drifts from the timeline (it was
// buffering, say), it re-publishes its real position so guests wait for it instead of
// running ahead. Guests only control playback when the host allows it.
import { h, newUid, announce } from '../core/dom.js';
import { api } from '../api/client.js';
import { session } from '../core/session.js';
import { clock, plural } from '../core/format.js';
import { button, linkButton, toggleSwitch, confirmDialog, spinner, toast, toastError } from '../ui/components.js';
import { icon } from '../ui/icons.js';
import { avatar } from '../ui/avatars.js';
import { LuminaPlayer } from '../player/player.js';
import { episodeLabel, partyPosition, needsResync } from '../player/helpers.js';

// Same alphabet as server/services/parties.js: no 0/O or 1/I/L.
const CODE_RE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/;
const CHAT_MAX = 500;
const CHAT_KEEP = 200;
const DRIFT_CHECK_MS = 4000;
const SEEK_SEND_MS = 250;
const RECONNECT_DELAYS = [1500, 3000, 6000, 12000, 20000];

const ENDED_REASONS = {
  host_ended: 'The host ended the watch party.',
  expired: 'The party was idle for four hours, so it closed.',
  empty: 'Everyone left, so the party closed.',
  shutdown: 'The Lumina server restarted. Watch parties do not survive a restart.',
  not_found: 'The party has ended, or the code is no longer valid.',
};

const normalizeCode = (value) => String(value || '').toUpperCase().replace(/[\s-]+/g, '');

export default async function render(ctx) {
  const root = h('div', { class: 'lm-party-view' });
  const code = normalizeCode(ctx.params.code);

  if (session.features?.watchParties === false) {
    root.append(disabledGate());
    return root;
  }
  if (!CODE_RE.test(code)) {
    root.append(joinGate(ctx, { invalid: code && code !== 'JOIN' ? ctx.params.code : null }));
    return root;
  }

  let party;
  try {
    ({ party } = await api.parties.get(code));
  } catch (err) {
    root.append(errorGate(ctx, err, code));
    return root;
  }
  if (ctx.signal.aborted) return root;

  let detail = null;
  try {
    detail = await api.catalog.title(party.titleId);
  } catch (err) {
    if (err?.code === 'PROFILE_RESTRICTED' || err?.status === 403) {
      root.append(gate({
        eyebrow: `Watch party · ${party.code}`,
        title: 'This party is not available on this profile',
        message: err.message || 'The title is outside the maturity setting for this profile.',
        actions: [linkButton('Switch profile', `#/profiles?next=${encodeURIComponent(`/party/${party.code}`)}`, { variant: 'primary', icon: 'users' }), linkButton('Back to browsing', '#/', { variant: 'ghost' })],
      }));
      return root;
    }
    // The room itself works without artwork; the player loads the title on its own.
  }
  if (ctx.signal.aborted) return root;

  const enter = (p, { focus = false } = {}) => {
    const roomEl = mountRoom(ctx, root, p, detail);
    root.replaceChildren(roomEl);
    if (focus) {
      // Land screen-reader and keyboard users on the player's heading after joining.
      const heading = roomEl.querySelector('h1');
      heading?.setAttribute('tabindex', '-1');
      heading?.focus({ preventScroll: true });
    }
  };
  if (party.you?.isMember) enter(party);
  else root.append(inviteGate(ctx, party, detail, enter));
  return root;
}

// ───────────────────────────── Gates (join, ended, errors) ─────────────────────────────
function gate({ eyebrow = 'Watch party', title, message, art, extra = [], actions = [], role }) {
  const headingId = newUid('pg');
  return h('section', { class: 'lm-party-gate', 'aria-labelledby': headingId, role },
    art ? h('div', { class: 'lm-party-gate__bg', 'aria-hidden': 'true' }, h('img', { src: art, alt: '', decoding: 'async' })) : null,
    h('div', { class: 'lm-party-gate__card' },
      h('span', { class: 'lm-party-gate__mark', 'aria-hidden': 'true' }, icon('users')),
      h('span', { class: 'lm-eyebrow' }, eyebrow),
      h('h1', { id: headingId, tabindex: '-1' }, title),
      message ? h('p', null, message) : null,
      ...extra,
      actions.length ? h('div', { class: 'lm-party-gate__actions' }, ...actions) : null));
}

function focusHeading(el) {
  requestAnimationFrame(() => el.querySelector('h1')?.focus({ preventScroll: true }));
}

function disabledGate() {
  return gate({
    title: 'Watch parties are turned off',
    message: 'The administrator of this Lumina server has switched watch parties off. Everything else keeps working.',
    actions: [linkButton('Back to browsing', '#/', { variant: 'primary', icon: 'home' })],
  });
}

/** Join-by-code form, also shown when a code is invalid or a party has ended. */
function joinForm(ctx, { autofocus = true } = {}) {
  const id = newUid('pc');
  const input = h('input', {
    id,
    class: 'lm-input lm-party-gate__code-input',
    name: 'code',
    type: 'text',
    inputmode: 'text',
    autocomplete: 'off',
    autocapitalize: 'characters',
    spellcheck: 'false',
    maxlength: '9',
    placeholder: 'ABC234',
    required: true,
    'aria-describedby': `${id}-hint ${id}-err`,
  });
  const err = h('span', { class: 'lm-error-text', id: `${id}-err`, hidden: true });
  const form = h('form', { class: 'lm-party-gate__form', novalidate: true },
    h('label', { class: 'lm-label', for: id }, 'Party code'),
    h('div', { class: 'lm-party-gate__code-row' }, input, button('Join', { variant: 'primary', type: 'submit', icon: 'arrowRight' })),
    h('span', { class: 'lm-hint', id: `${id}-hint` }, 'Six characters from your host’s invite: letters and the digits 2–9.'),
    err);
  input.addEventListener('input', () => {
    const v = input.value.toUpperCase();
    if (v !== input.value) input.value = v;
    err.hidden = true;
    input.removeAttribute('aria-invalid');
  });
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = normalizeCode(input.value);
    if (!CODE_RE.test(code)) {
      err.textContent = code.length !== 6
        ? 'Party codes have six characters.'
        : 'That is not a valid code. Codes never contain 0, 1, I, L or O.';
      err.hidden = false;
      input.setAttribute('aria-invalid', 'true');
      input.focus();
      return;
    }
    ctx.navigate(`/party/${code}`);
  });
  if (autofocus) requestAnimationFrame(() => input.focus({ preventScroll: true }));
  return form;
}

function joinGate(ctx, { invalid } = {}) {
  return gate({
    title: 'Join a watch party',
    message: invalid
      ? `“${String(invalid).slice(0, 24)}” is not a valid party code. Check the invite and try again.`
      : 'Watch together in sync and chat while you watch. Enter the code from your host’s invite.',
    extra: [joinForm(ctx)],
    actions: [linkButton('Back to browsing', '#/', { variant: 'ghost', icon: 'arrowLeft' })],
  });
}

function errorGate(ctx, err, code) {
  if (err?.code === 'FEATURE_DISABLED') return disabledGate();
  if (err?.status === 404) {
    return gate({
      eyebrow: `Watch party · ${code}`,
      title: 'This watch party is not running',
      message: ENDED_REASONS.not_found,
      extra: [joinForm(ctx, { autofocus: false })],
      actions: [linkButton('Back to browsing', '#/', { variant: 'ghost', icon: 'arrowLeft' })],
    });
  }
  return gate({
    eyebrow: `Watch party · ${code}`,
    title: 'The watch party could not be opened',
    message: err?.message || 'Please try again in a moment.',
    actions: [
      button('Try again', { variant: 'primary', icon: 'refresh', onClick: () => ctx.navigate(`/party/${code}`, { replace: true }) }),
      linkButton('Back to browsing', '#/', { variant: 'ghost' }),
    ],
  });
}

function inviteGate(ctx, party, detail, enter) {
  const titleName = detail?.title || 'a Lumina title';
  const ep = party.episodeId && detail?.seasons ? detail.seasons.flatMap((s) => s.episodes).find((e) => e.id === party.episodeId) : null;
  const status = h('p', { class: 'lm-party-gate__status', role: 'status' });
  const full = party.memberCount >= party.maxMembers;
  const join = button(full ? 'This party is full' : 'Join the party', { variant: 'primary', icon: 'play', disabled: full });
  const notNow = linkButton('Not now', `#/title/${encodeURIComponent(party.titleId)}`, { variant: 'ghost' });
  join.addEventListener('click', async () => {
    join.disabled = true;
    join.classList.add('is-busy');
    status.textContent = '';
    try {
      const res = await api.parties.join(party.code);
      enter(res.party, { focus: true });
    } catch (err) {
      join.disabled = err?.code === 'PARTY_FULL' || err?.status === 404;
      join.classList.remove('is-busy');
      status.textContent = err?.message || 'You could not join right now. Please try again.';
      if (err?.status === 404) ctx.navigate(`/party/${party.code}`, { replace: true });
    }
  });
  const el = gate({
    eyebrow: `Watch party · ${party.code}`,
    title: titleName,
    art: detail?.backdrop || detail?.poster || null,
    message: ep ? episodeLabel(ep) : null,
    extra: [
      party.host ? h('div', { class: 'lm-party-gate__host' }, avatar(party.host.avatar), h('span', null, 'Hosted by ', h('strong', null, party.host.name))) : null,
      h('p', { class: 'lm-party-gate__meta' }, `${party.memberCount} of ${party.maxMembers} watching${party.state?.playing ? ' · playing now' : ''}`),
      status,
    ],
    actions: [join, notNow],
  });
  requestAnimationFrame(() => (full ? notNow : join).focus({ preventScroll: true }));
  return el;
}

// ───────────────────────────── The room ─────────────────────────────
function mountRoom(ctx, root, initial, detailIn) {
  const code = initial.code;
  const titleId = initial.titleId;
  let detail = detailIn;
  let state = initial.state;
  let offset = clockOffset(state.serverTime);
  let you = initial.you || { isMember: true, isHost: false, canControl: false };
  let members = initial.members || [];
  let allowGuestControl = !!initial.allowGuestControl;
  let myName = members.find((m) => m.isYou)?.name || session.profile?.name || '';
  let membersSeen = false;
  let es = null;
  let ended = false;
  let leaving = false;
  let retry = 0;
  let retryTimer = null;
  let seekTimer = null;
  let pendingSeek = null;
  let targetEpisode; // episode the party timeline is on, as last requested (null for a movie)
  let shownEpisode; // episode whose media the player holds
  let mediaLoading = false;
  let mediaSeq = 0;
  let lastSent = null;
  let unread = 0;
  let panelOpen = true;
  const seenChat = new Set();

  const expected = () => partyPosition(state, Date.now(), offset);

  // ── Player ──
  const unreadBadge = h('span', { class: 'lm-party__unread', hidden: true, 'aria-hidden': 'true' });
  const panelId = newUid('ppanel');
  const panelToggle = h('button', {
    type: 'button',
    class: 'lm-btn lm-btn--glass lm-btn--sm lm-party__panel-toggle',
    'aria-controls': panelId,
    'aria-expanded': 'true',
    onClick: () => setPanel(!panelOpen, { focus: true }),
  }, icon('message'), h('span', { class: 'lm-party__panel-label' }, 'Party'), unreadBadge);

  const player = new LuminaPlayer({
    profile: session.profile,
    mode: api.mode,
    contained: true,
    extras: [panelToggle],
    fetchTitle: async () => (detail ??= await api.catalog.title(titleId)),
    onBack: () => leave(),
    onEpisodeRequest: (ep) => requestEpisode(ep),
    onMediaChange: (pb) => ctx.setTitle(`Watch party · ${pb.title?.title || 'Lumina'}`),
    onRetryLoad: () => loadMedia(state.episodeId || null),
    party: {
      canControl: () => !!you.canControl,
      isHost: () => !!you.isHost,
      isPlaying: () => !!state.playing,
      onControl: (action, position) => sendControl(action, position),
      resync: () => syncNow(),
    },
  });

  // ── Panel ──
  const status = h('p', { class: 'lm-party__status', role: 'status' });
  const conn = h('p', { class: 'lm-party__conn', role: 'status', hidden: true });
  const inviteUrl = `${location.origin}${location.pathname}#/party/${code}`;
  const inviteInput = h('input', { class: 'lm-input', type: 'text', value: inviteUrl, readOnly: true, 'aria-label': 'Invite link', onFocus: (e) => e.target.select() });
  const copyBtn = button('Copy', { variant: 'glass', size: 'sm', icon: 'copy', onClick: () => copyInvite() });
  const shareBtn = typeof navigator.share === 'function'
    ? button('', { variant: 'glass', size: 'sm', icon: 'share', ariaLabel: 'Share invite', attrs: { title: 'Share invite' }, onClick: () => shareInvite() })
    : null;
  const guestSwitch = toggleSwitch({ checked: allowGuestControl, label: 'Let guests control playback', onChange: (v) => setGuestControl(v) });
  const guestRow = h('div', { class: 'lm-party__toggle' }, h('span', { id: newUid('pgc') }, 'Let guests control playback'), guestSwitch);
  guestSwitch.setAttribute('aria-labelledby', guestRow.firstChild.id);
  guestSwitch.removeAttribute('aria-label');

  const membersTitle = h('h3', { class: 'lm-party__section-title' });
  const membersList = h('ul', { class: 'lm-party__members', role: 'list', 'aria-label': 'People in this party' });

  const chatTitleId = newUid('pchat');
  const log = h('ol', { class: 'lm-party__log', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-labelledby': chatTitleId });
  const emptyChat = h('li', { class: 'lm-party__msg lm-party__msg--system lm-party__empty' }, 'Say hello — messages are seen by everyone in the party.');
  log.append(emptyChat);
  const chatInput = h('input', {
    class: 'lm-input',
    type: 'text',
    name: 'text',
    maxlength: String(CHAT_MAX),
    autocomplete: 'off',
    placeholder: 'Message the party',
    'aria-label': 'Message',
    enterkeyhint: 'send',
  });
  const counter = h('p', { class: 'lm-party__count', 'aria-live': 'off' }, `0 / ${CHAT_MAX}`);
  const chatError = h('p', { class: 'lm-party__chat-error', role: 'alert', hidden: true });
  const sendBtn = button('', { variant: 'primary', icon: 'send', type: 'submit', ariaLabel: 'Send message', attrs: { title: 'Send' } });
  const chatForm = h('form', { class: 'lm-party__form', novalidate: true }, chatInput, sendBtn);
  chatInput.addEventListener('input', () => {
    const n = chatInput.value.length;
    counter.textContent = `${n} / ${CHAT_MAX}`;
    counter.classList.toggle('is-near', n > CHAT_MAX - 50);
    if (!chatError.hidden) chatError.hidden = true;
  });
  chatForm.addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat();
  });

  const footer = h('div', { class: 'lm-party__footer' });

  const panel = h('aside', { class: 'lm-party__panel', id: panelId, 'aria-label': 'Watch party' },
    h('div', { class: 'lm-party__head' },
      h('div', { class: 'lm-party__head-row' },
        h('h2', null, 'Watch party'),
        h('span', { class: 'lm-party__code', 'aria-label': `Party code ${code.split('').join(' ')}` }, code),
        h('button', { type: 'button', class: 'lm-icon-btn lm-party__close', 'aria-label': 'Hide party panel', onClick: () => setPanel(false, { focus: true }) }, icon('close'))),
      h('div', { class: 'lm-party__invite' }, inviteInput, copyBtn, shareBtn),
      h('div', { class: 'lm-party__controls' }, status, conn, guestRow)),
    membersTitle,
    membersList,
    h('section', { class: 'lm-party__chat', 'aria-labelledby': chatTitleId },
      h('h3', { class: 'lm-party__section-title', id: chatTitleId }, 'Chat'),
      log,
      chatError,
      counter,
      chatForm),
    footer);

  const stage = h('div', { class: 'lm-party__stage' }, player.el);
  const roomEl = h('div', { class: 'lm-party', dataset: { panel: 'open' } }, stage, panel);

  // ── Rendering ──
  function setPanel(open, { focus = false } = {}) {
    panelOpen = open;
    roomEl.dataset.panel = open ? 'open' : 'closed';
    panelToggle.setAttribute('aria-expanded', String(open));
    panelToggle.setAttribute('aria-label', open ? 'Hide party panel' : `Show party panel${unread ? `, ${unread} unread ${plural(unread, 'message')}` : ''}`);
    if (open) {
      unread = 0;
      paintUnread();
      scrollLog(true);
    }
    if (focus) (open ? chatInput : panelToggle).focus({ preventScroll: true });
  }

  function paintUnread() {
    unreadBadge.hidden = !unread;
    unreadBadge.textContent = unread > 9 ? '9+' : String(unread);
    if (!panelOpen) panelToggle.setAttribute('aria-label', `Show party panel${unread ? `, ${unread} unread ${plural(unread, 'message')}` : ''}`);
  }

  function renderControls() {
    const others = members.filter((m) => !m.isYou).length;
    let text;
    if (you.isHost) text = allowGuestControl ? 'You are the host. Everyone can control playback.' : 'You are the host and control playback.';
    else if (you.canControl) text = 'The host lets everyone control playback.';
    else text = 'The host controls playback. Your player follows along.';
    status.replaceChildren(icon(you.canControl ? 'play' : 'users'), h('span', null, text));
    guestRow.hidden = !you.isHost;
    guestSwitch.setChecked(allowGuestControl);
    const leaveBtn = button(you.isHost && others ? 'Leave' : 'Leave party', { variant: 'glass', icon: 'logout', onClick: () => leave() });
    const endBtn = you.isHost ? button('End party', { variant: 'danger', icon: 'close', onClick: () => endParty() }) : null;
    footer.replaceChildren(...[leaveBtn, endBtn].filter(Boolean));
  }

  function renderMembers() {
    const online = members.filter((m) => m.online).length;
    membersTitle.textContent = `In the room · ${members.length}`;
    membersTitle.setAttribute('aria-label', `${plural(members.length, 'person', 'people')} in the room, ${online} online`);
    membersList.replaceChildren(...members.map((m) => {
      const bits = [m.isHost ? 'host' : null, m.isYou ? 'you' : null, m.online ? null : 'away'].filter(Boolean);
      return h('li', { class: ['lm-party__member', !m.online && 'is-offline', m.isYou && 'is-you'], title: bits.length ? `${m.name} (${bits.join(', ')})` : m.name },
        h('span', { class: 'lm-party__presence' }, avatar(m.avatar), h('span', { class: ['lm-party__dot', m.online && 'is-online'], 'aria-hidden': 'true' })),
        h('span', { class: 'lm-party__member-name' }, m.name, m.isYou ? h('span', { class: 'lm-party__you' }, ' (you)') : null),
        m.isHost ? h('span', { class: 'lm-badge lm-badge--accent' }, 'Host') : null,
        h('span', { class: 'visually-hidden' }, m.online ? ', online' : ', away'));
    }));
  }

  function scrollLog(force = false) {
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    if (force || nearBottom) log.scrollTop = log.scrollHeight;
  }

  function addChat(msg) {
    if (!msg || seenChat.has(msg.id)) return;
    seenChat.add(msg.id);
    emptyChat.remove();
    const time = new Date(msg.at);
    const when = Number.isFinite(time.getTime()) ? time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    let li;
    if (msg.system) {
      li = h('li', { class: 'lm-party__msg lm-party__msg--system' }, h('span', null, msg.text));
    } else {
      li = h('li', { class: ['lm-party__msg', msg.mine && 'is-mine'] },
        avatar(msg.author?.avatar),
        h('div', { class: 'lm-party__msg-body' },
          h('p', { class: 'lm-party__msg-author' },
            h('span', null, msg.mine ? 'You' : msg.author?.name || 'Guest'),
            msg.author?.isHost ? h('span', { class: 'lm-party__host-tag' }, 'Host') : null,
            when ? h('time', { datetime: msg.at }, when) : null),
          h('p', { class: 'lm-party__msg-text' }, msg.text)));
    }
    const stick = msg.mine || log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    log.append(li);
    while (log.children.length > CHAT_KEEP) log.firstElementChild.remove();
    if (stick) log.scrollTop = log.scrollHeight;
    if (!msg.history && !msg.mine && !msg.system) {
      const hiddenPanel = !panelOpen || player.isFullscreen();
      if (hiddenPanel) {
        player.notify(`${msg.author?.name || 'Guest'}: ${msg.text.length > 90 ? `${msg.text.slice(0, 89)}…` : msg.text}`, 'message', 4200);
        if (!panelOpen) {
          unread += 1;
          paintUnread();
        }
      }
    }
  }

  // ── Party timeline ──
  function applyState(next, { echo = false } = {}) {
    if (!next) return;
    state = next;
    if (next.serverTime) offset = clockOffset(next.serverTime);
    const ep = next.episodeId || null;
    if (targetEpisode !== undefined && ep !== targetEpisode) {
      if (next.by && !isMine(next)) player.notify(`${next.by} changed the episode`, 'layers', 3200);
      loadMedia(ep);
      return;
    }
    syncNow();
    if (!echo && next.action && next.by && !isMine(next)) {
      const label = {
        play: `${next.by} pressed play`,
        pause: `${next.by} paused`,
        seek: `${next.by} jumped to ${clock(next.position)}`,
      }[next.action];
      if (label) player.notify(label, next.action === 'pause' ? 'pause' : next.action === 'play' ? 'play' : 'history', 2400);
    }
  }

  function isMine(s) {
    return !!lastSent && s.by === myName && s.action === lastSent.action && Date.now() - lastSent.at < 4000;
  }

  /** True when the player holds the media the party is on and it has finished loading. */
  function inStep() {
    return !!player.playback && !mediaLoading && shownEpisode === (state.episodeId || null);
  }

  function syncNow() {
    if (inStep()) player.syncTo({ playing: !!state.playing, position: expected() });
  }

  async function loadMedia(episodeId) {
    const seq = ++mediaSeq;
    targetEpisode = episodeId || null;
    mediaLoading = true;
    try {
      const pb = await api.catalog.playback(titleId, { episodeId: episodeId || undefined });
      if (seq !== mediaSeq || ended) return;
      shownEpisode = targetEpisode;
      await player.load(pb, { startAt: expected(), exact: true, autoplay: !!state.playing });
      if (seq !== mediaSeq || ended) return;
      mediaLoading = false;
      syncNow();
    } catch (err) {
      if (seq !== mediaSeq || ended || err?.name === 'AbortError') return;
      mediaLoading = false;
      player.showError(err, { title: detail?.title || 'Watch party' });
    }
  }

  function sendControl(action, position, { quiet = false } = {}) {
    if (!you.canControl || ended) return;
    const pos = Number.isFinite(position) ? Math.max(0, Math.round(position * 1000) / 1000) : expected();
    // Move the local copy of the timeline at once, so drift checks do not undo the change
    // while the request travels.
    state = {
      ...state,
      playing: action === 'play' ? true : action === 'pause' ? false : state.playing,
      position: pos,
      updatedAt: new Date(Date.now() + offset).toISOString(),
    };
    if (action === 'seek') {
      // Scrubbing and held arrow keys produce bursts: send only the last position.
      pendingSeek = pos;
      if (seekTimer) return;
      seekTimer = setTimeout(() => {
        seekTimer = null;
        const p = pendingSeek;
        pendingSeek = null;
        post('seek', p, quiet);
      }, SEEK_SEND_MS);
      return;
    }
    post(action, pos, quiet);
  }

  function post(action, position, quiet) {
    lastSent = { action, at: Date.now() };
    api.parties.control(code, { action, position }).then((res) => {
      if (res?.state && !ended) applyState({ ...res.state, action, by: myName }, { echo: true });
    }).catch((err) => {
      if (ended) return;
      if (!quiet) player.notify(err?.message || 'That change did not reach the party', 'alert', 4000);
      if (err?.code === 'CONTROL_NOT_ALLOWED' || err?.code === 'NOT_A_MEMBER') refreshParty();
    });
  }

  async function requestEpisode(ep) {
    if (!you.canControl) {
      player.notify('The host chooses episodes in this party', 'users');
      return;
    }
    try {
      lastSent = { action: 'episode', at: Date.now() };
      const res = await api.parties.control(code, { action: 'episode', episodeId: ep.id, position: 0 });
      if (res?.state && !ended) applyState({ ...res.state, action: 'episode', by: myName }, { echo: true });
    } catch (err) {
      player.notify(err?.message || 'That episode could not be started', 'alert', 4000);
    }
  }

  // The host is the reference clock; everyone else follows the timeline.
  const driftTimer = setInterval(() => {
    if (ended || player.errorShown || !inStep()) return;
    const v = player.video;
    if (you.isHost && you.canControl) {
      if (state.playing && !v.paused && !v.ended && !v.seeking && !seekTimer && needsResync(v.currentTime, expected())) {
        sendControl('seek', v.currentTime, { quiet: true });
      }
    } else {
      syncNow();
    }
  }, DRIFT_CHECK_MS);

  // ── Members & settings ──
  function applyMembers(m) {
    const wasHost = you.isHost;
    members = m.members || [];
    allowGuestControl = !!m.allowGuestControl;
    you = m.you || you;
    myName = members.find((x) => x.isYou)?.name || myName;
    if (membersSeen && !wasHost && you.isHost) {
      player.notify('You are now the host', 'users', 4000);
      announce('You are now the host of this watch party.');
    }
    membersSeen = true;
    renderMembers();
    renderControls();
    player.applyPartyLock();
  }

  async function setGuestControl(value) {
    guestSwitch.disabled = true;
    try {
      const path = `/api/parties/${encodeURIComponent(code)}`;
      const res = api.parties.update ? await api.parties.update(code, { allowGuestControl: value }) : await api.request('PATCH', path, { body: { allowGuestControl: value } });
      if (res?.party) applyMembers({ members: res.party.members, allowGuestControl: res.party.allowGuestControl, you: res.party.you });
    } catch (err) {
      guestSwitch.setChecked(allowGuestControl);
      toastError(err);
    } finally {
      guestSwitch.disabled = false;
    }
  }

  async function refreshParty() {
    try {
      const { party } = await api.parties.get(code);
      if (!party.you?.isMember) {
        const res = await api.parties.join(code);
        applyMembers({ members: res.party.members, allowGuestControl: res.party.allowGuestControl, you: res.party.you });
        player.notify('You rejoined the party', 'users');
      } else {
        applyMembers({ members: party.members, allowGuestControl: party.allowGuestControl, you: party.you });
      }
      return true;
    } catch (err) {
      if (err?.status === 404) end('not_found');
      else if (err?.code === 'FEATURE_DISABLED') end('disabled');
      return false;
    }
  }

  // ── Chat ──
  async function sendChat() {
    const text = chatInput.value.trim();
    if (!text) {
      chatInput.focus();
      return;
    }
    sendBtn.disabled = true;
    try {
      const { message } = await api.parties.chat(code, text);
      addChat(message);
      chatInput.value = '';
      chatInput.dispatchEvent(new Event('input'));
    } catch (err) {
      chatError.textContent = err?.retryAfter
        ? `${err.message} (${plural(err.retryAfter, 'second')})`
        : err?.message || 'Your message was not sent.';
      chatError.hidden = false;
      if (err?.code === 'NOT_A_MEMBER') refreshParty();
    } finally {
      sendBtn.disabled = false;
      chatInput.focus();
    }
  }

  // ── Invite ──
  async function copyInvite() {
    let ok = false;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      ok = true;
    } catch {
      inviteInput.focus();
      inviteInput.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
    }
    if (ok) {
      copyBtn.querySelector('span').textContent = 'Copied';
      setTimeout(() => { copyBtn.querySelector('span').textContent = 'Copy'; }, 2000);
      player.notify('Invite link copied', 'copy');
    } else {
      player.notify('Select the link and copy it to invite people', 'info', 4000);
    }
  }

  async function shareInvite() {
    try {
      await navigator.share({ title: 'Lumina watch party', text: `Join my watch party on Lumina (code ${code})`, url: inviteUrl });
    } catch (err) {
      if (err?.name !== 'AbortError') copyInvite();
    }
  }

  // ── Leaving & the end ──
  async function leave() {
    if (ended || leaving) return;
    const others = members.filter((m) => !m.isYou);
    if (you.isHost && others.length) {
      const ok = await confirmDialog({
        title: 'Leave the watch party?',
        message: `The party keeps going and ${others[0].name} becomes the host. You can come back with the code while it is running.`,
        confirmLabel: 'Leave',
      });
      if (!ok) return;
    }
    leaving = true;
    try {
      await api.parties.leave(code);
    } catch {
      /* the server forgets absent members on its own after a short grace period */
    }
    shutdown();
    ctx.navigate(`/title/${encodeURIComponent(titleId)}`);
  }

  async function endParty() {
    const ok = await confirmDialog({
      title: 'End the watch party for everyone?',
      message: 'Everyone’s player stops following the party and the chat closes. They can keep watching on their own.',
      confirmLabel: 'End party',
      danger: true,
    });
    if (!ok) return;
    leaving = true;
    try {
      await api.parties.end(code);
      shutdown();
      toast('The watch party has ended.', { type: 'success' });
      ctx.navigate(`/title/${encodeURIComponent(titleId)}`);
    } catch (err) {
      leaving = false;
      toastError(err);
    }
  }

  function shutdown() {
    ended = true;
    es?.close();
    es = null;
    clearInterval(driftTimer);
    clearTimeout(retryTimer);
    clearTimeout(seekTimer);
  }

  function end(reason) {
    if (ended) return;
    const at = player.video?.currentTime || 0;
    const episodeId = targetEpisode || null;
    shutdown();
    if (leaving) return;
    player.destroy();
    const watchHref = `#/watch/${encodeURIComponent(titleId)}?${new URLSearchParams({ ...(episodeId ? { episode: episodeId } : {}), ...(at > 1 ? { t: String(Math.floor(at)) } : {}) })}`;
    const el = reason === 'disabled'
      ? disabledGate()
      : gate({
        title: 'This watch party has ended',
        message: ENDED_REASONS[reason] || ENDED_REASONS.not_found,
        art: detail?.backdrop || null,
        actions: [
          linkButton('Keep watching on your own', watchHref, { variant: 'primary', icon: 'play' }),
          linkButton('Back to title', `#/title/${encodeURIComponent(titleId)}`, { variant: 'glass' }),
          linkButton('Join another party', '#/party/join', { variant: 'ghost', icon: 'users' }),
        ],
      });
    root.replaceChildren(el);
    focusHeading(el);
    announce('The watch party has ended.');
  }

  // ── Events (Server-Sent Events) ──
  function setConn(text) {
    conn.hidden = !text;
    conn.replaceChildren(...(text ? [spinner('Reconnecting'), h('span', null, text)] : []));
  }

  function connect() {
    if (ended) return;
    es?.close();
    const source = new EventSource(api.parties.eventsUrl(code));
    es = source;
    const parse = (fn) => (e) => {
      if (source !== es) return;
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      fn(data);
    };
    source.addEventListener('open', () => {
      retry = 0;
      setConn(null);
    });
    source.addEventListener('state', parse((s) => applyState(s)));
    source.addEventListener('members', parse((m) => applyMembers(m)));
    source.addEventListener('chat', parse((m) => addChat(m)));
    source.addEventListener('ended', parse((d) => end(d.reason)));
    source.addEventListener('error', () => {
      if (source !== es || ended || leaving) return;
      if (source.readyState === EventSource.CLOSED) {
        // The server refused the stream (party gone, membership lost): find out why.
        setConn('Reconnecting to the party…');
        recover();
      } else {
        setConn('Connection lost. Reconnecting…');
      }
    });
  }

  async function recover() {
    clearTimeout(retryTimer);
    const ok = await refreshParty();
    if (ended) return;
    if (ok) {
      connect();
      return;
    }
    const delay = RECONNECT_DELAYS[Math.min(retry, RECONNECT_DELAYS.length - 1)];
    retry += 1;
    setConn(`Connection lost. Trying again in ${Math.round(delay / 1000)} s…`);
    retryTimer = setTimeout(recover, delay);
  }

  // ── Start ──
  ctx.onDestroy(() => {
    shutdown();
    player.destroy();
  });
  // Leaving the page without "Leave": the stream closes and the server marks this member
  // away, then removes them after a grace period (a reload within it keeps the seat).

  setPanel(true);
  renderMembers();
  renderControls();
  connect();
  loadMedia(state.episodeId || null);
  return roomEl;
}

function clockOffset(serverTime) {
  const t = Date.parse(serverTime);
  return Number.isFinite(t) ? t - Date.now() : 0;
}

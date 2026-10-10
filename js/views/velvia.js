// Velvia Suggestions (/velvia): a film concierge grounded in the Lumina catalog.
//   ?q=<text>    asks that question straight away
//   ?title=<id>  asks about a specific title (context), e.g. from a title page
// The conversation belongs to the active profile and is kept in sessionStorage so follow-ups
// continue across navigation; the last 12 turns are sent with each question.
import { artImg } from '../ui/artwork.js';
import { h, newUid, announce, prefersReducedMotion } from '../core/dom.js';
import { api, ServerRequiredError } from '../api/client.js';
import { session } from '../core/session.js';
import { icon } from '../ui/icons.js';
import { button, notice, stars, toggleSwitch } from '../ui/components.js';
import { listButton, qualityBadge, ageBadge, playHref } from '../ui/card.js';
import {
  conversation, profileKey, historyPreference, historyAllowedByProfile, setHistoryPreference, assistantTurn, apiMessages,
  errorMessage, velviaEmblem, lengthLabel, providerLabel, slimTitle,
} from '../ui/panels/velvia-panel.js';

const EXAMPLES = [
  'What should I watch tonight?',
  'Find me a psychological thriller',
  'I want a movie with a complicated storyline',
  'Recommend something similar to Interstellar',
  'Find a movie with excellent cinematography',
  'I want a relaxing movie with a beautiful soundtrack',
  'Recommend a series with several seasons',
  'Find a movie I can watch in 4K',
  'Recommend a movie under two hours',
  'Something for a family movie night',
];
const MAX_COMPARE = 3;

/** The badge already says "Closest option", so the reason starts after it. */
function cleanReason(reason) {
  const r = String(reason || '').replace(/^Closest option:\s*/i, '');
  return r.charAt(0).toUpperCase() + r.slice(1);
}

function greeting() {
  const hr = new Date().getHours();
  return hr < 5 ? 'Good evening' : hr < 12 ? 'Good morning' : hr < 18 ? 'Good afternoon' : 'Good evening';
}

export default async function render(ctx) {
  ctx.setTitle('Velvia Suggestions');
  const pid = profileKey();
  const state = conversation.load(pid);
  let busy = false;
  let useHistory = historyPreference(pid);
  let lastProvider = null;

  // ── Header ──
  const providerNote = h('span', { class: 'lm-velvia__provider-name' }, providerLabel('local'));
  const historySwitch = toggleSwitch({
    checked: useHistory,
    label: 'Use my viewing history',
    onChange: (on) => {
      useHistory = on;
      setHistoryPreference(on, pid);
      announce(on ? 'Velvia will use your viewing history for suggestions.' : 'Velvia will not use your viewing history.');
    },
  });
  const signedIn = !!session.profile;
  // The profile's privacy setting wins: when it keeps history out of recommendations, the
  // switch is off and can't be turned on here (the server would ignore it anyway).
  const blockedByProfile = signedIn && !historyAllowedByProfile();
  const hint = !signedIn
    ? 'Sign in to personalise'
    : blockedByProfile
      ? ['Turned off in ', h('a', { href: '#/settings/privacy' }, 'Settings › Privacy')]
      : 'Only for this profile, in this tab';
  if (!signedIn || blockedByProfile) historySwitch.disabled = true;
  historySwitch.setAttribute('aria-describedby', 'velvia-history-hint');
  const historyRow = h('div', { class: 'lm-velvia__history' },
    historySwitch,
    h('div', null,
      h('span', { class: 'lm-velvia__history-label', 'aria-hidden': 'true' }, 'Use my viewing history'),
      h('span', { class: 'lm-velvia__history-hint', id: 'velvia-history-hint' }, ...[hint].flat())));
  historyRow.querySelector('.lm-velvia__history-label').addEventListener('click', () => { if (!historySwitch.disabled) historySwitch.click(); });

  const newBtn = button('New conversation', { variant: 'ghost', size: 'sm', icon: 'refresh', onClick: () => resetConversation() });

  const header = h('header', { class: 'lm-velvia__head' },
    velviaEmblem('lg'),
    h('div', { class: 'lm-velvia__titles' },
      h('h1', { class: 'lm-velvia__name' }, 'Velvia'),
      h('p', { class: 'lm-velvia__sub' }, 'Suggestions from the Lumina catalog'),
      h('p', { class: 'lm-velvia__provider' }, icon('leaf'), h('span', null, 'Grounded in the Lumina catalog'), h('span', { class: 'lm-velvia__provider-sep', 'aria-hidden': 'true' }, '·'), providerNote)),
    h('div', { class: 'lm-velvia__controls' }, historyRow, newBtn));

  api.velvia.status().then((s) => {
    if (lastProvider) return;
    providerNote.textContent = providerLabel(s?.available ? s.provider : 'local');
  }).catch(() => {});

  // ── Transcript ──
  const live = h('p', { class: 'visually-hidden', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const log = h('ol', { class: 'lm-velvia__log', 'aria-label': 'Conversation with Velvia' });
  const contextBar = h('div', { class: 'lm-velvia__context', hidden: true });

  function velviaMessage(...children) {
    return h('li', { class: 'lm-vmsg lm-vmsg--velvia' },
      h('div', { class: 'lm-vmsg__who' }, velviaEmblem('xs'), h('span', { class: 'lm-vmsg__name' }, 'Velvia')),
      h('div', { class: 'lm-vmsg__body' }, ...children));
  }

  function userMessage(text) {
    return h('li', { class: 'lm-vmsg lm-vmsg--user' },
      h('span', { class: 'visually-hidden' }, 'You: '),
      h('div', { class: 'lm-vmsg__bubble' }, text));
  }

  function chips(items, { label, quiet = false } = {}) {
    return h('div', { class: ['lm-velvia-chips', quiet && 'lm-velvia-chips--quiet'], role: 'group', 'aria-label': label },
      ...items.map((text) => h('button', { type: 'button', class: 'lm-chip lm-chip--velvia', onClick: () => send(text) }, text)));
  }

  function intro() {
    const name = session.profile?.name && session.profile.name !== 'Guest' ? `, ${session.profile.name}` : '';
    return velviaMessage(
      h('p', { class: 'lm-vmsg__text' }, `${greeting()}${name}. I’m Velvia, your concierge in the Lumina gardens. Tell me the mood you’re in, a film you loved or how much time you have, and I’ll suggest titles from the Lumina catalog — only titles that are really here.`),
      h('p', { class: 'lm-vmsg__hint' }, 'You might ask:'),
      chips(EXAMPLES, { label: 'Example questions' }));
  }

  // ── Recommendation cards ──
  const compareButtons = new Map();
  function paintCompareButtons() {
    for (const [id, btns] of compareButtons) {
      const on = state.compare.some((x) => x.id === id);
      for (const b of btns) {
        if (!b.isConnected) continue;
        b.setAttribute('aria-pressed', String(on));
        b.querySelector('span').textContent = on ? 'In compare' : 'Compare';
      }
    }
  }

  function recCard(rec) {
    const t = rec.title;
    const href = `#/title/${encodeURIComponent(t.id)}`;
    const cmp = button('Compare', { variant: 'ghost', size: 'sm', icon: 'columns', ariaLabel: `Compare ${t.title}`, attrs: { 'aria-pressed': 'false' }, onClick: () => toggleCompare(t) });
    if (!compareButtons.has(t.id)) compareButtons.set(t.id, []);
    compareButtons.get(t.id).push(cmp);
    const meta = h('div', { class: 'lm-vrec__meta' });
    const facts = [t.year, t.genres?.slice(0, 2).join(', '), lengthLabel(t)].filter(Boolean);
    facts.forEach((f) => meta.append(h('span', null, String(f))));
    meta.append(ageBadge(t));
    const q = qualityBadge(t);
    if (q) meta.append(q);
    if (t.memberRating?.count) meta.append(h('span', { class: 'lm-vrec__rating', title: `${t.memberRating.average} average from ${t.memberRating.count} member ratings` }, stars(t.memberRating.average), h('span', null, String(t.memberRating.average))));
    const tint = t.palette?.[0];
    return h('li', { class: 'lm-vrec', style: tint ? { '--vrec-tint': tint } : undefined },
      h('a', { class: 'lm-vrec__poster', href, tabindex: '-1', 'aria-hidden': 'true' },
        artImg({ src: t.poster, srcset: t.posterSrcset, sizes: '120px', title: t.title, kind: 'poster' })),
      h('div', { class: 'lm-vrec__body' },
        h('div', { class: 'lm-vrec__top' },
          h('h3', { class: 'lm-vrec__title' }, h('a', { href }, t.title)),
          rec.closest ? h('span', { class: 'lm-velvia-closest', title: 'Not an exact match for your request' }, 'Closest option') : null),
        meta,
        h('p', { class: 'lm-vrec__why' }, icon('sparkle'), h('span', null, h('span', { class: 'visually-hidden' }, 'Why: '), cleanReason(rec.reason)))),
      h('div', { class: 'lm-vrec__actions' },
        t.playable === false ? null : h('a', { class: 'lm-btn lm-btn--primary lm-btn--sm', href: playHref(t), 'aria-label': `Play ${t.title}` }, icon('play'), h('span', null, 'Play')),
        listButton(t, { size: 'sm', variant: 'glass', label: true }),
        h('a', { class: 'lm-btn lm-btn--ghost lm-btn--sm', href, 'aria-label': `Details for ${t.title}` }, icon('info'), h('span', null, 'Details')),
        button('Find similar', { variant: 'ghost', size: 'sm', icon: 'compass', ariaLabel: `Find similar to ${t.title}`, onClick: () => send(`More like ${t.title}`) }),
        cmp,
        button('Ask about this', { variant: 'ghost', size: 'sm', icon: 'message', ariaLabel: `Ask about this: ${t.title}`, onClick: () => { setContext(t); send(`Tell me about ${t.title}`); } })));
  }

  function comparisonTable(comparison, recs) {
    const byId = new Map(recs.map((r) => [r.titleId, r.title]));
    const cols = comparison.titleIds.map((id, i) => comparison.titles?.[i] || byId.get(id)?.title || id);
    const captionId = newUid('vcmp');
    return h('div', { class: 'lm-vcompare', role: 'region', 'aria-labelledby': captionId, tabindex: '0', style: { '--cols': cols.length } },
      h('table', null,
        h('caption', { id: captionId, class: 'visually-hidden' }, `Comparison of ${cols.join(', ')}`),
        h('thead', null, h('tr', null, h('td', null), ...cols.map((c) => h('th', { scope: 'col' }, c)))),
        h('tbody', null, ...comparison.rows.map((r) => h('tr', null, h('th', { scope: 'row' }, r.label), ...r.values.map((v) => h('td', null, v)))))));
  }

  function answerMessage(turn) {
    const recs = turn.recommendations || [];
    const parts = [];
    if (turn.fallback && turn.notice) parts.push(notice(turn.notice, { type: 'warn' }));
    parts.push(h('p', { class: 'lm-vmsg__text' }, turn.reply));
    if (turn.comparison?.rows?.length) parts.push(comparisonTable(turn.comparison, recs));
    if (recs.length) parts.push(h('ul', { class: 'lm-vrec-list', role: 'list', 'aria-label': 'Suggested titles' }, ...recs.map(recCard)));
    if (turn.clarifyingQuestion) parts.push(h('p', { class: 'lm-vmsg__question' }, turn.clarifyingQuestion));
    if (turn.suggestions?.length) parts.push(chips(turn.suggestions, { label: turn.clarifyingQuestion ? 'Possible answers' : 'Follow-up questions', quiet: !turn.clarifyingQuestion }));
    return velviaMessage(...parts);
  }

  function errorItem(err, retry) {
    return velviaMessage(notice(errorMessage(err), { type: 'danger' }), h('div', { class: 'lm-cluster lm-cluster--sm' }, button('Try again', { variant: 'glass', size: 'sm', icon: 'refresh', onClick: retry })));
  }

  function renderTranscript() {
    compareButtons.clear();
    log.replaceChildren(intro(), ...state.turns.map((t) => (t.role === 'user' ? userMessage(t.content) : answerMessage(t))));
    paintCompareButtons();
  }

  // ── Context ("Asking about …") ──
  function setContext(t) {
    state.context = t ? { titleId: t.id, name: t.title } : null;
    conversation.save(state, pid);
    paintContext();
  }
  function paintContext() {
    if (!state.context) {
      contextBar.hidden = true;
      contextBar.replaceChildren();
      return;
    }
    contextBar.hidden = false;
    contextBar.replaceChildren(
      icon('film'),
      h('span', null, 'Asking about ', h('strong', null, state.context.name)),
      h('button', { type: 'button', class: 'lm-icon-btn lm-velvia__context-clear', 'aria-label': `Stop asking about ${state.context.name}`, onClick: () => { setContext(null); announce('Context cleared.'); textarea.focus(); } }, icon('close', { size: 16 })));
  }

  // ── Compare tray ──
  const tray = h('div', { class: 'lm-velvia__tray', hidden: true, role: 'region', 'aria-label': 'Titles to compare' });
  function toggleCompare(t) {
    const i = state.compare.findIndex((x) => x.id === t.id);
    if (i >= 0) state.compare.splice(i, 1);
    else {
      if (state.compare.length >= MAX_COMPARE) {
        announce(`You can compare up to ${MAX_COMPARE} titles. Remove one first.`);
        paintTray(true);
        return;
      }
      state.compare.push({ id: t.id, title: t.title, poster: t.poster });
    }
    conversation.save(state, pid);
    paintTray();
    paintCompareButtons();
    announce(i >= 0 ? `Removed ${t.title} from compare.` : `Added ${t.title} to compare (${state.compare.length} of ${MAX_COMPARE}).`);
  }
  function paintTray(full = false) {
    const items = state.compare;
    tray.hidden = !items.length;
    tray.classList.toggle('is-full', full);
    if (!items.length) return tray.replaceChildren();
    const ids = items.map((x) => encodeURIComponent(x.id)).join(',');
    tray.replaceChildren(
      h('span', { class: 'lm-velvia__tray-label' }, icon('columns'), `Compare ${items.length}/${MAX_COMPARE}`),
      h('ul', { class: 'lm-velvia__tray-items', role: 'list' }, ...items.map((x) => h('li', null,
        h('span', { class: 'lm-velvia__tray-item' }, x.title,
          h('button', { type: 'button', class: 'lm-velvia__tray-remove', 'aria-label': `Remove ${x.title} from compare`, onClick: () => toggleCompare(x) }, icon('close', { size: 14 })))))),
      h('div', { class: 'lm-velvia__tray-actions' },
        items.length >= 2 ? button('Ask Velvia', { variant: 'glass', size: 'sm', icon: 'sparkle', onClick: () => send(`Compare ${items.map((x) => x.title).join(items.length === 2 ? ' and ' : ', ')}`, { compareIds: items.map((x) => x.id) }) }) : null,
        h('a', { class: ['lm-btn', 'lm-btn--primary', 'lm-btn--sm', items.length < 2 && 'is-disabled'], href: `#/compare?ids=${ids}`, 'aria-disabled': items.length < 2 ? 'true' : undefined, onClick: (e) => { if (items.length < 2) { e.preventDefault(); announce('Add at least two titles to compare.'); } } }, h('span', null, 'Compare side by side'), icon('arrowRight'))));
  }

  // ── Composer ──
  const inputId = newUid('velvia-input');
  const textarea = h('textarea', { id: inputId, class: 'lm-velvia__input', rows: 1, maxlength: 2000, placeholder: 'Ask for a mood, a title you loved, or how much time you have…', autocomplete: 'off', enterkeyhint: 'send' });
  const sendBtn = h('button', { type: 'submit', class: 'lm-btn lm-btn--primary lm-btn--icon lm-velvia__send', 'aria-label': 'Send to Velvia' }, icon('send'));
  const grow = () => {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  };
  textarea.addEventListener('input', grow);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      form.requestSubmit();
    }
  });
  const form = h('form', { class: 'lm-velvia__composer', onSubmit: (e) => { e.preventDefault(); send(textarea.value); } },
    h('label', { class: 'visually-hidden', for: inputId }, 'Message Velvia'),
    textarea,
    sendBtn);
  // The context pill sits with the composer, so what Velvia is being asked about stays in view.
  const dock = h('div', { class: 'lm-velvia__dock' }, contextBar, tray, form);
  const fine = h('p', { class: 'lm-velvia__fine' }, 'Velvia only suggests titles in the Lumina catalog. Your conversation stays in this browser tab.');

  function scrollToLatest(node, block = 'nearest') {
    node?.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block });
  }

  async function send(text, { compareIds } = {}) {
    const content = String(text || '').trim().slice(0, 2000);
    if (!content || busy) return;
    busy = true;
    sendBtn.disabled = true;
    sendBtn.classList.add('is-busy');
    textarea.value = '';
    grow();
    state.turns.push({ role: 'user', content });
    conversation.save(state, pid);
    const mine = userMessage(content);
    log.append(mine);
    const typing = h('li', { class: 'lm-vmsg lm-vmsg--velvia lm-vmsg--typing' },
      h('div', { class: 'lm-vmsg__who' }, velviaEmblem('xs'), h('span', { class: 'lm-vmsg__name' }, 'Velvia')),
      h('div', { class: 'lm-vmsg__body' }, h('span', { class: 'lm-velvia-typing', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')), h('span', { class: 'lm-vmsg__hint' }, 'Looking through the catalog…')));
    log.append(typing);
    live.textContent = 'Velvia is looking through the catalog…';
    scrollToLatest(typing);
    try {
      const context = {};
      if (state.context?.titleId) context.titleId = state.context.titleId;
      if (compareIds?.length) context.compareIds = compareIds;
      const res = await api.velvia.chat({ messages: apiMessages(state.turns), context, options: { useHistory } }, { signal: ctx.signal });
      const turn = assistantTurn(res);
      state.turns.push(turn);
      conversation.save(state, pid);
      lastProvider = turn.provider;
      providerNote.textContent = providerLabel(turn.provider);
      const node = answerMessage(turn);
      typing.replaceWith(node);
      paintCompareButtons();
      const count = turn.recommendations.length;
      live.textContent = `Velvia: ${turn.reply}${turn.clarifyingQuestion ? ` ${turn.clarifyingQuestion}` : ''}${count ? ` ${count} title${count === 1 ? '' : 's'} suggested.` : ''}`;
      // Bring the question to the top so the answer reads from its start.
      scrollToLatest(mine, 'start');
    } catch (err) {
      // The question was not answered: take it back out of the stored conversation, so a
      // later visit doesn't show (or resend) a question without its answer.
      state.turns.pop();
      conversation.save(state, pid);
      if (err?.name === 'AbortError') return; // navigated away; the page is gone
      mine.remove();
      const item = errorItem(err, () => { item.remove(); send(content, { compareIds }); });
      typing.replaceWith(item);
      live.textContent = errorMessage(err);
      textarea.value = content;
      grow();
    } finally {
      busy = false;
      sendBtn.disabled = false;
      sendBtn.classList.remove('is-busy');
    }
  }

  function resetConversation() {
    state.turns = [];
    state.context = null;
    conversation.save(state, pid);
    renderTranscript();
    paintContext();
    lastProvider = null;
    announce('Started a new conversation with Velvia.');
    textarea.focus();
  }

  renderTranscript();
  paintContext();
  paintTray();

  const page = h('div', { class: 'lm-page lm-container lm-velvia' },
    header,
    h('div', { class: 'lm-velvia__layout' },
      h('section', { class: 'lm-velvia__chat', 'aria-label': 'Conversation' }, log, live, dock, fine)));

  // ?title=<id> sets the context; ?q=<text> asks straight away. Both are removed from the URL
  // so going back to this page does not ask again.
  const titleId = ctx.query.get('title');
  const q = ctx.query.get('q');
  if (titleId || q) history.replaceState(history.state, '', '#/velvia');
  if (titleId && state.context?.titleId !== titleId) {
    try {
      const t = await api.catalog.title(titleId);
      setContext(slimTitle(t));
    } catch (err) {
      if (!(err instanceof ServerRequiredError)) page.querySelector('.lm-velvia__chat').prepend(notice('That title isn’t available on this profile, so Velvia will answer without it.', { type: 'warn' }));
    }
  }
  // Runs once the router has attached the page (so the live region is in the document).
  if (q) setTimeout(() => send(q), 0);
  else if (state.turns.length) requestAnimationFrame(() => scrollToLatest([...log.querySelectorAll('.lm-vmsg--user')].pop(), 'start'));
  return page;
}

// Velvia on other pages: velviaPanel({ title }) for the title page and velviaCompare({ titles })
// for the compare page. Also the conversation helpers shared with the full Velvia page
// (js/views/velvia.js): the per-profile conversation kept in sessionStorage, the plain-text
// form of each turn sent back to the server, and the small building blocks both use.
import { h, newUid, announce } from '../../core/dom.js';
import { api, ApiError } from '../../api/client.js';
import { session } from '../../core/session.js';
import { bus } from '../../core/bus.js';
import { runtime as fmtRuntime } from '../../core/format.js';
import { icon } from '../icons.js';
import { notice, spinner } from '../components.js';

// ───────────────────────── Conversation state ─────────────────────────
const MAX_STORED_TURNS = 40;
export const MAX_SENT_TURNS = 12;

export const PROVIDER_LABELS = {
  local: 'Built-in catalog engine',
  anthropic: 'Anthropic Claude',
  'openai-compatible': 'OpenAI-compatible provider',
};
export const providerLabel = (name) => PROVIDER_LABELS[name] || PROVIDER_LABELS.local;

/** Conversations belong to the active profile and live only in this browser tab. */
export function profileKey() {
  return session.profile?.id || (session.isServer ? 'signed-out' : 'guest');
}

function readSession(key, fallback) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeSession(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable or full: the conversation simply isn't kept */
  }
}

export const conversation = {
  load(pid = profileKey()) {
    const v = readSession(`lumina.velvia.${pid}`, null);
    return {
      turns: Array.isArray(v?.turns) ? v.turns : [],
      context: v?.context && typeof v.context.titleId === 'string' ? v.context : null,
      compare: Array.isArray(v?.compare) ? v.compare.slice(0, 3) : [],
    };
  },
  save(state, pid = profileKey()) {
    writeSession(`lumina.velvia.${pid}`, { v: 1, turns: state.turns.slice(-MAX_STORED_TURNS), context: state.context || null, compare: (state.compare || []).slice(0, 3) });
  },
  clear(pid = profileKey()) {
    writeSession(`lumina.velvia.${pid}`, null);
  },
};

/** False when the profile's privacy setting keeps viewing history out of recommendations. */
export function historyAllowedByProfile() {
  return !!session.profile && session.profile.preferences?.privacy?.useHistoryForRecommendations !== false;
}

/**
 * Whether this profile's viewing history may shape answers: the per-tab choice, defaulting
 * to the profile setting. When the profile setting is off, history is never used (the server
 * ignores it too), so a choice stored in this tab doesn't count.
 */
export function historyPreference(pid = profileKey()) {
  if (!historyAllowedByProfile()) return false;
  const saved = readSession(`lumina.velvia.history.${pid}`, null);
  return typeof saved === 'boolean' ? saved : true;
}

export function setHistoryPreference(value, pid = profileKey()) {
  writeSession(`lumina.velvia.history.${pid}`, !!value);
}

/** The fields a recommendation card needs, so stored conversations stay small. */
export function slimTitle(t) {
  if (!t) return null;
  const pick = ['id', 'type', 'title', 'year', 'runtimeMin', 'seasonCount', 'episodeCount', 'genres', 'poster', 'backdrop', 'palette', 'quality', 'resolutions', 'hdr', 'ageRating', 'ratingSource', 'minAge', 'memberRating', 'playable'];
  const out = {};
  for (const k of pick) if (t[k] !== undefined) out[k] = t[k];
  return out;
}

/** Stores an API answer as an assistant turn. */
export function assistantTurn(res) {
  return {
    role: 'assistant',
    reply: String(res.reply || ''),
    clarifyingQuestion: res.clarifyingQuestion || '',
    suggestions: Array.isArray(res.suggestions) ? res.suggestions.slice(0, 4) : [],
    recommendations: (res.recommendations || []).map((r) => ({ titleId: r.titleId, reason: r.reason, closest: !!r.closest, title: slimTitle(r.title) })).filter((r) => r.title),
    comparison: res.comparison || null,
    provider: res.provider || 'local',
    fallback: !!res.fallback,
    notice: res.notice || '',
    intent: res.intent || '',
  };
}

/** Plain-text form of an assistant turn, as replayed to the server on the next request. */
export function assistantText(turn) {
  const names = (turn.recommendations || []).map((r) => r.title?.title).filter(Boolean);
  const tail = [turn.clarifyingQuestion, names.length ? `Suggested: ${names.join(' · ')}` : ''].filter(Boolean).join('\n');
  const room = 2000 - tail.length - 1;
  const reply = turn.reply.length > room ? `${turn.reply.slice(0, Math.max(0, room - 1))}…` : turn.reply;
  return [reply, tail].filter(Boolean).join('\n');
}

/** The last MAX_SENT_TURNS turns, as the API expects them. */
export function apiMessages(turns) {
  return turns
    .slice(-MAX_SENT_TURNS)
    .map((t) => (t.role === 'user' ? { role: 'user', content: String(t.content).slice(0, 2000) } : { role: 'assistant', content: assistantText(t) }))
    .filter((m) => m.content.trim());
}

/** A friendly message for a failed request (rate limits, offline, validation). */
export function errorMessage(err) {
  if (err instanceof ApiError && err.status === 429) {
    return `You’ve asked Velvia a lot in a short time. Please wait ${err.retryAfter ? `${err.retryAfter} seconds` : 'a moment'} and try again.`;
  }
  if (err instanceof ApiError && err.code === 'NETWORK') return 'Velvia couldn’t reach Lumina. Check your connection and try again.';
  if (err instanceof ApiError && err.status === 422) return 'That message couldn’t be sent. Try a shorter question.';
  return err?.message || 'Something went wrong. Please try again.';
}

// ───────────────────────── Building blocks ─────────────────────────
/** Velvia's emblem: a stone lantern with a sparkle, in a gold-ringed seal. Decorative. */
export function velviaEmblem(size = 'md') {
  return h('span', { class: ['lm-velvia-emblem', `lm-velvia-emblem--${size}`], 'aria-hidden': 'true' },
    icon('lantern', { className: 'lm-velvia-emblem__lantern' }),
    icon('sparkle', { className: 'lm-velvia-emblem__sparkle' }));
}

export function lengthLabel(t) {
  if (t.type === 'series') {
    if (t.seasonCount > 1) return `${t.seasonCount} seasons`;
    if (t.episodeCount) return `${t.episodeCount} episode${t.episodeCount === 1 ? '' : 's'}`;
    return 'Series';
  }
  return t.runtimeMin || t.runtimeMin === 0 ? fmtRuntime(t.runtimeMin) : '';
}

/** A compact recommendation: poster, title, reason (used by the panels). */
export function miniRec(rec) {
  const t = rec.title;
  const href = `#/title/${encodeURIComponent(t.id)}`;
  return h('li', { class: 'lm-vmini' },
    h('a', { class: 'lm-vmini__poster', href, tabindex: '-1', 'aria-hidden': 'true' }, t.poster ? h('img', { src: t.poster, alt: '', loading: 'lazy', decoding: 'async' }) : null),
    h('div', { class: 'lm-vmini__body' },
      h('a', { class: 'lm-vmini__title', href }, t.title),
      h('span', { class: 'lm-vmini__meta' }, [t.genres?.[0], lengthLabel(t), t.quality === '4K' ? '4K' : null].filter(Boolean).join(' · ')),
      rec.closest ? h('span', { class: 'lm-velvia-closest' }, 'Closest option') : null,
      h('span', { class: 'lm-vmini__why' }, String(rec.reason || '').replace(/^Closest option:\s*(.)/i, (m, c) => c.toUpperCase()))));
}

function answerBlock(res, { onChip, list = 'mini' } = {}) {
  const wrap = h('div', { class: 'lm-vpanel__reply' });
  if (res.fallback && res.notice) wrap.append(notice(res.notice, { type: 'warn' }));
  wrap.append(h('p', { class: 'lm-vpanel__text' }, res.reply));
  if (res.clarifyingQuestion) wrap.append(h('p', { class: 'lm-vpanel__question' }, res.clarifyingQuestion));
  const recs = (res.recommendations || []).filter((r) => r.title);
  if (recs.length) {
    const ol = h(list === 'ranked' ? 'ol' : 'ul', { class: ['lm-vmini-list', list === 'ranked' && 'lm-vmini-list--ranked'], role: 'list' }, ...recs.map(miniRec));
    wrap.append(ol);
  }
  if (onChip && res.suggestions?.length) {
    wrap.append(h('div', { class: 'lm-velvia-chips lm-velvia-chips--quiet', role: 'group', 'aria-label': 'Follow-up questions' },
      ...res.suggestions.map((s) => h('button', { type: 'button', class: 'lm-chip lm-chip--velvia', onClick: () => onChip(s) }, s))));
  }
  return wrap;
}

/**
 * One request from a panel. It is cancelled when the viewer leaves the page the panel is on,
 * so an answer about the previous title is never shown or announced on another page.
 */
function panelRequest(section) {
  const ctrl = new AbortController();
  const off = bus.on('route:changed', () => {
    if (!section.isConnected) ctrl.abort();
  });
  return {
    signal: ctrl.signal,
    /** False once the request was cancelled or the panel is no longer on screen. */
    live: () => !ctrl.signal.aborted && section.isConnected,
    done: off,
  };
}

function providerFoot(res) {
  return h('p', { class: 'lm-vpanel__provider' }, icon('leaf'), `Grounded in the Lumina catalog · ${providerLabel(res.provider)}`);
}

// ───────────────────────── Title page panel ─────────────────────────
const TITLE_CHIPS = [
  ['What’s it about?', (n) => `What’s ${n} about?`],
  ['Themes', (n) => `What are the themes of ${n}?`],
  ['Cast & crew', (n) => `Who are the cast and crew of ${n}?`],
  ['Pacing', (n) => `How is the pacing of ${n}?`],
  ['Cinematography', (n) => `Tell me about the cinematography of ${n}.`],
  ['Soundtrack', (n) => `Tell me about the soundtrack of ${n}.`],
  ['Is it right for kids?', (n) => `Is ${n} right for kids?`],
  ['What should I watch next?', (n) => `What should I watch after ${n}?`],
];

/** "Ask Velvia about <title>" section for the title page (section id "velvia"). */
export function velviaPanel({ title }) {
  if (!title?.id) return h('div', { hidden: true });
  const name = title.title;
  const headingId = newUid('velvia');
  const inputId = newUid('velvia-q');
  const thread = []; // this panel's own exchange, sent as context for follow-ups
  let busy = false;

  const answer = h('div', { class: 'lm-vpanel__answer', 'aria-busy': 'false' });
  const input = h('input', { id: inputId, class: 'lm-input lm-vpanel__input', type: 'text', maxlength: 2000, autocomplete: 'off', placeholder: `Ask anything about ${name}…` });
  const askBtn = h('button', { type: 'submit', class: 'lm-btn lm-btn--primary' }, icon('send'), h('span', null, 'Ask'));
  const continueLink = h('a', { class: 'lm-vpanel__continue', href: `#/velvia?title=${encodeURIComponent(title.id)}` }, 'Continue with Velvia', icon('arrowRight'));

  async function ask(question) {
    const q = String(question || '').trim();
    if (!q || busy) return;
    busy = true;
    askBtn.disabled = true;
    answer.setAttribute('aria-busy', 'true');
    answer.replaceChildren(h('div', { class: 'lm-vpanel__thinking' }, spinner('Velvia is reading the catalog'), h('span', null, 'Velvia is reading the catalog…')));
    thread.push({ role: 'user', content: q });
    const req = panelRequest(section);
    try {
      const res = await api.velvia.chat({
        messages: apiMessages(thread),
        context: { titleId: title.id },
        options: { useHistory: historyPreference() },
      }, { signal: req.signal });
      if (!req.live()) {
        thread.pop();
        return;
      }
      const turn = assistantTurn(res);
      thread.push(turn);
      // Keep the exchange so "Continue with Velvia" picks up where this left off.
      const state = conversation.load();
      state.turns.push({ role: 'user', content: q }, turn);
      state.context = { titleId: title.id, name };
      conversation.save(state);
      answer.replaceChildren(h('p', { class: 'lm-vpanel__asked' }, h('span', { class: 'visually-hidden' }, 'You asked: '), q), answerBlock(res, { onChip: ask }), providerFoot(res));
      announce(`Velvia: ${res.reply}`);
    } catch (err) {
      thread.pop();
      if (!req.live()) return;
      answer.replaceChildren(notice(errorMessage(err), { type: 'danger' }));
    } finally {
      req.done();
      busy = false;
      askBtn.disabled = false;
      answer.setAttribute('aria-busy', 'false');
    }
  }

  const form = h('form', { class: 'lm-vpanel__form', onSubmit: (e) => { e.preventDefault(); const q = input.value; input.value = ''; ask(q); } },
    h('label', { class: 'visually-hidden', for: inputId }, `Ask Velvia about ${name}`),
    input,
    askBtn);

  const section = h('section', { id: 'velvia', class: 'lm-vpanel', 'aria-labelledby': headingId },
    h('div', { class: 'lm-vpanel__head' },
      velviaEmblem('sm'),
      h('div', null,
        h('p', { class: 'lm-eyebrow' }, 'Velvia'),
        h('h2', { id: headingId, class: 'lm-vpanel__title' }, `Ask Velvia about ${name}`),
        h('p', { class: 'lm-vpanel__sub' }, 'Answers come only from what the Lumina catalog records about this title.'))),
    h('div', { class: 'lm-velvia-chips', role: 'group', 'aria-label': `Questions about ${name}` },
      ...TITLE_CHIPS.map(([label, text]) => h('button', { type: 'button', class: 'lm-chip lm-chip--velvia', onClick: () => ask(text(name)) }, label))),
    form,
    answer,
    continueLink);
  return section;
}

// ───────────────────────── Compare page panel ─────────────────────────
/** "A and B" / "A, B and C". */
function namesOf(titles) {
  const names = titles.map((t) => t.title);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names.join('');
}

/** "Ask Velvia to compare" section for the compare page. */
export function velviaCompare({ titles }) {
  const list = (Array.isArray(titles) ? titles : []).filter((t) => t?.id).slice(0, 3);
  const headingId = newUid('velvia-cmp');
  const inputId = newUid('velvia-pref');
  const answer = h('div', { class: 'lm-vpanel__answer', 'aria-busy': 'false' });
  const input = h('input', { id: inputId, class: 'lm-input lm-vpanel__input', type: 'text', maxlength: 2000, autocomplete: 'off', placeholder: 'I prefer shorter, visually striking films' });
  const enough = list.length >= 2;
  const askBtn = h('button', { type: 'submit', class: 'lm-btn lm-btn--primary', disabled: !enough }, icon('sparkle'), h('span', null, 'Ask Velvia to compare'));
  let busy = false;

  async function compare() {
    if (busy || !enough) return;
    busy = true;
    askBtn.disabled = true;
    answer.setAttribute('aria-busy', 'true');
    answer.replaceChildren(h('div', { class: 'lm-vpanel__thinking' }, spinner('Velvia is comparing'), h('span', null, 'Velvia is comparing the catalog details…')));
    const pref = input.value.trim();
    const content = pref || `Compare ${namesOf(list)}.`;
    const req = panelRequest(section);
    try {
      const res = await api.velvia.chat({
        messages: [{ role: 'user', content }],
        context: { compareIds: list.map((t) => t.id) },
        options: { useHistory: historyPreference() },
      }, { signal: req.signal });
      if (!req.live()) return;
      answer.replaceChildren(answerBlock(res, { list: 'ranked' }), providerFoot(res));
      announce(`Velvia: ${res.reply}`);
    } catch (err) {
      if (!req.live()) return;
      answer.replaceChildren(notice(errorMessage(err), { type: 'danger' }));
    } finally {
      req.done();
      busy = false;
      askBtn.disabled = !enough;
      answer.setAttribute('aria-busy', 'false');
    }
  }

  const section = h('section', { class: 'lm-vpanel lm-vpanel--compare', 'aria-labelledby': headingId },
    h('div', { class: 'lm-vpanel__head' },
      velviaEmblem('sm'),
      h('div', null,
        h('p', { class: 'lm-eyebrow' }, 'Velvia'),
        h('h2', { id: headingId, class: 'lm-vpanel__title' }, 'Ask Velvia to compare'),
        h('p', { class: 'lm-vpanel__sub' }, enough
          ? `Tell Velvia what you enjoy and it will choose between ${namesOf(list)} using their catalog details.`
          : 'Add at least two titles, then tell Velvia what you enjoy and it will choose between them.'))),
    h('form', { class: 'lm-vpanel__form', onSubmit: (e) => { e.preventDefault(); compare(); } },
      h('label', { class: 'lm-label', for: inputId }, 'What do you prefer?'),
      h('div', { class: 'lm-vpanel__row' }, input, askBtn)),
    answer);
  return section;
}

// Velvia orchestrator. Every answer is grounded in the catalog the profile may see:
//
//   1. The built-in catalog engine (js/core/velvia-engine.js) reads the conversation and ranks
//      the catalog. With VELVIA_PROVIDER=local its answer is returned as is.
//   2. Otherwise the engine's best matches (plus context, compare and editorial titles, at
//      most 30) become the only cards a conversational provider sees. Its answer is checked:
//      ids that are not among those cards are dropped, and anything unusable (error, timeout,
//      refusal, truncated or malformed JSON, nothing grounded, a title named that the profile
//      may not see) falls back to the engine with a notice. Conversations are never stored; provider failures are logged without content.
import { parseJson } from '../../db/index.js';
import { log } from '../../lib/log.js';
import { analyze, composeResponse } from '../../../js/core/velvia-engine.js';
import { normalize } from '../../../js/core/text.js';
import { ProviderError } from './errors.js';
import { SYSTEM_PROMPT, responseSchema, buildCard, buildMessages, parseAnswer, groundAnswer } from './prompt.js';
import { createAnthropicProvider } from './providers/anthropic.js';
import { createOpenAICompatibleProvider } from './providers/openai-compatible.js';

export const FALLBACK_NOTICE = 'Velvia’s conversational service is unavailable right now, so these suggestions come from the built-in catalog engine.';
export const MAX_CARDS = 30;
const TOP_MATCHES = 12;
const HISTORY_NAMES = 10;

export const PROVIDER_LABELS = {
  local: 'Built-in catalog engine',
  anthropic: 'Anthropic Claude',
  'openai-compatible': 'OpenAI-compatible provider',
};

function createProvider(v) {
  if (v.provider === 'anthropic') return createAnthropicProvider({ apiKey: v.apiKey, model: v.model, timeoutMs: v.timeoutMs });
  if (v.provider === 'openai-compatible') return createOpenAICompatibleProvider({ baseUrl: v.baseUrl, apiKey: v.apiKey, model: v.model, timeoutMs: v.timeoutMs });
  return null;
}

/**
 * True when an answer names a title this profile may not see (parental limits) that the
 * viewer did not name first. Providers only receive visible cards, but could still name a
 * restricted title from their own knowledge; such an answer is never shown.
 */
export function namesHiddenTitle(texts, hidden, viewerText = '') {
  if (!hidden.length) return false;
  const said = ` ${normalize(viewerText)} `;
  const answer = ` ${normalize(texts.join(' '))} `;
  return hidden.some((t) => {
    const n = normalize(t.title);
    return n.length >= 4 && answer.includes(` ${n} `) && !said.includes(` ${n} `);
  });
}

/** Runs `fn(signal)` and rejects with ProviderError('timeout') after `ms`, even if `fn` ignores the signal. */
async function withDeadline(fn, ms) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ProviderError('timeout'));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve().then(() => fn(controller.signal)), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

export class VelviaService {
  constructor({ catalog, library, config }) {
    this.catalog = catalog;
    this.library = library;
    this.config = config;
    this.override = null;
    this.cache = { key: null, provider: null };
  }

  /** Dependency injection for tests and operators: a provider object, or null to use config. */
  setProvider(provider) {
    this.override = provider || null;
  }

  providerName() {
    return this.override?.name || this.config.velvia.provider || 'local';
  }

  provider() {
    if (this.override) return this.override;
    const v = this.config.velvia;
    const key = [v.provider, v.apiKey, v.model, v.baseUrl, v.timeoutMs].join('\u0000');
    if (this.cache.key !== key) this.cache = { key, provider: createProvider(v) };
    return this.cache.provider;
  }

  async status() {
    const name = this.providerName();
    if (name === 'local') return { provider: 'local', available: true, model: null, grounded: true };
    const p = this.provider();
    if (!p) return { provider: name, available: false, model: null, grounded: true };
    return { provider: p.name, available: await p.available(), model: p.model || null, grounded: true };
  }

  /**
   * Viewing signals for the engine and the provider. History is used only when the viewer
   * allows it for this request AND the profile's privacy preference allows it.
   */
  signalsFor(profile, options = {}) {
    if (!profile) return { signals: {}, personalisation: 'unavailable' };
    // Under parental limits a title the viewer names may exist but be hidden from this
    // profile, so Velvia says it isn't available "on this profile" (never whether it exists).
    const maxAge = profile.max_age ?? profile.maxAge ?? null;
    const restricted = maxAge !== null && maxAge !== undefined;
    const prefs = parseJson(profile.preferences, {}) || {};
    if (options.useHistory === false || prefs?.privacy?.useHistoryForRecommendations === false) {
      return { signals: { useHistory: false, restricted }, personalisation: 'off' };
    }
    const s = this.library.homeSignals(profile);
    return { signals: { history: s.history, watchlist: s.watchlist, ratings: s.ratings, progress: s.progress, restricted }, personalisation: 'on' };
  }

  /** The grounded card set for a provider: the engine's best matches first, then context. */
  candidates(a, titles) {
    const out = [];
    const seen = new Set();
    const add = (t) => {
      if (t && !seen.has(t.id) && out.length < MAX_CARDS) {
        seen.add(t.id);
        out.push(t);
      }
    };
    add(a.contextTitle);
    a.compareTitles.forEach(add);
    a.compare.forEach(add);
    add(a.target);
    (a.state?.latest?.mentions || []).forEach(add);
    a.ranked.slice(0, TOP_MATCHES).forEach((x) => add(x.t));
    a.closest.slice(0, TOP_MATCHES).forEach((x) => add(x.t));
    (a.state?.prevRecs || []).slice(0, 5).forEach(add);
    [...titles].sort((x, y) => (x.editorialRank ?? 1000) - (y.editorialRank ?? 1000) || String(x.id).localeCompare(String(y.id))).forEach(add);
    return out;
  }

  fallback(local) {
    return { ...local, provider: 'local', fallback: true, notice: FALLBACK_NOTICE };
  }

  /** Full credits (cast roles, crew such as Music) for a title the profile may see, or null. */
  credits(id, profile) {
    try {
      return this.catalog.detail(id, { profile }).credits || null;
    } catch {
      return null;
    }
  }

  /**
   * Catalog summaries carry no crew. When the engine discusses one title, give it that
   * title's full credits so it can name a credited composer instead of saying none is listed.
   */
  withCredits(a, profile) {
    if (a.intent !== 'discuss' || !a.target || a.target.credits) return a;
    const credits = this.credits(a.target.id, profile);
    return credits ? { ...a, target: { ...a.target, credits } } : a;
  }

  /** @param {{ body: { messages, context?, options? }, profile: object|null }} req */
  async chat({ body, profile }) {
    const titles = this.catalog.published(profile);
    const { signals, personalisation } = this.signalsFor(profile, body.options || {});
    const a = analyze(titles, body, signals);
    const local = composeResponse(this.withCredits(a, profile));
    const name = this.providerName();
    if (name === 'local') return local;

    const p = this.provider();
    if (!p || !(await p.available())) {
      log.warn('velvia.provider_unavailable', { provider: name });
      return this.fallback(local);
    }

    const cardTitles = this.candidates(a, titles);
    // Nothing this profile may see: there is nothing a provider could ground an answer in.
    if (!cardTitles.length) return local;
    const watched = personalisation === 'on' ? new Set((signals.history || []).map((h) => h.titleId)) : new Set();
    const byId = new Map(titles.map((t) => [t.id, t]));
    const focus = new Set([a.contextTitle?.id, a.target?.id].filter(Boolean));
    const cards = cardTitles.map((t) => buildCard(t, {
      watched: watched.has(t.id),
      crew: focus.has(t.id) ? this.credits(t.id, profile)?.crew || null : null,
    }));
    const context = {
      focusedTitleId: a.contextTitle?.id || null,
      compareTitleIds: a.compareTitles.map((t) => t.id),
      personalisation,
      recentlyWatched: personalisation === 'on' ? (signals.history || []).map((h) => byId.get(h.titleId)?.title).filter(Boolean).slice(0, HISTORY_NAMES) : [],
      titlesNotOnLumina: local.notInCatalog || [],
      peopleNotCredited: local.peopleNotInCatalog || [],
    };
    const messages = buildMessages({ messages: body.messages, cards, context });
    const deadlineMs = Math.max(1000, 2 * (this.config.velvia.timeoutMs || 20000) + 1500);
    const started = Date.now();
    try {
      const schema = responseSchema(cardTitles.map((t) => t.id));
      const { text } = await withDeadline((signal) => p.complete({ system: SYSTEM_PROMPT, messages, schema, signal }), deadlineMs);
      const answer = parseAnswer(text);
      const maxAge = a.state?.constraints?.maxAge ?? null;
      const grounded = groundAnswer(answer, cardTitles, { maxAge });
      const asked = Array.isArray(answer.recommendations) ? answer.recommendations.length : 0;
      // Every suggestion was outside the catalog: the reply is about titles we cannot show.
      if (asked > 0 && grounded.recommendations.length === 0) throw new ProviderError('ungrounded');
      const visible = new Set(titles.map((t) => t.id));
      const hidden = titles.length < this.catalog.published(null).length ? this.catalog.published(null).filter((t) => !visible.has(t.id)) : [];
      const viewerText = body.messages.filter((m) => m.role === 'user').map((m) => m.content).join(' ');
      if (namesHiddenTitle([grounded.reply, grounded.clarifyingQuestion, ...grounded.suggestions, ...grounded.recommendations.map((r) => r.reason)], hidden, viewerText)) {
        throw new ProviderError('restricted');
      }
      if (grounded.dropped) log.warn('velvia.provider_ids_dropped', { provider: p.name, dropped: grounded.dropped });
      log.debug('velvia.provider_ok', { provider: p.name, ms: Date.now() - started, cards: cards.length });
      const out = {
        reply: grounded.reply,
        recommendations: grounded.recommendations,
        clarifyingQuestion: grounded.clarifyingQuestion,
        suggestions: grounded.suggestions,
        provider: p.name,
        fallback: false,
        intent: local.intent,
      };
      if (local.comparison) out.comparison = local.comparison;
      if (local.notInCatalog) out.notInCatalog = local.notInCatalog;
      return out;
    } catch (err) {
      const kind = err instanceof ProviderError ? err.kind : 'error';
      log.warn('velvia.provider_failed', { provider: p.name, kind, status: err?.status ?? null, ms: Date.now() - started });
      return this.fallback(local);
    }
  }
}

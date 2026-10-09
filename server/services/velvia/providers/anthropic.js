// Anthropic provider for Velvia, using the official SDK.
//
// The SDK is an optional dependency: it is imported lazily here and nowhere else, so the
// server runs (with the built-in catalog engine) when it is not installed. The API key comes
// only from configuration (VELVIA_API_KEY) and never reaches the browser.
import { ProviderError } from '../errors.js';

export const DEFAULT_MODEL = 'claude-opus-5-5';
// The answer is a short JSON object written at medium effort. Thinking is always on and
// counts toward this limit; if a response ever reaches it (stop_reason "max_tokens"), the
// truncated answer is discarded and the catalog engine answers instead.
export const MAX_TOKENS = 2000;
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

let sdkPromise = null;
/** Resolves to the SDK's Anthropic class, or null when the package is not installed. */
export function loadAnthropicSdk() {
  sdkPromise ??= import('@anthropic-ai/sdk').then((m) => m.default || m.Anthropic || null, () => null);
  return sdkPromise;
}

/** Maps SDK errors onto ProviderError kinds using the SDK's typed classes. */
export function classifyError(err, Anthropic, signal) {
  if (err instanceof ProviderError) return err;
  if (Anthropic) {
    if (err instanceof Anthropic.APIConnectionTimeoutError) return new ProviderError('timeout');
    if (err instanceof Anthropic.APIUserAbortError) return new ProviderError('timeout');
    if (err instanceof Anthropic.RateLimitError) return new ProviderError('rate_limited', { status: 429 });
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new ProviderError('auth', { status: err.status });
    if (err instanceof Anthropic.APIConnectionError) return new ProviderError('connection');
    if (err instanceof Anthropic.APIError) return new ProviderError('api', { status: err.status ?? null });
  }
  if (signal?.aborted) return new ProviderError('timeout');
  return new ProviderError('api', { detail: err?.name || 'error' });
}

/**
 * @param {{ apiKey?: string, model?: string, timeoutMs?: number, client?: object, loadSdk?: () => Promise<Function|null> }} opts
 *   `client` injects a ready client (tests); otherwise one is created from the SDK.
 */
export function createAnthropicProvider({ apiKey = '', model = '', timeoutMs = 20000, client = null, loadSdk = loadAnthropicSdk } = {}) {
  const modelId = model || DEFAULT_MODEL;
  let cached = client;

  async function getClient(Anthropic) {
    if (cached) return cached;
    if (!Anthropic || !apiKey) throw new ProviderError('unavailable');
    cached = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 1 });
    return cached;
  }

  return {
    name: 'anthropic',
    label: 'Anthropic Claude',
    model: modelId,

    async available() {
      if (client) return true;
      return !!apiKey && !!(await loadSdk());
    },

    /** Sends one turn and returns the answer text. Throws ProviderError on any failure. */
    async complete({ system, messages, schema, signal }) {
      const Anthropic = await loadSdk();
      const c = await getClient(Anthropic);
      let response;
      try {
        response = await c.beta.messages.create({
          model: modelId,
          max_tokens: MAX_TOKENS,
          betas: [FALLBACK_BETA],
          fallbacks: 'default',
          system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
          messages,
          output_config: { effort: 'medium', format: { type: 'json_schema', schema } },
        }, signal ? { signal } : undefined);
      } catch (err) {
        throw classifyError(err, Anthropic, signal);
      }
      // Check why the model stopped before reading any content.
      if (response?.stop_reason === 'refusal') throw new ProviderError('refusal');
      if (response?.stop_reason === 'max_tokens') throw new ProviderError('truncated');
      // Thinking blocks come back with empty text; only the text block carries the answer.
      const block = (response?.content || []).find((b) => b.type === 'text');
      if (!block || typeof block.text !== 'string' || !block.text.trim()) throw new ProviderError('empty');
      return { text: block.text, model: response.model || modelId };
    },
  };
}

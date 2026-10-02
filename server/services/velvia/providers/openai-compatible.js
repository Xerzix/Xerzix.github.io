// OpenAI-compatible chat-completions provider (for operators running other providers or a
// self-hosted model). Same prompt contract as the Anthropic provider; JSON mode requested.
import { ProviderError } from '../errors.js';

export const MAX_TOKENS = 1500;

/**
 * @param {{ baseUrl: string, apiKey?: string, model?: string, timeoutMs?: number, fetchImpl?: typeof fetch }} opts
 */
export function createOpenAICompatibleProvider({ baseUrl = '', apiKey = '', model = '', timeoutMs = 20000, fetchImpl = globalThis.fetch } = {}) {
  const root = String(baseUrl || '').replace(/\/+$/, '');
  return {
    name: 'openai-compatible',
    label: 'OpenAI-compatible provider',
    model: model || null,

    async available() {
      if (!root) return false;
      try {
        const u = new URL(root);
        return u.protocol === 'https:' || u.protocol === 'http:';
      } catch {
        return false;
      }
    },

    async complete({ system, messages, signal }) {
      if (!(await this.available())) throw new ProviderError('unavailable');
      const timeout = AbortSignal.timeout(timeoutMs);
      const combined = signal ? AbortSignal.any([timeout, signal]) : timeout;
      const aborted = () => timeout.aborted || !!signal?.aborted;
      let res;
      try {
        res = await fetchImpl(`${root}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: model || undefined,
            messages: [{ role: 'system', content: system }, ...messages],
            response_format: { type: 'json_object' },
            max_tokens: MAX_TOKENS,
          }),
          signal: combined,
          redirect: 'error',
        });
      } catch {
        throw new ProviderError(aborted() ? 'timeout' : 'connection');
      }
      if (res.status === 429) throw new ProviderError('rate_limited', { status: 429 });
      if (res.status === 401 || res.status === 403) throw new ProviderError('auth', { status: res.status });
      if (!res.ok) throw new ProviderError('api', { status: res.status });
      let data;
      try {
        data = await res.json();
      } catch {
        throw new ProviderError(aborted() ? 'timeout' : 'malformed');
      }
      const choice = data?.choices?.[0];
      if (!choice || typeof choice !== 'object') throw new ProviderError('malformed');
      if (choice.finish_reason === 'content_filter' || choice.message?.refusal) throw new ProviderError('refusal');
      if (choice.finish_reason === 'length') throw new ProviderError('truncated');
      const text = choice.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new ProviderError('empty');
      return { text, model: data.model || model || null };
    },
  };
}

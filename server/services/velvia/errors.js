// Failures of a conversational provider. `kind` is what the orchestrator logs (never the
// conversation) and what decides the fallback: every kind falls back to the catalog engine.
export class ProviderError extends Error {
  /**
   * @param {'unavailable'|'timeout'|'rate_limited'|'connection'|'auth'|'api'|'refusal'|'truncated'|'empty'|'malformed'|'ungrounded'|'restricted'} kind
   */
  constructor(kind, { status = null, detail = '' } = {}) {
    super(`Velvia provider failed: ${kind}${detail ? ` (${detail})` : ''}`);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = status;
  }
}

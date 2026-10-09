// Security headers, CSRF/origin protection and rate limiting.
import { config } from '../config.js';
import { HttpError, tooMany } from './errors.js';

export function buildCsp() {
  const media = config.media.extraOrigins.join(' ');
  return [
    "default-src 'self'",
    "script-src 'self'",
    // Inline style attributes are used by a few components for computed geometry.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    `img-src 'self' data: blob: ${media}`,
    // data: only for media: hls.js gives each HLS subtitle rendition a placeholder
    // <track src="data:,WEBVTT"> and fills it with cues itself. Media cannot run script.
    `media-src 'self' blob: data: ${media}`,
    `connect-src 'self' ${media}`,
    "worker-src 'self' blob:",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export function securityHeaders() {
  const csp = buildCsp();
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), picture-in-picture=(self), fullscreen=(self)',
    ...(config.isProd ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence for the JSON API: state-changing requests must carry the custom
 * `X-Lumina-Request` header (which cross-site forms cannot send without a CORS
 * preflight this server never grants), and any Origin header must be our own.
 */
export function csrfGuard(ctx) {
  if (!ctx.path.startsWith('/api/') || SAFE_METHODS.has(ctx.method)) return;
  if (ctx.header('x-lumina-request') !== '1') {
    throw new HttpError(403, 'CSRF_REJECTED', 'This request was blocked for your protection. Refresh the page and try again.');
  }
  const origin = ctx.header('origin');
  if (origin) {
    const host = ctx.header('host');
    const allowed = new Set([config.publicUrl, `http://${host}`, `https://${host}`]);
    if (!allowed.has(origin)) throw new HttpError(403, 'CSRF_REJECTED', 'Cross-site requests are not allowed.');
  }
}

/**
 * Fixed-window-with-carryover rate limiter kept in memory. For multi-instance deployments
 * replace the store with Redis (see docs/SECURITY.md); the call sites stay the same.
 */
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref();
  }

  hit(key, max, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || now >= b.reset) {
      b = { count: 0, reset: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count += 1;
    return { allowed: b.count <= max, remaining: Math.max(0, max - b.count), retryAfter: Math.ceil((b.reset - now) / 1000) };
  }

  sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now >= b.reset) this.buckets.delete(k);
  }

  reset() {
    this.buckets.clear();
  }
}

export const limiter = new RateLimiter();

/**
 * Route guard factory. `by` chooses the key: 'ip', 'account' (falls back to ip) or a function.
 *   app.post('/api/auth/login', rateLimit('login', { max: 10, windowMs: 15 * 60e3 }), handler)
 */
export function rateLimit(name, { max, windowMs, by = 'ip' }) {
  return (ctx) => {
    if (config.isTest && process.env.LUMINA_TEST_RATE_LIMITS !== '1') return;
    const who = typeof by === 'function' ? by(ctx) : by === 'account' ? ctx.account?.id || ctx.ip : ctx.ip;
    const r = limiter.hit(`${name}:${who}`, max, windowMs);
    if (!r.allowed) throw tooMany(r.retryAfter);
  };
}

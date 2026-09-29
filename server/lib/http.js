// Minimal HTTP application layer on top of node:http: routing with params, guard chains,
// JSON bodies with size limits, cookies, and uniform error responses.
import { randomBytes } from 'node:crypto';
import { HttpError, badRequest } from './errors.js';
import { log } from './log.js';

const DEFAULT_JSON_LIMIT = 1024 * 1024; // 1 MiB

function compile(pattern) {
  const keys = [];
  const source = pattern
    .replace(/\/+$/, '')
    .replace(/[.*+?^${}()|[\]\\]/g, (c) => (c === '*' ? c : `\\${c}`))
    .replace(/:(\w+)/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    })
    .replace(/\*$/, '(.*)');
  if (pattern.endsWith('*')) keys.push('rest');
  return { regex: new RegExp(`^${source || ''}/?$`), keys };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function serializeCookie(name, value, opts = {}) {
  let c = `${name}=${encodeURIComponent(value)}; Path=${opts.path || '/'}`;
  if (opts.maxAge !== undefined) c += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.httpOnly !== false) c += '; HttpOnly';
  c += `; SameSite=${opts.sameSite || 'Lax'}`;
  if (opts.secure) c += '; Secure';
  return c;
}

/** Reads the request body up to `limit` bytes. */
export function readBody(req, limit = DEFAULT_JSON_LIMIT) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > limit) {
      reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.'));
      req.resume();
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', 'The request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Per-request context passed to every guard and handler. */
export class Context {
  constructor(req, res, app) {
    this.req = req;
    this.res = res;
    this.app = app;
    const url = new URL(req.url, 'http://localhost');
    this.method = req.method;
    this.path = decodeURIComponent(url.pathname);
    this.searchParams = url.searchParams;
    this.query = Object.fromEntries(url.searchParams);
    this.params = {};
    this.cookies = parseCookies(req.headers.cookie);
    this.requestId = randomBytes(6).toString('hex');
    this.ip = app.clientIp(req);
    this.state = {};
    // Populated by the session middleware.
    this.session = null;
    this.account = null;
    this.profile = null;
    this._body = undefined;
    this._headers = {};
    this._cookies = [];
  }

  header(name) {
    return this.req.headers[name.toLowerCase()];
  }

  setHeader(name, value) {
    this._headers[name] = value;
  }

  setCookie(name, value, opts) {
    this._cookies.push(serializeCookie(name, value, opts));
  }

  clearCookie(name, opts = {}) {
    this._cookies.push(serializeCookie(name, '', { ...opts, maxAge: 0 }));
  }

  /** Parses a JSON body (object expected). Empty body -> {}. */
  async body(limit) {
    if (this._body !== undefined) return this._body;
    const type = (this.header('content-type') || '').split(';')[0].trim();
    const raw = await readBody(this.req, limit);
    if (!raw.length) return (this._body = {});
    if (type !== 'application/json') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON with Content-Type: application/json.');
    try {
      const parsed = JSON.parse(raw.toString('utf8'));
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      return (this._body = parsed);
    } catch {
      throw badRequest('The request body is not valid JSON.');
    }
  }

  get sent() {
    return this.res.headersSent || this.res.writableEnded;
  }

  writeHead(status, headers = {}) {
    const all = { ...this.app.baseHeaders, ...this._headers, ...headers, 'X-Request-Id': this.requestId };
    if (this._cookies.length) all['Set-Cookie'] = this._cookies;
    this.res.writeHead(status, all);
  }

  json(data, status = 200) {
    if (this.sent) return;
    const payload = JSON.stringify(data);
    this.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': this._headers['Cache-Control'] || 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    this.res.end(this.method === 'HEAD' ? undefined : payload);
  }

  empty(status = 204, headers = {}) {
    if (this.sent) return;
    this.writeHead(status, headers);
    this.res.end();
  }

  text(body, status = 200, type = 'text/plain; charset=utf-8') {
    if (this.sent) return;
    this.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
    this.res.end(this.method === 'HEAD' ? undefined : body);
  }

  redirect(location, status = 302) {
    this.writeHead(status, { Location: location });
    this.res.end();
  }
}

export class App {
  constructor({ trustProxy = false } = {}) {
    this.trustProxy = trustProxy;
    this.routes = [];
    this.before = [];
    this.fallback = null;
    this.baseHeaders = {};
  }

  clientIp(req) {
    if (this.trustProxy) {
      const fwd = req.headers['x-forwarded-for'];
      if (fwd) return String(fwd).split(',')[0].trim();
    }
    return req.socket.remoteAddress || '';
  }

  /** Global middleware run before routing: (ctx) => void | Promise<void>. */
  use(fn) {
    this.before.push(fn);
    return this;
  }

  route(method, pattern, ...handlers) {
    const { regex, keys } = compile(pattern);
    this.routes.push({ method, pattern, regex, keys, handlers });
    return this;
  }

  get(p, ...h) { return this.route('GET', p, ...h); }
  post(p, ...h) { return this.route('POST', p, ...h); }
  put(p, ...h) { return this.route('PUT', p, ...h); }
  patch(p, ...h) { return this.route('PATCH', p, ...h); }
  delete(p, ...h) { return this.route('DELETE', p, ...h); }
  head(p, ...h) { return this.route('HEAD', p, ...h); }

  /** Handler for requests no route matched (e.g. static files). */
  otherwise(fn) {
    this.fallback = fn;
    return this;
  }

  match(method, path) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => {
        params[k] = m[i + 1];
      });
      return { route: r, params };
    }
    return { route: null, pathMatched };
  }

  handler() {
    return async (req, res) => {
      const ctx = new Context(req, res, this);
      const started = process.hrtime.bigint();
      try {
        for (const fn of this.before) {
          await fn(ctx);
          if (ctx.sent) return;
        }
        const { route, params, pathMatched } = this.match(ctx.method, ctx.path);
        if (route) {
          ctx.params = params;
          ctx.route = route.pattern;
          let result;
          for (const h of route.handlers) {
            result = await h(ctx);
            if (ctx.sent) break;
          }
          if (!ctx.sent) {
            if (result === undefined) ctx.empty(204);
            else ctx.json(result);
          }
        } else if (pathMatched) {
          throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'That method is not allowed here.');
        } else if (this.fallback) {
          await this.fallback(ctx);
        } else {
          throw new HttpError(404, 'NOT_FOUND', 'We could not find that.');
        }
      } catch (err) {
        this.handleError(ctx, err);
      } finally {
        if (ctx.path.startsWith('/api/')) {
          const ms = Number(process.hrtime.bigint() - started) / 1e6;
          log.debug('request', { id: ctx.requestId, method: ctx.method, path: ctx.route || ctx.path, status: res.statusCode, ms: Math.round(ms) });
        }
      }
    };
  }

  handleError(ctx, err) {
    if (err instanceof HttpError) {
      if (err.status === 429 && err.extra?.retryAfter) ctx.setHeader('Retry-After', String(err.extra.retryAfter));
      const body = { error: { code: err.code, message: err.message, ...err.extra } };
      if (ctx.sent) return;
      ctx.json(body, err.status);
      return;
    }
    // Unknown failure: log with the request id, return a generic message only.
    log.error('unhandled error', { id: ctx.requestId, method: ctx.method, path: ctx.path, err });
    if (ctx.sent) {
      ctx.res.destroy();
      return;
    }
    ctx.json({ error: { code: 'INTERNAL', message: 'Something went wrong on our side. Please try again.', requestId: ctx.requestId } }, 500);
  }
}

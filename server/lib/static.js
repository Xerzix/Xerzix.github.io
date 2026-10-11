// Static and media file serving with byte-range support (needed for video seeking),
// ETags, and a strict allowlist so server code, the database and uploads are never exposed.
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { brotliCompress, constants as zlibConstants, gzip } from 'node:zlib';
import { pickEncoding } from './encoding.js';
import { HttpError } from './errors.js';

export { pickEncoding };

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.mpd': 'application/dash+xml',
  '.ts': 'video/mp2t',
  '.m4s': 'video/iso.segment',
  '.mp4': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.vtt': 'text/vtt; charset=utf-8',
  '.pdf': 'application/pdf',
};

// Text assets are compressed when the client accepts it. Media, fonts and images are already
// compressed, and range requests are always answered from the raw bytes.
const COMPRESSIBLE = new Set(['.html', '.css', '.js', '.mjs', '.json', '.txt', '.md', '.svg', '.vtt']);
const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESS_BYTES = 8 * 1024 * 1024;
const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

// Compressed bodies, keyed by path, ETag and encoding, so each version of a file is compressed
// once. Oldest entries are evicted beyond the byte budget.
const compressedCache = new Map();
const COMPRESSED_CACHE_BYTES = 32 * 1024 * 1024;
let compressedCacheSize = 0;

async function compressedBody(filePath, etag, encoding) {
  const key = `${filePath}\0${etag}\0${encoding}`;
  const hit = compressedCache.get(key);
  if (hit) {
    compressedCache.delete(key);
    compressedCache.set(key, hit);
    return hit;
  }
  const raw = await readFile(filePath);
  const body = encoding === 'br'
    ? await brotli(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9, [zlibConstants.BROTLI_PARAM_SIZE_HINT]: raw.length } })
    : await gzipAsync(raw, { level: 9 });
  compressedCache.set(key, body);
  compressedCacheSize += body.length;
  for (const [k, v] of compressedCache) {
    if (compressedCacheSize <= COMPRESSED_CACHE_BYTES) break;
    compressedCache.delete(k);
    compressedCacheSize -= v.length;
  }
  return body;
}

/**
 * Resolves `relPath` inside `root`, refusing traversal and dotfiles.
 * Returns null when the path contains a "." / ".." / dotfile segment or a NUL byte, or
 * escapes the root. The RAW path is checked before normalize(): normalizing first would
 * collapse "css/../var/db" into "var/db", silently stepping out of the directory the
 * caller meant to confine to.
 */
export function safeJoin(root, relPath) {
  if (typeof relPath !== 'string' || relPath.includes('\0')) return null;
  if (relPath.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return null;
  const cleaned = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  if (cleaned.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return null;
  const full = resolve(join(root, cleaned));
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/**
 * Streams a file with Range support. `cache` is a Cache-Control value. With `compress`, text
 * assets are sent with Brotli or gzip when the client accepts it.
 */
export async function sendFile(ctx, filePath, { cache = 'no-cache', contentType, disposition, compress = false } = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'We could not find that file.');
  }
  if (!info.isFile()) throw new HttpError(404, 'NOT_FOUND', 'We could not find that file.');

  const type = contentType || MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const baseTag = `${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}`;
  const compressible = compress && COMPRESSIBLE.has(extname(filePath).toLowerCase())
    && info.size >= MIN_COMPRESS_BYTES && info.size <= MAX_COMPRESS_BYTES;
  const encoding = compressible && !ctx.header('range') ? pickEncoding(ctx.header('accept-encoding')) : null;
  // Each encoding is a different representation, so it gets its own ETag.
  const etag = `W/"${baseTag}${encoding ? `-${encoding}` : ''}"`;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': cache,
  };
  if (disposition) headers['Content-Disposition'] = disposition;
  if (compressible) headers.Vary = 'Accept-Encoding';

  if (ctx.header('if-none-match') === etag) {
    ctx.writeHead(304, headers);
    ctx.res.end();
    return;
  }

  const range = ctx.header('range');
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    let start;
    let end;
    if (m) {
      if (m[1] === '' && m[2] !== '') {
        start = Math.max(0, info.size - Number(m[2]));
        end = info.size - 1;
      } else {
        start = Number(m[1]);
        end = m[2] === '' ? info.size - 1 : Math.min(Number(m[2]), info.size - 1);
      }
    }
    if (!m || Number.isNaN(start) || start > end || start >= info.size) {
      ctx.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
      ctx.res.end();
      return;
    }
    ctx.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    if (ctx.method === 'HEAD') return ctx.res.end();
    createReadStream(filePath, { start, end }).on('error', () => ctx.res.destroy()).pipe(ctx.res);
    return;
  }

  if (encoding) {
    const body = await compressedBody(filePath, etag, encoding);
    ctx.writeHead(200, { ...headers, 'Content-Encoding': encoding, 'Content-Length': body.length });
    return ctx.res.end(ctx.method === 'HEAD' ? undefined : body);
  }

  ctx.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (ctx.method === 'HEAD') return ctx.res.end();
  createReadStream(filePath).on('error', () => ctx.res.destroy()).pipe(ctx.res);
}

/**
 * Serves the public web root. Only these top-level entries are reachable; everything
 * else (server/, tests/, var/, node_modules/, docs/, package.json …) returns 404.
 */
const PUBLIC_ENTRIES = new Set(['index.html', 'admin.html', 'css', 'js', 'assets', 'data', 'media', 'content', 'robots.txt', 'manifest.webmanifest']);
const NO_STORE_HTML = 'no-cache';

export function staticHandler(root) {
  return async (ctx) => {
    if (ctx.method !== 'GET' && ctx.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'That method is not allowed here.');
    let rel = ctx.path === '/' ? 'index.html' : ctx.path.replace(/^\/+/, '');
    const top = rel.split('/')[0];
    if (!PUBLIC_ENTRIES.has(top)) throw new HttpError(404, 'NOT_FOUND', 'We could not find that.');
    const full = safeJoin(root, rel);
    if (!full) throw new HttpError(404, 'NOT_FOUND', 'We could not find that.');
    // Enforce the allowlist on the RESOLVED location too, so no encoding trick can turn
    // "css/<something>" into a file outside the public entries.
    const resolvedTop = relative(resolve(root), full).split(sep)[0];
    if (!PUBLIC_ENTRIES.has(resolvedTop)) throw new HttpError(404, 'NOT_FOUND', 'We could not find that.');
    const ext = extname(full).toLowerCase();
    // HTML is revalidated on every load; versioned static assets can be cached briefly;
    // media segments are immutable once written.
    let cache = 'public, max-age=300';
    if (ext === '.html') cache = NO_STORE_HTML;
    else if (['.ts', '.m4s', '.mp4', '.webm'].includes(ext)) cache = 'public, max-age=86400';
    else if (ext === '.m3u8') cache = 'public, max-age=60';
    await sendFile(ctx, full, { cache, compress: true });
  };
}

// Static and media file serving with byte-range support (needed for video seeking),
// ETags, and a strict allowlist so server code, the database and uploads are never exposed.
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { HttpError } from './errors.js';

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

/**
 * Resolves `relPath` inside `root`, refusing traversal and dotfiles.
 * Returns null when the path escapes the root.
 */
export function safeJoin(root, relPath) {
  const cleaned = normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, '');
  if (cleaned.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return null;
  const full = resolve(join(root, cleaned));
  const base = resolve(root);
  if (full !== base && !full.startsWith(base + sep)) return null;
  return full;
}

/**
 * Streams a file with Range support. `cache` is a Cache-Control value.
 */
export async function sendFile(ctx, filePath, { cache = 'no-cache', contentType, disposition } = {}) {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'We could not find that file.');
  }
  if (!info.isFile()) throw new HttpError(404, 'NOT_FOUND', 'We could not find that file.');

  const type = contentType || MIME[extname(filePath).toLowerCase()] || 'application/octet-stream';
  const etag = `W/"${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': type,
    'Accept-Ranges': 'bytes',
    ETag: etag,
    'Last-Modified': info.mtime.toUTCString(),
    'Cache-Control': cache,
  };
  if (disposition) headers['Content-Disposition'] = disposition;

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
    const ext = extname(full).toLowerCase();
    // HTML is revalidated on every load; versioned static assets can be cached briefly;
    // media segments are immutable once written.
    let cache = 'public, max-age=300';
    if (ext === '.html') cache = NO_STORE_HTML;
    else if (['.ts', '.m4s', '.mp4', '.webm'].includes(ext)) cache = 'public, max-age=86400';
    else if (ext === '.m3u8') cache = 'public, max-age=60';
    await sendFile(ctx, full, { cache });
  };
}

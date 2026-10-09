// Resumable uploads (tus-style; docs/API.md "Creators & uploads").
//   POST   /api/uploads           create → { id, offset: 0, chunkSize, maxChunkSize, expiresAt }
//   PATCH  /api/uploads/:id       one chunk (application/offset+octet-stream, Upload-Offset)
//   HEAD / GET / DELETE           offset / status / abort
// Bytes are streamed to private storage (uploads/<id>.part), never into memory. When the last
// byte arrives the file is validated by its content (magic bytes, not name or declared type),
// hashed, probed and scanned, then moved to its final key and attached. Nothing is ever
// reachable from the web except artwork, which staff upload into public/art/.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { config as defaultConfig } from '../config.js';
import { now, parseJson, toJson } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { conflict, forbidden, HttpError, notFound, validation } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { audit } from './audit.js';
import { addEvent, EDITABLE_STATUSES, FILE_ROLES, syncUploadState } from './creators.js';
import { classifyText, decodeUtf8, imageSize, probeFile, sniffType } from './media/probe.js';
import { ensureDirFor, removeKey, storagePath } from './storage.js';

export const ARTWORK_ROLES = ['poster', 'backdrop', 'artwork'];
export const ROLE_KINDS = {
  feature: 'video', episode: 'video', trailer: 'video',
  poster: 'image', backdrop: 'image', artwork: 'image',
  document: 'document', subtitle: 'subtitle',
};
/** Content types (from sniffType) accepted for each kind of role. */
export const ACCEPTED_TYPES = {
  video: ['mp4', 'mov', 'mkv', 'webm', 'ts'],
  image: ['png', 'jpeg', 'webp'],
  document: ['pdf'],
  subtitle: ['vtt', 'srt'],
};
/** File name extensions offered by the picker; only a hint — the content decides. */
export const EXTENSIONS = {
  video: ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'ts', 'mts', 'm2ts'],
  image: ['png', 'jpg', 'jpeg', 'webp'],
  document: ['pdf'],
  subtitle: ['vtt', 'srt'],
};
const KIND_LABEL = {
  video: 'a video file (MP4, MOV, MKV, WebM or MPEG-TS)',
  image: 'an image (PNG, JPEG or WebP)',
  document: 'a PDF document',
  subtitle: 'a subtitle file (WebVTT or SRT, UTF-8)',
};
export const SUBTITLE_MAX_BYTES = 5 * 1024 * 1024;
export const RECOMMENDED_CHUNK = 8 * 1024 * 1024;
const MAX_ACTIVE_PER_ACCOUNT = 20;

export function sizeLimit(kind, cfg = defaultConfig) {
  return { video: cfg.uploads.maxBytes, image: cfg.uploads.maxImageBytes, document: cfg.uploads.maxDocumentBytes, subtitle: SUBTITLE_MAX_BYTES }[kind];
}

/** Safe storage file name: ASCII letters, digits, dot, dash and underscore; no leading dot. */
export function sanitizeFilename(name) {
  const base = String(name || '').split(/[\\/]/).pop().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot + 1).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) : '';
  let stem = (dot > 0 ? base.slice(0, dot) : base).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/[-.]{2,}/g, '-').replace(/^[-._]+|[-._]+$/g, '');
  stem = stem.slice(0, 80) || 'file';
  return ext ? `${stem}.${ext}` : stem;
}

const extensionOf = (name) => {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(String(name || ''));
  return m ? m[1].toLowerCase() : '';
};

const readableSize = (n) => {
  const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${Number.isInteger(n) ? n : n.toFixed(1)} ${units[i]}`;
};

/** Splits a configured command line into argv (supports simple quoting; never uses a shell). */
export function splitCommand(command) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(command))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * Runs the configured scanner with the file path appended. Exit 0 = clean, 1 = infected
 * (ClamAV convention), anything else (or a failure to run) = error.
 */
export function scanFile(path, command, { timeoutMs = 15 * 60_000 } = {}) {
  if (!command) return Promise.resolve('not_configured');
  const [cmd, ...args] = splitCommand(command);
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    let proc;
    try {
      proc = spawn(cmd, [...args, path], { stdio: 'ignore' });
    } catch {
      return done('error');
    }
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      done('error');
    }, timeoutMs);
    proc.on('error', () => {
      clearTimeout(timer);
      done('error');
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      done(code === 0 ? 'clean' : code === 1 ? 'infected' : 'error');
    });
  });
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path, { highWaterMark: 1024 * 1024 })) hash.update(chunk);
  return hash.digest('hex');
}

async function readHead(path, bytes) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const { bytesRead } = await fh.read(buf, 0, bytes, 0);
    return buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function uploadDto(u) {
  const result = parseJson(u.result, {});
  return {
    id: u.id,
    purpose: u.purpose,
    submissionId: u.submission_id,
    role: u.file_role,
    filename: u.filename,
    size: u.size_bytes,
    offset: u.offset_bytes,
    status: u.status === 'in_progress' && u.offset_bytes === u.size_bytes ? 'processing' : u.status,
    error: u.error,
    createdAt: u.created_at,
    updatedAt: u.updated_at,
    expiresAt: u.expires_at,
    ...(result.fileId ? { fileId: result.fileId } : {}),
    ...(result.url ? { url: result.url, width: result.width ?? null, height: result.height ?? null } : {}),
  };
}

export class UploadService {
  constructor(db, config = defaultConfig) {
    this.db = db;
    this.config = config;
    this.busy = new Set();
    this.hashes = new Map(); // uploadId → { hash, pos } while this process has seen every byte
  }

  expiry() {
    return new Date(Date.now() + this.config.uploads.expireHours * 3600_000).toISOString();
  }

  own(ctx, id) {
    const row = this.db.get('SELECT * FROM uploads WHERE id = ? AND account_id = ?', id, ctx.account.id);
    if (!row) throw notFound('We could not find that upload.');
    return row;
  }

  async create(ctx, input, { assertStaff }) {
    const { purpose, role } = input;
    const kind = ROLE_KINDS[role];
    let submissionId = null;
    if (purpose === 'submission') {
      if (!ctx.account.is_creator) throw forbidden('Creator access is required. Apply on the Creators page.', 'CREATOR_REQUIRED');
      if (!FILE_ROLES.includes(role)) throw validation({ role: `Choose one of: ${FILE_ROLES.join(', ')}.` });
      if (!input.submissionId) throw validation({ submissionId: 'Choose the submission this file belongs to.' });
      const sub = this.db.get('SELECT id, status FROM submissions WHERE id = ? AND account_id = ?', input.submissionId, ctx.account.id);
      if (!sub) throw notFound('We could not find that submission.');
      if (!EDITABLE_STATUSES.includes(sub.status)) throw conflict('This submission is no longer accepting files.', 'SUBMISSION_LOCKED', { status: sub.status });
      submissionId = sub.id;
    } else {
      assertStaff(ctx);
      if (!ARTWORK_ROLES.includes(role)) throw validation({ role: `Choose one of: ${ARTWORK_ROLES.join(', ')}.` });
    }
    const limit = sizeLimit(kind, this.config);
    if (input.size > limit) {
      const message = `Files of this kind can be at most ${readableSize(limit)}.`;
      throw new HttpError(413, 'FILE_TOO_LARGE', message, { fields: { size: message }, maxBytes: limit });
    }
    const ext = extensionOf(input.filename);
    if (ext && !EXTENSIONS[kind].includes(ext)) {
      throw new HttpError(422, 'UNSUPPORTED_FILE_TYPE', `This does not look like ${KIND_LABEL[kind]}.`, { fields: { filename: `Choose ${KIND_LABEL[kind]}.` } });
    }
    const active = this.db.get(`SELECT COUNT(*) AS n FROM uploads WHERE account_id = ? AND status = 'in_progress'`, ctx.account.id).n;
    if (active >= MAX_ACTIVE_PER_ACCOUNT) throw conflict('You have too many uploads in progress. Finish or cancel some first.', 'TOO_MANY_UPLOADS');

    const id = newId('upl');
    const key = `uploads/${id}.part`;
    const ts = now();
    const expiresAt = this.expiry();
    await writeFile(ensureDirFor(key), '');
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO uploads (id, account_id, purpose, submission_id, file_role, filename, declared_mime, size_bytes, offset_bytes, storage_key, status, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'in_progress', ?, ?, ?)`,
        id, ctx.account.id, purpose, submissionId, role, input.filename, input.mime ?? null, input.size, key, ts, ts, expiresAt,
      );
      syncUploadState(this.db, submissionId);
    });
    this.hashes.set(id, { hash: createHash('sha256'), pos: 0 });
    const maxChunkSize = this.config.uploads.chunkMaxBytes;
    return { id, offset: 0, size: input.size, chunkSize: Math.min(RECOMMENDED_CHUNK, maxChunkSize), maxChunkSize, expiresAt };
  }

  status(ctx, id) {
    return uploadDto(this.own(ctx, id));
  }

  /** Handles one PATCH. Returns the new offset; throws HttpError for protocol problems. */
  async receive(ctx, id) {
    const row = this.own(ctx, id);
    const type = String(ctx.header('content-type') || '').split(';')[0].trim().toLowerCase();
    if (type !== 'application/offset+octet-stream') throw new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send chunks with Content-Type: application/offset+octet-stream.');
    ctx.setHeader('Upload-Offset', String(row.offset_bytes));
    ctx.setHeader('Upload-Length', String(row.size_bytes));
    ctx.setHeader('Cache-Control', 'no-store');
    if (row.status !== 'in_progress') throw conflict(row.status === 'complete' ? 'This upload has already finished.' : `This upload was ${row.status}. Start it again.`, 'UPLOAD_NOT_ACTIVE', { status: row.status });
    const header = ctx.header('upload-offset');
    if (header === undefined || !/^\d+$/.test(String(header))) throw new HttpError(400, 'BAD_REQUEST', 'The Upload-Offset header is missing or invalid.');
    const offset = Number(header);
    if (offset !== row.offset_bytes) throw conflict('The upload offset does not match. Resume from the server offset.', 'OFFSET_MISMATCH', { offset: row.offset_bytes });
    const chunkMax = this.config.uploads.chunkMaxBytes;
    const declared = ctx.header('content-length') !== undefined ? Number(ctx.header('content-length')) : null;
    if (row.offset_bytes >= row.size_bytes) {
      // Every byte is here. If no request is checking the file right now (the server restarted
      // or the connection carrying the last chunk dropped mid-check), an empty PATCH at the
      // final offset runs the check again; otherwise the client waits for the running one.
      if (this.busy.has(id)) throw conflict('All bytes have been received; the file is being checked.', 'UPLOAD_BUSY');
      if (declared) throw new HttpError(413, 'CHUNK_TOO_LARGE', 'Every byte of this file has already been received.');
      this.busy.add(id);
      try {
        await this.finalize(ctx, row);
        return row.size_bytes;
      } finally {
        this.busy.delete(id);
      }
    }
    if (declared !== null && declared > chunkMax) throw new HttpError(413, 'CHUNK_TOO_LARGE', `Chunks can be at most ${readableSize(chunkMax)}.`, { maxChunkSize: chunkMax });
    if (declared !== null && offset + declared > row.size_bytes) throw new HttpError(413, 'CHUNK_TOO_LARGE', 'This chunk goes past the declared file size.');
    if (this.busy.has(id)) throw conflict('Another chunk for this upload is still being written.', 'UPLOAD_BUSY');

    this.busy.add(id);
    try {
      const limit = Math.min(chunkMax, row.size_bytes - offset);
      const { written, aborted } = await this.writeChunk(row, ctx.req, limit);
      const newOffset = offset + written;
      const r = this.db.run(`UPDATE uploads SET offset_bytes = ?, updated_at = ?, expires_at = ? WHERE id = ? AND status = 'in_progress'`, newOffset, now(), this.expiry(), id);
      ctx.setHeader('Upload-Offset', String(newOffset));
      if (!r.changes) throw conflict('This upload was cancelled.', 'UPLOAD_NOT_ACTIVE');
      if (aborted) return newOffset;
      if (newOffset === row.size_bytes) await this.finalize(ctx, { ...row, offset_bytes: newOffset });
      return newOffset;
    } finally {
      this.busy.delete(id);
    }
  }

  async writeChunk(row, req, limit) {
    const path = storagePath(row.storage_key);
    await mkdir(dirname(path), { recursive: true });
    let fh;
    try {
      fh = await open(path, 'r+');
    } catch {
      fh = await open(path, 'w+');
    }
    const state = this.hashes.get(row.id);
    const hashing = state && state.pos === row.offset_bytes ? state : null;
    if (!hashing) this.hashes.delete(row.id);
    let pos = row.offset_bytes;
    let written = 0;
    let aborted = false;
    try {
      await fh.truncate(row.offset_bytes); // drop anything past the committed offset
      try {
        for await (const chunk of req) {
          if (written + chunk.length > limit) {
            await fh.truncate(row.offset_bytes);
            this.hashes.delete(row.id);
            throw new HttpError(413, 'CHUNK_TOO_LARGE', 'This chunk is larger than allowed or goes past the declared file size.');
          }
          let off = 0;
          while (off < chunk.length) {
            const { bytesWritten } = await fh.write(chunk, off, chunk.length - off, pos + off);
            off += bytesWritten;
          }
          pos += chunk.length;
          written += chunk.length;
          if (hashing) {
            hashing.hash.update(chunk);
            hashing.pos = pos;
          }
        }
      } catch (err) {
        if (err instanceof HttpError) throw err;
        aborted = true; // the client went away mid-chunk; keep what arrived
      }
    } finally {
      await fh.close();
    }
    return { written, aborted };
  }

  async reject(ctx, row, message, code = 'UPLOAD_REJECTED') {
    this.db.run(`UPDATE uploads SET status = 'rejected', error = ?, updated_at = ? WHERE id = ?`, message, now(), row.id);
    this.hashes.delete(row.id);
    await removeKey(row.storage_key).catch(() => {});
    syncUploadState(this.db, row.submission_id);
    throw new HttpError(422, code, message);
  }

  /** Validates, hashes, probes and scans a complete upload, then stores and attaches it. */
  async finalize(ctx, row) {
    const path = storagePath(row.storage_key);
    const kind = ROLE_KINDS[row.file_role];
    let info;
    try {
      info = await stat(path);
    } catch {
      return this.reject(ctx, row, 'The uploaded data is no longer on the server. Upload the file again.');
    }
    if (info.size !== row.size_bytes) return this.reject(ctx, row, 'The received file size does not match the declared size.');
    const head = await readHead(path, 256 * 1024);
    let type = sniffType(head);
    if (kind === 'subtitle') {
      const text = decodeUtf8(await readFile(path), { complete: true });
      if (text === null) return this.reject(ctx, row, 'Subtitle files must be UTF-8 text (WebVTT or SRT).');
      const t = classifyText(text);
      type = t === 'vtt' || t === 'srt' ? sniffType(Buffer.from(text.slice(0, 4096))) : null;
    }
    if (!type || !ACCEPTED_TYPES[kind].includes(type.type)) {
      return this.reject(ctx, row, `This file is not ${KIND_LABEL[kind]}. Lumina checks what a file contains, not just its name.`);
    }

    const state = this.hashes.get(row.id);
    const sha256 = state && state.pos === row.size_bytes ? state.hash.digest('hex') : await sha256File(path);
    this.hashes.delete(row.id);
    if (row.purpose === 'submission') {
      const same = this.db.get('SELECT original_name FROM submission_files WHERE submission_id = ? AND sha256 = ?', row.submission_id, sha256);
      if (same) return this.reject(ctx, row, `This exact file is already attached to the submission as “${same.original_name}”.`, 'DUPLICATE_FILE');
    }

    let probe;
    if (kind === 'video') {
      probe = await probeFile(path, { ffprobePath: this.config.media.ffprobePath });
      // ffprobe ran and could not read the file: the right header bytes are not enough.
      if (probe.ffprobeUnreadable) {
        return this.reject(ctx, row, 'We could not read a video stream in this file. Export it again from your editing software and upload the new file.');
      }
      // MP4/MOV can always be parsed (ffprobe or the built-in box parser); other containers
      // are only parsed when ffprobe is configured.
      const parsed = probe.source === 'ffprobe' || probe.source === 'mp4-parser' || type.type === 'mp4' || type.type === 'mov';
      if (parsed && !probe.videoCodec) {
        return this.reject(ctx, row, 'We could not find a video stream in this file.');
      }
    } else if (kind === 'image') {
      const dims = imageSize(head);
      if (!dims) return this.reject(ctx, row, 'We could not read this image. Try exporting it again as PNG, JPEG or WebP.');
      probe = { container: type.type, width: dims.width, height: dims.height, source: 'basic' };
    } else if (kind === 'subtitle') {
      const text = await readFile(path, 'utf8');
      probe = { container: type.type, cues: (text.match(/-->/g) || []).length, source: 'basic' };
    } else {
      probe = { container: type.type, source: 'basic' };
    }

    const scan = await scanFile(path, this.config.uploads.scanCommand);
    if (scan === 'infected') {
      audit(this.db, ctx, 'upload.infected', { targetType: 'upload', targetId: row.id, details: { filename: row.filename, submissionId: row.submission_id } });
      return this.reject(ctx, row, 'The malware scanner flagged this file, so it was deleted.', 'UPLOAD_INFECTED');
    }
    if (scan === 'error') log.warn('upload scan failed', { upload: row.id });

    if (row.purpose === 'artwork') return this.attachArtwork(ctx, row, path, type, probe, sha256);
    return this.attachToSubmission(ctx, row, path, type, probe, sha256, scan);
  }

  async attachToSubmission(ctx, row, path, type, probe, sha256, scan) {
    const sub = this.db.get('SELECT id, status FROM submissions WHERE id = ? AND account_id = ?', row.submission_id, row.account_id);
    if (!sub || !EDITABLE_STATUSES.includes(sub.status)) return this.reject(ctx, row, 'This submission is no longer accepting files.', 'SUBMISSION_LOCKED');
    const fileId = newId('sfl');
    const key = `submissions/${sub.id}/${fileId}-${sanitizeFilename(row.filename)}`;
    await rename(path, ensureDirFor(key));
    const ts = now();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO submission_files (id, submission_id, upload_id, role, original_name, mime, size_bytes, sha256, probe, scan_status, storage_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        fileId, sub.id, row.id, row.file_role, row.filename, type.mime, row.size_bytes, sha256, toJson(probe), scan, key, ts,
      );
      this.db.run(`UPDATE uploads SET status = 'complete', storage_key = ?, result = ?, error = NULL, updated_at = ? WHERE id = ?`, key, toJson({ fileId }), ts, row.id);
      addEvent(this.db, { submissionId: sub.id, actorId: ctx.account.id, kind: 'file', message: `Uploaded “${row.filename}” (${row.file_role}, ${readableSize(row.size_bytes)}).` });
      this.db.run('UPDATE submissions SET updated_at = ? WHERE id = ?', ts, sub.id);
      syncUploadState(this.db, sub.id);
    });
  }

  async attachArtwork(ctx, row, path, type, probe, sha256) {
    const file = `${row.id}.${type.ext}`;
    const key = `public/art/${file}`;
    await rename(path, ensureDirFor(key));
    const url = `/media/art/${file}`;
    this.db.run(
      `UPDATE uploads SET status = 'complete', storage_key = ?, result = ?, error = NULL, updated_at = ? WHERE id = ?`,
      key, toJson({ url, width: probe.width, height: probe.height, sha256 }), now(), row.id,
    );
    audit(this.db, ctx, 'media.artwork_uploaded', { targetType: 'upload', targetId: row.id, details: { url, role: row.file_role, filename: row.filename } });
  }

  async abort(ctx, id) {
    const row = this.own(ctx, id);
    if (row.status === 'complete') throw conflict('This upload has finished. Remove the file from the submission instead.', 'UPLOAD_COMPLETE');
    if (row.status !== 'in_progress') return;
    if (this.busy.has(id) && row.offset_bytes >= row.size_bytes) throw conflict('The file is being checked. Wait a moment, then remove it from the submission if you do not want it.', 'UPLOAD_BUSY');
    this.db.run(`UPDATE uploads SET status = 'aborted', updated_at = ? WHERE id = ? AND status = 'in_progress'`, now(), id);
    this.hashes.delete(id);
    await removeKey(row.storage_key).catch(() => {});
    syncUploadState(this.db, row.submission_id);
  }

  /** Expires in-progress uploads that have been idle past UPLOAD_EXPIRE_HOURS. */
  async expireStale() {
    const rows = this.db.all(`SELECT id, storage_key, submission_id FROM uploads WHERE status = 'in_progress' AND expires_at < ?`, now());
    for (const row of rows) {
      if (this.busy.has(row.id)) continue;
      this.db.run(`UPDATE uploads SET status = 'expired', error = 'The upload expired before it finished.', updated_at = ? WHERE id = ? AND status = 'in_progress'`, now(), row.id);
      this.hashes.delete(row.id);
      await removeKey(row.storage_key).catch(() => {});
      syncUploadState(this.db, row.submission_id);
    }
    if (rows.length) log.info('expired stale uploads', { count: rows.length });
    return rows.length;
  }
}

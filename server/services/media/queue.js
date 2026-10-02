// Transcode job queue (SQLite table transcode_jobs). The worker (./worker.js) consumes it.
//   enqueueTranscode(db, { mediaId, sourceKey }) → { jobId, status, existing }
//   jobStatus(db, mediaId)                       → latest job for that media, or null
// Callers that change what the catalog shows should call services.catalog.invalidate()
// afterwards (enqueueing moves the media row to status 'processing').
import { newId } from '../../lib/crypto.js';
import { now, parseJson } from '../../db/index.js';
import { storagePath } from '../storage.js';

/** Normalises "storage:<key>" or "<key>" into a storage key and checks it stays inside storage. */
export function toStorageKey(sourceKey) {
  const key = String(sourceKey || '').replace(/^storage:/, '');
  if (!key) throw new Error('A storage key for the source file is required.');
  // Keys are plain relative paths: no absolute paths, backslashes, empty or dot segments.
  if (key.startsWith('/') || key.includes('\\') || key.split('/').some((s) => !s || s.startsWith('.'))) {
    throw new Error(`Invalid storage key: ${key}`);
  }
  storagePath(key); // resolves inside STORAGE_DIR or throws
  return key;
}

export function jobDto(row) {
  if (!row) return null;
  return {
    id: row.id,
    mediaId: row.media_id,
    sourceKey: row.source_key,
    status: row.status,
    progress: row.progress,
    ladder: parseJson(row.ladder, []),
    error: row.error,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

/**
 * Queues a transcode of `sourceKey` (a private storage key) into HLS for media `mediaId`
 * and marks the media row 'processing'. If a job for that media is already queued or
 * running it is returned instead of creating a duplicate.
 */
export function enqueueTranscode(db, { mediaId, sourceKey }) {
  const key = toStorageKey(sourceKey);
  return db.tx(() => {
    const media = db.get('SELECT id FROM media WHERE id = ?', mediaId);
    if (!media) throw new Error(`Unknown media id: ${mediaId}`);
    const active = db.get(`SELECT * FROM transcode_jobs WHERE media_id = ? AND status IN ('queued', 'running') ORDER BY created_at DESC LIMIT 1`, mediaId);
    if (active) return { jobId: active.id, status: active.status, existing: true };
    const id = newId('job');
    const ts = now();
    db.run(`INSERT INTO transcode_jobs (id, media_id, source_key, status, progress, ladder, attempts, created_at) VALUES (?, ?, ?, 'queued', 0, '[]', 0, ?)`, id, mediaId, key, ts);
    db.run(`UPDATE media SET status = 'processing', updated_at = ? WHERE id = ?`, ts, mediaId);
    return { jobId: id, status: 'queued', existing: false };
  });
}

/** The most recent job for a media row (any status), or null. */
export function jobStatus(db, mediaId) {
  return jobDto(db.get('SELECT * FROM transcode_jobs WHERE media_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', mediaId));
}

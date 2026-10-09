// Transcoding worker: takes queued jobs from transcode_jobs one at a time, turns the source
// file into a verified HLS ladder in private storage (media/<mediaId>/) and records what was
// actually produced on the media row. Runs in-process (server/index.js, when
// TRANSCODE_IN_PROCESS=true) or standalone (server/worker.js → `npm run worker`).
//   startWorker(db, services, opts?) → { stop(): Promise<void>, runOnce(): Promise<job|null>, busy }
import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { config } from '../../config.js';
import { now, parseJson, toJson } from '../../db/index.js';
import { log } from '../../lib/log.js';
import { removeKey, storagePath } from '../storage.js';
import { probeFile } from './probe.js';
import { planLadder, transcodeToHls } from './transcoder.js';

export const FFMPEG_REQUIRED = 'Transcoding requires ffmpeg on the host (FFMPEG_PATH) or a cloud transcoder';
const MAX_ATTEMPTS = 3;

function languageLabel(lang) {
  if (lang === 'zxx') return 'No dialogue';
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(lang) || lang;
  } catch {
    return lang;
  }
}

/** Jobs left 'running' by a crash go back to the queue (or fail after MAX_ATTEMPTS). */
function recoverInterrupted(db) {
  const ts = now();
  for (const job of db.all(`SELECT id, media_id, attempts FROM transcode_jobs WHERE status = 'running'`)) {
    if (job.attempts >= MAX_ATTEMPTS) {
      db.run(`UPDATE transcode_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, 'Interrupted too many times.', ts, job.id);
      db.run(`UPDATE media SET status = 'failed', updated_at = ? WHERE id = ?`, ts, job.media_id);
    } else {
      db.run(`UPDATE transcode_jobs SET status = 'queued', progress = 0 WHERE id = ?`, job.id);
    }
  }
}

export function startWorker(db, services = {}, opts = {}) {
  const intervalMs = opts.intervalMs ?? 5000;
  const ffmpegPath = () => opts.ffmpegPath ?? config.media.ffmpegPath;
  const ffprobePath = () => opts.ffprobePath ?? config.media.ffprobePath;
  let stopped = false;
  let current = null; // { job, controller, promise }

  recoverInterrupted(db);

  function fail(job, message) {
    const ts = now();
    db.tx(() => {
      db.run(`UPDATE transcode_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`, String(message).slice(0, 1000), ts, job.id);
      db.run(`UPDATE media SET status = 'failed', updated_at = ? WHERE id = ?`, ts, job.media_id);
    });
    services.catalog?.invalidate?.();
    log.warn('transcode failed', { job: job.id, media: job.media_id, error: String(message).slice(0, 300) });
  }

  async function processJob(job) {
    const media = db.get('SELECT * FROM media WHERE id = ?', job.media_id);
    if (!media) return fail(job, 'The media item no longer exists.');
    if (!ffmpegPath()) return fail(job, FFMPEG_REQUIRED);
    let input;
    try {
      input = storagePath(job.source_key);
    } catch {
      return fail(job, 'The source key is not a valid storage key.');
    }
    if (!existsSync(input)) return fail(job, 'The source file is missing from storage.');

    const tmpKey = `media/${job.media_id}.tmp-${job.id}`;
    const outDir = storagePath(tmpKey);
    const controller = new AbortController();
    current.controller = controller;
    let lastWrite = 0;
    try {
      const probe = await probeFile(input, { ffprobePath: ffprobePath() });
      const ladder = probe.height ? planLadder({ width: probe.width, height: probe.height }) : undefined;
      // Declare the audio language only when the source file itself states one.
      const sourceLang = probe.audioTracks?.[0]?.lang;
      const audioLanguage = sourceLang && sourceLang !== 'und' ? sourceLang : null;
      if (ladder) db.run('UPDATE transcode_jobs SET ladder = ? WHERE id = ?', toJson(ladder.map((r) => ({ height: r.height, width: r.width, videoKbps: r.videoKbps }))), job.id);
      await mkdir(outDir, { recursive: true });
      const result = await transcodeToHls({
        input,
        outDir,
        ladder,
        audioLanguage,
        ffmpegPath: ffmpegPath(),
        signal: controller.signal,
        onProgress: ({ ratio }) => {
          if (ratio === null || Date.now() - lastWrite < 2000) return;
          lastWrite = Date.now();
          db.run('UPDATE transcode_jobs SET progress = ? WHERE id = ?', Math.round(ratio * 1000) / 1000, job.id);
        },
      });
      // Swap the finished ladder into place.
      const finalKey = `media/${job.media_id}`;
      await removeKey(finalKey);
      await rename(outDir, storagePath(finalKey));

      const heights = [...new Set(result.renditions.map((r) => r.height))].sort((a, b) => b - a);
      const ts = now();
      let audioTracks = parseJson(media.audio_tracks, []);
      if (!result.hasAudio) audioTracks = [];
      else if (!audioTracks.length && result.audio?.language) {
        audioTracks = [{ lang: result.audio.language, label: languageLabel(result.audio.language), kind: 'main', default: true }];
      }
      db.tx(() => {
        db.run(
          `UPDATE media SET kind = 'hls', source = ?, variants = '[]', resolutions = ?, video_codecs = ?, audio_formats = ?, audio_tracks = ?,
                  duration_s = ?, verified_at = ?, status = 'ready', updated_at = ? WHERE id = ?`,
          `storage:${finalKey}/master.m3u8`, toJson(heights), toJson(['H.264']), toJson(result.hasAudio ? ['AAC', 'Stereo'] : []), toJson(audioTracks),
          result.durationS ?? probe.durationS ?? null, ts, ts, job.media_id,
        );
        db.run(`UPDATE transcode_jobs SET status = 'done', progress = 1, ladder = ?, error = NULL, finished_at = ? WHERE id = ?`, toJson(result.renditions), ts, job.id);
      });
      services.catalog?.invalidate?.();
      log.info('transcode finished', { job: job.id, media: job.media_id, renditions: heights });
    } catch (err) {
      await rm(outDir, { recursive: true, force: true }).catch(() => {});
      if (controller.signal.aborted) {
        // Shutting down: put the job back so the next worker picks it up.
        db.run(`UPDATE transcode_jobs SET status = 'queued', progress = 0, attempts = MAX(0, attempts - 1) WHERE id = ?`, job.id);
        log.info('transcode interrupted; re-queued', { job: job.id });
        return;
      }
      fail(job, err.message || 'Transcoding failed.');
    }
  }

  /** Claims and processes the oldest queued job. Resolves with the job row, or null when idle. */
  async function runOnce() {
    if (stopped || current) return null;
    const job = db.get(`SELECT * FROM transcode_jobs WHERE status = 'queued' ORDER BY created_at, rowid LIMIT 1`);
    if (!job) return null;
    const claimed = db.run(`UPDATE transcode_jobs SET status = 'running', started_at = ?, attempts = attempts + 1, progress = 0, error = NULL WHERE id = ? AND status = 'queued'`, now(), job.id);
    if (!claimed.changes) return null;
    current = { job, controller: null, promise: null };
    current.promise = processJob(job).catch((err) => log.error('transcode worker error', { err }));
    try {
      await current.promise;
    } finally {
      current = null;
    }
    return db.get('SELECT * FROM transcode_jobs WHERE id = ?', job.id);
  }

  const tick = () => {
    if (!stopped && !current) runOnce().catch((err) => log.error('transcode worker tick failed', { err }));
  };
  const timer = setInterval(tick, intervalMs);
  const first = setTimeout(tick, Math.min(1000, intervalMs));
  if (opts.unref !== false) {
    timer.unref();
    first.unref();
  }
  if (!ffmpegPath()) log.info('transcode worker started without ffmpeg; queued jobs will fail with an explanation', {});

  return {
    runOnce,
    get busy() {
      return !!current;
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      clearTimeout(first);
      if (current) {
        current.controller?.abort();
        await current.promise;
      }
    },
  };
}

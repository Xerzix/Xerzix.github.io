// Creator applications and content submissions, from the reviewer's side.
// Allowed status transitions (anything else is a 409):
//   submitted → under_review
//   under_review → info_required | approved | rejected
//   info_required → under_review   (after the creator has responded)
//   approved → published           (only by publishing the draft title made from it)
// Every change writes a submission_event and notifies the creator. Nothing is published
// automatically: publishing a submission creates a DRAFT title that staff complete.
import { now, parseJson, toJson } from '../../db/index.js';
import { conflict, notFound, validation } from '../../lib/errors.js';
import { newId } from '../../lib/crypto.js';
import { v } from '../../lib/validate.js';
import { notify } from '../notifications.js';
import { likeTerm, paging, slugify, uniqueId } from './common.js';
import { isBrowserPlayableMp4, summarizeProbe } from './media-verify.js';

// ───────────────────────────── Creator applications ─────────────────────────────

export const decisionSchema = v.object({
  decision: v.enum(['approve', 'reject', 'info_required']),
  note: v.string().max(2000).optional(),
});

function applicationDto(r) {
  return {
    id: r.id,
    accountId: r.account_id,
    account: r.email !== undefined ? { email: r.email, displayName: r.display_name, isCreator: !!r.is_creator, status: r.account_status } : undefined,
    legalName: r.legal_name,
    contactEmail: r.contact_email,
    company: r.company,
    website: r.website,
    portfolio: r.portfolio,
    country: r.country,
    bio: r.bio,
    status: r.status,
    reviewerNote: r.reviewer_note,
    reviewedBy: r.reviewer_name || r.reviewed_by || null,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listApplications(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 25 });
  const where = [];
  const args = [];
  const status = query.status === 'all' ? null : ['pending', 'info_required', 'approved', 'rejected'].includes(query.status) ? query.status : 'pending';
  if (status) {
    where.push('c.status = ?');
    args.push(status);
  }
  if (query.q) {
    const term = likeTerm(query.q);
    where.push(`(c.legal_name LIKE ? ESCAPE '\\' OR c.contact_email LIKE ? ESCAPE '\\' OR c.company LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\')`);
    args.push(term, term, term, term);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM creator_applications c JOIN accounts a ON a.id = c.account_id LEFT JOIN accounts rv ON rv.id = c.reviewed_by ${clause}`;
  const total = db.get(`SELECT COUNT(*) AS n ${from}`, ...args).n;
  const rows = db.all(
    `SELECT c.*, a.email, a.display_name, a.is_creator, a.status AS account_status, rv.display_name AS reviewer_name
       ${from} ORDER BY c.created_at ${status === 'pending' ? 'ASC' : 'DESC'} LIMIT ? OFFSET ?`,
    ...args, pageSize, offset,
  );
  const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM creator_applications GROUP BY status').map((r) => [r.status, r.n]));
  return { items: rows.map(applicationDto), total, page, pageSize, counts };
}

export function decideApplication(db, ctx, id, { decision, note }) {
  const app = db.get('SELECT * FROM creator_applications WHERE id = ?', id);
  if (!app) throw notFound('That application does not exist.');
  if ((decision === 'reject' || decision === 'info_required') && !note) {
    throw validation({ note: decision === 'reject' ? 'Tell the applicant why (they will see this note).' : 'Say what information you need (the applicant will see this note).' });
  }
  const status = { approve: 'approved', reject: 'rejected', info_required: 'info_required' }[decision];
  const ts = now();
  db.tx(() => {
    db.run(
      'UPDATE creator_applications SET status = ?, reviewer_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ? WHERE id = ?',
      status, note || null, ctx.account.id, ts, ts, id,
    );
    if (decision === 'approve') db.run('UPDATE accounts SET is_creator = 1, updated_at = ? WHERE id = ?', ts, app.account_id);
    const messages = {
      approve: ['Your creator application was approved', 'You can now submit work for review from the creator dashboard.'],
      reject: ['Your creator application was not approved', note || ''],
      info_required: ['More information needed for your creator application', note || ''],
    };
    notify(db, {
      accountId: app.account_id,
      type: 'creator_application',
      title: messages[decision][0],
      body: (decision === 'approve' && note ? `${messages.approve[1]} ${note}` : messages[decision][1]).slice(0, 1000),
      link: decision === 'approve' ? '#/creators/dashboard' : '#/creators',
      data: { applicationId: id, status },
      dedupeKey: `creator_application:${id}:${status}:${ts}`,
    });
  });
  return { before: app.status, after: status, accountId: app.account_id };
}

// ───────────────────────────── Submissions ─────────────────────────────

export const TRANSITIONS = {
  submitted: ['under_review'],
  under_review: ['info_required', 'approved', 'rejected'],
  info_required: ['under_review'],
};

export const statusSchema = v.object({
  status: v.enum(['under_review', 'info_required', 'approved', 'rejected']),
  message: v.string().max(3000).optional(),
  internalNote: v.string().max(3000).optional(),
});

export const commentSchema = v.object({
  message: v.string().min(1).max(3000),
  visibleToCreator: v.boolean().default(false),
});

const STATUS_COPY = {
  under_review: ['is being reviewed', 'A Lumina reviewer has started reviewing your submission.'],
  info_required: ['needs more information', 'A reviewer needs more information before continuing.'],
  approved: ['was approved', 'Your submission was approved. Our team will prepare it for publication — nothing goes live until artwork and licensing are complete.'],
  rejected: ['was not approved', 'After review, this submission was not approved for Lumina.'],
};

function submissionDto(s) {
  return {
    id: s.id,
    accountId: s.account_id,
    creator: s.email !== undefined ? { id: s.account_id, email: s.email, displayName: s.display_name } : undefined,
    projectTitle: s.project_title,
    description: s.description,
    contentType: s.content_type,
    runtimeMin: s.runtime_min,
    genres: parseJson(s.genres, []),
    language: s.language,
    releaseYear: s.release_year,
    country: s.country,
    trailerUrl: s.trailer_url,
    additionalInfo: s.additional_info,
    rights: parseJson(s.rights, {}),
    attestedAt: s.attested_at,
    attestationIp: s.attestation_ip,
    status: s.status,
    statusReason: s.status_reason,
    titleId: s.title_id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    submittedAt: s.submitted_at,
    fileCount: s.file_count,
  };
}

export function listSubmissions(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 25 });
  const where = [];
  const args = [];
  const all = ['draft', 'uploading', 'submitted', 'under_review', 'info_required', 'approved', 'rejected', 'published'];
  const status = query.status || 'queue';
  if (status === 'queue') where.push(`s.status IN ('submitted', 'under_review', 'info_required')`);
  else if (all.includes(status)) {
    where.push('s.status = ?');
    args.push(status);
  } else where.push(`s.status NOT IN ('draft', 'uploading')`); // "all": everything a creator has sent in
  if (query.q) {
    const term = likeTerm(query.q);
    where.push(`(s.project_title LIKE ? ESCAPE '\\' OR a.email LIKE ? ESCAPE '\\' OR a.display_name LIKE ? ESCAPE '\\')`);
    args.push(term, term, term);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM submissions s JOIN accounts a ON a.id = s.account_id ${clause}`;
  const total = db.get(`SELECT COUNT(*) AS n ${from}`, ...args).n;
  const rows = db.all(
    `SELECT s.*, a.email, a.display_name, (SELECT COUNT(*) FROM submission_files f WHERE f.submission_id = s.id) AS file_count
       ${from} ORDER BY COALESCE(s.submitted_at, s.updated_at) ASC LIMIT ? OFFSET ?`,
    ...args, pageSize, offset,
  );
  const counts = Object.fromEntries(db.all('SELECT status, COUNT(*) AS n FROM submissions GROUP BY status').map((r) => [r.status, r.n]));
  return { items: rows.map(submissionDto), total, page, pageSize, counts };
}

function fileDto(f) {
  const probe = parseJson(f.probe, {});
  return {
    id: f.id,
    role: f.role,
    label: f.label,
    originalName: f.original_name,
    mime: f.mime,
    sizeBytes: f.size_bytes,
    sha256: f.sha256,
    scanStatus: f.scan_status,
    probe: summarizeProbe(probe),
    browserPlayable: isBrowserPlayableMp4(probe, f.mime),
    createdAt: f.created_at,
  };
}

export function getSubmission(db, id) {
  const s = db.get('SELECT s.*, a.email, a.display_name FROM submissions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?', id);
  if (!s) throw notFound('That submission does not exist.');
  return s;
}

export function submissionDetail(db, id) {
  const s = getSubmission(db, id);
  const files = db.all('SELECT * FROM submission_files WHERE submission_id = ? ORDER BY created_at', id);
  const events = db.all(
    `SELECT e.*, a.display_name AS actor_name, a.role AS actor_role FROM submission_events e LEFT JOIN accounts a ON a.id = e.actor_account_id
      WHERE e.submission_id = ? ORDER BY e.created_at, e.id`, id,
  );
  const title = s.title_id ? db.get('SELECT id, title, status FROM titles WHERE id = ?', s.title_id) : null;
  const application = db.get('SELECT id, status, legal_name, company, country FROM creator_applications WHERE account_id = ? ORDER BY created_at DESC LIMIT 1', s.account_id);
  const responded = hasResponded(events);
  return {
    submission: submissionDto(s),
    files: files.map(fileDto),
    events: events.map((e) => ({
      id: e.id,
      kind: e.kind,
      fromStatus: e.from_status,
      toStatus: e.to_status,
      message: e.message,
      visibleToCreator: !!e.visible_to_creator,
      actor: e.actor_account_id ? { id: e.actor_account_id, name: e.actor_name, isStaff: e.actor_role === 'admin' || e.actor_role === 'moderator' } : null,
      createdAt: e.created_at,
    })),
    title: title ? { id: title.id, title: title.title, status: title.status } : null,
    application: application ? { id: application.id, status: application.status, legalName: application.legal_name, company: application.company, country: application.country } : null,
    allowedTransitions: allowedTransitions(s.status, responded),
    awaitingCreatorResponse: s.status === 'info_required' && !responded,
  };
}

/** True when the creator answered the latest information request (event ids are monotonic). */
function hasResponded(events) {
  const lastRequest = events.filter((e) => e.kind === 'info_request').reduce((max, e) => Math.max(max, e.id), -1);
  return lastRequest >= 0 && events.some((e) => e.kind === 'info_response' && e.id > lastRequest);
}

function allowedTransitions(status, responded) {
  if (status === 'info_required' && !responded) return [];
  return TRANSITIONS[status] || [];
}

function addEvent(db, { submissionId, actorId, kind, from = null, to = null, message = null, visible = true }) {
  db.run(
    `INSERT INTO submission_events (submission_id, actor_account_id, kind, from_status, to_status, message, visible_to_creator, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    submissionId, actorId, kind, from, to, message, visible ? 1 : 0, now(),
  );
}

export function changeSubmissionStatus(db, ctx, id, { status, message, internalNote }) {
  const s = getSubmission(db, id);
  const responded = hasResponded(db.all('SELECT id, kind FROM submission_events WHERE submission_id = ?', id));
  if (!(TRANSITIONS[s.status] || []).includes(status)) {
    throw conflict(`A submission that is ${s.status.replace('_', ' ')} cannot move to ${status.replace('_', ' ')}.`, 'INVALID_TRANSITION', { from: s.status, allowed: TRANSITIONS[s.status] || [] });
  }
  if (s.status === 'info_required' && !responded) throw conflict('The creator has not responded to the information request yet.', 'AWAITING_CREATOR');
  if ((status === 'info_required' || status === 'rejected') && !message) {
    throw validation({ message: status === 'rejected' ? 'Explain the decision — the creator will see this message.' : 'Say what you need — the creator will see this message.' });
  }
  const ts = now();
  db.tx(() => {
    db.run('UPDATE submissions SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', status, ['info_required', 'rejected'].includes(status) ? message : null, ts, id);
    addEvent(db, { submissionId: id, actorId: ctx.account.id, kind: status === 'info_required' ? 'info_request' : 'status', from: s.status, to: status, message: message || null, visible: true });
    if (internalNote) addEvent(db, { submissionId: id, actorId: ctx.account.id, kind: 'comment', message: internalNote, visible: false });
    const [phrase, fallback] = STATUS_COPY[status];
    notify(db, {
      accountId: s.account_id,
      type: 'submission_update',
      title: `“${s.project_title}” ${phrase}`,
      body: (message || fallback).slice(0, 1000),
      link: `#/creators/submissions/${id}`,
      data: { submissionId: id, status },
      dedupeKey: `submission:${id}:${status}:${ts}`,
    });
  });
  return { before: s.status, after: status, creatorId: s.account_id };
}

export function addSubmissionComment(db, ctx, id, { message, visibleToCreator }) {
  const s = getSubmission(db, id);
  db.tx(() => {
    addEvent(db, { submissionId: id, actorId: ctx.account.id, kind: 'comment', message, visible: visibleToCreator });
    if (visibleToCreator) {
      notify(db, {
        accountId: s.account_id,
        type: 'submission_update',
        title: `New message about “${s.project_title}”`,
        body: message.slice(0, 1000),
        link: `#/creators/submissions/${id}`,
        data: { submissionId: id },
        dedupeKey: `submission:${id}:comment:${Date.now()}`,
      });
    }
  });
}

export function getSubmissionFile(db, submissionId, fileId) {
  const f = db.get('SELECT * FROM submission_files WHERE id = ? AND submission_id = ?', fileId, submissionId);
  if (!f) throw notFound('That file does not exist.');
  return f;
}

/**
 * Creates a DRAFT title (and media rows) from an approved submission.
 *   options.enqueue: enqueueTranscode(db, { mediaId, sourceKey }) from
 *   server/services/media/queue.js when ffmpeg is configured, otherwise null.
 * Returns { titleId, media: [{id, role, kind, status, episodeId, file, note}], warnings }.
 */
export async function publishSubmission(db, ctx, id, { enqueue = null } = {}) {
  const s = getSubmission(db, id);
  if (s.status !== 'approved') throw conflict('Only approved submissions can be turned into a catalog title.', 'NOT_APPROVED', { status: s.status });
  if (s.title_id && db.get('SELECT 1 FROM titles WHERE id = ?', s.title_id)) {
    throw conflict('A title already exists for this submission.', 'TITLE_EXISTS', { titleId: s.title_id });
  }
  const files = db.all('SELECT * FROM submission_files WHERE submission_id = ? ORDER BY created_at', id);
  const videoFiles = files.filter((f) => ['feature', 'episode', 'trailer'].includes(f.role));
  const infected = videoFiles.filter((f) => f.scan_status === 'infected');
  if (infected.length) throw conflict('A file in this submission failed the malware scan.', 'FILE_INFECTED');
  const isSeries = s.content_type === 'series' || (s.content_type === 'episode') || files.some((f) => f.role === 'episode');
  const type = isSeries ? 'series' : 'movie';
  const exists = (tid) => !!db.get('SELECT 1 FROM titles WHERE id = ?', tid);
  const titleId = uniqueId(slugify(s.project_title), exists);
  const ts = now();
  const genres = parseJson(s.genres, []);
  const tags = ['creator-submission'];
  if (['short', 'documentary', 'pilot'].includes(s.content_type)) tags.push(s.content_type);
  const warnings = [];
  const created = [];
  const jobs = [];

  db.tx(() => {
    db.run(
      `INSERT INTO titles (id, type, title, synopsis, year, runtime_min, age_rating, rating_source, min_age, genres, tags, countries, original_language,
                           credits, license, status, creator_account_id, submission_id, added_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'NR', 'advisory', 18, ?, ?, ?, ?, ?, '{}', 'draft', ?, ?, ?, ?)`,
      titleId, type, s.project_title, s.description || '', s.release_year ?? null, s.runtime_min ?? null, toJson(genres), toJson(tags),
      toJson(s.country ? [String(s.country).toUpperCase().slice(0, 2)] : []), s.language || null,
      toJson({ directors: [], cast: [], crew: [] }), s.account_id, id, ts, ts,
    );
    let episodeNo = 0;
    for (const f of videoFiles) {
      let episodeId = null;
      const role = f.role === 'trailer' ? 'trailer' : 'main';
      if (type === 'series' && f.role !== 'trailer') {
        episodeNo++;
        if (episodeNo === 1) db.run('INSERT INTO seasons (id, title_id, number) VALUES (?, ?, 1)', `${titleId}-s1`, titleId);
        episodeId = `${titleId}-s1e${episodeNo}`;
        db.run(
          `INSERT INTO episodes (id, title_id, season_number, number, name, synopsis, runtime_min) VALUES (?, ?, 1, ?, ?, '', ?)`,
          episodeId, titleId, episodeNo, f.label || `Episode ${episodeNo}`, null,
        );
      } else if (type === 'movie' && role === 'main' && created.some((c) => c.role === 'main')) {
        warnings.push(`${f.original_name}: a film has one main video; this extra feature file was not attached.`);
        continue;
      }
      const mediaId = newId('med');
      const probe = parseJson(f.probe, {});
      const summary = summarizeProbe(probe);
      let kind;
      let source;
      let status;
      let note;
      let resolutions = [];
      let verifiedAt = null;
      if (enqueue) {
        kind = 'hls';
        source = `storage:media/${mediaId}/master.m3u8`;
        status = 'processing';
        note = 'Queued for transcoding to an HLS ladder.';
        jobs.push({ mediaId, sourceKey: f.storage_key });
      } else if (isBrowserPlayableMp4(probe, f.mime)) {
        kind = 'progressive';
        source = `storage:${f.storage_key}`;
        status = 'ready';
        note = 'Browser-playable MP4 (H.264/AAC) served as a single progressive file. Transcoding is not configured.';
        if (summary?.height) {
          resolutions = [summary.height];
          verifiedAt = ts; // measured by the upload probe
        }
      } else {
        kind = 'progressive';
        source = `storage:${f.storage_key}`;
        status = 'failed';
        note = 'Not browser-playable (needs H.264/AAC MP4) and transcoding is not configured. Configure FFMPEG_PATH and transcode it.';
        warnings.push(`${f.original_name}: ${note}`);
      }
      db.run(
        `INSERT INTO media (id, title_id, episode_id, role, label, kind, source, resolutions, video_codecs, duration_s, status, verified_at, verify_report, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mediaId, titleId, episodeId, role, f.label || f.original_name, kind, source, toJson(resolutions),
        toJson(summary?.videoCodec && status === 'ready' ? [summary.videoCodec === 'h264' ? 'H.264' : summary.videoCodec] : []),
        summary?.durationS ?? null, status, verifiedAt,
        toJson(verifiedAt ? { ok: true, checkedAt: ts, kind: 'progressive', note: 'From the upload probe.', probes: [summary] } : { note }), ts, ts,
      );
      created.push({ id: mediaId, role, kind, status, episodeId, file: f.original_name, note });
    }
    if (!videoFiles.length) warnings.push('This submission has no video files; add media to the title before publishing.');
    db.run('UPDATE submissions SET title_id = ?, updated_at = ? WHERE id = ?', titleId, ts, id);
    addEvent(db, { submissionId: id, actorId: ctx.account.id, kind: 'comment', message: `Draft title “${titleId}” created for publication. ${warnings.join(' ')}`.trim(), visible: false });
  });

  for (const job of jobs) {
    try {
      await enqueue(db, job);
    } catch (err) {
      db.run(`UPDATE media SET status = 'failed', verify_report = ?, updated_at = ? WHERE id = ?`, toJson({ note: `Could not queue transcoding: ${err.message}` }), now(), job.mediaId);
      warnings.push(`Could not queue transcoding for ${job.mediaId}: ${err.message}`);
    }
  }
  return { titleId, media: created, warnings };
}

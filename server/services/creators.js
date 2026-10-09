// Creator applications and submissions (owner side). Staff decisions — approving creators,
// moving submissions past 'submitted', publishing — live in the admin API. Nothing here
// publishes anything: the furthest a creator can move their own work is 'submitted'.
import { now, parseJson, placeholders, toJson } from '../db/index.js';
import { newId } from '../lib/crypto.js';
import { conflict, notFound, validation } from '../lib/errors.js';
import { audit } from './audit.js';
import { notify } from './notifications.js';
import { removeKey } from './storage.js';

export const SUBMISSION_STATUSES = ['draft', 'uploading', 'submitted', 'under_review', 'info_required', 'approved', 'rejected', 'published'];
export const CONTENT_TYPES = ['movie', 'short', 'documentary', 'pilot', 'series', 'episode', 'trailer'];
export const FILE_ROLES = ['feature', 'episode', 'trailer', 'poster', 'backdrop', 'document', 'subtitle'];
/** States in which the creator may edit details, attest, upload and remove files. */
export const EDITABLE_STATUSES = ['draft', 'uploading', 'info_required'];
/** States in which the creator may delete the whole submission. */
export const DELETABLE_STATUSES = ['draft', 'uploading', 'rejected'];
export const DISTRIBUTION_RIGHTS = ['owner', 'exclusive_license', 'non_exclusive_license'];
export const CLEARANCE_ANSWERS = ['yes', 'no', 'not_applicable'];

export function applicationDto(a) {
  if (!a) return null;
  return {
    id: a.id,
    legalName: a.legal_name,
    contactEmail: a.contact_email,
    company: a.company,
    website: a.website,
    portfolio: a.portfolio,
    country: a.country,
    bio: a.bio,
    status: a.status,
    reviewerNote: a.status === 'info_required' || a.status === 'rejected' ? a.reviewer_note : null,
    reviewedAt: a.reviewed_at,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

export function submissionDto(s, extra = {}) {
  return {
    id: s.id,
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
    status: s.status,
    statusReason: s.status_reason,
    titleId: s.title_id,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
    submittedAt: s.submitted_at,
    editable: EDITABLE_STATUSES.includes(s.status),
    ...extra,
  };
}

export function fileDto(f) {
  return {
    id: f.id,
    role: f.role,
    label: f.label,
    originalName: f.original_name,
    mime: f.mime,
    sizeBytes: f.size_bytes,
    sha256: f.sha256,
    probe: parseJson(f.probe, {}),
    scanStatus: f.scan_status,
    createdAt: f.created_at,
  };
}

export function eventDto(e, viewerAccountId) {
  return {
    id: e.id,
    kind: e.kind,
    fromStatus: e.from_status,
    toStatus: e.to_status,
    message: e.message,
    by: e.actor_account_id && e.actor_account_id === viewerAccountId ? 'you' : 'lumina',
    createdAt: e.created_at,
  };
}

export function addEvent(db, { submissionId, actorId = null, kind, from = null, to = null, message = null, visible = true }) {
  db.run(
    `INSERT INTO submission_events (submission_id, actor_account_id, kind, from_status, to_status, message, visible_to_creator, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    submissionId, actorId, kind, from, to, message, visible ? 1 : 0, now(),
  );
}

/**
 * Keeps a submission's status in step with its uploads: 'uploading' while any upload is in
 * progress, back to 'draft' when none are. Other states (e.g. info_required) are left alone.
 */
export function syncUploadState(db, submissionId) {
  if (!submissionId) return;
  const active = db.get(`SELECT COUNT(*) AS n FROM uploads WHERE submission_id = ? AND status = 'in_progress'`, submissionId).n;
  const ts = now();
  if (active) db.run(`UPDATE submissions SET status = 'uploading', updated_at = ? WHERE id = ? AND status = 'draft'`, ts, submissionId);
  else db.run(`UPDATE submissions SET status = 'draft', updated_at = ? WHERE id = ? AND status = 'uploading'`, ts, submissionId);
}

export class CreatorService {
  constructor(db) {
    this.db = db;
  }

  // ───────────── Applications ─────────────

  me(ctx) {
    const app = this.db.get('SELECT * FROM creator_applications WHERE account_id = ? ORDER BY created_at DESC LIMIT 1', ctx.account.id);
    return { isCreator: !!ctx.account.is_creator, application: applicationDto(app) };
  }

  apply(ctx, input) {
    if (ctx.account.is_creator) throw conflict('Your account is already a verified creator.', 'ALREADY_CREATOR');
    const ts = now();
    const open = this.db.get(`SELECT * FROM creator_applications WHERE account_id = ? AND status IN ('pending', 'info_required')`, ctx.account.id);
    const values = [input.legalName, input.contactEmail, input.company ?? null, input.website ?? null, input.portfolio ?? null, input.country ?? null, input.bio];
    let id;
    if (open?.status === 'pending') throw conflict('Your application is already waiting for review.', 'APPLICATION_EXISTS');
    if (open) {
      // Answering a request for more information re-opens the same application.
      id = open.id;
      this.db.run(
        `UPDATE creator_applications SET legal_name = ?, contact_email = ?, company = ?, website = ?, portfolio = ?, country = ?, bio = ?, status = 'pending', updated_at = ?
          WHERE id = ? AND account_id = ? AND status = 'info_required'`,
        ...values, ts, id, ctx.account.id,
      );
    } else {
      id = newId('app');
      try {
        this.db.run(
          `INSERT INTO creator_applications (id, account_id, legal_name, contact_email, company, website, portfolio, country, bio, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`,
          id, ctx.account.id, ...values, ts, ts,
        );
      } catch (err) {
        if (/UNIQUE/i.test(err.message)) throw conflict('Your application is already waiting for review.', 'APPLICATION_EXISTS');
        throw err;
      }
    }
    audit(this.db, ctx, open ? 'creator.application_updated' : 'creator.application_submitted', { targetType: 'creator_application', targetId: id });
    return { application: applicationDto(this.db.get('SELECT * FROM creator_applications WHERE id = ?', id)) };
  }

  // ───────────── Submissions ─────────────

  /** The caller's own submission, or 404 (never reveals other creators' work). */
  own(ctx, id) {
    const s = this.db.get('SELECT * FROM submissions WHERE id = ? AND account_id = ?', id, ctx.account.id);
    if (!s) throw notFound('We could not find that submission.');
    return s;
  }

  list(ctx) {
    const rows = this.db.all('SELECT * FROM submissions WHERE account_id = ? ORDER BY updated_at DESC', ctx.account.id);
    if (!rows.length) return { items: [] };
    const ids = rows.map((r) => r.id);
    const counts = new Map(this.db.all(`SELECT submission_id, COUNT(*) AS n FROM submission_files WHERE submission_id IN (${placeholders(ids.length)}) GROUP BY submission_id`, ...ids).map((r) => [r.submission_id, r.n]));
    return { items: rows.map((r) => submissionDto(r, { fileCount: counts.get(r.id) || 0 })) };
  }

  create(ctx, input) {
    const id = newId('sub');
    const ts = now();
    this.db.tx(() => {
      this.db.run(
        `INSERT INTO submissions (id, account_id, project_title, description, content_type, runtime_min, genres, language, release_year, country, trailer_url, additional_info, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
        id, ctx.account.id, input.projectTitle, input.description ?? '', input.contentType, input.runtimeMin ?? null, toJson(input.genres ?? []),
        input.language ?? null, input.releaseYear ?? null, input.country ?? null, input.trailerUrl ?? null, input.additionalInfo ?? null, ts, ts,
      );
      addEvent(this.db, { submissionId: id, actorId: ctx.account.id, kind: 'status', to: 'draft', message: 'Draft created.' });
    });
    return { submission: submissionDto(this.own(ctx, id)) };
  }

  detail(ctx, id) {
    const s = this.own(ctx, id);
    const files = this.db.all('SELECT * FROM submission_files WHERE submission_id = ? ORDER BY created_at', id).map(fileDto);
    const events = this.db.all('SELECT * FROM submission_events WHERE submission_id = ? AND visible_to_creator = 1 ORDER BY created_at, id', id).map((e) => eventDto(e, ctx.account.id));
    const uploads = this.db.all(`SELECT id, filename, file_role, size_bytes, offset_bytes, created_at, expires_at FROM uploads WHERE submission_id = ? AND account_id = ? AND status = 'in_progress' ORDER BY created_at`, id, ctx.account.id)
      .map((u) => ({ id: u.id, filename: u.filename, role: u.file_role, size: u.size_bytes, offset: u.offset_bytes, createdAt: u.created_at, expiresAt: u.expires_at }));
    return { submission: submissionDto(s), files, events, uploads };
  }

  assertEditable(s) {
    if (!EDITABLE_STATUSES.includes(s.status)) {
      throw conflict(`This submission is ${s.status.replace('_', ' ')} and can no longer be changed.`, 'SUBMISSION_LOCKED', { status: s.status });
    }
  }

  update(ctx, id, input) {
    const s = this.own(ctx, id);
    this.assertEditable(s);
    const map = {
      projectTitle: 'project_title', description: 'description', contentType: 'content_type', runtimeMin: 'runtime_min', genres: 'genres',
      language: 'language', releaseYear: 'release_year', country: 'country', trailerUrl: 'trailer_url', additionalInfo: 'additional_info',
    };
    const sets = [];
    const params = [];
    for (const [key, col] of Object.entries(map)) {
      if (!(key in input)) continue;
      sets.push(`${col} = ?`);
      params.push(key === 'genres' ? toJson(input[key] ?? []) : key === 'description' ? input[key] ?? '' : input[key] ?? null);
    }
    if (sets.length) {
      const r = this.db.run(`UPDATE submissions SET ${sets.join(', ')}, updated_at = ? WHERE id = ? AND account_id = ? AND status IN ('draft', 'uploading', 'info_required')`, ...params, now(), id, ctx.account.id);
      if (!r.changes) throw conflict('This submission can no longer be changed.', 'SUBMISSION_LOCKED');
    }
    return { submission: submissionDto(this.own(ctx, id)) };
  }

  async remove(ctx, id) {
    const s = this.own(ctx, id);
    if (!DELETABLE_STATUSES.includes(s.status)) {
      throw conflict('Submissions under review cannot be deleted. Contact the Lumina team if you need to withdraw it.', 'SUBMISSION_LOCKED', { status: s.status });
    }
    const partials = this.db.all(`SELECT storage_key FROM uploads WHERE submission_id = ? AND status = 'in_progress'`, id);
    const r = this.db.run(`DELETE FROM submissions WHERE id = ? AND account_id = ? AND status IN ('draft', 'uploading', 'rejected')`, id, ctx.account.id);
    if (!r.changes) throw notFound('We could not find that submission.');
    for (const p of partials) await removeKey(p.storage_key).catch(() => {});
    await removeKey(`submissions/${id}`).catch(() => {});
    audit(this.db, ctx, 'creator.submission_deleted', { targetType: 'submission', targetId: id, details: { projectTitle: s.project_title } });
  }

  async removeFile(ctx, id, fileId) {
    const s = this.own(ctx, id);
    this.assertEditable(s);
    const f = this.db.get('SELECT * FROM submission_files WHERE id = ? AND submission_id = ?', fileId, id);
    if (!f) throw notFound('We could not find that file.');
    this.db.tx(() => {
      this.db.run('DELETE FROM submission_files WHERE id = ? AND submission_id = ?', fileId, id);
      addEvent(this.db, { submissionId: id, actorId: ctx.account.id, kind: 'file', message: `Removed “${f.original_name}” (${f.role}).` });
      this.db.run('UPDATE submissions SET updated_at = ? WHERE id = ?', now(), id);
    });
    await removeKey(f.storage_key).catch(() => {});
  }

  attest(ctx, id, { rights, confirm }, ip) {
    const s = this.own(ctx, id);
    this.assertEditable(s);
    if (confirm !== true) throw validation({ confirm: 'Confirm that you hold these rights to continue.' });
    const ts = now();
    const clean = {
      copyrightOwner: rights.copyrightOwner,
      distributionRights: rights.distributionRights,
      territories: rights.territories,
      restrictions: rights.restrictions ?? null,
      musicCleared: rights.musicCleared,
      footageCleared: rights.footageCleared,
      documentationNotes: rights.documentationNotes ?? null,
    };
    this.db.tx(() => {
      this.db.run(
        `UPDATE submissions SET rights = ?, attested_at = ?, attestation_ip = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status IN ('draft', 'uploading', 'info_required')`,
        toJson(clean), ts, ip || null, ts, id, ctx.account.id,
      );
      addEvent(this.db, { submissionId: id, actorId: ctx.account.id, kind: 'comment', message: 'Rights and ownership confirmed.' });
    });
    audit(this.db, ctx, 'creator.rights_attested', { targetType: 'submission', targetId: id, details: { copyrightOwner: clean.copyrightOwner, distributionRights: clean.distributionRights } });
    return { submission: submissionDto(this.own(ctx, id)) };
  }

  /** What is still missing before a submission can be sent for review. { field: message } */
  missingForSubmit(s) {
    const missing = {};
    if (!s.project_title?.trim()) missing.projectTitle = 'Add a project title.';
    if (!s.description || s.description.trim().length < 20) missing.description = 'Describe the project in at least 20 characters.';
    if (!s.runtime_min) missing.runtimeMin = 'Add the runtime.';
    if (!s.language) missing.language = 'Add the original language.';
    if (!s.attested_at) missing.rights = 'Complete the rights and ownership step.';
    const roles = s.content_type === 'trailer' ? ['feature', 'episode', 'trailer'] : ['feature', 'episode'];
    const main = this.db.get(`SELECT COUNT(*) AS n FROM submission_files WHERE submission_id = ? AND role IN (${placeholders(roles.length)}) AND scan_status != 'infected'`, s.id, ...roles).n;
    if (!main) missing.files = s.content_type === 'trailer' ? 'Upload the trailer or video file.' : 'Upload at least one feature or episode file.';
    const active = this.db.get(`SELECT COUNT(*) AS n FROM uploads WHERE submission_id = ? AND status = 'in_progress'`, s.id).n;
    if (active) missing.uploads = 'Wait for your uploads to finish (or cancel them) before submitting.';
    return missing;
  }

  submit(ctx, id) {
    const s = this.own(ctx, id);
    if (!['draft', 'uploading'].includes(s.status)) {
      throw conflict(s.status === 'info_required' ? 'Send your response to the reviewer’s request instead.' : 'This submission has already been sent.', 'SUBMISSION_LOCKED', { status: s.status });
    }
    const missing = this.missingForSubmit(s);
    if (Object.keys(missing).length) throw validation(missing);
    const ts = now();
    this.db.tx(() => {
      const r = this.db.run(`UPDATE submissions SET status = 'submitted', submitted_at = ?, status_reason = NULL, updated_at = ? WHERE id = ? AND account_id = ? AND status = ?`, ts, ts, id, ctx.account.id, s.status);
      if (!r.changes) throw conflict('This submission changed while you were submitting it. Refresh and try again.', 'CONFLICT');
      addEvent(this.db, { submissionId: id, actorId: ctx.account.id, kind: 'status', from: s.status, to: 'submitted', message: 'Submitted for review.' });
    });
    audit(this.db, ctx, 'creator.submission_submitted', { targetType: 'submission', targetId: id });
    notify(this.db, {
      accountId: ctx.account.id,
      type: 'submission_update',
      title: `“${s.project_title}” was submitted`,
      body: 'The Lumina team will review your files and rights documentation. We will let you know if anything else is needed.',
      link: `#/creators/submissions/${id}`,
      data: { submissionId: id, status: 'submitted' },
      dedupeKey: `submission:${id}:submitted:${ts}`,
    });
    return { submission: submissionDto(this.own(ctx, id)) };
  }

  respond(ctx, id, message) {
    const s = this.own(ctx, id);
    if (s.status !== 'info_required') throw conflict('The Lumina team has not asked for more information on this submission.', 'SUBMISSION_LOCKED', { status: s.status });
    // Responding locks the submission, so a file still on its way would be refused at the end.
    const active = this.db.get(`SELECT COUNT(*) AS n FROM uploads WHERE submission_id = ? AND status = 'in_progress'`, id).n;
    if (active) {
      throw conflict(`Wait for your ${active === 1 ? 'upload' : `${active} uploads`} to finish (or cancel ${active === 1 ? 'it' : 'them'}) before you send your response.`, 'UPLOADS_IN_PROGRESS', { uploads: active });
    }
    const ts = now();
    this.db.tx(() => {
      const r = this.db.run(`UPDATE submissions SET status = 'submitted', updated_at = ? WHERE id = ? AND account_id = ? AND status = 'info_required'`, ts, id, ctx.account.id);
      if (!r.changes) throw conflict('This submission changed while you were responding. Refresh and try again.', 'CONFLICT');
      addEvent(this.db, { submissionId: id, actorId: ctx.account.id, kind: 'info_response', from: 'info_required', to: 'submitted', message });
    });
    audit(this.db, ctx, 'creator.submission_responded', { targetType: 'submission', targetId: id });
    return { submission: submissionDto(this.own(ctx, id)) };
  }

  /** Titles linked to the creator's submissions, with honest (measured) stats. */
  titles(ctx) {
    const rows = this.db.all(
      `SELECT DISTINCT t.id, t.title, t.type, t.poster, t.backdrop, t.status, t.published_at, s.id AS submission_id
         FROM titles t LEFT JOIN submissions s ON s.title_id = t.id AND s.account_id = ?
        WHERE s.id IS NOT NULL OR t.creator_account_id = ?
        ORDER BY COALESCE(t.published_at, t.added_at) DESC`,
      ctx.account.id, ctx.account.id,
    );
    const seen = new Set();
    const items = [];
    for (const t of rows) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      const viewers = this.db.get('SELECT COUNT(DISTINCT profile_id) AS n FROM history WHERE title_id = ?', t.id).n;
      const rating = this.db.get(`SELECT AVG(rating) AS avg, COUNT(*) AS n, SUM(CASE WHEN body IS NOT NULL THEN 1 ELSE 0 END) AS written FROM reviews WHERE title_id = ? AND status = 'visible'`, t.id);
      items.push({
        id: t.id,
        title: t.title,
        type: t.type,
        poster: t.poster,
        backdrop: t.backdrop,
        status: t.status,
        publishedAt: t.published_at,
        submissionId: t.submission_id,
        stats: {
          viewers,
          memberRating: rating.n ? { average: Math.round(rating.avg * 10) / 10, count: rating.n } : null,
          reviewCount: rating.written || 0,
        },
      });
    }
    return { items };
  }
}

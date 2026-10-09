// Administration API (/api/admin/*). Every route is guarded by requireStaff (moderator or
// admin with a recent re-authentication) or requireAdmin; every mutation is audited; the
// catalog read model is invalidated after any content or media change.
//
// Admin-only: deleting content (titles, episodes, seasons, media), role/profile-limit/creator
// changes (enforced in services/admin/users.js), taxonomy and platform settings, publishing a
// submission, the full audit log and server logs.
import { ROOT } from '../config.js';
import { now } from '../db/index.js';
import { requireAdmin, requireStaff } from '../auth/session.js';
import { HttpError, validation } from '../lib/errors.js';
import { log } from '../lib/log.js';
import { rateLimit } from '../lib/security.js';
import { v } from '../lib/validate.js';
import { audit } from '../services/audit.js';
import { accountDto } from '../services/dto.js';
import { notify } from '../services/notifications.js';
import { signedUrl } from '../services/storage.js';
import { allowedMediaOrigins, languageLabel, mediaRefProblem } from '../services/admin/common.js';
import {
  adminTitle, applyVerification, createEpisode, createMedia, createSeason, createTitle, deleteEpisode, deleteMedia, deleteSeason, deleteTitle,
  episodeDto, episodeSchema, getMediaRow, getTaxonomy, listMedia, listTitles, mediaDto, mediaPatchSchema, mediaSchema, publishTitle,
  seasonSchema, storageSourceProblem, taxonomySchema, titlePatchSchema, titleSchema, unpublishTitle, updateEpisode, updateMedia, updateSeason, updateTitle,
} from '../services/admin/content.js';
import { verifyMedia } from '../services/admin/media-verify.js';
import {
  listReportGroups, listReviews, moderationHistory, resolveReport, resolveSchema, reviewStatusSchema, setCommentStatus, setReviewStatus,
} from '../services/admin/moderation.js';
import { listUsers, revokeSessions, updateUser, userDetail, userPatchSchema } from '../services/admin/users.js';
import {
  addSubmissionComment, changeSubmissionStatus, commentSchema, decideApplication, decisionSchema, getSubmissionFile, listApplications,
  listSubmissions, publishSubmission, statusSchema, submissionDetail,
} from '../services/admin/submissions.js';
import {
  announcementSchema, auditLog, createAnnouncement, deleteAnnouncement, health, listAnnouncements, logs, overview, playbackErrors,
  qualityReports, qualityStatusSchema, setQualityStatus, usage,
} from '../services/admin/platform.js';
import { describeSettings, getSetting, readPlatformSettings, setSetting } from '../services/admin/settings.js';
import { searchTmdb, tmdbDetails } from '../services/admin/tmdb.js';

/**
 * Loads a module another slice provides (media probe, transcode queue). Returns null when it
 * is not installed so the dashboard can say "unavailable" instead of failing.
 */
async function optionalModule(rel) {
  const url = new URL(rel, import.meta.url);
  try {
    return await import(url.href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(rel.split('/').pop())) return null;
    log.error('optional module failed to load', { module: rel, err });
    return null;
  }
}

const settingsSchema = v.object({
  maintenanceMessage: v.string().max(500).nullable().optional(),
  registrationOpen: v.boolean().optional(),
  reviewCommentsEnabled: v.boolean().optional(),
  watchPartiesEnabled: v.boolean().optional(),
});

const commentStatusSchema = v.object({ status: v.enum(['visible', 'hidden', 'removed']), note: v.string().max(1000).optional() });
const transcodeSchema = v.object({ sourceKey: v.string().max(500).optional() });

export default function register(app, { db, services, config }) {
  const { catalog } = services;
  const staff = requireStaff;
  const admin = requireAdmin;
  const isAdmin = (ctx) => ctx.account.role === 'admin';

  // ───────────── Identity & overview ─────────────
  app.get('/api/admin/me', ...staff, (ctx) => ({
    account: accountDto(ctx.account),
    elevatedUntil: ctx.session.elevatedUntil,
    serverTime: now(),
    requireTotp: config.auth.adminRequire2fa,
    permissions: {
      admin: isAdmin(ctx),
      changeRoles: isAdmin(ctx),
      deleteContent: isAdmin(ctx),
      settings: isAdmin(ctx),
      auditLog: isAdmin(ctx),
      serverLogs: isAdmin(ctx),
      publishSubmissions: isAdmin(ctx),
    },
  }));

  app.get('/api/admin/overview', ...staff, () => overview(db, config));

  // ───────────── Titles ─────────────
  app.get('/api/admin/titles', ...staff, (ctx) => listTitles(db, ctx.query));

  app.post('/api/admin/titles', ...staff, async (ctx) => {
    const input = v.parse(titleSchema, await ctx.body());
    const id = createTitle(db, input);
    audit(db, ctx, 'content.title_create', { targetType: 'title', targetId: id, details: { title: input.title, type: input.type } });
    catalog.invalidate();
    return adminTitle(db, id);
  });

  app.get('/api/admin/titles/:id', ...staff, (ctx) => adminTitle(db, ctx.params.id));

  app.patch('/api/admin/titles/:id', ...staff, async (ctx) => {
    const patch = v.parse(titlePatchSchema, await ctx.body());
    const { changed } = updateTitle(db, ctx.params.id, patch);
    if (changed.length) audit(db, ctx, 'content.title_update', { targetType: 'title', targetId: ctx.params.id, details: { changed } });
    catalog.invalidate();
    return adminTitle(db, ctx.params.id);
  });

  app.delete('/api/admin/titles/:id', ...admin, (ctx) => {
    const row = deleteTitle(db, ctx.params.id);
    audit(db, ctx, 'content.title_delete', { targetType: 'title', targetId: row.id, details: { title: row.title, type: row.type, status: row.status } });
    catalog.invalidate();
    return { ok: true };
  });

  app.post('/api/admin/titles/:id/publish', ...staff, (ctx) => {
    const result = publishTitle(db, ctx, ctx.params.id);
    audit(db, ctx, 'content.title_publish', { targetType: 'title', targetId: ctx.params.id, details: { notified: result.notified, submissionId: result.submission?.id || null } });
    catalog.invalidate();
    return { ...adminTitle(db, ctx.params.id), notified: result.notified };
  });

  app.post('/api/admin/titles/:id/unpublish', ...staff, (ctx) => {
    unpublishTitle(db, ctx.params.id);
    audit(db, ctx, 'content.title_unpublish', { targetType: 'title', targetId: ctx.params.id });
    catalog.invalidate();
    return adminTitle(db, ctx.params.id);
  });

  // ───────────── Seasons & episodes ─────────────
  app.post('/api/admin/titles/:id/seasons', ...staff, async (ctx) => {
    const input = v.parse(seasonSchema, await ctx.body());
    const season = createSeason(db, ctx.params.id, input);
    audit(db, ctx, 'content.season_create', { targetType: 'season', targetId: season.id, details: { titleId: ctx.params.id, number: season.number } });
    catalog.invalidate();
    return { season };
  });

  app.patch('/api/admin/seasons/:id', ...staff, async (ctx) => {
    const patch = v.parse(seasonSchema.partial(), await ctx.body());
    const season = updateSeason(db, ctx.params.id, patch);
    audit(db, ctx, 'content.season_update', { targetType: 'season', targetId: season.id, details: { titleId: season.title_id, fields: Object.keys(patch) } });
    catalog.invalidate();
    return { season };
  });

  app.delete('/api/admin/seasons/:id', ...admin, (ctx) => {
    const { season, episodesDeleted } = deleteSeason(db, ctx.params.id);
    audit(db, ctx, 'content.season_delete', { targetType: 'season', targetId: season.id, details: { titleId: season.title_id, number: season.number, episodesDeleted } });
    catalog.invalidate();
    return { ok: true, episodesDeleted };
  });

  app.post('/api/admin/titles/:id/episodes', ...staff, async (ctx) => {
    const input = v.parse(episodeSchema, await ctx.body());
    const ep = createEpisode(db, ctx.params.id, input);
    audit(db, ctx, 'content.episode_create', { targetType: 'episode', targetId: ep.id, details: { titleId: ctx.params.id, season: ep.season_number, number: ep.number } });
    catalog.invalidate();
    return { episode: episodeDto(ep) };
  });

  app.patch('/api/admin/episodes/:id', ...staff, async (ctx) => {
    const patch = v.parse(episodeSchema.partial(), await ctx.body());
    const ep = updateEpisode(db, ctx.params.id, patch);
    audit(db, ctx, 'content.episode_update', { targetType: 'episode', targetId: ep.id, details: { titleId: ep.title_id, fields: Object.keys(patch) } });
    catalog.invalidate();
    return { episode: episodeDto(ep) };
  });

  app.delete('/api/admin/episodes/:id', ...admin, (ctx) => {
    const ep = deleteEpisode(db, ctx.params.id);
    audit(db, ctx, 'content.episode_delete', { targetType: 'episode', targetId: ep.id, details: { titleId: ep.title_id, name: ep.name } });
    catalog.invalidate();
    return { ok: true };
  });

  // ───────────── Media ─────────────
  const verifyEnv = () => ({
    root: ROOT,
    storageRoot: config.storageDir,
    allowedOrigins: allowedMediaOrigins(),
    labelFor: languageLabel,
    loadProbe: async () => {
      const mod = await optionalModule('../services/media/probe.js');
      return typeof mod?.probeFile === 'function' ? (path) => mod.probeFile(path, { ffprobePath: config.media.ffprobePath }) : null;
    },
  });

  app.get('/api/admin/media', ...staff, (ctx) => ({ ...listMedia(db, ctx.query), allowedOrigins: allowedMediaOrigins() }));

  app.get('/api/admin/media/:id', ...staff, (ctx) => ({ media: mediaDto(getMediaRow(db, ctx.params.id)) }));

  app.post('/api/admin/media', ...staff, async (ctx) => {
    const input = v.parse(mediaSchema, await ctx.body());
    const { row, notified } = createMedia(db, input);
    audit(db, ctx, 'media.create', { targetType: 'media', targetId: row.id, details: { titleId: row.title_id, episodeId: row.episode_id, role: row.role, kind: row.kind, notified } });
    catalog.invalidate();
    return { media: mediaDto(row), notified };
  });

  app.patch('/api/admin/media/:id', ...staff, async (ctx) => {
    const patch = v.parse(mediaPatchSchema, await ctx.body());
    delete patch.titleId; // media cannot move between titles
    const { row, notified, relocated } = updateMedia(db, ctx.params.id, patch);
    audit(db, ctx, 'media.update', { targetType: 'media', targetId: row.id, details: { titleId: row.title_id, fields: Object.keys(patch), verificationReset: relocated, notified } });
    catalog.invalidate();
    return { media: mediaDto(row), notified, verificationReset: relocated };
  });

  app.delete('/api/admin/media/:id', ...admin, (ctx) => {
    const m = deleteMedia(db, ctx.params.id);
    audit(db, ctx, 'media.delete', { targetType: 'media', targetId: m.id, details: { titleId: m.title_id, episodeId: m.episode_id, role: m.role, source: m.source } });
    catalog.invalidate();
    return { ok: true };
  });

  app.post('/api/admin/media/:id/verify', ...staff, rateLimit('admin-verify', { max: 30, windowMs: 60_000, by: 'account' }), async (ctx) => {
    const m = getMediaRow(db, ctx.params.id);
    const result = await verifyMedia(m, verifyEnv());
    const row = applyVerification(db, m.id, result);
    audit(db, ctx, 'media.verify', {
      targetType: 'media', targetId: m.id,
      details: { ok: result.ok, message: result.message, code: result.report?.code || null, resolutions: result.fields?.resolutions || null },
    });
    catalog.invalidate();
    return { ok: result.ok, message: result.message, report: result.report, media: mediaDto(row) };
  });

  app.post('/api/admin/media/:id/transcode', ...staff, async (ctx) => {
    const m = getMediaRow(db, ctx.params.id);
    const body = v.parse(transcodeSchema, await ctx.body());
    const sourceKey = body.sourceKey || (m.source.startsWith('storage:') && !m.source.endsWith('.m3u8') ? m.source.slice(8) : null);
    if (!sourceKey) throw validation({ sourceKey: 'Give the private storage key of the source file to transcode (under media/, or a video file of an approved submission linked to this title).' });
    // The ladder becomes playable media of this title, so the same source rules apply.
    const problem = mediaRefProblem(`storage:${sourceKey}`) || storageSourceProblem(db, sourceKey, m.title_id);
    if (problem) throw validation({ sourceKey: problem });
    if (!config.media.ffmpegPath) throw new HttpError(503, 'TRANSCODER_NOT_CONFIGURED', 'Transcoding needs ffmpeg on the server. Set FFMPEG_PATH (and FFPROBE_PATH) and restart.');
    const queue = await optionalModule('../services/media/queue.js');
    if (typeof queue?.enqueueTranscode !== 'function') throw new HttpError(503, 'TRANSCODER_UNAVAILABLE', 'The transcoding queue (server/services/media/queue.js) is not installed on this server.');
    let job;
    try {
      job = await queue.enqueueTranscode(db, { mediaId: m.id, sourceKey });
    } catch (err) {
      throw validation({ sourceKey: err.message });
    }
    audit(db, ctx, 'media.transcode', { targetType: 'media', targetId: m.id, details: { sourceKey, jobId: job?.jobId || null, existing: !!job?.existing } });
    catalog.invalidate();
    return { ok: true, job: job ?? null, media: mediaDto(getMediaRow(db, m.id)) };
  });

  // ───────────── TMDB (metadata only) ─────────────
  const tmdbLimit = rateLimit('admin-tmdb', { max: 60, windowMs: 60_000, by: 'account' });
  app.get('/api/admin/tmdb/search', ...staff, tmdbLimit, async (ctx) => {
    const q = String(ctx.query.q || '').trim().slice(0, 120);
    if (!q) throw validation({ q: 'Enter a title to search for.' });
    return searchTmdb(config, { q, type: ctx.query.type });
  });

  app.get('/api/admin/tmdb/:type/:id', ...staff, tmdbLimit, async (ctx) => {
    const type = ctx.params.type === 'movie' ? 'movie' : ['tv', 'series'].includes(ctx.params.type) ? 'tv' : null;
    if (!type || !/^\d{1,10}$/.test(ctx.params.id)) throw new HttpError(404, 'NOT_FOUND', 'Unknown TMDB entry.');
    return { metadata: await tmdbDetails(config, { type, id: ctx.params.id }), notice: 'Metadata from TMDB. Review every field before saving. TMDB artwork is subject to its own terms; prefer artwork you are licensed to use.' };
  });

  // ───────────── Taxonomy ─────────────
  app.get('/api/admin/taxonomy', ...staff, () => getTaxonomy(db, getSetting(db, 'taxonomy', null)));

  app.put('/api/admin/taxonomy', ...admin, async (ctx) => {
    const input = v.parse(taxonomySchema, await ctx.body());
    const ids = new Set();
    input.collections.forEach((c, i) => {
      if (ids.has(c.id)) throw validation({ [`collections[${i}].id`]: 'Each collection needs a unique id.' });
      ids.add(c.id);
    });
    setSetting(db, 'taxonomy', input, ctx.account.id);
    audit(db, ctx, 'content.taxonomy_update', { targetType: 'platform_setting', targetId: 'taxonomy', details: { genres: input.genres.length, collections: input.collections.length } });
    catalog.invalidate();
    return getTaxonomy(db, input);
  });

  // ───────────── Creators ─────────────
  app.get('/api/admin/creator-applications', ...staff, (ctx) => listApplications(db, ctx.query));

  app.post('/api/admin/creator-applications/:id/decision', ...staff, async (ctx) => {
    const input = v.parse(decisionSchema, await ctx.body());
    const r = decideApplication(db, ctx, ctx.params.id, input);
    audit(db, ctx, 'creators.application_decision', { targetType: 'creator_application', targetId: ctx.params.id, details: { decision: input.decision, from: r.before, to: r.after, accountId: r.accountId } });
    return { ok: true, status: r.after };
  });

  // ───────────── Submissions ─────────────
  app.get('/api/admin/submissions', ...staff, (ctx) => listSubmissions(db, ctx.query));
  app.get('/api/admin/submissions/:id', ...staff, (ctx) => submissionDetail(db, ctx.params.id));

  app.post('/api/admin/submissions/:id/status', ...staff, async (ctx) => {
    const input = v.parse(statusSchema, await ctx.body());
    const r = changeSubmissionStatus(db, ctx, ctx.params.id, input);
    audit(db, ctx, 'submissions.status', { targetType: 'submission', targetId: ctx.params.id, details: { from: r.before, to: r.after, internalNote: !!input.internalNote } });
    return submissionDetail(db, ctx.params.id);
  });

  app.post('/api/admin/submissions/:id/comments', ...staff, async (ctx) => {
    const input = v.parse(commentSchema, await ctx.body());
    addSubmissionComment(db, ctx, ctx.params.id, input);
    audit(db, ctx, 'submissions.comment', { targetType: 'submission', targetId: ctx.params.id, details: { visibleToCreator: input.visibleToCreator } });
    return submissionDetail(db, ctx.params.id);
  });

  app.post('/api/admin/submissions/:id/publish', ...admin, async (ctx) => {
    let enqueue = null;
    if (config.media.ffmpegPath) {
      const queue = await optionalModule('../services/media/queue.js');
      if (typeof queue?.enqueueTranscode === 'function') enqueue = queue.enqueueTranscode;
    }
    const result = await publishSubmission(db, ctx, ctx.params.id, { enqueue });
    audit(db, ctx, 'submissions.publish', {
      targetType: 'submission', targetId: ctx.params.id,
      details: { titleId: result.titleId, media: result.media.map((m) => ({ id: m.id, kind: m.kind, status: m.status })), transcoding: !!enqueue, warnings: result.warnings },
    });
    catalog.invalidate();
    return result;
  });

  // Short-lived signed URL for previewing or downloading a submitted file. Access is audited.
  app.get('/api/admin/submissions/:id/files/:fileId/url', ...staff, (ctx) => {
    const f = getSubmissionFile(db, ctx.params.id, ctx.params.fileId);
    const minutes = 30;
    const url = signedUrl(f.storage_key, minutes);
    audit(db, ctx, 'submissions.file_access', { targetType: 'submission_file', targetId: f.id, details: { submissionId: ctx.params.id, role: f.role } });
    return { url, expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(), mime: f.mime, name: f.original_name, sizeBytes: f.size_bytes };
  });

  // ───────────── Moderation ─────────────
  app.get('/api/admin/reports', ...staff, (ctx) => listReportGroups(db, ctx.query));

  app.post('/api/admin/reports/:id/resolve', ...staff, async (ctx) => {
    const input = v.parse(resolveSchema, await ctx.body());
    const r = resolveReport(db, ctx, ctx.params.id, input);
    audit(db, ctx, 'moderation.report_resolve', {
      targetType: r.target.type, targetId: r.target.id,
      details: { action: input.action, note: input.note || null, reportsResolved: r.resolved, targetStatus: r.targetStatus || null, suspended: r.suspended || null, sessionsRevoked: r.sessionsRevoked ?? null },
    });
    if (r.ratingsChanged) catalog.invalidateRatings();
    return { ok: true, ...r };
  });

  app.get('/api/admin/reviews', ...staff, (ctx) => listReviews(db, ctx.query));

  app.patch('/api/admin/reviews/:id', ...staff, async (ctx) => {
    const input = v.parse(reviewStatusSchema, await ctx.body());
    const r = setReviewStatus(db, ctx.params.id, input);
    audit(db, ctx, 'moderation.review_status', { targetType: 'review', targetId: ctx.params.id, details: { from: r.before, to: r.after, note: input.note || null, titleId: r.titleId } });
    catalog.invalidateRatings();
    return { ok: true, status: r.after };
  });

  app.patch('/api/admin/comments/:id', ...staff, async (ctx) => {
    const input = v.parse(commentStatusSchema, await ctx.body());
    const r = setCommentStatus(db, ctx.params.id, input);
    audit(db, ctx, 'moderation.comment_status', { targetType: 'comment', targetId: ctx.params.id, details: { from: r.before, to: r.after, note: input.note || null } });
    return { ok: true, status: r.after };
  });

  app.get('/api/admin/moderation/history', ...staff, (ctx) => moderationHistory(db, ctx.query));

  // ───────────── Users ─────────────
  app.get('/api/admin/users', ...staff, (ctx) => listUsers(db, ctx.query));
  app.get('/api/admin/users/:id', ...staff, (ctx) => userDetail(db, ctx.params.id));

  app.patch('/api/admin/users/:id', ...staff, async (ctx) => {
    const patch = v.parse(userPatchSchema, await ctx.body());
    const r = updateUser(db, ctx.account, ctx.params.id, patch);
    const id = ctx.params.id;
    const changed = Object.keys(r.changes);
    if (r.changes.status) {
      const suspended = r.changes.status.to === 'suspended';
      audit(db, ctx, suspended ? 'moderation.account_suspend' : 'moderation.account_reinstate', {
        targetType: 'account', targetId: id,
        details: { reason: r.after.suspended_reason, until: r.after.suspended_until, sessionsRevoked: r.sessionsRevoked },
      });
      notify(db, {
        accountId: id,
        type: 'moderation',
        title: suspended ? 'Your account was suspended' : 'Your account was reinstated',
        body: suspended
          ? `${r.after.suspended_until ? `Suspended until ${r.after.suspended_until.slice(0, 10)}.` : 'Suspended until further notice.'}${r.after.suspended_reason ? ` Reason: ${r.after.suspended_reason}` : ''}`
          : 'You can use Lumina again. Please follow the Community Guidelines.',
        link: '#/legal/community',
        dedupeKey: `moderation:account:${id}:${r.changes.status.to}:${now()}`,
      });
    }
    const other = changed.filter((k) => k !== 'status' && !(r.changes.status && (k === 'suspendedReason' || k === 'suspendedUntil')));
    if (other.length) {
      audit(db, ctx, 'users.update', { targetType: 'account', targetId: id, details: { changes: Object.fromEntries(other.map((k) => [k, r.changes[k]])) } });
    }
    if (r.changes.role) {
      notify(db, {
        accountId: id,
        type: 'account_security',
        title: 'Your Lumina role changed',
        body: `An administrator changed your role from ${r.changes.role.from} to ${r.changes.role.to}.`,
        link: '#/account',
        dedupeKey: `role:${id}:${r.changes.role.to}:${now()}`,
      });
    }
    return userDetail(db, id);
  });

  app.post('/api/admin/users/:id/revoke-sessions', ...staff, (ctx) => {
    const revoked = revokeSessions(db, ctx.account, ctx.params.id, ctx.session.id);
    audit(db, ctx, 'users.revoke_sessions', { targetType: 'account', targetId: ctx.params.id, details: { revoked } });
    return { ok: true, revoked };
  });

  // ───────────── Platform ─────────────
  app.get('/api/admin/health', ...staff, () => health(db, config));
  app.get('/api/admin/usage', ...staff, (ctx) => usage(db, config, { days: [7, 30, 90].includes(Number(ctx.query.days)) ? Number(ctx.query.days) : 30 }));
  app.get('/api/admin/logs', ...admin, (ctx) => logs(ctx.query));
  app.get('/api/admin/playback-errors', ...staff, (ctx) => playbackErrors(db, ctx.query));
  app.get('/api/admin/quality-reports', ...staff, (ctx) => qualityReports(db, ctx.query));

  app.patch('/api/admin/quality-reports/:id', ...staff, async (ctx) => {
    const { status } = v.parse(qualityStatusSchema, await ctx.body());
    const r = setQualityStatus(db, ctx.params.id, status);
    audit(db, ctx, 'platform.quality_report_status', { targetType: 'quality_report', targetId: ctx.params.id, details: { from: r.before, to: r.after } });
    return { ok: true, status };
  });

  app.get('/api/admin/audit', ...admin, (ctx) => auditLog(db, ctx.query));

  app.get('/api/admin/settings', ...admin, () => ({ settings: describeSettings(db), effective: readPlatformSettings(db) }));

  app.put('/api/admin/settings', ...admin, async (ctx) => {
    const input = v.parse(settingsSchema, await ctx.body());
    const before = readPlatformSettings(db);
    const changed = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined) continue;
      setSetting(db, key, value, ctx.account.id);
      if (before[key] !== value) changed[key] = { from: before[key], to: value };
    }
    if (Object.keys(changed).length) audit(db, ctx, 'platform.settings_update', { targetType: 'platform_setting', targetId: Object.keys(changed).join(','), details: { changed } });
    return { settings: describeSettings(db), effective: readPlatformSettings(db) };
  });

  app.get('/api/admin/announcements', ...staff, (ctx) => listAnnouncements(db, ctx.query));

  app.post('/api/admin/announcements', ...staff, async (ctx) => {
    const input = v.parse(announcementSchema, await ctx.body());
    const a = createAnnouncement(db, ctx, input);
    audit(db, ctx, 'platform.announcement_create', { targetType: 'announcement', targetId: a.id, details: { title: a.title, audience: a.audience, startsAt: a.starts_at, endsAt: a.ends_at } });
    return { announcement: { id: a.id, title: a.title, audience: a.audience, startsAt: a.starts_at, endsAt: a.ends_at } };
  });

  app.delete('/api/admin/announcements/:id', ...staff, (ctx) => {
    const a = deleteAnnouncement(db, ctx.params.id);
    audit(db, ctx, 'platform.announcement_delete', { targetType: 'announcement', targetId: a.id, details: { title: a.title } });
    return { ok: true };
  });
}

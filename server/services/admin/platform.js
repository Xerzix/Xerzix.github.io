// Platform operations: overview counts, health, storage usage, telemetry-based usage
// estimates, logs, playback errors, quality reports, the audit log and announcements.
import { existsSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { now, parseJson } from '../../db/index.js';
import { notFound, validation } from '../../lib/errors.js';
import { newId } from '../../lib/crypto.js';
import { recentLogs } from '../../lib/log.js';
import { v } from '../../lib/validate.js';
import { isAppLink, likeTerm, paging } from './common.js';
import { auditDto } from './moderation.js';

const startedAt = Date.now();

// ───────────────────────────── Storage walk (cached) ─────────────────────────────

let storageCache = null; // { at, dir, value }
let storagePending = null;

async function walk(dir, budget) {
  let bytes = 0;
  let files = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const e of entries) {
    if (budget.count++ > budget.max || Date.now() > budget.deadline) {
      budget.truncated = true;
      break;
    }
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      const sub = await walk(full, budget);
      bytes += sub.bytes;
      files += sub.files;
    } else if (e.isFile()) {
      try {
        bytes += (await stat(full)).size;
        files++;
      } catch {
        /* file vanished mid-walk */
      }
    }
  }
  return { bytes, files };
}

/** Bytes used under the private storage directory. Cached for a minute; bounded walk. */
export async function storageUsage(storageDir) {
  if (storageCache && storageCache.dir === storageDir && Date.now() - storageCache.at < 60_000) return storageCache.value;
  if (!storagePending) {
    storagePending = (async () => {
      const budget = { count: 0, max: 200_000, deadline: Date.now() + 3000, truncated: false };
      const present = existsSync(storageDir);
      const { bytes, files } = present ? await walk(storageDir, budget) : { bytes: 0, files: 0 };
      const value = { bytes, files, truncated: budget.truncated, present, measuredAt: now() };
      storageCache = { at: Date.now(), dir: storageDir, value };
      return value;
    })().finally(() => {
      storagePending = null;
    });
  }
  return storagePending;
}

async function fileSize(path) {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

// ───────────────────────────── Health ─────────────────────────────

export function integrations(config) {
  const binary = (path) => (!path ? 'not_configured' : existsSync(path) ? 'configured' : 'missing');
  return [
    {
      id: 'mail',
      name: 'Email delivery',
      status: config.mail.transport === 'webhook' ? (config.mail.webhookUrl ? 'configured' : 'misconfigured') : 'development',
      detail: config.mail.transport === 'webhook'
        ? (config.mail.webhookUrl ? 'Webhook transport to a mail provider.' : 'MAIL_TRANSPORT=webhook but MAIL_WEBHOOK_URL is empty.')
        : 'Log transport: emails (password resets) are written to the server log, not delivered.',
    },
    {
      id: 'velvia',
      name: 'Velvia AI provider',
      status: config.velvia.provider === 'local' ? 'not_configured' : config.velvia.apiKey ? 'configured' : 'misconfigured',
      detail: config.velvia.provider === 'local'
        ? 'Built-in catalog-grounded engine (no external AI provider).'
        : `${config.velvia.provider}${config.velvia.model ? ` · ${config.velvia.model}` : ''}${config.velvia.apiKey ? '' : ' — VELVIA_API_KEY is missing'}`,
    },
    { id: 'ffmpeg', name: 'ffmpeg (transcoding)', status: binary(config.media.ffmpegPath), detail: config.media.ffmpegPath ? `FFMPEG_PATH=${config.media.ffmpegPath}` : 'FFMPEG_PATH is not set; uploads cannot be transcoded.' },
    { id: 'ffprobe', name: 'ffprobe (media probing)', status: binary(config.media.ffprobePath), detail: config.media.ffprobePath ? `FFPROBE_PATH=${config.media.ffprobePath}` : 'FFPROBE_PATH is not set.' },
    { id: 'scanner', name: 'Upload malware scanner', status: config.uploads.scanCommand ? 'configured' : 'not_configured', detail: config.uploads.scanCommand ? 'UPLOAD_SCAN_COMMAND is set.' : 'UPLOAD_SCAN_COMMAND is not set; uploads are not scanned for malware.' },
    { id: 'tmdb', name: 'TMDB metadata import', status: config.tmdb.token ? 'configured' : 'not_configured', detail: config.tmdb.token ? 'TMDB_API_TOKEN is set (metadata only).' : 'TMDB_API_TOKEN is not set.' },
    { id: 'staff2fa', name: 'Two-factor for staff', status: config.auth.adminRequire2fa ? 'configured' : 'not_configured', detail: config.auth.adminRequire2fa ? 'ADMIN_REQUIRE_2FA=true.' : 'Staff may use the dashboard without TOTP (ADMIN_REQUIRE_2FA=false).' },
    { id: 'monetization', name: 'Monetization', status: 'info', detail: `MONETIZATION_MODE=${config.monetization.mode} (no payments are collected).` },
  ];
}

export function transcodeQueue(db) {
  const rows = db.all('SELECT status, COUNT(*) AS n FROM transcode_jobs GROUP BY status');
  const counts = { queued: 0, running: 0, done: 0, failed: 0 };
  for (const r of rows) counts[r.status] = r.n;
  return counts;
}

export async function health(db, config) {
  const [dbBytes, walBytes, storage] = await Promise.all([fileSize(db.file), fileSize(`${db.file}-wal`), storageUsage(config.storageDir)]);
  const tables = db.all(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`)
    .filter((t) => /^\w+$/.test(t.name))
    .map((t) => ({ name: t.name, rows: db.get(`SELECT COUNT(*) AS n FROM "${t.name}"`).n }));
  const mem = process.memoryUsage();
  const migrations = db.all('SELECT version, applied_at FROM schema_migrations ORDER BY version');
  return {
    status: 'ok',
    checkedAt: now(),
    server: {
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      processUptimeS: Math.round(process.uptime()),
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      env: config.env,
      memory: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal, external: mem.external },
      pid: process.pid,
    },
    database: { path: db.file === ':memory:' ? ':memory:' : db.file.split(/[\\/]/).slice(-2).join('/'), bytes: dbBytes, walBytes, tables, migrations: migrations.map((m) => m.version) },
    storage,
    transcode: transcodeQueue(db),
    integrations: integrations(config),
  };
}

// ───────────────────────────── Overview ─────────────────────────────

export async function overview(db, config) {
  const titleRows = db.all('SELECT status, type, COUNT(*) AS n FROM titles GROUP BY status, type');
  const titles = { total: 0, published: 0, draft: 0, unpublished: 0, movies: 0, series: 0 };
  for (const r of titleRows) {
    titles.total += r.n;
    titles[r.status] += r.n;
    titles[r.type === 'movie' ? 'movies' : 'series'] += r.n;
  }
  const count = (sql, ...a) => db.get(sql, ...a).n;
  const dayAgo = new Date(Date.now() - 86_400_000).toISOString();
  const [dbBytes, walBytes, storage] = await Promise.all([fileSize(db.file), fileSize(`${db.file}-wal`), storageUsage(config.storageDir)]);
  const recent = db.all('SELECT * FROM audit_log ORDER BY id DESC LIMIT 8').map(auditDto);
  return {
    titles,
    media: {
      total: count('SELECT COUNT(*) AS n FROM media'),
      unverified: count(`SELECT COUNT(*) AS n FROM media WHERE verified_at IS NULL AND status = 'ready'`),
      failed: count(`SELECT COUNT(*) AS n FROM media WHERE status = 'failed'`),
      processing: count(`SELECT COUNT(*) AS n FROM media WHERE status = 'processing'`),
    },
    accounts: {
      total: count('SELECT COUNT(*) AS n FROM accounts'),
      staff: count(`SELECT COUNT(*) AS n FROM accounts WHERE role IN ('moderator', 'admin')`),
      suspended: count(`SELECT COUNT(*) AS n FROM accounts WHERE status = 'suspended' AND (suspended_until IS NULL OR suspended_until > ?)`, now()),
      newLast7d: count('SELECT COUNT(*) AS n FROM accounts WHERE created_at >= ?', new Date(Date.now() - 7 * 86_400_000).toISOString()),
    },
    creators: count('SELECT COUNT(*) AS n FROM accounts WHERE is_creator = 1'),
    queues: {
      openReports: count(`SELECT COUNT(*) AS n FROM reports WHERE status = 'open'`),
      reportedItems: count(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM reports WHERE status = 'open' GROUP BY target_type, target_id)`),
      pendingReviews: count(`SELECT COUNT(*) AS n FROM reviews WHERE status = 'pending'`),
      creatorApplications: count(`SELECT COUNT(*) AS n FROM creator_applications WHERE status = 'pending'`),
      submissionsAwaiting: count(`SELECT COUNT(*) AS n FROM submissions WHERE status IN ('submitted', 'under_review')`),
      submissionsInfoRequired: count(`SELECT COUNT(*) AS n FROM submissions WHERE status = 'info_required'`),
      qualityReportsOpen: count(`SELECT COUNT(*) AS n FROM quality_reports WHERE status = 'open'`),
      playbackErrors24h: count('SELECT COUNT(*) AS n FROM playback_errors WHERE created_at >= ?', dayAgo),
    },
    transcode: transcodeQueue(db),
    health: {
      uptimeS: Math.round((Date.now() - startedAt) / 1000),
      dbBytes,
      walBytes,
      storageBytes: storage.bytes,
      integrations: integrations(config).map(({ id, name, status }) => ({ id, name, status })),
      recentErrors: recentLogs({ level: 'error', limit: 50 }).length,
    },
    recentActivity: recent,
  };
}

// ───────────────────────────── Usage (telemetry) ─────────────────────────────

export async function usage(db, config, { days = 30 } = {}) {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const totals = db.get(
    `SELECT COALESCE(SUM(seconds_watched), 0) AS seconds, COALESCE(SUM(bytes_estimate), 0) AS bytes, COUNT(*) AS sessions,
            COUNT(DISTINCT account_id) AS accounts, COALESCE(SUM(rebuffer_seconds), 0) AS rebuffer, COALESCE(SUM(error_count), 0) AS errors
       FROM playback_sessions WHERE started_at >= ?`, since,
  );
  const daily = db.all(
    `SELECT substr(started_at, 1, 10) AS day, COALESCE(SUM(seconds_watched), 0) AS seconds, COALESCE(SUM(bytes_estimate), 0) AS bytes, COUNT(*) AS sessions
       FROM playback_sessions WHERE started_at >= ? GROUP BY day ORDER BY day`, since,
  );
  const top = db.all(
    `SELECT p.title_id, t.title, COALESCE(SUM(p.seconds_watched), 0) AS seconds, COALESCE(SUM(p.bytes_estimate), 0) AS bytes, COUNT(*) AS sessions
       FROM playback_sessions p LEFT JOIN titles t ON t.id = p.title_id WHERE p.started_at >= ?
      GROUP BY p.title_id ORDER BY seconds DESC LIMIT 10`, since,
  );
  const storage = await storageUsage(config.storageDir);
  // Fill missing days so charts and tables have a continuous axis.
  const byDay = new Map(daily.map((d) => [d.day, d]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const d = byDay.get(day);
    series.push({ day, seconds: d?.seconds || 0, bytes: d?.bytes || 0, sessions: d?.sessions || 0 });
  }
  return {
    windowDays: days,
    since,
    label: 'Estimated from player telemetry',
    note: 'Watch time and bytes are reported by players while they play (bytes are estimated from the selected bitrate). Viewers who block telemetry, and Preview-mode playback, are not counted. This is not a CDN bill.',
    totals: { secondsWatched: totals.seconds, bytesEstimate: totals.bytes, sessions: totals.sessions, accounts: totals.accounts, rebufferSeconds: totals.rebuffer, errors: totals.errors },
    daily: series,
    topTitles: top.map((t) => ({ titleId: t.title_id, title: t.title, secondsWatched: t.seconds, bytesEstimate: t.bytes, sessions: t.sessions })),
    storage,
  };
}

// ───────────────────────────── Logs, errors, reports ─────────────────────────────

export function logs(query) {
  const level = ['debug', 'info', 'warn', 'error'].includes(query.level) ? query.level : 'info';
  const limit = Math.max(1, Math.min(1000, Number.parseInt(query.limit, 10) || 200));
  const needle = String(query.q || '').slice(0, 200).toLowerCase();
  // Search the scrubbed entries, so a query can never probe a redacted value.
  const items = recentLogs({ level, limit: 2000 }).map(scrubLogEntry)
    .filter((e) => !needle || JSON.stringify(e).toLowerCase().includes(needle))
    .slice(0, limit);
  return { items, level, limit, note: 'The last 2,000 log entries of this server process, kept in memory only (they are lost on restart).' };
}

// Defence in depth: the logger is told never to record secrets, but a field that could carry
// one (a mail body with a one-time link, a token, a password) is never shown to staff.
const SECRET_FIELD = /^(text|html|body|token|password|secret|authorization|cookie|sig|code)$/i;
const TOKEN_PARAM = /([?&#](?:token|sig|code)=)[^&\s"']+/gi;
function scrubLogEntry(entry) {
  const out = {};
  for (const [key, value] of Object.entries(entry)) {
    if (SECRET_FIELD.test(key)) out[key] = '[redacted]';
    else if (typeof value === 'string') out[key] = value.replace(TOKEN_PARAM, '$1[redacted]');
    else out[key] = value;
  }
  return out;
}

export function playbackErrors(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 50 });
  const where = [];
  const args = [];
  if (query.titleId) {
    where.push('e.title_id = ?');
    args.push(query.titleId);
  }
  if (query.code) {
    where.push('e.code = ?');
    args.push(String(query.code).slice(0, 80));
  }
  if (query.fatal === '1') where.push('e.fatal = 1');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM playback_errors e ${clause}`, ...args).n;
  const rows = db.all(
    `SELECT e.*, t.title AS title_name FROM playback_errors e LEFT JOIN titles t ON t.id = e.title_id ${clause} ORDER BY e.id DESC LIMIT ? OFFSET ?`,
    ...args, pageSize, offset,
  );
  const since = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const summary = db.all(
    `SELECT code, COUNT(*) AS n, SUM(fatal) AS fatal, MAX(created_at) AS last_at FROM playback_errors WHERE created_at >= ? GROUP BY code ORDER BY n DESC LIMIT 20`, since,
  );
  return {
    items: rows.map((e) => ({
      id: e.id, mediaId: e.media_id, titleId: e.title_id, titleName: e.title_name, episodeId: e.episode_id, code: e.code, message: e.message,
      fatal: !!e.fatal, details: parseJson(e.details, null), userAgent: e.user_agent, createdAt: e.created_at,
    })),
    total,
    page,
    pageSize,
    summary: summary.map((s) => ({ code: s.code, count: s.n, fatal: s.fatal || 0, lastAt: s.last_at })),
  };
}

export const qualityStatusSchema = v.object({ status: v.enum(['open', 'acknowledged', 'resolved']) });

export function qualityReports(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 30 });
  const where = [];
  const args = [];
  if (['open', 'acknowledged', 'resolved'].includes(query.status)) {
    where.push('q.status = ?');
    args.push(query.status);
  }
  if (query.category) {
    where.push('q.category = ?');
    args.push(String(query.category).slice(0, 40));
  }
  if (query.titleId) {
    where.push('q.title_id = ?');
    args.push(query.titleId);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM quality_reports q ${clause}`, ...args).n;
  const rows = db.all(
    `SELECT q.*, t.title AS title_name, a.email FROM quality_reports q LEFT JOIN titles t ON t.id = q.title_id LEFT JOIN accounts a ON a.id = q.account_id
      ${clause} ORDER BY q.created_at DESC LIMIT ? OFFSET ?`,
    ...args, pageSize, offset,
  );
  const categories = db.all(`SELECT category, COUNT(*) AS n FROM quality_reports WHERE status = 'open' GROUP BY category ORDER BY n DESC`);
  return {
    items: rows.map((q) => ({
      id: q.id, titleId: q.title_id, titleName: q.title_name, episodeId: q.episode_id, mediaId: q.media_id, category: q.category,
      description: q.description, device: q.device, connectionMbps: q.connection_mbps, selectedResolution: q.selected_resolution,
      diagnostics: parseJson(q.diagnostics, null), status: q.status, reporter: q.email || null, createdAt: q.created_at,
    })),
    total,
    page,
    pageSize,
    openByCategory: categories.map((c) => ({ category: c.category, count: c.n })),
  };
}

export function setQualityStatus(db, id, status) {
  const q = db.get('SELECT id, status FROM quality_reports WHERE id = ?', id);
  if (!q) throw notFound('That quality report does not exist.');
  db.run('UPDATE quality_reports SET status = ? WHERE id = ?', status, id);
  return { before: q.status, after: status };
}

// ───────────────────────────── Audit log ─────────────────────────────

export function auditLog(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 50 });
  const where = [];
  const args = [];
  if (query.actor) {
    where.push('(actor_account_id = ? OR actor_email LIKE ? ESCAPE \'\\\')');
    args.push(String(query.actor).trim(), likeTerm(query.actor));
  }
  if (query.action) {
    where.push(`action LIKE ? ESCAPE '\\'`);
    args.push(`${String(query.action).trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  if (query.targetType) {
    where.push('target_type = ?');
    args.push(String(query.targetType).slice(0, 40));
  }
  if (query.targetId) {
    where.push('target_id = ?');
    args.push(String(query.targetId).slice(0, 120));
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = db.get(`SELECT COUNT(*) AS n FROM audit_log ${clause}`, ...args).n;
  const rows = db.all(`SELECT * FROM audit_log ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`, ...args, pageSize, offset);
  const areas = db.all(`SELECT DISTINCT substr(action, 1, instr(action || '.', '.') - 1) AS area FROM audit_log ORDER BY area`).map((r) => r.area).filter(Boolean);
  return { items: rows.map(auditDto), total, page, pageSize, areas };
}

// ───────────────────────────── Announcements ─────────────────────────────

export const announcementSchema = v.object({
  title: v.string().min(3).max(120),
  body: v.string().min(1).max(1000),
  link: v.string().max(300).check(isAppLink, 'Use an in-app link starting with #/ or an https URL.').nullable().optional(),
  audience: v.enum(['all', 'creators']).default('all'),
  startsAt: v.string().max(40).check((s) => !Number.isNaN(Date.parse(s)), 'Enter a valid date and time.').optional(),
  endsAt: v.string().max(40).check((s) => !Number.isNaN(Date.parse(s)), 'Enter a valid date and time.').nullable().optional(),
});

function announcementState(a, ts) {
  if (a.starts_at > ts) return 'scheduled';
  if (a.ends_at && a.ends_at <= ts) return 'ended';
  return 'active';
}

export function listAnnouncements(db, query) {
  const { page, pageSize, offset } = paging(query, { size: 25 });
  const total = db.get('SELECT COUNT(*) AS n FROM announcements').n;
  const ts = now();
  const rows = db.all(
    `SELECT n.*, a.display_name AS author,
            (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = n.id AND r.read_at IS NOT NULL) AS reads,
            (SELECT COUNT(*) FROM announcement_reads r WHERE r.announcement_id = n.id AND r.dismissed_at IS NOT NULL) AS dismissals
       FROM announcements n LEFT JOIN accounts a ON a.id = n.created_by ORDER BY n.starts_at DESC LIMIT ? OFFSET ?`,
    pageSize, offset,
  );
  return {
    items: rows.map((a) => ({
      id: a.id, title: a.title, body: a.body, link: a.link, audience: a.audience, startsAt: a.starts_at, endsAt: a.ends_at,
      state: announcementState(a, ts), reads: a.reads, dismissals: a.dismissals, author: a.author || null, createdAt: a.created_at,
    })),
    total,
    page,
    pageSize,
  };
}

export function createAnnouncement(db, ctx, input) {
  const ts = now();
  const startsAt = input.startsAt ? new Date(input.startsAt).toISOString() : ts;
  const endsAt = input.endsAt ? new Date(input.endsAt).toISOString() : null;
  if (endsAt && endsAt <= startsAt) throw validation({ endsAt: 'The end must be after the start.' });
  if (endsAt && endsAt <= ts) throw validation({ endsAt: 'The end is already in the past.' });
  const id = newId('ann');
  db.run(
    'INSERT INTO announcements (id, title, body, link, audience, starts_at, ends_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id, input.title, input.body, input.link ?? null, input.audience, startsAt, endsAt, ctx.account.id, ts,
  );
  return db.get('SELECT * FROM announcements WHERE id = ?', id);
}

export function deleteAnnouncement(db, id) {
  const a = db.get('SELECT * FROM announcements WHERE id = ?', id);
  if (!a) throw notFound('That announcement does not exist.');
  db.run('DELETE FROM announcements WHERE id = ?', id);
  return a;
}

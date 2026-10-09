// Playback telemetry (measured by the player) and playback-quality reports (submitted by
// members). The two are stored separately and summarised separately — see
// services/quality.js. The playback descriptor itself (GET /api/playback/:titleId) lives in
// routes/catalog.js.
import { requireAuth } from '../auth/session.js';
import { v } from '../lib/validate.js';
import { rateLimit } from '../lib/security.js';
import { TelemetryService } from '../services/telemetry.js';
import { QualityService, QUALITY_CATEGORIES } from '../services/quality.js';

const id = () => v.string().max(80).pattern(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/, 'Invalid identifier.');
const num = (max) => v.number().min(0).max(max);

const openSchema = v.object({
  mediaId: id(),
  titleId: id(),
  episodeId: id().optional(),
});

const sessionSchema = v.object({
  // Issued by POST /api/playback/sessions/open; the service verifies its signature.
  sessionId: v.string().max(80).pattern(/^[A-Za-z0-9_.-]{8,80}$/, 'Invalid session id.'),
  mediaId: id(),
  titleId: id(),
  episodeId: id().optional(),
  // Upper bounds here only reject nonsense; the service clamps against wall-clock time.
  secondsWatched: num(7 * 86_400).default(0),
  startupMs: num(3_600_000).optional(),
  rebufferCount: v.int().min(0).max(1_000_000).default(0),
  rebufferSeconds: num(7 * 86_400).default(0),
  avgBitrateKbps: num(10_000_000).optional(),
  maxHeight: v.int().min(0).max(100_000).optional(),
  droppedFrames: v.int().min(0).max(1e9).default(0),
  bytesEstimate: num(1e13).default(0),
  errorCount: v.int().min(0).max(1_000_000).default(0),
});

const errorSchema = v.object({
  mediaId: id().optional(),
  titleId: id(),
  episodeId: id().optional(),
  code: v.string().max(64).pattern(/^[A-Za-z0-9_.:-]+$/, 'Invalid error code.'),
  message: v.string().max(500).optional(),
  fatal: v.boolean().default(false),
  details: v.object({
    type: v.string().max(40).optional(),
    source: v.string().max(40).optional(),
    host: v.string().max(120).optional(),
    httpStatus: v.int().min(0).max(999).optional(),
    position: num(7 * 86_400).optional(),
    level: v.int().min(-1).max(100).optional(),
    height: v.int().min(0).max(10_000).optional(),
    fallbackIndex: v.int().min(0).max(20).optional(),
    online: v.boolean().optional(),
  }).optional(),
});

// Diagnostics a member may choose to attach to a report: only these measured fields.
const diagnosticsSchema = v.object({
  capturedAt: v.string().max(40).optional(),
  source: v.string().max(40).optional(),
  host: v.string().max(120).optional(),
  resolution: v.string().max(20).optional(),
  quality: v.string().max(40).optional(),
  startupMs: num(3_600_000).optional(),
  rebufferCount: v.int().min(0).max(1_000_000).optional(),
  rebufferSeconds: num(7 * 86_400).optional(),
  avgBitrateKbps: num(10_000_000).optional(),
  bandwidthKbps: num(100_000_000).optional(),
  bufferAheadS: num(86_400).optional(),
  droppedFrames: v.int().min(0).max(1e9).optional(),
  totalFrames: v.int().min(0).max(1e10).optional(),
  maxHeight: v.int().min(0).max(100_000).optional(),
  codecs: v.string().max(120).optional(),
  audio: v.string().max(60).optional(),
  subtitles: v.string().max(60).optional(),
  errors: v.array(v.string().max(64)).max(10).optional(),
  userAgent: v.string().max(120).optional(),
});

const reportSchema = v.object({
  titleId: id(),
  episodeId: id().optional(),
  category: v.enum(QUALITY_CATEGORIES),
  description: v.string().max(2000).optional(),
  device: v.string().max(120).optional(),
  connectionMbps: v.number().min(0).max(100_000).optional(),
  selectedResolution: v.string().max(40).optional(),
  diagnostics: diagnosticsSchema.optional(),
});

export default function register(app, { db, services }) {
  services.telemetry ??= new TelemetryService(db);
  services.quality ??= new QualityService(db, services.catalog);
  const { telemetry, quality, catalog } = services;
  telemetry.onChange((titleId) => quality.invalidate(titleId));

  // A player opens one viewing session per media it loads; only issued ids are accepted below.
  app.post('/api/playback/sessions/open', rateLimit('playback-open', { max: 30, windowMs: 60_000 }), async (ctx) => {
    const body = v.parse(openSchema, await ctx.body(4 * 1024));
    return telemetry.openSession({ account: ctx.account }, body);
  });

  // Measured playback session (cumulative totals, upserted by the issued session id).
  app.post('/api/playback/sessions', rateLimit('playback-session', { max: 90, windowMs: 60_000 }), async (ctx) => {
    const body = v.parse(sessionSchema, await ctx.body(16 * 1024));
    return telemetry.recordSession({ account: ctx.account }, body);
  });

  app.post('/api/playback/errors', rateLimit('playback-error', { max: 20, windowMs: 60_000 }), async (ctx) => {
    const body = v.parse(errorSchema, await ctx.body(16 * 1024));
    return telemetry.recordError({ account: ctx.account, userAgent: ctx.header('user-agent') }, body);
  });

  // Subjective report from a signed-in member.
  app.post('/api/quality-reports', requireAuth, rateLimit('quality-report', { max: 10, windowMs: 3600_000, by: 'account' }), async (ctx) => {
    const body = v.parse(reportSchema, await ctx.body(32 * 1024));
    const report = quality.createReport({ account: ctx.account, profile: ctx.profile }, body);
    return { report };
  });

  // Public per-title summary: measured and reported data, always separate.
  app.get('/api/titles/:id/quality', rateLimit('quality-summary', { max: 240, windowMs: 60_000 }), (ctx) => {
    catalog.detail(ctx.params.id, { profile: ctx.profile });
    ctx.setHeader('Cache-Control', 'private, max-age=30');
    return quality.summary(ctx.params.id);
  });
}

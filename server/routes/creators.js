// Creators: applications, submissions (owner side), rights attestation and creator stats.
// Staff actions on applications and submissions are in the admin API.
import { requireAuth, requireCreator } from '../auth/session.js';
import { rateLimit } from '../lib/security.js';
import { patterns, v } from '../lib/validate.js';
import { CLEARANCE_ANSWERS, CONTENT_TYPES, CreatorService, DISTRIBUTION_RIGHTS, FILE_ROLES } from '../services/creators.js';
import { EXTENSIONS, RECOMMENDED_CHUNK, ROLE_KINDS, SUBTITLE_MAX_BYTES } from '../services/uploads.js';

const application = v.object({
  legalName: v.string().min(2).max(200),
  contactEmail: v.string().email(),
  company: v.string().max(200).optional(),
  website: v.string().max(500).url().optional(),
  portfolio: v.string().max(500).url().optional(),
  country: v.string().pattern(/^[A-Za-z]{2}$/, 'Use a two-letter country code, e.g. JP.').optional(),
  bio: v.string().min(40).max(5000),
});

const currentYear = new Date().getUTCFullYear();
const submissionFields = {
  projectTitle: v.string().min(1).max(200),
  description: v.string().max(5000).optional(),
  contentType: v.enum(CONTENT_TYPES),
  runtimeMin: v.int().min(1).max(1500).nullable().optional(),
  genres: v.array(v.string().max(40)).max(8).unique().optional(),
  language: v.string().pattern(patterns.lang, 'Use a language code such as en or ja.').nullable().optional(),
  releaseYear: v.int().min(1888).max(currentYear + 3).nullable().optional(),
  country: v.string().pattern(/^[A-Za-z]{2}$/, 'Use a two-letter country code, e.g. JP.').nullable().optional(),
  trailerUrl: v.string().max(500).url().nullable().optional(),
  additionalInfo: v.string().max(5000).nullable().optional(),
};
const submissionCreate = v.object(submissionFields);
const submissionPatch = v.object(submissionFields).partial();

const attestation = v.object({
  rights: v.object({
    copyrightOwner: v.string().min(2).max(200),
    distributionRights: v.enum(DISTRIBUTION_RIGHTS),
    territories: v.array(v.string().pattern(/^(WW|[A-Z]{2})$/, 'Use WW (worldwide) or two-letter country codes.')).min(1).max(250).unique(),
    restrictions: v.string().max(2000).optional(),
    musicCleared: v.enum(CLEARANCE_ANSWERS),
    footageCleared: v.enum(CLEARANCE_ANSWERS),
    documentationNotes: v.string().max(5000).optional(),
  }),
  confirm: v.boolean(),
});

const response = v.object({ message: v.string().min(1).max(5000) });

/** Drops keys whose value was not sent at all (so PATCH only touches what the client sent). */
function onlySent(raw, clean) {
  const out = {};
  for (const k of Object.keys(clean)) if (k in raw) out[k] = clean[k];
  for (const k of Object.keys(raw)) if (k in submissionFields && !(k in out) && (raw[k] === null || raw[k] === '')) out[k] = null;
  return out;
}

export default function register(app, { db, services, config }) {
  services.creators ??= new CreatorService(db);
  const creators = services.creators;

  // Public: the limits and formats this server accepts (shown on the Creators page and uploader).
  app.get('/api/creators/requirements', (ctx) => {
    ctx.setHeader('Cache-Control', 'public, max-age=300');
    return {
      uploads: {
        maxVideoBytes: config.uploads.maxBytes,
        maxImageBytes: config.uploads.maxImageBytes,
        maxDocumentBytes: config.uploads.maxDocumentBytes,
        maxSubtitleBytes: SUBTITLE_MAX_BYTES,
        chunkBytes: Math.min(RECOMMENDED_CHUNK, config.uploads.chunkMaxBytes),
        maxChunkBytes: config.uploads.chunkMaxBytes,
        expireHours: config.uploads.expireHours,
      },
      roles: Object.fromEntries(FILE_ROLES.map((r) => [r, ROLE_KINDS[r]])),
      extensions: EXTENSIONS,
      transcoding: { available: !!config.media.ffmpegPath },
    };
  });

  app.get('/api/creators/me', requireAuth, (ctx) => creators.me(ctx));

  app.post('/api/creators/applications', requireAuth, rateLimit('creators:apply', { max: 5, windowMs: 24 * 3600_000, by: 'account' }), async (ctx) => {
    const input = v.parse(application, await ctx.body());
    return creators.apply(ctx, { ...input, country: input.country?.toUpperCase() });
  });

  app.get('/api/creators/submissions', requireCreator, (ctx) => creators.list(ctx));

  app.post('/api/creators/submissions', requireCreator, rateLimit('creators:submission', { max: 30, windowMs: 24 * 3600_000, by: 'account' }), async (ctx) => {
    const input = v.parse(submissionCreate, await ctx.body());
    return creators.create(ctx, { ...input, country: input.country?.toUpperCase() });
  });

  app.get('/api/creators/submissions/:id', requireCreator, (ctx) => creators.detail(ctx, ctx.params.id));

  app.patch('/api/creators/submissions/:id', requireCreator, async (ctx) => {
    const raw = await ctx.body();
    const input = onlySent(raw, v.parse(submissionPatch, raw));
    if (input.projectTitle === null) delete input.projectTitle;
    if (input.contentType === null) delete input.contentType;
    if (input.country) input.country = input.country.toUpperCase();
    return creators.update(ctx, ctx.params.id, input);
  });

  app.delete('/api/creators/submissions/:id', requireCreator, async (ctx) => {
    await creators.remove(ctx, ctx.params.id);
  });

  app.delete('/api/creators/submissions/:id/files/:fileId', requireCreator, async (ctx) => {
    await creators.removeFile(ctx, ctx.params.id, ctx.params.fileId);
  });

  app.post('/api/creators/submissions/:id/attest', requireCreator, rateLimit('creators:attest', { max: 30, windowMs: 3600_000, by: 'account' }), async (ctx) => {
    const raw = await ctx.body();
    const t = raw?.rights?.territories;
    if (typeof t === 'string') raw.rights.territories = t.split(',');
    if (Array.isArray(raw?.rights?.territories)) raw.rights.territories = raw.rights.territories.map((x) => (typeof x === 'string' ? x.trim().toUpperCase() : x));
    const input = v.parse(attestation, raw);
    return creators.attest(ctx, ctx.params.id, input, ctx.ip);
  });

  app.post('/api/creators/submissions/:id/submit', requireCreator, rateLimit('creators:submit', { max: 30, windowMs: 3600_000, by: 'account' }), (ctx) => creators.submit(ctx, ctx.params.id));

  app.post('/api/creators/submissions/:id/respond', requireCreator, rateLimit('creators:respond', { max: 30, windowMs: 3600_000, by: 'account' }), async (ctx) => {
    const { message } = v.parse(response, await ctx.body());
    return creators.respond(ctx, ctx.params.id, message);
  });

  app.get('/api/creators/titles', requireCreator, (ctx) => creators.titles(ctx));
}

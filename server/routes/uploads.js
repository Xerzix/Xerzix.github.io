// Resumable uploads (tus-style) for creator submissions and staff artwork, plus the public
// artwork route. See server/services/uploads.js for the validation pipeline.
import { requireAuth, requireStaff } from '../auth/session.js';
import { HttpError } from '../lib/errors.js';
import { rateLimit } from '../lib/security.js';
import { sendFile } from '../lib/static.js';
import { v } from '../lib/validate.js';
import { ARTWORK_ROLES, UploadService } from '../services/uploads.js';
import { FILE_ROLES } from '../services/creators.js';
import { storagePath } from '../services/storage.js';

const createUpload = v.object({
  filename: v.string().min(1).max(255),
  size: v.int().min(1),
  mime: v.string().max(120).optional(),
  purpose: v.enum(['submission', 'artwork']),
  submissionId: v.string().max(80).optional(),
  role: v.enum([...new Set([...FILE_ROLES, ...ARTWORK_ROLES])]),
});

const ART_FILE = /^upl_[0-9a-z]{20}\.(png|jpg|webp)$/;

/** Runs the staff guard chain (moderator/admin + recent re-authentication) inline. */
function assertStaff(ctx) {
  for (const guard of requireStaff) guard(ctx);
}

export default function register(app, { db, services, config }) {
  services.uploads ??= new UploadService(db, config);
  const uploads = services.uploads;

  app.post('/api/uploads', requireAuth, rateLimit('uploads:create', { max: 120, windowMs: 3600_000, by: 'account' }), async (ctx) => {
    const input = v.parse(createUpload, await ctx.body());
    return uploads.create(ctx, input, { assertStaff });
  });

  // HEAD must be registered before GET: a GET route also answers HEAD requests.
  app.head('/api/uploads/:id', requireAuth, (ctx) => {
    const row = uploads.own(ctx, ctx.params.id);
    ctx.empty(200, { 'Upload-Offset': String(row.offset_bytes), 'Upload-Length': String(row.size_bytes), 'Cache-Control': 'no-store' });
  });

  app.get('/api/uploads/:id', requireAuth, (ctx) => uploads.status(ctx, ctx.params.id));

  app.patch('/api/uploads/:id', requireAuth, rateLimit('uploads:chunk', { max: 20000, windowMs: 3600_000, by: 'account' }), async (ctx) => {
    const offset = await uploads.receive(ctx, ctx.params.id);
    ctx.empty(204, { 'Upload-Offset': String(offset), 'Cache-Control': 'no-store' });
  });

  app.delete('/api/uploads/:id', requireAuth, async (ctx) => {
    await uploads.abort(ctx, ctx.params.id);
  });

  // Public artwork uploaded by staff (poster/backdrop images). Only files directly inside
  // storage public/art/ with an upload-id name are served; everything else in storage stays private.
  app.get('/media/art/:file', async (ctx) => {
    const file = ctx.params.file;
    if (!ART_FILE.test(file)) throw new HttpError(404, 'NOT_FOUND', 'We could not find that image.');
    await sendFile(ctx, storagePath(`public/art/${file}`), { cache: 'public, max-age=31536000, immutable' });
  });

  // Remove partial files of uploads that were abandoned.
  const sweep = () => uploads.expireStale().catch(() => {});
  const timer = setInterval(sweep, 3600_000);
  timer.unref();
  setTimeout(sweep, 30_000).unref();
}

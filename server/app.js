// Builds the Lumina HTTP application: services, global middleware, auto-loaded route
// modules (server/routes/*.js), private media and the static web root.
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config, ROOT } from './config.js';
import { openDatabase } from './db/index.js';
import { App } from './lib/http.js';
import { HttpError } from './lib/errors.js';
import { csrfGuard, securityHeaders } from './lib/security.js';
import { sendFile, staticHandler } from './lib/static.js';
import { sessionMiddleware } from './auth/session.js';
import { CatalogService } from './services/catalog.js';
import { LibraryService } from './services/library.js';
import { storagePath, verifyScope } from './services/storage.js';
import { seedIfEmpty } from './seed/seed.js';
import { backfillUsernames } from './services/identities.js';

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), 'routes');

export async function createApp({ dbFile = config.dbPath, seed = true } = {}) {
  const db = openDatabase(dbFile);
  if (seed) seedIfEmpty(db);
  // Accounts from before usernames existed get a unique one (and a picture) on first start.
  backfillUsernames(db);

  const catalog = new CatalogService(db);
  const services = { catalog, library: new LibraryService(db, catalog) };

  const app = new App({ trustProxy: config.trustProxy });
  app.db = db;
  app.services = services;
  app.baseHeaders = securityHeaders();

  app.use(csrfGuard);
  app.use(sessionMiddleware(db));

  // Route modules register themselves; each exports default (app, deps) => void.
  const deps = { db, services, config };
  const files = readdirSync(ROUTES_DIR).filter((f) => f.endsWith('.js')).sort();
  for (const f of files) {
    const mod = await import(pathToFileURL(join(ROUTES_DIR, f)).href);
    if (typeof mod.default === 'function') await mod.default(app, deps);
  }

  // Private media: signed, expiring, directory-scoped grants (see services/storage.js).
  app.get('/media/private/*', async (ctx) => {
    const key = ctx.params.rest;
    const scope = dirname(key);
    if (!verifyScope(scope, ctx.query.exp, ctx.query.sig)) throw new HttpError(403, 'MEDIA_FORBIDDEN', 'This media link has expired or is not valid.');
    // Manifests reference sibling files by relative path; append the grant so they load too.
    if (key.endsWith('.m3u8')) {
      const { readFile } = await import('node:fs/promises');
      let text;
      try {
        text = await readFile(storagePath(key), 'utf8');
      } catch {
        throw new HttpError(404, 'NOT_FOUND', 'We could not find that file.');
      }
      const grant = `exp=${ctx.query.exp}&sig=${ctx.query.sig}`;
      const signed = text.split('\n').map((line) => {
        const l = line.trim();
        if (l && !l.startsWith('#')) return `${l}${l.includes('?') ? '&' : '?'}${grant}`;
        return line.replace(/URI="([^"?]+)"/g, (_, uri) => `URI="${uri}?${grant}"`);
      }).join('\n');
      ctx.setHeader('Cache-Control', 'private, no-store');
      ctx.text(signed, 200, 'application/vnd.apple.mpegurl');
      return;
    }
    await sendFile(ctx, storagePath(key), { cache: 'private, max-age=3600' });
  });

  app.otherwise((ctx) => {
    if (ctx.path.startsWith('/api/')) throw new HttpError(404, 'NOT_FOUND', 'Unknown API endpoint.');
    return staticHandler(ROOT)(ctx);
  });

  return { app, db, services };
}

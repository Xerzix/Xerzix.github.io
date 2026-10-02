// Lumina server entry point.
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { config } from './config.js';
import { createApp } from './app.js';
import { log } from './lib/log.js';

const { app, db } = await createApp();
const server = createServer({ requestTimeout: 0, headersTimeout: 30_000 }, app.handler());
server.keepAliveTimeout = 65_000;

// Optional in-process transcoding worker (see server/services/media/worker.js).
let worker = null;
const workerModule = join(dirname(fileURLToPath(import.meta.url)), 'services', 'media', 'worker.js');
if (config.media.runWorkerInProcess && existsSync(workerModule)) {
  const { startWorker } = await import(pathToFileURL(workerModule).href);
  worker = startWorker(db, app.services);
}

server.listen(config.port, config.host, () => {
  log.info('lumina listening', { url: `http://${config.host}:${config.port}`, env: config.env, db: config.dbPath });
});

function shutdown(signal) {
  log.info('shutting down', { signal });
  worker?.stop?.();
  // Watch parties live in memory: tell members the party ended and close their event
  // streams, otherwise open Server-Sent-Event connections hold server.close() open.
  app.services.parties?.stop?.();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

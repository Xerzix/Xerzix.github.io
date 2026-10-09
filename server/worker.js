// Standalone transcoding worker (`npm run worker`). Use it instead of the in-process worker
// (set TRANSCODE_IN_PROCESS=false on the web server) when transcoding should run on a
// separate machine or process. It shares the database and STORAGE_DIR with the server.
import { config } from './config.js';
import { openDatabase } from './db/index.js';
import { log } from './lib/log.js';
import { CatalogService } from './services/catalog.js';
import { startWorker } from './services/media/worker.js';

const db = openDatabase(config.dbPath);
const services = { catalog: new CatalogService(db) };
const worker = startWorker(db, services, { unref: false });

log.info('lumina transcode worker started', {
  db: config.dbPath,
  storage: config.storageDir,
  ffmpeg: config.media.ffmpegPath ? 'configured' : 'missing (jobs will fail with an explanation)',
});

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  log.info('transcode worker stopping', { signal });
  const force = setTimeout(() => process.exit(1), 15_000);
  force.unref();
  try {
    await worker.stop();
  } finally {
    db.close();
    process.exit(0);
  }
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

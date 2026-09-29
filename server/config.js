// Central configuration. Every value comes from the environment (optionally a .env file)
// so no secret is ever committed or shipped to the browser.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

export const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), '..'));

function loadDotEnv(file) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    let value = m[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
loadDotEnv(join(ROOT, '.env'));

const env = process.env;
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes|on)$/i.test(v));
const int = (v, d) => (v === undefined || v === '' || Number.isNaN(Number(v)) ? d : Number(v));
const list = (v, d = []) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : d);

const NODE_ENV = env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const dataDir = resolve(ROOT, env.DATA_DIR || 'var');

let sessionSecret = env.SESSION_SECRET;
if (!sessionSecret) {
  if (isProd) throw new Error('SESSION_SECRET must be set in production (32+ random bytes).');
  // Development/test only: persist a generated secret so signed URLs and encrypted
  // 2FA secrets survive restarts. Never used when NODE_ENV=production.
  const devSecretFile = join(dataDir, 'dev-secret');
  if (existsSync(devSecretFile)) sessionSecret = readFileSync(devSecretFile, 'utf8').trim();
  else {
    sessionSecret = randomBytes(32).toString('hex');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(devSecretFile, sessionSecret, { mode: 0o600 });
  }
}

export const config = {
  env: NODE_ENV,
  isProd,
  isTest: NODE_ENV === 'test',
  host: env.HOST || '127.0.0.1',
  port: int(env.PORT, 8080),
  publicUrl: (env.PUBLIC_URL || `http://localhost:${int(env.PORT, 8080)}`).replace(/\/$/, ''),
  trustProxy: bool(env.TRUST_PROXY, false),
  secret: sessionSecret,

  dataDir,
  dbPath: env.DATABASE_PATH ? resolve(ROOT, env.DATABASE_PATH) : join(dataDir, 'lumina.db'),
  storageDir: env.STORAGE_DIR ? resolve(ROOT, env.STORAGE_DIR) : join(dataDir, 'storage'),

  session: {
    cookieName: 'lumina_sid',
    ttlDays: int(env.SESSION_TTL_DAYS, 30),
    secureCookie: bool(env.SECURE_COOKIES, isProd),
    elevatedMinutes: int(env.ELEVATED_MINUTES, 15),
  },

  auth: {
    minPasswordLength: 10,
    maxFailedLogins: int(env.MAX_FAILED_LOGINS, 8),
    lockMinutes: int(env.LOCK_MINUTES, 15),
    resetTokenMinutes: 60,
    adminRequire2fa: bool(env.ADMIN_REQUIRE_2FA, false),
    allowRegistration: bool(env.ALLOW_REGISTRATION, true),
  },

  profiles: { maxPerAccount: int(env.MAX_PROFILES, 5) },

  uploads: {
    maxBytes: int(env.UPLOAD_MAX_BYTES, 50 * 1024 ** 3), // 50 GiB per file
    maxImageBytes: int(env.UPLOAD_MAX_IMAGE_BYTES, 15 * 1024 ** 2),
    maxDocumentBytes: int(env.UPLOAD_MAX_DOCUMENT_BYTES, 25 * 1024 ** 2),
    chunkMaxBytes: int(env.UPLOAD_CHUNK_MAX_BYTES, 64 * 1024 ** 2),
    scanCommand: env.UPLOAD_SCAN_COMMAND || '',
    expireHours: int(env.UPLOAD_EXPIRE_HOURS, 72),
  },

  media: {
    ffmpegPath: env.FFMPEG_PATH || '',
    ffprobePath: env.FFPROBE_PATH || '',
    signedUrlMinutes: int(env.MEDIA_URL_MINUTES, 240),
    // Origins (besides this server) that the player may load manifests/segments/artwork from.
    extraOrigins: list(env.MEDIA_ORIGINS, [
      'https://test-streams.mux.dev',
      'https://demo.unified-streaming.com',
      'https://bitdash-a.akamaihd.net',
      'https://devstreaming-cdn.apple.com',
      'https://commondatastorage.googleapis.com',
    ]),
    runWorkerInProcess: bool(env.TRANSCODE_IN_PROCESS, true),
  },

  mail: {
    transport: env.MAIL_TRANSPORT || 'log', // log | webhook
    webhookUrl: env.MAIL_WEBHOOK_URL || '',
    webhookToken: env.MAIL_WEBHOOK_TOKEN || '',
    from: env.MAIL_FROM || 'Lumina <no-reply@lumina.local>',
  },

  velvia: {
    provider: env.VELVIA_PROVIDER || 'local', // local | anthropic | openai-compatible
    apiKey: env.VELVIA_API_KEY || '',
    model: env.VELVIA_MODEL || '',
    baseUrl: env.VELVIA_BASE_URL || '',
    timeoutMs: int(env.VELVIA_TIMEOUT_MS, 20000),
  },

  tmdb: { token: env.TMDB_API_TOKEN || '' },

  monetization: { mode: env.MONETIZATION_MODE || 'free' },

  features: {
    communityComments: bool(env.FEATURE_REVIEW_COMMENTS, true),
    watchParties: bool(env.FEATURE_WATCH_PARTIES, true),
    sharedCollections: bool(env.FEATURE_SHARED_COLLECTIONS, true),
    requireSigninToPlay: bool(env.REQUIRE_SIGNIN_TO_PLAY, false),
  },
};

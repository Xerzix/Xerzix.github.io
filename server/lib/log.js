// Structured JSON logging to stdout plus an in-memory ring buffer that the admin
// dashboard reads ("System logs"). Never log secrets, tokens, passwords or bodies.
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] ?? (process.env.NODE_ENV === 'test' ? LEVELS.error : LEVELS.info);
const RING_SIZE = 2000;
const ring = [];

function write(level, msg, fields = {}) {
  const entry = { t: new Date().toISOString(), level, msg, ...fields };
  if (fields.err instanceof Error) {
    entry.err = { name: fields.err.name, message: fields.err.message, stack: fields.err.stack?.split('\n').slice(0, 6).join('\n') };
  }
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.shift();
  if (LEVELS[level] >= threshold) {
    const line = JSON.stringify(entry);
    if (LEVELS[level] >= LEVELS.warn) process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }
}

export const log = {
  debug: (msg, f) => write('debug', msg, f),
  info: (msg, f) => write('info', msg, f),
  warn: (msg, f) => write('warn', msg, f),
  error: (msg, f) => write('error', msg, f),
};

export function recentLogs({ level = 'debug', limit = 200, contains = '' } = {}) {
  const min = LEVELS[level] ?? 0;
  const needle = contains.toLowerCase();
  const out = [];
  for (let i = ring.length - 1; i >= 0 && out.length < limit; i--) {
    const e = ring[i];
    if (LEVELS[e.level] < min) continue;
    if (needle && !JSON.stringify(e).toLowerCase().includes(needle)) continue;
    out.push(e);
  }
  return out;
}

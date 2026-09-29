// SQLite access through Node's built-in driver (node:sqlite). Provides cached prepared
// statements, transactions (nestable via savepoints), JSON helpers and a migration runner.
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { log } from '../lib/log.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export class Database {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(dirname(file), { recursive: true });
    this.file = file;
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.cache = new Map();
    this.depth = 0;
  }

  prepare(sql) {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.raw.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return stmt;
  }

  /** First row or undefined. */
  get(sql, ...params) {
    const row = this.prepare(sql).get(...params);
    return row ? { ...row } : undefined;
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...params).map((r) => ({ ...r }));
  }

  run(sql, ...params) {
    const r = this.prepare(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }

  exec(sql) {
    this.raw.exec(sql);
  }

  /** Runs fn inside a transaction. Nested calls use savepoints. fn must be synchronous. */
  tx(fn) {
    const sp = `sp_${this.depth}`;
    this.raw.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth++;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') throw new Error('db.tx callbacks must be synchronous');
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.depth--;
      this.raw.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      throw err;
    }
  }

  migrate() {
    this.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`);
    const applied = new Set(this.all('SELECT version FROM schema_migrations').map((r) => r.version));
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_[\w-]+\.sql$/.test(f)).sort();
    const ran = [];
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) continue;
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      this.tx(() => {
        this.exec(sql);
        this.run('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)', version, now());
      });
      ran.push(version);
      log.info('migration applied', { version });
    }
    return ran;
  }

  close() {
    this.cache.clear();
    this.raw.close();
  }
}

export const now = () => new Date().toISOString();

/** Parses a JSON column, returning `fallback` for null or malformed data. */
export function parseJson(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export const toJson = (value) => JSON.stringify(value ?? null);

/** Builds "?, ?, ?" for IN clauses. */
export const placeholders = (n) => Array.from({ length: n }, () => '?').join(', ');

export function openDatabase(file) {
  const db = new Database(file);
  db.migrate();
  return db;
}

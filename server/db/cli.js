// Operational commands:
//   node server/db/cli.js migrate
//   node server/db/cli.js seed
//   node server/db/cli.js create-admin <email>        (password read from LUMINA_ADMIN_PASSWORD or prompted)
//   node server/db/cli.js export-catalog [outfile]    (writes the Preview-mode snapshot)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { config, ROOT } from '../config.js';
import { openDatabase, now } from './index.js';
import { seedIfEmpty, exportCatalog } from '../seed/seed.js';
import { CatalogService } from '../services/catalog.js';
import { hashPassword, newId } from '../lib/crypto.js';

const [cmd, ...args] = process.argv.slice(2);
const db = openDatabase(config.dbPath);

async function readPassword() {
  if (process.env.LUMINA_ADMIN_PASSWORD) return process.env.LUMINA_ADMIN_PASSWORD;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const pw = await rl.question('Password (min 10 characters): ');
  rl.close();
  return pw;
}

switch (cmd) {
  case 'migrate':
    console.log('Migrations up to date.');
    break;
  case 'seed':
    console.log(`Seeded ${seedIfEmpty(db)} titles.`);
    break;
  case 'create-admin': {
    const email = args[0];
    if (!email) throw new Error('Usage: create-admin <email>');
    const password = await readPassword();
    if (password.length < config.auth.minPasswordLength) throw new Error('Password too short.');
    const existing = db.get('SELECT id FROM accounts WHERE email = ?', email);
    const ts = now();
    if (existing) {
      db.run("UPDATE accounts SET role = 'admin', password_hash = ?, updated_at = ? WHERE id = ?", await hashPassword(password), ts, existing.id);
      console.log(`Promoted ${email} to admin.`);
    } else {
      const id = newId('acc');
      db.tx(() => {
        db.run(
          `INSERT INTO accounts (id, email, display_name, password_hash, role, created_at, updated_at, terms_accepted_at) VALUES (?, ?, ?, ?, 'admin', ?, ?, ?)`,
          id, email, 'Administrator', '', ts, ts, ts,
        );
        db.run('INSERT INTO profiles (id, account_id, name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', newId('prf'), id, 'Administrator', 'lantern', ts, ts);
      });
      db.run('UPDATE accounts SET password_hash = ? WHERE id = ?', await hashPassword(password), id);
      console.log(`Created admin ${email}.`);
    }
    break;
  }
  case 'export-catalog': {
    seedIfEmpty(db);
    const out = args[0] || join(ROOT, 'data', 'catalog.json');
    const snapshot = exportCatalog(db, new CatalogService(db));
    writeFileSync(out, JSON.stringify(snapshot, null, 1) + '\n');
    console.log(`Wrote ${snapshot.titles.length} titles to ${out}`);
    break;
  }
  default:
    console.log('Commands: migrate | seed | create-admin <email> | export-catalog [outfile]');
}
db.close();

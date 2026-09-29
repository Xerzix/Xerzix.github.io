// Outbound email boundary. Lumina does not ship an SMTP client; production deployments
// point MAIL_TRANSPORT=webhook at a transactional mail provider (or a small relay) that
// accepts {from, to, subject, text} JSON. The default "log" transport writes messages to the
// server log and keeps the last few in memory for local development and tests.
import { config } from '../config.js';
import { log } from '../lib/log.js';

const outbox = [];

export async function sendMail({ to, subject, text }) {
  const message = { from: config.mail.from, to, subject, text, at: new Date().toISOString() };
  if (config.mail.transport === 'webhook') {
    if (!config.mail.webhookUrl) throw new Error('MAIL_WEBHOOK_URL is not configured');
    const res = await fetch(config.mail.webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(config.mail.webhookToken ? { Authorization: `Bearer ${config.mail.webhookToken}` } : {}),
      },
      body: JSON.stringify(message),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      log.error('mail delivery failed', { status: res.status, to: redact(to) });
      throw new Error(`Mail provider responded ${res.status}`);
    }
    log.info('mail sent', { to: redact(to), subject });
    return;
  }
  // Development transport: never used when NODE_ENV=production unless explicitly chosen.
  outbox.push(message);
  if (outbox.length > 50) outbox.shift();
  if (!config.isTest) log.info('mail (log transport)', { to: redact(to), subject, text });
}

/** Test/dev helper: messages captured by the log transport. */
export function devOutbox() {
  return outbox;
}

function redact(email) {
  const [user, domain] = String(email).split('@');
  return `${user.slice(0, 2)}***@${domain}`;
}

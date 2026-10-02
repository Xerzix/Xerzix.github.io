// Spam heuristics for reviews and replies. `assessSpam` is pure (no I/O) so it can be unit
// tested; the review service gathers the account context (recent posts, reused text) and
// passes it in. A score at or above SPAM_THRESHOLD holds the post for a moderator: it is
// never deleted automatically, and nothing is published or hidden without a human decision
// beyond this hold.

export const SPAM_THRESHOLD = 3;
export const BURST_WINDOW_MS = 10 * 60_000;
export const BURST_MAX = 5; // more than 5 posts in 10 minutes is a burst

// Small, conservative blocklist of phrases that are almost never part of a genuine review.
export const BLOCKLIST = [
  'buy now', 'click here', 'free money', 'make money fast', 'earn money from home', 'work from home', 'crypto giveaway',
  'double your bitcoin', 'casino bonus', 'online casino', 'viagra', 'cialis', 'onlyfans', 'free followers',
  'cheap followers', 'dm me on telegram', 'whatsapp me', 'limited time offer', 'free iptv', 'watch free full movie',
  'download full movie', 'free movie download', 'promo code', 'forex signals',
];

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s]+|\b[a-z0-9-]{2,}\.(?:com|net|org|io|ru|xyz|top|info|biz|link|click|shop|site|online|live)\b(?:\/[^\s]*)?/gi;
const EMAIL_RE = /\b[^\s@]+@[^\s@]+\.[a-z]{2,}\b/i;
const PHONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const hasPhoneNumber = (text) => (text.match(PHONE_RE) || []).some((m) => m.replace(/\D/g, '').length >= 9);

/** Lower-cases and collapses whitespace so reused text is recognised. */
export function normalizeForCompare(text) {
  return String(text || '').toLowerCase().normalize('NFKC').replace(/\s+/g, ' ').trim();
}

/**
 * Scores a post.
 *   text: the body; context: { recentCount, duplicateCount }
 *     recentCount    posts of the same kind by this account in the last 10 minutes (excluding this one)
 *     duplicateCount other posts by this account (on other titles/reviews) with identical text
 * → { score, held, reasons: [{ code, detail }] }
 */
export function assessSpam(text, { recentCount = 0, duplicateCount = 0 } = {}) {
  const reasons = [];
  let score = 0;
  const add = (points, code, detail) => {
    score += points;
    reasons.push({ code, detail });
  };
  const body = String(text || '');

  const links = body.match(URL_RE) || [];
  if (links.length >= 3) add(3, 'links', `${links.length} links`);
  else if (links.length === 2) add(2, 'links', '2 links');
  else if (links.length === 1) add(1, 'links', '1 link');

  if (EMAIL_RE.test(body) || hasPhoneNumber(body)) add(1, 'contact', 'Contact details');

  const letters = body.replace(/[^\p{L}]/gu, '');
  const upper = body.replace(/[^\p{Lu}]/gu, '');
  if (letters.length >= 20 && upper.length / letters.length > 0.7) add(2, 'shouting', `${Math.round((upper.length / letters.length) * 100)}% capitals`);

  if (/(.)\1{7,}/u.test(body)) add(1.5, 'repeated_characters', 'Long run of one character');
  const words = normalizeForCompare(body).split(' ').filter((w) => w.length > 1);
  if (words.length >= 6) {
    const counts = new Map();
    for (const w of words) counts.set(w, (counts.get(w) || 0) + 1);
    const top = Math.max(...counts.values());
    if (top >= 5 && top / words.length > 0.4) add(1.5, 'repeated_words', 'The same word repeated');
  }

  const lower = normalizeForCompare(body);
  const hits = BLOCKLIST.filter((p) => lower.includes(p));
  if (hits.length) add(3 * hits.length, 'blocklist', hits.join(', '));

  if (body.trim().length >= 12 && duplicateCount > 0) add(3, 'duplicate', `Same text posted ${duplicateCount} other time${duplicateCount === 1 ? '' : 's'}`);
  if (recentCount + 1 > BURST_MAX) add(3, 'burst', `${recentCount + 1} posts in 10 minutes`);

  score = Math.round(score * 10) / 10;
  return { score, held: score >= SPAM_THRESHOLD, reasons };
}

/** One-line explanation stored as the moderation note when a post is held. */
export function holdNote(result) {
  return `Held by the automatic spam filter (score ${result.score}): ${result.reasons.map((r) => r.detail).join('; ')}.`;
}

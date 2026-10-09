// Password policy for registration, password changes and resets. Length is the main
// defence (≥ 10 characters); on top of that we refuse well-known passwords (and simple
// "word + digits" variants of them) and passwords that contain the email's local part.
import { config } from '../config.js';
import { validation } from '../lib/errors.js';

export const PASSWORD_MAX = 200;

// Frequently breached passwords that already satisfy the minimum length.
const COMMON_PASSWORDS = new Set([
  '1234567890', '12345678910', '123456789012', '0123456789', '0987654321', '1111111111', '0000000000', '1122334455',
  '1234512345', '1234567891', '9876543210', '1q2w3e4r5t', '1q2w3e4r5t6y', 'q1w2e3r4t5', 'qwertyuiop', 'qwertyuiop[]',
  'asdfghjkl;', 'asdfghjkl', 'zxcvbnm123', 'qwerty12345', 'qwerty123456', 'qwertyuiop1', 'qazwsxedc123', 'qazwsxedcrfv',
  '1qaz2wsx3edc', 'zaq12wsxcde3', 'password12', 'password123', 'password1234', 'password12345', 'passw0rd123', 'p@ssw0rd123',
  'password!123', 'password2024', 'password2025', 'password2026', 'iloveyou123', 'iloveyou12', 'iloveyou!!', 'letmein123',
  'letmein1234', 'welcome123', 'welcome1234', 'welcome2024', 'welcome2025', 'welcome2026', 'sunshine123', 'princess123',
  'football123', 'baseball123', 'basketball', 'basketball1', 'superman123', 'batman12345', 'starwars123', 'dragon12345',
  'monkey12345', 'master12345', 'shadow12345', 'michael123', 'jennifer123', 'jordan2323', 'liverpool1', 'chelsea123',
  'computer123', 'internet123', 'trustno1234', 'whatever123', 'freedom123', 'abcdefghij', 'abcdefg123', 'abc123456789',
  'abcd123456', 'abcd1234abcd', 'a1b2c3d4e5', 'aaaaaaaaaa', 'administrator', 'admin12345', 'admin123456', 'changeme123',
  'changeme12', 'secret1234', 'mypassword', 'mypassword1', 'mypassword123', 'yourpassword', 'thisisapassword',
  'correcthorsebatterystaple', 'lumina12345', 'lumina123456', 'luminastream', 'netflix123', 'streaming123', 'movies12345',
  'q1w2e3r4t5y6', '147258369a', '123123123123', '789456123a', '11223344556', 'iloveyouiloveyou', 'loveyou1234',
  'qwerty123qwerty', 'passwordpassword', '1234qwerasdf', 'zxcvbnmasdf', 'asdf1234asdf',
]);

// Words that are refused when they make up the whole password apart from digits/symbols
// (so "Password2026!" or "sunshine!!12" are refused, while a real passphrase is not).
const COMMON_WORDS = new Set([
  'password', 'passw', 'passwd', 'passwort', 'qwerty', 'qwertyuiop', 'asdfgh', 'asdfghjkl', 'zxcvbnm', 'iloveyou', 'letmein',
  'welcome', 'admin', 'administrator', 'sunshine', 'princess', 'football', 'baseball', 'basketball', 'superman', 'batman',
  'starwars', 'dragon', 'monkey', 'master', 'shadow', 'trustno', 'whatever', 'freedom', 'secret', 'changeme', 'lumina',
  'netflix', 'streaming', 'movies', 'abc', 'abcdef', 'abcdefgh', 'love', 'hello', 'default', 'test', 'guest', 'login',
]);

/** Returns a human-readable problem with the password, or null when it is acceptable. */
export function passwordProblem(password, { email } = {}) {
  const min = config.auth.minPasswordLength;
  if (typeof password !== 'string' || password.length < min) return `Use at least ${min} characters.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  const lower = password.normalize('NFKC').toLowerCase();
  if (/^(.)\1+$/.test(lower)) return 'Avoid repeating a single character. Try a phrase of a few words.';
  const letters = lower.replace(/[^\p{L}]/gu, '');
  if (COMMON_PASSWORDS.has(lower) || COMMON_PASSWORDS.has(lower.replace(/\s+/g, '')) || COMMON_WORDS.has(letters)) {
    return 'This password is too common. Try a longer phrase that is unique to you.';
  }
  if (!letters && password.length < 16) return 'Add some letters, or use a longer passphrase.';
  const local = String(email || '').split('@')[0].toLowerCase();
  if (local.length >= 3 && lower.includes(local)) return 'Your password must not contain your email address.';
  return null;
}

/** Throws 422 VALIDATION_FAILED with `{ [field]: problem }` when the policy is not met. */
export function assertPasswordPolicy(password, { email, field = 'password' } = {}) {
  const problem = passwordProblem(password, { email });
  if (problem) throw validation({ [field]: problem });
}

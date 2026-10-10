-- Identities (050–059): separate accounts chosen on "Who's watching?".
--
-- Each identity on the opening screen is its own account — its own username, password, session,
-- watchlist, history, ratings, language, theme and Velvia preferences. (Profiles still exist
-- inside an account, e.g. a kids profile managed by a parent; they share that account's sign-in.)

-- Unique usernames, enforced by the database regardless of letter case. Existing accounts get a
-- username at startup (services/identities.js backfillUsernames); new ones choose it at sign-up.
ALTER TABLE accounts ADD COLUMN username TEXT COLLATE NOCASE;
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_username ON accounts(username COLLATE NOCASE);

-- The identity's picture on "Who's watching?" and in the navigation (an id from js/ui/avatars.js).
ALTER TABLE accounts ADD COLUMN avatar TEXT;

-- A browser that has signed in to Lumina. The device cookie holds a random token; only its
-- SHA-256 is stored. A device lists the identities used on it — at most five.
CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  token_hash   TEXT NOT NULL UNIQUE,
  user_agent   TEXT,
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS device_identities (
  device_id      TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Five slots (0–4) per device; UNIQUE + CHECK make a sixth impossible at the database level.
  slot           INTEGER NOT NULL CHECK (slot BETWEEN 0 AND 4),
  -- "Keep me signed in on this device": until this time the identity can be entered from
  -- "Who's watching?" without its password. Signing out clears it.
  remember_until TEXT,
  added_at       TEXT NOT NULL,
  last_used_at   TEXT,
  PRIMARY KEY (device_id, account_id),
  UNIQUE (device_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_device_identities_account ON device_identities(account_id);

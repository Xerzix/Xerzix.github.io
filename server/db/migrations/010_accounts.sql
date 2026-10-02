-- Accounts slice (010–019).
-- Password-reset lookups by account (invalidating older tokens) and the "where you're signed in"
-- list (by account, most recent first) are frequent enough to index.
CREATE INDEX IF NOT EXISTS idx_password_resets_account ON password_resets(account_id, used_at);
CREATE INDEX IF NOT EXISTS idx_sessions_account_seen ON sessions(account_id, last_seen_at);

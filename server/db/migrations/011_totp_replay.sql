-- Accounts slice (010–019).
-- The last TOTP time step (Unix time / 30 s) accepted for the account. A code is accepted only
-- for a later step, so a seen code cannot be replayed within its validity window (RFC 6238 §5.2).
ALTER TABLE accounts ADD COLUMN totp_last_step INTEGER;

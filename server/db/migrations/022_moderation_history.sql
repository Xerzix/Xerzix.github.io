-- Community (020–029): a record of posts a moderator (or 3 member reports) took down, kept
-- after the author deletes the post. A new review on the same title, a new reply on the same
-- review, or the same text posted again by that account is held for a moderator instead of
-- going live, so deleting and re-posting cannot undo a moderation decision.
CREATE TABLE moderation_history (
  id           TEXT PRIMARY KEY,
  account_id   TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  target_type  TEXT NOT NULL CHECK (target_type IN ('review', 'comment')),
  target_id    TEXT NOT NULL,          -- the deleted review or reply
  title_id     TEXT,                   -- the title it was about
  review_id    TEXT,                   -- for replies: the review it answered
  body_hash    TEXT,                   -- sha256 of the normalised text (no text is kept)
  status       TEXT NOT NULL CHECK (status IN ('hidden', 'removed')),
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_moderation_history_account ON moderation_history(account_id, target_type, created_at);

-- Community: reviews, replies, reports and blocks (range 020–029 belongs to community & creators).

-- When the author last changed the rating, text or spoiler flag (drives the "edited" label;
-- moderation status changes do not count as edits).
ALTER TABLE reviews ADD COLUMN edited_at TEXT;
CREATE INDEX idx_reviews_account_created ON reviews(account_id, created_at);

-- Replies gain a 'pending' state (held by the spam filter until a moderator looks at it) and a
-- moderation note. SQLite cannot change a CHECK constraint in place, so the table is rebuilt.
-- No other table references review_comments.
CREATE TABLE review_comments_v2 (
  id               TEXT PRIMARY KEY,
  review_id        TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id       TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  body             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  moderation_note  TEXT,
  spam_score       REAL NOT NULL DEFAULT 0,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
INSERT INTO review_comments_v2 (id, review_id, account_id, profile_id, body, status, spam_score, created_at, updated_at)
  SELECT id, review_id, account_id, profile_id, body, status, spam_score, created_at, updated_at FROM review_comments;
DROP TABLE review_comments;
ALTER TABLE review_comments_v2 RENAME TO review_comments;
CREATE INDEX idx_comments_review ON review_comments(review_id, created_at);
CREATE INDEX idx_comments_account ON review_comments(account_id, created_at);

-- Blocks get an opaque id (so the API never exposes another member's account id) and the
-- name that was shown when the block was made.
ALTER TABLE blocks ADD COLUMN id TEXT;
ALTER TABLE blocks ADD COLUMN label TEXT;
CREATE UNIQUE INDEX idx_blocks_id ON blocks(id);

CREATE INDEX idx_reports_target ON reports(target_type, target_id, status);
CREATE INDEX idx_review_votes_account ON review_votes(account_id);

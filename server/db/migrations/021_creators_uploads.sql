-- Creators, submissions, resumable uploads and transcoding.

-- At most one open (pending or info_required) creator application per account.
CREATE UNIQUE INDEX idx_creator_apps_active ON creator_applications(account_id) WHERE status IN ('pending', 'info_required');

-- What a completed upload produced: {fileId} for submissions, {url, width, height} for artwork.
ALTER TABLE uploads ADD COLUMN result TEXT NOT NULL DEFAULT '{}';
CREATE INDEX idx_uploads_submission ON uploads(submission_id, status);
CREATE INDEX idx_uploads_expiry ON uploads(status, expires_at);

CREATE INDEX idx_transcode_media ON transcode_jobs(media_id, created_at);
CREATE INDEX idx_titles_submission ON titles(submission_id);

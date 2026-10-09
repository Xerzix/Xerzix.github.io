-- Administration and notifications (range 030–039).

-- Last verification attempt for a media row: what the server read from the manifest or
-- file, or why it could not verify it. Successful checks also set media.verified_at.
ALTER TABLE media ADD COLUMN verify_report TEXT NOT NULL DEFAULT '{}';

-- Admin dashboard queries (filters, queues and history).
CREATE INDEX IF NOT EXISTS idx_adm_audit_action ON audit_log(action, created_at);
CREATE INDEX IF NOT EXISTS idx_adm_audit_actor ON audit_log(actor_account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_adm_reviews_status ON reviews(status, created_at);
CREATE INDEX IF NOT EXISTS idx_adm_comments_status ON review_comments(status, created_at);
CREATE INDEX IF NOT EXISTS idx_adm_reports_target ON reports(target_type, target_id, status);
CREATE INDEX IF NOT EXISTS idx_adm_accounts_role ON accounts(role, status);
CREATE INDEX IF NOT EXISTS idx_adm_announcements_window ON announcements(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_adm_quality_status ON quality_reports(status, created_at);
CREATE INDEX IF NOT EXISTS idx_adm_playback_sessions_started ON playback_sessions(started_at);
CREATE INDEX IF NOT EXISTS idx_adm_creator_apps_account ON creator_applications(account_id);
CREATE INDEX IF NOT EXISTS idx_adm_notifications_type ON notifications(account_id, type);

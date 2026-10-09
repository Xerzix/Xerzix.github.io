-- Playback (040–049): indexes for the quality summary, per-member report caps and the
-- error log. The tables themselves are defined in 001_core.sql.
CREATE INDEX IF NOT EXISTS idx_quality_reports_account ON quality_reports(account_id, title_id, created_at);
CREATE INDEX IF NOT EXISTS idx_playback_errors_title ON playback_errors(title_id, created_at);
CREATE INDEX IF NOT EXISTS idx_playback_sessions_updated ON playback_sessions(updated_at);

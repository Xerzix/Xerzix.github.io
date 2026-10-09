-- Lumina core schema. Timestamps are ISO-8601 UTC strings. JSON columns are TEXT.
-- Identifiers are opaque random strings (see server/lib/crypto.js newId) except catalog
-- slugs (titles, seasons, episodes) which are readable and stable.

-- ───────────────────────── Accounts, sessions, profiles ─────────────────────────
CREATE TABLE accounts (
  id               TEXT PRIMARY KEY,
  email            TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name     TEXT NOT NULL DEFAULT '',
  password_hash    TEXT NOT NULL,
  role             TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'moderator', 'admin')),
  is_creator       INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  suspended_reason TEXT,
  suspended_until  TEXT,
  email_verified_at TEXT,
  totp_secret      TEXT,            -- AES-GCM encrypted (server/lib/crypto.js encryptField)
  totp_enabled     INTEGER NOT NULL DEFAULT 0,
  failed_logins    INTEGER NOT NULL DEFAULT 0,
  locked_until     TEXT,
  max_profiles     INTEGER NOT NULL DEFAULT 5 CHECK (max_profiles BETWEEN 1 AND 5),
  settings         TEXT NOT NULL DEFAULT '{}',  -- account-level preferences (notification prefs)
  terms_accepted_at TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  last_login_at    TEXT
);

CREATE TABLE profiles (
  id                 TEXT PRIMARY KEY,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name               TEXT NOT NULL,
  avatar             TEXT NOT NULL DEFAULT 'sakura',
  is_kids            INTEGER NOT NULL DEFAULT 0,
  max_age            INTEGER,              -- NULL = unrestricted; otherwise highest allowed title min_age
  pin_hash           TEXT,                 -- scrypt hash of a 4-digit PIN protecting entry and settings
  ui_language        TEXT NOT NULL DEFAULT 'en',
  audio_language     TEXT,
  subtitle_language  TEXT,
  subtitles_default  INTEGER NOT NULL DEFAULT 0,
  autoplay_next      INTEGER NOT NULL DEFAULT 1,
  autoplay_previews  INTEGER NOT NULL DEFAULT 1,
  preferences        TEXT NOT NULL DEFAULT '{}',  -- appearance, environment, subtitle style, privacy …
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (account_id, name)
);
CREATE INDEX idx_profiles_account ON profiles(account_id);

-- Defence in depth for the per-account profile limit (the service checks first).
CREATE TRIGGER profiles_limit BEFORE INSERT ON profiles
WHEN (SELECT COUNT(*) FROM profiles WHERE account_id = NEW.account_id)
     >= (SELECT max_profiles FROM accounts WHERE id = NEW.account_id)
BEGIN
  SELECT RAISE(ABORT, 'PROFILE_LIMIT');
END;

CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  account_id      TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,
  profile_id      TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  last_seen_at    TEXT NOT NULL,
  expires_at      TEXT NOT NULL,
  elevated_until  TEXT,                    -- "sudo mode" after password (and TOTP) re-entry
  user_agent      TEXT,
  ip              TEXT
);
CREATE INDEX idx_sessions_account ON sessions(account_id);

CREATE TABLE password_resets (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  ip          TEXT
);

-- ───────────────────────── Catalog ─────────────────────────
CREATE TABLE titles (
  id                 TEXT PRIMARY KEY,           -- slug
  type               TEXT NOT NULL CHECK (type IN ('movie', 'series')),
  title              TEXT NOT NULL,
  original_title     TEXT,
  tagline            TEXT,
  synopsis           TEXT NOT NULL DEFAULT '',
  year               INTEGER,
  release_date       TEXT,
  runtime_min        INTEGER,                    -- movie runtime or typical episode runtime
  age_rating         TEXT NOT NULL DEFAULT 'NR',
  rating_source      TEXT NOT NULL DEFAULT 'advisory' CHECK (rating_source IN ('official', 'advisory')),
  min_age            INTEGER NOT NULL DEFAULT 18,
  genres             TEXT NOT NULL DEFAULT '[]',
  tags               TEXT NOT NULL DEFAULT '[]', -- editorial collections, e.g. hidden-gem, lumina-original
  moods              TEXT NOT NULL DEFAULT '[]', -- descriptive facets used by search and Velvia
  keywords           TEXT NOT NULL DEFAULT '[]',
  countries          TEXT NOT NULL DEFAULT '[]',
  original_language  TEXT,
  credits            TEXT NOT NULL DEFAULT '{}', -- {directors:[], cast:[{name,role}], crew:[{name,job}]}
  awards             TEXT NOT NULL DEFAULT '[]',
  poster             TEXT,
  backdrop           TEXT,
  palette            TEXT NOT NULL DEFAULT '[]', -- hex colours for ambient mode
  license            TEXT NOT NULL DEFAULT '{}', -- {name, url, attribution, source}
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished')),
  featured           INTEGER NOT NULL DEFAULT 0,
  editorial_rank     INTEGER NOT NULL DEFAULT 1000,
  creator_account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  submission_id      TEXT,
  added_at           TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  published_at       TEXT
);
CREATE INDEX idx_titles_status ON titles(status, type);
CREATE INDEX idx_titles_added ON titles(added_at);

CREATE TABLE seasons (
  id        TEXT PRIMARY KEY,
  title_id  TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  number    INTEGER NOT NULL,
  name      TEXT,
  synopsis  TEXT,
  year      INTEGER,
  UNIQUE (title_id, number)
);

CREATE TABLE episodes (
  id             TEXT PRIMARY KEY,
  title_id       TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  season_number  INTEGER NOT NULL,
  number         INTEGER NOT NULL,
  name           TEXT NOT NULL,
  synopsis       TEXT NOT NULL DEFAULT '',
  runtime_min    INTEGER,
  still          TEXT,
  air_date       TEXT,
  UNIQUE (title_id, season_number, number)
);
CREATE INDEX idx_episodes_title ON episodes(title_id, season_number, number);

-- A playable rendition set. Resolutions/tracks describe only what the media actually
-- contains; `verified_at` records when that was checked against the manifest or file.
CREATE TABLE media (
  id               TEXT PRIMARY KEY,
  title_id         TEXT REFERENCES titles(id) ON DELETE CASCADE,
  episode_id       TEXT REFERENCES episodes(id) ON DELETE CASCADE,
  role             TEXT NOT NULL DEFAULT 'main' CHECK (role IN ('main', 'trailer', 'extra')),
  label            TEXT,
  kind             TEXT NOT NULL CHECK (kind IN ('hls', 'dash', 'progressive')),
  source           TEXT NOT NULL,             -- URL, site path, or "storage:<key>" for private storage
  fallbacks        TEXT NOT NULL DEFAULT '[]',-- alternative sources tried on fatal errors: [{kind, src}]
  variants         TEXT NOT NULL DEFAULT '[]',-- progressive only: [{height, src, bitrateKbps}]
  resolutions      TEXT NOT NULL DEFAULT '[]',-- verified heights, e.g. [2160,1080,720]
  audio_tracks     TEXT NOT NULL DEFAULT '[]',-- [{lang, label, kind, default}]
  subtitle_tracks  TEXT NOT NULL DEFAULT '[]',-- [{lang, label, kind, src, default}]
  audio_formats    TEXT NOT NULL DEFAULT '[]',
  video_codecs     TEXT NOT NULL DEFAULT '[]',
  hdr              TEXT,
  duration_s       REAL,
  intro_start      REAL,
  intro_end        REAL,
  credits_start    REAL,
  status           TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing', 'ready', 'failed')),
  verified_at      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_media_title ON media(title_id, role);
CREATE INDEX idx_media_episode ON media(episode_id);

-- ───────────────────────── Personal library (per profile) ─────────────────────────
CREATE TABLE watchlist (
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title_id    TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  added_at    TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (profile_id, title_id)
);

CREATE TABLE progress (
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title_id    TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id  TEXT NOT NULL DEFAULT '',   -- '' for movies
  position_s  REAL NOT NULL DEFAULT 0,
  duration_s  REAL,
  completed   INTEGER NOT NULL DEFAULT 0,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, title_id, episode_id)
);
CREATE INDEX idx_progress_recent ON progress(profile_id, updated_at);

CREATE TABLE history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  title_id    TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id  TEXT NOT NULL DEFAULT '',
  watched_at  TEXT NOT NULL,     -- start of the viewing session
  updated_at  TEXT NOT NULL,
  seconds     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_history_profile ON history(profile_id, watched_at);
CREATE INDEX idx_history_title ON history(title_id, watched_at);

CREATE TABLE collections (
  id           TEXT PRIMARY KEY,
  profile_id   TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  description  TEXT NOT NULL DEFAULT '',
  visibility   TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'unlisted')),
  share_token  TEXT UNIQUE,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_collections_profile ON collections(profile_id);

CREATE TABLE collection_items (
  collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
  title_id      TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  position      INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  added_at      TEXT NOT NULL,
  PRIMARY KEY (collection_id, title_id)
);

CREATE TABLE follows (
  profile_id  TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  target_type TEXT NOT NULL CHECK (target_type IN ('series', 'creator', 'genre')),
  target_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (profile_id, target_type, target_id)
);

-- ───────────────────────── Community ─────────────────────────
CREATE TABLE reviews (
  id                 TEXT PRIMARY KEY,
  title_id           TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  account_id         TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id         TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  rating             INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  body               TEXT,                         -- NULL = rating without a written review
  contains_spoilers  INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'pending', 'hidden', 'removed')),
  moderation_note    TEXT,
  spam_score         REAL NOT NULL DEFAULT 0,
  helpful_count      INTEGER NOT NULL DEFAULT 0,
  comment_count      INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  UNIQUE (title_id, profile_id)
);
CREATE INDEX idx_reviews_title ON reviews(title_id, status, created_at);
CREATE INDEX idx_reviews_account ON reviews(account_id);

CREATE TABLE review_votes (
  review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL,
  PRIMARY KEY (review_id, account_id)
);

CREATE TABLE review_comments (
  id          TEXT PRIMARY KEY,
  review_id   TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id  TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  body        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'visible' CHECK (status IN ('visible', 'hidden', 'removed')),
  spam_score  REAL NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX idx_comments_review ON review_comments(review_id, created_at);

CREATE TABLE reports (
  id                   TEXT PRIMARY KEY,
  target_type          TEXT NOT NULL CHECK (target_type IN ('review', 'comment', 'collection')),
  target_id            TEXT NOT NULL,
  reporter_account_id  TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  reason               TEXT NOT NULL CHECK (reason IN ('spam', 'harassment', 'hate', 'spoilers', 'sexual', 'violence', 'misinformation', 'copyright', 'other')),
  details              TEXT,
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'dismissed')),
  resolution_note      TEXT,
  resolved_by          TEXT,
  resolved_at          TEXT,
  created_at           TEXT NOT NULL,
  UNIQUE (target_type, target_id, reporter_account_id)
);
CREATE INDEX idx_reports_status ON reports(status, created_at);

CREATE TABLE blocks (
  account_id          TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  blocked_account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (account_id, blocked_account_id)
);

-- ───────────────────────── Playback quality & telemetry ─────────────────────────
-- User-submitted, subjective reports.
CREATE TABLE quality_reports (
  id                   TEXT PRIMARY KEY,
  title_id             TEXT NOT NULL REFERENCES titles(id) ON DELETE CASCADE,
  episode_id           TEXT,
  media_id             TEXT,
  account_id           TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  category             TEXT NOT NULL CHECK (category IN ('buffering', 'interruptions', 'poor_quality', 'audio_sync', 'missing_subtitles', 'wrong_language', 'playback_error', 'crash', 'other')),
  description          TEXT,
  device               TEXT,
  connection_mbps      REAL,
  selected_resolution  TEXT,
  diagnostics          TEXT,     -- optional player measurements the user chose to attach (JSON)
  status               TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'acknowledged', 'resolved')),
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_quality_title ON quality_reports(title_id, created_at);

-- Measured by the player itself (objective). One row per viewing session.
CREATE TABLE playback_sessions (
  id                 TEXT PRIMARY KEY,
  media_id           TEXT,
  title_id           TEXT,
  episode_id         TEXT,
  account_id         TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  started_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  seconds_watched    REAL NOT NULL DEFAULT 0,
  startup_ms         INTEGER,
  rebuffer_count     INTEGER NOT NULL DEFAULT 0,
  rebuffer_seconds   REAL NOT NULL DEFAULT 0,
  avg_bitrate_kbps   REAL,
  max_height         INTEGER,
  dropped_frames     INTEGER NOT NULL DEFAULT 0,
  bytes_estimate     INTEGER NOT NULL DEFAULT 0,
  error_count        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_playback_sessions_title ON playback_sessions(title_id, started_at);

CREATE TABLE playback_errors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id    TEXT,
  title_id    TEXT,
  episode_id  TEXT,
  account_id  TEXT,
  code        TEXT NOT NULL,
  message     TEXT,
  fatal       INTEGER NOT NULL DEFAULT 0,
  details     TEXT,
  user_agent  TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX idx_playback_errors_created ON playback_errors(created_at);

-- ───────────────────────── Creators & submissions ─────────────────────────
CREATE TABLE creator_applications (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  legal_name     TEXT NOT NULL,
  contact_email  TEXT NOT NULL,
  company        TEXT,
  website        TEXT,
  portfolio      TEXT,
  country        TEXT,
  bio            TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'info_required', 'approved', 'rejected')),
  reviewer_note  TEXT,
  reviewed_by    TEXT,
  reviewed_at    TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX idx_creator_apps_status ON creator_applications(status, created_at);

CREATE TABLE submissions (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  project_title    TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  content_type     TEXT NOT NULL CHECK (content_type IN ('movie', 'short', 'documentary', 'pilot', 'series', 'episode', 'trailer')),
  runtime_min      INTEGER,
  genres           TEXT NOT NULL DEFAULT '[]',
  language         TEXT,
  release_year     INTEGER,
  country          TEXT,
  trailer_url      TEXT,
  additional_info  TEXT,
  rights           TEXT NOT NULL DEFAULT '{}',
  attested_at      TEXT,
  attestation_ip   TEXT,
  status           TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'uploading', 'submitted', 'under_review', 'info_required', 'approved', 'rejected', 'published')),
  status_reason    TEXT,
  title_id         TEXT REFERENCES titles(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  submitted_at     TEXT
);
CREATE INDEX idx_submissions_account ON submissions(account_id, updated_at);
CREATE INDEX idx_submissions_status ON submissions(status, updated_at);

CREATE TABLE uploads (
  id             TEXT PRIMARY KEY,
  account_id     TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  purpose        TEXT NOT NULL CHECK (purpose IN ('submission', 'artwork', 'media')),
  submission_id  TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  file_role      TEXT,
  filename       TEXT NOT NULL,
  declared_mime  TEXT,
  size_bytes     INTEGER NOT NULL,
  offset_bytes   INTEGER NOT NULL DEFAULT 0,
  storage_key    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'complete', 'aborted', 'expired', 'rejected')),
  error          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL
);
CREATE INDEX idx_uploads_account ON uploads(account_id, status);

CREATE TABLE submission_files (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  upload_id      TEXT REFERENCES uploads(id) ON DELETE SET NULL,
  role           TEXT NOT NULL CHECK (role IN ('feature', 'episode', 'trailer', 'poster', 'backdrop', 'document', 'subtitle')),
  label          TEXT,
  original_name  TEXT NOT NULL,
  mime           TEXT NOT NULL,
  size_bytes     INTEGER NOT NULL,
  sha256         TEXT,
  probe          TEXT NOT NULL DEFAULT '{}',
  scan_status    TEXT NOT NULL DEFAULT 'pending' CHECK (scan_status IN ('pending', 'clean', 'infected', 'not_configured', 'error')),
  storage_key    TEXT NOT NULL,
  created_at     TEXT NOT NULL
);
CREATE INDEX idx_submission_files_sub ON submission_files(submission_id);

CREATE TABLE submission_events (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  submission_id        TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  actor_account_id     TEXT,
  kind                 TEXT NOT NULL CHECK (kind IN ('status', 'comment', 'info_request', 'info_response', 'file')),
  from_status          TEXT,
  to_status            TEXT,
  message              TEXT,
  visible_to_creator   INTEGER NOT NULL DEFAULT 1,
  created_at           TEXT NOT NULL
);
CREATE INDEX idx_submission_events_sub ON submission_events(submission_id, created_at);

CREATE TABLE transcode_jobs (
  id           TEXT PRIMARY KEY,
  media_id     TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  source_key   TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
  progress     REAL NOT NULL DEFAULT 0,
  ladder       TEXT NOT NULL DEFAULT '[]',
  error        TEXT,
  attempts     INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL,
  started_at   TEXT,
  finished_at  TEXT
);
CREATE INDEX idx_transcode_status ON transcode_jobs(status, created_at);

-- ───────────────────────── Notifications ─────────────────────────
CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  account_id  TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  profile_id  TEXT REFERENCES profiles(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',
  link        TEXT,
  data        TEXT NOT NULL DEFAULT '{}',
  dedupe_key  TEXT,
  read_at     TEXT,
  created_at  TEXT NOT NULL,
  UNIQUE (account_id, dedupe_key)
);
CREATE INDEX idx_notifications_account ON notifications(account_id, read_at, created_at);

CREATE TABLE announcements (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  link        TEXT,
  audience    TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'creators')),
  starts_at   TEXT NOT NULL,
  ends_at     TEXT,
  created_by  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE announcement_reads (
  account_id       TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  announcement_id  TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  read_at          TEXT,
  dismissed_at     TEXT,
  PRIMARY KEY (account_id, announcement_id)
);

-- ───────────────────────── Administration ─────────────────────────
CREATE TABLE audit_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_account_id  TEXT,
  actor_email       TEXT,
  action            TEXT NOT NULL,
  target_type       TEXT,
  target_id         TEXT,
  details           TEXT NOT NULL DEFAULT '{}',
  ip                TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);
CREATE INDEX idx_audit_target ON audit_log(target_type, target_id);

CREATE TABLE platform_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);

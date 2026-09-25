-- KLOUD.PHOTOGRAPHY — initial schema

CREATE TABLE IF NOT EXISTS admins (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,          -- pbkdf2$<iterations>$<salt_b64>$<hash_b64>
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,          -- sha-256 of the raw cookie token
  admin_id   INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS photos (
  id                TEXT PRIMARY KEY,   -- uuid v4
  title             TEXT NOT NULL DEFAULT '',
  taken_on          TEXT,               -- ISO date, YYYY-MM-DD
  description       TEXT NOT NULL DEFAULT '',

  -- the untouched original
  original_key      TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  original_type     TEXT NOT NULL,
  original_size     INTEGER NOT NULL,

  -- generated derivatives (never overwrite the original)
  preview_key       TEXT,
  thumb_key         TEXT,

  width             INTEGER,
  height            INTEGER,
  placeholder       TEXT,               -- tiny inline LQIP data URL

  sort_order        INTEGER NOT NULL DEFAULT 0,
  published         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photos_feed ON photos(published, sort_order DESC, created_at DESC);

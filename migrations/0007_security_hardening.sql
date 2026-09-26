-- Durable throttling for sign-in, setup and locked-folder password checks.
-- Keys are SHA-256 digests; no raw address, username or folder name is stored.
CREATE TABLE IF NOT EXISTS rate_limits (
  key        TEXT PRIMARY KEY,
  attempts   INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits(expires_at);

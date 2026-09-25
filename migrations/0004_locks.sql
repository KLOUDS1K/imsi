-- Password-protected folders.
--
-- A NULL password_hash means the folder is public, which is what every
-- existing row gets — so this changes nothing about what is already there.

ALTER TABLE folders ADD COLUMN password_hash TEXT;

-- Small key/value store. It holds the HMAC key that signs unlock grants and
-- media tokens; generating it lazily here rather than as a deploy-time secret
-- means a fresh deployment cannot come up half-configured.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

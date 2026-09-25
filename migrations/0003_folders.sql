-- File-explorer restructure: photos now live inside a folder tree.
--
-- Additive only. Existing photo rows keep every value they had and simply
-- land at the root level (folder_id = ''), where the explorer shows them as
-- loose files — nothing is moved or dropped.

CREATE TABLE IF NOT EXISTS folders (
  id          TEXT PRIMARY KEY,                 -- uuid v4
  -- '' means "root level". An empty string rather than NULL so that the
  -- UNIQUE index below actually constrains top-level names: SQLite treats
  -- every NULL as distinct, so UNIQUE(NULL, 'name') would never collide.
  parent_id   TEXT NOT NULL DEFAULT '',
  name        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  folder_date TEXT,                             -- optional ISO date, YYYY-MM-DD
  sort_order  INTEGER NOT NULL DEFAULT 0,
  published   INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_folders_unique_name ON folders(parent_id, name);
CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order DESC, created_at DESC);

ALTER TABLE photos ADD COLUMN folder_id TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_photos_folder ON photos(folder_id, sort_order DESC, created_at DESC);

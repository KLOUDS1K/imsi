-- Counters for the owner's stats panel.
--
-- Aggregates, not an event log: a row per hit would grow without bound and buy
-- nothing the panel shows. Every write is an upsert, and every one of them runs
-- after the response has gone out.

CREATE TABLE IF NOT EXISTS stats (
  key        TEXT PRIMARY KEY,   -- 'visits' | 'downloads' | 'views'
                                 -- 'folder:<id>' | 'photo:<id>'
  count      INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- One row per browser that has ever been here, so "unique visitors" is a
-- COUNT(*) rather than a scan of an event log.
CREATE TABLE IF NOT EXISTS visitors (
  id         TEXT PRIMARY KEY,   -- opaque random id from a first-party cookie
  first_seen INTEGER NOT NULL,
  last_seen  INTEGER NOT NULL,
  visits     INTEGER NOT NULL DEFAULT 0
);

-- A day/kind grid, which is all the chart needs.
CREATE TABLE IF NOT EXISTS daily (
  day   TEXT NOT NULL,           -- YYYY-MM-DD, UTC
  kind  TEXT NOT NULL,           -- 'visits' | 'views' | 'downloads'
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, kind)
);

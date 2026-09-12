-- Practice Tracker schema (design section 3.2).
--
-- One deviation from the design document: recorded_at defaults to
-- strftime('%Y-%m-%dT%H:%M:%fZ','now') rather than datetime('now').
-- datetime('now') emits '2026-09-12 17:04:00' (space-separated), which does not
-- sort lexicographically against the 'T'-separated ISO bound that the weekly
-- window query passes in. A uniform format is what makes `recorded_at >= ?`
-- correct.

CREATE TABLE IF NOT EXISTS objectives (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT    NOT NULL,
  weight      REAL    NOT NULL DEFAULT 1.0   CHECK (weight >= 0),
  active      INTEGER NOT NULL DEFAULT 1,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sub_objectives (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  objective_id INTEGER NOT NULL REFERENCES objectives(id),
  name         TEXT    NOT NULL,
  is_default   INTEGER NOT NULL DEFAULT 0,
  active       INTEGER NOT NULL DEFAULT 1,
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  sub_objective_id INTEGER NOT NULL REFERENCES sub_objectives(id),
  recorded_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  points           REAL    NOT NULL DEFAULT 1.0,
  note             TEXT
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sessions_sub  ON sessions(sub_objective_id);
CREATE INDEX IF NOT EXISTS idx_sessions_time ON sessions(recorded_at);

-- Design section 4.1: fix these before data accumulates. Changing either later
-- silently reshuffles every historical weekly bucket.
INSERT OR IGNORE INTO config (key, value) VALUES
  ('week_start_day', 'MO'),
  ('timezone',       'Europe/Lisbon'),
  ('window_days',    '7');

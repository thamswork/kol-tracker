-- Content being tracked (replaces the "Tracked Accounts" tab)
CREATE TABLE IF NOT EXISTS content (
  id TEXT PRIMARY KEY,
  kol TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('Instagram', 'TikTok')),
  url TEXT NOT NULL,
  date_posted TEXT,
  fee_paid REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Done')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- One row per performance check (replaces the "Snapshots" tab)
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_id TEXT NOT NULL REFERENCES content(id),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  views INTEGER,
  likes INTEGER,
  comments INTEGER,
  shares INTEGER,
  engagement_rate REAL,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_snapshots_content ON snapshots(content_id, timestamp);

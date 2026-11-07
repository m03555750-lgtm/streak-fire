PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pending_pairs (
  chat_id TEXT PRIMARY KEY,
  chat_title TEXT,
  first_user_id TEXT NOT NULL,
  first_user_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS pairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL UNIQUE,
  chat_title TEXT,
  member_a_id TEXT NOT NULL,
  member_a_name TEXT NOT NULL,
  member_b_id TEXT NOT NULL,
  member_b_name TEXT NOT NULL,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  last_completed_day TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS daily_activity (
  pair_id INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  activity_day TEXT NOT NULL,
  PRIMARY KEY (pair_id, user_id, activity_day),
  FOREIGN KEY (pair_id) REFERENCES pairs(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_daily_activity_pair_day
  ON daily_activity(pair_id, activity_day);

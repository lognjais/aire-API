CREATE TABLE IF NOT EXISTS polls (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  questions TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS votes (
  poll_id TEXT NOT NULL,
  voter_id TEXT NOT NULL,
  answers TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (poll_id, voter_id)
);

CREATE INDEX IF NOT EXISTS idx_votes_poll ON votes (poll_id);

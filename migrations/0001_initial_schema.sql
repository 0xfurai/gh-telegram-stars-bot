-- Initial D1 schema, ported from the old Supabase schema (database.sql on the
-- legacy branch).
--
-- Conventions:
-- * Timestamps are UTC ISO 8601 text, the same format as JavaScript's
--   Date.prototype.toISOString(): 2026-11-07T03:44:54.123Z.
-- * Booleans are INTEGER 0/1 with a CHECK constraint.
-- * The data layer sets updated_at in its queries. There are no triggers.
--
-- Write budget: on D1 every index adds a written row to each insert or update
-- of an indexed column, and the free plan allows 100k written rows per day.
-- Only add an index when a query needs it.

-- Telegram chats (private chats and groups).
CREATE TABLE chats (
  id INTEGER PRIMARY KEY,           -- Telegram chat ID; negative for groups
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- GitHub repositories that at least one chat subscribed to.
--
-- id is the GitHub repository ID, which stays the same when a repository is
-- renamed or transferred. Using it as the primary key avoids a second unique
-- index (and its extra write on every insert).
CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,           -- GitHub repository ID
  -- GraphQL node ID, used by the batched star check. NULL only for repos that
  -- were gone from GitHub when the data was copied from Supabase.
  github_node_id TEXT UNIQUE,
  full_name TEXT NOT NULL,          -- owner/repo, updated on rename
  description TEXT,
  html_url TEXT NOT NULL,
  stars_count INTEGER NOT NULL DEFAULT 0 CHECK (stars_count >= 0),
  is_archived INTEGER NOT NULL DEFAULT 0 CHECK (is_archived IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Subscriptions: which chat follows which repository.
--
-- last_notified_stars is the star count this chat was last told about.
-- A notification is due when repositories.stars_count is higher. It's only
-- raised after a successful send, so failed sends are retried by the next run.
-- New subscriptions start at the repository's current star count.
CREATE TABLE chat_repositories (
  chat_id INTEGER NOT NULL REFERENCES chats (id) ON DELETE CASCADE,
  repository_id INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  last_notified_stars INTEGER NOT NULL CHECK (last_notified_stars >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (chat_id, repository_id)
) WITHOUT ROWID;

-- The primary key covers lookups by chat. This index covers lookups by
-- repository and the ON DELETE CASCADE from repositories. Subscriptions change
-- rarely, so its write cost is small.
CREATE INDEX idx_chat_repositories_repository_id ON chat_repositories (repository_id);

-- Star increases found by the star check.
--
-- Decision (GSB-2): keep star events with a 90-day retention period, rather
-- than replacing them with a counter. They feed /stats and the shadow-run
-- comparison with the old app (GSB-15). The star check deletes rows older than
-- 90 days once a day (GSB-9).
--
-- No indexes: inserts happen on every star change, and the only readers
-- (/stats, the daily cleanup, the shadow-run script) scan the table anyway.
CREATE TABLE star_events (
  id INTEGER PRIMARY KEY,
  repository_id INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  stars_count INTEGER NOT NULL CHECK (stars_count >= 0),
  previous_stars_count INTEGER NOT NULL CHECK (previous_stars_count >= 0),
  stars_gained INTEGER GENERATED ALWAYS AS (stars_count - previous_stars_count) STORED,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

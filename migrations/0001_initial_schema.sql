-- Initial D1 schema, ported from the old Supabase schema (database.sql on the
-- legacy branch).
--
-- Conventions:
-- * Timestamps are UTC ISO 8601 text, the same format as JavaScript's
--   Date.prototype.toISOString(): 2026-11-07T03:44:54.123Z.
-- * Booleans are INTEGER 0/1 with a CHECK constraint.
-- * The data layer sets updated_at in its queries. There are no triggers.
--
-- Cost budget (D1 free plan): 100k rows written and 5M rows read per day.
-- Every index adds a written row to each write of its columns, and a query
-- without a usable index reads the whole table. test/schema.test.ts pins the
-- list of indexes and the cost of the writes the star check repeats.

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
-- renamed or transferred. The table has no secondary indexes: lookups go by
-- id, or by name within one chat's subscriptions.
-- The repository URL is not stored: it's https://github.com/<full_name>.
CREATE TABLE repositories (
  id INTEGER PRIMARY KEY,           -- GitHub repository ID
  -- GraphQL node ID, used by the batched star check. NULL only for repos that
  -- were gone from GitHub when the data was copied from Supabase.
  github_node_id TEXT,
  -- owner/repo as GitHub returns it, updated on rename. GitHub names are
  -- case-insensitive, so comparisons are too.
  full_name TEXT NOT NULL COLLATE NOCASE,
  description TEXT,
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

-- Stars gained per repository per UTC day, as found by the star check.
--
-- Decision (GSB-2): instead of one row per star event (the old star_events
-- table), keep one row per repository per day, kept for 90 days. A star check
-- that finds an increase adds it to today's row with an upsert (one written
-- row). With 100 active repositories that's about 9,000 rows, so /stats, the
-- daily cleanup and the shadow-run comparison (GSB-15) read little. Per-event
-- rows would grow to millions and make each of those a large scan.
--
-- Only increases are recorded, as in the old app: 100 -> 105 -> 103 -> 106
-- records 5 and then 3. The star check deletes rows older than 90 days once a
-- day (GSB-9).
CREATE TABLE daily_star_gains (
  repository_id INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  stars_gained INTEGER NOT NULL CHECK (stars_gained > 0),
  PRIMARY KEY (repository_id, day)
) WITHOUT ROWID;

-- Star check run log and alert state (GSB-14).
--
-- One row per run, kept 7 days (about 2,000 rows), so /health/star-check can
-- tell when star checks stopped or keep failing. No index: the newest rows
-- are read by rowid (ORDER BY id DESC), which needs no scan. One written row
-- per run, about 290 a day.
CREATE TABLE star_check_runs (
  id INTEGER PRIMARY KEY,
  scheduled_at TEXT NOT NULL,       -- the Cron Trigger's scheduled time, ISO UTC
  finished_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  ok INTEGER NOT NULL CHECK (ok IN (0, 1)),
  summary TEXT NOT NULL             -- the run summary as JSON
);

-- When the admin chat was last alerted about a failed run, so alerts go out
-- at most once an hour.
ALTER TABLE star_check_state ADD COLUMN last_alert_at TEXT;

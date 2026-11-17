-- Weekly, monthly and yearly star summaries (GSB-23).
--
-- daily_star_gains can't give a summary: it keeps only gains, for 90 days.
-- Instead, the star check stores each subscribed repository's star count at
-- the start of every period (Mondays and the 1st of each month, UTC), and a
-- summary is the count at the period's end minus the count at its start.
--
-- About 65 rows per repository per year, kept 400 days so the yearly summary
-- still has the start of the year. The star check writes them on the
-- boundary day itself: once per repository (later runs that day write
-- nothing), plus repositories first subscribed later that day.
CREATE TABLE star_snapshots (
  repository_id INTEGER NOT NULL REFERENCES repositories (id) ON DELETE CASCADE,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  stars_count INTEGER NOT NULL CHECK (stars_count >= 0),
  PRIMARY KEY (repository_id, day)
) WITHOUT ROWID;

-- The newest boundary day with snapshots. Summaries for a period wait until
-- its end snapshot exists, so a run that failed at midnight can't send one
-- from missing data.
ALTER TABLE star_check_state ADD COLUMN last_snapshot_day TEXT;

-- Per chat: which summaries it wants (all by default; /summaries changes
-- them), and the start day of the last period each one was sent for (or
-- skipped, when nothing changed). NULL: never sent.
ALTER TABLE chats ADD COLUMN weekly_summary INTEGER NOT NULL DEFAULT 1 CHECK (weekly_summary IN (0, 1));
ALTER TABLE chats ADD COLUMN monthly_summary INTEGER NOT NULL DEFAULT 1 CHECK (monthly_summary IN (0, 1));
ALTER TABLE chats ADD COLUMN yearly_summary INTEGER NOT NULL DEFAULT 1 CHECK (yearly_summary IN (0, 1));
ALTER TABLE chats ADD COLUMN weekly_summary_sent TEXT;
ALTER TABLE chats ADD COLUMN monthly_summary_sent TEXT;
ALTER TABLE chats ADD COLUMN yearly_summary_sent TEXT;

-- The chat's time zone (/timezone): an IANA name ("Europe/Berlin") or a
-- fixed offset ("UTC+05:30"). Summaries go out at 10:00 there. NULL: at
-- 15:00 UTC, an hour that suits both Europe and the Americas.
ALTER TABLE chats ADD COLUMN time_zone TEXT;

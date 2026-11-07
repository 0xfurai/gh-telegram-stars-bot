-- Where the next star check starts (GSB-6).
--
-- When a run can't check every repository (request budget or GitHub rate
-- limit), it records the last repository ID it checked, and the next run
-- continues after it, so every repository gets its turn. After a full pass
-- the cursor is 0. One row; writing it only when it changes costs at most one
-- written row per run.
CREATE TABLE star_check_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0)
);

INSERT INTO star_check_state (id, cursor) VALUES (1, 0);

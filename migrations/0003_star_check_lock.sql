-- A lock so two star check runs never overlap (GSB-9 review).
--
-- Overlapping runs could both read the same due notifications before either
-- marks them sent, and send them twice. A run takes the lock (one written
-- row), and a run that finds it held skips. The lock expires on its own, so a
-- run that crashed holds it for at most 10 minutes.
ALTER TABLE star_check_state ADD COLUMN locked_until TEXT;

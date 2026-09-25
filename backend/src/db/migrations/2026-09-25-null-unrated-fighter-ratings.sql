-- 2026-09-25 — clear stale ratings on fighters with no fight history.
--
-- Before computeRatings.js paged its sweep, it rated whatever arbitrary slice
-- of the table the 1000-row cap handed it, fighters with no bouts included.
-- Those rows carry ratings computed from null slpm/str_acc/td_avg: the
-- formula's floor dressed up as a measurement. resume_strength_score was the
-- 5.0 default for all of them.
--
-- computeRatings.js now skips these fighters (--all-fighters opts back in), so
-- nothing rewrites these values; this clears what earlier runs left behind.
--
-- Applied 2026-09-25: 829 rows.
--
-- Idempotent: re-running matches nothing once the columns are null.

UPDATE fighters
SET rating_striking       = NULL,
    rating_wrestling      = NULL,
    rating_grappling      = NULL,
    rating_cardio         = NULL,
    rating_overall        = NULL,
    resume_strength_score = NULL
WHERE COALESCE(stats_fight_count, 0) = 0
  AND COALESCE(wins, 0) + COALESCE(losses, 0) = 0
  AND (rating_striking       IS NOT NULL
    OR rating_wrestling      IS NOT NULL
    OR rating_grappling      IS NOT NULL
    OR rating_cardio         IS NOT NULL
    OR rating_overall        IS NOT NULL
    OR resume_strength_score IS NOT NULL);

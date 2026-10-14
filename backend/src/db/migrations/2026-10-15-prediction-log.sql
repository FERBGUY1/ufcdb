-- prediction_log: the predictor's public track record. One row per scheduled
-- bout, written BEFORE the event by src/scrapers/log-predictions.js and never
-- edited afterwards. The grading columns are filled once, after the event, by
-- the grading step of `npm run weekly`.
--
-- Immutability is enforced here, not only in the scripts (the backend uses the
-- service key, which bypasses RLS, so the triggers are the real guard):
--   * INSERT  refused when the event date has passed or any grading column is
--             set; logged_at is forced to now() (no backdating).
--   * UPDATE  may only fill grading columns that are still NULL, and only while
--             graded_at is NULL. Every prediction column is frozen.
--   * DELETE  refused.
-- First pick wins: one row per event + unordered fighter pair. A bout that is
-- cancelled or whose opponent changes keeps its row (graded 'void'); the new
-- matchup is logged as a new row. No foreign keys, so deleting or rewriting a
-- fights/events row can never alter or remove a log entry.
--
-- Paste into the Supabase SQL editor and run.

CREATE TABLE IF NOT EXISTS prediction_log (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- bout snapshot at log time (fighter1/fighter2 = the fights row orientation then)
  fight_id           UUID NOT NULL,
  event_id           UUID NOT NULL,
  event_name         TEXT NOT NULL,
  event_date         DATE NOT NULL,
  fighter1_id        UUID NOT NULL,
  fighter2_id        UUID NOT NULL,
  fighter1_name      TEXT NOT NULL,
  fighter2_name      TEXT NOT NULL,
  weight_class_id    INTEGER,
  is_title_fight     BOOLEAN NOT NULL DEFAULT false,
  scheduled_rounds   INTEGER NOT NULL CHECK (scheduled_rounds IN (3, 5)),

  -- the prediction
  model_version      TEXT NOT NULL,
  fighter1_win_pct   NUMERIC(5,2) NOT NULL CHECK (fighter1_win_pct BETWEEN 0 AND 100),
  fighter2_win_pct   NUMERIC(5,2) NOT NULL CHECK (fighter2_win_pct BETWEEN 0 AND 100),
  fighter1_ko_pct    NUMERIC(5,2),
  fighter1_sub_pct   NUMERIC(5,2),
  fighter1_dec_pct   NUMERIC(5,2),
  fighter2_ko_pct    NUMERIC(5,2),
  fighter2_sub_pct   NUMERIC(5,2),
  fighter2_dec_pct   NUMERIC(5,2),
  predicted_winner_id UUID NOT NULL,
  predicted_win_pct  NUMERIC(5,2) GENERATED ALWAYS AS (GREATEST(fighter1_win_pct, fighter2_win_pct)) STORED,
  predicted_method   TEXT NOT NULL CHECK (predicted_method IN ('KO/TKO', 'SUB', 'DEC')),
  confidence         TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  logged_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- grading (filled once, after the event)
  outcome            TEXT CHECK (outcome IN ('graded', 'void')),
  void_reason        TEXT,          -- 'draw' | 'no_contest' | 'cancelled' | 'matchup_changed'
  actual_winner_id   UUID,
  actual_result      TEXT,          -- fights.result at grading time
  actual_method      TEXT,          -- fights.method at grading time
  actual_round       INTEGER,
  actual_time        TEXT,
  correct            BOOLEAN,       -- NULL when void
  graded_at          TIMESTAMPTZ,

  CHECK (fighter1_id <> fighter2_id),
  CHECK (predicted_winner_id IN (fighter1_id, fighter2_id))
);

CREATE UNIQUE INDEX IF NOT EXISTS prediction_log_bout_key
  ON prediction_log (event_id, LEAST(fighter1_id, fighter2_id), GREATEST(fighter1_id, fighter2_id));
CREATE INDEX IF NOT EXISTS prediction_log_event_date_idx ON prediction_log (event_date);
CREATE INDEX IF NOT EXISTS prediction_log_ungraded_idx ON prediction_log (event_id) WHERE graded_at IS NULL;

-- ── guards ─────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION prediction_log_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  grade_cols CONSTANT TEXT[] := ARRAY['outcome', 'void_reason', 'actual_winner_id', 'actual_result',
                                      'actual_method', 'actual_round', 'actual_time', 'correct', 'graded_at'];
  o JSONB;
  n JSONB;
  c TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prediction_log is append-only: rows cannot be deleted';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.event_date < (now() AT TIME ZONE 'UTC')::date THEN
      RAISE EXCEPTION 'prediction_log: event % (%) has already happened', NEW.event_name, NEW.event_date;
    END IF;
    n := to_jsonb(NEW);
    FOREACH c IN ARRAY grade_cols LOOP
      IF n->>c IS NOT NULL THEN
        RAISE EXCEPTION 'prediction_log: % must be NULL on insert', c;
      END IF;
    END LOOP;
    NEW.logged_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE
  IF OLD.graded_at IS NOT NULL THEN
    RAISE EXCEPTION 'prediction_log: row % is already graded', OLD.id;
  END IF;
  o := to_jsonb(OLD);
  n := to_jsonb(NEW);
  -- predicted_win_pct is generated (not yet computed in a BEFORE trigger) and
  -- derives from frozen columns, so it is left out of the comparison.
  IF (o - grade_cols - 'predicted_win_pct') IS DISTINCT FROM (n - grade_cols - 'predicted_win_pct') THEN
    RAISE EXCEPTION 'prediction_log: prediction columns are frozen (row %)', OLD.id;
  END IF;
  FOREACH c IN ARRAY grade_cols LOOP
    IF o->>c IS NOT NULL AND (n->c) IS DISTINCT FROM (o->c) THEN
      RAISE EXCEPTION 'prediction_log: % is already set (row %)', c, OLD.id;
    END IF;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS prediction_log_guard_ins ON prediction_log;
DROP TRIGGER IF EXISTS prediction_log_guard_upd ON prediction_log;
DROP TRIGGER IF EXISTS prediction_log_guard_del ON prediction_log;
CREATE TRIGGER prediction_log_guard_ins BEFORE INSERT ON prediction_log FOR EACH ROW EXECUTE FUNCTION prediction_log_guard();
CREATE TRIGGER prediction_log_guard_upd BEFORE UPDATE ON prediction_log FOR EACH ROW EXECUTE FUNCTION prediction_log_guard();
CREATE TRIGGER prediction_log_guard_del BEFORE DELETE ON prediction_log FOR EACH ROW EXECUTE FUNCTION prediction_log_guard();

-- TRUNCATE skips row triggers, so take it away from the API roles too.
REVOKE TRUNCATE ON prediction_log FROM anon, authenticated, service_role;

-- No direct client access; the backend (service key) serves /api/track-record.
ALTER TABLE prediction_log ENABLE ROW LEVEL SECURITY;

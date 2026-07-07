-- Computed career-stat columns filled by src/ml/computeCareerStats.js
-- (knockdown rates, control %, style mix, coverage counters, recent form).
-- Run in the Supabase SQL editor before `computeCareerStats.js --apply`.

ALTER TABLE fighters ADD COLUMN IF NOT EXISTS kd_per15            NUMERIC(5,2);
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS kd_absorbed_per15   NUMERIC(5,2);
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS ctrl_pct            NUMERIC(5,2);
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS sig_distance_pct    NUMERIC(5,2);
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS sig_clinch_pct      NUMERIC(5,2);
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS sig_ground_pct      NUMERIC(5,2);
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS stats_fight_count   INTEGER;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS stats_total_seconds INTEGER;
ALTER TABLE fighters ADD COLUMN IF NOT EXISTS recent_form         JSONB;

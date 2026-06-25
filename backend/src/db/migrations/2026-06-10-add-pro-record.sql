-- Adds full professional MMA record columns (sourced from Sherdog).
-- NULL means "not yet scraped" — sherdog-pro-records.js uses this to resume.
-- Paste into the Supabase SQL editor and run.

ALTER TABLE fighters
  ADD COLUMN IF NOT EXISTS pro_wins   INTEGER,
  ADD COLUMN IF NOT EXISTS pro_losses INTEGER,
  ADD COLUMN IF NOT EXISTS pro_draws  INTEGER,
  ADD COLUMN IF NOT EXISTS pro_nc     INTEGER;

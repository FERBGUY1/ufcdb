-- fight_predictions: cache 3- and 5-round predictions separately.
-- Run in the Supabase SQL editor. The default name of the old UNIQUE
-- constraint is the Postgres-generated one; adjust if it was renamed.
ALTER TABLE fight_predictions
  ADD COLUMN IF NOT EXISTS scheduled_rounds INTEGER NOT NULL DEFAULT 3;

ALTER TABLE fight_predictions
  DROP CONSTRAINT IF EXISTS fight_predictions_fighter1_id_fighter2_id_weight_class_id_key;

ALTER TABLE fight_predictions
  ADD CONSTRAINT fight_predictions_pair_wc_rounds_key
  UNIQUE (fighter1_id, fighter2_id, weight_class_id, scheduled_rounds);

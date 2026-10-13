-- Full professional (and amateur) MMA fight history per fighter, parsed from
-- the Sherdog profile page (src/scrapers/sherdog-history.js). One row per
-- Sherdog history row. INTERNAL TRAINING DATA ONLY: read by the predictor's
-- training path (trainModel.loadSherdogHistory); never served by a route or
-- shown on the site.
-- Paste into the Supabase SQL editor and run, then seed with:
--   node -r dotenv/config src/scrapers/sherdog-history.js

CREATE TABLE IF NOT EXISTS sherdog_fights (
  fighter_id           UUID NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  sherdog_id           TEXT NOT NULL,          -- the fighter's own Sherdog profile slug
  seq                  INTEGER NOT NULL,       -- row order on the page, 0 = most recent
  date                 DATE,                   -- NULL when Sherdog shows N/A
  result               TEXT NOT NULL,          -- 'win' | 'loss' | 'draw' | 'nc' | 'unknown'
  opponent_name        TEXT,
  opponent_sherdog_id  TEXT,                   -- slug from the opponent link; joins to fighters.sherdog_id
  event_name           TEXT,
  event_sherdog_id     TEXT,
  method               TEXT,                   -- 'KO/TKO' | 'SUB' | 'DEC' | 'DQ' | 'NC' | 'Draw' | 'Other'
  method_raw           TEXT,                   -- Sherdog's text, e.g. "TKO (Punches)"
  round                INTEGER,
  time                 TEXT,
  is_amateur           BOOLEAN NOT NULL DEFAULT false,
  source               TEXT NOT NULL DEFAULT 'sherdog',
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fighter_id, is_amateur, seq)
);

CREATE INDEX IF NOT EXISTS sherdog_fights_opponent_idx ON sherdog_fights (opponent_sherdog_id);
CREATE INDEX IF NOT EXISTS sherdog_fights_date_idx ON sherdog_fights (fighter_id, date);

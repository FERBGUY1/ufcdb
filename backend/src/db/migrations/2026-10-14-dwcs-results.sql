-- Dana White's Contender Series appearances parsed from the Wikipedia season
-- pages (src/scrapers/wiki-dwcs.js). One row per DWCS bout of a fighter who is
-- in the fighters table. Read by the predictor's training path (trainModel.loadDwcs).
-- Paste into the Supabase SQL editor and run, then seed with:
--   node -r dotenv/config src/scrapers/wiki-dwcs.js

CREATE TABLE IF NOT EXISTS dwcs_results (
  fighter_id   UUID NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  dwcs_date    DATE NOT NULL,
  season       INTEGER NOT NULL,
  episode      TEXT,
  opponent     TEXT,
  weight_class TEXT,
  result       TEXT NOT NULL,           -- 'win' (this fighter lost or won, see won) | 'draw' | 'no_contest' | 'unknown'
  won          BOOLEAN NOT NULL,
  finish       BOOLEAN NOT NULL,        -- won by KO/TKO/submission
  method       TEXT,
  contract     BOOLEAN NOT NULL,        -- named in the episode's "Contract awards" list
  source       TEXT NOT NULL DEFAULT 'wikipedia',
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (fighter_id, dwcs_date)
);

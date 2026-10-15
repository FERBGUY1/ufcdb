-- Precomputed Glicko-2 rating per fighter (src/ml/computeGlickoRatings.js), the
-- serving-side source of the predictor's glicko_scaled feature (model-v7).
-- The rating is replayed over UFC fights plus the non-UFC Sherdog bouts of every
-- fighter with a page (glickoEngine.js, seed 'unified'); the Sherdog rows
-- themselves stay internal. These numbers are read by predictionEngine.js only
-- and are never displayed on the site.
-- Refreshed by `npm run weekly` after sherdog-history.js. Paste into the
-- Supabase SQL editor and run, then seed with:
--   node -r dotenv/config src/ml/computeGlickoRatings.js

CREATE TABLE IF NOT EXISTS glicko_ratings (
  fighter_id      UUID PRIMARY KEY REFERENCES fighters(id) ON DELETE CASCADE,
  rating          DOUBLE PRECISION NOT NULL,   -- Glicko-2 rating after the last rated bout (1500 = unknown)
  rd              DOUBLE PRECISION NOT NULL,   -- rating deviation after the last rated bout (inflated to "today" at serving)
  volatility      DOUBLE PRECISION NOT NULL,
  fights          INTEGER NOT NULL DEFAULT 0,  -- rated bouts replayed (UFC + regional)
  ufc_fights      INTEGER NOT NULL DEFAULT 0,
  last_fight_date DATE,                        -- date of the last rated bout (NULL = no bouts; rating is the seed)
  config          JSONB NOT NULL,              -- glickoEngine config the replay used (tau, initialRd, finishMult, seed, ...)
  computed_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

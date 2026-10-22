-- Fantasy (prime-vs-prime) predictor: per-fighter Glicko-2 rating HISTORY and
-- peak, so predictionEngine.js can serve a rating "as of" any past date and
-- find the date of a fighter's highest rating without replaying the Sherdog
-- bouts at request time. Written by src/ml/computeGlickoRatings.js (weekly).
-- Still internal: these numbers are read by the predictor only.
--
-- history: array of post-bout states in date order, one per rated bout
--   { d: 'YYYY-MM-DD', r: rating, rd: deviation, s: volatility, n: bouts so far, u: UFC bouts so far, ufc: true|false }
-- peak_rating / peak_date: highest post-bout rating over the fighter's UFC
--   bouts and the date of that bout (NULL when there is none).
--
-- Paste into the Supabase SQL editor and run, then refresh with:
--   node -r dotenv/config src/ml/computeGlickoRatings.js

ALTER TABLE glicko_ratings ADD COLUMN IF NOT EXISTS history     JSONB;
ALTER TABLE glicko_ratings ADD COLUMN IF NOT EXISTS peak_rating DOUBLE PRECISION;
ALTER TABLE glicko_ratings ADD COLUMN IF NOT EXISTS peak_date   DATE;

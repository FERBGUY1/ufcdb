-- Late-replacement bouts parsed from Wikipedia event-page Background prose
-- (src/scrapers/wiki-short-notice.js). One row per fight that had a replacement.
-- Read by the predictor's training path only (trainModel.js / evaluate.js);
-- serving leaves the features null so hypotheticals assume a full camp.
-- Paste into the Supabase SQL editor and run, then seed with:
--   node -r dotenv/config src/scrapers/wiki-short-notice.js --reparse

CREATE TABLE IF NOT EXISTS fight_replacements (
  fight_id    UUID PRIMARY KEY REFERENCES fights(id) ON DELETE CASCADE,
  fighter_id  UUID NOT NULL REFERENCES fighters(id) ON DELETE CASCADE,
  days        INTEGER,                 -- days of notice when the page states it; NULL = "replaced by" only
  cue         TEXT NOT NULL,           -- 'date' | 'relative' | 'event-day' | 'short-notice' | 'replaced'
  sentence    TEXT,                    -- the Wikipedia sentence the record came from
  source      TEXT NOT NULL DEFAULT 'wikipedia',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS fight_replacements_fighter_idx ON fight_replacements (fighter_id);

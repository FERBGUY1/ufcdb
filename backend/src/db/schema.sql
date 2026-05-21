-- ═══════════════════════════════════════════════════════════
-- UFCDB v2 — Complete Database Schema
-- Paste this into your Supabase SQL editor and run it
-- ═══════════════════════════════════════════════════════════

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ── WEIGHT CLASSES ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS weight_classes (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  gender      TEXT NOT NULL DEFAULT 'male',
  limit_lbs   INTEGER,
  sort_order  INTEGER DEFAULT 0
);

-- ── PROMOTIONS ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS promotions (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  slug        TEXT NOT NULL UNIQUE,
  country     TEXT,
  active      BOOLEAN DEFAULT TRUE,
  founded     INTEGER,
  notes       TEXT
);

-- ── GYMS ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS gyms (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        TEXT NOT NULL,
  slug        TEXT NOT NULL UNIQUE,
  city        TEXT,
  state       TEXT,
  country     TEXT,
  head_coach  TEXT,
  website     TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── FIGHTERS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fighters (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  ufc_id                TEXT UNIQUE,
  sherdog_id            TEXT UNIQUE,
  tapology_id           TEXT UNIQUE,

  -- Identity
  first_name            TEXT NOT NULL,
  last_name             TEXT NOT NULL,
  nickname              TEXT,
  slug                  TEXT NOT NULL UNIQUE,

  -- Weight
  primary_weight_class_id INTEGER REFERENCES weight_classes(id),
  weight_classes_competed TEXT[],

  -- Status
  status                TEXT NOT NULL DEFAULT 'active',
  is_champion           BOOLEAN DEFAULT FALSE,
  is_interim_champ      BOOLEAN DEFAULT FALSE,
  rank                  INTEGER,

  -- Physical
  height_inches         NUMERIC(4,1),
  reach_inches          NUMERIC(4,1),
  leg_reach_inches      NUMERIC(4,1),
  stance                TEXT,
  weight_lbs            NUMERIC(5,1),

  -- UFC Record
  wins                  INTEGER DEFAULT 0,
  losses                INTEGER DEFAULT 0,
  draws                 INTEGER DEFAULT 0,
  no_contests           INTEGER DEFAULT 0,
  wins_ko               INTEGER DEFAULT 0,
  wins_sub              INTEGER DEFAULT 0,
  wins_dec              INTEGER DEFAULT 0,
  losses_ko             INTEGER DEFAULT 0,
  losses_sub            INTEGER DEFAULT 0,
  losses_dec            INTEGER DEFAULT 0,

  -- Full Career Record (all promotions)
  career_wins           INTEGER DEFAULT 0,
  career_losses         INTEGER DEFAULT 0,
  career_draws          INTEGER DEFAULT 0,
  career_no_contests    INTEGER DEFAULT 0,

  -- Amateur Record
  amateur_wins          INTEGER DEFAULT 0,
  amateur_losses        INTEGER DEFAULT 0,
  amateur_draws         INTEGER DEFAULT 0,

  -- Boxing record (if applicable)
  boxing_wins           INTEGER DEFAULT 0,
  boxing_losses         INTEGER DEFAULT 0,
  boxing_draws          INTEGER DEFAULT 0,

  -- UFC Stats
  slpm                  NUMERIC(5,2),
  sapm                  NUMERIC(5,2),
  str_acc               NUMERIC(5,2),
  str_def               NUMERIC(5,2),
  td_avg                NUMERIC(5,2),
  td_acc                NUMERIC(5,2),
  td_def                NUMERIC(5,2),
  sub_avg               NUMERIC(5,2),

  -- Fighting Style (primary and secondary)
  primary_style         TEXT,
  secondary_style       TEXT,
  style_notes           TEXT,

  -- Contextual Performance Ratings (1-10, computed)
  rating_striking       NUMERIC(4,2),
  rating_grappling      NUMERIC(4,2),
  rating_wrestling      NUMERIC(4,2),
  rating_bjj            NUMERIC(4,2),
  rating_chin           NUMERIC(4,2),
  rating_cardio         NUMERIC(4,2),
  rating_ground_defense NUMERIC(4,2),
  rating_str_defense    NUMERIC(4,2),
  rating_td_offense     NUMERIC(4,2),
  rating_td_defense     NUMERIC(4,2),
  rating_overall        NUMERIC(4,2),

  -- Cardio Metrics (computed from fight data)
  cardio_output_r1      NUMERIC(5,2),
  cardio_output_r2      NUMERIC(5,2),
  cardio_output_r3      NUMERIC(5,2),
  cardio_output_r4      NUMERIC(5,2),
  cardio_output_r5      NUMERIC(5,2),
  cardio_degradation    NUMERIC(5,2),  -- % drop R1 to R3
  late_finish_rate      NUMERIC(5,2),  -- % of wins in R3+
  late_loss_rate        NUMERIC(5,2),  -- % of losses in R3+
  championship_round_record TEXT,       -- e.g. "8-2"

  -- Career Arc
  career_arc            TEXT,  -- rising | contender | prime | declining | gatekeeper | journeyman | retired
  career_arc_updated_at TIMESTAMPTZ,
  prime_start           INTEGER,  -- year
  prime_end             INTEGER,  -- year

  -- Resume / Opponent Quality
  resume_strength_score NUMERIC(5,2),  -- computed
  avg_opponent_quality  NUMERIC(5,2),  -- computed

  -- Personal
  date_of_birth         DATE,
  nationality           TEXT,
  hometown              TEXT,
  current_city          TEXT,
  ethnicity             TEXT,
  religion              TEXT,
  languages             TEXT[],

  -- Personal Life (manually curated)
  relationship_status   TEXT,
  partner_name          TEXT,
  children_count        INTEGER,
  children_notes        TEXT,
  military_service      TEXT,
  education             TEXT,

  -- Training
  gym_id                UUID REFERENCES gyms(id),
  gym_name              TEXT,
  head_coach            TEXT,
  notable_coaches       TEXT[],
  training_partners     TEXT[],

  -- Career
  pro_debut_date        DATE,
  ufc_debut_date        DATE,
  ufc_debut_event       TEXT,
  management            TEXT,
  fighting_style        TEXT,

  -- Scouting
  strengths             TEXT[],
  weaknesses            TEXT[],
  scout_notes           TEXT,

  -- Media
  photo_url             TEXT,
  instagram             TEXT,
  twitter               TEXT,
  youtube               TEXT,
  tiktok                TEXT,
  official_website      TEXT,

  -- Meta
  last_synced_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fighters_name_trgm ON fighters
  USING GIN ((first_name || ' ' || last_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS fighters_slug_idx ON fighters(slug);
CREATE INDEX IF NOT EXISTS fighters_status_idx ON fighters(status);
CREATE INDEX IF NOT EXISTS fighters_weight_class_idx ON fighters(primary_weight_class_id);
CREATE INDEX IF NOT EXISTS fighters_style_idx ON fighters(primary_style);
CREATE INDEX IF NOT EXISTS fighters_resume_idx ON fighters(resume_strength_score DESC);

-- ── EVENTS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS events (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  promotion_id    INTEGER REFERENCES promotions(id),
  ufc_id          TEXT UNIQUE,
  name            TEXT NOT NULL,
  slug            TEXT NOT NULL UNIQUE,
  event_number    INTEGER,
  event_type      TEXT DEFAULT 'numbered',
  date            DATE NOT NULL,
  venue           TEXT,
  city            TEXT,
  state           TEXT,
  country         TEXT,
  attendance      INTEGER,
  ppv_buys        INTEGER,
  is_complete     BOOLEAN DEFAULT FALSE,
  main_event      TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS events_date_idx ON events(date DESC);
CREATE INDEX IF NOT EXISTS events_promotion_idx ON events(promotion_id);

-- ── FIGHTS ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS fights (
  id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  event_id              UUID REFERENCES events(id) ON DELETE CASCADE,
  promotion_id          INTEGER REFERENCES promotions(id),

  fighter1_id           UUID REFERENCES fighters(id),
  fighter2_id           UUID REFERENCES fighters(id),
  winner_id             UUID REFERENCES fighters(id),

  card_position         TEXT,
  bout_order            INTEGER,
  weight_class_id       INTEGER REFERENCES weight_classes(id),
  is_title_fight        BOOLEAN DEFAULT FALSE,
  is_interim_title      BOOLEAN DEFAULT FALSE,
  catch_weight_lbs      NUMERIC(5,1),

  result                TEXT,
  method                TEXT,
  method_detail         TEXT,
  round                 INTEGER,
  time                  TEXT,
  time_format           TEXT,

  -- Scorecards
  judge1_score          TEXT,
  judge2_score          TEXT,
  judge3_score          TEXT,

  -- Strike stats
  fighter1_sig_str      TEXT,
  fighter2_sig_str      TEXT,
  fighter1_sig_str_pct  TEXT,
  fighter2_sig_str_pct  TEXT,
  fighter1_total_str    TEXT,
  fighter2_total_str    TEXT,
  fighter1_td           TEXT,
  fighter2_td           TEXT,
  fighter1_td_pct       TEXT,
  fighter2_td_pct       TEXT,
  fighter1_sub_att      INTEGER,
  fighter2_sub_att      INTEGER,
  fighter1_pass         INTEGER,
  fighter2_pass         INTEGER,
  fighter1_rev          INTEGER,
  fighter2_rev          INTEGER,
  fighter1_kd           INTEGER,
  fighter2_kd           INTEGER,

  -- Round by round data (JSONB)
  rounds_data           JSONB,

  -- Records at time of fight
  fighter1_record_at_fight TEXT,
  fighter2_record_at_fight TEXT,

  -- Opponent quality scores (computed at time of fight)
  fighter1_quality_score NUMERIC(5,2),
  fighter2_quality_score NUMERIC(5,2),

  -- Style at time of fight
  fighter1_style_at_fight TEXT,
  fighter2_style_at_fight TEXT,

  -- Career arc at time of fight
  fighter1_arc_at_fight TEXT,
  fighter2_arc_at_fight TEXT,

  created_at            TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS fights_fighter1_idx ON fights(fighter1_id);
CREATE INDEX IF NOT EXISTS fights_fighter2_idx ON fights(fighter2_id);
CREATE INDEX IF NOT EXISTS fights_event_idx ON fights(event_id);
CREATE INDEX IF NOT EXISTS fights_upcoming_idx ON fights(result) WHERE result = 'upcoming';
CREATE INDEX IF NOT EXISTS fights_style_matchup_idx ON fights(fighter1_style_at_fight, fighter2_style_at_fight);

-- ── STYLE MATCHUP STATS (precomputed) ────────────────────
CREATE TABLE IF NOT EXISTS style_matchups (
  id              SERIAL PRIMARY KEY,
  style1          TEXT NOT NULL,
  style2          TEXT NOT NULL,
  weight_class_id INTEGER REFERENCES weight_classes(id),
  total_fights    INTEGER DEFAULT 0,
  style1_wins     INTEGER DEFAULT 0,
  style2_wins     INTEGER DEFAULT 0,
  draws           INTEGER DEFAULT 0,
  style1_win_pct  NUMERIC(5,2),
  style2_win_pct  NUMERIC(5,2),
  ko_pct          NUMERIC(5,2),
  sub_pct         NUMERIC(5,2),
  dec_pct         NUMERIC(5,2),
  avg_fight_time  NUMERIC(5,2),  -- in seconds
  notable_fights  JSONB,          -- array of {fighter1, fighter2, result, event}
  last_computed   TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(style1, style2, weight_class_id)
);

-- ── OPPONENT QUALITY HISTORY ──────────────────────────────
CREATE TABLE IF NOT EXISTS opponent_quality_scores (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fighter_id      UUID REFERENCES fighters(id),
  scored_date     DATE NOT NULL,
  quality_score   NUMERIC(5,2) NOT NULL,  -- 1-10
  career_arc      TEXT NOT NULL,
  rank_at_time    INTEGER,
  record_at_time  TEXT,
  win_streak      INTEGER DEFAULT 0,
  loss_streak     INTEGER DEFAULT 0,
  notes           TEXT,
  UNIQUE(fighter_id, scored_date)
);

-- ── BETTING ODDS ─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS odds (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fight_id        UUID REFERENCES fights(id) ON DELETE CASCADE,
  bookmaker       TEXT NOT NULL,
  bet_type        TEXT DEFAULT 'moneyline',
  fighter1_odds   INTEGER,
  fighter2_odds   INTEGER,
  line_type       TEXT DEFAULT 'current',
  recorded_at     TIMESTAMPTZ DEFAULT NOW(),
  fighter1_open   INTEGER,
  fighter2_open   INTEGER,
  is_historical   BOOLEAN DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS odds_fight_idx ON odds(fight_id);

-- ── AI PREDICTION CACHE ───────────────────────────────────
CREATE TABLE IF NOT EXISTS fight_predictions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fighter1_id     UUID REFERENCES fighters(id),
  fighter2_id     UUID REFERENCES fighters(id),
  weight_class_id INTEGER REFERENCES weight_classes(id),

  -- Win probabilities
  fighter1_win_pct  NUMERIC(5,2),
  fighter2_win_pct  NUMERIC(5,2),
  draw_pct          NUMERIC(5,2),

  -- Method breakdown
  fighter1_ko_pct   NUMERIC(5,2),
  fighter1_sub_pct  NUMERIC(5,2),
  fighter1_dec_pct  NUMERIC(5,2),
  fighter2_ko_pct   NUMERIC(5,2),
  fighter2_sub_pct  NUMERIC(5,2),
  fighter2_dec_pct  NUMERIC(5,2),

  -- Round projections (JSONB)
  round_projections JSONB,

  -- AI narrative
  ai_breakdown      TEXT,
  key_factors       TEXT[],
  confidence        TEXT,  -- high | medium | low

  -- Cache control
  generated_at      TIMESTAMPTZ DEFAULT NOW(),
  expires_at        TIMESTAMPTZ,
  model_version     TEXT DEFAULT 'v2',

  UNIQUE(fighter1_id, fighter2_id, weight_class_id)
);

-- ── RANKINGS ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rankings (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fighter_id      UUID REFERENCES fighters(id),
  weight_class_id INTEGER REFERENCES weight_classes(id),
  rank            INTEGER,
  is_interim      BOOLEAN DEFAULT FALSE,
  recorded_date   DATE DEFAULT CURRENT_DATE,
  UNIQUE(fighter_id, weight_class_id, recorded_date)
);

-- ── DATA FLAGS (community corrections) ───────────────────
CREATE TABLE IF NOT EXISTS data_flags (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  entity_type TEXT NOT NULL,
  entity_id   UUID NOT NULL,
  field       TEXT,
  note        TEXT,
  status      TEXT DEFAULT 'open',
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- ── UPDATED_AT TRIGGER ────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER fighters_updated_at
  BEFORE UPDATE ON fighters
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── ROW LEVEL SECURITY ────────────────────────────────────
ALTER TABLE fighters ENABLE ROW LEVEL SECURITY;
ALTER TABLE fights ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE odds ENABLE ROW LEVEL SECURITY;
ALTER TABLE style_matchups ENABLE ROW LEVEL SECURITY;
ALTER TABLE fight_predictions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "public read fighters"         ON fighters         FOR SELECT USING (true);
CREATE POLICY "public read fights"           ON fights           FOR SELECT USING (true);
CREATE POLICY "public read events"           ON events           FOR SELECT USING (true);
CREATE POLICY "public read odds"             ON odds             FOR SELECT USING (true);
CREATE POLICY "public read style_matchups"   ON style_matchups   FOR SELECT USING (true);
CREATE POLICY "public read predictions"      ON fight_predictions FOR SELECT USING (true);

/**
 * features.js — the feature vector shared by trainModel.js, evaluate.js and
 * predictionEngine.js
 *
 * One definition so training and serving can never drift. Every feature is a
 * DIFFERENTIAL (fighter A minus fighter B) over stats computed by statsEngine
 * snapshots — at training time with a cutoff date (only fights before the
 * fight being predicted), at serving time over the full career.
 * Missing values on either side make the differential 0 (neutral).
 *
 * MODEL CONFIG: the robustness knobs (shrinkage, recency decay, layoff cap,
 * z-clipping) live in one object that the trainer stores in the model file
 * and the engine reads back, so serving always matches training. All default
 * OFF = the Phase-0 model.
 */

const { snapshot } = require('./statsEngine');

const FEATURES = [
  'slpm',               // sig strikes landed / min
  'sapm',               // sig strikes absorbed / min
  'str_acc',            // striking accuracy %
  'str_def',            // striking defense %
  'td_avg',             // takedowns landed / 15 min
  'td_acc',             // takedown accuracy %
  'td_def',             // takedown defense %
  'sub_avg',            // submission attempts / 15 min
  'kd_per15',           // knockdowns scored / 15 min
  'kd_absorbed_per15',  // knockdowns absorbed / 15 min
  'cardio_degradation', // output drop R1->R3 % (negative = increases)
  'experience',         // completed UFC fights
  'win_rate',           // career UFC win % (of decided fights; shrunk toward 50% when winShrinkFights > 0)
  'recent_win_rate',    // win % over last 3 stats-fights
  'form_trend',         // recent SLpM minus career SLpM (rising/fading output)
  'age',                // age in years at fight time
  'reach',              // reach in inches
  'height',             // height in inches
  'layoff_days',        // days since last fight (capped at layoffCapDays when set)
  'stats_minutes',      // cage minutes with round stats (how much the rate stats rest on)
  'pro_win_rate',       // pro MMA win % as of the fight (current pro record minus UFC results on/after the date)
  'pro_fights',         // pro MMA fights as of the fight (same derivation)
  // ── Phase 2: opponent strength (eloEngine.js + annotateOpponentPriors) ──
  'elo',                // UFC Elo rating before the fight
  'sos',                // strength of schedule: mean opponent Elo at the time of each fight
  'elo_best_win',       // highest Elo (at the time) of an opponent beaten
  'elo_trend',          // Elo change over the last 3 fights (momentum)
  'opp_adj_slpm',       // SLpM minus what the opponents faced typically absorb
  'opp_adj_sapm',       // SApM minus what the opponents faced typically land
  'opp_adj_td_avg',     // TD/15 rescaled to a league-average takedown defense
];

const DEFAULT_CONFIG = {
  shrinkMinutes: 0,     // pseudo-minutes of league prior mixed into rate stats (statsEngine.snapshot)
  halfLifeDays: 0,      // recency decay half-life for stats-fight sums (0 = off)
  layoffCapDays: 0,     // cap on layoff_days (0 = uncapped)
  winShrinkFights: 0,   // pseudo-fights at 50% mixed into win_rate / pro_win_rate (0 = raw)
  clipZ: 0,             // clip standardized features at ±clipZ (0 = no clipping)
  eloK: 40,             // Elo step (eloEngine.computeElo)
  eloFinishMult: 1,     // K multiplier for KO/SUB wins (1 = off)
};

/**
 * Per-fighter feature values.
 *   snap        full snapshot (statsEngine.snapshot with optional cutoff)
 *   snapRecent  last-3 snapshot (same cutoff)
 *   fighter     fighters row with date_of_birth, reach_inches, height_inches,
 *               pro_wins, pro_losses
 *   asOfDate    ISO date the features are computed for
 *   cfg         DEFAULT_CONFIG-shaped options
 *   ufcAfter    { wins, losses } the fighter recorded in the UFC on or after
 *               asOfDate — subtracted from the CURRENT pro record to approximate
 *               the pro record as it stood at the time. Fights outside the UFC
 *               after that date are not known and are not removed (small
 *               overcount for fighters who left and kept fighting).
 */
function sideValues(snap, snapRecent, fighter, asOfDate, cfg = DEFAULT_CONFIG, ufcAfter = { wins: 0, losses: 0 }, elo = null) {
  const asOf = new Date(asOfDate);
  const kw = cfg.winShrinkFights || 0;
  const shrinkRate = (w, n) => (n + kw > 0 ? ((w + kw * 0.5) / (n + kw)) * 100 : null);
  const decided = snap.record.wins + snap.record.losses;
  const layoff = snap.last_fight_date ? (asOf - new Date(snap.last_fight_date)) / 86400000 : null;
  let proW = null, proL = null;
  if (fighter?.pro_wins != null && fighter?.pro_losses != null) {
    proW = Math.max(0, fighter.pro_wins - (ufcAfter.wins || 0));
    proL = Math.max(0, fighter.pro_losses - (ufcAfter.losses || 0));
  }
  return {
    slpm: snap.slpm, sapm: snap.sapm, str_acc: snap.str_acc, str_def: snap.str_def,
    td_avg: snap.td_avg, td_acc: snap.td_acc, td_def: snap.td_def, sub_avg: snap.sub_avg,
    kd_per15: snap.kd_per15, kd_absorbed_per15: snap.kd_absorbed_per15,
    cardio_degradation: snap.cardio_degradation,
    experience: snap.total_fights,
    win_rate: shrinkRate(snap.record.wins, decided),
    recent_win_rate: snapRecent.stats_win_rate,
    form_trend: snapRecent.slpm != null && snap.slpm != null ? snapRecent.slpm - snap.slpm : null,
    age: fighter?.date_of_birth ? (asOf - new Date(fighter.date_of_birth)) / (365.25 * 86400000) : null,
    reach: fighter?.reach_inches ?? null,
    height: fighter?.height_inches ?? null,
    layoff_days: layoff == null ? null : (cfg.layoffCapDays > 0 ? Math.min(layoff, cfg.layoffCapDays) : layoff),
    stats_minutes: snap.stats_seconds / 60,
    pro_win_rate: proW == null ? null : shrinkRate(proW, proW + proL),
    pro_fights: proW == null ? null : proW + proL,
    elo: elo ? elo.elo : null,
    sos: elo ? elo.sos : null,
    elo_best_win: elo ? elo.elo_best_win : null,
    elo_trend: elo ? elo.elo_trend : null,
    opp_adj_slpm: snap.slpm_adj ?? null,
    opp_adj_sapm: snap.sapm_adj ?? null,
    opp_adj_td_avg: snap.td_avg_adj ?? null,
  };
}

// UFC wins/losses a fighter recorded on or after `date` (the fight itself included).
function ufcResultsOnOrAfter(timeline, date) {
  let wins = 0, losses = 0;
  for (const e of timeline) if (e.date >= date) { if (e.result === 'win') wins++; else if (e.result === 'loss') losses++; }
  return { wins, losses };
}

/**
 * One side's feature values for a matchup as of `asOf`.
 *   cutoff   training: the fight date (only earlier fights count);
 *            serving: null = full career
 *   cfg      DEFAULT_CONFIG-shaped; priors from statsEngine.computePriors
 *            (required when cfg.shrinkMinutes > 0)
 *   elo      eloEngine.computeElo() result (null = Elo features neutral)
 */
function sideFeatures(timeline, fighter, asOf, cutoff, cfg = DEFAULT_CONFIG, priors = null, elo = null) {
  const snapOpts = { asOf, halfLifeDays: cfg.halfLifeDays, shrinkMinutes: cfg.shrinkMinutes, priors };
  const snap = snapshot(timeline, cutoff, null, snapOpts);
  const recent = snapshot(timeline, cutoff, 3, snapOpts);
  const eloSummary = elo && fighter ? elo.summaryAsOf(fighter.id, cutoff) : null;
  return sideValues(snap, recent, fighter, asOf, cfg, ufcResultsOnOrAfter(timeline, asOf), eloSummary);
}

// A-minus-B differentials in FEATURES order; null on either side -> 0
function diffVector(a, b) {
  return FEATURES.map(k => (a[k] != null && b[k] != null ? a[k] - b[k] : 0));
}

// Standardize a raw diff vector with train-set mu/sigma, clipping at ±clipZ
// when set. Used by the trainer, the harness and the engine alike.
function standardize(x, mu, sigma, clipZ = 0) {
  return x.map((v, j) => {
    const z = (v - mu[j]) / sigma[j];
    return clipZ > 0 ? Math.max(-clipZ, Math.min(clipZ, z)) : z;
  });
}

module.exports = { FEATURES, DEFAULT_CONFIG, sideValues, sideFeatures, ufcResultsOnOrAfter, diffVector, standardize };

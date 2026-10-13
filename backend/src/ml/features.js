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
const { styleProfile } = require('./styleEngine');

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
  // ── Phase 3: career phase ──
  'age_sq',             // (age - 30)^2: lets the age effect bend instead of staying linear
  'years_active',       // years since first UFC fight
  'ko_losses_career',   // KO/TKO losses, career
  'ko_losses_24m',      // KO/TKO losses in the 24 months before the fight
  'fights_12m',         // UFC fights in the 12 months before the fight (activity)
  // ── Phase 3: fight context (bout.scheduledRounds) ──
  'five_round_fights',  // prior fights scheduled for 5 rounds
  'five_round_fights_sched', // same, but only when THIS bout is 5 rounds (interaction; 0 otherwise)
  'late_round_cardio',  // mean R4-R5 output / mean R1-R3 output - 1 (null without R4+ data)
  // ── Phase 3: size (bout.limitLbs) ──
  'natural_limit',      // weight limit of the fighter's modal division before the fight (lbs)
  'moving_up_lbs',      // bout limit minus natural limit (positive = fighting above natural division)
  'off_division_fights',// prior fights outside the modal division
  // ── age × rating interaction ──
  'age_elo',            // (age - 30) * (elo - 1500) / 100: lets the age penalty flatten for highly rated fighters
  // ── Phase 4: style (styleEngine.js) ──
  'style_distance',     // share of sig attempts at distance (%)
  'style_clinch',       // share in the clinch (%)
  'style_ground',       // share on the ground (%)
  'style_ctrl',         // control time % of cage time
  'style_pair_edge',    // historical win rate of own style label vs opponent's, before the fight, minus 50% (antisymmetric)
  'pair_td_threat',     // PAIRWISE: own TD/15 x (100 - opp TD defense) — computed in diffVector from both sides
  'pair_strike_threat', // PAIRWISE: own SLpM x (100 - opp striking defense)
  // ── Late replacements (scrapers/wiki-short-notice.js -> data/short-notice.json). Training-only context:
  //    serving leaves both null (= a full camp for every hypothetical). Shipped in v5 (2026-10-13). ──
  'replacement',        // 1 = stepped in as a late replacement (Wikipedia Background prose), 0 = original booking
  'notice_days',        // days of notice, capped at 60 (60 = a full camp; replacement with unknown timing = 21)
  // ── Contender Series (scrapers/wiki-dwcs.js -> dwcs_results). Set by the trainer from the fighter's
  //    latest DWCS appearance before the bout; non-alumni are 0 on all four. Null at serving = neutral. ──
  'dwcs',               // 1 = fought on Dana White's Contender Series before this bout
  'dwcs_won',           // 1 = won that DWCS bout
  'dwcs_finish',        // 1 = won it by KO/TKO/submission
  'dwcs_days_to_debut', // days from the DWCS bout to the UFC debut, capped at 730 (0 for non-alumni)
  // ── Sherdog fight history (scrapers/sherdog-history.js -> sherdog_fights). Training-only; never served.
  //    With cfg.proRecordSource = 'sherdog', pro_win_rate / pro_fights come from the exact pro record as of
  //    the fight date instead of today's pro_wins/pro_losses minus later UFC results. ──
  'regional_finish_rate',   // KO/TKO+SUB share of non-UFC pro wins before the bout (shrunk toward 50%)
  'regional_opp_quality',   // mean pre-fight win rate of non-UFC opponents whose own history is known (else 50)
  'regional_opp_ufc_share', // share of non-UFC opponents who had already fought in the UFC at the time
  'pro_record_quality',     // (pro_win_rate - 50) x min(pro_fights, 30) / 100: a 20-2 outranks a 5-0
];

// Pairwise features are built from BOTH sides in diffVector (antisymmetric
// by construction, so the mirror property holds).
const PAIR_FEATURES = {
  pair_td_threat: (a, b) => (a.td_avg != null && b.td_def != null && b.td_avg != null && a.td_def != null
    ? a.td_avg * (100 - b.td_def) / 100 - b.td_avg * (100 - a.td_def) / 100 : 0),
  pair_strike_threat: (a, b) => (a.slpm != null && b.str_def != null && b.slpm != null && a.str_def != null
    ? a.slpm * (100 - b.str_def) / 100 - b.slpm * (100 - a.str_def) / 100 : 0),
};

const DEFAULT_CONFIG = {
  shrinkMinutes: 0,     // pseudo-minutes of league prior mixed into rate stats (statsEngine.snapshot)
  halfLifeDays: 0,      // recency decay half-life for stats-fight sums (0 = off)
  layoffCapDays: 0,     // cap on layoff_days (0 = uncapped)
  winShrinkFights: 0,   // pseudo-fights at 50% mixed into win_rate / pro_win_rate (0 = raw)
  clipZ: 0,             // clip standardized features at ±clipZ (0 = no clipping)
  eloK: 40,             // Elo step (eloEngine.computeElo)
  eloFinishMult: 1,     // K multiplier for KO/SUB wins (1 = off)
  eloDecision: 'none',  // decision-win weighting: none | method | cards | score (eloEngine)
  eloDecisionFloor: 0.5,// weight of the least convincing decision
  eloDecisionCap: 1,    // weight of a shutout decision
  proRecordSource: 'approx', // 'approx' = pro_wins/pro_losses minus later UFC results; 'sherdog' = exact as-of record (ctx.proRecord)
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
function sideValues(snap, snapRecent, fighter, asOfDate, cfg = DEFAULT_CONFIG, ufcAfter = { wins: 0, losses: 0 }, elo = null, ctx = {}) {
  const asOf = new Date(asOfDate);
  const age = fighter?.date_of_birth ? (asOf - new Date(fighter.date_of_birth)) / (365.25 * 86400000) : null;
  const bout = ctx.bout || {};
  const c = ctx.career || {};
  const r4 = snap.cardio?.r4, r5 = snap.cardio?.r5;
  const early = [snap.cardio?.r1, snap.cardio?.r2, snap.cardio?.r3].filter(v => v != null);
  const late = [r4, r5].filter(v => v != null);
  const lateCardio = early.length && late.length && early.reduce((s, v) => s + v, 0) > 0
    ? (late.reduce((s, v) => s + v, 0) / late.length) / (early.reduce((s, v) => s + v, 0) / early.length) - 1
    : null;
  const naturalLimit = c.naturalLimit ?? null;
  const kw = cfg.winShrinkFights || 0;
  const shrinkRate = (w, n) => (n + kw > 0 ? ((w + kw * 0.5) / (n + kw)) * 100 : null);
  const decided = snap.record.wins + snap.record.losses;
  const layoff = snap.last_fight_date ? (asOf - new Date(snap.last_fight_date)) / 86400000 : null;
  let proW = null, proL = null;
  if (fighter?.pro_wins != null && fighter?.pro_losses != null) {
    proW = Math.max(0, fighter.pro_wins - (ufcAfter.wins || 0));
    proL = Math.max(0, fighter.pro_losses - (ufcAfter.losses || 0));
  }
  if (cfg.proRecordSource === 'sherdog' && ctx.proRecord) { proW = ctx.proRecord.wins; proL = ctx.proRecord.losses; }
  const proRate = proW == null ? null : shrinkRate(proW, proW + proL);
  return {
    slpm: snap.slpm, sapm: snap.sapm, str_acc: snap.str_acc, str_def: snap.str_def,
    td_avg: snap.td_avg, td_acc: snap.td_acc, td_def: snap.td_def, sub_avg: snap.sub_avg,
    kd_per15: snap.kd_per15, kd_absorbed_per15: snap.kd_absorbed_per15,
    cardio_degradation: snap.cardio_degradation,
    experience: snap.total_fights,
    win_rate: shrinkRate(snap.record.wins, decided),
    recent_win_rate: snapRecent.stats_win_rate,
    form_trend: snapRecent.slpm != null && snap.slpm != null ? snapRecent.slpm - snap.slpm : null,
    age,
    reach: fighter?.reach_inches ?? null,
    height: fighter?.height_inches ?? null,
    layoff_days: layoff == null ? null : (cfg.layoffCapDays > 0 ? Math.min(layoff, cfg.layoffCapDays) : layoff),
    stats_minutes: snap.stats_seconds / 60,
    pro_win_rate: proRate,
    pro_fights: proW == null ? null : proW + proL,
    elo: elo ? elo.elo : null,
    sos: elo ? elo.sos : null,
    elo_best_win: elo ? elo.elo_best_win : null,
    elo_trend: elo ? elo.elo_trend : null,
    opp_adj_slpm: snap.slpm_adj ?? null,
    opp_adj_sapm: snap.sapm_adj ?? null,
    opp_adj_td_avg: snap.td_avg_adj ?? null,
    age_sq: age == null ? null : (age - 30) ** 2,
    years_active: c.firstFightDate ? (asOf - new Date(c.firstFightDate)) / (365.25 * 86400000) : null,
    ko_losses_career: c.koLossesCareer ?? null,
    ko_losses_24m: c.koLosses24m ?? null,
    fights_12m: c.fights12m ?? null,
    five_round_fights: c.fiveRoundFights ?? null,
    five_round_fights_sched: c.fiveRoundFights == null ? null : (bout.scheduledRounds === 5 ? c.fiveRoundFights : 0),
    late_round_cardio: lateCardio,
    natural_limit: naturalLimit,
    moving_up_lbs: naturalLimit != null && bout.limitLbs != null ? bout.limitLbs - naturalLimit : null,
    off_division_fights: c.offDivisionFights ?? null,
    age_elo: age != null && elo ? (age - 30) * (elo.elo - 1500) / 100 : null,
    style_distance: snap.sig_distance_pct ?? null,
    style_clinch: snap.sig_clinch_pct ?? null,
    style_ground: snap.sig_ground_pct ?? null,
    style_ctrl: snap.ctrl_pct ?? null,
    style_pair_edge: ctx.stylePairEdge ?? null, // set by the caller once both labels are known
    style_label: ctx.styleLabel ?? null,         // not a model feature; carried for the caller
    replacement: ctx.notice ? ctx.notice.replacement : null, // set by the trainer from short-notice.json; null at serving = neutral
    notice_days: ctx.notice ? ctx.notice.days : null,
    dwcs: ctx.dwcs ? ctx.dwcs.dwcs : null,                     // set by the trainer from dwcs_results; null at serving = neutral
    dwcs_won: ctx.dwcs ? ctx.dwcs.won : null,
    dwcs_finish: ctx.dwcs ? ctx.dwcs.finish : null,
    dwcs_days_to_debut: ctx.dwcs ? ctx.dwcs.daysToDebut : null,
    regional_finish_rate: ctx.regional ? ctx.regional.finishRate : null,
    regional_opp_quality: ctx.regional ? ctx.regional.oppQuality : null,
    regional_opp_ufc_share: ctx.regional ? ctx.regional.oppUfcShare : null,
    pro_record_quality: proRate == null ? null : (proRate - 50) * Math.min(proW + proL, 30) / 100,
  };
}

/**
 * Date-window and division facts about a timeline as of `asOf` (fights
 * strictly before `cutoff`, or all when cutoff is null).
 *   limitByWc  weight_class_id -> limit_lbs (from the weight_classes table)
 */
function careerContext(timeline, asOf, cutoff, limitByWc = {}) {
  const fights = cutoff ? timeline.filter(e => e.date < cutoff) : timeline;
  const asOfMs = new Date(asOf).getTime();
  const daysAgo = e => (asOfMs - new Date(e.date).getTime()) / 86400000;
  const isKoLoss = e => e.result === 'loss' && /KO/i.test(e.method || '');
  const wcCounts = {};
  for (const e of fights) if (e.weightClassId != null) wcCounts[e.weightClassId] = (wcCounts[e.weightClassId] || 0) + 1;
  const modal = Object.entries(wcCounts).sort((a, b) => b[1] - a[1])[0];
  const modalWc = modal ? +modal[0] : null;
  return {
    firstFightDate: fights.length ? fights[0].date : null,
    koLossesCareer: fights.filter(isKoLoss).length,
    koLosses24m: fights.filter(e => isKoLoss(e) && daysAgo(e) <= 730).length,
    fights12m: fights.filter(e => daysAgo(e) <= 365).length,
    fiveRoundFights: fights.filter(e => e.scheduledRounds === 5).length,
    modalWeightClassId: modalWc,
    naturalLimit: modalWc != null ? (limitByWc[modalWc] ?? null) : null,
    offDivisionFights: modalWc != null ? fights.filter(e => e.weightClassId != null && e.weightClassId !== modalWc).length : null,
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
 *   bout     { scheduledRounds (3|5), limitLbs } for THIS bout; limitByWc map
 *            for the natural-division lookup. Missing pieces leave the
 *            dependent features null (= neutral).
 */
function sideFeatures(timeline, fighter, asOf, cutoff, cfg = DEFAULT_CONFIG, priors = null, elo = null, bout = {}, limitByWc = {}) {
  const snapOpts = { asOf, halfLifeDays: cfg.halfLifeDays, shrinkMinutes: cfg.shrinkMinutes, priors };
  const snap = snapshot(timeline, cutoff, null, snapOpts);
  const recent = snapshot(timeline, cutoff, 3, snapOpts);
  const eloSummary = elo && fighter ? elo.summaryAsOf(fighter.id, cutoff) : null;
  const career = careerContext(timeline, asOf, cutoff, limitByWc);
  const styleLabel = styleProfile(snap).label;
  return sideValues(snap, recent, fighter, asOf, cfg, ufcResultsOnOrAfter(timeline, asOf), eloSummary, { bout, career, styleLabel });
}

// Once both sides are known, set the antisymmetric style-vs-style edge
// (edge for A; B gets the negative). `edgeFn(styleA, styleB)` comes from
// styleEngine (a point-in-time value for training, the final table for serving).
function attachStylePairEdge(a, b, edgeFn) {
  const e = edgeFn ? edgeFn(a.style_label, b.style_label) : 0;
  a.style_pair_edge = e; b.style_pair_edge = -e;
}

// A-minus-B differentials in FEATURES order; null on either side -> 0.
// Pairwise features are computed from both sides (see PAIR_FEATURES).
function diffVector(a, b) {
  return FEATURES.map(k => (PAIR_FEATURES[k] ? PAIR_FEATURES[k](a, b) : (a[k] != null && b[k] != null ? a[k] - b[k] : 0)));
}

// Standardize a raw diff vector with train-set mu/sigma, clipping at ±clipZ
// when set. Used by the trainer, the harness and the engine alike.
function standardize(x, mu, sigma, clipZ = 0) {
  return x.map((v, j) => {
    const z = (v - mu[j]) / sigma[j];
    return clipZ > 0 ? Math.max(-clipZ, Math.min(clipZ, z)) : z;
  });
}

module.exports = { FEATURES, PAIR_FEATURES, DEFAULT_CONFIG, sideValues, sideFeatures, attachStylePairEdge, careerContext, ufcResultsOnOrAfter, diffVector, standardize };

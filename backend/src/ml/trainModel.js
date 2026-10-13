/**
 * trainModel.js — train the shipped predictor (logistic regression) and write
 * src/ml/model-v5.json.
 *
 * Dataset: every completed fight with a winner (TRAIN_MIN_PRIOR prior
 * stats-fights per side; 0 = debutants included). Features are computed with
 * a cutoff at the fight's own date (statsEngine snapshots see only earlier
 * fights — no time leakage) under TRAIN_CONFIG (shrinkage toward league
 * priors, recency decay, layoff cap, z-clipping). The config and the priors
 * are stored in the model file so predictionEngine.js serves exactly what
 * was trained.
 *
 * Orientation: DB fighter1 is always the winner, so a naive label would be
 * constant. Each fight is deterministically flipped by a hash of its id so
 * labels are ~50/50 and re-runs are reproducible.
 *
 * Split: train < 2024-01-01 <= test (time-based; user-specified backtest era).
 * For the rolling-origin evaluation (one fold per year, feature gate, sanity
 * set, market baseline) use src/ml/evaluate.js — it imports the dataset
 * builder, trainer and scorer from here so the two can never drift.
 *
 * Output: src/ml/model-v5.json (weights, standardization, metrics) — read by
 * predictionEngine.js. Writes NOTHING to the database.
 *
 * Run: node -r dotenv/config src/ml/trainModel.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../db/client');
const { buildTimelines, computePriors, annotateOpponentPriors } = require('./statsEngine');
const { computeElo, eloOptions } = require('./eloEngine');
const { buildStylePairHistory } = require('./styleEngine');
const { FEATURES, DEFAULT_CONFIG, sideFeatures, ufcResultsOnOrAfter, diffVector, standardize } = require('./features');

const SPLIT_DATE = '2024-01-01';
const MIN_PRIOR_STATS_FIGHTS = 2;   // harness default (Phase-0 comparability)
const PRIOR_CUTOFF = '2019-01-01'; // league priors use only fights before the first evaluation fold
const MODEL_PATH = path.join(__dirname, 'model-v5.json');
// Late replacements per fight (scrapers/wiki-short-notice.js). Shipped in v5 (2026-10-13): replacement + notice_days
// passed the gate (-0.0030 mean, worse only 2023 +0.0010); a binary short_notice (<= 21 days) was redundant with them.
// Lives in the fight_replacements table (migration 2026-10-13); npm run weekly refreshes it.
// buildDataset takes the map as an option (`shortNotice`); an empty map = every row is a full camp (feature diff 0).
const SHORT_NOTICE_DAYS = 21;
async function loadShortNotice() {
  const rows = await loadAll('fight_replacements', 'fight_id, fighter_id, days, cue');
  return Object.fromEntries(rows.map(r => [r.fight_id, { fighterId: r.fighter_id, days: r.days, cue: r.cue }]));
}
// Contender Series appearances (scrapers/wiki-dwcs.js). Lives in the dwcs_results
// table (migration 2026-10-14); until that migration has been run the scraper
// writes backend/.cache/wiki-dwcs/dwcs-results.json and this reads that instead.
// Returns Map fighterId -> [{ date, won, finish }] sorted by date.
const DWCS_FALLBACK = path.join(__dirname, '..', '..', '.cache', 'wiki-dwcs', 'dwcs-results.json');
const DWCS_DAYS_CAP = 730;
async function loadDwcs() {
  let rows;
  const { error } = await supabase.from('dwcs_results').select('fighter_id').limit(1);
  if (!error) rows = await loadAll('dwcs_results', 'fighter_id, dwcs_date, won, finish');
  else if (fs.existsSync(DWCS_FALLBACK)) rows = JSON.parse(fs.readFileSync(DWCS_FALLBACK, 'utf8'));
  else return new Map();
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.fighter_id)) map.set(r.fighter_id, []);
    map.get(r.fighter_id).push({ date: r.dwcs_date, won: r.won ? 1 : 0, finish: r.finish ? 1 : 0 });
  }
  for (const list of map.values()) list.sort((x, y) => (x.date < y.date ? -1 : 1));
  return map;
}
// Per-side DWCS context for a training row: the latest appearance before the bout, else zeros.
// daysToDebut = DWCS bout -> first UFC fight (the fighter's earliest timeline entry), capped.
function dwcsFor(list, fightDate, timeline) {
  const none = { dwcs: 0, won: 0, finish: 0, daysToDebut: 0 };
  if (!list?.length) return none;
  const prior = list.filter(e => e.date < fightDate);
  if (!prior.length) return none;
  const last = prior[prior.length - 1];
  const debut = timeline?.length ? timeline.reduce((m, e) => (e.date < m ? e.date : m), timeline[0].date) : fightDate;
  const days = Math.max(0, Math.round((new Date(debut) - new Date(last.date)) / 86400000));
  return { dwcs: 1, won: last.won, finish: last.finish, daysToDebut: Math.min(DWCS_DAYS_CAP, days) };
}

// Per-side notice context for a training row: a full camp unless this fighter was the replacement.
function noticeFor(rec, fighterId) {
  if (!rec || rec.fighterId !== fighterId) return { replacement: 0, days: 60 };
  return { replacement: 1, days: rec.days != null ? Math.min(60, rec.days) : SHORT_NOTICE_DAYS };
}

// What the SHIPPED model is trained with (Phases 1+2, chosen with evaluate.js
// on 2026-10-12: pooled logloss 0.6482 -> 0.6417 (Phase 1) -> 0.6317 (Phase 2)
// on the min-prior-2 subset). Training includes debutants (min prior 0) so the
// model is calibrated on the population the Predict page actually serves.
// Dropped at the gate (leave-one-out under this config, 2026-10-12): the Phase-2
// extras stats_minutes, opp_adj_td_avg, elo_best_win, elo_trend, sos, and the
// legacy features whose removal did not raise held-out logloss — slpm,
// kd_absorbed_per15, cardio_degradation, experience, recent_win_rate,
// form_trend. Final 18-feature set: pooled logloss 0.6298 on the min-prior-2 subset.
const TRAIN_CONFIG = { ...DEFAULT_CONFIG, shrinkMinutes: 30, halfLifeDays: 1095, layoffCapDays: 730, winShrinkFights: 2, clipZ: 3, eloK: 100, eloFinishMult: 1.5 };
const TRAIN_MIN_PRIOR = 0;
const TRAIN_EXCLUDED = new Set([
  'stats_minutes', 'opp_adj_td_avg', 'elo_best_win', 'elo_trend', 'sos',
  'slpm', 'kd_absorbed_per15', 'cardio_degradation', 'experience', 'recent_win_rate', 'form_trend',
  // Phase 3 (2026-10-12): none passed the gate; see CLAUDE.md "Phase-3 findings"
  'age_sq', 'years_active', 'ko_losses_career', 'ko_losses_24m', 'fights_12m',
  'five_round_fights', 'five_round_fights_sched', 'late_round_cardio',
  'natural_limit', 'moving_up_lbs', 'off_division_fights',
  // age_elo PASSED the gate (2026-10-12: -0.0014 mean, worse only in 2026) and is shipped
  // Phase 4 style features: pending gate
  'style_distance', 'style_clinch', 'style_ground', 'style_ctrl', 'style_pair_edge', 'pair_td_threat', 'pair_strike_threat',
  // Contender Series (2026-10-14): pending gate
  'dwcs', 'dwcs_won', 'dwcs_finish', 'dwcs_days_to_debut',
]);
const TRAIN_FEATURES = FEATURES.filter(f => !TRAIN_EXCLUDED.has(f));

const FIGHT_COLS = 'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, round, time, time_format, is_title_fight, weight_class_id, rounds_data, judge1_score, judge2_score, judge3_score';
const FIGHTER_COLS = 'id, slug, first_name, last_name, date_of_birth, reach_inches, height_inches, pro_wins, pro_losses';

async function loadAll(table, cols) {
  const all = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`loadAll(${table}): ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

const sigmoid = z => 1 / (1 + Math.exp(-z));
const hashFlip = id => parseInt(id.replace(/-/g, '').slice(0, 8), 16) % 2 === 1;

// fitIntercept defaults to FALSE: every feature is an A-minus-B differential
// and the orientation is randomized by the hash flip, so the true intercept
// is zero. A fitted intercept would make P(A beats B) != 1 - P(B beats A).
function trainLogistic(X, y, { epochs = 1200, lr = 0.3, l2 = 1e-3, fitIntercept = false } = {}) {
  const n = X.length, d = X[0].length;
  let w = new Array(d).fill(0), b = 0;
  for (let e = 0; e < epochs; e++) {
    const gw = new Array(d).fill(0);
    let gb = 0;
    for (let i = 0; i < n; i++) {
      const z = X[i].reduce((s, x, j) => s + x * w[j], b);
      const err = sigmoid(z) - y[i];
      for (let j = 0; j < d; j++) gw[j] += err * X[i][j];
      gb += err;
    }
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
    if (fitIntercept) b -= lr * (gb / n);
  }
  return { w, b };
}

function evaluate(X, y, w, b) {
  let correct = 0, logloss = 0, brier = 0;
  const bins = Array.from({ length: 10 }, () => ({ n: 0, pSum: 0, ySum: 0 }));
  for (let i = 0; i < X.length; i++) {
    const p = sigmoid(X[i].reduce((s, x, j) => s + x * w[j], b));
    if ((p > 0.5 ? 1 : 0) === y[i]) correct++;
    const pc = Math.min(1 - 1e-9, Math.max(1e-9, p));
    logloss += -(y[i] * Math.log(pc) + (1 - y[i]) * Math.log(1 - pc));
    brier += (p - y[i]) ** 2;
    const bin = Math.min(9, Math.floor(p * 10));
    bins[bin].n++; bins[bin].pSum += p; bins[bin].ySum += y[i];
  }
  return {
    n: X.length,
    accuracy: correct / X.length,
    logloss: logloss / X.length,
    brier: brier / X.length,
    calibration: bins.map((bn, i) => ({
      range: `${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)}`,
      n: bn.n,
      predicted: bn.n ? bn.pSum / bn.n : null,
      actual: bn.n ? bn.ySum / bn.n : null,
    })),
  };
}

/**
 * Build the point-in-time training rows from raw tables.
 * Each row: { date, fightId, weightClassId, method, x (A-minus-B diffs in
 * FEATURES order), y (1 = A won), a, b (per-side feature values), flip
 * (true when A is DB fighter2), minPriorStats }.
 */
// Bout weight class when the fight row has none (503 of 511 fights in 2022):
// the division both fighters mostly fought in within two years of the date,
// or the one side that has one. Read-only imputation for the model path; the
// DB rows stay as they are.
function imputeWeightClass(tl1, tl2, date) {
  const modal = tl => {
    const counts = {};
    for (const e of tl || []) {
      if (e.weightClassId == null || Math.abs(new Date(e.date) - new Date(date)) > 730 * 86400000) continue;
      counts[e.weightClassId] = (counts[e.weightClassId] || 0) + 1;
    }
    const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    return top ? +top[0] : null;
  };
  const a = modal(tl1), b = modal(tl2);
  if (a != null && b != null) return a === b ? a : null;
  return a ?? b ?? null;
}

const scheduledRoundsOf = f => (/5 Rnd/i.test(f.time_format || '') ? 5 : 3);

function buildDataset(fights, events, fighters, { minPriorStatsFights = MIN_PRIOR_STATS_FIGHTS, cfg = DEFAULT_CONFIG, weightClasses = [], shortNotice = {}, dwcs = new Map() } = {}) {
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));
  const limitByWc = Object.fromEntries(weightClasses.filter(w => w.limit_lbs != null).map(w => [w.id, w.limit_lbs]));
  const timelines = annotateOpponentPriors(buildTimelines(fights, eventById));
  const priors = cfg.shrinkMinutes > 0 ? computePriors(timelines, PRIOR_CUTOFF) : null;
  const elo = computeElo(fights, eventById, eloOptions(cfg));
  // style-vs-style record, point-in-time per fight (styleEngine)
  const styleHist = buildStylePairHistory(fights, eventById, timelines, { halfLifeDays: cfg.halfLifeDays, shrinkMinutes: cfg.shrinkMinutes, priors });

  const rows = [];
  let imputedWc = 0, missingWc = 0;
  let skippedInexperienced = 0;
  for (const f of fights) {
    if (f.result !== 'win' || !f.winner_id) continue;
    const ev = eventById[f.event_id];
    if (!ev) continue;
    const tl1 = timelines.get(f.fighter1_id), tl2 = timelines.get(f.fighter2_id);
    if (!tl1 || !tl2) continue;
    const prior1 = tl1.filter(e => e.date < ev.date && e.hasStats).length;
    const prior2 = tl2.filter(e => e.date < ev.date && e.hasStats).length;
    if (prior1 < minPriorStatsFights || prior2 < minPriorStatsFights) { skippedInexperienced++; continue; }

    // deterministic orientation flip (fighter1 is always the winner in the DB)
    const flip = hashFlip(f.id);
    const aId = flip ? f.fighter2_id : f.fighter1_id;
    const bId = flip ? f.fighter1_id : f.fighter2_id;
    const label = f.winner_id === aId ? 1 : 0;

    let wcId = f.weight_class_id ?? null;
    if (wcId == null) { wcId = imputeWeightClass(tl1, tl2, ev.date); if (wcId != null) imputedWc++; else missingWc++; }
    const bout = { scheduledRounds: scheduledRoundsOf(f), weightClassId: wcId, limitLbs: wcId != null ? (limitByWc[wcId] ?? null) : null };
    const a = sideFeatures(timelines.get(aId), fighterById[aId], ev.date, ev.date, cfg, priors, elo, bout, limitByWc);
    const b = sideFeatures(timelines.get(bId), fighterById[bId], ev.date, ev.date, cfg, priors, elo, bout, limitByWc);
    // pre-fight style-vs-style edge, stored for DB fighter1; A is fighter1 unless flipped
    const e1 = styleHist.edgeByFight.get(f.id) ?? 0;
    a.style_pair_edge = flip ? -e1 : e1; b.style_pair_edge = -a.style_pair_edge;
    const na = noticeFor(shortNotice[f.id], aId), nb = noticeFor(shortNotice[f.id], bId);
    Object.assign(a, { replacement: na.replacement, notice_days: na.days });
    Object.assign(b, { replacement: nb.replacement, notice_days: nb.days });
    const da = dwcsFor(dwcs.get(aId), ev.date, timelines.get(aId)), db = dwcsFor(dwcs.get(bId), ev.date, timelines.get(bId));
    Object.assign(a, { dwcs: da.dwcs, dwcs_won: da.won, dwcs_finish: da.finish, dwcs_days_to_debut: da.daysToDebut });
    Object.assign(b, { dwcs: db.dwcs, dwcs_won: db.won, dwcs_finish: db.finish, dwcs_days_to_debut: db.daysToDebut });
    rows.push({
      date: ev.date, fightId: f.id, weightClassId: wcId, method: f.method || null, bout,
      x: diffVector(a, b), y: label, a, b, flip, minPriorStats: Math.min(prior1, prior2), priorA: flip ? prior2 : prior1, priorB: flip ? prior1 : prior2,
    });
  }
  return { rows, timelines, eventById, fighterById, priors, elo, styleHist, cfg, limitByWc, skippedInexperienced, imputedWc, missingWc };
}

async function main() {
  console.log('Predictor v5 training\n');
  const events = await loadAll('events', 'id, date');
  const fights = await loadAll('fights', FIGHT_COLS);
  const fighters = await loadAll('fighters', FIGHTER_COLS);
  const weightClasses = await loadAll('weight_classes', 'id, name, limit_lbs');
  const shortNotice = await loadShortNotice();
  const dwcs = await loadDwcs();

  console.log(`Loaded ${fights.length} fights, ${Object.keys(shortNotice).length} late replacements; building timelines...`);
  const { rows, priors, skippedInexperienced, imputedWc, missingWc } = buildDataset(fights, events, fighters, { minPriorStatsFights: TRAIN_MIN_PRIOR, cfg: TRAIN_CONFIG, weightClasses, shortNotice, dwcs });
  console.log(`Bout weight class: imputed on ${imputedWc} rows, unknown on ${missingWc}`);
  console.log(`Config: ${JSON.stringify(TRAIN_CONFIG)}  features ${TRAIN_FEATURES.length}/${FEATURES.length}`);
  console.log(`Dataset: ${rows.length} fights (skipped ${skippedInexperienced} where a fighter had <${TRAIN_MIN_PRIOR} prior stats-fights)`);
  const labelBalance = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  console.log(`Label balance: ${(labelBalance * 100).toFixed(1)}% positive (orientation flip working if ~50%)`);

  // The shipped model is fit on EVERY row; the split below only produces the
  // metrics stored in the file. evaluate.js is the real judge.
  const train = rows.filter(r => r.date < SPLIT_DATE);
  const test = rows.filter(r => r.date >= SPLIT_DATE);
  console.log(`Report split: train ${train.length} (< ${SPLIT_DATE})  |  test ${test.length} (>= ${SPLIT_DATE})\n`);

  const idx = TRAIN_FEATURES.map(n => FEATURES.indexOf(n));
  const d = idx.length;
  // Standardization is centred on ZERO (mu = 0, sigma = RMS): every feature is
  // an A-minus-B differential whose true mean is zero by construction, and a
  // fitted non-zero mean would make A-vs-B and B-vs-A unequal after clipping.
  const fit = (fitRows) => {
    const mu = new Array(d).fill(0), sigma = new Array(d).fill(0);
    for (const r of fitRows) for (let j = 0; j < d; j++) sigma[j] += r.x[idx[j]] ** 2 / fitRows.length;
    for (let j = 0; j < d; j++) sigma[j] = Math.sqrt(sigma[j]) || 1;
    const std = r => standardize(idx.map(k => r.x[k]), mu, sigma, TRAIN_CONFIG.clipZ);
    const { w, b } = trainLogistic(fitRows.map(std), fitRows.map(r => r.y));
    return { mu, sigma, w, b, std };
  };

  // ── Report fit (train < split, scored on >= split) ────────────────────────
  console.log('Training report model (train < split)...');
  const rep = fit(train);
  const trainMetrics = evaluate(train.map(rep.std), train.map(r => r.y), rep.w, rep.b);
  const testMetrics = evaluate(test.map(rep.std), test.map(r => r.y), rep.w, rep.b);

  console.log('\n======== REPORT SPLIT ========');
  console.log(`Train (${trainMetrics.n}):  accuracy ${(trainMetrics.accuracy * 100).toFixed(1)}%  logloss ${trainMetrics.logloss.toFixed(4)}  brier ${trainMetrics.brier.toFixed(4)}`);
  console.log(`Test  (${testMetrics.n}):  accuracy ${(testMetrics.accuracy * 100).toFixed(1)}%  logloss ${testMetrics.logloss.toFixed(4)}  brier ${testMetrics.brier.toFixed(4)}`);
  console.log(`Baselines: coin flip 50.0% / logloss 0.6931`);

  console.log('\nCalibration (test):  range | n | mean predicted | actual win rate');
  for (const c of testMetrics.calibration) {
    if (!c.n) continue;
    console.log(`  ${c.range} | ${String(c.n).padStart(4)} | ${(c.predicted * 100).toFixed(1)}% | ${(c.actual * 100).toFixed(1)}%`);
  }

  // ── Shipped fit (all rows) ────────────────────────────────────────────────
  console.log('\nTraining shipped model (all rows)...');
  const { mu, sigma, w, b } = fit(rows);
  console.log('\nCoefficients (standardized — magnitude = importance):');
  TRAIN_FEATURES.map((name, j) => ({ name, w: w[j] }))
    .sort((a2, b2) => Math.abs(b2.w) - Math.abs(a2.w))
    .forEach(({ name, w: wj }) => console.log(`  ${name.padEnd(20)} ${wj >= 0 ? '+' : ''}${wj.toFixed(4)}`));

  // ── Odds benchmark (when the odds table has data) ──────────────────────────
  const { count: oddsCount } = await supabase.from('odds').select('id', { count: 'exact', head: true });
  if (!oddsCount) {
    console.log('\nOdds benchmark: SKIPPED — odds table is empty (backfill it and run evaluate.js for the market comparison).');
  } else {
    console.log(`\nOdds benchmark: ${oddsCount} odds rows found — run src/ml/evaluate.js for the market comparison.`);
  }

  fs.writeFileSync(MODEL_PATH, JSON.stringify({
    version: 'v5',
    trainedAt: new Date().toISOString(),
    splitDate: SPLIT_DATE,
    minPriorStatsFights: TRAIN_MIN_PRIOR,
    rows: rows.length,
    config: TRAIN_CONFIG,
    priors,
    features: TRAIN_FEATURES,
    mu, sigma, w, b,
    metrics: { note: 'report split only; the shipped weights are fit on all rows. See src/ml/reports for the rolling-origin evaluation.',
               train: { n: trainMetrics.n, accuracy: trainMetrics.accuracy, logloss: trainMetrics.logloss },
               test: { n: testMetrics.n, accuracy: testMetrics.accuracy, logloss: testMetrics.logloss, brier: testMetrics.brier } },
  }, null, 2));
  console.log(`\nModel written to ${MODEL_PATH}`);
}

module.exports = {
  loadAll, loadShortNotice, loadDwcs, hashFlip, sigmoid, trainLogistic, evaluate, buildDataset, sideFeatures, ufcResultsOnOrAfter, imputeWeightClass, scheduledRoundsOf,
  FIGHT_COLS, FIGHTER_COLS, MIN_PRIOR_STATS_FIGHTS, SPLIT_DATE, PRIOR_CUTOFF, TRAIN_CONFIG, TRAIN_MIN_PRIOR, TRAIN_FEATURES, MODEL_PATH,
};

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}

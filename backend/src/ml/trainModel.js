/**
 * trainModel.js — train the shipped predictor (logistic regression) and write
 * src/ml/model-v4.json.
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
 * Output: src/ml/model-v3.json (weights, standardization, metrics) — read by
 * predictionEngine.js. Writes NOTHING to the database.
 *
 * Run: node -r dotenv/config src/ml/trainModel.js
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const supabase = require('../db/client');
const { buildTimelines, computePriors } = require('./statsEngine');
const { FEATURES, DEFAULT_CONFIG, sideFeatures, ufcResultsOnOrAfter, diffVector, standardize } = require('./features');

const SPLIT_DATE = '2024-01-01';
const MIN_PRIOR_STATS_FIGHTS = 2;   // harness default (Phase-0 comparability)
const PRIOR_CUTOFF = '2019-01-01'; // league priors use only fights before the first evaluation fold
const MODEL_PATH = path.join(__dirname, 'model-v4.json');

// What the SHIPPED model is trained with (Phase 1, chosen with evaluate.js on
// 2026-10-12: pooled logloss 0.6482 -> 0.6417 on the min-prior-2 subset).
// Training includes debutants (min prior 0) so the model is calibrated on the
// population the Predict page actually serves. stats_minutes failed the gate.
const TRAIN_CONFIG = { ...DEFAULT_CONFIG, shrinkMinutes: 30, halfLifeDays: 1095, layoffCapDays: 730, winShrinkFights: 2, clipZ: 3 };
const TRAIN_MIN_PRIOR = 0;
const TRAIN_FEATURES = FEATURES.filter(f => f !== 'stats_minutes');

const FIGHT_COLS = 'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, round, time, time_format, is_title_fight, weight_class_id, rounds_data';
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

function trainLogistic(X, y, { epochs = 1200, lr = 0.3, l2 = 1e-3 } = {}) {
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
    b -= lr * (gb / n);
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
function buildDataset(fights, events, fighters, { minPriorStatsFights = MIN_PRIOR_STATS_FIGHTS, cfg = DEFAULT_CONFIG } = {}) {
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));
  const timelines = buildTimelines(fights, eventById);
  const priors = cfg.shrinkMinutes > 0 ? computePriors(timelines, PRIOR_CUTOFF) : null;

  const rows = [];
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

    const a = sideFeatures(timelines.get(aId), fighterById[aId], ev.date, ev.date, cfg, priors);
    const b = sideFeatures(timelines.get(bId), fighterById[bId], ev.date, ev.date, cfg, priors);
    rows.push({
      date: ev.date, fightId: f.id, weightClassId: f.weight_class_id ?? null, method: f.method || null,
      x: diffVector(a, b), y: label, a, b, flip, minPriorStats: Math.min(prior1, prior2),
    });
  }
  return { rows, timelines, eventById, fighterById, priors, cfg, skippedInexperienced };
}

async function main() {
  console.log('Predictor v4 training\n');
  const events = await loadAll('events', 'id, date');
  const fights = await loadAll('fights', FIGHT_COLS);
  const fighters = await loadAll('fighters', FIGHTER_COLS);

  console.log(`Loaded ${fights.length} fights; building timelines...`);
  const { rows, priors, skippedInexperienced } = buildDataset(fights, events, fighters, { minPriorStatsFights: TRAIN_MIN_PRIOR, cfg: TRAIN_CONFIG });
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
  const fit = (fitRows) => {
    const mu = new Array(d).fill(0), sigma = new Array(d).fill(0);
    for (const r of fitRows) for (let j = 0; j < d; j++) mu[j] += r.x[idx[j]] / fitRows.length;
    for (const r of fitRows) for (let j = 0; j < d; j++) sigma[j] += (r.x[idx[j]] - mu[j]) ** 2 / fitRows.length;
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
    version: 'v4',
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
  loadAll, hashFlip, sigmoid, trainLogistic, evaluate, buildDataset, sideFeatures, ufcResultsOnOrAfter,
  FIGHT_COLS, FIGHTER_COLS, MIN_PRIOR_STATS_FIGHTS, SPLIT_DATE, PRIOR_CUTOFF, TRAIN_CONFIG, TRAIN_MIN_PRIOR, TRAIN_FEATURES, MODEL_PATH,
};

if (require.main === module) {
  main().catch(e => { console.error('Fatal:', e); process.exit(1); });
}

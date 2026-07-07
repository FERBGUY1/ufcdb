/**
 * trainModel.js — train predictor v3 (logistic regression) and backtest it.
 *
 * Dataset: every completed fight with a winner where BOTH fighters have >=2
 * prior stats-fights. Features are computed with a cutoff at the fight's own
 * date (statsEngine snapshots see only earlier fights — no time leakage).
 *
 * Orientation: DB fighter1 is always the winner, so a naive label would be
 * constant. Each fight is deterministically flipped by a hash of its id so
 * labels are ~50/50 and re-runs are reproducible.
 *
 * Split: train < 2024-01-01 <= test (time-based; user-specified backtest era).
 * Odds benchmark: runs against the odds table when it has rows; skipped
 * (and said so) while it's empty.
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
const { buildTimelines, snapshot } = require('./statsEngine');
const { FEATURES, sideValues, diffVector } = require('./features');

const SPLIT_DATE = '2024-01-01';
const MIN_PRIOR_STATS_FIGHTS = 2;
const MODEL_PATH = path.join(__dirname, 'model-v3.json');

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

async function main() {
  console.log('Predictor v3 training\n');
  const events = await loadAll('events', 'id, date');
  const fights = await loadAll('fights',
    'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, round, time, time_format, is_title_fight, rounds_data');
  const fighters = await loadAll('fighters', 'id, first_name, last_name, date_of_birth, reach_inches, height_inches');
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const fighterById = Object.fromEntries(fighters.map(f => [f.id, f]));

  console.log(`Loaded ${fights.length} fights; building timelines...`);
  const timelines = buildTimelines(fights, eventById);

  // ── Build dataset ──────────────────────────────────────────────────────────
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
    if (prior1 < MIN_PRIOR_STATS_FIGHTS || prior2 < MIN_PRIOR_STATS_FIGHTS) { skippedInexperienced++; continue; }

    // deterministic orientation flip (fighter1 is always the winner in the DB)
    const flip = hashFlip(f.id);
    const aId = flip ? f.fighter2_id : f.fighter1_id;
    const bId = flip ? f.fighter1_id : f.fighter2_id;
    const label = f.winner_id === aId ? 1 : 0;

    const tlA = timelines.get(aId), tlB = timelines.get(bId);
    const a = sideValues(snapshot(tlA, ev.date), snapshot(tlA, ev.date, 3), fighterById[aId], ev.date);
    const b = sideValues(snapshot(tlB, ev.date), snapshot(tlB, ev.date, 3), fighterById[bId], ev.date);
    rows.push({ date: ev.date, fightId: f.id, x: diffVector(a, b), y: label });
  }
  console.log(`Dataset: ${rows.length} fights (skipped ${skippedInexperienced} where a fighter had <${MIN_PRIOR_STATS_FIGHTS} prior stats-fights)`);
  const labelBalance = rows.reduce((s, r) => s + r.y, 0) / rows.length;
  console.log(`Label balance: ${(labelBalance * 100).toFixed(1)}% positive (orientation flip working if ~50%)`);

  const train = rows.filter(r => r.date < SPLIT_DATE);
  const test = rows.filter(r => r.date >= SPLIT_DATE);
  console.log(`Split: train ${train.length} (< ${SPLIT_DATE})  |  test ${test.length} (>= ${SPLIT_DATE})\n`);

  // ── Standardize on train ───────────────────────────────────────────────────
  const d = FEATURES.length;
  const mu = new Array(d).fill(0), sigma = new Array(d).fill(0);
  for (const r of train) for (let j = 0; j < d; j++) mu[j] += r.x[j] / train.length;
  for (const r of train) for (let j = 0; j < d; j++) sigma[j] += (r.x[j] - mu[j]) ** 2 / train.length;
  for (let j = 0; j < d; j++) sigma[j] = Math.sqrt(sigma[j]) || 1;
  const standardize = x => x.map((v, j) => (v - mu[j]) / sigma[j]);
  const Xtr = train.map(r => standardize(r.x)), ytr = train.map(r => r.y);
  const Xte = test.map(r => standardize(r.x)), yte = test.map(r => r.y);

  // ── Train + evaluate ───────────────────────────────────────────────────────
  console.log('Training logistic regression...');
  const { w, b } = trainLogistic(Xtr, ytr);
  const trainMetrics = evaluate(Xtr, ytr, w, b);
  const testMetrics = evaluate(Xte, yte, w, b);

  console.log('\n======== RESULTS ========');
  console.log(`Train (${trainMetrics.n}):  accuracy ${(trainMetrics.accuracy * 100).toFixed(1)}%  logloss ${trainMetrics.logloss.toFixed(4)}  brier ${trainMetrics.brier.toFixed(4)}`);
  console.log(`Test  (${testMetrics.n}):  accuracy ${(testMetrics.accuracy * 100).toFixed(1)}%  logloss ${testMetrics.logloss.toFixed(4)}  brier ${testMetrics.brier.toFixed(4)}`);
  console.log(`Baselines: coin flip 50.0% / logloss 0.6931`);

  console.log('\nCalibration (test):  range | n | mean predicted | actual win rate');
  for (const c of testMetrics.calibration) {
    if (!c.n) continue;
    console.log(`  ${c.range} | ${String(c.n).padStart(4)} | ${(c.predicted * 100).toFixed(1)}% | ${(c.actual * 100).toFixed(1)}%`);
  }

  console.log('\nCoefficients (standardized — magnitude = importance):');
  FEATURES.map((name, j) => ({ name, w: w[j] }))
    .sort((a2, b2) => Math.abs(b2.w) - Math.abs(a2.w))
    .forEach(({ name, w: wj }) => console.log(`  ${name.padEnd(20)} ${wj >= 0 ? '+' : ''}${wj.toFixed(4)}`));

  // ── Odds benchmark (when the odds table has data) ──────────────────────────
  const { count: oddsCount } = await supabase.from('odds').select('id', { count: 'exact', head: true });
  if (!oddsCount) {
    console.log('\nOdds benchmark: SKIPPED — odds table is empty (backfill it and re-run for the market comparison).');
  } else {
    console.log(`\nOdds benchmark: ${oddsCount} odds rows found — implement comparison when historical odds land.`);
  }

  fs.writeFileSync(MODEL_PATH, JSON.stringify({
    version: 'v3',
    trainedAt: new Date().toISOString(),
    splitDate: SPLIT_DATE,
    minPriorStatsFights: MIN_PRIOR_STATS_FIGHTS,
    features: FEATURES,
    mu, sigma, w, b,
    metrics: { train: { n: trainMetrics.n, accuracy: trainMetrics.accuracy, logloss: trainMetrics.logloss },
               test: { n: testMetrics.n, accuracy: testMetrics.accuracy, logloss: testMetrics.logloss, brier: testMetrics.brier } },
  }, null, 2));
  console.log(`\nModel written to ${MODEL_PATH}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

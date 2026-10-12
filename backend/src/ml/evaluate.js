/**
 * evaluate.js — rolling-origin evaluation harness for the fight predictor.
 *
 * Every judgment about a feature or a model goes through this script, never
 * through trainModel.js's single 2024 split.
 *
 * FOLDS: one per year from --from to --to (default 2019..current year). Each
 * fold trains on every usable fight dated before Jan 1 of that year and tests
 * on the fights of that year. Standardization is fit on the fold's train rows.
 * Rows are the same point-in-time rows trainModel.js uses (buildDataset).
 *
 * REPORTS, per fold and pooled over all folds:
 *   - model: accuracy, log loss, Brier
 *   - baselines fit the same way on one or two features: win-rate pick,
 *     younger pick, win-rate+age
 *   - market: de-vigged closing consensus from the odds table on the fights
 *     that have one, with the model scored on that same subset (skipped and
 *     said so while the odds table is empty)
 *   - pooled calibration (10 bins) and accuracy per confidence label using the
 *     exact rule predictionEngine.js applies
 *
 * SANITY SET (src/ml/sanitySet.json): lopsided / cross-weight matchups served
 * full-career as of today, through BOTH the shipped model-v3.json and the
 * candidate (this run's features, fit on all rows). Pass = expected side gets
 * at least minProb.
 *
 * FEATURE GATE (--ablate): leave-one-feature-out across all folds. A feature
 * KEEPs its place only if including it lowers mean fold log loss AND raises it
 * in at most one fold. Anything else is a DROP candidate.
 *
 * COMPARE (--baseline report.json): same KEEP/DROP rule applied to this run's
 * model versus a report saved earlier with --out, fold by fold.
 *
 * Flags:
 *   --from YEAR --to YEAR    fold range (default 2019..now)
 *   --features a,b,c         restrict to a subset of features.js FEATURES
 *   --min-prior N            prior stats-fights required per side (default 2)
 *   --score-min-prior N      score only test rows whose thinner side has >= N
 *                            (default = --min-prior; use 2 to compare a
 *                            --min-prior 0 run against the Phase-0 baseline)
 *   --shrink K               pseudo-minutes of league prior mixed into rate stats
 *   --half-life DAYS         recency decay half-life for stats sums
 *   --layoff-cap DAYS        cap layoff_days
 *   --win-shrink N           pseudo-fights at 50% mixed into win rates
 *   --clip Z                 clip standardized features at ±Z
 *   --ablate                 leave-one-out feature gate (slow: folds x features fits)
 *   --out PATH               write the JSON report
 *   --baseline PATH          compare against a saved report
 *   --no-sanity              skip the sanity set
 *
 * Writes NOTHING to the database and never touches model-v3.json.
 * Run: node -r dotenv/config src/ml/evaluate.js [flags]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadAll, sigmoid, trainLogistic, evaluate, buildDataset, sideFeatures, FIGHT_COLS, FIGHTER_COLS, MIN_PRIOR_STATS_FIGHTS } = require('./trainModel');
const { FEATURES, DEFAULT_CONFIG, diffVector, standardize } = require('./features');

// ── CLI ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i > -1 && argv[i + 1] != null ? argv[i + 1] : dflt; };
const FROM = parseInt(opt('from', '2019'));
const TO = parseInt(opt('to', String(new Date().getFullYear())));
const MIN_PRIOR = parseInt(opt('min-prior', String(MIN_PRIOR_STATS_FIGHTS)));
// Score only test rows whose thinner side has at least this many prior
// stats-fights (training still uses every row). Lets a --min-prior 0 run be
// compared with the Phase-0 baseline on the same fights.
const SCORE_MIN_PRIOR = parseInt(opt('score-min-prior', String(MIN_PRIOR)));
const SELECTED = opt('features', null) ? opt('features').split(',').map(s => s.trim()).filter(Boolean) : FEATURES.slice();
const CFG = {
  ...DEFAULT_CONFIG,
  shrinkMinutes: parseFloat(opt('shrink', String(DEFAULT_CONFIG.shrinkMinutes))),
  halfLifeDays: parseFloat(opt('half-life', String(DEFAULT_CONFIG.halfLifeDays))),
  layoffCapDays: parseFloat(opt('layoff-cap', String(DEFAULT_CONFIG.layoffCapDays))),
  winShrinkFights: parseFloat(opt('win-shrink', String(DEFAULT_CONFIG.winShrinkFights))),
  clipZ: parseFloat(opt('clip', String(DEFAULT_CONFIG.clipZ))),
};
const ABLATE = flag('ablate');
const OUT = opt('out', null);
const BASELINE = opt('baseline', null);
const SANITY = !flag('no-sanity');
const SANITY_PATH = path.join(__dirname, 'sanitySet.json');
const { MODEL_PATH } = require('./trainModel');

for (const f of SELECTED) if (!FEATURES.includes(f)) { console.error(`Unknown feature "${f}". Known: ${FEATURES.join(', ')}`); process.exit(1); }

const BASELINE_SETS = {
  'win_rate only': ['win_rate'],
  'age only': ['age'],
  'win_rate+age': ['win_rate', 'age'],
};

const ll = (p, y) => { const pc = Math.min(1 - 1e-9, Math.max(1e-9, p)); return -(y * Math.log(pc) + (1 - y) * Math.log(1 - pc)); };
const pct = v => (v == null ? '   —  ' : `${(v * 100).toFixed(1)}%`.padStart(6));
const f4 = v => (v == null ? '  —   ' : v.toFixed(4));
const idxOf = names => names.map(n => FEATURES.indexOf(n));

// ── Core: fit on train rows, score test rows, for one feature subset ──────
function fitAndScore(train, test, names) {
  const idx = idxOf(names), d = idx.length;
  const mu = new Array(d).fill(0), sigma = new Array(d).fill(0);
  for (const r of train) for (let j = 0; j < d; j++) mu[j] += r.x[idx[j]] / train.length;
  for (const r of train) for (let j = 0; j < d; j++) sigma[j] += (r.x[idx[j]] - mu[j]) ** 2 / train.length;
  for (let j = 0; j < d; j++) sigma[j] = Math.sqrt(sigma[j]) || 1;
  const std = r => standardize(idx.map(k => r.x[k]), mu, sigma, CFG.clipZ);
  const Xtr = train.map(std), ytr = train.map(r => r.y);
  const { w, b } = trainLogistic(Xtr, ytr);
  const Xte = test.map(std), yte = test.map(r => r.y);
  const metrics = test.length ? evaluate(Xte, yte, w, b) : null;
  const probs = Xte.map(x => sigmoid(x.reduce((s, v, j) => s + v * w[j], b)));
  const zmax = Xte.map(x => Math.max(...x.map(Math.abs)));
  return { metrics, probs, zmax, w, b, mu, sigma, names };
}

function scoreSubset(probs, ys) {
  if (!probs.length) return null;
  let c = 0, L = 0, B = 0;
  for (let i = 0; i < probs.length; i++) {
    if ((probs[i] > 0.5 ? 1 : 0) === ys[i]) c++;
    L += ll(probs[i], ys[i]); B += (probs[i] - ys[i]) ** 2;
  }
  return { n: probs.length, accuracy: c / probs.length, logloss: L / probs.length, brier: B / probs.length };
}

// ── Market: de-vigged closing consensus per fight id ──────────────────────
const implied = american => (american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100));
function buildMarket(oddsRows) {
  // one line per (fight, bookmaker): prefer line_type 'closing', else the latest recorded_at
  const best = new Map();
  const isClosing = o => o.line_type === 'closing';
  for (const o of oddsRows) {
    if (o.fighter1_odds == null || o.fighter2_odds == null) continue;
    const key = `${o.fight_id}|${o.bookmaker}`;
    const cur = best.get(key);
    const better = !cur
      || (isClosing(o) && !isClosing(cur))
      || (isClosing(o) === isClosing(cur) && (o.recorded_at || '') > (cur.recorded_at || ''));
    if (better) best.set(key, o);
  }
  const byFight = new Map(); // fight_id -> {p1, books}
  for (const o of best.values()) {
    const i1 = implied(o.fighter1_odds), i2 = implied(o.fighter2_odds);
    const p1 = i1 / (i1 + i2); // proportional de-vig
    if (!byFight.has(o.fight_id)) byFight.set(o.fight_id, { sum: 0, n: 0 });
    const m = byFight.get(o.fight_id); m.sum += p1; m.n++;
  }
  const out = new Map();
  for (const [fid, m] of byFight) out.set(fid, { p1: m.sum / m.n, books: m.n });
  return out;
}

// ── Folds ─────────────────────────────────────────────────────────────────
function runFolds(rows, names, market, { quiet = false } = {}) {
  const folds = [];
  const pooled = { p: [], y: [], z: [], rows: [] };
  for (let year = FROM; year <= TO; year++) {
    const lo = `${year}-01-01`, hi = `${year + 1}-01-01`;
    const train = rows.filter(r => r.date < lo);
    const test = rows.filter(r => r.date >= lo && r.date < hi && r.minPriorStats >= SCORE_MIN_PRIOR);
    if (!train.length || !test.length) continue;
    const fit = fitAndScore(train, test, names);
    const fold = { year, nTrain: train.length, nTest: test.length,
      model: { accuracy: fit.metrics.accuracy, logloss: fit.metrics.logloss, brier: fit.metrics.brier },
      baselines: {}, market: null, fit };
    if (!quiet) {
      for (const [label, set] of Object.entries(BASELINE_SETS)) {
        const bf = fitAndScore(train, test, set);
        fold.baselines[label] = { accuracy: bf.metrics.accuracy, logloss: bf.metrics.logloss };
      }
      if (market && market.size) {
        const mp = [], my = [], modelP = [];
        test.forEach((r, i) => {
          const m = market.get(r.fightId); if (!m) return;
          mp.push(r.flip ? 1 - m.p1 : m.p1); my.push(r.y); modelP.push(fit.probs[i]);
        });
        if (mp.length) fold.market = { n: mp.length, market: scoreSubset(mp, my), modelOnSubset: scoreSubset(modelP, my) };
      }
    }
    test.forEach((r, i) => { pooled.p.push(fit.probs[i]); pooled.y.push(r.y); pooled.z.push(fit.zmax[i]); pooled.rows.push(r); });
    folds.push(fold);
  }
  return { folds, pooled };
}

const mean = arr => arr.reduce((s, v) => s + v, 0) / (arr.length || 1);
const summarize = folds => ({
  meanLogloss: mean(folds.map(f => f.model.logloss)),
  meanAccuracy: mean(folds.map(f => f.model.accuracy)),
  meanBrier: mean(folds.map(f => f.model.brier)),
});

// KEEP/DROP rule shared by the feature gate and --baseline: candidate must lower
// mean fold log loss and may be worse in at most one fold.
function gate(candidateFolds, referenceFolds) {
  const ref = Object.fromEntries(referenceFolds.map(f => [f.year, f.model.logloss]));
  const paired = candidateFolds.filter(f => ref[f.year] != null);
  const deltas = paired.map(f => ({ year: f.year, delta: f.model.logloss - ref[f.year] }));
  const meanDelta = mean(deltas.map(d => d.delta));
  const worse = deltas.filter(d => d.delta > 0).length;
  return { deltas, meanDelta, worse, keep: meanDelta < 0 && worse <= 1 };
}

// ── Sanity set ────────────────────────────────────────────────────────────
function serveWith(model, a, b) {
  // model: { names, mu, sigma, w, b, cfg } over `names`; a/b are sideValues objects
  const full = diffVector(a, b);
  const idx = idxOf(model.names);
  const z = standardize(idx.map(k => full[k]), model.mu, model.sigma, model.cfg.clipZ);
  const contrib = z.map((v, j) => v * model.w[j]);
  const p = sigmoid(contrib.reduce((s, v) => s + v, model.b));
  const top = contrib.map((c, j) => ({ f: model.names[j], c })).sort((x, y) => Math.abs(y.c) - Math.abs(x.c))[0];
  return { p, zmax: Math.max(...z.map(Math.abs)), top };
}

function runSanity(timelines, fighterById, candidate, priors) {
  if (!fs.existsSync(SANITY_PATH)) return { skipped: `no ${path.basename(SANITY_PATH)}` };
  const { pairs } = JSON.parse(fs.readFileSync(SANITY_PATH, 'utf8'));
  const bySlug = new Map(Object.values(fighterById).map(f => [f.slug, f]));
  // the shipped model is served with ITS OWN config (stored in the file; Phase-0 files have none = raw)
  const shipped = fs.existsSync(MODEL_PATH) ? (() => {
    const m = require(MODEL_PATH);
    return { names: m.features, mu: m.mu, sigma: m.sigma, w: m.w, b: m.b, cfg: { ...DEFAULT_CONFIG, ...(m.config || {}) }, priors: m.priors || null };
  })() : null;
  const today = new Date().toISOString().slice(0, 10);
  // full career (no cutoff), decay measured back from today
  const vals = (f, model) => sideFeatures(timelines.get(f.id) || [], f, today, null, model.cfg, model.priors);
  const results = [];
  for (const pr of pairs) {
    const A = bySlug.get(pr.f1), B = bySlug.get(pr.f2);
    if (!A || !B) { results.push({ ...pr, missing: !A ? pr.f1 : pr.f2 }); continue; }
    const want = pr.expect === 'f2' ? 'f2' : 'f1';
    const one = model => {
      if (!model) return null;
      const s = serveWith(model, vals(A, model), vals(B, model));
      const pExp = want === 'f1' ? s.p : 1 - s.p;
      return { pExpected: pExp, pass: pExp >= pr.minProb, zmax: s.zmax, top: `${s.top.f}${s.top.c >= 0 ? '+' : ''}${s.top.c.toFixed(2)}` };
    };
    results.push({ ...pr, shipped: one(shipped), candidate: one(candidate) });
  }
  const tally = key => { const r = results.filter(x => x[key]); return { pass: r.filter(x => x[key].pass).length, total: r.length }; };
  return { results, shipped: shipped ? tally('shipped') : null, candidate: tally('candidate') };
}

// ── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  const cfgText = Object.entries(CFG).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ') || 'raw (Phase-0 behaviour)';
  console.log(`Predictor rolling-origin evaluation  folds ${FROM}..${TO}  features ${SELECTED.length}/${FEATURES.length}  min prior stats-fights ${MIN_PRIOR} (scored >= ${SCORE_MIN_PRIOR})\nconfig: ${cfgText}\n`);

  const [events, fights, fighters, oddsRows] = await Promise.all([
    loadAll('events', 'id, date'),
    loadAll('fights', FIGHT_COLS),
    loadAll('fighters', FIGHTER_COLS),
    loadAll('odds', 'fight_id, bookmaker, fighter1_odds, fighter2_odds, line_type, recorded_at'),
  ]);
  const { rows, timelines, fighterById, priors, skippedInexperienced } = buildDataset(fights, events, fighters, { minPriorStatsFights: MIN_PRIOR, cfg: CFG });
  const market = buildMarket(oddsRows);
  console.log(`Rows: ${rows.length} usable fights (skipped ${skippedInexperienced} with a side under ${MIN_PRIOR} prior stats-fights)  |  market lines on ${market.size} fights`);

  // ── Main run
  const { folds, pooled } = runFolds(rows, SELECTED, market);
  if (!folds.length) { console.error('No folds had both train and test rows.'); process.exit(1); }
  const summary = summarize(folds);

  console.log('\n======== FOLDS (train on everything before the year, test on the year) ========');
  console.log('year | train | test |  acc   logloss  brier | win_rate   age    wr+age  (logloss) | market n  market  model');
  for (const f of folds) {
    const b = f.baselines;
    const mk = f.market ? `${String(f.market.n).padStart(6)}  ${f4(f.market.market.logloss)}  ${f4(f.market.modelOnSubset.logloss)}` : '     —  (no odds)';
    console.log(`${f.year} | ${String(f.nTrain).padStart(5)} | ${String(f.nTest).padStart(4)} | ${pct(f.model.accuracy)}  ${f4(f.model.logloss)}  ${f4(f.model.brier)} | ${f4(b['win_rate only'].logloss)}  ${f4(b['age only'].logloss)}  ${f4(b['win_rate+age'].logloss)}           | ${mk}`);
  }
  const bl = label => f4(mean(folds.map(f => f.baselines[label].logloss)));
  console.log(`mean | ${' '.repeat(5)} | ${' '.repeat(4)} | ${pct(summary.meanAccuracy)}  ${f4(summary.meanLogloss)}  ${f4(summary.meanBrier)} | ${bl('win_rate only')}  ${bl('age only')}  ${bl('win_rate+age')}`);

  const pooledScore = scoreSubset(pooled.p, pooled.y);
  console.log(`\nPooled over ${pooledScore.n} test fights: acc ${pct(pooledScore.accuracy)}  logloss ${f4(pooledScore.logloss)}  brier ${f4(pooledScore.brier)}   (coin flip: 50.0% / 0.6931)`);
  const bAcc = label => pct(mean(folds.map(f => f.baselines[label].accuracy)));
  console.log(`Baseline mean accuracy: win_rate ${bAcc('win_rate only')}  age ${bAcc('age only')}  win_rate+age ${bAcc('win_rate+age')}`);

  // market pooled
  const mFolds = folds.filter(f => f.market);
  let marketPooled = null;
  if (mFolds.length) {
    const mp = [], my = [], mm = [];
    // pooled market comparison from rows (same subset for both)
    pooled.rows.forEach((r, i) => { const m = market.get(r.fightId); if (!m) return; mp.push(r.flip ? 1 - m.p1 : m.p1); my.push(r.y); mm.push(pooled.p[i]); });
    marketPooled = { n: mp.length, market: scoreSubset(mp, my), model: scoreSubset(mm, my) };
    console.log(`Market (de-vigged closing consensus) on ${mp.length} fights: market acc ${pct(marketPooled.market.accuracy)} logloss ${f4(marketPooled.market.logloss)}  |  model on same fights: acc ${pct(marketPooled.model.accuracy)} logloss ${f4(marketPooled.model.logloss)}`);
  } else {
    console.log('Market baseline: SKIPPED — no odds matched to test fights (odds table has ' + oddsRows.length + ' rows).');
  }

  // calibration + confidence (pooled)
  const bins = Array.from({ length: 10 }, () => ({ n: 0, p: 0, y: 0 }));
  const conf = { high: { n: 0, c: 0 }, medium: { n: 0, c: 0 }, low: { n: 0, c: 0 } };
  const extreme = { n: 0, c: 0, L: 0 };
  pooled.p.forEach((p, i) => {
    const y = pooled.y[i], r = pooled.rows[i];
    const bi = Math.min(9, Math.floor(p * 10)); bins[bi].n++; bins[bi].p += p; bins[bi].y += y;
    const hit = (p > 0.5 ? 1 : 0) === y;
    const pd = Math.abs(2 * p - 1);
    const label = r.minPriorStats < 2 ? 'low' : pd > 0.25 ? 'high' : pd > 0.12 ? 'medium' : 'low';
    conf[label].n++; if (hit) conf[label].c++;
    if (pooled.z[i] > 3) { extreme.n++; if (hit) extreme.c++; extreme.L += ll(p, y); }
  });
  console.log('\nCalibration (pooled):  bin | n | mean predicted | actual');
  bins.forEach((b, i) => b.n && console.log(`  ${(i / 10).toFixed(1)}-${((i + 1) / 10).toFixed(1)} | ${String(b.n).padStart(4)} | ${pct(b.p / b.n)} | ${pct(b.y / b.n)}`));
  console.log('Confidence label (predictionEngine rule) -> accuracy: ' +
    Object.entries(conf).map(([k, v]) => `${k} ${v.n} fights ${pct(v.n ? v.c / v.n : null)}`).join('  |  '));
  console.log(`Rows with a standardized feature beyond ±3: ${extreme.n} (${(100 * extreme.n / pooled.p.length).toFixed(1)}%)  acc ${pct(extreme.n ? extreme.c / extreme.n : null)}  logloss ${f4(extreme.n ? extreme.L / extreme.n : null)}`);

  // ── Sanity set (candidate = this feature set fit on ALL rows)
  let sanity = null;
  if (SANITY) {
    const all = fitAndScore(rows, [], SELECTED);
    const candidate = { names: SELECTED, mu: all.mu, sigma: all.sigma, w: all.w, b: all.b, cfg: CFG, priors };
    sanity = runSanity(timelines, fighterById, candidate, priors);
    if (sanity.skipped) console.log(`\nSanity set: skipped (${sanity.skipped})`);
    else {
      console.log(`\n======== SANITY SET  shipped ${path.basename(MODEL_PATH)} ${sanity.shipped ? `${sanity.shipped.pass}/${sanity.shipped.total}` : 'n/a'}   candidate ${sanity.candidate.pass}/${sanity.candidate.total} ========`);
      console.log('shipped  candidate | need  | matchup (expected side first)');
      for (const r of sanity.results) {
        if (r.missing) { console.log(`   —        —     |  —    | ${r.f1} vs ${r.f2}: MISSING ${r.missing}`); continue; }
        const cell = x => (x ? `${x.pass ? 'ok ' : 'XX '}${pct(x.pExpected)}` : '    —    ');
        const first = r.expect === 'f2' ? r.f2 : r.f1, second = r.expect === 'f2' ? r.f1 : r.f2;
        console.log(`${cell(r.shipped)}  ${cell(r.candidate)} | ${pct(r.minProb)} | ${first} vs ${second}  [${r.note}]  z${r.candidate.zmax.toFixed(1)} ${r.candidate.top}`);
      }
    }
  }

  // ── Feature gate (leave-one-out)
  let ablation = null;
  if (ABLATE) {
    console.log(`\n======== FEATURE GATE (leave-one-out, ${SELECTED.length} features x ${folds.length} folds) ========`);
    console.log('feature              | Δ mean logloss if REMOVED | folds hurt by removal | verdict');
    ablation = [];
    for (const feat of SELECTED) {
      const without = SELECTED.filter(f => f !== feat);
      if (!without.length) continue;
      const r = runFolds(rows, without, null, { quiet: true });
      // candidate = WITH the feature (main run) vs reference = WITHOUT it
      const g = gate(folds, r.folds);
      const row = { feature: feat, deltaIfRemoved: -g.meanDelta, foldsWorseWith: g.worse, keep: g.keep };
      ablation.push(row);
      console.log(`${feat.padEnd(20)} | ${(row.deltaIfRemoved >= 0 ? '+' : '') + row.deltaIfRemoved.toFixed(4).padStart(8)}                  | ${String(folds.length - g.worse).padStart(2)}/${folds.length}                 | ${g.keep ? 'KEEP' : 'DROP candidate'}`);
    }
    console.log('KEEP = including it lowers mean fold logloss and hurts at most one fold.');
  }

  // ── Compare with a saved report
  let comparison = null;
  if (BASELINE) {
    const ref = JSON.parse(fs.readFileSync(BASELINE, 'utf8'));
    const g = gate(folds, ref.folds);
    comparison = { baseline: BASELINE, baselineFeatures: ref.features, ...g };
    console.log(`\n======== VS BASELINE ${BASELINE} (${ref.features.length} features, generated ${ref.generatedAt}) ========`);
    for (const d of g.deltas) console.log(`  ${d.year}: ${d.delta >= 0 ? '+' : ''}${d.delta.toFixed(4)} logloss`);
    console.log(`  mean Δ ${g.meanDelta >= 0 ? '+' : ''}${g.meanDelta.toFixed(4)}  worse in ${g.worse}/${g.deltas.length} folds  ->  ${g.keep ? 'KEEP (passes the gate)' : 'DOES NOT pass the gate'}`);
  }

  // ── Report
  if (OUT) {
    const report = {
      generatedAt: new Date().toISOString(), from: FROM, to: TO, minPriorStatsFights: MIN_PRIOR, scoreMinPrior: SCORE_MIN_PRIOR,
      config: CFG, features: SELECTED, rows: rows.length,
      folds: folds.map(({ fit, ...f }) => f),
      summary, pooled: pooledScore, marketPooled,
      calibration: bins.map((b, i) => ({ bin: i, n: b.n, predicted: b.n ? b.p / b.n : null, actual: b.n ? b.y / b.n : null })),
      confidence: conf,
      sanity: sanity && !sanity.skipped ? { shipped: sanity.shipped, candidate: sanity.candidate, results: sanity.results } : null,
      ablation, comparison,
    };
    fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
    console.log(`\nReport written to ${OUT}`);
  }
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });

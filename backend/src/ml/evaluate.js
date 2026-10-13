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
 *   - market: de-vigged closing consensus (BestFightOdds lines file, else the
 *     odds table) on the fights that have one, with the model scored on that
 *     same subset (skipped and said so when no lines match)
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
 *   --elo-k K                Elo step (default 40)
 *   --elo-finish M           Elo K multiplier for KO/SUB wins (default 1)
 *   --elo-dec MODE           decision-win weighting: none | method | cards | score (default none)
 *   --elo-dec-floor F        weight of the least convincing decision (default 0.5)
 *   --elo-dec-cap C          weight of a shutout decision (default 1)
 *   --model logistic|gbm     model family (baselines stay logistic)
 *   --l2 X                   logistic L2 penalty (default 0.001)
 *   --gbm-rounds N --gbm-depth D --gbm-lr X --gbm-l2 X --gbm-min-leaf N --gbm-subsample F
 *   --ablate                 leave-one-out feature gate (slow: folds x features fits)
 *   --out PATH               write the JSON report
 *   --baseline PATH          compare against a saved report
 *   --no-sanity              skip the sanity set
 *   --market PATH            closing-lines file (default src/ml/data/market-lines.json,
 *                            from scrapers/bestfightodds-lines.js) · --no-market
 *
 * MARKET: the de-vigged closing consensus is scored on the test fights that
 * have a line, with the model and a 50/50 logit blend on the same fights, plus
 * flat-stake ROI (1 unit whenever model probability × decimal close > 1) at the
 * consensus close and at the best available close, with a bootstrap 95% CI.
 * These lines are for internal benchmarking only and are never served.
 *
 * Writes NOTHING to the database and never touches the model file.
 * Run: node -r dotenv/config src/ml/evaluate.js [flags]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { loadAll, loadShortNotice, loadDwcs, sigmoid, trainLogistic, evaluate, buildDataset, sideFeatures, FIGHT_COLS, FIGHTER_COLS, MIN_PRIOR_STATS_FIGHTS } = require('./trainModel');
const { FEATURES, DEFAULT_CONFIG, diffVector, standardize, careerContext } = require('./features');
const { computeElo, eloOptions } = require('./eloEngine');
const { applySizePrior } = require('./sizePrior');
const { trainGBM, predictGBM } = require('./gbm');

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
  eloK: parseFloat(opt('elo-k', String(DEFAULT_CONFIG.eloK))),
  eloFinishMult: parseFloat(opt('elo-finish', String(DEFAULT_CONFIG.eloFinishMult))),
  eloDecision: opt('elo-dec', DEFAULT_CONFIG.eloDecision),
  eloDecisionFloor: parseFloat(opt('elo-dec-floor', String(DEFAULT_CONFIG.eloDecisionFloor))),
  eloDecisionCap: parseFloat(opt('elo-dec-cap', String(DEFAULT_CONFIG.eloDecisionCap))),
};
const ABLATE = flag('ablate');
// Model family. The baselines (win_rate / age) are always logistic.
const MODEL_KIND = opt('model', 'logistic');
if (!['logistic', 'gbm'].includes(MODEL_KIND)) { console.error('--model must be logistic or gbm'); process.exit(1); }
const LOGIT_L2 = parseFloat(opt('l2', '0.001'));
const GBM_OPTS = {
  rounds: parseInt(opt('gbm-rounds', '300')), depth: parseInt(opt('gbm-depth', '3')), lr: parseFloat(opt('gbm-lr', '0.05')),
  l2: parseFloat(opt('gbm-l2', '5')), minLeaf: parseFloat(opt('gbm-min-leaf', '20')), subsample: parseFloat(opt('gbm-subsample', '0.8')),
};
const OUT = opt('out', null);
const BASELINE = opt('baseline', null);
// Closing lines for the market baseline (written by scrapers/bestfightodds-lines.js; internal only)
const MARKET_PATH = flag('no-market') ? null : opt('market', path.join(__dirname, 'data', 'market-lines.json'));
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
function fitAndScore(train, test, names, kind = MODEL_KIND) {
  const idx = idxOf(names), d = idx.length;
  // zero-centred standardization (mu = 0, sigma = RMS) — see trainModel.fit
  const mu = new Array(d).fill(0), sigma = new Array(d).fill(0);
  for (const r of train) for (let j = 0; j < d; j++) sigma[j] += r.x[idx[j]] ** 2 / train.length;
  for (let j = 0; j < d; j++) sigma[j] = Math.sqrt(sigma[j]) || 1;
  const std = r => standardize(idx.map(k => r.x[k]), mu, sigma, CFG.clipZ);
  const Xtr = train.map(std), ytr = train.map(r => r.y);
  const Xte = test.map(std), yte = test.map(r => r.y);
  const zmax = Xte.map(x => Math.max(...x.map(Math.abs)));
  if (kind === 'gbm') {
    const gbm = trainGBM(Xtr, ytr, GBM_OPTS);
    const probs = Xte.map(x => predictGBM(gbm, x).p);
    const metrics = test.length ? { ...scoreSubset(probs, yte), calibration: null } : null;
    return { metrics, probs, zmax, w: null, b: null, mu, sigma, names, gbm };
  }
  const { w, b } = trainLogistic(Xtr, ytr, { l2: LOGIT_L2 });
  const metrics = test.length ? evaluate(Xte, yte, w, b) : null;
  const probs = Xte.map(x => sigmoid(x.reduce((s, v, j) => s + v * w[j], b)));
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
// Entry per fight (oriented to DB fighter1): { p1 (de-vigged), i1, i2 (implied
// WITH vig at the consensus close = the price a flat-stake bettor pays),
// best1, best2 (best available decimal price at close, when a range is known) }
const implied = american => (american > 0 ? 100 / (american + 100) : Math.abs(american) / (Math.abs(american) + 100));
function buildMarket(oddsRows, lines) {
  const out = new Map();
  // 1) BestFightOdds lines file (src/scrapers/bestfightodds-lines.js): closing range per side.
  //    Consensus implied = mean of implied(closeMin), implied(closeMax); best price = the lower implied.
  for (const [fid, L] of Object.entries(lines || {})) {
    const side = s => { const v = [s.closeMin, s.closeMax].filter(x => x != null).map(implied); return v.length ? { mean: v.reduce((a, b) => a + b, 0) / v.length, best: Math.min(...v) } : null; };
    const a = side(L.f1), b = side(L.f2);
    if (!a || !b) continue;
    out.set(fid, { p1: a.mean / (a.mean + b.mean), i1: a.mean, i2: b.mean, best1: 1 / a.best, best2: 1 / b.best, source: 'bfo' });
  }
  // 2) odds table (live sync), one line per (fight, bookmaker): prefer 'closing', else latest; averaged across books.
  const best = new Map();
  const isClosing = o => o.line_type === 'closing';
  for (const o of oddsRows || []) {
    if (o.fighter1_odds == null || o.fighter2_odds == null || out.has(o.fight_id)) continue;
    const key = `${o.fight_id}|${o.bookmaker}`;
    const cur = best.get(key);
    const better = !cur
      || (isClosing(o) && !isClosing(cur))
      || (isClosing(o) === isClosing(cur) && (o.recorded_at || '') > (cur.recorded_at || ''));
    if (better) best.set(key, o);
  }
  const byFight = new Map();
  for (const o of best.values()) {
    const i1 = implied(o.fighter1_odds), i2 = implied(o.fighter2_odds);
    if (!byFight.has(o.fight_id)) byFight.set(o.fight_id, { s1: 0, s2: 0, n: 0, b1: 0, b2: 0 });
    const m = byFight.get(o.fight_id); m.s1 += i1; m.s2 += i2; m.n++; m.b1 = Math.max(m.b1, 1 / i1); m.b2 = Math.max(m.b2, 1 / i2);
  }
  for (const [fid, m] of byFight) {
    const i1 = m.s1 / m.n, i2 = m.s2 / m.n;
    out.set(fid, { p1: i1 / (i1 + i2), i1, i2, best1: m.b1, best2: m.b2, source: `odds-table(${m.n})` });
  }
  return out;
}

// Flat-stake betting against the closing price: 1 unit on a side whenever the
// model's probability times the decimal price exceeds 1 + edge (positive EV
// after the vig). `price` = 'consensus' (pay the mean close) or 'best' (best
// available close). Returns per-bet profits so callers can bootstrap.
function flatStake(items, { edge = 0, price = 'consensus' } = {}) {
  const profits = [];
  for (const it of items) {
    const dA = price === 'best' ? it.bestA : 1 / it.iA, dB = price === 'best' ? it.bestB : 1 / it.iB;
    const evA = it.pModel * dA - 1, evB = (1 - it.pModel) * dB - 1;
    if (evA <= edge && evB <= edge) continue;
    const onA = evA >= evB;
    const won = onA ? it.y === 1 : it.y === 0;
    profits.push(won ? (onA ? dA : dB) - 1 : -1);
  }
  const units = profits.reduce((s, v) => s + v, 0);
  return { bets: profits.length, units, roi: profits.length ? units / profits.length : null, profits };
}
function bootstrapRoi(profits, reps = 2000, seed = 11) {
  if (profits.length < 10) return null;
  let a = seed >>> 0; const rand = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const rois = [];
  for (let r = 0; r < reps; r++) { let s = 0; for (let i = 0; i < profits.length; i++) s += profits[Math.floor(rand() * profits.length)]; rois.push(s / profits.length); }
  rois.sort((x, y) => x - y);
  return { lo: rois[Math.floor(0.025 * reps)], hi: rois[Math.floor(0.975 * reps)] };
}
// Items for the market comparison on a set of rows (oriented to the row's A side).
function marketItems(rows, probs, market) {
  const items = [];
  rows.forEach((r, i) => {
    const m = market.get(r.fightId); if (!m) return;
    items.push({ y: r.y, pModel: probs[i], pMarket: r.flip ? 1 - m.p1 : m.p1,
      iA: r.flip ? m.i2 : m.i1, iB: r.flip ? m.i1 : m.i2, bestA: r.flip ? m.best2 : m.best1, bestB: r.flip ? m.best1 : m.best2, year: r.date.slice(0, 4) });
  });
  return items;
}
const logit = p => Math.log(p / (1 - p));
function marketSummary(items) {
  if (!items.length) return null;
  const y = items.map(it => it.y);
  const blend = items.map(it => sigmoid(0.5 * logit(Math.min(1 - 1e-6, Math.max(1e-6, it.pModel))) + 0.5 * logit(it.pMarket)));
  const consensus = flatStake(items), best = flatStake(items, { price: 'best' }), edge5 = flatStake(items, { edge: 0.05 });
  const marketFav = flatStake(items.map(it => ({ ...it, pModel: it.pMarket })), {}); // sanity: betting the market's own numbers
  return {
    n: items.length,
    market: scoreSubset(items.map(it => it.pMarket), y), model: scoreSubset(items.map(it => it.pModel), y), blend: scoreSubset(blend, y),
    agree: items.filter(it => (it.pModel > 0.5) === (it.pMarket > 0.5)).length / items.length,
    roi: {
      consensus: { bets: consensus.bets, units: consensus.units, roi: consensus.roi, ci95: bootstrapRoi(consensus.profits) },
      best: { bets: best.bets, units: best.units, roi: best.roi, ci95: bootstrapRoi(best.profits) },
      edge5: { bets: edge5.bets, units: edge5.units, roi: edge5.roi, ci95: bootstrapRoi(edge5.profits) },
      marketOwn: { bets: marketFav.bets, units: marketFav.units, roi: marketFav.roi },
    },
  };
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
        const bf = fitAndScore(train, test, set, 'logistic');
        fold.baselines[label] = { accuracy: bf.metrics.accuracy, logloss: bf.metrics.logloss };
      }
      if (market && market.size) {
        const s = marketSummary(marketItems(test, fit.probs, market));
        if (s) fold.market = { n: s.n, market: s.market, modelOnSubset: s.model, blend: s.blend, agree: s.agree, roi: s.roi };
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
  // model: { names, mu, sigma, w, b, cfg } over `names` (or { gbm }); a/b are sideValues objects
  const full = diffVector(a, b);
  const idx = idxOf(model.names);
  const z = standardize(idx.map(k => full[k]), model.mu, model.sigma, model.cfg.clipZ);
  if (model.gbm) return { p: predictGBM(model.gbm, z).p, zmax: Math.max(...z.map(Math.abs)), top: { f: 'gbm', c: 0 } };
  const contrib = z.map((v, j) => v * model.w[j]);
  const p = sigmoid(contrib.reduce((s, v) => s + v, model.b));
  const top = contrib.map((c, j) => ({ f: model.names[j], c })).sort((x, y) => Math.abs(y.c) - Math.abs(x.c))[0];
  return { p, zmax: Math.max(...z.map(Math.abs)), top };
}

function runSanity(timelines, fighterById, candidate, fights, events, limitByWc = {}) {
  if (!fs.existsSync(SANITY_PATH)) return { skipped: `no ${path.basename(SANITY_PATH)}` };
  const { pairs } = JSON.parse(fs.readFileSync(SANITY_PATH, 'utf8'));
  const bySlug = new Map(Object.values(fighterById).map(f => [f.slug, f]));
  // the shipped model is served with ITS OWN config (stored in the file; Phase-0 files have none = raw)
  const shipped = fs.existsSync(MODEL_PATH) ? (() => {
    const m = require(MODEL_PATH);
    const cfg = { ...DEFAULT_CONFIG, ...(m.config || {}) };
    const eventById = Object.fromEntries(events.map(e => [e.id, e]));
    const elo = m.features.some(f => f.startsWith('elo') || f === 'sos') ? computeElo(fights, eventById, eloOptions(cfg)) : null;
    return { names: m.features, mu: m.mu, sigma: m.sigma, w: m.w, b: m.b, cfg, priors: m.priors || null, elo };
  })() : null;
  const today = new Date().toISOString().slice(0, 10);
  // Bout context as the Predict page derives it when no weight is given: the
  // bout is in the HEAVIER fighter's natural division (modal weight class over
  // the full career; the smaller fighter moves up), 3 rounds.
  const boutFor = (f, g) => {
    const wcOf = x => careerContext(timelines.get(x.id) || [], today, null, limitByWc).modalWeightClassId;
    const w1 = wcOf(f), w2 = wcOf(g);
    const l1 = w1 != null ? limitByWc[w1] ?? -1 : -1, l2 = w2 != null ? limitByWc[w2] ?? -1 : -1;
    const wc = l2 > l1 ? w2 : (w1 ?? w2);
    return { scheduledRounds: 3, weightClassId: wc, limitLbs: wc != null ? (limitByWc[wc] ?? null) : null };
  };
  // full career (no cutoff), decay measured back from today
  const vals = (f, model, bout) => sideFeatures(timelines.get(f.id) || [], f, today, null, model.cfg, model.priors, model.elo, bout, limitByWc);
  const results = [];
  for (const pr of pairs) {
    const A = bySlug.get(pr.f1), B = bySlug.get(pr.f2);
    if (!A || !B) { results.push({ ...pr, missing: !A ? pr.f1 : pr.f2 }); continue; }
    const want = pr.expect === 'f2' ? 'f2' : 'f1';
    const bout = boutFor(A, B);
    // The size prior (sizePrior.js) is applied here exactly as the engine
    // applies it at serving time. It never touches the fold evaluation above.
    const one = model => {
      if (!model) return null;
      const va = vals(A, model, bout), vb = vals(B, model, bout);
      const s = serveWith(model, va, vb);
      const size = applySizePrior(s.p, va.natural_limit, vb.natural_limit, bout.limitLbs);
      const pExp = want === 'f1' ? size.p : 1 - size.p;
      const skillExp = want === 'f1' ? s.p : 1 - s.p;
      return { pExpected: pExp, pass: pExp >= pr.minProb, zmax: s.zmax, top: `${s.top.f}${s.top.c >= 0 ? '+' : ''}${s.top.c.toFixed(2)}`, sizeGap: size.gap, skillOnly: skillExp };
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
  const modelText = MODEL_KIND === 'gbm' ? `gbm ${JSON.stringify(GBM_OPTS)}` : `logistic l2=${LOGIT_L2}`;
  console.log(`Predictor rolling-origin evaluation  folds ${FROM}..${TO}  features ${SELECTED.length}/${FEATURES.length}  min prior stats-fights ${MIN_PRIOR} (scored >= ${SCORE_MIN_PRIOR})\nmodel: ${modelText}\nconfig: ${cfgText}\n`);

  const [events, fights, fighters, oddsRows, weightClasses] = await Promise.all([
    loadAll('events', 'id, date'),
    loadAll('fights', FIGHT_COLS),
    loadAll('fighters', FIGHTER_COLS),
    loadAll('odds', 'fight_id, bookmaker, fighter1_odds, fighter2_odds, line_type, recorded_at'),
    loadAll('weight_classes', 'id, name, limit_lbs'),
  ]);
  const { rows, timelines, fighterById, priors, elo, limitByWc, skippedInexperienced, imputedWc, missingWc } = buildDataset(fights, events, fighters, { minPriorStatsFights: MIN_PRIOR, cfg: CFG, weightClasses, shortNotice: await loadShortNotice(), dwcs: await loadDwcs() });
  const lines = MARKET_PATH && fs.existsSync(MARKET_PATH) ? JSON.parse(fs.readFileSync(MARKET_PATH, 'utf8')) : null;
  const market = buildMarket(oddsRows, lines);
  { // late-replacement coverage and raw win rates (fight_replacements table)
    const isRep = (v, maxDays) => v.replacement === 1 && (maxDays == null || (v.notice_days != null && v.notice_days <= maxDays));
    const side = (r, maxDays) => (isRep(r.a, maxDays) && !isRep(r.b) ? 'a' : isRep(r.b, maxDays) && !isRep(r.a) ? 'b' : null);
    const tally = maxDays => { let n = 0, w = 0; for (const r of rows) { const s = side(r, maxDays); if (!s) continue; n++; if ((s === 'a') === (r.y === 1)) w++; } return n ? `${n} fights, wins ${pct(w / n)}` : 'none'; };
    console.log(`Short-notice data (fight_replacements): replacement ${tally(null)}  |  notice_days <= 21 (unknown timing counts as 21) ${tally(21)}`);
  }
  console.log(`Rows: ${rows.length} usable fights (skipped ${skippedInexperienced} with a side under ${MIN_PRIOR} prior stats-fights)  |  market lines on ${market.size} fights (${lines ? Object.keys(lines).length + ' from ' + path.basename(MARKET_PATH) : 'no lines file'}, odds table ${oddsRows.length} rows)  |  bout weight class imputed ${imputedWc}, unknown ${missingWc}`);

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

  // market pooled (same subset for market and model)
  const mFolds = folds.filter(f => f.market);
  let marketPooled = null;
  if (mFolds.length) {
    marketPooled = marketSummary(marketItems(pooled.rows, pooled.p, market));
    const mp = marketPooled;
    const roiLine = (label, r) => `  ${label.padEnd(22)} bets ${String(r.bets).padStart(5)}  units ${(r.units >= 0 ? '+' : '') + r.units.toFixed(1).padStart(7)}  ROI ${r.roi == null ? '  —  ' : ((r.roi >= 0 ? '+' : '') + (100 * r.roi).toFixed(1) + '%')}${r.ci95 ? `  95% CI [${(100 * r.ci95.lo).toFixed(1)}%, ${(100 * r.ci95.hi).toFixed(1)}%]` : ''}`;
    console.log(`\n======== MARKET (de-vigged BestFightOdds closing consensus) on ${mp.n} test fights ========`);
    console.log(`market: acc ${pct(mp.market.accuracy)} logloss ${f4(mp.market.logloss)} brier ${f4(mp.market.brier)}  |  model on the same fights: acc ${pct(mp.model.accuracy)} logloss ${f4(mp.model.logloss)} brier ${f4(mp.model.brier)}  |  Δ logloss model − market ${(mp.model.logloss - mp.market.logloss >= 0 ? '+' : '')}${(mp.model.logloss - mp.market.logloss).toFixed(4)}`);
    console.log(`50/50 logit blend of model and market: logloss ${f4(mp.blend.logloss)} (${mp.blend.logloss < mp.market.logloss ? 'model adds information beyond the market' : 'model adds nothing beyond the market'})  |  model and market pick the same side ${pct(mp.agree)} of the time`);
    console.log('Flat stake, 1 unit per bet, bet whenever model probability × decimal close > 1 (positive EV after vig):');
    console.log(roiLine('at consensus close', mp.roi.consensus));
    console.log(roiLine('at best available close', mp.roi.best));
    console.log(roiLine('edge ≥ 5% (consensus)', mp.roi.edge5));
    console.log(roiLine('market betting itself', mp.roi.marketOwn) + '   (sanity: should be ≈ 0 bets, or ≈ −vig)');
    // model vs market by prior UFC stats-fights of the THINNER side (0 = a debutant on the card)
    const bucketOf = n => (n === 0 ? '0' : n <= 2 ? '1-2' : n <= 5 ? '3-5' : '6+');
    const byExp = {};
    pooled.rows.forEach((r, i) => {
      const m = market.get(r.fightId); if (!m) return;
      const pMarket = r.flip ? 1 - m.p1 : m.p1;
      const key = bucketOf(Math.min(r.priorA, r.priorB));
      const o = byExp[key] || (byExp[key] = { n: 0, Lm: 0, Lk: 0, cm: 0, ck: 0 });
      o.n++; o.Lm += ll(pooled.p[i], r.y); o.Lk += ll(pMarket, r.y);
      if ((pooled.p[i] > 0.5 ? 1 : 0) === r.y) o.cm++; if ((pMarket > 0.5 ? 1 : 0) === r.y) o.ck++;
    });
    console.log('\nmodel vs market by prior UFC stats-fights of the thinner side:  bucket |    n | market ll | model ll |   Δ     | market acc | model acc');
    for (const k of ['0', '1-2', '3-5', '6+']) { const o = byExp[k]; if (!o) continue;
      const d = o.Lm / o.n - o.Lk / o.n;
      console.log(`  ${k.padStart(6)} | ${String(o.n).padStart(4)} |   ${f4(o.Lk / o.n)}  |  ${f4(o.Lm / o.n)}  | ${d >= 0 ? '+' : ''}${d.toFixed(4)} |   ${pct(o.ck / o.n)}   |  ${pct(o.cm / o.n)}`); }
    marketPooled.byExperience = Object.fromEntries(Object.entries(byExp).map(([k, o]) => [k, { n: o.n, market: o.Lk / o.n, model: o.Lm / o.n, marketAcc: o.ck / o.n, modelAcc: o.cm / o.n }]));
    console.log('per fold: year    n   market   model   blend  | ROI@consensus (bets)  ROI@best (bets)');
    for (const f of mFolds) console.log(`          ${f.year} ${String(f.market.n).padStart(5)}   ${f4(f.market.market.logloss)}  ${f4(f.market.modelOnSubset.logloss)}  ${f4(f.market.blend.logloss)}  | ${((f.market.roi.consensus.roi || 0) * 100).toFixed(1).padStart(6)}% (${f.market.roi.consensus.bets})   ${((f.market.roi.best.roi || 0) * 100).toFixed(1).padStart(6)}% (${f.market.roi.best.bets})`);
  } else {
    console.log('Market baseline: SKIPPED — no odds matched to test fights (lines file ' + (lines ? Object.keys(lines).length : 0) + ' fights, odds table ' + oddsRows.length + ' rows).');
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
    const candidate = { names: SELECTED, mu: all.mu, sigma: all.sigma, w: all.w, b: all.b, gbm: all.gbm || null, cfg: CFG, priors, elo };
    sanity = runSanity(timelines, fighterById, candidate, fights, events, limitByWc);
    if (sanity.skipped) console.log(`\nSanity set: skipped (${sanity.skipped})`);
    else {
      console.log(`\n======== SANITY SET  shipped ${path.basename(MODEL_PATH)} ${sanity.shipped ? `${sanity.shipped.pass}/${sanity.shipped.total}` : 'n/a'}   candidate ${sanity.candidate.pass}/${sanity.candidate.total} ========`);
      console.log('shipped  candidate | need  | matchup (expected side first)');
      for (const r of sanity.results) {
        if (r.missing) { console.log(`   —        —     |  —    | ${r.f1} vs ${r.f2}: MISSING ${r.missing}`); continue; }
        const cell = x => (x ? `${x.pass ? 'ok ' : 'XX '}${pct(x.pExpected)}` : '    —    ');
        const first = r.expect === 'f2' ? r.f2 : r.f1, second = r.expect === 'f2' ? r.f1 : r.f2;
        const sizeNote = r.candidate.sizeGap >= 2 ? `  size prior: ${r.candidate.sizeGap} divisions, skill-only ${pct(r.candidate.skillOnly)}` : '';
        console.log(`${cell(r.shipped)}  ${cell(r.candidate)} | ${pct(r.minProb)} | ${first} vs ${second}  [${r.note}]  z${r.candidate.zmax.toFixed(1)} ${r.candidate.top}${sizeNote}`);
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
      model: MODEL_KIND, logitL2: LOGIT_L2, gbm: MODEL_KIND === 'gbm' ? GBM_OPTS : null,
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

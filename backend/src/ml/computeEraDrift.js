/**
 * computeEraDrift.js — estimate how much the UFC field improved over time and
 * write src/ml/data/era-drift.json, the table eraDrift.js serves for FANTASY
 * (cross-era) matchups. Run by hand; the file is committed so predictions are
 * stable between runs:
 *
 *   node -r dotenv/config src/ml/computeEraDrift.js [--reps N]
 *
 * WHAT IS IDENTIFIED. Ratings are relative to the field they were earned in.
 * Within any fight both fighters share the date, so results alone can never
 * separate "the field improved by X per year" from "every fighter declines X
 * per year faster": only era-to-era DIFFERENCES in drift are identified. The
 * LEVEL is pinned by an anchor assumption — true strength is flat at ages
 * 27–31 — and the output says so. Two further corrections:
 *   - inflation: the unified Glicko scale drifts (UFC field mean 1651 in 1995,
 *     ~2100 since 2010) because losers leave the pool below 1500. Ratings are
 *     measured RELATIVE to the field mean before anything else, and that field
 *     mean series is saved so eraDrift.js can re-base a rating onto another
 *     date's scale (a mechanical step, no anchor involved).
 *   - selection / rating-system artifacts give negative "the field got weaker"
 *     readings in some eras. Policy (agreed 2026-10-16): the served drift is
 *     the mean of the Glicko and UFC-Elo estimates, zero where their signs
 *     disagree, floored at zero. In practice only 1999–2001 survives.
 *
 * METHODS (all on consecutive-UFC-bout intervals per fighter, relative rating
 * change per year regressed on age bins + 3-year period bins, weighted by the
 * interval length):
 *   M1  unified Glicko-2 (glickoEngine.js, model config)   -> glicko, glicko_ci (fighter-cluster bootstrap, 90%)
 *   M2  UFC-only Elo (eloEngine.js, model config)          -> elo
 *   M3  bridge fighters (>= 8 UFC bouts over >= 6 years): decline beyond the
 *       M1 age curve, attributed to the periods they spanned -> bridge
 */
const fs = require('fs');
const path = require('path');
const { loadAll, loadSherdogHistory, FIGHT_COLS, FIGHTER_COLS } = require('./trainModel');
const { computeElo, eloOptions } = require('./eloEngine');
const { computeGlicko, glickoOptions } = require('./glickoEngine');
const { DEFAULT_CONFIG } = require('./features');

const OUT = path.join(__dirname, 'data', 'era-drift.json');
const MODEL = require(path.join(__dirname, 'model-v8.json'));
const CFG = { ...DEFAULT_CONFIG, ...(MODEL.config || {}) };
const argv = process.argv.slice(2);
const REPS = +(argv[argv.indexOf('--reps') + 1] || 200);

const AGE_BINS = [[0, 23], [23, 25], [25, 27], [27, 29], [29, 31], [31, 33], [33, 35], [35, 38], [38, 99]];
const ANCHOR = [27, 31];
const PERIODS = []; for (let y = 1993; y <= 2026; y += 3) PERIODS.push([y, Math.min(y + 3, 2027)]);
const yrs = (a, b) => (new Date(b) - new Date(a)) / (365.25 * 86400000);
const frac = d => { const x = new Date(d); return x.getFullYear() + (x.getMonth() + 0.5) / 12; };
const num = v => (typeof v === 'number' ? v : v.r);
const ageBin = a => AGE_BINS.findIndex(([lo, hi]) => a >= lo && a < hi);
const perBin = y => PERIODS.findIndex(([lo, hi]) => y >= lo && y < hi);

function wls(X, y, w, ridge = 1e-6) {
  const p = X[0].length, A = Array.from({ length: p }, () => new Array(p).fill(0)), c = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) { const xi = X[i], wi = w[i]; for (let a = 0; a < p; a++) { if (!xi[a]) continue; c[a] += wi * xi[a] * y[i]; for (let b = 0; b < p; b++) if (xi[b]) A[a][b] += wi * xi[a] * xi[b]; } }
  for (let a = 0; a < p; a++) A[a][a] += ridge;
  const n = p, M = A.map((r, i) => [...r, c[i]]);
  for (let i = 0; i < n; i++) { let piv = i; for (let r = i + 1; r < n; r++) if (Math.abs(M[r][i]) > Math.abs(M[piv][i])) piv = r; [M[i], M[piv]] = [M[piv], M[i]]; if (Math.abs(M[i][i]) < 1e-12) continue; for (let r = 0; r < n; r++) if (r !== i) { const f = M[r][i] / M[i][i]; for (let k = i; k <= n; k++) M[r][k] -= f * M[i][k]; } }
  return M.map((r, i) => (Math.abs(r[i]) < 1e-12 ? 0 : r[n] / r[i]));
}

// UFC field mean rating by year (bout-weighted mean of pre-bout ratings of UFC bouts in that year).
function fieldMeanByYear(history) {
  const acc = {};
  for (const h of history.values()) for (const e of h) { if (e.ufc === false) continue; const y = +e.date.slice(0, 4); (acc[y] ||= { s: 0, n: 0 }); acc[y].s += num(e.pre); acc[y].n++; }
  return Object.fromEntries(Object.entries(acc).filter(([, v]) => v.n >= 20).map(([y, v]) => [y, +(v.s / v.n).toFixed(1)]));
}
const meanAt = (byYear, t) => { // linear interpolation between mid-years, clamped
  const ys = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  if (t <= ys[0] + 0.5) return byYear[ys[0]]; if (t >= ys[ys.length - 1] + 0.5) return byYear[ys[ys.length - 1]];
  for (let i = 0; i + 1 < ys.length; i++) { const a = ys[i] + 0.5, b = ys[i + 1] + 0.5; if (t >= a && t <= b) return byYear[ys[i]] + (byYear[ys[i + 1]] - byYear[ys[i]]) * (t - a) / (b - a); }
  return byYear[ys[ys.length - 1]];
};

function intervals(history, fighters, byYear) {
  const rows = [];
  for (const [id, h] of history) {
    const f = fighters.get(id); if (!f?.date_of_birth) continue;
    const ufc = h.filter(e => e.ufc !== false);
    for (let k = 0; k + 1 < ufc.length; k++) {
      const dt = yrs(ufc[k].date, ufc[k + 1].date); if (dt <= 0 || dt > 4) continue;
      const t0 = frac(ufc[k].date), t1 = frac(ufc[k + 1].date);
      rows.push({ id, dr: (num(ufc[k + 1].post) - meanAt(byYear, t1)) - (num(ufc[k].post) - meanAt(byYear, t0)), dt, age: yrs(f.date_of_birth, ufc[k].date) + dt / 2, year: (t0 + t1) / 2 });
    }
  }
  return rows;
}
function fitRates(rows) {
  const p = AGE_BINS.length + PERIODS.length, X = [], y = [], w = [];
  for (const r of rows) { const a = ageBin(r.age), t = perBin(r.year); if (a < 0 || t < 0) continue; const x = new Array(p).fill(0); x[a] = 1; x[AGE_BINS.length + t] = 1; X.push(x); y.push(r.dr / r.dt); w.push(r.dt); }
  const b = wls(X, y, w, 1e-3);
  return { beta: b.slice(0, AGE_BINS.length), gamma: b.slice(AGE_BINS.length) };
}
function anchored(fit) {
  const idx = AGE_BINS.map((b, i) => (b[0] >= ANCHOR[0] && b[1] <= ANCHOR[1] ? i : -1)).filter(i => i >= 0);
  const shift = idx.reduce((s, i) => s + fit.beta[i], 0) / idx.length;
  return { beta: fit.beta.map(v => v - shift), drift: fit.gamma.map(v => -(v + shift)) };
}
function bootstrap(rows, reps) {
  const byId = new Map(); for (const r of rows) { if (!byId.has(r.id)) byId.set(r.id, []); byId.get(r.id).push(r); }
  const ids = [...byId.keys()], out = [];
  let seed = 7; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  for (let i = 0; i < reps; i++) { const s = []; for (let k = 0; k < ids.length; k++) s.push(...byId.get(ids[Math.floor(rnd() * ids.length)])); out.push(anchored(fitRates(s)).drift); }
  return PERIODS.map((_, t) => { const v = out.map(d => d[t]).sort((a, b) => a - b); return [v[Math.floor(0.05 * reps)], v[Math.min(reps - 1, Math.floor(0.95 * reps))]]; });
}

async function main() {
  const [events, fights, fightersRaw, sherdog] = await Promise.all([loadAll('events', 'id, date'), loadAll('fights', FIGHT_COLS), loadAll('fighters', FIGHTER_COLS), loadSherdogHistory()]);
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  const fighters = new Map(fightersRaw.map(f => [f.id, f]));
  const elo = computeElo(fights, eventById, eloOptions(CFG));
  const glicko = computeGlicko(fights, eventById, { ...glickoOptions(CFG), sherdog });
  const gMean = fieldMeanByYear(glicko.history), eMean = fieldMeanByYear(elo.history);
  const gRows = intervals(glicko.history, fighters, gMean), eRows = intervals(elo.history, fighters, eMean);
  const gFit = anchored(fitRates(gRows)), eFit = anchored(fitRates(eRows));
  const ci = bootstrap(gRows, REPS);
  // M3 bridges
  const bridges = [];
  for (const [id, h] of glicko.history) {
    const f = fighters.get(id); if (!f?.date_of_birth) continue;
    const ufc = h.filter(e => e.ufc); if (ufc.length < 8 || yrs(ufc[0].date, ufc[ufc.length - 1].date) < 6) continue;
    let agePred = 0; const expo = new Array(PERIODS.length).fill(0);
    for (let k = 0; k + 1 < ufc.length; k++) { const dt = yrs(ufc[k].date, ufc[k + 1].date); agePred += gFit.beta[ageBin(yrs(f.date_of_birth, ufc[k].date) + dt / 2)] * dt; const t = perBin((frac(ufc[k].date) + frac(ufc[k + 1].date)) / 2); if (t >= 0) expo[t] += dt; }
    const observed = (num(ufc[ufc.length - 1].post) - meanAt(gMean, frac(ufc[ufc.length - 1].date))) - (num(ufc[0].post) - meanAt(gMean, frac(ufc[0].date)));
    bridges.push({ expo, excess: -(observed - agePred) });
  }
  const bridge = wls(bridges.map(b => b.expo), bridges.map(b => b.excess), bridges.map(() => 1), 1e-2);

  const r1 = v => +v.toFixed(1);
  const periods = PERIODS.map(([from, to], t) => {
    const g = gFit.drift[t], e = eFit.drift[t];
    const agree = Math.sign(g) === Math.sign(e);
    const chosen = agree ? Math.max(0, (g + e) / 2) : 0;
    const n = gRows.filter(r => perBin(r.year) === t).length;
    return { from, to: to - 1, glicko: r1(g), glicko_ci: ci[t].map(r1), elo: r1(e), bridge: r1(bridge[t]), n_intervals: n, chosen: r1(chosen), reliability: from < 2005 ? 'low' : 'normal' };
  });
  const out = {
    generated_at: new Date().toISOString(), model: MODEL.version,
    anchor: `true strength flat at ages ${ANCHOR[0]}-${ANCHOR[1]}`,
    policy: 'mean of glicko and elo where signs agree, else 0; floored at 0; pre-2005 flagged low reliability',
    units: 'rating points per year of field improvement (positive = field got stronger)',
    age_curve: Object.fromEntries(AGE_BINS.map((b, i) => [`${b[0]}-${b[1] === 99 ? '' : b[1]}`, { glicko: r1(gFit.beta[i]), elo: r1(eFit.beta[i]) }])),
    periods, field_mean: { glicko: gMean, elo: eMean }, bridges: bridges.length,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
  console.log(`wrote ${path.relative(process.cwd(), OUT)} (${gRows.length} Glicko intervals, ${bridges.length} bridge fighters, ${REPS} bootstrap reps)`);
  for (const p of periods) console.log(`${p.from}-${p.to}  glicko ${p.glicko} [${p.glicko_ci.join(', ')}]  elo ${p.elo}  bridge ${p.bridge}  -> served ${p.chosen} (${p.reliability})`);
}

if (require.main === module) main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });

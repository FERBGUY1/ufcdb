/**
 * eraDrift.js — serving-side era adjustment for FANTASY (cross-era) matchups.
 *
 * Reads data/era-drift.json (computeEraDrift.js) and answers: a rating earned
 * on date A — what is it worth on date B's scale? Two components:
 *   rebase       mechanical: the field MEAN rating on B minus on A, per rating
 *                system (Glicko inflates over time, UFC Elo barely moves). No
 *                assumption involved.
 *   improvement  estimated: cumulative field improvement between A and B
 *                (served `chosen` values; pre-2005 flagged low reliability).
 * shift = rebase − improvement, applied to A's ratings. For A and B on the same
 * date every term is exactly 0, so same-era and current matchups are untouched
 * by construction (eraDrift.test.js). The adjustment is antisymmetric:
 * adjust(A, B).shift === −adjust(B, A).shift.
 */
const path = require('path');

let TABLE = null;
function table() {
  if (!TABLE) TABLE = require(path.join(__dirname, 'data', 'era-drift.json'));
  return TABLE;
}
const frac = d => { const x = new Date(d); return x.getFullYear() + (x.getMonth() + 0.5) / 12; };

// The yearly field means wobble by ±20 points year to year (roster mix, a partial
// current year); only the slow drift is inflation, so the series is smoothed with a
// 5-year centred moving average before use (edges average the years available).
const SMOOTH_YEARS = 5;
const smoothed = {};
function smoothSeries(kind) {
  if (smoothed[kind]) return smoothed[kind];
  const raw = table().field_mean[kind];
  const ys = Object.keys(raw).map(Number).sort((a, b) => a - b);
  const half = Math.floor(SMOOTH_YEARS / 2);
  const out = {};
  for (const y of ys) {
    const win = ys.filter(x => Math.abs(x - y) <= half);
    out[y] = win.reduce((s, x) => s + raw[x], 0) / win.length;
  }
  return (smoothed[kind] = out);
}

// Field mean for a rating system at a date: linear between mid-years of the smoothed series, clamped at the ends.
function fieldMean(kind, date) {
  const byYear = smoothSeries(kind);
  const ys = Object.keys(byYear).map(Number).sort((a, b) => a - b);
  const t = frac(date);
  if (t <= ys[0] + 0.5) return byYear[ys[0]];
  if (t >= ys[ys.length - 1] + 0.5) return byYear[ys[ys.length - 1]];
  for (let i = 0; i + 1 < ys.length; i++) {
    const a = ys[i] + 0.5, b = ys[i + 1] + 0.5;
    if (t >= a && t <= b) return byYear[ys[i]] + (byYear[ys[i + 1]] - byYear[ys[i]]) * (t - a) / (b - a);
  }
  return byYear[ys[ys.length - 1]];
}

// Cumulative served field improvement from the first period start up to `date`.
function fieldLevel(date) {
  const t = frac(date);
  let s = 0;
  for (const p of table().periods) {
    const lo = p.from, hi = p.to + 1;
    if (t <= lo) break;
    s += p.chosen * (Math.min(t, hi) - lo);
  }
  return s;
}

// Lowest reliability of the periods a date range touches.
function reliability(dateA, dateB) {
  const lo = Math.min(frac(dateA), frac(dateB)), hi = Math.max(frac(dateA), frac(dateB));
  let r = 'normal';
  for (const p of table().periods) if (p.to + 1 > lo && p.from < hi && p.reliability === 'low') r = 'low';
  return r;
}

/**
 * Adjustment that moves fighter A's ratings (earned as of dateA) onto dateB's scale.
 * Returns { years, rebase: { glicko, elo }, improvement, shift: { glicko, elo }, reliability, periods }.
 * Positive shift.glicko = add to A's Glicko. Exactly zero when dateA === dateB.
 */
function adjust(dateA, dateB) {
  if (!dateA || !dateB || dateA === dateB) return { years: 0, rebase: { glicko: 0, elo: 0 }, improvement: 0, shift: { glicko: 0, elo: 0 }, reliability: 'normal', periods: [] };
  const rebase = { glicko: fieldMean('glicko', dateB) - fieldMean('glicko', dateA), elo: fieldMean('elo', dateB) - fieldMean('elo', dateA) };
  const improvement = fieldLevel(dateB) - fieldLevel(dateA);
  const lo = Math.min(frac(dateA), frac(dateB)), hi = Math.max(frac(dateA), frac(dateB));
  const periods = table().periods.filter(p => p.to + 1 > lo && p.from < hi && p.chosen > 0).map(p => ({ from: p.from, to: p.to, per_year: p.chosen }));
  return {
    years: (new Date(dateB) - new Date(dateA)) / (365.25 * 86400000),
    rebase, improvement,
    shift: { glicko: rebase.glicko - improvement, elo: rebase.elo - improvement },
    reliability: reliability(dateA, dateB), periods,
  };
}

module.exports = { adjust, fieldMean, fieldLevel, reliability, table };

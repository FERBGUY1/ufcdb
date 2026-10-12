/**
 * sizePrior.js — hand-set size adjustment for cross-weight matchups.
 *
 * NOT learned from fight data. UFC cards contain no bouts across two or more
 * divisions (the few cross-division bouts are matchmade to be competitive and
 * the naturally bigger fighter wins them no more often), so the trained model
 * is a same-size comparison of skill. This prior is applied ON TOP of the
 * model's log-odds, only at serving time and in the sanity set — never inside
 * the rolling-origin evaluation, which only sees real fights.
 *
 * Gap is counted in divisions between the two fighters' NATURAL divisions
 * (modal weight class over their fights), on the shared weight ladder
 * 115 / 125 / 135 / 145 / 155 / 170 / 185 / 205 / 265. Women's divisions sit
 * on the same ladder (W-FLW 125 vs W-BW 135 = one division).
 *
 * Curve (log-odds toward the naturally bigger fighter), x = gap - 1:
 *   gap 0-1   : 0            elite smaller fighters stay competitive one
 *                             division up (Volkanovski vs Makhachev 1)
 *   gap >= 2  : A*x + B*x^2  linear step per extra division plus a mild
 *                             convex term
 * Anchors (set 2026-10-12): gap 2 = +1.15 log-odds, so Makhachev (LW) vs a
 * top middleweight lands near even-to-slight-underdog (Chimaev 58%,
 * Strickland 31%); gap 5 = +5.2, taking Ngannou (HW) vs Topuria (FW) from the
 * model's ~40% on skill to ~99%.
 */

const LADDER = [115, 125, 135, 145, 155, 170, 185, 205, 265];
const A = 1.10;
const B = 0.05;
const FREE_GAP = 1; // gaps up to this many divisions get no adjustment

const nearestRung = lbs => {
  if (lbs == null) return null;
  let best = 0;
  for (let i = 1; i < LADDER.length; i++) if (Math.abs(LADDER[i] - lbs) < Math.abs(LADDER[best] - lbs)) best = i;
  return best;
};

/** Number of divisions between two natural limits (null when either is unknown). */
function divisionGap(limitA, limitB) {
  const a = nearestRung(limitA), b = nearestRung(limitB);
  return a == null || b == null ? null : Math.abs(a - b);
}

/** Log-odds shift toward the bigger fighter for a given division gap. */
function sizeAdjustmentLogit(gap) {
  if (gap == null || gap <= FREE_GAP) return 0;
  const x = gap - FREE_GAP;
  return A * x + B * x * x;
}

const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));

/**
 * Apply the prior to the model's probability that fighter A wins.
 * Returns { p, pBefore, gap, shift, biggerIsA } — shift is the signed
 * log-odds change applied to A (positive when A is the bigger fighter).
 */
function applySizePrior(pA, limitA, limitB) {
  const gap = divisionGap(limitA, limitB);
  const base = sizeAdjustmentLogit(gap);
  if (!base) return { p: pA, pBefore: pA, gap, shift: 0, biggerIsA: null };
  const biggerIsA = limitA > limitB;
  const shift = biggerIsA ? base : -base;
  const pc = Math.min(1 - 1e-9, Math.max(1e-9, pA));
  return { p: sigmoid(logit(pc) + shift), pBefore: pA, gap, shift, biggerIsA };
}

/** The curve as a table, for docs and review. */
function curveTable(maxGap = LADDER.length - 1) {
  return Array.from({ length: maxGap + 1 }, (_, gap) => {
    const z = sizeAdjustmentLogit(gap);
    return { gap, logOdds: z, fromEven: sigmoid(z) };
  });
}

module.exports = { LADDER, A, B, FREE_GAP, divisionGap, sizeAdjustmentLogit, applySizePrior, curveTable };

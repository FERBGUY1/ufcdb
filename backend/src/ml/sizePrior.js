/**
 * sizePrior.js — hand-set size / weight-cut adjustment for cross-weight matchups.
 *
 * NOT learned from fight data. UFC cards contain no bouts across two or more
 * divisions (the few cross-division bouts are matchmade to be competitive and
 * the naturally bigger fighter wins them no more often), so the trained model
 * is a same-size comparison of skill. This prior is applied ON TOP of the
 * model's log-odds, only at serving time and in the sanity set — never inside
 * the rolling-origin evaluation, which only sees real fights.
 *
 * It depends on the BOUT WEIGHT (user decision 2026-10-12). Each fighter's
 * natural division (modal weight class) is placed on the shared ladder
 * 115 / 125 / 135 / 145 / 155 / 170 / 185 / 205 / 265 (women's divisions sit
 * on the same rungs), and so is the bout limit — fractionally for a
 * catchweight, so a bout between two rungs applies both effects proportionally.
 * Each fighter then MOVES some number of divisions from natural to bout weight:
 *
 *   moving UP u divisions   (giving size away):   penalty UP(u)
 *     u <= 1 : 0                 elite smaller fighters stay competitive one
 *                                 division up (Volkanovski vs Makhachev 1)
 *     u >= 1 : A*x + B*x^2, x = u - 1   (A 1.10, B 0.05)
 *                                 +1.15 at 2 up, +2.40 at 3, +3.75 at 4,
 *                                 +5.20 at 5 (Topuria at heavyweight)
 *
 *   moving DOWN d divisions (cutting weight):      penalty DOWN(d)
 *     d <= 1 : 0                 a one-division drop is routine
 *     d  = 2 : 2.0               extreme cut, large penalty
 *     d >= 3 : 5.0, +1.5 per further division   "can't realistically make
 *                                 weight" — the odds flip strongly toward the
 *                                 fighter at natural weight, with a note
 *     knots interpolate linearly, so a catchweight gets a proportional share.
 *
 * Net shift toward A (log-odds) = (UP_B + DOWN_B) - (UP_A + DOWN_A). Both
 * fighters moving the same way by the same amount cancel out. The old
 * "natural gap" curve is the special case where the bout is at the bigger
 * fighter's natural weight (then only the smaller fighter moves, up).
 *
 * When the bout weight is unknown it is taken as the HEAVIER fighter's natural
 * division — the same in either slot order, so mirror symmetry holds.
 */

const LADDER = [115, 125, 135, 145, 155, 170, 185, 205, 265];
const A = 1.10;
const B = 0.05;
const FREE_GAP = 1;                       // moves up to this many divisions (either way) cost nothing
const DOWN_KNOTS = [[1, 0], [2, 2.0], [3, 5.0]]; // divisions down -> log-odds penalty
const DOWN_SLOPE_BEYOND = 1.5;            // per division past the last knot
const EXTREME_CUT_FROM = 1.5;             // moving down at least this many divisions = "extreme cut" note
const CANT_MAKE_WEIGHT_FROM = 2.5;        // moving down at least this many = "can't realistically make weight" note

/** Fractional rung position of a weight on the ladder (clamped to the ends). */
function rungOf(lbs) {
  if (lbs == null || !Number.isFinite(lbs)) return null;
  if (lbs <= LADDER[0]) return 0;
  if (lbs >= LADDER[LADDER.length - 1]) return LADDER.length - 1;
  for (let i = 1; i < LADDER.length; i++) {
    if (lbs <= LADDER[i]) return i - 1 + (lbs - LADDER[i - 1]) / (LADDER[i] - LADDER[i - 1]);
  }
  return LADDER.length - 1;
}
const nearestRung = lbs => { const r = rungOf(lbs); return r == null ? null : Math.round(r); };

/** Number of divisions between two natural limits (null when either is unknown). */
function divisionGap(limitA, limitB) {
  const a = nearestRung(limitA), b = nearestRung(limitB);
  return a == null || b == null ? null : Math.abs(a - b);
}

/** Penalty (log-odds) for moving UP u divisions — the original escalating curve. */
function upPenalty(u) {
  if (u == null || u <= FREE_GAP) return 0;
  const x = u - FREE_GAP;
  return A * x + B * x * x;
}
/** Penalty (log-odds) for cutting DOWN d divisions — piecewise linear through DOWN_KNOTS. */
function downPenalty(d) {
  if (d == null || d <= DOWN_KNOTS[0][0]) return 0;
  for (let i = 1; i < DOWN_KNOTS.length; i++) {
    const [d0, p0] = DOWN_KNOTS[i - 1], [d1, p1] = DOWN_KNOTS[i];
    if (d <= d1) return p0 + (p1 - p0) * (d - d0) / (d1 - d0);
  }
  const [dl, pl] = DOWN_KNOTS[DOWN_KNOTS.length - 1];
  return pl + DOWN_SLOPE_BEYOND * (d - dl);
}
/** Backwards-compatible: shift toward the bigger fighter when the bout is at the bigger fighter's weight. */
const sizeAdjustmentLogit = gap => upPenalty(gap);

const logit = p => Math.log(p / (1 - p));
const sigmoid = z => 1 / (1 + Math.exp(-z));

/** One fighter's move from natural weight to the bout weight. */
function moveOf(naturalLimit, boutLimit) {
  const n = rungOf(naturalLimit), b = rungOf(boutLimit);
  if (n == null || b == null) return { natural: naturalLimit ?? null, move: null, up: 0, down: 0, penalty: 0, extremeCut: false, cantMakeWeight: false };
  const move = b - n; // + up, − down, in divisions (fractional for catchweights)
  const up = Math.max(0, move), down = Math.max(0, -move);
  return {
    natural: naturalLimit, move, up, down,
    penalty: upPenalty(up) + downPenalty(down),
    extremeCut: down >= EXTREME_CUT_FROM && down < CANT_MAKE_WEIGHT_FROM,
    cantMakeWeight: down >= CANT_MAKE_WEIGHT_FROM,
  };
}

/**
 * Apply the prior to the model's probability that fighter A wins.
 * @param pA        skill-only probability for A
 * @param limitA/B  natural division limits (lbs)
 * @param boutLimit the bout's weight limit (lbs); null = heavier fighter's natural division
 * Returns { p, pBefore, boutLimit, gap, shift, biggerIsA, a, b } where shift is
 * the signed log-odds change applied to A and a / b describe each side's move.
 */
function applySizePrior(pA, limitA, limitB, boutLimit = null) {
  const gap = divisionGap(limitA, limitB);
  const bout = boutLimit ?? (limitA != null && limitB != null ? Math.max(limitA, limitB) : null);
  const a = moveOf(limitA, bout), b = moveOf(limitB, bout);
  const shift = b.penalty - a.penalty;
  const biggerIsA = limitA != null && limitB != null && limitA !== limitB ? limitA > limitB : null;
  if (!shift) return { p: pA, pBefore: pA, boutLimit: bout, gap, shift: 0, biggerIsA, a, b };
  const pc = Math.min(1 - 1e-9, Math.max(1e-9, pA));
  return { p: sigmoid(logit(pc) + shift), pBefore: pA, boutLimit: bout, gap, shift, biggerIsA, a, b };
}

/** The curves as a table, for docs and review. */
function curveTable(maxGap = LADDER.length - 1) {
  return Array.from({ length: maxGap + 1 }, (_, gap) => ({
    divisions: gap, up: upPenalty(gap), down: downPenalty(gap), upFromEven: sigmoid(-upPenalty(gap)), downFromEven: sigmoid(-downPenalty(gap)),
  }));
}

module.exports = { LADDER, A, B, FREE_GAP, DOWN_KNOTS, EXTREME_CUT_FROM, CANT_MAKE_WEIGHT_FROM, rungOf, divisionGap, upPenalty, downPenalty, sizeAdjustmentLogit, moveOf, applySizePrior, curveTable };

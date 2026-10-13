/**
 * eloEngine.js — point-in-time Elo over UFC fights.
 *
 * Fights are replayed in date order. Every fighter's rating BEFORE each fight
 * is recorded, so a feature computed "as of" a date only sees ratings earned
 * strictly before it (same cutoff semantics as statsEngine.snapshot).
 *
 *   K            rating step (default 40)
 *   finishMult   multiplier on K for KO/TKO and submission wins (1 = off)
 *   initial      starting rating for a UFC debutant
 *   decision     how a DECISION win is weighted ('none' = like any win):
 *                  'method'  U-DEC x1, M-DEC x midpoint, S-DEC/DEC x decisionFloor (on K)
 *                  'cards'   K x (floor + (cap-floor)*dominance); dominance = mean winner
 *                            margin per card per round (29-28 x3 -> 0.33, 30-27 x3 -> 1,
 *                            split 29-28/28-29/29-28 -> 0.11); no cards -> 'method' rule
 *                  'score'   same dominance, but as a fractional result: the winner scores
 *                            0.5 + 0.5*(floor + (cap-floor)*dominance) instead of 1
 *   decisionFloor  weight of the least convincing decision (default 0.5)
 *   decisionCap    weight of a shutout (default 1; >1 lets dominant decisions count extra)
 *
 * Draws score 0.5 each; no-contests and upcoming bouts are skipped. Same-day
 * fights (early tournaments) are replayed in the order given, so a semi-final
 * result does feed the final — but a feature asked for "as of" that date
 * still sees only strictly-earlier dates.
 */

const expectedScore = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

const DEC_RE = /^(U-DEC|S-DEC|M-DEC|DEC)$/i;
const parseCard = s => { const m = /(\d+)\s*[-\u2013]\s*(\d+)\s*$/.exec(String(s || '')); return m ? [+m[1], +m[2]] : null; };

// Winner-oriented scorecard dominance in [0, 1] (null when cards are missing or
// do not identify a majority side). Cards are stored in the corner order of the
// source, so the winner's side is taken as the majority direction.
function cardDominance(f) {
  const cards = [f.judge1_score, f.judge2_score, f.judge3_score].map(parseCard).filter(Boolean);
  if (cards.length < 2) return null;
  const sign = Math.sign(cards.reduce((s, [a, b]) => s + Math.sign(a - b), 0));
  if (!sign) return null;
  const rounds = Math.max(1, Math.round(Math.max(...cards.flat()) / 10));
  const margin = cards.reduce((s, [a, b]) => s + (a - b) * sign, 0) / cards.length / rounds;
  return Math.min(1, Math.max(0, margin));
}

// Weight of a decision win under the chosen scheme (1 for non-decisions).
function decisionWeight(f, { decision, decisionFloor, decisionCap }) {
  if (decision === 'none' || !DEC_RE.test(f.method || '')) return 1;
  const byMethod = () => (/^U-DEC$/i.test(f.method) ? 1 : /^M-DEC$/i.test(f.method) ? (1 + decisionFloor) / 2 : decisionFloor);
  if (decision === 'method') return byMethod();
  const d = cardDominance(f);
  if (d == null) return byMethod();
  return decisionFloor + (decisionCap - decisionFloor) * d;
}

// Elo options from a features.DEFAULT_CONFIG-shaped object.
const eloOptions = cfg => ({ K: cfg.eloK, finishMult: cfg.eloFinishMult, decision: cfg.eloDecision || 'none', decisionFloor: cfg.eloDecisionFloor ?? 0.5, decisionCap: cfg.eloDecisionCap ?? 1 });

/**
 * @param fights     raw fights rows (id, event_id, fighter1_id, fighter2_id, winner_id, result, method)
 * @param eventById  id -> { date }
 * @returns { history: Map<fighterId, [{date, fightId, oppId, pre, post, oppPre, result}]>, ratingAsOf, summaryAsOf, config }
 */
function computeElo(fights, eventById, { K = 40, finishMult = 1, initial = 1500, decision = 'none', decisionFloor = 0.5, decisionCap = 1 } = {}) {
  const decOpts = { decision, decisionFloor, decisionCap };
  const rating = new Map();
  const history = new Map();
  const get = id => (rating.has(id) ? rating.get(id) : initial);
  const push = (id, entry) => { if (!history.has(id)) history.set(id, []); history.get(id).push(entry); };

  const ordered = fights
    .filter(f => f.fighter1_id && f.fighter2_id && eventById[f.event_id] && (f.result === 'win' || f.result === 'draw'))
    .map(f => ({ f, date: eventById[f.event_id].date }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.f.id.localeCompare(b.f.id));

  for (const { f, date } of ordered) {
    const a = f.fighter1_id, b = f.fighter2_id;
    const ra = get(a), rb = get(b);
    let sa;
    if (f.result === 'draw') sa = 0.5;
    else if (f.winner_id === a) sa = 1;
    else if (f.winner_id === b) sa = 0;
    else continue;
    const finish = /KO|SUB/i.test(f.method || '');
    let k = K * (finish && sa !== 0.5 ? finishMult : 1);
    if (sa !== 0.5) {
      const w = decisionWeight(f, decOpts);
      if (decision === 'score') sa = sa === 1 ? 0.5 + 0.5 * w : 0.5 - 0.5 * w;
      else k *= w;
    }
    const ea = expectedScore(ra, rb);
    const na = ra + k * (sa - ea);
    const nb = rb + k * ((1 - sa) - (1 - ea));
    rating.set(a, na); rating.set(b, nb);
    const resA = sa > 0.5 ? 'win' : sa < 0.5 ? 'loss' : 'draw';
    push(a, { date, fightId: f.id, oppId: b, pre: ra, post: na, oppPre: rb, result: resA });
    push(b, { date, fightId: f.id, oppId: a, pre: rb, post: nb, oppPre: ra, result: resA === 'win' ? 'loss' : resA === 'loss' ? 'win' : 'draw' });
  }

  // Rating as it stood before any fight on `date` (null date = current).
  function ratingAsOf(fighterId, date = null) {
    const h = history.get(fighterId);
    if (!h || !h.length) return initial;
    let r = initial;
    for (const e of h) { if (date && e.date >= date) break; r = e.post; }
    return r;
  }

  // Elo-derived summary as of `date`: current rating, strength of schedule
  // (mean opponent pre-fight rating), best beaten opponent, and momentum
  // (rating change over the last 3 fights).
  function summaryAsOf(fighterId, date = null) {
    const h = (history.get(fighterId) || []).filter(e => !date || e.date < date);
    if (!h.length) return { elo: initial, sos: null, elo_best_win: null, elo_trend: null, elo_fights: 0 };
    const sos = h.reduce((s, e) => s + e.oppPre, 0) / h.length;
    const wins = h.filter(e => e.result === 'win');
    const bestWin = wins.length ? Math.max(...wins.map(e => e.oppPre)) : null;
    const last3 = h.slice(-3);
    return {
      elo: h[h.length - 1].post,
      sos,
      elo_best_win: bestWin,
      elo_trend: last3[last3.length - 1].post - last3[0].pre,
      elo_fights: h.length,
    };
  }

  return { history, ratingAsOf, summaryAsOf, config: { K, finishMult, initial, ...decOpts } };
}

module.exports = { computeElo, expectedScore, eloOptions, cardDominance, decisionWeight };

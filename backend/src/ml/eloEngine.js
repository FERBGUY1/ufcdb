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
 *
 * Draws score 0.5 each; no-contests and upcoming bouts are skipped. Same-day
 * fights (early tournaments) are replayed in the order given, so a semi-final
 * result does feed the final — but a feature asked for "as of" that date
 * still sees only strictly-earlier dates.
 */

const expectedScore = (ra, rb) => 1 / (1 + Math.pow(10, (rb - ra) / 400));

/**
 * @param fights     raw fights rows (id, event_id, fighter1_id, fighter2_id, winner_id, result, method)
 * @param eventById  id -> { date }
 * @returns { history: Map<fighterId, [{date, fightId, oppId, pre, post, oppPre, result}]>, ratingAsOf, summaryAsOf, config }
 */
function computeElo(fights, eventById, { K = 40, finishMult = 1, initial = 1500 } = {}) {
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
    const k = K * (finish && sa !== 0.5 ? finishMult : 1);
    const ea = expectedScore(ra, rb);
    const na = ra + k * (sa - ea);
    const nb = rb + k * ((1 - sa) - (1 - ea));
    rating.set(a, na); rating.set(b, nb);
    const resA = sa === 1 ? 'win' : sa === 0 ? 'loss' : 'draw';
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

  return { history, ratingAsOf, summaryAsOf, config: { K, finishMult, initial } };
}

module.exports = { computeElo, expectedScore };

/**
 * glickoEngine.js — point-in-time Glicko-2 ratings with uncertainty (RD).
 *
 * Same contract as eloEngine.computeElo: fights are replayed in strict date
 * order and every fighter's state BEFORE each fight is recorded, so a value
 * asked "as of" date D only reflects fights dated strictly before D. The
 * replay is date-batched: all bouts on one date are rated against the
 * pre-date states and applied together, so no result on D feeds another
 * rating on D (verified by glickoEngine.test.js).
 *
 * Glicko-2 (Glickman 2012): r = 1500 + 173.7178 µ, RD = 173.7178 φ, volatility σ.
 *   tau          system constant (0.3 … 1.2; default 0.5)
 *   initialRd    RD of a fighter with no known fights (default 350)
 *   initialVol   starting volatility (default 0.06)
 *   periodDays   time unit for RD inflation: φ² grows by σ² per periodDays of
 *                inactivity (default 365)
 *   finishMult   multiplier on the rating step (not the RD step) for KO/TKO and
 *                submission wins (1 = off); mirrors eloEngine's finishMult
 *   seed         'none'    every fighter starts at 1500 / initialRd
 *                'record'  a fighter's FIRST state is seeded from the Sherdog
 *                          pre-UFC record and regional opponent quality
 *                          (seedSlope rating points per % of shrunk win rate
 *                          above 50, weighted by min(fights, 30)/30; seedOppSlope
 *                          per % of opponent quality above 50); RD starts at
 *                          initialRd minus seedRdDrop × that weight
 *                'unified' the replay itself includes the non-UFC Sherdog bouts of
 *                          every fighter with a page; opponents without a page
 *                          become their own rating nodes keyed by Sherdog id, an
 *                          unknown opponent is a fresh anonymous node. UFC bouts
 *                          come from the DB rows only (Sherdog UFC rows and any
 *                          Sherdog row that duplicates a DB fight ±1 day are
 *                          dropped), so nothing is counted twice.
 *
 * Draws score 0.5; no-contests and upcoming bouts are skipped.
 */

const SCALE = 173.7178;
const g = phi => 1 / Math.sqrt(1 + 3 * phi * phi / (Math.PI * Math.PI));
const E = (mu, muJ, phiJ) => 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));

// Glicko-2 volatility iteration (Illinois algorithm from the spec).
function newVolatility(phi, sigma, v, delta, tau) {
  const a = Math.log(sigma * sigma);
  const f = x => Math.exp(x) * (delta * delta - phi * phi - v - Math.exp(x)) / (2 * (phi * phi + v + Math.exp(x)) ** 2) - (x - a) / (tau * tau);
  let A = a, B;
  if (delta * delta > phi * phi + v) B = Math.log(delta * delta - phi * phi - v);
  else { let k = 1; while (f(a - k * tau) < 0) k++; B = a - k * tau; }
  let fA = f(A), fB = f(B);
  for (let i = 0; i < 100 && Math.abs(B - A) > 1e-6; i++) {
    const C = A + (A - B) * fA / (fB - fA), fC = f(C);
    if (fC * fB <= 0) { A = B; fA = fB; } else fA /= 2;
    B = C; fB = fC;
  }
  return Math.exp(A / 2);
}

const shrunkRate = (w, l, k = 2) => (w + l + k > 0 ? ((w + k * 0.5) / (w + l + k)) * 100 : 50);

// Options from a features.DEFAULT_CONFIG-shaped object.
const glickoOptions = cfg => ({
  tau: cfg.glickoTau ?? 0.5, initialRd: cfg.glickoRd0 ?? 350, initialVol: cfg.glickoVol0 ?? 0.06,
  periodDays: cfg.glickoPeriodDays ?? 365, finishMult: cfg.glickoFinishMult ?? 1,
  seed: cfg.glickoSeed || 'none', seedSlope: cfg.glickoSeedSlope ?? 5, seedOppSlope: cfg.glickoSeedOppSlope ?? 5, seedRdDrop: cfg.glickoSeedRdDrop ?? 100,
});

/**
 * Build the bout list for the replay. Each bout: { date, id, a, b, sa (score for a), finish, ufc }.
 * `sherdog` = trainModel.loadSherdogHistory() shape ({ byFighter, bySherdog }); only read for seed 'unified'.
 */
function collectBouts(fights, eventById, sherdog, seed) {
  const bouts = [];
  const ufcPairDates = new Set();
  const ordered = fights
    .filter(f => f.fighter1_id && f.fighter2_id && eventById[f.event_id] && (f.result === 'win' || f.result === 'draw'))
    .map(f => ({ f, date: eventById[f.event_id].date }));
  for (const { f, date } of ordered) {
    const a = f.fighter1_id, b = f.fighter2_id;
    let sa;
    if (f.result === 'draw') sa = 0.5; else if (f.winner_id === a) sa = 1; else if (f.winner_id === b) sa = 0; else continue;
    bouts.push({ date, id: `ufc:${f.id}`, a, b, sa, finish: /KO|SUB/i.test(f.method || ''), ufc: true });
    const day = new Date(date).getTime();
    for (const d of [-1, 0, 1]) ufcPairDates.add(`${[a, b].sort().join('|')}@${new Date(day + d * 86400000).toISOString().slice(0, 10)}`);
  }
  if (seed === 'unified' && sherdog) {
    const seen = new Set();
    let anon = 0;
    for (const [fighterId, list] of sherdog.byFighter) {
      for (const e of list) {
        if (e.ufc || !e.date || (e.result !== 'win' && e.result !== 'loss' && e.result !== 'draw')) continue;
        const oppFighter = e.opp ? sherdog.bySherdog.get(e.opp) : null;
        const opp = oppFighter || (e.opp ? `sd:${e.opp}` : `anon:${anon++}`);
        if (oppFighter && ufcPairDates.has(`${[fighterId, oppFighter].sort().join('|')}@${e.date}`)) continue; // a DB UFC bout
        // a regional bout between two paged fighters is on both pages: keep one listing
        const key = `${[fighterId, opp].sort().join('|')}@${e.date}`;
        if (seen.has(key)) continue;
        seen.add(key);
        bouts.push({ date: e.date, id: key, a: fighterId, b: opp, sa: e.result === 'win' ? 1 : e.result === 'loss' ? 0 : 0.5, finish: !!e.finish, ufc: false });
      }
    }
  }
  return bouts.sort((x, y) => x.date.localeCompare(y.date) || x.id.localeCompare(y.id));
}

/**
 * @param fights    raw fight rows (id, event_id, fighter1_id, fighter2_id, winner_id, result, method)
 * @param eventById id -> { date }
 * @param opts      glickoOptions() shape; plus `sherdog` (loadSherdogHistory result) for the seeds
 * @returns { history: Map<id, [{date, boutId, oppId, pre: {r, rd}, post: {r, rd}, oppPre, result, ufc}]>, summaryAsOf, expected, config }
 */
function computeGlicko(fights, eventById, opts = {}) {
  const { tau = 0.5, initialRd = 350, initialVol = 0.06, periodDays = 365, finishMult = 1, seed = 'none', seedSlope = 5, seedOppSlope = 5, seedRdDrop = 100, sherdog = null } = opts;
  const state = new Map(); // id -> { mu, phi, sigma, last }
  const history = new Map();
  const seedOf = new Map();

  // 'record' seed: first state from the Sherdog pre-UFC record (fights before the first UFC bout).
  // "pre-UFC" = before the fighter's first DB fight (not Sherdog's event-name flag), so the
  // seed is a constant fixed before any UFC bout and can never see a later regional bout.
  const firstDbFight = new Map();
  for (const f of fights) { const d = eventById[f.event_id]?.date; if (!d) continue; for (const id of [f.fighter1_id, f.fighter2_id]) if (id && (!firstDbFight.has(id) || d < firstDbFight.get(id))) firstDbFight.set(id, d); }
  if (seed === 'record' && sherdog) {
    for (const [id, list] of sherdog.byFighter) {
      const firstUfc = firstDbFight.get(id) || '9999';
      let w = 0, l = 0, qual = 0, n = 0;
      for (const e of list) {
        if (e.date >= firstUfc || e.ufc) continue;
        if (e.result === 'win') w++; else if (e.result === 'loss') l++; else continue;
        const oppId = e.opp ? sherdog.bySherdog.get(e.opp) : null;
        let q = 50;
        if (oppId) { let ow = 0, ol = 0; for (const x of sherdog.byFighter.get(oppId) || []) { if (x.date >= e.date) break; if (x.result === 'win') ow++; else if (x.result === 'loss') ol++; } q = shrunkRate(ow, ol); }
        qual += q; n++;
      }
      if (!n) continue;
      const weight = Math.min(n, 30) / 30;
      const r = 1500 + seedSlope * (shrunkRate(w, l) - 50) * weight + seedOppSlope * (qual / n - 50) * weight;
      seedOf.set(id, { r, rd: Math.max(60, initialRd - seedRdDrop * weight) });
    }
  }
  const fresh = id => {
    const s = seedOf.get(id);
    return { mu: s ? (s.r - 1500) / SCALE : 0, phi: (s ? s.rd : initialRd) / SCALE, sigma: initialVol, last: null };
  };
  const get = id => { if (!state.has(id)) state.set(id, fresh(id)); return state.get(id); };
  const push = (id, entry) => { if (!history.has(id)) history.set(id, []); history.get(id).push(entry); };
  const asRating = s => ({ r: 1500 + SCALE * s.mu, rd: SCALE * s.phi });

  // RD inflation for inactivity up to `date` (pre-fight state used for both expectation and update).
  const inflate = (s, date) => {
    const t = s.last ? (new Date(date) - new Date(s.last)) / 86400000 / periodDays : 1;
    return Math.sqrt(s.phi * s.phi + s.sigma * s.sigma * Math.max(0, t));
  };

  const bouts = collectBouts(fights, eventById, sherdog, seed);
  let i = 0;
  while (i < bouts.length) {
    const date = bouts[i].date;
    let j = i; while (j < bouts.length && bouts[j].date === date) j++;
    const day = bouts.slice(i, j);
    // pre-date snapshot for every participant on this date (frozen for the whole date)
    const pre = new Map();
    for (const b of day) for (const id of [b.a, b.b]) if (!pre.has(id)) { const s = get(id); pre.set(id, { mu: s.mu, phi: inflate(s, date), sigma: s.sigma }); }
    // per-fighter list of opponents on this date (early tournaments fight 2-3 times on one date)
    const games = new Map();
    for (const b of day) {
      if (!games.has(b.a)) games.set(b.a, []); if (!games.has(b.b)) games.set(b.b, []);
      games.get(b.a).push({ opp: b.b, s: b.sa, finish: b.finish, bout: b });
      games.get(b.b).push({ opp: b.a, s: 1 - b.sa, finish: b.finish, bout: b });
    }
    const post = new Map();
    for (const [id, gs] of games) {
      const me = pre.get(id);
      let v = 0, sum = 0, finishBonus = 0;
      for (const x of gs) {
        const o = pre.get(x.opp), gj = g(o.phi), e = E(me.mu, o.mu, o.phi);
        v += gj * gj * e * (1 - e);
        const term = gj * (x.s - e);
        sum += term;
        if (x.finish && x.s !== 0.5 && finishMult !== 1) finishBonus += term * (finishMult - 1);
      }
      v = 1 / v;
      const delta = v * sum;
      const sigma = newVolatility(me.phi, me.sigma, v, delta, tau);
      const phiStar = Math.sqrt(me.phi * me.phi + sigma * sigma);
      const phi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
      const mu = me.mu + phi * phi * (sum + finishBonus);
      post.set(id, { mu, phi, sigma, last: date });
    }
    for (const b of day) {
      const pa = asRating(pre.get(b.a)), pb = asRating(pre.get(b.b));
      const resA = b.sa > 0.5 ? 'win' : b.sa < 0.5 ? 'loss' : 'draw';
      push(b.a, { date, boutId: b.id, oppId: b.b, pre: pa, post: asRating(post.get(b.a)), sigma: post.get(b.a).sigma, oppPre: pb, result: resA, ufc: b.ufc });
      push(b.b, { date, boutId: b.id, oppId: b.a, pre: pb, post: asRating(post.get(b.b)), sigma: post.get(b.b).sigma, oppPre: pa, result: resA === 'win' ? 'loss' : resA === 'loss' ? 'win' : 'draw', ufc: b.ufc });
    }
    for (const [id, s] of post) state.set(id, s);
    i = j;
  }

  // State as it stood before any fight on `date` (null = current), RD inflated to that date.
  function stateAsOf(fighterId, date = null) {
    const h = history.get(fighterId);
    const s = fresh(fighterId);
    let cur = { mu: s.mu, phi: s.phi, sigma: s.sigma, last: null }, fights = 0, ufcFights = 0;
    for (const e of h || []) {
      if (date && e.date >= date) break;
      cur = { mu: (e.post.r - 1500) / SCALE, phi: e.post.rd / SCALE, sigma: e.sigma, last: e.date };
      fights++; if (e.ufc) ufcFights++;
    }
    const phi = date ? inflate(cur, date) : cur.phi;
    return { r: 1500 + SCALE * cur.mu, rd: SCALE * phi, fights, ufcFights, seeded: seedOf.has(fighterId) };
  }

  function summaryAsOf(fighterId, date = null) {
    const s = stateAsOf(fighterId, date);
    return { glicko: s.r, glicko_rd: s.rd, glicko_fights: s.fights, glicko_ufc_fights: s.ufcFights };
  }

  // Glicko expected score of A over B from two summaries (uncertainty-aware).
  const expected = (a, b) => E((a.glicko - 1500) / SCALE, (b.glicko - 1500) / SCALE, Math.sqrt(a.glicko_rd ** 2 + b.glicko_rd ** 2) / SCALE);

  return { history, stateAsOf, summaryAsOf, expected, bouts: bouts.length, config: { tau, initialRd, initialVol, periodDays, finishMult, seed, seedSlope, seedOppSlope, seedRdDrop } };
}

/**
 * Serving-side view over the precomputed glicko_ratings table
 * (computeGlickoRatings.js). Same `summaryAsOf(fighterId, date)` contract as
 * computeGlicko so features.sideFeatures cannot tell the two apart: the stored
 * post-last-bout RD is inflated to `date` (default today) exactly as the replay
 * inflates it to a fight date, and an unknown fighter gets the fresh state
 * (1500 / initialRd), which is what training saw for a debutant.
 *
 * PAST dates (fantasy snapshots): when a row carries `history` (post-bout states
 * in date order, written by computeGlickoRatings.js) a `date` on or before the
 * last bout is answered from the last history entry strictly before it, RD
 * inflated from that bout to `date` — the replay's stateAsOf rule. A date
 * before the first bout gives the fresh state. Rows without history fall back
 * to the current state, and `hasHistory` is false so the engine can refuse a
 * snapshot instead of serving a wrong one.
 *
 * @param rows  glicko_ratings rows (fighter_id, rating, rd, volatility, fights, ufc_fights, last_fight_date[, history, peak_rating, peak_date])
 * @param opts  glickoOptions() shape (initialRd, initialVol, periodDays)
 */
function ratingsFromTable(rows, opts = {}) {
  const { initialRd = 350, initialVol = 0.06, periodDays = 365 } = opts;
  const byId = new Map(rows.map(r => [r.fighter_id, r]));
  const hasHistory = rows.some(r => Array.isArray(r.history));
  const inflate = (rd, sigma, from, to) => {
    const t = from ? (new Date(to) - new Date(from)) / 86400000 / periodDays : 1;
    return SCALE * Math.sqrt((rd / SCALE) ** 2 + sigma * sigma * Math.max(0, t));
  };
  function summaryAsOf(fighterId, date = null) {
    const asOf = date || new Date().toISOString().slice(0, 10);
    const r = byId.get(fighterId);
    if (!r) return { glicko: 1500, glicko_rd: inflate(initialRd, initialVol, null, asOf), glicko_fights: 0, glicko_ufc_fights: 0 };
    if (date && Array.isArray(r.history) && r.last_fight_date && date <= r.last_fight_date) {
      let last = null;
      for (const e of r.history) { if (e.d >= date) break; last = e; }
      if (!last) return { glicko: 1500, glicko_rd: inflate(initialRd, initialVol, null, asOf), glicko_fights: 0, glicko_ufc_fights: 0 };
      return { glicko: last.r, glicko_rd: inflate(last.rd, last.s, last.d, asOf), glicko_fights: last.n, glicko_ufc_fights: last.u };
    }
    return { glicko: r.rating, glicko_rd: inflate(r.rd, r.volatility, r.last_fight_date, asOf), glicko_fights: r.fights, glicko_ufc_fights: r.ufc_fights };
  }
  // Highest post-bout rating over the fighter's UFC bouts: { date, rating } or null.
  function peakOf(fighterId) {
    const r = byId.get(fighterId);
    if (!r) return null;
    if (r.peak_date && r.peak_rating != null) return { date: r.peak_date, rating: r.peak_rating };
    if (!Array.isArray(r.history)) return null;
    let best = null;
    for (const e of r.history) if (e.ufc && (!best || e.r > best.r)) best = e;
    return best ? { date: best.d, rating: best.r } : null;
  }
  const currentRating = fighterId => byId.get(fighterId)?.rating ?? 1500;
  return { summaryAsOf, peakOf, currentRating, size: byId.size, fromTable: true, hasHistory };
}

module.exports = { computeGlicko, glickoOptions, ratingsFromTable, collectBouts, SCALE };

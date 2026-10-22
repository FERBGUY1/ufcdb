/**
 * styleEngine.js — point-in-time fighting-style profiles and style-vs-style history.
 *
 * styleProfile(snapshot) turns any statsEngine snapshot (raw career, cutoff
 * at a date, shrunk toward priors — whatever the caller built) into
 * continuous style axes plus a label. Because it reads a snapshot, it is
 * point-in-time whenever the snapshot is, unlike fighters.primary_style
 * (assign-styles.js), which is a current-career heuristic backfilled onto
 * every historical fight. One function serves the model, the Predict and
 * Compare pages, and the Style Matchups page.
 *
 * buildStylePairHistory() replays decided fights in date order, labels each
 * side from its pre-fight snapshot, and records for every fight the
 * historical win rate of A's style against B's style BEFORE that fight
 * (shrunk toward 50%). The final table is what serving uses.
 */

const { snapshot } = require('./statsEngine');

const AXES = ['distance', 'clinch', 'ground', 'wrestling', 'submission', 'control', 'pace'];

/**
 * @param snap  statsEngine.snapshot() output
 * @returns { axes: {distance, clinch, ground (0-100 shares of sig attempts),
 *            wrestling (TD/15), submission (sub att/15), control (% of cage time),
 *            pace (sig att/min proxy = slpm / acc)}, label, hasData }
 */
function styleProfile(snap) {
  if (!snap || !snap.stats_fights) return { axes: Object.fromEntries(AXES.map(a => [a, null])), label: 'Unknown', hasData: false };
  const distance = snap.sig_distance_pct, clinch = snap.sig_clinch_pct, ground = snap.sig_ground_pct;
  const wrestling = snap.td_avg, submission = snap.sub_avg, control = snap.ctrl_pct;
  const pace = snap.slpm != null && snap.str_acc ? snap.slpm / (snap.str_acc / 100) : snap.slpm;
  const axes = { distance, clinch, ground, wrestling, submission, control, pace };

  let label = 'Balanced';
  const td = wrestling ?? 0, sub = submission ?? 0, dist = distance ?? 0, cl = clinch ?? 0, gr = ground ?? 0;
  const slpm = snap.slpm ?? 0, sdef = snap.str_def ?? 0;
  // A high-volume takedown artist whose submissions are a side effect (GSP: 3.9 TD/15,
  // 1.05 sub/15; 4.2 / 1.7 as of 2008) is a Wrestler; Submission grappler needs the
  // submission rate to be at least half the takedown rate.
  if (td >= 3.0 && sub < td / 2) label = 'Wrestler';
  else if (sub >= 1.0 && td >= 1.0) label = 'Submission grappler';
  else if (sub >= 1.2) label = 'Submission hunter';
  else if (td >= 3.0) label = 'Wrestler';
  else if (td >= 1.8 && (gr >= 20 || (control ?? 0) >= 30)) label = 'Grinder';
  else if (cl >= 25) label = 'Clinch fighter';
  else if (slpm >= 5.0 && dist >= 65) label = 'Pressure striker';
  else if (sdef >= 60 && slpm < 4.0 && dist >= 65) label = 'Counter striker';
  else if (dist >= 70 && td < 1.0) label = 'Striker';
  return { axes, label, hasData: true };
}

const shrinkRate = (w, n, k = 20) => (w + 0.5 * k) / (n + k);

/**
 * Replay fights chronologically and build the style-vs-style record.
 *   fights, eventById, timelines  as in trainModel
 *   snapOpts                      options for statsEngine.snapshot (shrink/decay)
 * Returns:
 *   edgeByFight  Map<fightId, edge for DB fighter1 (= winRate(style1 vs style2) - 0.5) as of that fight>
 *   labelByFight Map<fightId, [style1, style2]>
 *   table        { 'A|B': { wins (of A), n } } cumulative over all fights
 *   edgeNow(styleA, styleB)  edge from the final table (serving)
 */
function buildStylePairHistory(fights, eventById, timelines, snapOpts = {}) {
  const table = {};
  const key = (sa, sb) => `${sa}|${sb}`;
  const edge = (sa, sb) => {
    if (sa === sb || sa === 'Unknown' || sb === 'Unknown') return 0;
    const fwd = table[key(sa, sb)] || { wins: 0, n: 0 }, rev = table[key(sb, sa)] || { wins: 0, n: 0 };
    const n = fwd.n + rev.n, wins = fwd.wins + (rev.n - rev.wins);
    return shrinkRate(wins, n) - 0.5;
  };
  const ordered = fights
    .filter(f => f.fighter1_id && f.fighter2_id && eventById[f.event_id] && f.result === 'win' && f.winner_id)
    .map(f => ({ f, date: eventById[f.event_id].date }))
    .sort((p, q) => p.date.localeCompare(q.date) || p.f.id.localeCompare(q.f.id));
  const edgeByFight = new Map(), labelByFight = new Map();
  for (const { f, date } of ordered) {
    const s1 = styleProfile(snapshot(timelines.get(f.fighter1_id) || [], date, null, { ...snapOpts, asOf: date })).label;
    const s2 = styleProfile(snapshot(timelines.get(f.fighter2_id) || [], date, null, { ...snapOpts, asOf: date })).label;
    edgeByFight.set(f.id, edge(s1, s2));
    labelByFight.set(f.id, [s1, s2]);
    if (s1 !== s2 && s1 !== 'Unknown' && s2 !== 'Unknown') {
      const k = key(s1, s2);
      if (!table[k]) table[k] = { wins: 0, n: 0 };
      table[k].n++; if (f.winner_id === f.fighter1_id) table[k].wins++;
    }
  }
  return { edgeByFight, labelByFight, table, edgeNow: edge };
}

module.exports = { AXES, styleProfile, buildStylePairHistory };

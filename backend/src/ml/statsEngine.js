/**
 * statsEngine.js — pure per-fighter statistics computed from fights.rounds_data
 *
 * One computation, three consumers:
 *   - computeCareerStats.js  writes full-career snapshots to the fighters table
 *   - trainModel.js          calls snapshot() with a cutoff date so training
 *                            features only see fights BEFORE the fight being
 *                            predicted (no time leakage)
 *   - predictionEngine.js    live snapshots for the two fighters in a matchup
 *
 * DENOMINATOR RULE: rate stats (SLpM, accuracy, TD defense, ...) sum only over
 * fights that actually carry stats (rounds_data present). Record/experience
 * counts cover all completed fights. Early-era stat gaps therefore never
 * poison averages — they just don't contribute.
 *
 * All percentage outputs are 0-100 (matching the existing fighters columns);
 * per-15-minute rates use seconds actually fought.
 */

const timeToSec = t => {
  const m = (t || '').match(/(\d+):(\d{2})/);
  return m ? +m[1] * 60 + +m[2] : null;
};

// Duration of a fight in seconds. Convention: full rounds are 300s; the final
// round contributes the recorded time. Early no-time-limit fights are stored
// as round 1 + total time, which this handles naturally (time may exceed 5:00).
function fightSeconds(fight) {
  const t = timeToSec(fight.time);
  const r = fight.round || (fight.rounds_data ? fight.rounds_data.length : 1) || 1;
  if (t != null) return (r - 1) * 300 + t;
  return r * 300;
}

function roundSeconds(fight, roundNo) {
  const finalRound = fight.round || (fight.rounds_data ? fight.rounds_data.length : 1);
  if (roundNo < finalRound) return 300;
  const t = timeToSec(fight.time);
  return t != null && t > 0 ? t : 300;
}

/**
 * Build chronological per-fighter timelines from raw fights.
 * Returns Map<fighterId, [{date, fightId, result ('win'|'loss'|'draw'|'nc'),
 *   method, finishRound, seconds, hasStats, me, opp, rounds:[{sec, me, opp}],
 *   isTitle, scheduledRounds}]> sorted by date ascending.
 */
function buildTimelines(fights, eventById) {
  const timelines = new Map();
  const push = (fid, entry) => {
    if (!timelines.has(fid)) timelines.set(fid, []);
    timelines.get(fid).push(entry);
  };

  for (const f of fights) {
    const ev = eventById[f.event_id];
    if (!ev || !f.result || f.result === 'upcoming') continue;

    const seconds = fightSeconds(f);
    const hasStats = Array.isArray(f.rounds_data) && f.rounds_data.length > 0;
    const scheduledRounds = /5 Rnd/i.test(f.time_format || '') ? 5 : 3;

    for (const side of [1, 2]) {
      const meId = side === 1 ? f.fighter1_id : f.fighter2_id;
      const oppId = side === 1 ? f.fighter2_id : f.fighter1_id;
      if (!meId) continue;
      let result;
      if (f.result === 'win') result = f.winner_id === meId ? 'win' : 'loss';
      else if (f.result === 'draw') result = 'draw';
      else result = 'nc';

      const meKey = side === 1 ? 'f1' : 'f2';
      const oppKey = side === 1 ? 'f2' : 'f1';
      const rounds = hasStats ? f.rounds_data.map(r => ({
        no: r.round,
        sec: roundSeconds(f, r.round),
        me: r[meKey] || {},
        opp: r[oppKey] || {},
      })) : [];

      // fight-level sums from rounds (fight totals columns are display strings)
      const sum = (rs, who, key) => {
        let s = 0, any = false;
        for (const r of rs) { const v = r[who][key]; if (v != null) { s += v; any = true; } }
        return any ? s : null;
      };
      const agg = who => ({
        sig_l: sum(rounds, who, 'sig_landed'), sig_a: sum(rounds, who, 'sig_att'),
        tot_l: sum(rounds, who, 'total_landed'), tot_a: sum(rounds, who, 'total_att'),
        td_l: sum(rounds, who, 'td_landed'), td_a: sum(rounds, who, 'td_att'),
        sub: sum(rounds, who, 'sub_att'), kd: sum(rounds, who, 'kd'),
        ctrl: sum(rounds, who, 'ctrl_sec'),
        dist_a: sum(rounds, who, 'distance_att'), clinch_a: sum(rounds, who, 'clinch_att'), ground_a: sum(rounds, who, 'ground_att'),
      });

      push(meId, {
        date: ev.date, fightId: f.id, oppId, result,
        method: f.method || null,
        finishRound: f.round || null,
        weightClassId: f.weight_class_id ?? null,
        seconds, hasStats, scheduledRounds,
        isTitle: !!f.is_title_fight,
        me: hasStats ? agg('me') : null,
        opp: hasStats ? agg('opp') : null,
        rounds,
      });
    }
  }

  for (const arr of timelines.values()) arr.sort((a, b) => a.date.localeCompare(b.date));
  return timelines;
}

const div = (a, b) => (b > 0 && a != null ? a / b : null);
const pct = (a, b) => (b > 0 && a != null ? (a / b) * 100 : null);
const round2 = v => (v == null ? null : Math.round(v * 100) / 100);
const DAY_MS = 86400000;

// Modal weight class across a list of timeline entries (null if none known).
function modalWeightClass(entries) {
  const counts = {};
  for (const e of entries) if (e.weightClassId != null) counts[e.weightClassId] = (counts[e.weightClassId] || 0) + 1;
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? +top[0] : null;
}

/**
 * League-wide prior rates used by snapshot() shrinkage. Computed over every
 * stats-fight dated before cutoffDate (so no evaluation fold ever sees its own
 * era), globally and per weight class. Each side of each fight contributes, so
 * the landed/absorbed priors are symmetric by construction.
 *   minMinutes  a weight class needs this many stats minutes to get its own
 *               prior; otherwise it falls back to the global one
 */
function computePriors(timelines, cutoffDate, { minMinutes = 3000 } = {}) {
  const fresh = () => ({ sec: 0, sig_l: 0, sig_a: 0, opp_sig_l: 0, opp_sig_a: 0, td_l: 0, td_a: 0,
    opp_td_l: 0, opp_td_a: 0, sub: 0, kd: 0, opp_kd: 0, r: {} });
  const acc = { global: fresh(), byWc: {} };
  const add = (S, e) => {
    S.sec += e.seconds;
    const m = e.me, o = e.opp;
    S.sig_l += m.sig_l || 0; S.sig_a += m.sig_a || 0; S.opp_sig_l += o.sig_l || 0; S.opp_sig_a += o.sig_a || 0;
    S.td_l += m.td_l || 0; S.td_a += m.td_a || 0; S.opp_td_l += o.td_l || 0; S.opp_td_a += o.td_a || 0;
    S.sub += m.sub || 0; S.kd += m.kd || 0; S.opp_kd += o.kd || 0;
    for (const r of e.rounds) {
      if (r.no > 5 || r.me.sig_att == null) continue;
      if (!S.r[r.no]) S.r[r.no] = { att: 0, sec: 0 };
      S.r[r.no].att += r.me.sig_att; S.r[r.no].sec += r.sec;
    }
  };
  for (const tl of timelines.values()) {
    for (const e of tl) {
      if (!e.hasStats || (cutoffDate && e.date >= cutoffDate)) continue;
      add(acc.global, e);
      if (e.weightClassId != null) {
        if (!acc.byWc[e.weightClassId]) acc.byWc[e.weightClassId] = fresh();
        add(acc.byWc[e.weightClassId], e);
      }
    }
  }
  const finish = S => {
    const min = S.sec / 60;
    const p = {
      minutes: min,
      slpm: S.sig_l / min, sapm: S.opp_sig_l / min,
      sig_att_pm: S.sig_a / min, opp_sig_att_pm: S.opp_sig_a / min,
      str_acc: 100 * S.sig_l / S.sig_a, str_def: 100 * (1 - S.opp_sig_l / S.opp_sig_a),
      td_avg: 900 * S.td_l / S.sec, td_att_pm: S.td_a / min, opp_td_att_pm: S.opp_td_a / min,
      td_acc: 100 * S.td_l / S.td_a, td_def: 100 * (1 - S.opp_td_l / S.opp_td_a),
      sub_avg: 900 * S.sub / S.sec, kd_per15: 900 * S.kd / S.sec, kd_absorbed_per15: 900 * S.opp_kd / S.sec,
    };
    for (let r = 1; r <= 5; r++) p['r' + r] = S.r[r] && S.r[r].sec > 0 ? S.r[r].att / (S.r[r].sec / 60) : null;
    return p;
  };
  const priors = { cutoffDate: cutoffDate || null, global: finish(acc.global), byWc: {} };
  for (const [wc, S] of Object.entries(acc.byWc)) if (S.sec / 60 >= minMinutes) priors.byWc[wc] = finish(S);
  return priors;
}

/**
 * Aggregate a fighter's timeline into a stat snapshot.
 *   cutoffDate  only fights strictly before this ISO date (null = all)
 *   lastN       only the most recent N stats-fights (after cutoff filter)
 *   opts        model-path options; all default OFF so computeCareerStats and
 *               the fighter pages keep raw career numbers:
 *     asOf           ISO date that recency decay measures back from
 *                    (defaults to cutoffDate; no decay when neither is set)
 *     halfLifeDays   exponential decay half-life for stats-fight sums
 *     shrinkMinutes  pseudo-minutes of league-prior performance mixed into
 *                    every rate stat (k). 0 = raw. Accuracy stats use the
 *                    prior's attempts-per-minute to turn k into pseudo-attempts
 *     priors         output of computePriors(); required when shrinkMinutes > 0
 */
function snapshot(timeline, cutoffDate = null, lastN = null, opts = {}) {
  const { halfLifeDays = 0, shrinkMinutes = 0, priors = null } = opts;
  const asOf = opts.asOf || cutoffDate || null;
  let fights = cutoffDate ? timeline.filter(e => e.date < cutoffDate) : timeline.slice();
  const allCompleted = fights;
  let statsFights = fights.filter(e => e.hasStats);
  if (lastN) statsFights = statsFights.slice(-lastN);

  const rec = { wins: 0, losses: 0, draws: 0, nc: 0 };
  for (const e of allCompleted) {
    if (e.result === 'win') rec.wins++;
    else if (e.result === 'loss') rec.losses++;
    else if (e.result === 'draw') rec.draws++;
    else rec.nc++;
  }

  // recency weight per fight (1 when decay is off)
  const asOfMs = asOf ? new Date(asOf).getTime() : null;
  const weightOf = e => (halfLifeDays > 0 && asOfMs != null
    ? Math.pow(0.5, Math.max(0, (asOfMs - new Date(e.date).getTime()) / DAY_MS) / halfLifeDays)
    : 1);

  // (weighted) sums over stats-fights only
  const S = { sec: 0, rawSec: 0, sig_l: 0, sig_a: 0, opp_sig_l: 0, opp_sig_a: 0, td_l: 0, td_a: 0,
              opp_td_l: 0, opp_td_a: 0, sub: 0, kd: 0, opp_kd: 0,
              ctrl: 0, ctrl_sec_base: 0, dist_a: 0, clinch_a: 0, ground_a: 0 };
  const roundOut = {}; // roundNo -> {att, sec}
  // what the opponents faced typically do/allow (minutes-weighted, decayed) —
  // filled from e.oppPrior, set by annotateOpponentPriors()
  const O = { sec: 0, slpm: 0, sapm: 0, td_def: 0 };
  let recWins = 0, recLosses = 0;

  for (const e of statsFights) {
    const wgt = weightOf(e);
    S.sec += e.seconds * wgt; S.rawSec += e.seconds;
    if (e.oppPrior) {
      const ws = e.seconds * wgt;
      O.sec += ws; O.slpm += e.oppPrior.slpm * ws; O.sapm += e.oppPrior.sapm * ws; O.td_def += e.oppPrior.td_def * ws;
    }
    const m = e.me, o = e.opp;
    S.sig_l += (m.sig_l || 0) * wgt; S.sig_a += (m.sig_a || 0) * wgt;
    S.opp_sig_l += (o.sig_l || 0) * wgt; S.opp_sig_a += (o.sig_a || 0) * wgt;
    S.td_l += (m.td_l || 0) * wgt; S.td_a += (m.td_a || 0) * wgt;
    S.opp_td_l += (o.td_l || 0) * wgt; S.opp_td_a += (o.td_a || 0) * wgt;
    S.sub += (m.sub || 0) * wgt; S.kd += (m.kd || 0) * wgt; S.opp_kd += (o.kd || 0) * wgt;
    if (m.ctrl != null) { S.ctrl += m.ctrl * wgt; S.ctrl_sec_base += e.seconds * wgt; }
    S.dist_a += (m.dist_a || 0) * wgt; S.clinch_a += (m.clinch_a || 0) * wgt; S.ground_a += (m.ground_a || 0) * wgt;
    if (e.result === 'win') recWins++; else if (e.result === 'loss') recLosses++;
    for (const r of e.rounds) {
      if (r.no > 5 || r.me.sig_att == null) continue;
      if (!roundOut[r.no]) roundOut[r.no] = { att: 0, sec: 0 };
      roundOut[r.no].att += r.me.sig_att * wgt;
      roundOut[r.no].sec += r.sec * wgt;
    }
  }

  // shrinkage toward the league prior: (num + k*prior) / (den + k)
  const k = shrinkMinutes > 0 && priors ? shrinkMinutes : 0;
  const wc = k ? modalWeightClass(fights) : null;
  const P = k ? (wc != null && priors.byWc[wc]) || priors.global : null;
  const shr = (num, den, prior, kk) => (kk > 0 ? (num + kk * prior) / (den + kk) : div(num, den));
  const shrPct = (num, den, priorPct, kk) => (kk > 0 ? 100 * (num + kk * priorPct / 100) / (den + kk) : pct(num, den));

  const min = S.sec / 60;
  const per15 = v => (S.sec > 0 ? (v / S.sec) * 900 : null);
  const rate15 = (v, prior) => (k ? 15 * (v + (k / 15) * prior) / (min + k) : per15(v));
  const cardio = {};
  for (let r = 1; r <= 5; r++) {
    const ro = roundOut[r];
    if (k) {
      const prior = P['r' + r] ?? priors.global['r' + r] ?? P.sig_att_pm;
      cardio['r' + r] = prior != null ? round2(shr(ro ? ro.att : 0, ro ? ro.sec / 60 : 0, prior, k / 3)) : null;
    } else {
      cardio['r' + r] = ro && ro.sec > 0 ? round2(ro.att / (ro.sec / 60)) : null;
    }
  }
  const degradation = cardio.r1 && cardio.r3 != null ? round2(((cardio.r1 - cardio.r3) / cardio.r1) * 100) : null;

  // finish-timing stats over ALL completed fights (they don't need round stats)
  const wins = allCompleted.filter(e => e.result === 'win');
  const losses = allCompleted.filter(e => e.result === 'loss');
  const lateWins = wins.filter(e => (e.finishRound || 0) >= 3).length;
  const lateLosses = losses.filter(e => (e.finishRound || 0) >= 3).length;
  const champRounds = allCompleted.filter(e => (e.finishRound || 0) >= 4);
  const champRec = champRounds.length
    ? `${champRounds.filter(e => e.result === 'win').length}-${champRounds.filter(e => e.result === 'loss').length}`
    : null;

  const styleDen = S.dist_a + S.clinch_a + S.ground_a;
  const lastFight = allCompleted[allCompleted.length - 1] || null;

  // Opponent-adjusted striking/wrestling: own rate minus what the opponents
  // faced typically allowed (or landed). Opponents without prior stats fall
  // back to the league prior when one is supplied, so a debut-heavy slate is
  // adjusted against an average opponent rather than dropped.
  const slpm = round2(shr(S.sig_l, min, k ? P.slpm : 0, k));
  const sapm = round2(shr(S.opp_sig_l, min, k ? P.sapm : 0, k));
  const td_avg = round2(rate15(S.td_l, k ? P.td_avg : 0));
  const G = priors ? priors.global : null;
  const oppExp = key => {
    const known = O.sec > 0 ? O[key] / O.sec : null;
    if (!G) return known;
    const unknownSec = Math.max(0, S.sec - O.sec);
    return S.sec > 0 ? ((known ?? 0) * O.sec + G[key] * unknownSec) / S.sec : G[key];
  };
  const oppSapm = oppExp('sapm'), oppSlpm = oppExp('slpm'), oppTdDef = oppExp('td_def');

  return {
    opp_exp_sapm: round2(oppSapm), opp_exp_slpm: round2(oppSlpm), opp_exp_td_def: round2(oppTdDef),
    slpm_adj: slpm != null && oppSapm != null ? round2(slpm - oppSapm) : null,
    sapm_adj: sapm != null && oppSlpm != null ? round2(sapm - oppSlpm) : null,
    // takedowns landed, rescaled to a league-average takedown defense
    td_avg_adj: td_avg != null && oppTdDef != null && G && oppTdDef < 100
      ? round2(td_avg * ((100 - G.td_def) / (100 - oppTdDef))) : null,
    record: rec,
    total_fights: allCompleted.length,
    stats_fights: statsFights.length,
    stats_seconds: S.rawSec,
    stats_seconds_weighted: S.sec,
    prior_weight_class: wc,
    slpm, sapm,
    str_acc: round2(shrPct(S.sig_l, S.sig_a, k ? P.str_acc : 0, k ? k * P.sig_att_pm : 0)),
    str_def: round2(k
      ? shrPct(S.opp_sig_a - S.opp_sig_l, S.opp_sig_a, P.str_def, k * P.opp_sig_att_pm)
      : (S.opp_sig_a > 0 ? 100 - (S.opp_sig_l / S.opp_sig_a) * 100 : null)),
    td_avg,
    td_acc: round2(shrPct(S.td_l, S.td_a, k ? P.td_acc : 0, k ? k * P.td_att_pm : 0)),
    td_def: round2(k
      ? shrPct(S.opp_td_a - S.opp_td_l, S.opp_td_a, P.td_def, k * P.opp_td_att_pm)
      : (S.opp_td_a > 0 ? 100 - (S.opp_td_l / S.opp_td_a) * 100 : null)),
    sub_avg: round2(rate15(S.sub, k ? P.sub_avg : 0)),
    kd_per15: round2(rate15(S.kd, k ? P.kd_per15 : 0)),
    kd_absorbed_per15: round2(rate15(S.opp_kd, k ? P.kd_absorbed_per15 : 0)),
    ctrl_pct: round2(pct(S.ctrl, S.ctrl_sec_base)),
    sig_distance_pct: round2(pct(S.dist_a, styleDen)),
    sig_clinch_pct: round2(pct(S.clinch_a, styleDen)),
    sig_ground_pct: round2(pct(S.ground_a, styleDen)),
    cardio,
    cardio_degradation: degradation,
    late_finish_rate: round2(pct(lateWins, wins.length)),
    late_loss_rate: round2(pct(lateLosses, losses.length)),
    championship_round_record: champRec,
    stats_win_rate: round2(pct(recWins, recWins + recLosses)),
    last_fight_date: lastFight ? lastFight.date : null,
  };
}

/**
 * Attach to every stats-fight entry the opponent's RAW career rates as they
 * stood before that fight (e.oppPrior = {slpm, sapm, td_avg, td_def}), or
 * null when the opponent had no prior stats. Point-in-time by construction:
 * the opponent snapshot is cut off at the fight date. Mutates the timelines
 * in place and returns them.
 */
function annotateOpponentPriors(timelines) {
  for (const tl of timelines.values()) {
    for (const e of tl) {
      if (!e.hasStats || !e.oppId) { e.oppPrior = null; continue; }
      const oppTl = timelines.get(e.oppId);
      if (!oppTl) { e.oppPrior = null; continue; }
      const s = snapshot(oppTl, e.date);
      e.oppPrior = s.stats_fights > 0 && s.slpm != null && s.sapm != null && s.td_def != null
        ? { slpm: s.slpm, sapm: s.sapm, td_avg: s.td_avg, td_def: s.td_def }
        : null;
    }
  }
  return timelines;
}

module.exports = { buildTimelines, snapshot, computePriors, annotateOpponentPriors, fightSeconds };

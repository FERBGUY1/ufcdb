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

/**
 * Aggregate a fighter's timeline into a stat snapshot.
 *   cutoffDate  only fights strictly before this ISO date (null = all)
 *   lastN       only the most recent N stats-fights (after cutoff filter)
 */
function snapshot(timeline, cutoffDate = null, lastN = null) {
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

  // sums over stats-fights only
  const S = { sec: 0, sig_l: 0, sig_a: 0, opp_sig_l: 0, opp_sig_a: 0, td_l: 0, td_a: 0,
              opp_td_l: 0, opp_td_a: 0, sub: 0, kd: 0, opp_kd: 0,
              ctrl: 0, ctrl_sec_base: 0, dist_a: 0, clinch_a: 0, ground_a: 0 };
  const roundOut = {}; // roundNo -> {att, sec}
  let recWins = 0, recLosses = 0;

  for (const e of statsFights) {
    S.sec += e.seconds;
    const m = e.me, o = e.opp;
    S.sig_l += m.sig_l || 0; S.sig_a += m.sig_a || 0;
    S.opp_sig_l += o.sig_l || 0; S.opp_sig_a += o.sig_a || 0;
    S.td_l += m.td_l || 0; S.td_a += m.td_a || 0;
    S.opp_td_l += o.td_l || 0; S.opp_td_a += o.td_a || 0;
    S.sub += m.sub || 0; S.kd += m.kd || 0; S.opp_kd += o.kd || 0;
    if (m.ctrl != null) { S.ctrl += m.ctrl; S.ctrl_sec_base += e.seconds; }
    S.dist_a += m.dist_a || 0; S.clinch_a += m.clinch_a || 0; S.ground_a += m.ground_a || 0;
    if (e.result === 'win') recWins++; else if (e.result === 'loss') recLosses++;
    for (const r of e.rounds) {
      if (r.no > 5 || r.me.sig_att == null) continue;
      if (!roundOut[r.no]) roundOut[r.no] = { att: 0, sec: 0 };
      roundOut[r.no].att += r.me.sig_att;
      roundOut[r.no].sec += r.sec;
    }
  }

  const min = S.sec / 60;
  const per15 = v => (S.sec > 0 ? (v / S.sec) * 900 : null);
  const cardio = {};
  for (let r = 1; r <= 5; r++) {
    cardio['r' + r] = roundOut[r] && roundOut[r].sec > 0 ? round2(roundOut[r].att / (roundOut[r].sec / 60)) : null;
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

  return {
    record: rec,
    total_fights: allCompleted.length,
    stats_fights: statsFights.length,
    stats_seconds: S.sec,
    slpm: round2(div(S.sig_l, min)),
    sapm: round2(div(S.opp_sig_l, min)),
    str_acc: round2(pct(S.sig_l, S.sig_a)),
    str_def: round2(S.opp_sig_a > 0 ? 100 - (S.opp_sig_l / S.opp_sig_a) * 100 : null),
    td_avg: round2(per15(S.td_l)),
    td_acc: round2(pct(S.td_l, S.td_a)),
    td_def: round2(S.opp_td_a > 0 ? 100 - (S.opp_td_l / S.opp_td_a) * 100 : null),
    sub_avg: round2(per15(S.sub)),
    kd_per15: round2(per15(S.kd)),
    kd_absorbed_per15: round2(per15(S.opp_kd)),
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

module.exports = { buildTimelines, snapshot, fightSeconds };

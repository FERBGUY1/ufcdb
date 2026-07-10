import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getFight, formatOdds } from '../lib/api';

export default function FightPage() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getFight(id).then(setData).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="p-8 text-center text-white/30">Loading fight...</div>;
  if (!data?.fight) return <div className="p-8 text-center text-white/30">Fight not found</div>;

  const { fight } = data;
  const f1 = fight.fighter1;
  const f2 = fight.fighter2;
  const f1Won = fight.result === 'win';
  const isDraw = fight.result === 'draw';
  const isNC   = fight.result === 'no_contest';
  const isUpcoming = fight.result === 'upcoming' || !fight.result;

  const fmtMethod = (m) => {
    if (!m) return '--';
    const mu = m.toUpperCase();
    if (mu === 'KO/TKO' || mu === 'TKO' || mu === 'KO') return 'KO/TKO';
    if (mu === 'SUB' || mu === 'SUBMISSION') return 'Submission';
    if (mu === 'U-DEC' || mu === 'UDEC') return 'Unanimous Decision';
    if (mu === 'S-DEC' || mu === 'SDEC') return 'Split Decision';
    if (mu === 'M-DEC') return 'Majority Decision';
    return m;
  };

  const odds = fight.odds?.[0];
  const f1Odds = odds?.fighter1_odds;
  const f2Odds = odds?.fighter2_odds;

  const rounds = Array.isArray(fight.rounds_data) ? fight.rounds_data : [];
  const hasRounds = rounds.length > 0;
  const scores = [fight.judge1_score, fight.judge2_score, fight.judge3_score].map(parseScore).filter(Boolean);
  const hasScores = scores.length > 0;

  return (
    <main className="max-w-4xl mx-auto px-4 py-8">
      {fight.events && (
        <Link to={`/events/${fight.events.slug}`} className="text-white/30 text-sm hover:text-white">
          ← {fight.events.name}
        </Link>
      )}

      <div className="mt-6 card overflow-hidden">
        {/* Fight header */}
        <div className="grid grid-cols-[1fr_auto_1fr] gap-4 p-6 border-b border-white/[0.06]">
          {/* Fighter 1 */}
          <div className="text-center">
            <Link to={`/fighters/${f1?.slug}`}
              className={`font-display text-2xl sm:text-3xl tracking-wider hover:text-gold block mb-1 ${
                f1Won ? 'text-win' : isDraw ? '' : isUpcoming ? '' : 'text-white/40'
              }`}>
              {f1?.first_name?.toUpperCase()}<br />{f1?.last_name?.toUpperCase()}
            </Link>
            {f1Won && <span className="text-xs text-win uppercase tracking-wider">Winner</span>}
            {isDraw && <span className="text-xs text-white/40">Draw</span>}
            {f1Odds && (
              <div className={`mt-1 text-sm font-medium ${f1Odds < 0 ? 'text-gold' : 'text-red-400'}`}>
                {formatOdds(f1Odds)}
              </div>
            )}
          </div>

          {/* Result center */}
          <div className="flex flex-col items-center justify-center min-w-[100px]">
            {isUpcoming ? (
              <span className="font-display text-2xl text-white/20">VS</span>
            ) : (
              <>
                {isDraw && <div className="text-xl font-display text-white/50">DRAW</div>}
                {isNC   && <div className="text-xl font-display text-white/50">NC</div>}
                {!isDraw && !isNC && (
                  <div className="text-center">
                    <div className="text-sm font-medium text-white/80 mb-1">{fmtMethod(fight.method)}</div>
                    {fight.method_detail && (
                      <div className="text-xs text-white/40 mb-1">{fight.method_detail}</div>
                    )}
                    {fight.round && (
                      <div className="text-xs text-white/30">
                        Round {fight.round}{fight.time ? ` · ${fight.time}` : ''}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Fighter 2 */}
          <div className="text-center">
            <Link to={`/fighters/${f2?.slug}`}
              className={`font-display text-2xl sm:text-3xl tracking-wider hover:text-gold block mb-1 ${
                isUpcoming ? '' : f1Won ? 'text-white/40' : isDraw ? '' : 'text-white/40'
              }`}>
              {f2?.first_name?.toUpperCase()}<br />{f2?.last_name?.toUpperCase()}
            </Link>
            {f2Odds && (
              <div className={`mt-1 text-sm font-medium ${f2Odds < 0 ? 'text-gold' : 'text-red-400'}`}>
                {formatOdds(f2Odds)}
              </div>
            )}
          </div>
        </div>

        {/* Event info */}
        {fight.events && (
          <div className="px-6 py-3 border-b border-white/[0.04] text-sm text-white/40 text-center">
            {fight.events.name} · {fight.events.date}
            {fight.events.city && ` · ${fight.events.city}`}
          </div>
        )}

        {/* Judges' scorecards (decisions) */}
        {hasScores && <Scorecards scores={scores} f1={f1} f2={f2} />}

        {/* Per-round statistical breakdown */}
        {hasRounds ? (
          <RoundBreakdown rounds={rounds} f1={f1} f2={f2} f1Won={f1Won} />
        ) : (fight.fighter1_sig_str || fight.fighter1_td) && (
          <div className="p-6 border-b border-white/[0.06]">
            <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-4 text-center">Fight Statistics</div>
            <div className="space-y-3">
              {fight.fighter1_sig_str && <StatRow label="Significant Strikes" f1={fight.fighter1_sig_str} f2={fight.fighter2_sig_str} />}
              {fight.fighter1_td && <StatRow label="Takedowns" f1={fight.fighter1_td} f2={fight.fighter2_td} />}
            </div>
          </div>
        )}

        {/* Records at time of fight */}
        {(fight.fighter1_record_at_fight || fight.fighter2_record_at_fight) && (
          <div className="px-6 py-4 border-b border-white/[0.06]">
            <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-3 text-center">Record at Time of Fight</div>
            <div className="grid grid-cols-2 gap-4 text-center text-sm">
              <div className="text-white/60">{fight.fighter1_record_at_fight || '--'}</div>
              <div className="text-white/60">{fight.fighter2_record_at_fight || '--'}</div>
            </div>
          </div>
        )}

        {/* Odds history */}
        {fight.odds?.length > 1 && (
          <div className="px-6 py-4">
            <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-3">Odds History</div>
            {fight.odds.map((o, i) => (
              <div key={i} className="flex justify-between text-xs py-1 border-b border-white/[0.03] last:border-0">
                <span className="text-white/30">{o.line_type}</span>
                <span className={o.fighter1_odds < 0 ? 'text-gold' : 'text-red-400'}>{f1?.last_name} {formatOdds(o.fighter1_odds)}</span>
                <span className={o.fighter2_odds < 0 ? 'text-gold' : 'text-red-400'}>{f2?.last_name} {formatOdds(o.fighter2_odds)}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Compare link */}
      {f1 && f2 && (
        <div className="mt-6 text-center">
          <Link to={`/compare?fighter1=${f1.slug}&fighter2=${f2.slug}`} className="btn-outline px-6 py-2.5 text-sm">
            Full Stat Comparison →
          </Link>
        </div>
      )}
    </main>
  );
}

// ── PER-ROUND BREAKDOWN + SCORECARDS ─────────────────────────────
// Fed by fights.rounds_data (per-round f1/f2 stat objects) and the
// judge*_score columns ("Name: 30-27", stored fighter1-first).

const parseScore = (s) => {
  const m = (s || '').match(/^(.*?):\s*(\d+)\s*[-–]\s*(\d+)\s*$/);
  return m ? { name: m[1].trim(), s1: +m[2], s2: +m[3] } : null;
};

const fmtCtrl = (sec) => {
  if (sec == null) return '--';
  const m = Math.floor(sec / 60), s = sec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
};

const AGG_KEYS = [
  'kd', 'sub_att', 'rev', 'ctrl_sec',
  'sig_landed', 'sig_att', 'total_landed', 'total_att', 'td_landed', 'td_att',
  'head_landed', 'body_landed', 'leg_landed',
  'distance_landed', 'clinch_landed', 'ground_landed',
];

// Sum a fighter's stats across a set of rounds. Always returns a zero-filled
// object; per-row rendering keys off has() so early-era null gaps just hide
// the rows that have no data (e.g. control time / positional breakdown).
function aggRounds(roundSet, who) {
  const out = Object.fromEntries(AGG_KEYS.map(k => [k, 0]));
  for (const r of roundSet) {
    const d = r?.[who];
    if (!d) continue;
    for (const k of AGG_KEYS) if (d[k] != null) out[k] += d[k];
  }
  return out;
}

function RoundBreakdown({ rounds, f1, f2, f1Won }) {
  const [tab, setTab] = useState('total');
  const scope = tab === 'total' ? rounds : [rounds[tab]];
  const a = aggRounds(scope, 'f1');
  const b = aggRounds(scope, 'f2');

  const acc = (l, at) => (at > 0 ? `${l} of ${at} · ${Math.round((l / at) * 100)}%` : `${l} of ${at}`);
  const has = (k) => (a[k] || 0) + (b[k] || 0) > 0;
  const hasTarget = has('head_landed') || has('body_landed') || has('leg_landed');
  const hasPosition = has('distance_landed') || has('clinch_landed') || has('ground_landed');

  return (
    <div className="p-6 border-b border-white/[0.06]">
      {/* fighter labels so left/right is unambiguous */}
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 mb-4">
        <div className={`text-right text-xs font-medium truncate ${f1Won ? 'text-gold' : 'text-white/60'}`}>{f1?.last_name}</div>
        <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase text-center px-2">Stats</div>
        <div className="text-left text-xs font-medium truncate text-white/60">{f2?.last_name}</div>
      </div>

      {/* round tabs (redundant when a fight has a single scored round) */}
      {rounds.length > 1 && (
        <div className="flex flex-wrap justify-center gap-1 mb-5">
          <TabBtn active={tab === 'total'} onClick={() => setTab('total')}>Total</TabBtn>
          {rounds.map((r, i) => (
            <TabBtn key={i} active={tab === i} onClick={() => setTab(i)}>R{r.round ?? i + 1}</TabBtn>
          ))}
        </div>
      )}

      <div className="space-y-3.5">
        <CompareStat label="Sig. Strikes" v1={a.sig_landed} v2={b.sig_landed}
          sub1={acc(a.sig_landed, a.sig_att)} sub2={acc(b.sig_landed, b.sig_att)} big />
        <CompareStat label="Total Strikes" v1={a.total_landed} v2={b.total_landed}
          sub1={`of ${a.total_att}`} sub2={`of ${b.total_att}`} />
        <CompareStat label="Takedowns" v1={a.td_landed} v2={b.td_landed}
          sub1={acc(a.td_landed, a.td_att)} sub2={acc(b.td_landed, b.td_att)} />
        {has('ctrl_sec') && (
          <CompareStat label="Control Time" v1={a.ctrl_sec} v2={b.ctrl_sec}
            fmt={fmtCtrl} />
        )}
        <div className="grid grid-cols-3 gap-3 pt-1">
          <MiniStat label="Knockdowns" v1={a.kd} v2={b.kd} />
          <MiniStat label="Sub Att" v1={a.sub_att} v2={b.sub_att} />
          <MiniStat label="Reversals" v1={a.rev} v2={b.rev} />
        </div>
      </div>

      {hasTarget && (
        <StatGroup title="Significant Strikes by Target">
          <CompareStat label="Head" v1={a.head_landed} v2={b.head_landed} />
          <CompareStat label="Body" v1={a.body_landed} v2={b.body_landed} />
          <CompareStat label="Leg"  v1={a.leg_landed}  v2={b.leg_landed} />
        </StatGroup>
      )}

      {hasPosition && (
        <StatGroup title="Significant Strikes by Position">
          <CompareStat label="Distance" v1={a.distance_landed} v2={b.distance_landed} />
          <CompareStat label="Clinch"   v1={a.clinch_landed}   v2={b.clinch_landed} />
          <CompareStat label="Ground"   v1={a.ground_landed}   v2={b.ground_landed} />
        </StatGroup>
      )}
    </div>
  );
}

function TabBtn({ active, onClick, children }) {
  return (
    <button onClick={onClick}
      className={`text-[10px] tracking-[0.15em] uppercase px-3 py-1.5 rounded-md transition-colors ${
        active ? 'bg-gold/15 text-gold' : 'text-white/30 hover:text-white/60 hover:bg-white/[0.04]'
      }`}>
      {children}
    </button>
  );
}

function StatGroup({ title, children }) {
  return (
    <div className="mt-6 pt-5 border-t border-white/[0.05]">
      <div className="text-[10px] tracking-[0.15em] text-white/30 uppercase mb-3.5 text-center">{title}</div>
      <div className="space-y-3.5">{children}</div>
    </div>
  );
}

// Center-out comparison bar. v1/v2 drive the bar; fmt formats the displayed
// number; the leader's number is highlighted gold.
function CompareStat({ label, v1, v2, sub1, sub2, fmt, big }) {
  const a = v1 || 0, b = v2 || 0, tot = a + b;
  const p1 = tot > 0 ? (a / tot) * 100 : 50;
  const disp = (v) => (fmt ? fmt(v) : (v ?? 0));
  const numCls = big ? 'text-lg' : 'text-sm';
  return (
    <div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-baseline gap-3 mb-1.5">
        <div className={`text-right font-medium tabular-nums ${numCls} ${a > b ? 'text-gold' : 'text-white/70'}`}>
          {disp(v1)}
          {sub1 && <span className="block text-[10px] font-normal text-white/30">{sub1}</span>}
        </div>
        <div className="text-[10px] tracking-[0.15em] text-white/30 uppercase text-center whitespace-nowrap px-1">{label}</div>
        <div className={`text-left font-medium tabular-nums ${numCls} ${b > a ? 'text-gold' : 'text-white/70'}`}>
          {disp(v2)}
          {sub2 && <span className="block text-[10px] font-normal text-white/30">{sub2}</span>}
        </div>
      </div>
      <div className="flex h-1.5 rounded-full overflow-hidden bg-dark-5">
        <div className="bg-gold/80 transition-all duration-500" style={{ width: `${p1}%` }} />
        <div className="bg-white/20 transition-all duration-500" style={{ width: `${100 - p1}%` }} />
      </div>
    </div>
  );
}

function MiniStat({ label, v1, v2 }) {
  return (
    <div className="text-center rounded-lg bg-white/[0.02] border border-white/[0.05] py-2">
      <div className="flex items-center justify-center gap-2 font-display text-lg tabular-nums">
        <span className={v1 > v2 ? 'text-gold' : 'text-white/60'}>{v1 ?? 0}</span>
        <span className="text-white/15 text-xs">/</span>
        <span className={v2 > v1 ? 'text-gold' : 'text-white/60'}>{v2 ?? 0}</span>
      </div>
      <div className="text-[9px] tracking-[0.15em] text-white/30 uppercase mt-0.5">{label}</div>
    </div>
  );
}

function Scorecards({ scores, f1, f2 }) {
  return (
    <div className="p-6 border-b border-white/[0.06]">
      <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-4 text-center">Judges' Scorecards</div>
      <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 mb-3 max-w-md mx-auto">
        <div className="text-right text-xs font-medium text-white/50 truncate">{f1?.last_name}</div>
        <div className="w-28" />
        <div className="text-left text-xs font-medium text-white/50 truncate">{f2?.last_name}</div>
      </div>
      <div className="space-y-2.5 max-w-md mx-auto">
        {scores.map((j, i) => (
          <div key={i} className="grid grid-cols-[1fr_auto_1fr] items-center gap-3">
            <div className={`text-right font-display text-2xl tabular-nums ${j.s1 > j.s2 ? 'text-gold' : 'text-white/40'}`}>{j.s1}</div>
            <div className="text-[10px] text-white/40 text-center w-28 truncate">{j.name}</div>
            <div className={`text-left font-display text-2xl tabular-nums ${j.s2 > j.s1 ? 'text-gold' : 'text-white/40'}`}>{j.s2}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatRow({ label, f1, f2 }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
      <div className="text-sm font-medium text-right text-white/70">{f1 || '--'}</div>
      <div className="text-[10px] text-white/30 text-center w-32">{label}</div>
      <div className="text-sm font-medium text-white/70">{f2 || '--'}</div>
    </div>
  );
}

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

        {/* Fight stats */}
        {(fight.fighter1_sig_str || fight.fighter1_td) && (
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

function StatRow({ label, f1, f2 }) {
  return (
    <div className="grid grid-cols-[1fr_auto_1fr] gap-2 items-center">
      <div className="text-sm font-medium text-right text-white/70">{f1 || '--'}</div>
      <div className="text-[10px] text-white/30 text-center w-32">{label}</div>
      <div className="text-sm font-medium text-white/70">{f2 || '--'}</div>
    </div>
  );
}

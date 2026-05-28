import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getEvent, formatOdds } from '../lib/api';

export default function EventPage() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    getEvent(slug).then(setData).finally(() => setLoading(false));
  }, [slug]);

  if (loading) return <div className="p-8 text-center text-white/30">Loading event...</div>;
  if (!data) return <div className="p-8 text-center text-white/30">Event not found</div>;

  const { event: e, fights } = data;

  const hasCardPos = fights.some(f => f.card_position);
  let sections;


  // bout_order=0 is main event; ascending puts headliner first in every section
  const byBoutOrder = arr => [...arr].sort((a, b) => (a.bout_order ?? 999) - (b.bout_order ?? 999));

  if (hasCardPos) {
    const main   = byBoutOrder(fights.filter(f => f.card_position === 'main_card'));
    const prelim = byBoutOrder(fights.filter(f => f.card_position === 'prelim'));
    const early  = byBoutOrder(fights.filter(f => f.card_position === 'early_prelim'));
    const other  = byBoutOrder(fights.filter(f => !f.card_position));
    const mainAll = [...main, ...other];

    sections = [
      mainAll.length > 0  ? { title: 'Main Card', fights: mainAll }       : null,
      prelim.length > 0   ? { title: 'Preliminary Card', fights: prelim } : null,
      early.length > 0    ? { title: 'Early Prelims', fights: early }     : null,
    ].filter(Boolean);
  } else {
    const mainEvent = fights.filter(f => f.bout_order === 0);
    const coMain    = fights.filter(f => f.bout_order === 1);
    const rest      = fights.filter(f => f.bout_order == null || f.bout_order > 1);

    sections = [
      mainEvent.length > 0 ? { title: 'Main Event', fights: mainEvent }  : null,
      coMain.length > 0    ? { title: 'Co-Main Event', fights: coMain }  : null,
      rest.length > 0      ? { title: 'Fight Card', fights: rest }       : null,
      mainEvent.length === 0 && coMain.length === 0 && rest.length === 0
        ? { title: 'Fight Card', fights } : null,
    ].filter(Boolean);
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <Link to="/events" className="text-white/30 text-sm hover:text-white">&larr; Events</Link>

      <div className="mt-4 mb-8">
        <div className="text-[10px] tracking-[0.3em] text-gold uppercase mb-2">{e.date}</div>
        <h1 className="font-display text-4xl tracking-[0.08em] mb-1">{e.name}</h1>
        {(e.venue || e.city) && (
          <p className="text-white/40 mt-2 text-sm">{[e.venue, e.city, e.country].filter(Boolean).join(' · ')}</p>
        )}
        <p className="text-white/20 text-xs mt-1">{fights.length} bout{fights.length !== 1 ? 's' : ''}</p>
      </div>

      {sections.map(s => (
        <FightSection key={s.title} title={s.title} fights={s.fights} />
      ))}
    </main>
  );
}

function FightSection({ title, fights }) {
  if (!fights.length) return null;
  return (
    <div className="mb-8">
      <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-3">{title}</div>
      <div className="space-y-2">
        {fights.map(fight => <FightItem key={fight.id} fight={fight} />)}
      </div>
    </div>
  );
}

function FightItem({ fight }) {
  const f1 = fight.fighter1;
  const f2 = fight.fighter2;
  const f1Won = fight.result === 'win';
  const f2Won = false;
  const isDraw = fight.result === 'draw';
  const isNC   = fight.result === 'no_contest';
  const isUpcoming = fight.result === 'upcoming' || !fight.result;

  const odds = fight.odds?.[0];

  const fmtMethod = (m) => {
    if (!m) return null;
    const mu = m.toUpperCase();
    if (mu === 'KO/TKO' || mu === 'TKO' || mu === 'KO') return 'KO/TKO';
    if (mu === 'SUB' || mu === 'SUBMISSION') return 'SUB';
    if (mu === 'U-DEC' || mu === 'UDEC') return 'DEC';
    if (mu === 'S-DEC' || mu === 'SDEC') return 'Split Dec';
    if (mu === 'M-DEC') return 'Maj Dec';
    return m;
  };

  return (
    <div className={`card p-4 ${fight.is_title_fight ? 'border-gold/20' : ''}`}>
      {fight.is_title_fight && (
        <div className="text-[9px] tracking-[0.25em] text-gold uppercase mb-2 flex items-center gap-1.5">
          <span>&#127942;</span> Title Fight
        </div>
      )}
      <div className="flex items-center gap-3">
        {/* Fighter 1 */}
        <div className="flex-1">
          {f1 && (
            <Link
              to={`/fighters/${f1.slug}`}
              className={`font-medium text-sm hover:text-gold transition-colors block ${
                f1Won ? 'text-win' : isDraw ? 'text-white/70' : isUpcoming ? '' : 'text-white/40'
              }`}
            >
              {f1.first_name} {f1.last_name}
            </Link>
          )}
          {f1Won && !isUpcoming && <span className="text-[9px] text-win/70 uppercase tracking-wider">W</span>}
        </div>

        {/* Result center */}
        <div className="text-center min-w-[80px]">
          {isUpcoming ? (
            <span className="font-display text-xs text-white/30">VS</span>
          ) : (
            <div>
              {isDraw && <span className="text-xs text-white/50">DRAW</span>}
              {isNC && <span className="text-xs text-white/50">NC</span>}
              {!isDraw && !isNC && fight.method && (
                <div className="text-xs text-white/60">
                  <div className="font-medium">{fmtMethod(fight.method)}</div>
                  {fight.round && (
                    <div className="text-white/30 text-[10px]">
                      R{fight.round}{fight.time ? ` · ${fight.time}` : ''}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Fighter 2 */}
        <div className="flex-1 text-right">
          {f2 && (
            <Link
              to={`/fighters/${f2.slug}`}
              className={`font-medium text-sm hover:text-gold transition-colors block ${
                f2Won ? 'text-win' : isDraw ? 'text-white/70' : isUpcoming ? '' : 'text-white/40'
              }`}
            >
              {f2.first_name} {f2.last_name}
            </Link>
          )}
        </div>
      </div>

      {/* Odds */}
      {odds && (
        <div className="flex gap-2 mt-2.5">
          <div className={`flex-1 text-center text-xs py-1 rounded border ${
            odds.fighter1_odds < 0 ? 'border-gold/20 text-gold' : 'border-red-900/30 text-red-400'
          }`}>
            {f1?.last_name} {formatOdds(odds.fighter1_odds)}
          </div>
          <div className={`flex-1 text-center text-xs py-1 rounded border ${
            odds.fighter2_odds < 0 ? 'border-gold/20 text-gold' : 'border-red-900/30 text-red-400'
          }`}>
            {f2?.last_name} {formatOdds(odds.fighter2_odds)}
          </div>
        </div>
      )}
    </div>
  );
}

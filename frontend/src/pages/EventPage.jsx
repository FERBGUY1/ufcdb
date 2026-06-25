import { useEffect, useState } from 'react';
import { Link, useParams, useNavigate } from 'react-router-dom';
import { getEvent, formatOdds } from '../lib/api';

export default function EventPage() {
  const { slug } = useParams();
  const navigate = useNavigate();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    getEvent(slug).then(setData).finally(() => setLoading(false));
  }, [slug]);

  // Arrow-key navigation through adjacent events (works at every viewport width,
  // including where the on-screen edge arrows are hidden). Ignore keystrokes that
  // are being typed into a form control.
  // UI mapping (intentional): left arrow → newer event, right arrow → older event.
  // The backend keeps prevEvent = nearest older, nextEvent = nearest newer.
  const older = data?.prevEvent;
  const newer = data?.nextEvent;
  useEffect(() => {
    const onKey = (ev) => {
      const tag = ev.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || ev.target?.isContentEditable) return;
      if (ev.key === 'ArrowLeft' && newer) navigate(`/events/${newer.slug}`);
      else if (ev.key === 'ArrowRight' && older) navigate(`/events/${older.slug}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [older, newer, navigate]);

  if (loading) return <div className="p-8 text-center text-white/30">Loading event...</div>;
  if (!data) return <div className="p-8 text-center text-white/30">Event not found</div>;

  const { event: e, fights } = data;

  const SECTION_RANK = { main_card: 0, prelim: 1, early_prelim: 2 };

  // Sort globally: section rank first, then bout_order ascending within each section.
  // bout_order=0 is always the main event headliner.
  const sortedFights = [...fights].sort((a, b) => {
    const ra = a.card_position != null ? (SECTION_RANK[a.card_position] ?? 3) : 3;
    const rb = b.card_position != null ? (SECTION_RANK[b.card_position] ?? 3) : 3;
    if (ra !== rb) return ra - rb;
    return (a.bout_order ?? 999) - (b.bout_order ?? 999);
  });

  const hasCardPos = sortedFights.some(f => f.card_position);
  let sections;

  if (hasCardPos) {
    const main   = sortedFights.filter(f => f.card_position === 'main_card');
    const prelim = sortedFights.filter(f => f.card_position === 'prelim');
    const early  = sortedFights.filter(f => f.card_position === 'early_prelim');
    const other  = sortedFights.filter(f => !f.card_position);

    sections = [
      main.length > 0   ? { title: 'Main Card',        fights: main   } : null,
      prelim.length > 0 ? { title: 'Preliminary Card', fights: prelim } : null,
      early.length > 0  ? { title: 'Early Prelims',    fights: early  } : null,
      other.length > 0  ? { title: 'Fight Card',       fights: other  } : null,
    ].filter(Boolean);
  } else {
    sections = [{ title: 'Fight Card', fights: sortedFights }];
  }

  return (
    <>
      <EventArrow dir="prev" event={newer} onClick={() => newer && navigate(`/events/${newer.slug}`)} />
      <EventArrow dir="next" event={older} onClick={() => older && navigate(`/events/${older.slug}`)} />

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
    </>
  );
}

// Fixed edge arrow for prev/next event navigation. Shown only at xl+ where the
// max-w-5xl card column leaves gutter at the screen edges (below xl the arrow
// keys still navigate). Disabled/greyed at the chronological ends — no wrap.
function EventArrow({ dir, event, onClick }) {
  const isPrev = dir === 'prev';
  const disabled = !event;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={isPrev ? 'Newer event' : 'Older event'}
      title={event ? event.name : `No ${isPrev ? 'later' : 'earlier'} event`}
      className={`hidden xl:flex fixed top-1/2 -translate-y-1/2 z-30 items-center justify-center
        w-12 h-12 rounded-full border shadow-lg transition-colors
        ${isPrev ? 'left-4' : 'right-4'}
        ${disabled
          ? 'bg-white/[0.03] border-white/10 text-white/20 cursor-not-allowed'
          : 'bg-dark/90 border-white/25 text-white hover:bg-gold hover:text-dark hover:border-gold'}`}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {isPrev ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
      </svg>
    </button>
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
          {fight.weight_classes?.name && (
            <div className="text-[9px] tracking-[0.1em] text-white/25 uppercase mb-1">
              {fight.weight_classes.name}
            </div>
          )}
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


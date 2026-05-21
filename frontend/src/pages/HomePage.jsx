import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getSiteStats, getUpcomingOdds, getEvents, formatOdds, formatRecord } from '../lib/api';

export default function HomePage() {
  const [stats, setStats]     = useState(null);
  const [upcoming, setUpcoming] = useState([]);
  const [recent, setRecent]   = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      getSiteStats(),
      getUpcomingOdds(),
      getEvents({ upcoming: false, limit: 6 }),
    ]).then(([s, u, r]) => {
      setStats(s);
      setUpcoming(u.fights || []);
      setRecent(r.events || []);
    }).catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  return (
    <main>
      {/* HERO */}
      <section className="bg-dark-2 border-b border-white/[0.06] pt-16 pb-14 px-4 text-center relative overflow-hidden">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_50%_0%,rgba(200,168,75,0.06)_0%,transparent_60%)] pointer-events-none" />
        <div className="relative max-w-2xl mx-auto">
          <p className="text-xs tracking-[0.4em] text-gold font-medium mb-4 uppercase">The Complete UFC Database</p>
          <h1 className="font-display text-6xl md:text-8xl tracking-[0.08em] leading-none mb-3">
            EVERY FIGHTER.<br /><span className="text-gold">EVERY FIGHT.</span>
          </h1>
          <p className="text-white/40 font-light text-base mt-4 mb-8 leading-relaxed">
            Full records, stats, personal profiles, gym info, coaches,<br />
            and betting odds for every UFC fighter — from UFC 1 to today.
          </p>
          <div className="flex gap-3 justify-center">
            <Link to="/fighters" className="btn-gold">Browse Fighters</Link>
            <Link to="/events"   className="btn-outline">View Events</Link>
          </div>
        </div>
      </section>

      {/* STATS BAR */}
      <div className="bg-dark-2 border-b border-white/[0.06]">
        <div className="max-w-4xl mx-auto grid grid-cols-2 md:grid-cols-5 divide-x divide-white/[0.06]">
          {[
            { num: stats?.total_fighters?.toLocaleString()  || '1,847+', label: 'Total Fighters' },
            { num: stats?.active_fighters?.toLocaleString() || '732',    label: 'Active Roster' },
            { num: stats?.total_fights?.toLocaleString()    || '6,200+', label: 'Fights Logged' },
            { num: stats?.total_events?.toLocaleString()    || '690+',   label: 'Events Covered' },
            { num: '4,100+', label: 'Odds Records' },
          ].map(s => (
            <div key={s.label} className="py-5 text-center px-4">
              <div className="font-display text-3xl tracking-[0.1em] text-gold leading-none">{s.num}</div>
              <div className="text-xs tracking-[0.15em] text-white/30 mt-1.5 uppercase">{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-4">
        {/* UPCOMING FIGHTS */}
        <section className="py-8">
          <h2 className="section-title">Upcoming Fights</h2>
          {upcoming.length === 0 ? (
            <div className="text-white/30 text-sm py-8 text-center">No upcoming fights data — check back after odds sync</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {upcoming.map(fight => <FightCard key={fight.id} fight={fight} />)}
            </div>
          )}
        </section>

        {/* RECENT EVENTS */}
        <section className="py-8 pt-0">
          <h2 className="section-title">Recent Events</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {recent.map(event => (
              <Link key={event.id} to={`/events/${event.slug}`} className="card-hover p-4 block">
                <div className="text-[10px] tracking-[0.2em] text-gold uppercase mb-2">{event.date}</div>
                <div className="font-medium text-sm mb-1">{event.name}</div>
                <div className="text-xs text-white/30">{event.city}{event.country ? `, ${event.country}` : ''}</div>
              </Link>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}

function FightCard({ fight }) {
  const f1 = fight.fighter1;
  const f2 = fight.fighter2;
  if (!f1 || !f2) return null;

  const currentOdds = fight.odds?.filter(o => o.line_type === 'current') || [];
  const dkOdds = currentOdds.find(o => o.bookmaker === 'draftkings') || currentOdds[0];

  return (
    <Link to={`/events/${fight.events?.slug}`} className="card-hover p-4 block">
      <div className="text-[10px] tracking-[0.2em] text-gold uppercase mb-3">
        {fight.events?.name}
        {fight.is_title_fight && <span className="ml-2 text-white/40">· Title Fight</span>}
      </div>

      <div className="flex items-center gap-2 mb-3">
        <FighterMini fighter={f1} />
        <span className="font-display text-loss text-sm tracking-wider flex-shrink-0">VS</span>
        <FighterMini fighter={f2} align="right" />
      </div>

      {dkOdds && (
        <div className="flex gap-2">
          <div className={`flex-1 text-center py-1.5 rounded-lg text-xs font-medium border ${
            dkOdds.fighter1_odds < 0
              ? 'bg-gold/10 text-gold border-gold/20'
              : 'bg-red-900/20 text-red-400 border-red-900/30'
          }`}>
            {f1.last_name} {formatOdds(dkOdds.fighter1_odds)}
          </div>
          <div className={`flex-1 text-center py-1.5 rounded-lg text-xs font-medium border ${
            dkOdds.fighter2_odds < 0
              ? 'bg-gold/10 text-gold border-gold/20'
              : 'bg-red-900/20 text-red-400 border-red-900/30'
          }`}>
            {f2.last_name} {formatOdds(dkOdds.fighter2_odds)}
          </div>
        </div>
      )}
    </Link>
  );
}

function FighterMini({ fighter, align = 'left' }) {
  return (
    <div className={`flex-1 ${align === 'right' ? 'text-right' : 'text-left'}`}>
      <Link to={`/fighters/${fighter.slug}`} className="font-medium text-sm hover:text-gold transition-colors">
        {fighter.first_name} {fighter.last_name}
      </Link>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { getEvent, formatOdds } from '../lib/api';
export default function EventPage() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { getEvent(slug).then(setData).finally(()=>setLoading(false)); }, [slug]);
  if (loading) return <div className="p-8 text-center text-white/30">Loading event...</div>;
  if (!data) return <div className="p-8 text-center text-white/30">Event not found</div>;
  const { event: e, fights } = data;
  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <Link to="/events" className="text-white/30 text-sm hover:text-white">← Events</Link>
      <div className="mt-4 mb-8">
        <div className="text-[10px] tracking-[0.3em] text-gold uppercase mb-2">{e.date}</div>
        <h1 className="font-display text-5xl tracking-[0.1em]">{e.name}</h1>
        {(e.venue||e.city) && <p className="text-white/40 mt-2">{[e.venue,e.city,e.country].filter(Boolean).join(' · ')}</p>}
      </div>
      <div className="space-y-2">{fights.map(fight=><FightItem key={fight.id} fight={fight}/>)}</div>
    </main>
  );
}
function FightItem({fight}) {
  const f1=fight.fighter1,f2=fight.fighter2;
  const odds=fight.odds?.[0];
  return (
    <div className={`card p-4 ${fight.is_title_fight?'border-gold/20':''}`}>
      <div className="flex items-center gap-4">
        <div className="flex-1">{f1&&<Link to={`/fighters/${f1.slug}`} className={`font-medium text-sm hover:text-gold ${fight.winner?.id===f1?.id?'text-win':''}`}>{f1.first_name} {f1.last_name}</Link>}</div>
        <div className="font-display text-loss text-sm">VS</div>
        <div className="flex-1 text-right">{f2&&<Link to={`/fighters/${f2.slug}`} className={`font-medium text-sm hover:text-gold ${fight.winner?.id===f2?.id?'text-win':''}`}>{f2.first_name} {f2.last_name}</Link>}</div>
        {fight.method&&<div className="text-xs text-white/40 min-w-[80px] text-right"><div>{fight.method}</div>{fight.round&&<div>R{fight.round}·{fight.time}</div>}</div>}
      </div>
      {odds&&<div className="flex gap-2 mt-2"><div className={`flex-1 text-center text-xs py-1 rounded border ${odds.fighter1_odds<0?'border-gold/20 text-gold':'border-red-900/30 text-red-400'}`}>{f1?.last_name} {formatOdds(odds.fighter1_odds)}</div><div className={`flex-1 text-center text-xs py-1 rounded border ${odds.fighter2_odds<0?'border-gold/20 text-gold':'border-red-900/30 text-red-400'}`}>{f2?.last_name} {formatOdds(odds.fighter2_odds)}</div></div>}
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getEvents } from '../lib/api';

export default function EventsPage() {
  const [events, setEvents] = useState([]);
  const [upcoming, setUpcoming] = useState([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    Promise.all([getEvents({ limit: 30, upcoming: false }), getEvents({ limit: 10, upcoming: true })])
      .then(([past, up]) => { setEvents(past.events||[]); setUpcoming(up.events||[]); })
      .finally(() => setLoading(false));
  }, []);
  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <h1 className="font-display text-4xl tracking-[0.2em] mb-6">EVENTS</h1>
      {upcoming.length > 0 && (<section className="mb-8"><h2 className="section-title">Upcoming</h2><div className="grid grid-cols-1 md:grid-cols-3 gap-3">{upcoming.map(e=><EventCard key={e.id} event={e}/>)}</div></section>)}
      <section><h2 className="section-title">Recent Events</h2><div className="grid grid-cols-1 md:grid-cols-3 gap-3">{loading?Array.from({length:9}).map((_,i)=><div key={i} className="card p-4 h-24 animate-pulse"/>):events.map(e=><EventCard key={e.id} event={e}/>)}</div></section>
    </main>
  );
}
function EventCard({event:e}) {
  return <Link to={`/events/${e.slug}`} className="card-hover p-4 block"><div className="text-[10px] tracking-[0.2em] text-gold uppercase mb-1.5">{e.date}</div><div className="font-medium text-sm mb-1">{e.name}</div><div className="text-xs text-white/30">{[e.venue,e.city,e.country].filter(Boolean).join(' · ')}</div></Link>;
}

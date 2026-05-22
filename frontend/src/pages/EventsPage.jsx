import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getEvents } from '../lib/api';

const PAGE_SIZE = 30;

const YEARS = Array.from({ length: new Date().getFullYear() - 1993 + 1 }, (_, i) => new Date().getFullYear() - i);

export default function EventsPage() {
  const [events,      setEvents]      = useState([]);
  const [upcoming,    setUpcoming]    = useState([]);
  const [loading,     setLoading]     = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [page,        setPage]        = useState(1);
  const [total,       setTotal]       = useState(0);
  const [search,      setSearch]      = useState('');
  const [year,        setYear]        = useState('');
  const searchTimer = useRef(null);

  const fetchEvents = useCallback(async (q, yr, pg) => {
    const params = { limit: PAGE_SIZE, page: pg, upcoming: false };
    if (yr) params.year = yr;
    if (q)  params.search = q;
    return getEvents(params);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchEvents(search, year, 1),
      getEvents({ limit: 10, upcoming: true }),
    ]).then(([past, up]) => {
      setEvents(past.events || []);
      setTotal(past.pagination?.total || 0);
      setPage(1);
      setUpcoming(up.events || []);
    }).finally(() => setLoading(false));
  }, [search, year, fetchEvents]);

  const onSearchChange = (val) => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(val), 350);
  };

  const loadMore = useCallback(() => {
    const nextPage = page + 1;
    setLoadingMore(true);
    fetchEvents(search, year, nextPage)
      .then(r => {
        setEvents(prev => [...prev, ...(r.events || [])]);
        setPage(nextPage);
      })
      .finally(() => setLoadingMore(false));
  }, [page, search, year, fetchEvents]);

  const hasMore = events.length < total;

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      <div className="flex items-baseline gap-4 mb-6 flex-wrap">
        <h1 className="font-display text-4xl tracking-[0.2em]">EVENTS</h1>
        <span className="text-white/30 text-sm">{total.toLocaleString()} events</span>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3 mb-6 items-center">
        <input
          type="text"
          placeholder="Search events…"
          defaultValue={search}
          onChange={e => onSearchChange(e.target.value)}
          className="input-dark w-52"
        />
        <select
          value={year}
          onChange={e => setYear(e.target.value)}
          className="input-dark w-32"
        >
          <option value="">All Years</option>
          {YEARS.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        {(search || year) && (
          <button
            onClick={() => { setSearch(''); setYear(''); }}
            className="text-xs text-white/40 hover:text-white"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Upcoming (shown only when no filters active) */}
      {!search && !year && upcoming.length > 0 && (
        <section className="mb-8">
          <h2 className="section-title">Upcoming</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {upcoming.map(e => <EventCard key={e.id} event={e} />)}
          </div>
        </section>
      )}

      <section>
        {!search && !year && <h2 className="section-title">Recent Events</h2>}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          {loading
            ? Array.from({ length: 9 }).map((_, i) => <div key={i} className="card p-4 h-24 animate-pulse" />)
            : events.length === 0
              ? <div className="col-span-3 text-center py-12 text-white/30">No events found.</div>
              : events.map(e => <EventCard key={e.id} event={e} />)
          }
        </div>

        {!loading && hasMore && (
          <div className="text-center mt-8">
            <button onClick={loadMore} disabled={loadingMore} className="btn-outline px-8 py-2.5">
              {loadingMore ? 'Loading…' : `Load More (${events.length} of ${total})`}
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function EventCard({ event: e }) {
  return (
    <Link to={`/events/${e.slug}`} className="card-hover p-4 block">
      <div className="text-[10px] tracking-[0.2em] text-gold uppercase mb-1.5">{e.date}</div>
      <div className="font-medium text-sm mb-1 leading-snug">{e.name}</div>
      <div className="text-xs text-white/30">{[e.venue, e.city, e.country].filter(Boolean).join(' · ')}</div>
    </Link>
  );
}

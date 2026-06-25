import { useEffect, useState, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import { getEvents, search as apiSearch, fmtProRecord } from '../lib/api';

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
  const [fighter,     setFighter]     = useState(null);
  const searchTimer = useRef(null);

  const fetchEvents = useCallback(async (q, yr, fid, pg) => {
    const params = { limit: PAGE_SIZE, page: pg, upcoming: false };
    if (yr)  params.year = yr;
    if (q)   params.search = q;
    if (fid) params.fighter = fid;
    return getEvents(params);
  }, []);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      fetchEvents(search, year, fighter?.id, 1),
      getEvents({ limit: 10, upcoming: true }),
    ]).then(([past, up]) => {
      setEvents(past.events || []);
      setTotal(past.pagination?.total || 0);
      setPage(1);
      setUpcoming(up.events || []);
    }).finally(() => setLoading(false));
  }, [search, year, fighter, fetchEvents]);

  const onSearchChange = (val) => {
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => setSearch(val), 350);
  };

  const loadMore = useCallback(() => {
    const nextPage = page + 1;
    setLoadingMore(true);
    fetchEvents(search, year, fighter?.id, nextPage)
      .then(r => {
        setEvents(prev => [...prev, ...(r.events || [])]);
        setPage(nextPage);
      })
      .finally(() => setLoadingMore(false));
  }, [page, search, year, fighter, fetchEvents]);

  const hasMore = events.length < total;
  const hasFilters = search || year || fighter;

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
        {fighter
          ? (
            <span className="inline-flex items-center gap-2 text-xs bg-gold/10 border border-gold/30 text-gold rounded-full pl-3 pr-1.5 py-1.5">
              Events with {fighter.first_name} {fighter.last_name}
              <button
                onClick={() => setFighter(null)}
                aria-label="Clear fighter filter"
                className="w-4 h-4 flex items-center justify-center rounded-full hover:bg-gold/20"
              >
                &times;
              </button>
            </span>
          )
          : <FighterFilter onSelect={setFighter} />
        }
        {hasFilters && (
          <button
            onClick={() => { setSearch(''); setYear(''); setFighter(null); }}
            className="text-xs text-white/40 hover:text-white"
          >
            Clear filters
          </button>
        )}
      </div>

      {/* Upcoming (shown only when no filters active) */}
      {!hasFilters && upcoming.length > 0 && (
        <section className="mb-8">
          <h2 className="section-title">Upcoming</h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {upcoming.map(e => <EventCard key={e.id} event={e} />)}
          </div>
        </section>
      )}

      <section>
        {!hasFilters && <h2 className="section-title">Recent Events</h2>}
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

// Debounced fighter search that filters the events list to one fighter's bouts.
// Mirrors the Nav search dropdown (avatar initials, name, weight class · record).
function FighterFilter({ onSelect }) {
  const [q, setQ]           = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen]     = useState(false);
  const ref   = useRef(null);
  const timer = useRef(null);

  const onChange = (val) => {
    setQ(val);
    clearTimeout(timer.current);
    if (val.length < 2) { setResults(null); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      const d = await apiSearch(val, 6);
      setResults(d); setOpen(true);
    }, 250);
  };

  const pick = (f) => {
    setQ(''); setResults(null); setOpen(false);
    onSelect(f);
  };

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <div className="relative w-52" ref={ref}>
      <input
        type="text"
        value={q}
        onChange={e => onChange(e.target.value)}
        onFocus={() => results && setOpen(true)}
        placeholder="Filter by fighter…"
        className="input-dark pl-9 w-full"
      />
      <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30"
        fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
          d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
      </svg>
      {open && results && (
        <div className="absolute top-full mt-1 w-72 bg-dark-3 border border-white/10 rounded-xl overflow-hidden shadow-2xl z-50">
          {results.fighters?.map(f => (
            <button key={f.id} onClick={() => pick(f)}
              className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-dark-4 transition-colors text-left">
              <div className="w-7 h-7 rounded-full bg-dark-5 border border-white/10 flex items-center justify-center text-xs font-display text-gold flex-shrink-0">
                {f.first_name?.[0]}{f.last_name?.[0]}
              </div>
              <div className="min-w-0">
                <div className="text-xs font-medium truncate">{f.first_name} {f.last_name}</div>
                <div className="text-[10px] text-white/40">{f.weight_classes?.name} · {fmtProRecord(f)}</div>
              </div>
              <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${f.status === 'active' ? 'bg-win/10 text-win' : 'bg-white/5 text-white/30'}`}>
                {f.status}
              </span>
            </button>
          ))}
          {!results.fighters?.length && (
            <div className="px-4 py-3 text-xs text-white/30">No fighters for "{q}"</div>
          )}
        </div>
      )}
    </div>
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

import { useEffect, useState, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getFighters, formatProRecord } from '../lib/api';

const WEIGHT_CLASSES = [
  { slug: '',                     label: 'All Divisions' },
  { slug: 'heavyweight',          label: 'Heavyweight' },
  { slug: 'light-heavyweight',    label: 'Light Heavyweight' },
  { slug: 'middleweight',         label: 'Middleweight' },
  { slug: 'welterweight',         label: 'Welterweight' },
  { slug: 'lightweight',          label: 'Lightweight' },
  { slug: 'featherweight',        label: 'Featherweight' },
  { slug: 'bantamweight',         label: 'Bantamweight' },
  { slug: 'flyweight',            label: 'Flyweight' },
  { slug: 'womens-strawweight',   label: "Women's Strawweight" },
  { slug: 'womens-flyweight',     label: "Women's Flyweight" },
  { slug: 'womens-bantamweight',  label: "Women's Bantamweight" },
];

export default function RosterPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [fighters, setFighters] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const weightClass = searchParams.get('weight_class') || '';
  const status      = searchParams.get('status') || 'all';
  const query       = searchParams.get('q') || '';
  const page        = parseInt(searchParams.get('page') || '1');
  const stance      = searchParams.get('stance') || '';
  const nationality = searchParams.get('nationality') || '';
  const heightIn    = searchParams.get('height_inches') || '';
  const reachIn     = searchParams.get('reach_inches') || '';

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await getFighters({
        weight_class: weightClass || undefined,
        status: status !== 'all' ? status : undefined,
        search: query || undefined,
        stance: stance || undefined,
        nationality: nationality || undefined,
        height_inches: heightIn || undefined,
        reach_inches: reachIn || undefined,
        page,
        limit: 60,
        sort: 'ranked',
      });
      setFighters(data.fighters || []);
      setPagination(data.pagination);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [weightClass, status, query, page, stance, nationality, heightIn, reachIn]);

  useEffect(() => { load(); }, [load]);

  const setParam = (key, val) => {
    const next = new URLSearchParams(searchParams);
    if (val) next.set(key, val); else next.delete(key);
    next.delete('page');
    setSearchParams(next);
  };

  const setPage = (p) => {
    const next = new URLSearchParams(searchParams);
    next.set('page', p);
    setSearchParams(next);
    window.scrollTo(0, 0);
  };

  return (
    <main className="max-w-7xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-6">
        <h1 className="font-display text-4xl tracking-[0.2em] mb-2">FIGHTER ROSTER</h1>
        <p className="text-white/40 text-sm">All-time UFC fighter database — active and historical</p>
      </div>

      {/* Filters */}
      <div className="mb-6 space-y-3">
        {/* Weight class filter */}
        <div className="flex flex-wrap gap-2">
          {WEIGHT_CLASSES.map(wc => (
            <button
              key={wc.slug}
              onClick={() => setParam('weight_class', wc.slug)}
              className={`text-xs px-3 py-1.5 rounded-lg border transition-all duration-150 ${
                weightClass === wc.slug
                  ? 'bg-gold text-dark-DEFAULT border-gold font-semibold'
                  : 'bg-dark-3 border-white/[0.06] text-white/50 hover:text-white hover:border-white/20'
              }`}
            >
              {wc.label}
            </button>
          ))}
        </div>

        {/* Status + search row */}
        <div className="flex flex-wrap gap-3 items-center">
          <div className="flex gap-2">
            {['all', 'active', 'retired'].map(s => (
              <button
                key={s}
                onClick={() => setParam('status', s)}
                className={`text-xs px-3 py-1.5 rounded-lg border capitalize transition-all ${
                  status === s
                    ? 'bg-dark-5 text-white border-white/20'
                    : 'bg-dark-3 border-white/[0.06] text-white/40 hover:text-white/70'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder="Filter by name, gym..."
            defaultValue={query}
            onChange={e => setParam('q', e.target.value)}
            className="input-dark ml-auto w-48"
          />
          {pagination && (
            <span className="text-xs text-white/30">{pagination.total?.toLocaleString()} fighters</span>
          )}
        </div>

        {/* Active attribute filter chip */}
        {(stance || nationality || heightIn || reachIn) && (
          <div className="flex flex-wrap gap-2 items-center">
            <span className="text-[10px] tracking-widest text-white/30 uppercase">Filtered by:</span>
            {stance && (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-gold/10 border border-gold/30 text-gold">
                {stance}
                <button onClick={() => setParam('stance', '')} className="hover:text-white">✕</button>
              </span>
            )}
            {nationality && (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-gold/10 border border-gold/30 text-gold">
                {nationality}
                <button onClick={() => setParam('nationality', '')} className="hover:text-white">✕</button>
              </span>
            )}
            {heightIn && (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-gold/10 border border-gold/30 text-gold">
                {heightIn}"
                <button onClick={() => setParam('height_inches', '')} className="hover:text-white">✕</button>
              </span>
            )}
            {reachIn && (
              <span className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg bg-gold/10 border border-gold/30 text-gold">
                Reach {reachIn}"
                <button onClick={() => setParam('reach_inches', '')} className="hover:text-white">✕</button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Grid */}
      {loading ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {Array.from({ length: 24 }).map((_, i) => (
            <div key={i} className="card p-4 animate-pulse">
              <div className="w-12 h-12 rounded-full bg-dark-5 mx-auto mb-3" />
              <div className="h-3 bg-dark-5 rounded mx-auto w-3/4 mb-2" />
              <div className="h-2.5 bg-dark-5 rounded mx-auto w-1/2" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="text-center py-16 text-white/30">
          <p className="text-lg mb-2">Failed to load fighters</p>
          <p className="text-sm">{error}</p>
          <button onClick={load} className="btn-outline mt-4">Retry</button>
        </div>
      ) : fighters.length === 0 ? (
        <div className="text-center py-16 text-white/30">
          No fighters found for these filters.
        </div>
      ) : (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-3">
          {fighters.map(f => <FighterCard key={f.id} fighter={f} />)}
        </div>
      )}

      {/* Pagination */}
      {pagination && pagination.pages > 1 && (
        <div className="flex justify-center gap-2 mt-8">
          {page > 1 && (
            <button onClick={() => setPage(page - 1)} className="btn-outline px-3 py-1.5 text-xs">← Prev</button>
          )}
          <span className="text-sm text-white/30 flex items-center px-3">
            Page {page} of {pagination.pages}
          </span>
          {page < pagination.pages && (
            <button onClick={() => setPage(page + 1)} className="btn-outline px-3 py-1.5 text-xs">Next →</button>
          )}
        </div>
      )}
    </main>
  );
}

function FighterCard({ fighter: f }) {
  const initials = `${f.first_name?.[0] || ''}${f.last_name?.[0] || ''}`;

  return (
    <Link
      to={`/fighters/${f.slug}`}
      className={`card p-4 text-center hover:border-gold-dim/40 hover:-translate-y-0.5 transition-all duration-200 block ${
        f.is_champion ? 'border-gold-dim/40' : ''
      }`}
    >
      {/* Avatar */}
      <div className={`w-12 h-12 rounded-full mx-auto mb-2.5 flex items-center justify-center font-display text-lg tracking-wide border-2 ${
        f.is_champion ? 'border-gold/50 bg-gold/10 text-gold' : 'border-white/10 bg-dark-4 text-white/60'
      }`}>
        {f.photo_url
          ? <img src={f.photo_url} alt={f.first_name} className="w-full h-full object-cover rounded-full" />
          : initials
        }
      </div>

      {f.is_champion
        ? <div className="text-[9px] tracking-[0.2em] text-gold uppercase mb-1">⟡ Champion</div>
        : f.rank != null && <div className="text-[9px] tracking-[0.2em] text-white/30 uppercase mb-1">#{f.rank}</div>
      }

      <div className="text-xs font-medium leading-tight mb-0.5">
        {f.first_name} {f.last_name}
      </div>
      {f.nickname && (
        <div className="text-[10px] text-gold italic mb-1.5 truncate">"{f.nickname}"</div>
      )}
      <div className="text-[11px] text-white/40">
        {formatProRecord(f)}
      </div>
      <div className="text-[9px] text-white/20 mt-1 truncate">{f.gym_name}</div>
      <div className={`mt-2 text-[9px] px-2 py-0.5 rounded-full inline-block ${
        f.status === 'active'
          ? 'bg-win/10 text-win'
          : 'bg-white/5 text-white/20'
      }`}>
        {f.status}
      </div>
    </Link>
  );
}

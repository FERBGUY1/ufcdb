import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getFighters, formatRecord } from '../lib/api';

const WEIGHT_CLASSES = [
  { slug: 'heavyweight',        name: 'Heavyweight',         limit: '265 lbs' },
  { slug: 'light-heavyweight',  name: 'Light Heavyweight',   limit: '205 lbs' },
  { slug: 'middleweight',       name: 'Middleweight',        limit: '185 lbs' },
  { slug: 'welterweight',       name: 'Welterweight',        limit: '170 lbs' },
  { slug: 'lightweight',        name: 'Lightweight',         limit: '155 lbs' },
  { slug: 'featherweight',      name: 'Featherweight',       limit: '145 lbs' },
  { slug: 'bantamweight',       name: 'Bantamweight',        limit: '135 lbs' },
  { slug: 'flyweight',          name: 'Flyweight',           limit: '125 lbs' },
  { slug: 'womens-strawweight', name: "Women's Strawweight", limit: '115 lbs' },
  { slug: 'womens-flyweight',   name: "Women's Flyweight",   limit: '125 lbs' },
  { slug: 'womens-bantamweight',name: "Women's Bantamweight",limit: '135 lbs' },
  { slug: 'womens-featherweight',name:"Women's Featherweight",limit: '145 lbs' },
];

export default function RankingsPage() {
  const [selected, setSelected] = useState('heavyweight');
  const [fighters, setFighters] = useState([]);
  const [loading, setLoading]   = useState(false);

  useEffect(() => {
    setLoading(true);
    getFighters({ weight_class: selected, sort: 'wins', order: 'desc', status: 'active', limit: 16 })
      .then(d => setFighters(d.fighters || []))
      .catch(() => setFighters([]))
      .finally(() => setLoading(false));
  }, [selected]);

  const selectedClass = WEIGHT_CLASSES.find(w => w.slug === selected);
  const champion = fighters.find(f => f.is_champion);
  const ranked   = fighters.filter(f => !f.is_champion);

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="page-header">RANKINGS</h1>
      <p className="page-sub">Top active fighters by weight class — sorted by win total</p>
      <p className="text-[10px] text-white/20 tracking-wider mt-1 mb-6">
        Official UFC rankings sync coming soon · Showing computed rankings based on record
      </p>

      {/* Weight class tabs */}
      <div className="flex flex-wrap gap-2 mb-8">
        {WEIGHT_CLASSES.map(wc => (
          <button
            key={wc.slug}
            onClick={() => setSelected(wc.slug)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${
              selected === wc.slug
                ? 'bg-gold text-dark-1'
                : 'bg-dark-3 text-white/50 hover:text-white hover:bg-dark-4'
            }`}
          >
            {wc.name}
          </button>
        ))}
      </div>

      {/* Division header */}
      <div className="mb-6">
        <div className="flex items-baseline gap-3">
          <h2 className="font-display text-2xl tracking-[0.1em]">{selectedClass?.name.toUpperCase()}</h2>
          <span className="text-xs text-white/30">{selectedClass?.limit}</span>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">
          {Array.from({length: 8}).map((_, i) => (
            <div key={i} className="h-14 bg-dark-3 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="space-y-1.5">
          {/* Champion row */}
          {champion && (
            <div className="card p-4 border-gold/20 mb-4">
              <div className="flex items-center gap-4">
                <div className="w-8 text-center">
                  <span className="text-gold text-lg">&#127942;</span>
                </div>
                <div className="flex-1">
                  <Link to={`/fighters/${champion.slug}`} className="font-medium hover:text-gold transition-colors">
                    {champion.first_name} {champion.last_name}
                  </Link>
                  {champion.nickname && (
                    <span className="text-xs text-white/30 ml-2">"{champion.nickname}"</span>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-sm font-medium text-win">
                    {formatRecord(champion.wins, champion.losses, champion.draws, champion.no_contests)}
                  </div>
                  <div className="text-[9px] tracking-[0.2em] text-gold uppercase mt-0.5">Champion</div>
                </div>
              </div>
            </div>
          )}

          {/* Ranked fighters */}
          {ranked.slice(0, 15).map((fighter, i) => (
            <RankedRow key={fighter.id} fighter={fighter} rank={i + 1} />
          ))}

          {fighters.length === 0 && (
            <div className="card p-8 text-center text-white/30">
              No active fighters found in this weight class
            </div>
          )}
        </div>
      )}
    </main>
  );
}

function RankedRow({ fighter, rank }) {
  return (
    <div className="card p-4 hover:border-white/10 transition-colors">
      <div className="flex items-center gap-4">
        <div className="w-8 text-center flex-shrink-0">
          <span className="font-display text-white/30 text-lg">#{rank}</span>
        </div>
        <div className="flex-1 min-w-0">
          <Link to={`/fighters/${fighter.slug}`} className="font-medium hover:text-gold transition-colors">
            {fighter.first_name} {fighter.last_name}
          </Link>
          {fighter.nickname && (
            <span className="text-xs text-white/30 ml-2 truncate">"{fighter.nickname}"</span>
          )}
        </div>
        <div className="text-right flex-shrink-0">
          <div className="text-sm font-medium">
            {formatRecord(fighter.wins, fighter.losses, fighter.draws, fighter.no_contests)}
          </div>
        </div>
      </div>
    </div>
  );
}

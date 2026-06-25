import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getAllRankings, formatProRecord } from '../lib/api';

export default function RankingsPage() {
  const [data, setData]         = useState(null);
  const [loading, setLoading]   = useState(true);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    getAllRankings()
      .then(d => {
        setData(d);
        if (d.divisions?.length) setSelected(d.divisions[0].weight_class.slug);
      })
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, []);

  const divisions = data?.divisions || [];
  const division  = divisions.find(d => d.weight_class.slug === selected);

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="page-header">RANKINGS</h1>
      <div className="flex items-baseline gap-3 mb-1">
        <p className="page-sub">Official UFC rankings</p>
        {data?.recorded_date && (
          <span className="text-[10px] text-white/20 tracking-wider">
            Updated {data.recorded_date}
          </span>
        )}
      </div>

      {loading ? (
        <div className="space-y-2 mt-6">
          {Array.from({length: 8}).map((_,i) => (
            <div key={i} className="h-14 bg-dark-3 rounded-xl animate-pulse" />
          ))}
        </div>
      ) : !data || divisions.length === 0 ? (
        <div className="card p-8 text-center text-white/30 mt-6">
          Rankings not yet available. Run the rankings scraper to populate.
        </div>
      ) : (
        <div className="flex gap-6 mt-6">
          {/* Weight class sidebar */}
          <aside className="flex-shrink-0 w-44">
            <div className="space-y-1 sticky top-4">
              {divisions.map(d => (
                <button
                  key={d.weight_class.slug}
                  onClick={() => setSelected(d.weight_class.slug)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-xs font-medium transition-colors ${
                    selected === d.weight_class.slug
                      ? 'bg-gold text-dark-1'
                      : 'bg-dark-3 text-white/50 hover:text-white hover:bg-dark-4'
                  }`}
                >
                  {d.weight_class.name}
                </button>
              ))}
            </div>
          </aside>

          {/* Rankings list */}
          <div className="flex-1 min-w-0">
            {division ? (
              <DivisionRankings division={division} />
            ) : (
              <div className="text-white/30 text-sm">Select a weight class</div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}

function DivisionRankings({ division }) {
  const wc = division.weight_class;
  return (
    <div>
      <div className="mb-6">
        <h2 className="font-display text-2xl tracking-[0.1em]">{wc.name.toUpperCase()}</h2>
      </div>

      <div className="space-y-1.5">
        {/* Champion */}
        {division.champion && (
          <div className="card p-4 border-gold/20 mb-4">
            <div className="flex items-center gap-4">
              <div className="w-8 text-center flex-shrink-0">
                <span className="text-gold text-lg">&#127942;</span>
              </div>
              <div className="flex-1 min-w-0">
                <Link to={`/fighters/${division.champion.slug}`} className="font-medium hover:text-gold transition-colors">
                  {division.champion.first_name} {division.champion.last_name}
                </Link>
                {division.champion.nickname && (
                  <span className="text-xs text-white/30 ml-2">"{division.champion.nickname}"</span>
                )}
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-sm font-medium text-win">
                  {formatProRecord(division.champion)}
                </div>
                <div className="text-[9px] tracking-[0.2em] text-gold uppercase mt-0.5">Champion</div>
              </div>
            </div>
          </div>
        )}

        {/* Ranked 1-15 */}
        {division.ranked.map(({ rank, is_interim, fighter }) => (
          fighter ? (
            <div key={fighter.id} className="card p-4 hover:border-white/10 transition-colors">
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
                  {is_interim && (
                    <span className="ml-2 text-[9px] text-gold/70 uppercase tracking-wider">Interim</span>
                  )}
                </div>
                <div className="text-right flex-shrink-0">
                  <div className="text-sm font-medium">
                    {formatProRecord(fighter)}
                  </div>
                </div>
              </div>
            </div>
          ) : null
        ))}

        {division.ranked.length === 0 && !division.champion && (
          <div className="card p-8 text-center text-white/30">No rankings data</div>
        )}
      </div>
    </div>
  );
}

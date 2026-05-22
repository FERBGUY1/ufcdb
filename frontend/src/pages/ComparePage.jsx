import { useState, useRef } from 'react';
import { Link } from 'react-router-dom';
import { search as apiSearch, fmtRecord, fmtHeight } from '../lib/api';
import axios from 'axios';

export default function ComparePage() {
  const [f1, setF1] = useState(null);
  const [f2, setF2] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const compare = async () => {
    if (!f1 || !f2) return;
    setLoading(true); setError(null);
    try {
      const r = await axios.get(`/api/fighters/${f1.slug}/compare`, { params: { opponent: f2.slug } });
      setData(r.data);
    } catch (e) {
      setError('Could not load comparison.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="page-header">COMPARE FIGHTERS</h1>
      <p className="page-sub">Side by side stat comparison for any two fighters in the database</p>

      <div className="flex gap-3 mb-6 flex-wrap">
        <FighterPicker label="Fighter 1" selected={f1} onSelect={(v) => { setF1(v); setData(null); }} />
        <FighterPicker label="Fighter 2" selected={f2} onSelect={(v) => { setF2(v); setData(null); }} />
        <button
          onClick={compare}
          disabled={!f1 || !f2 || loading}
          className="btn-gold self-end disabled:opacity-40"
        >
          {loading ? 'Loading…' : 'Compare →'}
        </button>
      </div>

      {error && <div className="text-red-400 text-sm mb-4">{error}</div>}

      {data && (
        <div className="card overflow-hidden">
          {/* Fighter headers */}
          <div className="grid grid-cols-[1fr_auto_1fr] p-5 gap-4 border-b border-white/[0.06]">
            <div>
              <Link to={`/fighters/${data.fighter1.slug}`} className="font-display text-2xl tracking-wider hover:text-gold block">
                {data.fighter1.first_name.toUpperCase()} {data.fighter1.last_name.toUpperCase()}
              </Link>
              <div className="text-white/40 text-sm">{fmtRecord(data.fighter1.wins, data.fighter1.losses, data.fighter1.draws)}</div>
              {data.fighter1.primary_style && <div className="text-gold text-xs mt-1">{data.fighter1.primary_style}</div>}
            </div>
            <div className="font-display text-2xl text-loss self-center">VS</div>
            <div className="text-right">
              <Link to={`/fighters/${data.fighter2.slug}`} className="font-display text-2xl tracking-wider hover:text-gold block">
                {data.fighter2.first_name.toUpperCase()} {data.fighter2.last_name.toUpperCase()}
              </Link>
              <div className="text-white/40 text-sm">{fmtRecord(data.fighter2.wins, data.fighter2.losses, data.fighter2.draws)}</div>
              {data.fighter2.primary_style && <div className="text-gold text-xs mt-1">{data.fighter2.primary_style}</div>}
            </div>
          </div>

          {/* Head to head */}
          {data.head_to_head?.length > 0 && (
            <div className="p-4 border-b border-white/[0.06]">
              <div className="text-[10px] tracking-widest text-gold uppercase mb-2">Head to Head</div>
              {data.head_to_head.map((f, i) => (
                <div key={i} className="text-xs text-white/50 py-1">
                  {f.events?.name} · {f.method} R{f.round} → {f.winner?.first_name} {f.winner?.last_name}
                </div>
              ))}
            </div>
          )}

          {/* Stat comparison */}
          <div className="divide-y divide-white/[0.04]">
            {data.stat_comparison?.map(s => (
              <div key={s.key} className="px-5 py-3 grid grid-cols-[1fr_auto_1fr] gap-3 items-center">
                <div className={`text-sm font-medium text-right ${s.advantage === 'fighter1' ? 'text-gold' : 'text-white/50'}`}>
                  {s.fighter1_value ?? '--'}{s.is_percent ? '%' : ''}
                </div>
                <div className="text-[10px] text-white/30 w-36 text-center">{s.label}</div>
                <div className={`text-sm font-medium ${s.advantage === 'fighter2' ? 'text-gold' : 'text-white/50'}`}>
                  {s.fighter2_value ?? '--'}{s.is_percent ? '%' : ''}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {f1 && f2 && !data && !loading && (
        <div className="text-center mt-6">
          <Link to={`/predict?f1=${f1.slug}&f2=${f2.slug}`} className="btn-gold">
            Get AI Fight Prediction →
          </Link>
        </div>
      )}
    </main>
  );
}

function FighterPicker({ label, selected, onSelect }) {
  if (selected) {
    return (
      <div className="card px-4 py-2 flex items-center gap-2 flex-1 min-w-48">
        <span className="text-xs text-white/40">{label}:</span>
        <span className="text-sm font-medium">{selected.first_name} {selected.last_name}</span>
        <button onClick={() => onSelect(null)} className="ml-auto text-white/30 hover:text-white text-xs">✕</button>
      </div>
    );
  }
  return <SearchBox label={label} onSelect={onSelect} />;
}

function SearchBox({ label, onSelect }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  const onType = (val) => {
    setQ(val);
    clearTimeout(timer.current);
    if (val.length < 2) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      const d = await apiSearch(val, 8);
      setResults(d.fighters || []);
      setOpen(true);
    }, 250);
  };

  return (
    <div className="relative flex-1 min-w-48">
      <div className="text-xs text-white/30 mb-1">{label}</div>
      <input
        className="input-dark w-full"
        placeholder="Search fighter…"
        value={q}
        onChange={e => onType(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-dark-3 border border-white/10 rounded-xl overflow-hidden z-40 max-h-52 overflow-y-auto">
          {results.map(f => (
            <button
              key={f.id}
              onMouseDown={() => { onSelect(f); setQ(''); setOpen(false); }}
              className="w-full text-left px-3 py-2.5 hover:bg-dark-4 transition-colors border-b border-white/[0.04] last:border-0"
            >
              <div className="text-sm font-medium">{f.first_name} {f.last_name}</div>
              <div className="text-xs text-white/40">{fmtRecord(f.wins, f.losses, f.draws)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

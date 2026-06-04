import { useState, useRef, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { getPrediction, search, fmtRecord, getFighter } from '../lib/api';

const WEIGHT_CLASSES = [
  { slug: 'strawweight',         name: 'Strawweight' },
  { slug: 'flyweight',           name: 'Flyweight' },
  { slug: 'bantamweight',        name: 'Bantamweight' },
  { slug: 'featherweight',       name: 'Featherweight' },
  { slug: 'lightweight',         name: 'Lightweight' },
  { slug: 'welterweight',        name: 'Welterweight' },
  { slug: 'middleweight',        name: 'Middleweight' },
  { slug: 'light-heavyweight',   name: 'Light Heavyweight' },
  { slug: 'heavyweight',         name: 'Heavyweight' },
  { slug: 'womens-strawweight',  name: "Women's Strawweight" },
  { slug: 'womens-flyweight',    name: "Women's Flyweight" },
  { slug: 'womens-bantamweight', name: "Women's Bantamweight" },
  { slug: 'womens-featherweight',name: "Women's Featherweight" },
];

export default function PredictPage() {
  const [searchParams] = useSearchParams();
  const [f1, setF1] = useState(null);
  const [f2, setF2] = useState(null);
  const [weightClass, setWeightClass] = useState('');
  const [prediction, setPrediction] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Pre-load fighters from URL params and auto-predict if both present
  useEffect(() => {
    const slug1 = searchParams.get('f1') || searchParams.get('fighter1');
    const slug2 = searchParams.get('f2') || searchParams.get('fighter2');
    if (!slug1 && !slug2) return;

    Promise.all([
      slug1 ? getFighter(slug1).then(d => d.fighter).catch(() => null) : Promise.resolve(null),
      slug2 ? getFighter(slug2).then(d => d.fighter).catch(() => null) : Promise.resolve(null),
    ]).then(([fighter1, fighter2]) => {
      if (fighter1) setF1(fighter1);
      if (fighter2) setF2(fighter2);
      if (fighter1 && fighter2) {
        setLoading(true); setError(null); setPrediction(null);
        getPrediction(fighter1.slug, fighter2.slug, null)
          .then(setPrediction)
          .catch(e => setError(e.response?.data?.error || 'Prediction failed. Try again.'))
          .finally(() => setLoading(false));
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const predict = async () => {
    if (!f1 || !f2) return;
    setLoading(true); setError(null); setPrediction(null);
    try {
      const data = await getPrediction(f1.slug, f2.slug, weightClass || null);
      setPrediction(data);
    } catch (e) {
      setError(e.response?.data?.error || 'Prediction failed. Try again.');
    } finally {
      setLoading(false);
    }
  };

  const canPredict = f1 && f2 && f1.slug !== f2.slug;

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <div className="mb-8">
        <h1 className="page-header">FIGHT PREDICTOR</h1>
        <p className="page-sub">
          Select any two fighters. Our engine analyzes styles, stats, cardio, and historical matchup data.
        </p>
        <div className="text-xs text-white/20 bg-dark-3 border border-white/[0.06] rounded-lg px-4 py-3 mt-3">
          Predictions are generated from historical data. Not a guarantee of outcome. Do not use for betting.
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-start mb-5">
        <FighterSelector label="Fighter 1" selected={f1} onSelect={setF1} onClear={() => { setF1(null); setPrediction(null); }} />
        <div className="flex items-center justify-center pt-8">
          <span className="font-display text-3xl text-loss tracking-widest">VS</span>
        </div>
        <FighterSelector label="Fighter 2" selected={f2} onSelect={setF2} onClear={() => { setF2(null); setPrediction(null); }} />
      </div>

      <div className="flex justify-center mb-6">
        <div className="flex items-center gap-3 bg-dark-3 border border-white/[0.06] rounded-lg px-4 py-2.5">
          <span className="text-[10px] tracking-[0.2em] text-white/30 uppercase">Weight Class</span>
          <select
            value={weightClass}
            onChange={e => { setWeightClass(e.target.value); setPrediction(null); }}
            className="bg-dark-3 border-none text-sm text-white/80 focus:outline-none cursor-pointer rounded"
          >
            <option value="" className="bg-dark-3 text-white">Auto (fighter's natural class)</option>
            {WEIGHT_CLASSES.map(wc => (
              <option key={wc.slug} value={wc.slug} className="bg-dark-3 text-white">{wc.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex justify-center mb-10">
        <button
          onClick={predict}
          disabled={!canPredict || loading}
          className={`font-display tracking-widest text-base px-10 py-3 rounded-lg transition-all duration-200 ${
            canPredict && !loading ? 'bg-gold text-dark-DEFAULT hover:bg-gold-light' : 'bg-dark-4 text-white/20 cursor-not-allowed'
          }`}
        >
          {loading ? 'ANALYZING...' : 'GENERATE PREDICTION'}
        </button>
      </div>

      {error && <div className="text-red-400 text-sm text-center mb-6">{error}</div>}

      {loading && (
        <div className="text-center py-16">
          <div className="font-display text-2xl tracking-widest text-white/20 mb-3">ANALYZING FIGHTERS</div>
          <div className="text-sm text-white/30">Comparing styles, stats, cardio, opponent quality...</div>
          <div className="mt-6 flex justify-center gap-1.5">
            {[0,1,2].map(i => (
              <div key={i} className="w-2 h-2 bg-gold rounded-full animate-bounce" style={{animationDelay:`${i*0.15}s`}} />
            ))}
          </div>
        </div>
      )}

      {prediction && !loading && <PredictionResult prediction={prediction} f1Name={f1} f2Name={f2} />}
    </main>
  );
}

function FighterSelector({ label, selected, onSelect, onClear }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  const [open, setOpen] = useState(false);
  const timer = useRef(null);

  const onType = (val) => {
    setQ(val);
    clearTimeout(timer.current);
    if (val.length < 2) { setResults([]); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      const data = await search(val, 8);
      setResults(data.fighters || []);
      setOpen(true);
    }, 250);
  };

  const pick = (f) => { onSelect(f); setQ(''); setResults([]); setOpen(false); };

  if (selected) {
    return (
      <div className="card p-5 text-center relative">
        <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-3">{label}</div>
        <div className="w-16 h-16 rounded-full bg-dark-4 border-2 border-gold/40 flex items-center justify-center font-display text-2xl text-gold mx-auto mb-3">
          {selected.first_name?.[0]}{selected.last_name?.[0]}
        </div>
        <Link to={`/fighters/${selected.slug}`} className="font-display text-xl tracking-wider hover:text-gold transition-colors">
          {selected.first_name?.toUpperCase()} {selected.last_name?.toUpperCase()}
        </Link>
        <div className="text-xs text-white/40 mt-1">{fmtRecord(selected.wins, selected.losses, selected.draws)}</div>
        <div className="text-xs text-gold/70 mt-0.5">{selected.primary_style}</div>
        <button
          onClick={onClear}
          className="mt-4 flex items-center gap-1.5 mx-auto text-xs text-white/40 hover:text-red-400 transition-colors border border-white/10 hover:border-red-500/30 rounded-lg px-3 py-1.5"
        >
          <span>&#x2715;</span> Change Fighter
        </button>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-3">{label}</div>
      <div className="relative">
        <input
          type="text" value={q} onChange={e => onType(e.target.value)}
          placeholder="Search fighter name..." className="input-dark"
          onFocus={() => results.length && setOpen(true)}
        />
        {open && results.length > 0 && (
          <div className="absolute top-full mt-1 left-0 right-0 bg-dark-3 border border-white/10 rounded-xl overflow-hidden shadow-2xl z-40 max-h-64 overflow-y-auto">
            {results.map(f => (
              <button key={f.id} onClick={() => pick(f)}
                className="w-full flex items-center gap-3 px-4 py-3 hover:bg-dark-4 transition-colors text-left border-b border-white/[0.04] last:border-0">
                <div className="w-9 h-9 rounded-full bg-dark-5 flex items-center justify-center font-display text-sm text-gold flex-shrink-0">
                  {f.first_name?.[0]}{f.last_name?.[0]}
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium">{f.first_name} {f.last_name}</div>
                  <div className="text-xs text-white/40">{fmtRecord(f.wins,f.losses,f.draws)} · {f.primary_style || 'Unknown style'}</div>
                </div>
                <span className={`ml-auto text-[9px] px-2 py-0.5 rounded-full ${f.status === 'active' ? 'bg-win/10 text-win' : 'bg-white/5 text-white/30'}`}>
                  {f.status}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WeightClassContext({ ctx, f1, f2 }) {
  const warnings = [];
  if (ctx.f1_moving_up && ctx.f1_primary_class) warnings.push((f1?.last_name || '') + ' moving UP from ' + ctx.f1_primary_class);
  if (ctx.f1_moving_down && ctx.f1_primary_class) warnings.push((f1?.last_name || '') + ' moving DOWN from ' + ctx.f1_primary_class);
  if (ctx.f2_moving_up && ctx.f2_primary_class) warnings.push((f2?.last_name || '') + ' moving UP from ' + ctx.f2_primary_class);
  if (ctx.f2_moving_down && ctx.f2_primary_class) warnings.push((f2?.last_name || '') + ' moving DOWN from ' + ctx.f2_primary_class);

  return (
    <div className={`card p-4 mb-5 ${ctx.has_size_mismatch ? 'border-orange-500/20' : ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10px] tracking-[0.2em] text-white/30 uppercase">Predicting at</span>
        <span className="text-sm font-medium text-gold">{ctx.weight_class}</span>
        {warnings.map((w, i) => (
          <span key={i} className="text-[10px] bg-orange-500/10 text-orange-300 px-2 py-0.5 rounded-full border border-orange-500/20">{w}</span>
        ))}
        {ctx.uncertainty_flag && (
          <span className="text-[10px] text-white/25 ml-auto">Cross-weight matchup — added uncertainty</span>
        )}
      </div>
    </div>
  );
}

function MethodBar({ label, pct, color }) {
  return (
    <div>
      <div className="flex justify-between mb-1.5">
        <span className="text-xs text-white/40">{label}</span>
        <span className="text-xs font-medium">{pct?.toFixed(1)}%</span>
      </div>
      <div className="stat-bar-track">
        <div className={`stat-bar-fill ${color}`} style={{ width: `${Math.min(pct,100)}%` }} />
      </div>
    </div>
  );
}

function PredictionResult({ prediction: p, f1Name, f2Name }) {
  const f1 = p.fighter1 || f1Name;
  const f2 = p.fighter2 || f2Name;
  const f1WinPct = parseFloat(p.fighter1_win_pct);
  const f2WinPct = parseFloat(p.fighter2_win_pct);
  const confidenceColor = { high: 'text-win', medium: 'text-gold', low: 'text-white/40' }[p.confidence] || 'text-white/40';

  return (
    <div className="space-y-5">
      {p.weight_class_context && <WeightClassContext ctx={p.weight_class_context} f1={f1} f2={f2} />}

      <div className="card p-6">
        <div className="text-[10px] tracking-[0.3em] text-gold uppercase text-center mb-4">
          Win Probability <span className={`ml-3 ${confidenceColor}`}>· {p.confidence?.toUpperCase()} CONFIDENCE</span>
        </div>
        <div className="grid grid-cols-[1fr_auto_1fr] gap-4 items-center mb-5">
          <div className="text-center">
            <div className="font-display text-4xl tracking-wider">{f1WinPct}%</div>
            <Link to={`/fighters/${f1?.slug}`} className="text-sm font-medium hover:text-gold transition-colors">{f1?.first_name} {f1?.last_name}</Link>
            <div className="text-xs text-gold/60 mt-0.5">{f1?.primary_style}</div>
          </div>
          <div className="font-display text-2xl text-loss tracking-widest">VS</div>
          <div className="text-center">
            <div className="font-display text-4xl tracking-wider">{f2WinPct}%</div>
            <Link to={`/fighters/${f2?.slug}`} className="text-sm font-medium hover:text-gold transition-colors">{f2?.first_name} {f2?.last_name}</Link>
            <div className="text-xs text-gold/60 mt-0.5">{f2?.primary_style}</div>
          </div>
        </div>
        <div className="relative h-3 bg-dark-5 rounded-full overflow-hidden">
          <div className="absolute left-0 top-0 h-full bg-gold rounded-full" style={{ width: `${f1WinPct}%` }} />
          <div className="absolute right-0 top-0 h-full bg-red-700/70 rounded-full" style={{ width: `${f2WinPct}%` }} />
        </div>
        <div className="flex justify-between mt-1.5">
          <span className="text-xs text-gold">{f1?.last_name}</span>
          <span className="text-xs text-red-400">{f2?.last_name}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="card p-5">
          <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-4">{f1?.first_name} {f1?.last_name} wins by...</div>
          <div className="space-y-3">
            <MethodBar label="KO / TKO"   pct={parseFloat(p.fighter1_ko_pct)}  color="bg-red-600" />
            <MethodBar label="Submission" pct={parseFloat(p.fighter1_sub_pct)} color="bg-blue-600" />
            <MethodBar label="Decision"   pct={parseFloat(p.fighter1_dec_pct)} color="bg-gold" />
          </div>
        </div>
        <div className="card p-5">
          <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-4">{f2?.first_name} {f2?.last_name} wins by...</div>
          <div className="space-y-3">
            <MethodBar label="KO / TKO"   pct={parseFloat(p.fighter2_ko_pct)}  color="bg-red-600" />
            <MethodBar label="Submission" pct={parseFloat(p.fighter2_sub_pct)} color="bg-blue-600" />
            <MethodBar label="Decision"   pct={parseFloat(p.fighter2_dec_pct)} color="bg-gold" />
          </div>
        </div>
      </div>

      {p.round_projections?.length > 0 && (
        <div className="card p-5">
          <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-4">Round by Round Projection</div>
          <div className="space-y-2.5">
            {p.round_projections.map(r => (
              <div key={r.round} className="grid grid-cols-[auto_1fr_auto] gap-3 items-center">
                <span className="text-xs text-white/30 w-12">Round {r.round}</span>
                <div className="relative h-2 bg-dark-5 rounded-full overflow-hidden">
                  <div className="absolute left-0 top-0 h-full bg-gold/60 rounded-full" style={{ width: `${r.f1_control_pct}%` }} />
                </div>
                <span className="text-xs text-white/40 text-right w-24 truncate">{r.projected_control}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-between mt-3 text-[10px] text-white/20">
            <span>{f1?.last_name} ←</span><span>→ {f2?.last_name}</span>
          </div>
        </div>
      )}

      {p.key_factors?.length > 0 && (
        <div className="card p-5">
          <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-4">Key Factors</div>
          <div className="space-y-2">
            {p.key_factors.map((factor, i) => (
              <div key={i} className="flex gap-3 text-sm text-white/70 leading-relaxed">
                <span className="text-gold font-display text-base flex-shrink-0 mt-0.5">#{i+1}</span>
                <span>{factor}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {p.ai_breakdown && (
        <div className="card p-6">
          <div className="text-[10px] tracking-[0.2em] text-gold uppercase mb-4">AI Analysis</div>
          <div className="text-sm text-white/70 leading-relaxed whitespace-pre-line">{p.ai_breakdown}</div>
          <div className="mt-4 pt-4 border-t border-white/[0.04] text-[10px] text-white/20">
            Generated by UFCDB prediction model v{p.model_version} · {new Date(p.generated_at).toLocaleDateString()}
          </div>
        </div>
      )}

      <div className="flex gap-3 justify-center pt-2">
        <Link to={`/fighters/${f1?.slug}`} className="btn-outline text-xs">{f1?.last_name} Profile</Link>
        <Link to={`/fighters/${f2?.slug}`} className="btn-outline text-xs">{f2?.last_name} Profile</Link>
        <Link to={`/compare?f1=${f1?.slug}&f2=${f2?.slug}`} className="btn-outline text-xs">Compare Fighters</Link>
      </div>
    </div>
  );
}

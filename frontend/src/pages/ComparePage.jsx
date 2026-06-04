import { useState, useRef, useEffect } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { search as apiSearch, fmtRecord, fmtHeight, getFighter } from '../lib/api';
import axios from 'axios';

export default function ComparePage() {
  const [searchParams] = useSearchParams();
  const [f1, setF1] = useState(null);
  const [f2, setF2] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Pre-load fighters from URL params and auto-compare if both present
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
        setLoading(true);
        axios.get(`/api/fighters/${fighter1.slug}/compare`, { params: { opponent: fighter2.slug } })
          .then(r => setData(r.data))
          .catch(() => setError('Could not load comparison.'))
          .finally(() => setLoading(false));
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const runCompare = async (slug1, slug2) => {
    setLoading(true); setError(null); setData(null);
    try {
      const r = await axios.get(`/api/fighters/${slug1}/compare`, { params: { opponent: slug2 } });
      setData(r.data);
    } catch {
      setError('Could not load comparison. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleCompare = () => {
    if (f1 && f2 && f1.slug !== f2.slug) runCompare(f1.slug, f2.slug);
  };

  const canCompare = f1 && f2 && f1.slug !== f2?.slug && !loading;

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="page-header">COMPARE FIGHTERS</h1>
      <p className="page-sub">Side-by-side comparison of any two fighters in the database</p>

      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr] gap-4 items-start mb-5">
        <FighterCard label="Fighter 1" selected={f1}
          onSelect={v => { setF1(v); setData(null); }}
          onClear={() => { setF1(null); setData(null); }} />
        <div className="flex items-center justify-center py-4">
          <span className="font-display text-2xl text-loss tracking-widest">VS</span>
        </div>
        <FighterCard label="Fighter 2" selected={f2}
          onSelect={v => { setF2(v); setData(null); }}
          onClear={() => { setF2(null); setData(null); }} />
      </div>

      <div className="flex justify-center mb-8">
        <button
          onClick={handleCompare}
          disabled={!canCompare}
          className={`font-display tracking-widest text-sm px-10 py-3 rounded-lg transition-all duration-200 ${
            canCompare ? 'bg-gold text-dark hover:bg-gold-light' : 'bg-dark-4 text-white/20 cursor-not-allowed'
          }`}
        >
          {loading ? 'LOADING...' : 'COMPARE →'}
        </button>
      </div>

      {error && <div className="text-red-400 text-sm text-center mb-6">{error}</div>}

      {loading && (
        <div className="text-center py-16">
          <div className="font-display text-xl tracking-widest text-white/20 mb-4">LOADING COMPARISON</div>
          <div className="flex justify-center gap-1.5">
            {[0, 1, 2].map(i => (
              <div key={i} className="w-2 h-2 bg-gold rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
            ))}
          </div>
        </div>
      )}

      {data && !loading && <ComparisonResults data={data} />}
    </main>
  );
}

// ── FIGHTER CARD (PICKER) ─────────────────────────────────

function FighterCard({ label, selected, onSelect, onClear }) {
  if (selected) {
    return (
      <div className="card p-5">
        <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-3">{label}</div>
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-full bg-dark-4 border border-gold/30 flex items-center justify-center font-display text-xl text-gold flex-shrink-0">
            {selected.first_name?.[0]}{selected.last_name?.[0]}
          </div>
          <div className="flex-1 min-w-0">
            <Link
              to={`/fighters/${selected.slug}`}
              className="font-display text-lg tracking-wider hover:text-gold transition-colors block truncate"
            >
              {selected.first_name?.toUpperCase()} {selected.last_name?.toUpperCase()}
            </Link>
            <div className="text-xs text-white/40 mt-0.5">
              {fmtRecord(selected.wins, selected.losses, selected.draws)}
              {selected.primary_style && <span className="ml-2 text-gold/60">{selected.primary_style}</span>}
            </div>
          </div>
          <button onClick={onClear} className="text-white/20 hover:text-white/60 transition-colors text-xs flex-shrink-0 ml-1">
            ✕
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card p-5">
      <div className="text-[10px] tracking-[0.2em] text-white/30 uppercase mb-3">{label}</div>
      <SearchBox onSelect={onSelect} />
    </div>
  );
}

function SearchBox({ onSelect }) {
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
    <div className="relative">
      <input
        className="input-dark"
        placeholder="Search fighter name..."
        value={q}
        onChange={e => onType(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && results.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-dark-3 border border-white/10 rounded-xl overflow-hidden z-40 max-h-56 overflow-y-auto shadow-2xl">
          {results.map(f => (
            <button
              key={f.id}
              onMouseDown={() => { onSelect(f); setQ(''); setOpen(false); }}
              className="w-full text-left flex items-center gap-3 px-3 py-2.5 hover:bg-dark-4 transition-colors border-b border-white/[0.04] last:border-0"
            >
              <div className="w-8 h-8 rounded-full bg-dark-5 flex items-center justify-center font-display text-sm text-gold flex-shrink-0">
                {f.first_name?.[0]}{f.last_name?.[0]}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-medium">{f.first_name} {f.last_name}</div>
                <div className="text-xs text-white/40">{fmtRecord(f.wins, f.losses, f.draws)} · {f.primary_style || 'Unknown style'}</div>
              </div>
              <span className={`ml-auto text-[9px] px-2 py-0.5 rounded-full flex-shrink-0 ${f.status === 'active' ? 'bg-win/10 text-win' : 'bg-white/5 text-white/30'}`}>
                {f.status}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── COMPARISON RESULTS ────────────────────────────────────

function ComparisonResults({ data }) {
  const {
    fighter1: f1, fighter2: f2,
    head_to_head = [], stat_comparison = [],
    rankings1 = [], rankings2 = [],
    recent_fights1 = [], recent_fights2 = [],
  } = data;

  return (
    <div className="space-y-5">
      <HeroSection f1={f1} f2={f2} rankings1={rankings1} rankings2={rankings2} />
      {head_to_head.length > 0 && (
        <HeadToHeadSection fights={head_to_head} f1={f1} f2={f2} />
      )}
      <RecordsSection f1={f1} f2={f2} />
      <PhysicalSection f1={f1} f2={f2} />
      <FightStatsSection stats={stat_comparison} f1={f1} f2={f2} />
      <RecentFightsSection f1={f1} f2={f2} fights1={recent_fights1} fights2={recent_fights2} />
      <div className="flex flex-wrap gap-3 justify-center pt-2 pb-4">
        <Link to={`/fighters/${f1.slug}`} className="btn-outline text-xs">
          {f1.first_name} {f1.last_name} Profile
        </Link>
        <Link to={`/predict?f1=${f1.slug}&f2=${f2.slug}`} className="btn-gold">
          AI Fight Prediction →
        </Link>
        <Link to={`/fighters/${f2.slug}`} className="btn-outline text-xs">
          {f2.first_name} {f2.last_name} Profile
        </Link>
      </div>
    </div>
  );
}

// ── HERO SECTION ──────────────────────────────────────────

function HeroSection({ f1, f2, rankings1, rankings2 }) {
  const rank1 = f1.is_champion ? 'CHAMPION' : rankings1?.[0]?.rank ? `#${rankings1[0].rank}` : null;
  const rank2 = f2.is_champion ? 'CHAMPION' : rankings2?.[0]?.rank ? `#${rankings2[0].rank}` : null;

  return (
    <div className="card overflow-hidden">
      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto_1fr]">
        {/* Fighter 1 */}
        <div className="p-6 bg-gradient-to-r from-gold/[0.05] to-transparent">
          <div className="flex items-center gap-2 mb-2 flex-wrap">
            {f1.is_champion && (
              <span className="text-[9px] bg-gold/20 text-gold border border-gold/30 px-2 py-0.5 rounded tracking-wider">CHAMPION</span>
            )}
            {rank1 && !f1.is_champion && (
              <span className="text-[10px] text-gold/70">{rank1}</span>
            )}
            <span className={`text-[9px] px-2 py-0.5 rounded-full ${f1.status === 'active' ? 'bg-win/10 text-win' : 'bg-white/5 text-white/30'}`}>
              {f1.status}
            </span>
          </div>
          <Link to={`/fighters/${f1.slug}`} className="font-display text-4xl tracking-wider block hover:text-gold transition-colors leading-none mb-1">
            {f1.first_name.toUpperCase()}
            <br />{f1.last_name.toUpperCase()}
          </Link>
          {f1.nickname && <p className="text-gold/60 italic text-sm mb-2">"{f1.nickname}"</p>}
          <div className="text-xs text-white/40 mb-2">{f1.weight_classes?.name}</div>
          <div className="font-display text-2xl tracking-wider">
            <span className="text-win">{f1.wins ?? 0}</span>
            <span className="text-white/20 mx-1">-</span>
            <span className="text-loss">{f1.losses ?? 0}</span>
            {f1.draws > 0 && <><span className="text-white/20 mx-1">-</span><span className="text-white/40">{f1.draws}</span></>}
          </div>
          {f1.primary_style && (
            <span className="inline-block mt-2 text-[10px] bg-dark-4 text-gold/70 px-2.5 py-1 rounded-md border border-white/[0.06]">
              {f1.primary_style}
            </span>
          )}
        </div>

        {/* VS divider */}
        <div className="flex items-center justify-center px-4 py-4 md:py-0 border-y md:border-y-0 md:border-x border-white/[0.06]">
          <span className="font-display text-3xl text-loss tracking-widest">VS</span>
        </div>

        {/* Fighter 2 */}
        <div className="p-6 text-left md:text-right bg-gradient-to-l from-red-900/[0.04] to-transparent">
          <div className="flex items-center gap-2 mb-2 flex-wrap md:justify-end">
            <span className={`text-[9px] px-2 py-0.5 rounded-full ${f2.status === 'active' ? 'bg-win/10 text-win' : 'bg-white/5 text-white/30'}`}>
              {f2.status}
            </span>
            {f2.is_champion && (
              <span className="text-[9px] bg-gold/20 text-gold border border-gold/30 px-2 py-0.5 rounded tracking-wider">CHAMPION</span>
            )}
            {rank2 && !f2.is_champion && (
              <span className="text-[10px] text-gold/70">{rank2}</span>
            )}
          </div>
          <Link to={`/fighters/${f2.slug}`} className="font-display text-4xl tracking-wider block hover:text-gold transition-colors leading-none mb-1">
            {f2.first_name.toUpperCase()}
            <br />{f2.last_name.toUpperCase()}
          </Link>
          {f2.nickname && <p className="text-gold/60 italic text-sm mb-2">"{f2.nickname}"</p>}
          <div className="text-xs text-white/40 mb-2">{f2.weight_classes?.name}</div>
          <div className="font-display text-2xl tracking-wider">
            <span className="text-win">{f2.wins ?? 0}</span>
            <span className="text-white/20 mx-1">-</span>
            <span className="text-loss">{f2.losses ?? 0}</span>
            {f2.draws > 0 && <><span className="text-white/20 mx-1">-</span><span className="text-white/40">{f2.draws}</span></>}
          </div>
          {f2.primary_style && (
            <span className="inline-block mt-2 text-[10px] bg-dark-4 text-gold/70 px-2.5 py-1 rounded-md border border-white/[0.06]">
              {f2.primary_style}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── HEAD TO HEAD ──────────────────────────────────────────

function HeadToHeadSection({ fights, f1, f2 }) {
  return (
    <div className="card p-5">
      <div className="text-[10px] tracking-[0.3em] text-gold uppercase mb-4">
        Head to Head · {fights.length} Previous {fights.length === 1 ? 'Fight' : 'Fights'}
      </div>
      <div className="divide-y divide-white/[0.04]">
        {fights.map((fight, i) => {
          const f1IsF1 = fight.fighter1_id === f1.id;
          const f1Won = fight.result === 'win' && f1IsF1;
          const f2Won = fight.result === 'win' && !f1IsF1;
          const isDraw = fight.result === 'draw';
          const isNC = fight.result === 'no_contest';

          return (
            <div key={i} className="py-3 flex items-center gap-4">
              <span className={`text-xs font-bold w-6 text-center flex-shrink-0 ${
                f1Won ? 'text-win' : f2Won ? 'text-loss' : 'text-white/30'
              }`}>
                {isDraw ? 'D' : isNC ? 'NC' : f1Won ? 'W' : 'L'}
              </span>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium">
                  {isDraw ? 'Draw' : isNC ? 'No Contest' : f1Won
                    ? `${f1.first_name} ${f1.last_name} wins`
                    : `${f2.first_name} ${f2.last_name} wins`
                  }
                </div>
                {fight.method && (
                  <div className="text-xs text-white/40 mt-0.5">
                    {fight.method}{fight.round ? ` · Round ${fight.round}` : ''}
                    {fight.time ? ` · ${fight.time}` : ''}
                  </div>
                )}
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-xs text-white/50">{fight.events?.name}</div>
                <div className="text-xs text-white/25">{fight.events?.date}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── RECORDS SECTION ───────────────────────────────────────

function RecordsSection({ f1, f2 }) {
  const showCareer = (f) =>
    f.career_wins > 0 && (f.career_wins !== f.wins || f.career_losses !== f.losses);

  return (
    <div className="card p-5">
      <div className="text-[10px] tracking-[0.3em] text-gold uppercase mb-5">Fight Record</div>
      <div className="grid grid-cols-[1fr_1px_1fr] gap-6 items-start">
        {/* F1 */}
        <div className="space-y-4">
          <div>
            <div className="font-display text-4xl tracking-wider leading-none">
              <span className="text-win">{f1.wins ?? 0}</span>
              <span className="text-white/20">-</span>
              <span className="text-loss">{f1.losses ?? 0}</span>
              {f1.draws > 0 && <><span className="text-white/20">-</span><span className="text-white/40">{f1.draws}</span></>}
              {f1.no_contests > 0 && <span className="text-white/20 text-2xl ml-1">({f1.no_contests} NC)</span>}
            </div>
            <div className="text-[10px] text-white/25 uppercase tracking-wider mt-1">UFC Record</div>
          </div>
          {showCareer(f1) && (
            <div>
              <div className="font-display text-xl tracking-wider text-white/40">
                {f1.career_wins}-{f1.career_losses}{f1.career_draws > 0 ? `-${f1.career_draws}` : ''}
              </div>
              <div className="text-[10px] text-white/20 uppercase tracking-wider">Pro Career</div>
            </div>
          )}
          <div className="space-y-1.5">
            {f1.wins_ko > 0 && <WinMethod label="KO / TKO" count={f1.wins_ko} />}
            {f1.wins_sub > 0 && <WinMethod label="Submission" count={f1.wins_sub} />}
            {f1.wins_dec > 0 && <WinMethod label="Decision" count={f1.wins_dec} />}
          </div>
        </div>

        {/* Divider */}
        <div className="bg-white/[0.06] self-stretch" />

        {/* F2 */}
        <div className="space-y-4">
          <div>
            <div className="font-display text-4xl tracking-wider leading-none">
              <span className="text-win">{f2.wins ?? 0}</span>
              <span className="text-white/20">-</span>
              <span className="text-loss">{f2.losses ?? 0}</span>
              {f2.draws > 0 && <><span className="text-white/20">-</span><span className="text-white/40">{f2.draws}</span></>}
              {f2.no_contests > 0 && <span className="text-white/20 text-2xl ml-1">({f2.no_contests} NC)</span>}
            </div>
            <div className="text-[10px] text-white/25 uppercase tracking-wider mt-1">UFC Record</div>
          </div>
          {showCareer(f2) && (
            <div>
              <div className="font-display text-xl tracking-wider text-white/40">
                {f2.career_wins}-{f2.career_losses}{f2.career_draws > 0 ? `-${f2.career_draws}` : ''}
              </div>
              <div className="text-[10px] text-white/20 uppercase tracking-wider">Pro Career</div>
            </div>
          )}
          <div className="space-y-1.5">
            {f2.wins_ko > 0 && <WinMethod label="KO / TKO" count={f2.wins_ko} />}
            {f2.wins_sub > 0 && <WinMethod label="Submission" count={f2.wins_sub} />}
            {f2.wins_dec > 0 && <WinMethod label="Decision" count={f2.wins_dec} />}
          </div>
        </div>
      </div>
    </div>
  );
}

function WinMethod({ label, count }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="text-white/30">{label}</span>
      <span className="font-semibold text-white">{count}</span>
    </div>
  );
}

// ── PHYSICAL SECTION ──────────────────────────────────────

function compareAdv(v1, v2, higherBetter = true) {
  if (v1 == null || v2 == null) return null;
  if (v1 === v2) return 'even';
  return (higherBetter ? v1 > v2 : v1 < v2) ? 'f1' : 'f2';
}

function PhysicalSection({ f1, f2 }) {
  const rows = [
    {
      label: 'Height',
      f1val: fmtHeight(f1.height_inches),
      f2val: fmtHeight(f2.height_inches),
      adv: compareAdv(f1.height_inches, f2.height_inches),
      hasData: f1.height_inches || f2.height_inches,
    },
    {
      label: 'Reach',
      f1val: f1.reach_inches ? `${f1.reach_inches}"` : '--',
      f2val: f2.reach_inches ? `${f2.reach_inches}"` : '--',
      adv: compareAdv(f1.reach_inches, f2.reach_inches),
      hasData: f1.reach_inches || f2.reach_inches,
    },
    {
      label: 'Leg Reach',
      f1val: f1.leg_reach_inches ? `${f1.leg_reach_inches}"` : '--',
      f2val: f2.leg_reach_inches ? `${f2.leg_reach_inches}"` : '--',
      adv: compareAdv(f1.leg_reach_inches, f2.leg_reach_inches),
      hasData: f1.leg_reach_inches || f2.leg_reach_inches,
    },
    {
      label: 'Stance',
      f1val: f1.stance || '--',
      f2val: f2.stance || '--',
      adv: null,
      hasData: f1.stance || f2.stance,
    },
    {
      label: 'Weight',
      f1val: f1.weight_lbs ? `${f1.weight_lbs} lbs` : '--',
      f2val: f2.weight_lbs ? `${f2.weight_lbs} lbs` : '--',
      adv: null,
      hasData: f1.weight_lbs || f2.weight_lbs,
    },
  ].filter(r => r.hasData);

  if (rows.length === 0) return null;

  return (
    <div className="card p-5">
      <div className="text-[10px] tracking-[0.3em] text-gold uppercase mb-4">Physical Attributes</div>
      <div className="divide-y divide-white/[0.04]">
        {rows.map(r => (
          <div key={r.label} className="py-3 grid grid-cols-[1fr_auto_1fr] gap-4 items-center">
            <div className={`text-sm font-medium text-right ${r.adv === 'f1' ? 'text-gold' : 'text-white/65'}`}>
              {r.f1val}
            </div>
            <div className="text-[10px] text-white/30 w-28 text-center uppercase tracking-wider">{r.label}</div>
            <div className={`text-sm font-medium ${r.adv === 'f2' ? 'text-gold' : 'text-white/65'}`}>
              {r.f2val}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── FIGHT STATS SECTION ───────────────────────────────────

function FightStatsSection({ stats, f1, f2 }) {
  if (!stats?.length) return null;

  return (
    <div className="card p-5">
      <div className="text-[10px] tracking-[0.3em] text-gold uppercase mb-1">Fight Statistics</div>
      <div className="flex justify-between text-[10px] text-white/20 mb-5">
        <span>{f1.last_name?.toUpperCase()}</span>
        <span>{f2.last_name?.toUpperCase()}</span>
      </div>
      <div className="space-y-5">
        {stats.map(s => (
          <StatCompareRow key={s.key} stat={s} />
        ))}
      </div>
    </div>
  );
}

function StatCompareRow({ stat }) {
  const { label, fighter1_value: v1, fighter2_value: v2, advantage, is_percent } = stat;

  const fmt = (v) => {
    if (v == null) return '--';
    return is_percent ? `${v}%` : `${v}`;
  };

  const n1 = parseFloat(v1) || 0;
  const n2 = parseFloat(v2) || 0;
  const total = n1 + n2;
  const p1 = total > 0 ? (n1 / total) * 100 : 50;
  const p2 = total > 0 ? (n2 / total) * 100 : 50;

  const adv1 = advantage === 'fighter1';
  const adv2 = advantage === 'fighter2';

  return (
    <div>
      <div className="grid grid-cols-[1fr_auto_1fr] gap-3 items-baseline mb-2">
        <div className={`text-sm font-medium text-right ${adv1 ? 'text-gold' : 'text-white/50'}`}>
          {fmt(v1)}
        </div>
        <div className="text-[10px] text-white/30 w-40 text-center">{label}</div>
        <div className={`text-sm font-medium ${adv2 ? 'text-gold' : 'text-white/50'}`}>
          {fmt(v2)}
        </div>
      </div>
      {v1 != null && v2 != null && (
        <div className="h-1.5 bg-dark-5 rounded-full overflow-hidden flex">
          <div
            className={`h-full rounded-l-full transition-all duration-700 ${adv1 ? 'bg-gold' : 'bg-white/15'}`}
            style={{ width: `${p1}%` }}
          />
          <div
            className={`h-full rounded-r-full transition-all duration-700 ${adv2 ? 'bg-gold' : 'bg-white/15'}`}
            style={{ width: `${p2}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ── RECENT FIGHTS SECTION ─────────────────────────────────

function RecentFightsSection({ f1, f2, fights1, fights2 }) {
  if (!fights1?.length && !fights2?.length) return null;

  return (
    <div className="card overflow-hidden">
      <div className="px-5 py-4 border-b border-white/[0.06]">
        <div className="text-[10px] tracking-[0.3em] text-gold uppercase">Recent Fight History</div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 divide-y md:divide-y-0 md:divide-x divide-white/[0.06]">
        <RecentFightsList fighter={f1} fights={fights1} />
        <RecentFightsList fighter={f2} fights={fights2} />
      </div>
    </div>
  );
}

function RecentFightsList({ fighter, fights }) {
  return (
    <div className="p-5">
      <div className="text-xs text-white/40 font-medium uppercase tracking-wider mb-4">
        {fighter.first_name} {fighter.last_name}
      </div>
      {(!fights || fights.length === 0) ? (
        <div className="text-xs text-white/20 py-2">No recent fights on record</div>
      ) : (
        <div className="space-y-1">
          {fights.map(fight => {
            const isF1 = fight.fighter1?.id === fighter.id || fight.fighter1_id === fighter.id;
            const opponent = isF1 ? fight.fighter2 : fight.fighter1;
            const isWin = fight.result === 'win' && isF1;
            const isDraw = fight.result === 'draw';
            const isNC = fight.result === 'no_contest';
            const resultLabel = isDraw ? 'D' : isNC ? 'NC' : isWin ? 'W' : 'L';
            const resultColor = isDraw || isNC
              ? 'text-white/30'
              : isWin ? 'text-win' : 'text-loss';

            return (
              <div key={fight.id} className="flex items-center gap-3 py-2 border-b border-white/[0.03] last:border-0">
                <span className={`text-xs font-bold w-5 text-center flex-shrink-0 ${resultColor}`}>
                  {resultLabel}
                </span>
                <div className="flex-1 min-w-0">
                  {opponent ? (
                    <Link
                      to={`/fighters/${opponent.slug}`}
                      className="text-xs font-medium hover:text-gold transition-colors block truncate"
                    >
                      {opponent.first_name} {opponent.last_name}
                    </Link>
                  ) : (
                    <span className="text-xs text-white/30">Unknown</span>
                  )}
                  {fight.method && (
                    <div className="text-[10px] text-white/30">
                      {fight.method}{fight.round ? ` R${fight.round}` : ''}
                    </div>
                  )}
                </div>
                {fight.events?.date && (
                  <div className="text-[10px] text-white/20 flex-shrink-0">
                    {fight.events.date.substring(0, 4)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

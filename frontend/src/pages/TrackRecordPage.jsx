import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { getTrackRecord } from '../lib/api';

// Every pick shown here was logged before the event (prediction_log) and never
// edited afterwards. Misses stay on the page.

const pct = (x, d = 1) => (x == null ? '—' : `${(x * 100).toFixed(d)}%`);
const num = (x, d = 3) => (x == null ? '—' : x.toFixed(d));
const CONF_STYLE = {
  high:   'text-gold border-gold/40',
  medium: 'text-white/70 border-white/20',
  low:    'text-white/40 border-white/10',
};
const STATUS = {
  hit:     { label: 'HIT',     cls: 'bg-green-500/15 text-green-400', icon: '✓' },
  miss:    { label: 'MISS',    cls: 'bg-red-500/15 text-red-400',     icon: '✗' },
  void:    { label: 'VOID',    cls: 'bg-white/5 text-white/40',       icon: '–' },
  pending: { label: 'PENDING', cls: 'bg-gold/10 text-gold',           icon: '…' },
};
// Graded toss-ups (pick under the toss-up line) are shown but not counted as a hit or miss.
const TOSSUP_STATUS = { label: 'TOSS-UP', cls: 'bg-white/5 text-white/50' };
const isScored = p => (p.status === 'hit' || p.status === 'miss') && !p.tossup;
const VOID_TEXT = { draw: 'Draw', no_contest: 'No contest', cancelled: 'Bout cancelled', matchup_changed: 'Opponent changed' };

function Tile({ label, value, sub }) {
  return (
    <div className="card p-4">
      <div className="text-[10px] tracking-[0.2em] text-white/40 uppercase">{label}</div>
      <div className="font-display text-3xl tracking-wider mt-1">{value}</div>
      {sub && <div className="text-xs text-white/40 mt-1">{sub}</div>}
    </div>
  );
}

// Predicted probability (x) vs actual hit rate (y), one dot per bin sized by n;
// the dashed diagonal is perfect calibration.
function CalibrationChart({ bins }) {
  const [hover, setHover] = useState(null);
  const W = 320, H = 240, L = 40, R = 12, T = 12, B = 32;
  const x = p => L + ((p - 0.5) / 0.5) * (W - L - R);
  const y = p => T + (1 - p) * (H - T - B);
  const pts = bins.filter(b => b.n > 0);
  const maxN = Math.max(1, ...pts.map(b => b.n));
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img"
           aria-label="Calibration: predicted win probability versus actual hit rate">
        {[0, 0.25, 0.5, 0.75, 1].map(v => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke="rgba(255,255,255,0.06)" />
            <text x={L - 6} y={y(v) + 3} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.4)">{v * 100}%</text>
          </g>
        ))}
        {[0.5, 0.6, 0.7, 0.8, 0.9, 1].map(v => (
          <text key={v} x={x(v)} y={H - B + 14} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)">{v * 100}%</text>
        ))}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="rgba(255,255,255,0.4)">Predicted win probability of the pick</text>
        <line x1={x(0.5)} y1={y(0.5)} x2={x(1)} y2={y(1)} stroke="rgba(255,255,255,0.3)" strokeWidth="1.5" strokeDasharray="4 4" />
        <text x={x(0.97)} y={y(0.97) - 6} textAnchor="end" fontSize="9" fill="rgba(255,255,255,0.4)">perfect calibration</text>
        {pts.map(b => (
          <g key={b.bin} onMouseEnter={() => setHover(b)} onMouseLeave={() => setHover(null)}>
            <circle cx={x(b.predicted)} cy={y(b.actual)} r={16} fill="transparent" />
            <circle cx={x(b.predicted)} cy={y(b.actual)} r={4 + 6 * Math.sqrt(b.n / maxN)}
                    fill="#C8A84B" stroke="#1a1a1a" strokeWidth="2" />
          </g>
        ))}
      </svg>
      {hover && (
        <div className="absolute top-2 right-2 card px-3 py-2 text-xs pointer-events-none">
          <div className="text-white/80 font-medium">{hover.bin} picks</div>
          <div className="text-white/50">predicted {pct(hover.predicted)} · actual {pct(hover.actual)}</div>
          <div className="text-white/40">n = {hover.n}</div>
        </div>
      )}
    </div>
  );
}

function FighterName({ f, picked }) {
  const cls = picked ? 'text-white font-medium' : 'text-white/50';
  return f.slug
    ? <Link to={`/fighters/${f.slug}`} className={`${cls} hover:text-gold`}>{f.name}</Link>
    : <span className={cls}>{f.name}</span>;
}

function PickRow({ p }) {
  const graded = p.status === 'hit' || p.status === 'miss';
  const st = graded && p.tossup ? { ...TOSSUP_STATUS, icon: STATUS[p.status].icon } : STATUS[p.status];
  const r = p.result;
  const outcome = p.status === 'pending' ? 'Not yet fought'
    : p.status === 'void' ? (VOID_TEXT[p.void_reason] || 'Void')
    : `${r.winner_name} by ${r.method || '?'}${r.round ? `, R${r.round}${r.time ? ' ' + r.time : ''}` : ''}`;
  return (
    <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-4 px-4 py-3 border-t border-white/[0.04]">
      <span className={`shrink-0 w-20 text-center text-[10px] font-bold tracking-widest rounded px-2 py-1 ${st.cls}`}>
        {st.icon} {st.label}
      </span>
      <div className="flex-1 min-w-0 text-sm">
        <FighterName f={p.fighter1} picked={p.pick.id === p.fighter1.id} />
        <span className="text-white/30"> vs </span>
        <FighterName f={p.fighter2} picked={p.pick.id === p.fighter2.id} />
        {p.is_title_fight && <span className="ml-2 text-[10px] text-gold tracking-widest">TITLE</span>}
        <div className="text-xs text-white/40 mt-0.5">
          Pick: <span className="text-white/70">{p.pick.name}</span> {p.pick.win_pct.toFixed(1)}% · {p.pick.method} · {p.scheduled_rounds} rds
        </div>
      </div>
      <span className={`shrink-0 text-[10px] uppercase tracking-widest border rounded px-2 py-0.5 ${p.tossup ? CONF_STYLE.low : CONF_STYLE[p.confidence]}`}>
        {p.tossup ? 'Toss-up' : p.confidence}
      </span>
      <div className="shrink-0 md:w-56 text-xs text-white/50 md:text-right">{outcome}</div>
    </div>
  );
}

export default function TrackRecordPage() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    getTrackRecord()
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const s = data?.summary;
  const o = s?.overall;

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      <h1 className="page-header">TRACK RECORD</h1>
      <p className="page-sub">
        Every pick is logged before the event and never edited afterwards — misses included.
        Draws, no contests and cancelled bouts are listed but not scored.
      </p>
      <p className="text-xs text-white/40 -mt-2 mb-6">
        <span className="text-white/60">Toss-up rule</span> (set on 15 Oct 2026, before any pick was graded):
        a pick whose win probability is under {s?.tossup_pct ?? 52}% is labelled a toss-up. Toss-ups do not count
        toward accuracy, but they stay in log loss, Brier and calibration, which score the probability itself.
      </p>

      {loading ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 bg-dark-3 rounded-xl animate-pulse" />)}</div>
      ) : error ? (
        <div className="card p-8 text-center text-white/40">Could not load the track record ({error}).</div>
      ) : !data.events.length ? (
        <div className="card p-8 text-center text-white/40">No predictions logged yet.</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <Tile label="Accuracy" value={pct(o.accuracy)}
                  sub={`${o.correct} of ${o.scored} graded picks${o.tossups ? ` · ${o.tossups} toss-up${o.tossups === 1 ? '' : 's'} excluded` : ''}`} />
            <Tile label="Log loss" value={num(o.log_loss)} sub="lower is better · 0.693 = coin flip" />
            <Tile label="Brier" value={num(o.brier)} sub="lower is better · 0.250 = coin flip" />
            <Tile label="Logged" value={s.counts.logged}
                  sub={`${s.counts.pending} pending · ${s.counts.void} void · model ${s.model_versions.join(', ')}`} />
          </div>
          {o.n < 100 && (
            <p className="text-xs text-white/40 mt-3">
              Only {o.n} graded pick{o.n === 1 ? '' : 's'} so far — small samples swing a lot; read the n beside every number.
            </p>
          )}

          <div className="grid md:grid-cols-2 gap-4 mt-6">
            <section className="card p-4">
              <h2 className="text-xs tracking-[0.2em] text-white/50 uppercase mb-3">By confidence</h2>
              <table className="w-full text-sm">
                <thead><tr className="text-[10px] text-white/30 uppercase tracking-widest">
                  <th className="text-left font-normal pb-2">Level</th><th className="text-right font-normal pb-2">Picks</th>
                  <th className="text-right font-normal pb-2">Accuracy</th><th className="text-right font-normal pb-2">Log loss</th>
                </tr></thead>
                <tbody>
                  {s.by_confidence.map(c => (
                    <tr key={c.confidence} className="border-t border-white/[0.04]">
                      <td className="py-2 capitalize">{c.confidence}</td>
                      <td className="py-2 text-right text-white/60">{c.n}</td>
                      <td className="py-2 text-right">{pct(c.accuracy)}</td>
                      <td className="py-2 text-right text-white/60">{num(c.log_loss)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="text-[11px] text-white/30 mt-2">Picks counts every graded pick; accuracy leaves out toss-ups.</p>
            </section>

            <section className="card p-4">
              <h2 className="text-xs tracking-[0.2em] text-white/50 uppercase mb-3">Calibration</h2>
              {o.n ? <CalibrationChart bins={s.calibration} /> : <div className="text-sm text-white/30 py-8 text-center">No graded picks yet.</div>}
              <table className="w-full text-xs mt-3">
                <thead><tr className="text-[10px] text-white/30 uppercase tracking-widest">
                  <th className="text-left font-normal pb-1">Pick prob.</th><th className="text-right font-normal pb-1">Picks</th>
                  <th className="text-right font-normal pb-1">Predicted</th><th className="text-right font-normal pb-1">Actual</th>
                </tr></thead>
                <tbody>
                  {s.calibration.map(b => (
                    <tr key={b.bin} className="border-t border-white/[0.04] text-white/60">
                      <td className="py-1">{b.bin}</td><td className="py-1 text-right">{b.n}</td>
                      <td className="py-1 text-right">{pct(b.predicted)}</td><td className="py-1 text-right text-white">{pct(b.actual)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>

          <h2 className="text-xs tracking-[0.2em] text-white/50 uppercase mt-8 mb-3">Every pick</h2>
          <div className="space-y-4">
            {data.events.map(ev => {
              const g = ev.picks.filter(isScored);
              const hits = g.filter(p => p.status === 'hit').length;
              const graded = ev.picks.some(p => p.status === 'hit' || p.status === 'miss');
              return (
                <section key={ev.event_id} className="card overflow-hidden">
                  <div className="flex items-baseline justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      {ev.slug
                        ? <Link to={`/events/${ev.slug}`} className="font-medium hover:text-gold">{ev.name}</Link>
                        : <span className="font-medium">{ev.name}</span>}
                      <div className="text-xs text-white/40">{ev.date}</div>
                    </div>
                    <div className="shrink-0 text-sm text-white/60">{graded ? `${hits}/${g.length} correct` : 'upcoming'}</div>
                  </div>
                  {ev.picks.map(p => <PickRow key={p.id} p={p} />)}
                </section>
              );
            })}
          </div>
        </>
      )}
    </main>
  );
}

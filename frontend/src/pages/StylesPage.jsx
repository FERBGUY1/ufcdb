import { useEffect, useState } from 'react';
import { getStyleMatchups, getStyleList, getStyleVsStyle } from '../lib/api';

const STYLE_COLORS = {
  'Boxer':                 'bg-blue-900/30 text-blue-300 border-blue-800/30',
  'Kickboxer':             'bg-red-900/30 text-red-300 border-red-800/30',
  'Muay Thai':             'bg-orange-900/30 text-orange-300 border-orange-800/30',
  'Karate':                'bg-yellow-900/30 text-yellow-300 border-yellow-800/30',
  'Taekwondo':             'bg-cyan-900/30 text-cyan-300 border-cyan-800/30',
  'Wrestler (Collegiate)': 'bg-green-900/30 text-green-300 border-green-800/30',
  'Wrestler (Freestyle)':  'bg-emerald-900/30 text-emerald-300 border-emerald-800/30',
  'Wrestler (Greco-Roman)':'bg-teal-900/30 text-teal-300 border-teal-800/30',
  'Sambo':                 'bg-purple-900/30 text-purple-300 border-purple-800/30',
  'Judo':                  'bg-indigo-900/30 text-indigo-300 border-indigo-800/30',
  'BJJ Specialist':        'bg-violet-900/30 text-violet-300 border-violet-800/30',
  'Grappler':              'bg-fuchsia-900/30 text-fuchsia-300 border-fuchsia-800/30',
  'Pressure Fighter':      'bg-rose-900/30 text-rose-300 border-rose-800/30',
  'Counter Striker':       'bg-pink-900/30 text-pink-300 border-pink-800/30',
  'Submission Hunter':     'bg-lime-900/30 text-lime-300 border-lime-800/30',
  'All-Rounder':           'bg-amber-900/30 text-amber-300 border-amber-800/30',
};

const styleColor = (s) => STYLE_COLORS[s] || 'bg-dark-4 text-white/50 border-white/10';

export default function StylesPage() {
  const [styles, setStyles]     = useState([]);
  const [matchups, setMatchups] = useState([]);
  const [selected1, setSel1]    = useState(null);
  const [selected2, setSel2]    = useState(null);
  const [detail, setDetail]     = useState(null);
  const [loading, setLoading]   = useState(true);
  const [detailLoading, setDL]  = useState(false);

  useEffect(() => {
    Promise.all([getStyleList(), getStyleMatchups({ min_fights: 3 })])
      .then(([sl, sm]) => { setStyles(sl.styles||[]); setMatchups(sm.matchups||[]); })
      .finally(() => setLoading(false));
  }, []);

  const pickStyle = async (style) => {
    if (!selected1) { setSel1(style); return; }
    if (!selected2 && style !== selected1) {
      setSel2(style);
      setDL(true);
      const d = await getStyleVsStyle(selected1, style);
      setDetail(d);
      setDL(false);
      return;
    }
    // Reset
    setSel1(style); setSel2(null); setDetail(null);
  };

  const reset = () => { setSel1(null); setSel2(null); setDetail(null); };

  return (
    <main className="max-w-6xl mx-auto px-4 py-8">
      <h1 className="page-header">STYLE MATCHUP ANALYTICS</h1>
      <p className="page-sub">
        Historical win rates between every fighting style combination across all UFC fights.
        Click a style to select it, then click another to see how they match up.
      </p>

      {/* Style selector grid */}
      <div className="mb-8">
        <div className="text-xs text-white/30 mb-3">
          {!selected1 ? 'Select a fighting style to begin' :
           !selected2 ? `${selected1} selected — now pick an opponent style` :
           `${selected1} vs ${selected2}`}
          {selected1 && (
            <button onClick={reset} className="ml-3 text-gold hover:underline">Reset</button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {styles.map(s => (
            <button key={s} onClick={() => pickStyle(s)}
              className={`text-xs px-3 py-2 rounded-lg border transition-all duration-150 ${
                s === selected1 ? 'ring-2 ring-gold ring-offset-1 ring-offset-dark-DEFAULT ' + styleColor(s) :
                s === selected2 ? 'ring-2 ring-red-400 ring-offset-1 ring-offset-dark-DEFAULT ' + styleColor(s) :
                styleColor(s)
              }`}>
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Detail matchup */}
      {(detailLoading || detail) && (
        <div className="card p-6 mb-8">
          {detailLoading ? (
            <div className="text-center text-white/30 py-8">Loading matchup data...</div>
          ) : detail?.matchup ? (
            <MatchupDetail matchup={detail.matchup} />
          ) : (
            <div className="text-center text-white/30 py-8">
              {detail?.message || 'No significant matchup data for this combination yet.'}
              <p className="text-xs mt-2">This will populate as fight data is imported.</p>
            </div>
          )}
        </div>
      )}

      {/* All matchups table */}
      <div>
        <h2 className="section-title">All Style Matchups</h2>
        {loading ? (
          <div className="text-white/30 text-center py-8">Loading matchup data...</div>
        ) : matchups.length === 0 ? (
          <div className="card p-8 text-center text-white/30">
            <p className="text-lg mb-2">No matchup data yet</p>
            <p className="text-sm">Run the scraper and style computation to populate this section.</p>
            <code className="text-xs bg-dark-4 px-3 py-1.5 rounded mt-3 inline-block text-gold">
              npm run scrape:ufcstats && npm run compute:styles
            </code>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {['Style 1','Style 2','Fights','Style 1 Win%','Style 2 Win%','KO%','Sub%','Dec%','Avg Time'].map(h => (
                    <th key={h} className="text-left px-4 py-3 text-[10px] tracking-[0.15em] text-white/30 uppercase font-medium whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {matchups.map((m,i) => (
                  <tr key={i}
                    onClick={() => { setSel1(m.style1); setSel2(m.style2); setDetail({ matchup: m }); window.scrollTo(0,0); }}
                    className="border-b border-white/[0.03] hover:bg-white/[0.02] cursor-pointer transition-colors">
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded border ${styleColor(m.style1)}`}>{m.style1}</span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-1 rounded border ${styleColor(m.style2)}`}>{m.style2}</span>
                    </td>
                    <td className="px-4 py-3 text-white/50">{m.total_fights}</td>
                    <td className="px-4 py-3">
                      <WinPctCell pct={m.style1_win_pct} />
                    </td>
                    <td className="px-4 py-3">
                      <WinPctCell pct={m.style2_win_pct} />
                    </td>
                    <td className="px-4 py-3 text-white/50">{m.ko_pct}%</td>
                    <td className="px-4 py-3 text-white/50">{m.sub_pct}%</td>
                    <td className="px-4 py-3 text-white/50">{m.dec_pct}%</td>
                    <td className="px-4 py-3 text-white/50">{fmtTime(m.avg_fight_time)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function MatchupDetail({ matchup: m }) {
  const s1Wins = parseFloat(m.style1_win_pct);
  const s2Wins = parseFloat(m.style2_win_pct);
  const dominant = s1Wins > s2Wins ? m.style1 : m.style2;
  const domPct   = Math.max(s1Wins, s2Wins).toFixed(1);

  return (
    <div>
      <div className="flex items-center gap-4 mb-6 flex-wrap">
        <span className={`text-sm px-3 py-1.5 rounded-lg border ${styleColor(m.style1)}`}>{m.style1}</span>
        <span className="font-display text-xl text-loss">VS</span>
        <span className={`text-sm px-3 py-1.5 rounded-lg border ${styleColor(m.style2)}`}>{m.style2}</span>
        <div className="ml-auto text-xs text-white/30">{m.total_fights} fights in database</div>
      </div>

      <div className="text-sm text-gold mb-4 font-medium">
        {dominant} fighters win this matchup {domPct}% of the time historically.
      </div>

      {/* Win% bar */}
      <div className="mb-6">
        <div className="flex justify-between text-xs text-white/40 mb-1.5">
          <span>{m.style1} — {m.style1_win_pct}%</span>
          <span>{m.style2_win_pct}% — {m.style2}</span>
        </div>
        <div className="h-4 bg-dark-5 rounded-full overflow-hidden flex">
          <div className="bg-gold/70 h-full transition-all duration-700" style={{width:`${m.style1_win_pct}%`}} />
          <div className="bg-red-700/70 h-full transition-all duration-700" style={{width:`${m.style2_win_pct}%`}} />
        </div>
      </div>

      {/* Method breakdown */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatBox label="Finish by KO/TKO" value={`${m.ko_pct}%`} />
        <StatBox label="Finish by Sub" value={`${m.sub_pct}%`} />
        <StatBox label="Goes to Decision" value={`${m.dec_pct}%`} />
      </div>

      {/* Average fight time */}
      <div className="text-xs text-white/30">
        Average fight time: <span className="text-white/60">{fmtTime(m.avg_fight_time)}</span>
      </div>

      {/* Notable fights */}
      {m.notable_fights?.length > 0 && (
        <div className="mt-5 pt-5 border-t border-white/[0.06]">
          <div className="text-[10px] tracking-[0.15em] text-white/30 uppercase mb-3">Notable Fights</div>
          <div className="space-y-2">
            {m.notable_fights.map((f,i) => (
              <div key={i} className="flex items-center gap-2 text-xs text-white/60">
                <span className="text-white font-medium">{f.fighter1}</span>
                <span className="text-white/30">vs</span>
                <span className="text-white font-medium">{f.fighter2}</span>
                <span className="text-white/30">·</span>
                <span className="text-gold">{f.winner} won</span>
                <span className="text-white/20">· {f.method}</span>
                <span className="ml-auto text-white/20">{f.date?.slice(0,4)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function WinPctCell({ pct }) {
  const n = parseFloat(pct);
  const color = n > 55 ? 'text-win' : n < 45 ? 'text-loss' : 'text-white/60';
  return <span className={`font-medium ${color}`}>{n.toFixed(1)}%</span>;
}

function StatBox({ label, value }) {
  return (
    <div className="bg-dark-4 rounded-lg p-3 text-center">
      <div className="font-display text-xl tracking-wider text-gold">{value}</div>
      <div className="text-[10px] text-white/30 mt-0.5">{label}</div>
    </div>
  );
}

function fmtTime(seconds) {
  if (!seconds) return '--';
  const s = parseInt(seconds);
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${rem.toString().padStart(2,'0')}`;
}

import { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { search, fmtProRecord } from '../lib/api';

export default function Nav() {
  const location  = useLocation();
  const navigate  = useNavigate();
  const [q, setQ] = useState('');
  const [results, setResults] = useState(null);
  const [open, setOpen]       = useState(false);
  const ref = useRef(null);
  const timer = useRef(null);

  const links = [
    { to:'/',         label:'Home' },
    { to:'/fighters', label:'Fighters' },
    { to:'/events',   label:'Events' },
    { to:'/rankings', label:'Rankings' },
    { to:'/styles',   label:'Style Matchups' },
    { to:'/predict',  label:'Fight Predictor' },
    { to:'/compare',  label:'Compare' },
  ];

  const active = (to) => to==='/' ? location.pathname==='/' : location.pathname.startsWith(to);

  const onSearch = (val) => {
    setQ(val);
    clearTimeout(timer.current);
    if (val.length<2) { setResults(null); setOpen(false); return; }
    timer.current = setTimeout(async () => {
      const d = await search(val,6);
      setResults(d); setOpen(true);
    }, 250);
  };

  const select = (slug, type='fighter') => {
    setQ(''); setOpen(false); setResults(null);
    navigate(type==='fighter' ? `/fighters/${slug}` : `/events/${slug}`);
  };

  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);

  return (
    <nav className="bg-dark-DEFAULT/95 backdrop-blur border-b border-white/[0.06] sticky top-0 z-50">
      <div className="max-w-screen-2xl mx-auto px-4 h-14 flex items-center gap-4">
        <Link to="/" className="font-display text-xl tracking-[0.2em] text-gold shrink-0">
          UFC<span className="text-white">DB</span>
        </Link>

        <div className="hidden lg:flex items-center gap-1 flex-1">
          {links.map(l => (
            <Link key={l.to} to={l.to}
              className={`nav-link whitespace-nowrap text-xs ${active(l.to) ? 'nav-active' : ''}`}>
              {l.label}
            </Link>
          ))}
        </div>

        <div className="flex-1 lg:flex-none flex justify-end" ref={ref}>
          <div className="relative w-full max-w-xs">
            <input type="text" value={q} onChange={e=>onSearch(e.target.value)}
              placeholder="Search fighters..."
              className="input-dark pl-9 py-2 text-xs"
              onFocus={()=>results&&setOpen(true)} />
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-white/30"
              fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {open && results && (
              <div className="absolute top-full mt-1 w-full bg-dark-3 border border-white/10 rounded-xl overflow-hidden shadow-2xl z-50">
                {results.fighters?.map(f => (
                  <button key={f.id} onClick={()=>select(f.slug,'fighter')}
                    className="w-full flex items-center gap-3 px-4 py-2.5 hover:bg-dark-4 transition-colors text-left">
                    <div className="w-7 h-7 rounded-full bg-dark-5 border border-white/10 flex items-center justify-center text-xs font-display text-gold flex-shrink-0">
                      {f.first_name?.[0]}{f.last_name?.[0]}
                    </div>
                    <div className="min-w-0">
                      <div className="text-xs font-medium truncate">{f.first_name} {f.last_name}</div>
                      <div className="text-[10px] text-white/40">{f.weight_classes?.name} · {fmtProRecord(f)}</div>
                    </div>
                    <span className={`ml-auto text-[9px] px-1.5 py-0.5 rounded-full flex-shrink-0 ${f.status==='active'?'bg-win/10 text-win':'bg-white/5 text-white/30'}`}>
                      {f.status}
                    </span>
                  </button>
                ))}
                {!results.fighters?.length && (
                  <div className="px-4 py-3 text-xs text-white/30">No results for "{q}"</div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </nav>
  );
}

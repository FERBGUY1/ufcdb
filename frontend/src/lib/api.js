import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE || '/api',
  timeout: 30000,
});

// ── FIGHTERS ─────────────────────────────────────────────
export const getFighters    = (p={}) => api.get('/fighters', {params:p}).then(r=>r.data);
export const getFighter     = (slug) => api.get(`/fighters/${slug}`).then(r=>r.data);
export const getFighterOdds = (slug) => api.get(`/fighters/${slug}/odds-history`).then(r=>r.data);
export const updateFighter  = (slug,data) => api.patch(`/fighters/${slug}`,data).then(r=>r.data);

// ── EVENTS ───────────────────────────────────────────────
export const getEvents = (p={}) => api.get('/events',{params:p}).then(r=>r.data);
export const getEvent  = (slug) => api.get(`/events/${slug}`).then(r=>r.data);
export const getFight  = (id)   => api.get(`/fights/${id}`).then(r=>r.data);

// ── SEARCH ───────────────────────────────────────────────
export const search = (q,limit=8) => api.get('/search',{params:{q,limit}}).then(r=>r.data);

// ── ODDS ─────────────────────────────────────────────────
export const getUpcomingOdds  = ()       => api.get('/odds/upcoming').then(r=>r.data);
export const getConsensusOdds = (id)     => api.get(`/odds/${id}/consensus`).then(r=>r.data);

// ── STATS ────────────────────────────────────────────────
export const getSiteStats = () => api.get('/stats/overview').then(r=>r.data);

// ── PREDICTIONS ──────────────────────────────────────────
export const getPrediction = (slug1, slug2, wcSlug) =>
  api.post('/predict', { fighter1_slug: slug1, fighter2_slug: slug2, ...(wcSlug && { weight_class_slug: wcSlug }) }).then(r=>r.data);

// ── RANKINGS ─────────────────────────────────────────────
export const getAllRankings = ()       => api.get('/rankings/all').then(r=>r.data);
export const getRankings   = (wc)     => api.get('/rankings', {params:{weight_class:wc}}).then(r=>r.data);

// ── STYLES ───────────────────────────────────────────────
export const getStyleMatchups = (p={}) => api.get('/styles/matchups',{params:p}).then(r=>r.data);
export const getStyleList     = ()     => api.get('/styles/list').then(r=>r.data);
export const getStyleVsStyle  = (s1,s2) =>
  api.get(`/styles/matchups/${encodeURIComponent(s1)}/vs/${encodeURIComponent(s2)}`).then(r=>r.data);

// ── UTILITIES ─────────────────────────────────────────────
export const fmtRecord = (w,l,d,nc) => {
  let r = `${w??0}-${l??0}`;
  if (d>0) r+=`-${d}`;
  if (nc>0) r+=` (${nc} NC)`;
  return r;
};
// Full pro MMA record (from Sherdog) with UFC-record fallback for fighters
// not yet scraped. Returns the numbers plus which source they came from.
export const proRecord = (f) => {
  const hasPro = f?.pro_wins != null &&
    ((f.pro_wins ?? 0) + (f.pro_losses ?? 0) + (f.pro_draws ?? 0) + (f.pro_nc ?? 0)) > 0;
  return hasPro
    ? { wins: f.pro_wins ?? 0, losses: f.pro_losses ?? 0, draws: f.pro_draws ?? 0, nc: f.pro_nc ?? 0, isPro: true }
    : { wins: f?.wins ?? 0, losses: f?.losses ?? 0, draws: f?.draws ?? 0, nc: f?.no_contests ?? 0, isPro: false };
};
export const fmtProRecord = (f) => {
  const r = proRecord(f);
  return fmtRecord(r.wins, r.losses, r.draws, r.nc);
};
export const fmtOdds = (n) => {
  if (!n && n!==0) return '--';
  return n>0 ? `+${n}` : `${n}`;
};
export const impliedProb = (n) => {
  if (!n) return null;
  const p = n>0 ? 100/(n+100) : Math.abs(n)/(Math.abs(n)+100);
  return (p*100).toFixed(0)+'%';
};
export const fmtHeight = (inches) => {
  if (!inches) return '--';
  return `${Math.floor(inches/12)}'${Math.round(inches%12)}"`;
};
export const countryFlag = (nat) => ({
  'American':'🇺🇸','Brazilian':'🇧🇷','Russian':'🇷🇺','Irish':'🇮🇪',
  'British':'🇬🇧','Australian':'🇦🇺','Canadian':'🇨🇦','Nigerian':'🇳🇬',
  'Georgian':'🇬🇪','Mexican':'🇲🇽','Chinese':'🇨🇳','Polish':'🇵🇱',
  'Dutch':'🇳🇱','Cameroonian':'🇨🇲','New Zealander':'🇳🇿','Dagestani':'🇷🇺',
})[nat] || '🌍';

export const formatOdds       = fmtOdds;
export const formatRecord     = fmtRecord;
export const formatProRecord  = fmtProRecord;
export const heightFromInches = fmtHeight;
export const getCountryFlag   = countryFlag;
export const oddsToImplied    = impliedProb;

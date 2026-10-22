import { useEffect, useState } from 'react';
import { getStyleProfile } from '../lib/api';

// Point-in-time style label from the fighter's UFC fight stats (styleEngine via
// GET /api/styles/profile/:slug) — the same definition the predictor uses.
// Pass `profile` when the caller already has it (prediction payload) to skip the fetch.
// Pass `asOf` (YYYY-MM-DD) to label the fighter as they stood after that date (a
// snapshot pick on the Predict page), so the card agrees with the fantasy result.
export default function StyleLabel({ slug, profile, asOf, className = '' }) {
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (profile || !slug) return;
    let live = true;
    getStyleProfile(slug, asOf).then(d => { if (live) setFetched(d.profile); }).catch(() => {});
    return () => { live = false; };
  }, [slug, profile, asOf]);
  const p = profile || fetched;
  if (!p?.hasData || !p.label || p.label === 'Unknown') return null;
  const tip = asOf ? `Style from this fighter's UFC fight statistics through ${asOf}` : "Style from this fighter's UFC fight statistics";
  return <span className={className} title={tip}>{p.label}{asOf ? <span className="text-white/30"> · as of {asOf.slice(0, 4)}</span> : null}</span>;
}

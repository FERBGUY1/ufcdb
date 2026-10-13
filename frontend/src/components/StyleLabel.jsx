import { useEffect, useState } from 'react';
import { getStyleProfile } from '../lib/api';

// Point-in-time style label from the fighter's UFC fight stats (styleEngine via
// GET /api/styles/profile/:slug) — the same definition the predictor uses.
// Pass `profile` when the caller already has it (prediction payload) to skip the fetch.
export default function StyleLabel({ slug, profile, className = '' }) {
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (profile || !slug) return;
    let live = true;
    getStyleProfile(slug).then(d => { if (live) setFetched(d.profile); }).catch(() => {});
    return () => { live = false; };
  }, [slug, profile]);
  const p = profile || fetched;
  if (!p?.hasData || !p.label || p.label === 'Unknown') return null;
  return <span className={className} title="Style from this fighter's UFC fight statistics">{p.label}</span>;
}

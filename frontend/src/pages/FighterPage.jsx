import { useEffect, useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { getFighter, formatOdds, formatProRecord, heightFromInches, getCountryFlag, oddsToImplied } from '../lib/api';

export default function FighterPage() {
  const { slug } = useParams();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState('history');

  useEffect(() => {
    setLoading(true);
    setError(null);
    getFighter(slug)
      .then(setData)
      .catch(e => setError(e.message))
      .finally(() => setLoading(false));
  }, [slug]);

  if (loading) return <ProfileSkeleton />;
  if (error || !data) return (
    <div className="text-center py-24 text-white/30">
      <p className="text-xl mb-2">Fighter not found</p>
      <Link to="/fighters" className="btn-outline mt-4 inline-block">Back to Roster</Link>
    </div>
  );

  const { fighter: f, fights, rankings } = data;
  const upcomingFight = fights?.find(fight => fight.result === 'upcoming');
  const dbBoutCount = fights?.filter(fight => fight.result !== 'upcoming').length ?? 0;
  const recordTotal = (f.wins || 0) + (f.losses || 0) + (f.draws || 0) + (f.no_contests || 0);
  const hasProRecord = f.pro_wins != null &&
    ((f.pro_wins || 0) + (f.pro_losses || 0) + (f.pro_draws || 0) + (f.pro_nc || 0)) > 0;
  // Only inflate bout count from record total when we have at least some fights in DB
  const boutCount = dbBoutCount > 0 ? Math.max(dbBoutCount, recordTotal) : 0;
  const hasMissingHistory = dbBoutCount === 0 && recordTotal > 0;

  return (
    <main>
      {/* Back */}
      <div className="max-w-7xl mx-auto px-4 pt-4">
        <Link to="/fighters" className="text-white/30 text-sm hover:text-white transition-colors flex items-center gap-1.5">
          â† Back to Roster
        </Link>
      </div>

      {/* HERO */}
      <div className="bg-dark-2 border-b border-white/[0.06] mt-2">
        <div className="max-w-7xl mx-auto px-4 py-8 flex gap-6 items-start flex-wrap md:flex-nowrap">
          {/* Avatar */}
          <div className={`w-24 h-24 rounded-full flex-shrink-0 flex items-center justify-content border-2 ${
            f.is_champion ? 'border-gold' : 'border-white/10'
          } bg-dark-4 flex items-center justify-center font-display text-3xl tracking-wide text-white/60`}>
            {f.photo_url
              ? <img src={f.photo_url} alt={f.first_name} className="w-full h-full object-cover rounded-full" />
              : `${f.first_name?.[0]}${f.last_name?.[0]}`
            }
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="text-[10px] tracking-[0.3em] text-gold uppercase mb-2 flex items-center gap-3">
              {f.weight_classes?.name}
              {f.is_champion && <span className="bg-gold/20 text-gold border border-gold/30 px-2 py-0.5 rounded text-[9px]">CHAMPION</span>}
              {rankings?.[0] && !f.is_champion && (
                <span className="text-white/30">Ranked #{rankings[0].rank}</span>
              )}
            </div>
            <h1 className="font-display text-5xl md:text-6xl tracking-[0.08em] leading-none">
              {f.first_name.toUpperCase()} {f.last_name.toUpperCase()}
            </h1>
            {f.nickname && (
              <p className="text-gold italic font-light text-lg mt-1">"{f.nickname}"</p>
            )}

            {/* Record */}
            <div className="flex gap-5 mt-4 items-end flex-wrap">
              <div>
                <div className="flex gap-5 items-end">
                  <RecordStat num={hasProRecord ? f.pro_wins : f.wins}     label="Wins"   color="text-win" />
                  <RecordStat num={hasProRecord ? f.pro_losses : f.losses} label="Losses" color="text-loss" />
                  <RecordStat num={hasProRecord ? f.pro_draws : f.draws}   label="Draws"  color="text-white/30" />
                  {(hasProRecord ? f.pro_nc : f.no_contests) > 0 && (
                    <RecordStat num={hasProRecord ? f.pro_nc : f.no_contests} label="NC" color="text-white/30" />
                  )}
                </div>
                <div className="text-[9px] tracking-[0.2em] text-white/20 uppercase mt-1">
                  {hasProRecord ? 'Pro Record' : 'UFC Record'}
                </div>
              </div>
              {hasProRecord && (
                <div className="pl-4 border-l border-white/10">
                  <div className="font-display text-2xl tracking-wider text-white/40">
                    {f.wins}-{f.losses}{f.draws > 0 ? `-${f.draws}` : ''}{f.no_contests > 0 ? ` (${f.no_contests} NC)` : ''}
                  </div>
                  <div className="text-[10px] tracking-wider text-white/20 uppercase">UFC Record</div>
                </div>
              )}
              {!hasProRecord && (f.career_wins > 0 || f.career_losses > 0) &&
               (f.career_wins !== f.wins || f.career_losses !== f.losses) && (
                <div className="pl-4 border-l border-white/10">
                  <div className="font-display text-2xl tracking-wider text-white/40">
                    {f.career_wins}-{f.career_losses}{f.career_draws > 0 ? `-${f.career_draws}` : ''}
                  </div>
                  <div className="text-[10px] tracking-wider text-white/20 uppercase">Pro Career</div>
                </div>
              )}
              {(f.amateur_wins > 0 || f.amateur_losses > 0) && (
                <div className="pl-4 border-l border-white/10">
                  <div className="font-display text-2xl tracking-wider text-white/30">
                    {f.amateur_wins}-{f.amateur_losses}{f.amateur_draws > 0 ? `-${f.amateur_draws}` : ''}
                  </div>
                  <div className="text-[10px] tracking-wider text-white/20 uppercase">Amateur</div>
                </div>
              )}
            </div>

            {/* Tags */}
            <div className="flex flex-wrap gap-2 mt-4">
              {f.stance && <Link to={`/fighters?stance=${encodeURIComponent(f.stance)}`} className="tag hover:border-gold/40 hover:text-gold transition-colors">{f.stance}</Link>}
              {f.height_inches && <Link to={`/fighters?height_inches=${f.height_inches}`} className="tag hover:border-gold/40 hover:text-gold transition-colors">{heightFromInches(f.height_inches)}</Link>}
              {f.reach_inches && <Link to={`/fighters?reach_inches=${f.reach_inches}`} className="tag hover:border-gold/40 hover:text-gold transition-colors">Reach {f.reach_inches}"</Link>}
              {f.nationality && <Link to={`/fighters?nationality=${encodeURIComponent(f.nationality)}`} className="tag hover:border-gold/40 hover:text-gold transition-colors">{getCountryFlag(f.nationality)} {f.nationality}</Link>}
              {f.status && (
                <Link to={`/fighters?status=${encodeURIComponent(f.status)}`} className={`tag hover:border-gold/40 hover:text-gold transition-colors ${f.status === 'active' ? 'text-win border-win/20' : ''}`}>
                  {f.status}
                </Link>
              )}
            </div>

            {/* Social icons */}
            {(f.instagram || f.twitter || f.youtube || f.tiktok) && (
              <div className="flex gap-3 mt-4">
                {f.instagram && (
                  <a href={`https://instagram.com/${f.instagram.replace('@','')}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/80 transition-colors" title={f.instagram}>
                    <IconInstagram />
                    <span className="hidden sm:inline">{f.instagram}</span>
                  </a>
                )}
                {f.twitter && (
                  <a href={`https://x.com/${f.twitter.replace('@','')}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/80 transition-colors" title={f.twitter}>
                    <IconX />
                    <span className="hidden sm:inline">{f.twitter}</span>
                  </a>
                )}
                {f.youtube && (
                  <a href={`https://youtube.com/${f.youtube}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/80 transition-colors" title={f.youtube}>
                    <IconYouTube />
                    <span className="hidden sm:inline">{f.youtube}</span>
                  </a>
                )}
                {f.tiktok && (
                  <a href={`https://tiktok.com/${f.tiktok}`} target="_blank" rel="noopener noreferrer"
                    className="flex items-center gap-1.5 text-xs text-white/40 hover:text-white/80 transition-colors" title={f.tiktok}>
                    <IconTikTok />
                    <span className="hidden sm:inline">{f.tiktok}</span>
                  </a>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* BODY */}
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">

          {/* MAIN COLUMN */}
          <div className="space-y-6">
            {/* Upcoming Fight */}
            {upcomingFight && <UpcomingFightCard fight={upcomingFight} fighter={f} />}

            {/* Fight Stats */}
            <section className="card p-5">
              <h2 className="font-display text-base tracking-[0.2em] text-gold uppercase mb-4">Fight Stats</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <StatBar label="Strikes Landed / Min"  value={f.slpm}    max={10}  />
                <StatBar label="Strikes Absorbed / Min" value={f.sapm}   max={10}  colorClass="bg-loss" />
                <StatBar label="Striking Accuracy"      value={f.str_acc} max={100} suffix="%" colorClass="bg-win" />
                <StatBar label="Striking Defense"       value={f.str_def} max={100} suffix="%" colorClass="bg-win" />
                <StatBar label="Takedowns / 15 Min"     value={f.td_avg}  max={10}  />
                <StatBar label="Takedown Accuracy"      value={f.td_acc}  max={100} suffix="%" colorClass="bg-win" />
                <StatBar label="Takedown Defense"       value={f.td_def}  max={100} suffix="%" colorClass="bg-win" />
                <StatBar label="Submission Avg"         value={f.sub_avg} max={5}   />
              </div>
            </section>

            {/* Strengths & Weaknesses */}
            {(f.strengths?.length > 0 || f.weaknesses?.length > 0) && (
              <section className="card p-5">
                <h2 className="font-display text-base tracking-[0.2em] text-gold uppercase mb-4">Strengths & Weaknesses</h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {f.strengths?.length > 0 && (
                    <div>
                      <p className="text-[10px] tracking-[0.15em] text-white/30 uppercase mb-2">Strengths</p>
                      <div className="space-y-1.5">
                        {f.strengths.map(s => (
                          <div key={s} className="text-xs text-green-300 bg-win/5 border border-win/10 rounded-lg px-3 py-2">
                            âœ“ {s}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {f.weaknesses?.length > 0 && (
                    <div>
                      <p className="text-[10px] tracking-[0.15em] text-white/30 uppercase mb-2">Weaknesses</p>
                      <div className="space-y-1.5">
                        {f.weaknesses.map(w => (
                          <div key={w} className="text-xs text-red-300 bg-loss/5 border border-loss/10 rounded-lg px-3 py-2">
                            âœ— {w}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                {f.scout_notes && (
                  <div className="mt-4 pt-4 border-t border-white/5">
                    <p className="text-[10px] tracking-[0.15em] text-white/30 uppercase mb-2">Scouting Notes</p>
                    <p className="text-sm text-white/60 leading-relaxed">{f.scout_notes}</p>
                  </div>
                )}
              </section>
            )}

            {/* Fight History */}
            <section className="card overflow-hidden">
              <div className="p-5 border-b border-white/[0.06]">
                <h2 className="font-display text-base tracking-[0.2em] text-gold uppercase">Fight History</h2>
                <p className="text-xs text-white/30 mt-0.5">
                  {boutCount > 0 ? `${boutCount} professional UFC bout${boutCount !== 1 ? 's' : ''}` : 'No bouts recorded'}
                  {dbBoutCount < recordTotal && dbBoutCount > 0 && (
                    <span className="ml-2 text-white/20">({dbBoutCount} on record)</span>
                  )}
                </p>
              </div>
              {hasMissingHistory ? (
                <div className="px-5 py-8 text-center">
                  <p className="text-sm text-white/30">
                    Fight-by-fight history not yet imported for this fighter.
                  </p>
                  <p className="text-xs text-white/20 mt-1">
                    Known record: {recordTotal > 0 ? `${f.wins}W–${f.losses}L${f.draws > 0 ? `–${f.draws}D` : ''}${f.no_contests > 0 ? ` (${f.no_contests} NC)` : ''}` : '–'}
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b border-white/[0.06]">
                        {['Opponent', 'Event', 'Date', 'Class', 'Result', 'Method', 'Rnd', 'Odds'].map(h => (
                          <th key={h} className="text-left px-4 py-2.5 text-[10px] tracking-[0.15em] text-white/30 uppercase font-medium">
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {fights?.filter(fight => fight.result !== 'upcoming').map(fight => (
                        <FightRow key={fight.id} fight={fight} fighterId={f.id} />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          {/* SIDEBAR */}
          <aside className="space-y-4">
            {/* Training */}
            <InfoCard title="Training">
              <InfoRow label="Gym"        value={f.gym_name || f.gyms?.name} />
              <InfoRow label="Head Coach" value={f.head_coach} />
              {f.notable_coaches?.length > 0 && (
                <InfoRow label="Coaches" value={f.notable_coaches.join(', ')} />
              )}
              {f.training_partners?.length > 0 && (
                <InfoRow label="Training Partners" value={f.training_partners.slice(0, 3).join(', ')} />
              )}
            </InfoCard>

            {/* Personal */}
            <InfoCard title="Personal">
              {f.date_of_birth && (
                <InfoRow label="Born" value={new Date(f.date_of_birth).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })} />
              )}
              {f.hometown && <InfoRow label="Hometown" value={f.hometown} />}
              {f.nationality && <InfoRow label="Nationality" value={`${getCountryFlag(f.nationality)} ${f.nationality}`} to={`/fighters?nationality=${encodeURIComponent(f.nationality)}`} />}
              {f.relationship_status && <InfoRow label="Relationship" value={f.relationship_status} />}
              {f.partner_name && <InfoRow label="Partner" value={f.partner_name} />}
              {f.children_count != null && (
                <InfoRow label="Children" value={f.children_notes || f.children_count} />
              )}
              {f.military_service && f.military_service !== 'None' && (
                <InfoRow label="Military" value={f.military_service} />
              )}
              {f.education && <InfoRow label="Education" value={f.education} />}
              {f.religion && <InfoRow label="Religion" value={f.religion} />}
            </InfoCard>

            {/* Physical */}
            <InfoCard title="Physical">
              {f.height_inches && <InfoRow label="Height" value={heightFromInches(f.height_inches)} to={`/fighters?height_inches=${f.height_inches}`} />}
              {f.reach_inches && <InfoRow label="Reach" value={`${f.reach_inches}"`} to={`/fighters?reach_inches=${f.reach_inches}`} />}
              {f.leg_reach_inches && <InfoRow label="Leg Reach" value={`${f.leg_reach_inches}"`} />}
              {f.stance && <InfoRow label="Stance" value={f.stance} to={`/fighters?stance=${encodeURIComponent(f.stance)}`} />}
              {f.weight_lbs && <InfoRow label="Weight" value={`${f.weight_lbs} lbs`} />}
            </InfoCard>

            {/* Career */}
            <InfoCard title="Career">
              {f.pro_debut_date && <InfoRow label="Pro Debut" value={f.pro_debut_date} />}
              {f.ufc_debut_date && <InfoRow label="UFC Debut" value={`${f.ufc_debut_date}${f.ufc_debut_event ? ` (${f.ufc_debut_event})` : ''}`} />}
              {f.management && <InfoRow label="Management" value={f.management} />}
              {(f.primary_style || f.fighting_style) && (
                <InfoRow
                  label="Style"
                  value={[f.primary_style || f.fighting_style, f.secondary_style].filter(Boolean).join(' / ')}
                />
              )}
            </InfoCard>

            {/* Social */}
            {(f.instagram || f.twitter || f.youtube || f.tiktok) && (
              <SocialLinks fighter={f} />
            )}

            {/* Compare button */}
            <Link
              to={`/compare?fighter1=${slug}`}
              className="btn-outline w-full text-center block py-2.5 text-sm"
            >
              Compare with Another Fighter
            </Link>
          </aside>
        </div>
      </div>
    </main>
  );
}

// â”€â”€ SUB-COMPONENTS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function RecordStat({ num, label, color }) {
  return (
    <div>
      <div className={`font-display text-4xl tracking-wider ${color}`}>{num}</div>
      <div className="text-[10px] tracking-[0.15em] text-white/30 uppercase">{label}</div>
    </div>
  );
}

function StatBar({ label, value, max, suffix = '', colorClass = 'bg-gold' }) {
  const pct = value != null ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div>
      <div className="flex justify-between mb-1.5">
        <span className="text-xs text-white/40">{label}</span>
        <span className="text-xs font-medium">{value != null ? `${value}${suffix}` : '--'}</span>
      </div>
      <div className="stat-bar-track">
        <div className={`stat-bar-fill ${colorClass}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function InfoCard({ title, children }) {
  return (
    <div className="card p-4">
      <h3 className="text-[10px] tracking-[0.2em] text-white/30 uppercase font-medium mb-3">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function InfoRow({ label, value, link, to }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-2 py-1.5 border-b border-white/[0.04] last:border-0">
      <span className="text-xs text-white/40 flex-shrink-0">{label}</span>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-gold hover:underline truncate">
          {value}
        </a>
      ) : to ? (
        <Link to={to} className="text-xs font-medium text-gold/80 hover:text-gold hover:underline truncate transition-colors">
          {value}
        </Link>
      ) : (
        <span className="text-xs font-medium text-right truncate">{String(value)}</span>
      )}
    </div>
  );
}

function BeltIcon({ variant }) {
  const [main, detail] = variant === 'gold'
    ? ['#C8A84B', '#8a7133']
    : ['#94A3B8', '#64748B'];
  return (
    <svg viewBox="0 0 26 11" width="18" height="8" style={{ display: 'inline', verticalAlign: 'middle' }}
      aria-label={variant === 'gold' ? 'Title fight' : 'Interim title fight'}>
      <title>{variant === 'gold' ? 'Title Fight' : 'Interim Title Fight'}</title>
      <rect x="0"  y="2" width="7"  height="7" rx="1.5" fill={main} />
      <rect x="19" y="2" width="7"  height="7" rx="1.5" fill={main} />
      <rect x="6"  y="0" width="14" height="11" rx="2"  fill={main} />
      <rect x="9"  y="3" width="8"  height="5"  rx="1"  fill={detail} opacity="0.8" />
      <circle cx="13" cy="5.5" r="2" fill={main} />
    </svg>
  );
}

function FightRow({ fight, fighterId }) {
  const navigate = useNavigate();
  const isF1 = fight.fighter1?.id === fighterId;
  const opponent = isF1 ? fight.fighter2 : fight.fighter1;
  const myOdds = fight.odds?.find(o => o.line_type === 'current') || fight.odds?.[0];
  const myOddsVal = myOdds ? (isF1 ? myOdds.fighter1_odds : myOdds.fighter2_odds) : null;

  // winner_id is not populated â€” derive win/loss from fighter position + result
  // 'win' means fighter1 won; so if this fighter is fighter1 and result='win' â†’ WIN
  const isWin = fight.result === 'win' && isF1;
  const resultLabel = fight.result === 'win'
    ? (isF1 ? 'WIN' : 'LOSS')
    : fight.result === 'no_contest' ? 'NC'
    : fight.result?.toUpperCase() || '--';

  return (
    <tr className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors cursor-pointer" onClick={()=>navigate(`/fights/${fight.id}`)} title="View fight details">
      <td className="px-4 py-3">
        {opponent ? (
          <Link to={`/fighters/${opponent.slug}`} className="font-medium hover:text-gold transition-colors" onClick={e => e.stopPropagation()}>
            {opponent.first_name} {opponent.last_name}
          </Link>
        ) : <span className="text-white/30">Unknown</span>}
        {(fight.is_title_fight || fight.is_interim_title) && (
          <span className="ml-1.5 inline-flex items-center">
            <BeltIcon variant={fight.is_interim_title ? 'silver' : 'gold'} />
          </span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-white/40 max-w-[140px] truncate">
        {fight.events ? (
          <Link to={`/events/${fight.events.slug}`} className="hover:text-white/70 transition-colors" onClick={e => e.stopPropagation()}>
            {fight.events.name}
          </Link>
        ) : '--'}
      </td>
      <td className="px-4 py-3 text-xs text-white/30 whitespace-nowrap">
        {fight.events?.date || '--'}
      </td>
      <td className="px-4 py-3 text-xs text-white/30 whitespace-nowrap">
        {fight.weight_classes?.name || '--'}
      </td>
      <td className="px-4 py-3">
        <span className={isWin ? 'result-win' : 'result-loss'}>{resultLabel}</span>
      </td>
      <td className="px-4 py-3">
        <span className="text-[10px] bg-dark-5 text-white/50 px-2 py-0.5 rounded">
          {fight.method || '--'}
        </span>
        {fight.round && (
          <span className="text-[10px] text-white/30 ml-1.5">R{fight.round} {fight.time}</span>
        )}
      </td>
      <td className="px-4 py-3 text-xs text-white/30">{fight.round || '--'}</td>
      <td className="px-4 py-3">
        {myOddsVal ? (
          <span className={myOddsVal < 0 ? 'odds-fav' : 'odds-dog'}>
            {formatOdds(myOddsVal)}
          </span>
        ) : <span className="text-white/20">--</span>}
      </td>
    </tr>
  );
}

function UpcomingFightCard({ fight, fighter }) {
  const isF1 = fight.fighter1?.id === fighter.id;
  const opponent = isF1 ? fight.fighter2 : fight.fighter1;
  const myOdds = fight.odds?.find(o => o.line_type === 'current') || fight.odds?.[0];
  const myOddsVal = myOdds ? (isF1 ? myOdds.fighter1_odds : myOdds.fighter2_odds) : null;
  const oppOddsVal = myOdds ? (isF1 ? myOdds.fighter2_odds : myOdds.fighter1_odds) : null;

  return (
    <div className="border border-gold/20 bg-gold/[0.04] rounded-xl p-5">
      <div className="text-[10px] tracking-[0.3em] text-gold uppercase mb-3">
        Next Fight â€” {fight.events?.name} Â· {fight.events?.date}
        {(fight.is_title_fight || fight.is_interim_title) && (
          <> · <BeltIcon variant={fight.is_interim_title ? 'silver' : 'gold'} /> {fight.is_interim_title ? 'Interim Title' : 'Title Fight'}</>
        )}
      </div>
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1">
          <div className="font-medium">{fighter.first_name} {fighter.last_name}</div>
          <div className="text-xs text-white/40">{formatProRecord(fighter)}</div>
        </div>
        <span className="font-display text-loss text-sm">VS</span>
        <div className="flex-1 text-right">
          {opponent ? (
            <Link to={`/fighters/${opponent.slug}`} className="font-medium hover:text-gold transition-colors" onClick={e => e.stopPropagation()}>
              {opponent.first_name} {opponent.last_name}
            </Link>
          ) : <span className="font-medium">TBD</span>}
        </div>
      </div>
      {myOddsVal && (
        <div className="flex gap-2">
          <div className={`flex-1 text-center py-2 rounded-lg text-sm font-semibold border ${
            myOddsVal < 0 ? 'bg-gold/10 text-gold border-gold/20' : 'bg-red-900/20 text-red-400 border-red-900/30'
          }`}>
            {formatOdds(myOddsVal)} <span className="text-xs opacity-60">({oddsToImplied(myOddsVal)})</span>
          </div>
          {oppOddsVal && (
            <div className={`flex-1 text-center py-2 rounded-lg text-sm font-semibold border ${
              oppOddsVal < 0 ? 'bg-gold/10 text-gold border-gold/20' : 'bg-red-900/20 text-red-400 border-red-900/30'
            }`}>
              {formatOdds(oppOddsVal)} <span className="text-xs opacity-60">({oddsToImplied(oppOddsVal)})</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function IconInstagram() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/>
    </svg>
  );
}

function IconX() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.741l7.73-8.835L1.254 2.25H8.08l4.253 5.622 5.91-5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/>
    </svg>
  );
}

function IconYouTube() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M23.498 6.186a3.016 3.016 0 00-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 00.502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 002.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 002.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z"/>
    </svg>
  );
}

function IconTikTok() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.89-2.89 2.89 2.89 0 012.89-2.89c.28 0 .54.04.79.1V9.01a6.32 6.32 0 00-.79-.05 6.34 6.34 0 00-6.34 6.34 6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.33-6.34V8.69a8.18 8.18 0 004.79 1.54V6.78a4.85 4.85 0 01-1.02-.09z"/>
    </svg>
  );
}

function SocialLinks({ fighter: f }) {
  const links = [
    f.instagram && {
      label: 'Instagram',
      handle: f.instagram,
      url: `https://instagram.com/${f.instagram.replace('@', '')}`,
      Icon: IconInstagram,
      color: 'hover:text-pink-400',
    },
    f.twitter && {
      label: 'Twitter / X',
      handle: f.twitter,
      url: `https://x.com/${f.twitter.replace('@', '')}`,
      Icon: IconX,
      color: 'hover:text-white',
    },
    f.youtube && {
      label: 'YouTube',
      handle: f.youtube,
      url: `https://youtube.com/${f.youtube}`,
      Icon: IconYouTube,
      color: 'hover:text-red-400',
    },
    f.tiktok && {
      label: 'TikTok',
      handle: f.tiktok,
      url: `https://tiktok.com/${f.tiktok}`,
      Icon: IconTikTok,
      color: 'hover:text-white',
    },
  ].filter(Boolean);

  return (
    <div className="card p-4">
      <h3 className="text-[10px] tracking-[0.2em] text-white/30 uppercase font-medium mb-3">Social Media</h3>
      <div className="space-y-2">
        {links.map(({ label, handle, url, Icon, color }) => (
          <a key={label} href={url} target="_blank" rel="noopener noreferrer"
            className={`flex items-center gap-3 py-2 px-3 rounded-lg bg-white/[0.03] border border-white/[0.06] text-white/50 ${color} transition-colors group`}>
            <span className="flex-shrink-0"><Icon /></span>
            <span className="text-xs font-medium flex-1 truncate">{handle}</span>
            <svg className="w-3 h-3 opacity-0 group-hover:opacity-50 transition-opacity flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        ))}
      </div>
    </div>
  );
}

function ProfileSkeleton() {
  return (
    <main>
      <div className="bg-dark-2 border-b border-white/[0.06] py-8 px-4">
        <div className="max-w-7xl mx-auto flex gap-6">
          <div className="w-24 h-24 rounded-full bg-dark-4 animate-pulse flex-shrink-0" />
          <div className="flex-1 space-y-3">
            <div className="h-3 bg-dark-4 rounded w-32 animate-pulse" />
            <div className="h-10 bg-dark-4 rounded w-64 animate-pulse" />
            <div className="h-4 bg-dark-4 rounded w-48 animate-pulse" />
          </div>
        </div>
      </div>
    </main>
  );
}
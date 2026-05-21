import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getFighter, formatOdds, formatRecord, heightFromInches, getCountryFlag, oddsToImplied } from '../lib/api';

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
  const record = formatRecord(f.wins, f.losses, f.draws, f.no_contests);
  const upcomingFight = fights?.find(fight => fight.result === 'upcoming');

  return (
    <main>
      {/* Back */}
      <div className="max-w-7xl mx-auto px-4 pt-4">
        <Link to="/fighters" className="text-white/30 text-sm hover:text-white transition-colors flex items-center gap-1.5">
          ← Back to Roster
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
              {f.is_champion && <span className="bg-gold/20 text-gold border border-gold/30 px-2 py-0.5 rounded text-[9px]">⟡ CHAMPION</span>}
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
            <div className="flex gap-5 mt-4 items-end">
              <RecordStat num={f.wins}   label="Wins"   color="text-win" />
              <RecordStat num={f.losses} label="Losses" color="text-loss" />
              <RecordStat num={f.draws}  label="Draws"  color="text-white/30" />
              {f.no_contests > 0 && <RecordStat num={f.no_contests} label="NC" color="text-white/30" />}
              {(f.amateur_wins > 0 || f.amateur_losses > 0) && (
                <div className="pl-4 border-l border-white/10">
                  <div className="font-display text-2xl tracking-wider text-white/30">
                    {f.amateur_wins}-{f.amateur_losses}
                  </div>
                  <div className="text-[10px] tracking-wider text-white/20 uppercase">Amateur</div>
                </div>
              )}
            </div>

            {/* Tags */}
            <div className="flex flex-wrap gap-2 mt-4">
              {f.stance && <span className="tag">{f.stance}</span>}
              {f.height_inches && <span className="tag">{heightFromInches(f.height_inches)}</span>}
              {f.reach_inches && <span className="tag">Reach {f.reach_inches}"</span>}
              {f.nationality && <span className="tag">{getCountryFlag(f.nationality)} {f.nationality}</span>}
              <span className={`tag ${f.status === 'active' ? 'text-win border-win/20' : ''}`}>
                {f.status}
              </span>
            </div>
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
                            ✓ {s}
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
                            ✗ {w}
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
                <p className="text-xs text-white/30 mt-0.5">{fights?.filter(f => f.result !== 'upcoming').length} professional bouts</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-white/[0.06]">
                      {['Opponent', 'Event', 'Date', 'Result', 'Method', 'Rnd', 'Odds'].map(h => (
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
              {f.nationality && <InfoRow label="Nationality" value={`${getCountryFlag(f.nationality)} ${f.nationality}`} />}
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
              {f.height_inches && <InfoRow label="Height" value={heightFromInches(f.height_inches)} />}
              {f.reach_inches && <InfoRow label="Reach" value={`${f.reach_inches}"`} />}
              {f.leg_reach_inches && <InfoRow label="Leg Reach" value={`${f.leg_reach_inches}"`} />}
              {f.stance && <InfoRow label="Stance" value={f.stance} />}
              {f.weight_lbs && <InfoRow label="Weight" value={`${f.weight_lbs} lbs`} />}
            </InfoCard>

            {/* Career */}
            <InfoCard title="Career">
              {f.pro_debut_date && <InfoRow label="Pro Debut" value={f.pro_debut_date} />}
              {f.ufc_debut_date && <InfoRow label="UFC Debut" value={`${f.ufc_debut_date}${f.ufc_debut_event ? ` (${f.ufc_debut_event})` : ''}`} />}
              {f.management && <InfoRow label="Management" value={f.management} />}
              {f.fighting_style && <InfoRow label="Style" value={f.fighting_style} />}
            </InfoCard>

            {/* Social */}
            {(f.instagram || f.twitter || f.youtube) && (
              <InfoCard title="Social Media">
                {f.instagram && <InfoRow label="Instagram" value={f.instagram} link={`https://instagram.com/${f.instagram.replace('@','')}`} />}
                {f.twitter && <InfoRow label="Twitter/X" value={f.twitter} link={`https://x.com/${f.twitter.replace('@','')}`} />}
                {f.youtube && <InfoRow label="YouTube" value={f.youtube} link={f.youtube} />}
              </InfoCard>
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

// ── SUB-COMPONENTS ────────────────────────────────────────

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

function InfoRow({ label, value, link }) {
  if (!value) return null;
  return (
    <div className="flex justify-between gap-2 py-1.5 border-b border-white/[0.04] last:border-0">
      <span className="text-xs text-white/40 flex-shrink-0">{label}</span>
      {link ? (
        <a href={link} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-gold hover:underline truncate">
          {value}
        </a>
      ) : (
        <span className="text-xs font-medium text-right truncate">{String(value)}</span>
      )}
    </div>
  );
}

function FightRow({ fight, fighterId }) {
  const isF1 = fight.fighter1?.id === fighterId;
  const opponent = isF1 ? fight.fighter2 : fight.fighter1;
  const myOdds = fight.odds?.find(o => o.line_type === 'current') || fight.odds?.[0];
  const myOddsVal = myOdds ? (isF1 ? myOdds.fighter1_odds : myOdds.fighter2_odds) : null;

  const resultLabel = fight.result === 'win'
    ? (fight.winner?.id === fighterId ? 'WIN' : 'LOSS')
    : fight.result?.toUpperCase() || '--';

  const isWin = fight.winner?.id === fighterId;

  return (
    <tr className="border-b border-white/[0.03] hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-3">
        {opponent ? (
          <Link to={`/fighters/${opponent.slug}`} className="font-medium hover:text-gold transition-colors">
            {opponent.first_name} {opponent.last_name}
          </Link>
        ) : <span className="text-white/30">Unknown</span>}
      </td>
      <td className="px-4 py-3 text-xs text-white/40 max-w-[140px] truncate">
        {fight.events ? (
          <Link to={`/events/${fight.events.slug}`} className="hover:text-white/70 transition-colors">
            {fight.events.name}
          </Link>
        ) : '--'}
      </td>
      <td className="px-4 py-3 text-xs text-white/30 whitespace-nowrap">
        {fight.events?.date || '--'}
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
        Next Fight — {fight.events?.name} · {fight.events?.date}
        {fight.is_title_fight && ' · Title Fight'}
      </div>
      <div className="flex items-center gap-4 mb-4">
        <div className="flex-1">
          <div className="font-medium">{fighter.first_name} {fighter.last_name}</div>
          <div className="text-xs text-white/40">{formatRecord(fighter.wins, fighter.losses, fighter.draws, fighter.no_contests)}</div>
        </div>
        <span className="font-display text-loss text-sm">VS</span>
        <div className="flex-1 text-right">
          {opponent ? (
            <Link to={`/fighters/${opponent.slug}`} className="font-medium hover:text-gold transition-colors">
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

/**
 * Opponent Quality & Career Arc Engine
 * Computes dynamic quality scores for every fighter at every point
 * in their career, and detects career arc phases.
 */

require('dotenv').config();
const supabase = require('../db/client');

// Career arc thresholds
const ARC_THRESHOLDS = {
  WIN_STREAK_RISING:    3,
  LOSS_STREAK_DECLINING: 2,
  MIN_FIGHTS_PRIME:     5,
  QUALITY_GATEKEEPER:   4.0,
  QUALITY_CONTENDER:    6.0,
  QUALITY_ELITE:        8.0,
};

/**
 * Compute a fighter's quality score at a specific date.
 * Score is 1-10 based on ranking, record, recent form, and opponent quality.
 */
function computeQualityScore(fighter, fightsUpToDate, rankAtTime) {
  let score = 5.0; // baseline

  const record = fightsUpToDate.length;
  const wins   = fightsUpToDate.filter(f => f.winner_id === fighter.id).length;
  const losses = record - wins;
  const winRate = record > 0 ? wins / record : 0;

  // Win rate adjustment (±2 points)
  score += (winRate - 0.5) * 4;

  // Ranking bonus
  if (rankAtTime !== null && rankAtTime !== undefined) {
    if (rankAtTime === 0) score += 3.0;       // champion
    else if (rankAtTime <= 3) score += 2.5;   // top 3
    else if (rankAtTime <= 5) score += 2.0;   // top 5
    else if (rankAtTime <= 10) score += 1.5;  // top 10
    else if (rankAtTime <= 15) score += 1.0;  // top 15
    else score += 0.3;                         // ranked but low
  }

  // Recent form (last 3 fights weighted more)
  const recent3 = fightsUpToDate.slice(-3);
  const recentWins = recent3.filter(f => f.winner_id === fighter.id).length;
  score += (recentWins / Math.max(recent3.length, 1) - 0.5) * 1.5;

  // Win/loss streak
  let streak = 0;
  for (let i = fightsUpToDate.length - 1; i >= 0; i--) {
    const isWin = fightsUpToDate[i].winner_id === fighter.id;
    if (i === fightsUpToDate.length - 1) {
      streak = isWin ? 1 : -1;
    } else {
      const prevWin = streakIsWin(streak);
      if (isWin === prevWin) streak += isWin ? 1 : -1;
      else break;
    }
  }
  score += streak * 0.2;

  // Clamp
  return Math.max(1, Math.min(10, score));
}

function streakIsWin(streak) { return streak > 0; }

/**
 * Detect career arc phase for a fighter at a given point in time.
 */
function detectCareerArc(fighter, qualityScore, fights, rankAtTime) {
  const winRate = fights.length > 0
    ? fights.filter(f => f.winner_id === fighter.id).length / fights.length
    : 0;

  // Recent trend
  const recent5 = fights.slice(-5);
  const recentWins = recent5.filter(f => f.winner_id === fighter.id).length;
  const recentLosses = recent5.length - recentWins;

  if (fights.length < 3) return 'rising';
  if (recentLosses >= 3) return 'declining';
  if (rankAtTime === 0) return 'prime';
  if (rankAtTime !== null && rankAtTime <= 5 && winRate > 0.75) return 'prime';
  if (recentWins >= 3 && fights.length < 15) return 'rising';
  if (recentWins >= 4 && qualityScore > 6) return 'contender';
  if (recentLosses >= 2 && qualityScore < 5) return 'declining';
  if (fights.length > 20 && qualityScore < 5 && winRate > 0.5) return 'gatekeeper';
  if (winRate < 0.4) return 'journeyman';
  if (qualityScore >= 6) return 'contender';
  return 'rising';
}

/**
 * Compute resume strength score for a fighter.
 * Weighted average of opponent quality scores at time of each fight,
 * with wins counting more than losses.
 */
async function computeResumeStrength(fighterId) {
  const { data: fights } = await supabase
    .from('fights')
    .select('id, winner_id, fighter1_id, fighter2_id, fighter1_quality_score, fighter2_quality_score')
    .or(`fighter1_id.eq.${fighterId},fighter2_id.eq.${fighterId}`)
    .not('result', 'eq', 'upcoming');

  if (!fights || fights.length === 0) return 5.0;

  let totalWeightedScore = 0;
  let totalWeight = 0;

  for (const fight of fights) {
    const isF1 = fight.fighter1_id === fighterId;
    const opponentScore = isF1 ? fight.fighter2_quality_score : fight.fighter1_quality_score;
    const won = fight.winner_id === fighterId;

    if (!opponentScore) continue;

    // Wins over high quality opponents count most
    // Losses to high quality opponents hurt less
    // Wins over low quality opponents barely matter
    const weight = won ? opponentScore / 10 * 1.5 : opponentScore / 10 * 0.8;

    totalWeightedScore += opponentScore * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return 5.0;
  return Math.max(1, Math.min(10, totalWeightedScore / totalWeight));
}

/**
 * Compute and store style matchup statistics across all fights.
 */
async function computeStyleMatchups() {
  console.log('Computing style matchup statistics...');

  const { data: fights } = await supabase
    .from('fights')
    .select(`
      id, result, method, winner_id, time, round, time_format,
      fighter1_style_at_fight, fighter2_style_at_fight,
      fighter1:fighters!fighter1_id (id, first_name, last_name),
      fighter2:fighters!fighter2_id (id, first_name, last_name),
      events (name, date)
    `)
    .not('fighter1_style_at_fight', 'is', null)
    .not('fighter2_style_at_fight', 'is', null)
    .not('result', 'eq', 'upcoming');

  if (!fights) return;

  // Aggregate by style pair
  const matchupMap = {};

  for (const fight of fights) {
    const s1 = fight.fighter1_style_at_fight;
    const s2 = fight.fighter2_style_at_fight;
    if (!s1 || !s2 || s1 === s2) continue;

    // Normalize key (alphabetical order for consistency)
    const key = [s1, s2].sort().join('|||');
    const f1IsFirst = [s1, s2].sort()[0] === s1;

    if (!matchupMap[key]) {
      matchupMap[key] = {
        style1: [s1, s2].sort()[0],
        style2: [s1, s2].sort()[1],
        total: 0, s1_wins: 0, s2_wins: 0, draws: 0,
        ko_wins: 0, sub_wins: 0, dec_wins: 0,
        total_time: 0, notable: [],
      };
    }

    const m = matchupMap[key];
    m.total++;

    const f1Won = fight.winner_id === fight.fighter1?.id;
    const f2Won = fight.winner_id === fight.fighter2?.id;

    if (f1Won) { f1IsFirst ? m.s1_wins++ : m.s2_wins++; }
    else if (f2Won) { f1IsFirst ? m.s2_wins++ : m.s1_wins++; }
    else m.draws++;

    if (fight.method === 'KO' || fight.method === 'TKO') m.ko_wins++;
    else if (fight.method === 'SUB') m.sub_wins++;
    else m.dec_wins++;

    // Fight time in seconds
    if (fight.round && fight.time) {
      const [mins, secs] = fight.time.split(':').map(Number);
      m.total_time += (fight.round - 1) * 300 + mins * 60 + (secs || 0);
    }

    // Track notable fights (top quality)
    if (m.notable.length < 5) {
      m.notable.push({
        fighter1: `${fight.fighter1?.first_name} ${fight.fighter1?.last_name}`,
        fighter2: `${fight.fighter2?.first_name} ${fight.fighter2?.last_name}`,
        winner: fight.winner_id === fight.fighter1?.id
          ? `${fight.fighter1?.first_name} ${fight.fighter1?.last_name}`
          : `${fight.fighter2?.first_name} ${fight.fighter2?.last_name}`,
        method: fight.method,
        event: fight.events?.name,
        date: fight.events?.date,
      });
    }
  }

  // Upsert into style_matchups table
  let computed = 0;
  for (const [, m] of Object.entries(matchupMap)) {
    const avgTime = m.total > 0 ? m.total_time / m.total : 0;
    const { error } = await supabase.from('style_matchups').upsert({
      style1: m.style1,
      style2: m.style2,
      weight_class_id: null,
      total_fights:  m.total,
      style1_wins:   m.s1_wins,
      style2_wins:   m.s2_wins,
      draws:         m.draws,
      style1_win_pct: m.total > 0 ? (m.s1_wins / m.total * 100).toFixed(1) : 50,
      style2_win_pct: m.total > 0 ? (m.s2_wins / m.total * 100).toFixed(1) : 50,
      ko_pct:  m.total > 0 ? (m.ko_wins  / m.total * 100).toFixed(1) : 0,
      sub_pct: m.total > 0 ? (m.sub_wins / m.total * 100).toFixed(1) : 0,
      dec_pct: m.total > 0 ? (m.dec_wins / m.total * 100).toFixed(1) : 0,
      avg_fight_time: avgTime.toFixed(0),
      notable_fights: m.notable,
      last_computed: new Date().toISOString(),
    }, { onConflict: 'style1,style2,weight_class_id' });

    if (!error) computed++;
  }

  console.log(`✓ Computed ${computed} style matchup combinations`);
}

module.exports = {
  computeQualityScore,
  detectCareerArc,
  computeResumeStrength,
  computeStyleMatchups,
};

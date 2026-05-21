/**
 * Compute contextual performance ratings for all fighters.
 * Run after importing fight data: node src/ml/computeRatings.js
 */
require('dotenv').config();
const supabase = require('../db/client');
const { computeResumeStrength, detectCareerArc } = require('./qualityEngine');

async function main() {
  console.log('Computing fighter ratings...');
  const { data: fighters } = await supabase.from('fighters').select('id, wins, losses, slpm, sapm, td_avg, td_def, wins_ko, wins_sub').limit(2000);
  if (!fighters) return;
  let updated = 0;
  for (const f of fighters) {
    const resumeScore = await computeResumeStrength(f.id);
    const ratingStriking   = Math.min(10, Math.max(1, (f.slpm||0) * 0.8 + (f.str_acc||50)/100*3));
    const ratingWrestling  = Math.min(10, Math.max(1, (f.td_avg||0) * 1.5 + (f.td_acc||50)/100*2));
    const ratingGrappling  = Math.min(10, Math.max(1, ((f.wins_sub||0)/Math.max(f.wins,1))*10));
    const ratingCardio     = Math.min(10, Math.max(1, 5 + (f.wins - f.losses > 0 ? 1 : -1)));
    const ratingOverall    = (ratingStriking + ratingWrestling + ratingGrappling + ratingCardio) / 4;
    const { error } = await supabase.from('fighters').update({
      rating_striking: ratingStriking.toFixed(2),
      rating_wrestling: ratingWrestling.toFixed(2),
      rating_grappling: ratingGrappling.toFixed(2),
      rating_cardio: ratingCardio.toFixed(2),
      rating_overall: ratingOverall.toFixed(2),
      resume_strength_score: resumeScore.toFixed(2),
    }).eq('id', f.id);
    if (!error) updated++;
  }
  console.log(`✓ Updated ratings for ${updated} fighters`);
}
main().catch(console.error);

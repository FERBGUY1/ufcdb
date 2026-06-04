/**
 * AI Fight Prediction Engine
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../db/client');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── WEIGHT CLASS CONTEXT ──────────────────────────────────
async function deriveNaturalWeightClassId(fighterId, fallbackId) {
  const { data: fights } = await supabase
    .from('fights')
    .select('weight_class_id')
    .or(`fighter1_id.eq.${fighterId},fighter2_id.eq.${fighterId}`)
    .not('weight_class_id', 'is', null);

  if (!fights || fights.length === 0) return fallbackId;

  const counts = {};
  for (const f of fights) {
    counts[f.weight_class_id] = (counts[f.weight_class_id] || 0) + 1;
  }
  return parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

async function computeWeightClassContext(f1, f2, weightClassId) {
  if (!weightClassId) return null;

  const { data: allWCs } = await supabase.from('weight_classes').select('id, name, slug, sort_order');
  if (!allWCs) return null;

  const wcById = Object.fromEntries(allWCs.map(w => [w.id, w]));
  const targetWC = wcById[weightClassId];
  if (!targetWC) return null;

  const [f1NaturalId, f2NaturalId] = await Promise.all([
    deriveNaturalWeightClassId(f1.id, f1.primary_weight_class_id),
    deriveNaturalWeightClassId(f2.id, f2.primary_weight_class_id),
  ]);

  const f1PrimaryWC = f1NaturalId ? wcById[f1NaturalId] : null;
  const f2PrimaryWC = f2NaturalId ? wcById[f2NaturalId] : null;

  const f1Diff = f1PrimaryWC ? (targetWC.sort_order - f1PrimaryWC.sort_order) : 0;
  const f2Diff = f2PrimaryWC ? (targetWC.sort_order - f2PrimaryWC.sort_order) : 0;

  return {
    weight_class:         targetWC.name,
    weight_class_slug:    targetWC.slug,
    f1_primary_class:     f1PrimaryWC ? f1PrimaryWC.name : null,
    f2_primary_class:     f2PrimaryWC ? f2PrimaryWC.name : null,
    f1_at_natural_weight: f1Diff === 0,
    f2_at_natural_weight: f2Diff === 0,
    f1_moving_up:         f1Diff < 0,
    f2_moving_up:         f2Diff < 0,
    f1_moving_down:       f1Diff > 0,
    f2_moving_down:       f2Diff > 0,
    f1_class_diff:        f1Diff,
    f2_class_diff:        f2Diff,
    has_size_mismatch:    Math.abs(f1Diff - f2Diff) >= 2,
    uncertainty_flag:     Math.abs(f1Diff) >= 2 || Math.abs(f2Diff) >= 2,
  };
}

// ── STATISTICAL MODEL ─────────────────────────────────────
function computeWinProbabilities(f1, f2, styleMatchup) {
  let f1Base = styleMatchup ? styleMatchup.style1_win_pct / 100 : 0.50;
  let f2Base = 1 - f1Base;

  if (f1.rating_overall && f2.rating_overall) {
    const diff = (f1.rating_overall - f2.rating_overall) / 10;
    f1Base += diff * 0.15;
    f2Base -= diff * 0.15;
  }
  if (f1.resume_strength_score && f2.resume_strength_score) {
    const diff = (f1.resume_strength_score - f2.resume_strength_score) / 10;
    f1Base += diff * 0.10;
    f2Base -= diff * 0.10;
  }
  if (f1.rating_cardio && f2.rating_cardio) {
    const diff = (f1.rating_cardio - f2.rating_cardio) / 10;
    f1Base += diff * 0.08;
    f2Base -= diff * 0.08;
  }
  if (f1.reach_inches && f2.reach_inches) {
    const diff = (f1.reach_inches - f2.reach_inches) / 10;
    f1Base += diff * 0.03;
    f2Base -= diff * 0.03;
  }

  f1Base = Math.max(0.10, Math.min(0.90, f1Base));
  f2Base = Math.max(0.10, Math.min(0.90, f2Base));
  const total = f1Base + f2Base;
  return { f1: f1Base / total, f2: f2Base / total };
}

function computeMethodBreakdown(f1, f2, winnerProb, isF1) {
  const winner = isF1 ? f1 : f2;
  const loser  = isF1 ? f2 : f1;

  const koChance  = Math.min(0.45, Math.max(0.05, ((winner.wins_ko || 0) / Math.max(winner.wins, 1)) * 0.8 * (1 - (loser.rating_chin || 5) / 10)));
  const subChance = Math.min(0.40, Math.max(0.02, ((winner.wins_sub || 0) / Math.max(winner.wins, 1)) * 0.8 * (1 - (loser.rating_ground_defense || 5) / 10)));
  const decChance = Math.max(0.15, 1 - koChance - subChance);
  const norm = koChance + subChance + decChance;

  return {
    ko:  ((koChance  / norm) * winnerProb * 100).toFixed(1),
    sub: ((subChance / norm) * winnerProb * 100).toFixed(1),
    dec: ((decChance / norm) * winnerProb * 100).toFixed(1),
  };
}

function computeRoundProjections(f1, f2) {
  const rounds = [];
  for (let r = 1; r <= 5; r++) {
    const f1Out = f1['cardio_output_r' + r] || f1.slpm || 4;
    const f2Out = f2['cardio_output_r' + r] || f2.slpm || 4;
    const f1Ctrl = f1Out / (f1Out + f2Out);
    rounds.push({
      round: r,
      f1_output:        f1Out.toFixed(2),
      f2_output:        f2Out.toFixed(2),
      projected_control: f1Ctrl > 0.52 ? f1.first_name + ' ' + f1.last_name : f1Ctrl < 0.48 ? f2.first_name + ' ' + f2.last_name : 'Even',
      f1_control_pct:   (f1Ctrl * 100).toFixed(0),
    });
  }
  return rounds;
}

function identifyKeyFactors(f1, f2, styleMatchup) {
  const factors = [];

  if (styleMatchup && styleMatchup.total_fights >= 10) {
    const favStyle = styleMatchup.style1_win_pct > 50 ? f1.primary_style : f2.primary_style;
    const topPct   = Math.max(styleMatchup.style1_win_pct, styleMatchup.style2_win_pct);
    factors.push('Historical ' + f1.primary_style + ' vs ' + f2.primary_style + ' matchups favor ' + favStyle + ' (' + topPct + '% win rate)');
  }

  if (f1.rating_cardio && f2.rating_cardio && Math.abs(f1.rating_cardio - f2.rating_cardio) >= 1.5) {
    const better = f1.rating_cardio > f2.rating_cardio ? f1 : f2;
    const other  = better === f1 ? f2 : f1;
    factors.push('Significant cardio edge for ' + better.first_name + ' ' + better.last_name + ' (' + better.rating_cardio + '/10 vs ' + other.rating_cardio + '/10)');
  }

  if (f1.reach_inches && f2.reach_inches && Math.abs(f1.reach_inches - f2.reach_inches) >= 3) {
    const longer = f1.reach_inches > f2.reach_inches ? f1 : f2;
    const diff   = Math.abs(f1.reach_inches - f2.reach_inches);
    factors.push(longer.first_name + ' ' + longer.last_name + ' holds a ' + diff + '" reach advantage');
  }

  if (f1.rating_wrestling && f2.rating_ground_defense && f1.rating_wrestling - f2.rating_ground_defense >= 2) {
    factors.push(f1.first_name + ' ' + f1.last_name + ' wrestling (' + f1.rating_wrestling + '/10) outpaces ' + f2.first_name + ' ' + f2.last_name + ' ground defense (' + f2.rating_ground_defense + '/10)');
  }

  if (f1.resume_strength_score && f2.resume_strength_score && Math.abs(f1.resume_strength_score - f2.resume_strength_score) >= 1.5) {
    const stronger = f1.resume_strength_score > f2.resume_strength_score ? f1 : f2;
    factors.push(stronger.first_name + ' ' + stronger.last_name + ' has a demonstrably stronger resume');
  }

  if (f1.rating_chin && f2.rating_chin && Math.min(f1.rating_chin, f2.rating_chin) <= 5) {
    const weaker = f1.rating_chin < f2.rating_chin ? f1 : f2;
    factors.push(weaker.first_name + ' ' + weaker.last_name + ' chin has shown vulnerability — finishing opportunity exists');
  }

  return factors.slice(0, 5);
}

// ── AI NARRATIVE GENERATOR ────────────────────────────────
async function generateNarrative(f1, f2, stats, keyFactors) {
  const prompt = [
    'You are an expert MMA analyst for UFCDB. Write a detailed analytical fight breakdown.',
    'Be specific, cite actual stats, and analyze the stylistic matchup honestly.',
    '',
    'FIGHTER 1: ' + f1.first_name + ' ' + f1.last_name,
    'Style: ' + (f1.primary_style || 'Unknown') + ' / ' + (f1.secondary_style || 'N/A'),
    'Record: ' + f1.wins + '-' + f1.losses + '-' + f1.draws,
    'Striking/Grappling/Wrestling: ' + f1.rating_striking + '/' + f1.rating_grappling + '/' + f1.rating_wrestling + ' out of 10',
    'Cardio: ' + f1.rating_cardio + '/10 | Chin: ' + f1.rating_chin + '/10 | GD: ' + f1.rating_ground_defense + '/10',
    'SLPM: ' + f1.slpm + ' | Acc: ' + f1.str_acc + '% | TDs: ' + f1.td_avg + ' | TDDef: ' + f1.td_def + '%',
    'Resume: ' + f1.resume_strength_score + '/10 | Arc: ' + f1.career_arc,
    'Strengths: ' + (f1.strengths ? f1.strengths.join(', ') : 'N/A'),
    'Weaknesses: ' + (f1.weaknesses ? f1.weaknesses.join(', ') : 'N/A'),
    '',
    'FIGHTER 2: ' + f2.first_name + ' ' + f2.last_name,
    'Style: ' + (f2.primary_style || 'Unknown') + ' / ' + (f2.secondary_style || 'N/A'),
    'Record: ' + f2.wins + '-' + f2.losses + '-' + f2.draws,
    'Striking/Grappling/Wrestling: ' + f2.rating_striking + '/' + f2.rating_grappling + '/' + f2.rating_wrestling + ' out of 10',
    'Cardio: ' + f2.rating_cardio + '/10 | Chin: ' + f2.rating_chin + '/10 | GD: ' + f2.rating_ground_defense + '/10',
    'SLPM: ' + f2.slpm + ' | Acc: ' + f2.str_acc + '% | TDs: ' + f2.td_avg + ' | TDDef: ' + f2.td_def + '%',
    'Resume: ' + f2.resume_strength_score + '/10 | Arc: ' + f2.career_arc,
    'Strengths: ' + (f2.strengths ? f2.strengths.join(', ') : 'N/A'),
    'Weaknesses: ' + (f2.weaknesses ? f2.weaknesses.join(', ') : 'N/A'),
    '',
    'PREDICTION: ' + f1.first_name + ' ' + stats.f1WinPct + '% | ' + f2.first_name + ' ' + stats.f2WinPct + '%',
    'Key factors: ' + keyFactors.join('; '),
    '',
    'Write 3-4 paragraphs: stylistic matchup, how each wins, cardio factor, overall analysis.',
    'Be honest. Skip phrases like "in conclusion". Write like a real analyst. No AI disclaimer.',
  ].join('\n');

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ── MAIN PREDICTION FUNCTION ──────────────────────────────
async function generatePrediction(fighter1Id, fighter2Id, weightClassId) {
  const [{ data: f1 }, { data: f2 }] = await Promise.all([
    supabase.from('fighters').select('*').eq('id', fighter1Id).single(),
    supabase.from('fighters').select('*').eq('id', fighter2Id).single(),
  ]);

  if (!f1 || !f2) throw new Error('One or both fighters not found');

  const weightClassContext = await computeWeightClassContext(f1, f2, weightClassId);

  const cacheFilter = 'and(fighter1_id.eq.' + fighter1Id + ',fighter2_id.eq.' + fighter2Id + '),and(fighter1_id.eq.' + fighter2Id + ',fighter2_id.eq.' + fighter1Id + ')';
  const { data: cached } = await supabase
    .from('fight_predictions')
    .select('*')
    .or(cacheFilter)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (cached) return { ...cached, fighter1: f1, fighter2: f2, weight_class_context: weightClassContext };

  const style1 = f1.primary_style;
  const style2 = f2.primary_style;
  const styleFilter = 'and(style1.eq.' + style1 + ',style2.eq.' + style2 + '),and(style1.eq.' + style2 + ',style2.eq.' + style1 + ')';
  const { data: styleMatchup } = await supabase
    .from('style_matchups')
    .select('*')
    .or(styleFilter)
    .is('weight_class_id', null)
    .single();

  let normalizedMatchup = styleMatchup;
  if (styleMatchup && styleMatchup.style1 !== style1) {
    normalizedMatchup = {
      ...styleMatchup,
      style1: styleMatchup.style2,
      style2: styleMatchup.style1,
      style1_wins: styleMatchup.style2_wins,
      style2_wins: styleMatchup.style1_wins,
      style1_win_pct: styleMatchup.style2_win_pct,
      style2_win_pct: styleMatchup.style1_win_pct,
    };
  }

  const { f1: f1WinProb, f2: f2WinProb } = computeWinProbabilities(f1, f2, normalizedMatchup);
  const f1Methods        = computeMethodBreakdown(f1, f2, f1WinProb, true);
  const f2Methods        = computeMethodBreakdown(f1, f2, f2WinProb, false);
  const roundProjections = computeRoundProjections(f1, f2);
  const keyFactors       = identifyKeyFactors(f1, f2, normalizedMatchup);
  const stats = { f1WinPct: (f1WinProb * 100).toFixed(1), f2WinPct: (f2WinProb * 100).toFixed(1) };

  let aiBreakdown = '';
  try {
    aiBreakdown = await generateNarrative(f1, f2, stats, keyFactors);
  } catch (e) {
    console.error('AI narrative failed:', e.message);
    aiBreakdown = 'This matchup pits ' + f1.first_name + ' ' + f1.last_name + ' against ' + f2.first_name + ' ' + f2.last_name + '. Statistical analysis gives ' + f1.first_name + ' a ' + stats.f1WinPct + '% win probability.';
  }

  const probDiff   = Math.abs(f1WinProb - f2WinProb);
  const confidence = probDiff > 0.25 ? 'high' : probDiff > 0.12 ? 'medium' : 'low';

  const prediction = {
    fighter1_id:       fighter1Id,
    fighter2_id:       fighter2Id,
    weight_class_id:   weightClassId || null,
    fighter1_win_pct:  parseFloat(stats.f1WinPct),
    fighter2_win_pct:  parseFloat(stats.f2WinPct),
    draw_pct:          2.0,
    fighter1_ko_pct:   parseFloat(f1Methods.ko),
    fighter1_sub_pct:  parseFloat(f1Methods.sub),
    fighter1_dec_pct:  parseFloat(f1Methods.dec),
    fighter2_ko_pct:   parseFloat(f2Methods.ko),
    fighter2_sub_pct:  parseFloat(f2Methods.sub),
    fighter2_dec_pct:  parseFloat(f2Methods.dec),
    round_projections: roundProjections,
    ai_breakdown:      aiBreakdown,
    key_factors:       keyFactors,
    confidence,
    generated_at:      new Date().toISOString(),
    expires_at:        new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    model_version:     'v2',
  };

  await supabase
    .from('fight_predictions')
    .upsert(prediction, { onConflict: 'fighter1_id,fighter2_id,weight_class_id' });

  return { ...prediction, fighter1: f1, fighter2: f2, weight_class_context: weightClassContext };
}

module.exports = { generatePrediction };

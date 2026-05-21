/**
 * AI Fight Prediction Engine
 * Uses fighter stats, styles, cardio, resume quality, and
 * historical style matchup data to generate fight predictions.
 * Powered by Claude (Anthropic) for the written breakdown.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const supabase = require('../db/client');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── STATISTICAL MODEL ─────────────────────────────────────
function computeWinProbabilities(f1, f2, styleMatchup) {
  // Base probabilities from style matchup history
  let f1Base = styleMatchup
    ? styleMatchup.style1_win_pct / 100
    : 0.50;
  let f2Base = 1 - f1Base;

  // Adjust for overall ratings (±15% max swing)
  if (f1.rating_overall && f2.rating_overall) {
    const ratingDiff = (f1.rating_overall - f2.rating_overall) / 10;
    f1Base += ratingDiff * 0.15;
    f2Base -= ratingDiff * 0.15;
  }

  // Adjust for resume strength (±10%)
  if (f1.resume_strength_score && f2.resume_strength_score) {
    const resumeDiff = (f1.resume_strength_score - f2.resume_strength_score) / 10;
    f1Base += resumeDiff * 0.10;
    f2Base -= resumeDiff * 0.10;
  }

  // Adjust for cardio (matters more if fight likely goes long)
  if (f1.rating_cardio && f2.rating_cardio) {
    const cardioDiff = (f1.rating_cardio - f2.rating_cardio) / 10;
    f1Base += cardioDiff * 0.08;
    f2Base -= cardioDiff * 0.08;
  }

  // Adjust for physical advantages
  if (f1.reach_inches && f2.reach_inches) {
    const reachDiff = (f1.reach_inches - f2.reach_inches) / 10;
    f1Base += reachDiff * 0.03;
    f2Base -= reachDiff * 0.03;
  }

  // Clamp to reasonable range (10%-90%)
  f1Base = Math.max(0.10, Math.min(0.90, f1Base));
  f2Base = Math.max(0.10, Math.min(0.90, f2Base));

  // Normalize
  const total = f1Base + f2Base;
  f1Base = f1Base / total;
  f2Base = f2Base / total;

  return { f1: f1Base, f2: f2Base };
}

function computeMethodBreakdown(f1, f2, winnerProb, isF1) {
  const winner = isF1 ? f1 : f2;
  const loser  = isF1 ? f2 : f1;

  // Base method rates from winner's offense vs loser's defense
  const koChance = Math.min(0.45, Math.max(0.05,
    ((winner.wins_ko || 0) / Math.max(winner.wins, 1)) * 0.8 *
    (1 - (loser.rating_chin || 5) / 10)
  ));

  const subChance = Math.min(0.40, Math.max(0.02,
    ((winner.wins_sub || 0) / Math.max(winner.wins, 1)) * 0.8 *
    (1 - (loser.rating_ground_defense || 5) / 10)
  ));

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
  const maxRounds = 5;

  for (let r = 1; r <= maxRounds; r++) {
    // Use cardio output data if available
    const f1Output = r <= 5
      ? (f1[`cardio_output_r${r}`] || f1.slpm || 4)
      : (f1.slpm || 4) * (1 - (f1.cardio_degradation || 10) / 100 * (r-1));

    const f2Output = r <= 5
      ? (f2[`cardio_output_r${r}`] || f2.slpm || 4)
      : (f2.slpm || 4) * (1 - (f2.cardio_degradation || 10) / 100 * (r-1));

    const f1Control = f1Output / (f1Output + f2Output);

    rounds.push({
      round: r,
      f1_output: f1Output.toFixed(2),
      f2_output: f2Output.toFixed(2),
      projected_control: f1Control > 0.52 ? f1.first_name + ' ' + f1.last_name
        : f1Control < 0.48 ? f2.first_name + ' ' + f2.last_name
        : 'Even',
      f1_control_pct: (f1Control * 100).toFixed(0),
    });
  }

  return rounds;
}

function identifyKeyFactors(f1, f2, styleMatchup) {
  const factors = [];

  // Style matchup
  if (styleMatchup && styleMatchup.total_fights >= 10) {
    const favStyle = styleMatchup.style1_win_pct > 50
      ? f1.primary_style : f2.primary_style;
    factors.push(`Historical ${f1.primary_style} vs ${f2.primary_style} matchups favor ${favStyle} fighters (${Math.max(styleMatchup.style1_win_pct, styleMatchup.style2_win_pct)}% win rate)`);
  }

  // Cardio
  if (f1.rating_cardio && f2.rating_cardio) {
    const diff = Math.abs(f1.rating_cardio - f2.rating_cardio);
    if (diff >= 1.5) {
      const better = f1.rating_cardio > f2.rating_cardio ? f1 : f2;
      factors.push(`Significant cardio advantage for ${better.first_name} ${better.last_name} (${better.rating_cardio}/10 vs ${(f1.rating_cardio === better.rating_cardio ? f2 : f1).rating_cardio}/10) — fight going late favors them heavily`);
    }
  }

  // Reach
  if (f1.reach_inches && f2.reach_inches) {
    const diff = Math.abs(f1.reach_inches - f2.reach_inches);
    if (diff >= 3) {
      const longer = f1.reach_inches > f2.reach_inches ? f1 : f2;
      factors.push(`${longer.first_name} ${longer.last_name} holds a ${diff}" reach advantage — significant at range`);
    }
  }

  // Ground game
  if (f1.rating_wrestling && f2.rating_ground_defense) {
    const tdThreat = f1.rating_wrestling - f2.rating_ground_defense;
    if (tdThreat >= 2) {
      factors.push(`${f1.first_name} ${f1.last_name}'s wrestling (${f1.rating_wrestling}/10) significantly outpaces ${f2.first_name} ${f2.last_name}'s ground defense (${f2.rating_ground_defense}/10)`);
    }
  }

  // Resume quality
  if (f1.resume_strength_score && f2.resume_strength_score) {
    const diff = Math.abs(f1.resume_strength_score - f2.resume_strength_score);
    if (diff >= 1.5) {
      const stronger = f1.resume_strength_score > f2.resume_strength_score ? f1 : f2;
      factors.push(`${stronger.first_name} ${stronger.last_name} has a demonstrably stronger resume — their stats have been earned against higher quality opposition`);
    }
  }

  // Chin
  if (f1.rating_chin && f2.rating_chin) {
    const weaker = f1.rating_chin < f2.rating_chin ? f1 : f2;
    if (Math.min(f1.rating_chin, f2.rating_chin) <= 5) {
      factors.push(`${weaker.first_name} ${weaker.last_name}'s chin has shown vulnerability — finishing opportunity exists`);
    }
  }

  return factors.slice(0, 5); // Top 5 factors
}

// ── AI NARRATIVE GENERATOR ────────────────────────────────
async function generateNarrative(f1, f2, stats, keyFactors) {
  const prompt = `You are an expert MMA analyst writing a fight breakdown for a website called UFCDB. 
Write a detailed, analytical breakdown of this hypothetical matchup. Be specific, cite the actual stats provided, and analyze the stylistic matchup honestly.

FIGHTER 1: ${f1.first_name} ${f1.last_name}
- Style: ${f1.primary_style || 'Unknown'} / ${f1.secondary_style || 'N/A'}
- Record: ${f1.wins}-${f1.losses}-${f1.draws}
- Striking: ${f1.rating_striking}/10 | Grappling: ${f1.rating_grappling}/10 | Wrestling: ${f1.rating_wrestling}/10
- Cardio: ${f1.rating_cardio}/10 | Chin: ${f1.rating_chin}/10 | Ground Defense: ${f1.rating_ground_defense}/10
- SLPM: ${f1.slpm} | Str Acc: ${f1.str_acc}% | TD Avg: ${f1.td_avg} | TD Def: ${f1.td_def}%
- Resume Strength: ${f1.resume_strength_score}/10 | Career Arc: ${f1.career_arc}
- Strengths: ${f1.strengths?.join(', ') || 'N/A'}
- Weaknesses: ${f1.weaknesses?.join(', ') || 'N/A'}

FIGHTER 2: ${f2.first_name} ${f2.last_name}
- Style: ${f2.primary_style || 'Unknown'} / ${f2.secondary_style || 'N/A'}
- Record: ${f2.wins}-${f2.losses}-${f2.draws}
- Striking: ${f2.rating_striking}/10 | Grappling: ${f2.rating_grappling}/10 | Wrestling: ${f2.rating_wrestling}/10
- Cardio: ${f2.rating_cardio}/10 | Chin: ${f2.rating_chin}/10 | Ground Defense: ${f2.rating_ground_defense}/10
- SLPM: ${f2.slpm} | Str Acc: ${f2.str_acc}% | TD Avg: ${f2.td_avg} | TD Def: ${f2.td_def}%
- Resume Strength: ${f2.resume_strength_score}/10 | Career Arc: ${f2.career_arc}
- Strengths: ${f2.strengths?.join(', ') || 'N/A'}
- Weaknesses: ${f2.weaknesses?.join(', ') || 'N/A'}

MODEL PREDICTION:
- ${f1.first_name} ${f1.last_name} win probability: ${stats.f1WinPct}%
- ${f2.first_name} ${f2.last_name} win probability: ${stats.f2WinPct}%
- Key factors: ${keyFactors.join('; ')}

Write 3-4 paragraphs of genuine analytical breakdown. Cover:
1. The stylistic matchup and what determines where this fight takes place
2. How each fighter tries to win and what they need to avoid
3. The cardio and late-rounds factor if relevant
4. Your overall analysis of how this plays out

Be honest — if one fighter has a clear edge, say so. If it's close, explain why. 
Do NOT use phrases like "in conclusion" or "to summarize". Write like a real analyst, not an AI.
Do NOT add any disclaimer about this being AI-generated — the site already has one.`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }],
  });

  return message.content[0].text;
}

// ── MAIN PREDICTION FUNCTION ──────────────────────────────
async function generatePrediction(fighter1Id, fighter2Id, weightClassId) {
  // Check cache first
  const { data: cached } = await supabase
    .from('fight_predictions')
    .select('*')
    .or(`and(fighter1_id.eq.${fighter1Id},fighter2_id.eq.${fighter2Id}),and(fighter1_id.eq.${fighter2Id},fighter2_id.eq.${fighter1Id})`)
    .gt('expires_at', new Date().toISOString())
    .single();

  if (cached) return cached;

  // Fetch both fighters
  const [{ data: f1 }, { data: f2 }] = await Promise.all([
    supabase.from('fighters').select('*').eq('id', fighter1Id).single(),
    supabase.from('fighters').select('*').eq('id', fighter2Id).single(),
  ]);

  if (!f1 || !f2) throw new Error('One or both fighters not found');

  // Fetch style matchup data
  const style1 = f1.primary_style;
  const style2 = f2.primary_style;
  const { data: styleMatchup } = await supabase
    .from('style_matchups')
    .select('*')
    .or(`and(style1.eq.${style1},style2.eq.${style2}),and(style1.eq.${style2},style2.eq.${style1})`)
    .is('weight_class_id', null)
    .single();

  // Normalize style matchup direction
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

  // Compute probabilities
  const { f1: f1WinProb, f2: f2WinProb } = computeWinProbabilities(f1, f2, normalizedMatchup);
  const f1Methods = computeMethodBreakdown(f1, f2, f1WinProb, true);
  const f2Methods = computeMethodBreakdown(f1, f2, f2WinProb, false);
  const roundProjections = computeRoundProjections(f1, f2);
  const keyFactors = identifyKeyFactors(f1, f2, normalizedMatchup);

  const stats = {
    f1WinPct: (f1WinProb * 100).toFixed(1),
    f2WinPct: (f2WinProb * 100).toFixed(1),
  };

  // Generate AI narrative
  let aiBreakdown = '';
  try {
    aiBreakdown = await generateNarrative(f1, f2, stats, keyFactors);
  } catch (e) {
    console.error('AI narrative failed:', e.message);
    aiBreakdown = `This matchup pits ${f1.first_name} ${f1.last_name} (${f1.primary_style || 'MMA Fighter'}) against ${f2.first_name} ${f2.last_name} (${f2.primary_style || 'MMA Fighter'}). Statistical analysis gives ${f1.first_name} a ${stats.f1WinPct}% win probability based on style matchup history, performance ratings, and resume quality.`;
  }

  // Determine confidence
  const probDiff = Math.abs(f1WinProb - f2WinProb);
  const confidence = probDiff > 0.25 ? 'high' : probDiff > 0.12 ? 'medium' : 'low';

  // Build prediction record
  const prediction = {
    fighter1_id:    fighter1Id,
    fighter2_id:    fighter2Id,
    weight_class_id: weightClassId || null,
    fighter1_win_pct: parseFloat(stats.f1WinPct),
    fighter2_win_pct: parseFloat(stats.f2WinPct),
    draw_pct: 2.0,
    fighter1_ko_pct:  parseFloat(f1Methods.ko),
    fighter1_sub_pct: parseFloat(f1Methods.sub),
    fighter1_dec_pct: parseFloat(f1Methods.dec),
    fighter2_ko_pct:  parseFloat(f2Methods.ko),
    fighter2_sub_pct: parseFloat(f2Methods.sub),
    fighter2_dec_pct: parseFloat(f2Methods.dec),
    round_projections: roundProjections,
    ai_breakdown:  aiBreakdown,
    key_factors:   keyFactors,
    confidence,
    generated_at:  new Date().toISOString(),
    expires_at:    new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(), // 7 days
    model_version: 'v2',
  };

  // Cache it
  await supabase
    .from('fight_predictions')
    .upsert(prediction, { onConflict: 'fighter1_id,fighter2_id,weight_class_id' });

  return { ...prediction, fighter1: f1, fighter2: f2 };
}

module.exports = { generatePrediction };

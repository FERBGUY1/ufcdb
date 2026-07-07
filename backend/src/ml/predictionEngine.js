/**
 * AI Fight Prediction Engine — v3
 *
 * Replaces the hand-tuned v2 blend with the trained logistic model
 * (src/ml/model-v3.json, produced by trainModel.js): real per-fight stats ->
 * statsEngine snapshots -> standardized feature differentials -> calibrated
 * win probability. Each feature's contribution (weight x standardized diff)
 * is computed per matchup; the top contributions become key_factors carrying
 * the actual numbers, and the narrative model is given ONLY those numbers to
 * cite. API shape and the fight_predictions cache are unchanged from v2.
 */

require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const supabase = require('../db/client');
const { buildTimelines, snapshot } = require('./statsEngine');
const { FEATURES, sideValues, diffVector } = require('./features');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = require(path.join(__dirname, 'model-v3.json'));
const DATA_TTL_MS = 6 * 60 * 60 * 1000;

// ── WEIGHT CLASS CONTEXT (unchanged from v2) ──────────────────────────────
async function deriveNaturalWeightClassId(fighterId) {
  const { data: fights } = await supabase
    .from('fights')
    .select('weight_class_id')
    .or(`fighter1_id.eq.${fighterId},fighter2_id.eq.${fighterId}`)
    .not('weight_class_id', 'is', null);
  if (!fights || fights.length === 0) return null;
  const counts = {};
  for (const f of fights) counts[f.weight_class_id] = (counts[f.weight_class_id] || 0) + 1;
  return parseInt(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

async function computeWeightClassContext(f1, f2, weightClassId) {
  if (!weightClassId) return null;
  const { data: allWCs } = await supabase.from('weight_classes').select('id, name, slug, sort_order, limit_lbs');
  if (!allWCs) return null;
  const wcById = Object.fromEntries(allWCs.map(w => [w.id, w]));
  const targetWC = wcById[weightClassId];
  if (!targetWC) return null;
  const [f1NaturalId, f2NaturalId] = await Promise.all([
    deriveNaturalWeightClassId(f1.id),
    deriveNaturalWeightClassId(f2.id),
  ]);
  const f1PrimaryWC = f1NaturalId ? wcById[f1NaturalId] : null;
  const f2PrimaryWC = f2NaturalId ? wcById[f2NaturalId] : null;
  const f1Diff = (targetWC.limit_lbs != null && f1PrimaryWC?.limit_lbs != null) ? targetWC.limit_lbs - f1PrimaryWC.limit_lbs : 0;
  const f2Diff = (targetWC.limit_lbs != null && f2PrimaryWC?.limit_lbs != null) ? targetWC.limit_lbs - f2PrimaryWC.limit_lbs : 0;
  return {
    weight_class: targetWC.name,
    weight_class_slug: targetWC.slug,
    f1_primary_class: f1PrimaryWC?.name ?? null,
    f2_primary_class: f2PrimaryWC?.name ?? null,
    f1_at_natural_weight: f1Diff === 0,
    f2_at_natural_weight: f2Diff === 0,
    f1_moving_up: f1Diff > 0, f2_moving_up: f2Diff > 0,
    f1_moving_down: f1Diff < 0, f2_moving_down: f2Diff < 0,
    f1_class_diff: f1Diff, f2_class_diff: f2Diff,
    has_size_mismatch: Math.abs(f1Diff - f2Diff) >= 30,
    uncertainty_flag: Math.abs(f1Diff) >= 30 || Math.abs(f2Diff) >= 30,
  };
}

// ── DATA CACHE (fights/events loaded once per process, refreshed on TTL) ──
let dataCache = null;

async function loadAll(table, cols) {
  const all = [];
  let page = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(cols).range(page * 1000, (page + 1) * 1000 - 1);
    if (error) throw new Error(`loadAll(${table}): ${error.message}`);
    if (!data?.length) break;
    all.push(...data);
    if (data.length < 1000) break;
    page++;
  }
  return all;
}

async function getData() {
  if (dataCache && Date.now() - dataCache.loadedAt < DATA_TTL_MS) return dataCache;
  const events = await loadAll('events', 'id, date');
  const fights = await loadAll('fights',
    'id, event_id, fighter1_id, fighter2_id, winner_id, result, method, round, time, time_format, is_title_fight, rounds_data');
  const eventById = Object.fromEntries(events.map(e => [e.id, e]));
  dataCache = { timelines: buildTimelines(fights, eventById), loadedAt: Date.now() };
  return dataCache;
}

// ── MODEL ──────────────────────────────────────────────────────────────────
const sigmoid = z => 1 / (1 + Math.exp(-z));

function predictProb(diffs) {
  const z = diffs.map((v, j) => (v - MODEL.mu[j]) / MODEL.sigma[j]);
  const score = z.reduce((s, x, j) => s + x * MODEL.w[j], MODEL.b);
  return { p: sigmoid(score), contributions: z.map((x, j) => x * MODEL.w[j]) };
}

// ── FACTOR EXPLANATIONS (real numbers, computed values) ───────────────────
const fmt = (v, dp = 1) => (v == null ? '?' : (+v).toFixed(dp));
const FACTOR_TEXT = {
  slpm: (A, B, a, b) => `striking volume: ${A} lands ${fmt(a.slpm, 2)} sig strikes/min vs ${B}'s ${fmt(b.slpm, 2)}`,
  sapm: (A, B, a, b) => `damage absorbed: ${A} eats ${fmt(a.sapm, 2)} sig strikes/min vs ${B}'s ${fmt(b.sapm, 2)}`,
  str_acc: (A, B, a, b) => `striking accuracy: ${A} ${fmt(a.str_acc)}% vs ${B} ${fmt(b.str_acc)}%`,
  str_def: (A, B, a, b) => `striking defense: ${A} avoids ${fmt(a.str_def)}% of strikes vs ${B}'s ${fmt(b.str_def)}%`,
  td_avg: (A, B, a, b) => `takedown output: ${A} lands ${fmt(a.td_avg, 2)} TD/15min vs ${B}'s ${fmt(b.td_avg, 2)}`,
  td_acc: (A, B, a, b) => `takedown accuracy: ${A} ${fmt(a.td_acc)}% vs ${B} ${fmt(b.td_acc)}%`,
  td_def: (A, B, a, b) => `takedown defense: ${A} stuffs ${fmt(a.td_def)}% vs ${B}'s ${fmt(b.td_def)}%`,
  sub_avg: (A, B, a, b) => `submission threat: ${A} ${fmt(a.sub_avg, 2)} attempts/15min vs ${B} ${fmt(b.sub_avg, 2)}`,
  kd_per15: (A, B, a, b) => `knockdown power: ${A} scores ${fmt(a.kd_per15, 2)} KD/15min vs ${B}'s ${fmt(b.kd_per15, 2)}`,
  kd_absorbed_per15: (A, B, a, b) => `durability: ${A} absorbs ${fmt(a.kd_absorbed_per15, 2)} KD/15min vs ${B}'s ${fmt(b.kd_absorbed_per15, 2)}`,
  ctrl_pct: (A, B, a, b) => `control time: ${A} controls ${fmt(a.ctrl_pct)}% of cage time vs ${B}'s ${fmt(b.ctrl_pct)}%`,
  cardio_degradation: (A, B, a, b) => `cardio: ${A}'s output ${(a.cardio_degradation ?? 0) <= 0 ? 'rises' : 'drops'} ${fmt(Math.abs(a.cardio_degradation ?? 0))}% R1->R3 vs ${B}'s ${(b.cardio_degradation ?? 0) <= 0 ? 'rise' : 'drop'} of ${fmt(Math.abs(b.cardio_degradation ?? 0))}%`,
  experience: (A, B, a, b) => `experience: ${A} has ${a.experience} UFC fights vs ${B}'s ${b.experience}`,
  win_rate: (A, B, a, b) => `career win rate: ${A} ${fmt(a.win_rate)}% vs ${B} ${fmt(b.win_rate)}%`,
  recent_win_rate: (A, B, a, b) => `recent form: ${A} won ${fmt(a.recent_win_rate, 0)}% of last 3 vs ${B}'s ${fmt(b.recent_win_rate, 0)}%`,
  form_trend: (A, B, a, b) => `output trend: ${A}'s recent striking is ${(a.form_trend ?? 0) >= 0 ? 'up' : 'down'} ${fmt(Math.abs(a.form_trend ?? 0), 2)}/min on career avg vs ${B} ${(b.form_trend ?? 0) >= 0 ? 'up' : 'down'} ${fmt(Math.abs(b.form_trend ?? 0), 2)}`,
  age: (A, B, a, b) => `age: ${A} is ${fmt(a.age, 0)} vs ${B} at ${fmt(b.age, 0)}`,
  reach: (A, B, a, b) => `reach: ${A} ${fmt(a.reach, 0)}" vs ${B} ${fmt(b.reach, 0)}"`,
  height: (A, B, a, b) => `height: ${A} ${fmt(a.height, 0)}" vs ${B} ${fmt(b.height, 0)}"`,
  layoff_days: (A, B, a, b) => `activity: ${A} last fought ${fmt(a.layoff_days, 0)} days ago vs ${B}'s ${fmt(b.layoff_days, 0)}`,
};

function buildKeyFactors(nameA, nameB, valsA, valsB, contributions) {
  return contributions
    .map((c, j) => ({ feature: FEATURES[j], c }))
    .filter(({ feature, c }) => Math.abs(c) > 0.01 && valsA[feature] != null && valsB[feature] != null)
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
    .slice(0, 5)
    .map(({ feature, c }) => {
      const text = FACTOR_TEXT[feature](nameA, nameB, valsA, valsB);
      const leader = c > 0 ? nameA : nameB;
      const pts = Math.abs(c * 25); // rough logit->probability-points at p~0.5
      return `${text} — edge ${leader} (~${pts.toFixed(0)} pts of win probability)`;
    });
}

// ── METHOD BREAKDOWN (empirical finish rates, not ratings) ─────────────────
function methodShares(timeline, asWinner) {
  const rel = timeline.filter(e => e.result === (asWinner ? 'win' : 'loss') && e.method);
  const share = re => rel.filter(e => re.test(e.method)).length / Math.max(rel.length, 1);
  return { ko: share(/KO/i), sub: share(/SUB/i), dec: share(/DEC/i) };
}

function computeMethodBreakdown(tlWinner, tlLoser, winProb) {
  const w = methodShares(tlWinner, true);   // how this fighter wins
  const l = methodShares(tlLoser, false);   // how the opponent loses
  let ko = 0.65 * w.ko + 0.35 * l.ko;
  let sub = 0.65 * w.sub + 0.35 * l.sub;
  let dec = Math.max(0.15, 0.65 * w.dec + 0.35 * l.dec);
  const norm = ko + sub + dec || 1;
  return {
    ko: ((ko / norm) * winProb * 100).toFixed(1),
    sub: ((sub / norm) * winProb * 100).toFixed(1),
    dec: ((dec / norm) * winProb * 100).toFixed(1),
  };
}

// ── ROUND PROJECTIONS (real per-round cardio curves) ───────────────────────
function computeRoundProjections(f1, f2, snap1, snap2) {
  const rounds = [];
  for (let r = 1; r <= 5; r++) {
    const o1 = snap1.cardio['r' + r] ?? snap1.slpm ?? 4;
    const o2 = snap2.cardio['r' + r] ?? snap2.slpm ?? 4;
    const share = o1 / (o1 + o2 || 1);
    rounds.push({
      round: r,
      f1_output: (+o1).toFixed(2),
      f2_output: (+o2).toFixed(2),
      projected_control: share > 0.52 ? `${f1.first_name} ${f1.last_name}` : share < 0.48 ? `${f2.first_name} ${f2.last_name}` : 'Even',
      f1_control_pct: (share * 100).toFixed(0),
    });
  }
  return rounds;
}

// ── NARRATIVE (grounded: gets ONLY the computed factors and numbers) ───────
async function generateNarrative(f1, f2, stats, keyFactors, methodLine) {
  const prompt = [
    'You are an MMA analyst for UFCDB. Write a 3-paragraph fight breakdown.',
    'STRICT RULE: cite ONLY the statistics listed below — do not invent numbers,',
    'records, fight history, or attributes that are not listed. If a dimension',
    'is not listed, do not speculate about it.',
    '',
    `MATCHUP: ${f1.first_name} ${f1.last_name} vs ${f2.first_name} ${f2.last_name}`,
    `MODEL PROBABILITY: ${f1.last_name} ${stats.f1WinPct}% | ${f2.last_name} ${stats.f2WinPct}% (logistic model on per-fight statistics)`,
    `METHOD OUTLOOK: ${methodLine}`,
    '',
    'THE DECIDING FACTORS (model contributions, largest first):',
    ...keyFactors.map((k, i) => `${i + 1}. ${k}`),
    '',
    'Paragraph 1: the statistical case for the favorite, citing the factors.',
    'Paragraph 2: the underdog\'s realistic path, citing the factors that lean their way.',
    'Paragraph 3: how the fight likely plays out. Be concrete, no hedging boilerplate.',
    'No "in conclusion", no AI disclaimers.',
  ].join('\n');

  const message = await anthropic.messages.create({
    model: 'claude-opus-4-8',
    max_tokens: 900,
    messages: [{ role: 'user', content: prompt }],
  });
  return message.content[0].text;
}

// ── MAIN ───────────────────────────────────────────────────────────────────
async function generatePrediction(fighter1Id, fighter2Id, weightClassId, opts = {}) {
  const [{ data: f1 }, { data: f2 }] = await Promise.all([
    supabase.from('fighters').select('*').eq('id', fighter1Id).single(),
    supabase.from('fighters').select('*').eq('id', fighter2Id).single(),
  ]);
  if (!f1 || !f2) throw new Error('One or both fighters not found');

  if (!weightClassId) {
    weightClassId = (await deriveNaturalWeightClassId(f1.id)) ?? f1.primary_weight_class_id ?? null;
  }
  const weightClassContext = await computeWeightClassContext(f1, f2, weightClassId);

  if (!opts.skipCache) {
    const cacheFilter = 'and(fighter1_id.eq.' + fighter1Id + ',fighter2_id.eq.' + fighter2Id + '),and(fighter1_id.eq.' + fighter2Id + ',fighter2_id.eq.' + fighter1Id + ')';
    const { data: cached } = await supabase
      .from('fight_predictions').select('*')
      .or(cacheFilter)
      .eq('model_version', 'v3')
      .gt('expires_at', new Date().toISOString())
      .maybeSingle();
    if (cached) return { ...cached, fighter1: f1, fighter2: f2, weight_class_context: weightClassContext };
  }

  const { timelines } = await getData();
  const tl1 = timelines.get(fighter1Id) || [];
  const tl2 = timelines.get(fighter2Id) || [];
  const today = new Date().toISOString().split('T')[0];

  const snap1 = snapshot(tl1), snap2 = snapshot(tl2);
  const vals1 = sideValues(snap1, snapshot(tl1, null, 3), f1, today);
  const vals2 = sideValues(snap2, snapshot(tl2, null, 3), f2, today);
  const { p: f1WinProb, contributions } = predictProb(diffVector(vals1, vals2));
  const f2WinProb = 1 - f1WinProb;

  const name1 = `${f1.first_name} ${f1.last_name}`, name2 = `${f2.first_name} ${f2.last_name}`;
  const keyFactors = buildKeyFactors(name1, name2, vals1, vals2, contributions);
  const lowData = snap1.stats_fights < 2 || snap2.stats_fights < 2;

  const f1Methods = computeMethodBreakdown(tl1, tl2, f1WinProb);
  const f2Methods = computeMethodBreakdown(tl2, tl1, f2WinProb);
  const roundProjections = computeRoundProjections(f1, f2, snap1, snap2);
  const stats = { f1WinPct: (f1WinProb * 100).toFixed(1), f2WinPct: (f2WinProb * 100).toFixed(1) };
  const methodLine = `${f1.last_name}: KO ${f1Methods.ko}% / SUB ${f1Methods.sub}% / DEC ${f1Methods.dec}% — ${f2.last_name}: KO ${f2Methods.ko}% / SUB ${f2Methods.sub}% / DEC ${f2Methods.dec}%`;

  let aiBreakdown = '';
  if (!opts.skipNarrative) {
    try {
      aiBreakdown = await generateNarrative(f1, f2, stats, keyFactors, methodLine);
    } catch (e) {
      console.error('AI narrative failed:', e.message);
      aiBreakdown = `${name1} vs ${name2}: the model gives ${f1.first_name} a ${stats.f1WinPct}% win probability based on ${keyFactors.length} statistical edges: ${keyFactors.join('; ')}.`;
    }
  }

  const probDiff = Math.abs(f1WinProb - f2WinProb);
  const confidence = lowData ? 'low' : probDiff > 0.25 ? 'high' : probDiff > 0.12 ? 'medium' : 'low';

  const prediction = {
    fighter1_id: fighter1Id,
    fighter2_id: fighter2Id,
    weight_class_id: weightClassId || null,
    fighter1_win_pct: parseFloat(stats.f1WinPct),
    fighter2_win_pct: parseFloat(stats.f2WinPct),
    draw_pct: 2.0,
    fighter1_ko_pct: parseFloat(f1Methods.ko),
    fighter1_sub_pct: parseFloat(f1Methods.sub),
    fighter1_dec_pct: parseFloat(f1Methods.dec),
    fighter2_ko_pct: parseFloat(f2Methods.ko),
    fighter2_sub_pct: parseFloat(f2Methods.sub),
    fighter2_dec_pct: parseFloat(f2Methods.dec),
    round_projections: roundProjections,
    ai_breakdown: aiBreakdown,
    key_factors: keyFactors,
    confidence,
    generated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    model_version: 'v3',
  };

  if (!opts.skipCache) {
    await supabase.from('fight_predictions')
      .upsert(prediction, { onConflict: 'fighter1_id,fighter2_id,weight_class_id' });
  }

  return { ...prediction, fighter1: f1, fighter2: f2, weight_class_context: weightClassContext };
}

module.exports = { generatePrediction };

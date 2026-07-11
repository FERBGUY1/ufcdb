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
// Every factor leads with the ADVANTAGED fighter (L = the fighter the model's
// contribution favors) so "who's favored" is unambiguous. The clause is chosen
// from the ACTUAL values, never from an assumed "good direction" — several model
// weights are counterintuitive (e.g. height and cardio_degradation favor the
// shorter / faster-fading fighter), so when the leader sits on the intuitively
// WORSE raw side we say so ("is favored despite …") instead of inventing an
// advantage that contradicts the printed numbers.
//   meta: sfx (per-number suffix, e.g. '%'), desc (trailing descriptor shown
//         once), dp (decimals), hib (higher-is-intuitively-better),
//         adv/despite = row clause when the leader is on the better / worse raw
//         side; advP/despiteP = the same as a bare noun phrase for prose.
const FACTOR_META = {
  slpm:              { sfx: '',  desc: 'sig strikes/min',         dp: 2, hib: true,  adv: 'lands the greater striking volume', despite: 'grades ahead despite lower volume',       advP: 'more striking volume',       despiteP: 'lower striking volume' },
  sapm:              { sfx: '',  desc: 'sig strikes/min absorbed',dp: 2, hib: false, adv: 'absorbs less damage',               despite: 'grades ahead despite absorbing more',     advP: 'less damage absorbed',       despiteP: 'more damage absorbed' },
  str_acc:           { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'is the more accurate striker',      despite: 'grades ahead despite lower accuracy',     advP: 'better striking accuracy',   despiteP: 'lower striking accuracy' },
  str_def:           { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'has the better striking defense',   despite: 'grades ahead despite weaker defense',     advP: 'better striking defense',    despiteP: 'weaker striking defense' },
  td_avg:            { sfx: '',  desc: 'TD/15min',                dp: 2, hib: true,  adv: 'holds the takedown-volume edge',    despite: 'grades ahead despite fewer takedowns',    advP: 'more takedown volume',       despiteP: 'fewer takedowns' },
  td_acc:            { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'is more accurate on takedowns',     despite: 'grades ahead despite lower TD accuracy',  advP: 'better takedown accuracy',   despiteP: 'lower takedown accuracy' },
  td_def:            { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'defends takedowns better',          despite: 'grades ahead despite weaker TD defense',  advP: 'better takedown defense',    despiteP: 'weaker takedown defense' },
  sub_avg:           { sfx: '',  desc: 'sub attempts/15min',      dp: 2, hib: true,  adv: 'is the bigger submission threat',   despite: 'grades ahead despite fewer sub attempts', advP: 'a bigger submission threat', despiteP: 'fewer submission attempts' },
  kd_per15:          { sfx: '',  desc: 'KD/15min',                dp: 2, hib: true,  adv: 'carries more knockdown power',      despite: 'grades ahead despite fewer knockdowns',   advP: 'more knockdown power',       despiteP: 'fewer knockdowns' },
  kd_absorbed_per15: { sfx: '',  desc: 'KD absorbed/15min',       dp: 2, hib: false, adv: 'is dropped less often',             despite: 'grades ahead despite being dropped more', advP: 'a sturdier chin',            despiteP: 'being dropped more often' },
  cardio_degradation:{ sfx: '%', desc: 'output drop R1→R3',       dp: 1, hib: false, adv: 'fades less into round 3',           despite: 'grades ahead despite fading more late',   advP: 'better late-round cardio',   despiteP: 'more fade late' },
  experience:        { sfx: '',  desc: 'UFC fights',              dp: 0, hib: true,  adv: 'is the more experienced fighter',   despite: 'grades ahead despite less experience',    advP: 'more UFC experience',        despiteP: 'less UFC experience' },
  win_rate:          { sfx: '%', desc: '',                        dp: 1, hib: true,  adv: 'has the stronger career win rate',  despite: 'grades ahead despite a lower win rate',   advP: 'a stronger career win rate', despiteP: 'a lower career win rate' },
  recent_win_rate:   { sfx: '%', desc: 'over last 3',             dp: 0, hib: true,  adv: 'is in better recent form',          despite: 'grades ahead despite cooler form',        advP: 'better recent form',         despiteP: 'cooler recent form' },
  form_trend:        { sfx: '',  desc: 'SLpM vs career avg',      dp: 2, hib: true,  adv: 'has rising output momentum',        despite: 'grades ahead despite fading output',      advP: 'rising output momentum',     despiteP: 'fading output' },
  age:               { sfx: '',  desc: 'yrs',                     dp: 0, hib: false, adv: 'is the younger fighter',            despite: 'grades ahead despite being older',        advP: 'a youth edge',               despiteP: 'an age disadvantage' },
  layoff_days:       { sfx: '',  desc: 'days since last fight',   dp: 0, hib: false, adv: 'comes in with less ring rust',      despite: 'grades ahead despite a longer layoff',    advP: 'less ring rust',             despiteP: 'a longer layoff' },
  // reach & height read as an inch advantage when the leader is the bigger one.
  reach:             { dp: 0, dim: 'reach' },
  height:            { dp: 0, dim: 'height' },
};

function factorText(feature, L, lv, tv) {
  const meta = FACTOR_META[feature];
  const a = lv[feature], b = tv[feature];
  const av = fmt(a, meta.dp), bv = fmt(b, meta.dp);
  if (meta.dim) {
    const d = fmt(Math.abs(a - b), 0);
    return a >= b
      ? `${L} has a ${d}-inch ${meta.dim} advantage (${av}" vs ${bv}")`
      : `${L} is favored despite giving up ${d} inches of ${meta.dim} (${av}" vs ${bv}")`;
  }
  const leaderOnBetterSide = meta.hib ? a >= b : a <= b;
  const clause = leaderOnBetterSide ? meta.adv : meta.despite;
  const nums = `${av}${meta.sfx} vs ${bv}${meta.sfx}${meta.desc ? ' ' + meta.desc : ''}`;
  return `${L} ${clause} (${nums})`;
}

// Top-5 model contributions as structured factors. Each carries the finished
// evidence `row` string plus fields the prose fallback reuses (leader, whether
// the leader sits on the intuitively better side, a bare noun `phrase`, `nums`).
function computeFactors(nameA, nameB, valsA, valsB, contributions) {
  return contributions
    .map((c, j) => ({ feature: FEATURES[j], c }))
    .filter(({ feature, c }) => Math.abs(c) > 0.01 && valsA[feature] != null && valsB[feature] != null)
    .sort((a, b) => Math.abs(b.c) - Math.abs(a.c))
    .slice(0, 5)
    .map(({ feature, c }) => {
      // c > 0 means the feature favors fighter A; phrase from the favored side.
      const leaderIsA = c > 0;
      const leader = leaderIsA ? nameA : nameB;
      const lv = leaderIsA ? valsA : valsB;
      const tv = leaderIsA ? valsB : valsA;
      const meta = FACTOR_META[feature];
      const a = lv[feature], b = tv[feature];
      const leaderBetter = meta.dim ? a >= b : (meta.hib ? a >= b : a <= b);
      const pts = Math.max(1, Math.round(Math.abs(c * 25))); // rough logit->prob-points at p~0.5
      const av = fmt(a, meta.dp), bv = fmt(b, meta.dp);
      const nums = meta.dim
        ? `${av}" vs ${bv}"`
        : `${av}${meta.sfx} vs ${bv}${meta.sfx}${meta.desc ? ' ' + meta.desc : ''}`;
      const phrase = meta.dim
        ? `a ${fmt(Math.abs(a - b), 0)}-inch ${meta.dim} ${a >= b ? 'advantage' : 'disadvantage'}`
        : (leaderBetter ? meta.advP : meta.despiteP);
      return {
        feature, leader, leaderBetter, pts, phrase, nums,
        row: `${factorText(feature, leader, lv, tv)} (~${pts} pts of win probability)`,
      };
    });
}

// Join a list into readable prose: "a", "a and b", "a, b, and c".
function proseList(items) {
  if (items.length <= 1) return items[0] || '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

// No-API-key fallback narrative: natural prose from the same structured factors.
// Only intuitive-direction edges are woven into "the case" / "the path" so the
// prose never reads backwards; counterintuitive factors still show as evidence
// rows but are omitted here. Purely factual — pick, probability, and numbers.
function fallbackNarrative(name1, name2, f1Pct, f2Pct, factors) {
  const favIsF1 = f1Pct >= f2Pct;
  const favName = favIsF1 ? name1 : name2;
  const dogName = favIsF1 ? name2 : name1;
  const favPct = favIsF1 ? f1Pct : f2Pct;
  const dogPct = favIsF1 ? f2Pct : f1Pct;
  const item = f => `${f.phrase} (${f.nums})`;
  const favSup = factors.filter(f => f.leader === favName && f.leaderBetter);
  const dogSup = factors.filter(f => f.leader === dogName && f.leaderBetter);

  const s1 = `The model makes ${favName} the pick at ${favPct.toFixed(1)}% to ${dogName}'s ${dogPct.toFixed(1)}%.`;
  const s2 = favSup.length
    ? `Its case is built on ${proseList(favSup.map(item))}.`
    : `Its edge is thin and rests on small statistical margins rather than any one dominant advantage.`;
  const s3 = dogSup.length
    ? ` ${dogName}'s path runs through ${proseList(dogSup.slice(0, 2).map(item))}.`
    : '';
  const margin = favPct - dogPct;
  const s4 = margin >= 25 ? ` The model reads this as a clear edge for ${favName}.`
           : margin >= 12 ? ` On balance it gives ${favName} the nod.`
           : ` It rates the matchup close, with ${favName} a slight favorite.`;
  return s1 + ' ' + s2 + s3 + s4;
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
// Scheduled rounds for a hypothetical matchup, derived from what the prediction
// already knows: the two fighters' SHARED bout history in the loaded timelines.
// Each timeline entry carries scheduledRounds (5 when time_format is "5 Rnd",
// else 3) and an isTitle flag. A title bout in their history -> 5; otherwise the
// max scheduled rounds across their shared bouts (captures 5-round main events).
// Never-fought pairings have no reliable signal -> default 3 (never 5).
function scheduledRoundsForMatchup(tl1, id2) {
  const shared = (tl1 || []).filter(e => e.oppId === id2);
  if (!shared.length) return 3;
  return shared.some(e => e.isTitle)
    ? 5
    : Math.max(...shared.map(e => e.scheduledRounds || 3));
}

function computeRoundProjections(f1, f2, snap1, snap2, scheduledRounds = 3) {
  const rounds = [];
  for (let r = 1; r <= scheduledRounds; r++) {
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
  const factors = computeFactors(name1, name2, vals1, vals2, contributions);
  const keyFactors = factors.map(f => f.row);
  const lowData = snap1.stats_fights < 2 || snap2.stats_fights < 2;

  const f1Methods = computeMethodBreakdown(tl1, tl2, f1WinProb);
  const f2Methods = computeMethodBreakdown(tl2, tl1, f2WinProb);
  const scheduledRounds = scheduledRoundsForMatchup(tl1, fighter2Id);
  const roundProjections = computeRoundProjections(f1, f2, snap1, snap2, scheduledRounds);
  const stats = { f1WinPct: (f1WinProb * 100).toFixed(1), f2WinPct: (f2WinProb * 100).toFixed(1) };
  const methodLine = `${f1.last_name}: KO ${f1Methods.ko}% / SUB ${f1Methods.sub}% / DEC ${f1Methods.dec}% — ${f2.last_name}: KO ${f2Methods.ko}% / SUB ${f2Methods.sub}% / DEC ${f2Methods.dec}%`;

  let aiBreakdown = '';
  if (!opts.skipNarrative) {
    try {
      aiBreakdown = await generateNarrative(f1, f2, stats, keyFactors, methodLine);
    } catch (e) {
      console.error('AI narrative failed:', e.message);
      aiBreakdown = fallbackNarrative(name1, name2, parseFloat(stats.f1WinPct), parseFloat(stats.f2WinPct), factors);
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
